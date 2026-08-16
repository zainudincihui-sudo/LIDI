// sync-transactions
//
// Each invoke processes a small batch of tokens (`TOKENS_PER_RUN`) from the
// `tokens` table -- see the comment by that constant for why it's kept
// small -- picking up where the previous invoke left off via a cursor
// stored in `sync_cursors`, and wrapping back to the start once it runs
// off the end. Since this runs on a 5-minute cron schedule, every token
// still gets covered eventually even though no single invoke looks at more
// than a handful. For each token in the batch, it pulls the most recent
// transfers from the Robinhood Chain Blockscout explorer
// (/api/v2/tokens/{address_hash}/transfers, public API, no key needed),
// makes sure the wallets involved exist in the `wallets` table, and
// inserts the transfers into `transactions`.
//
// Buy/sell direction: Blockscout's transfers endpoint doesn't label a
// transfer as a trade, so direction is inferred from whether the transfer
// counterpart is a contract (the `is_contract` flag Blockscout returns on
// `from`/`to`) -- tokens moving INTO a contract are treated as a sell by
// the sending wallet, tokens moving OUT of a contract are treated as a buy
// by the receiving wallet. This is a heuristic, NOT a curated list of known
// Robinhood Chain DEX pool/router addresses (no such list was available to
// build this against), so a transfer into/out of some other kind of
// contract (a bridge, a staking contract, etc.) would be mislabeled as a
// trade. Transfers between two plain wallets, or between two contracts,
// can't be classified as a buy or a sell either way and are skipped rather
// than guessed -- see `transactions_unclassified_skipped` in the response.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke sync-transactions

import { createClient } from "jsr:@supabase/supabase-js@2";

const BLOCKSCOUT_BASE_URL = "https://robinhoodchain.blockscout.com";

// Same field-name uncertainty as sync-tokens: Blockscout has renamed fields
// across API versions, and we don't have live access to this specific
// instance from the build environment, so each mapping tries a few
// candidate names in order.
const ADDRESS_FIELDS = ["address_hash", "address", "hash"];
const TX_HASH_FIELDS = ["transaction_hash", "tx_hash", "hash"];

const MAX_PAGES_PER_TOKEN = 2; // "latest transfers", not full history
// Live runs against the full ~342-row tokens table hit WORKER_RESOURCE_LIMIT
// (the Edge Function ran out of compute mid-invoke) even after capping to
// the top 25 by volume -- the free-tier Edge Function compute budget per
// invoke is the real constraint, not just row count. Each invoke now only
// looks at a handful of tokens, tracked via a cursor (see `sync_cursors`
// below) so the next invoke continues from there instead of starting over.
const TOKENS_PER_RUN = 5;
const CURSOR_NAME = "sync-transactions";
const BATCH_SIZE = 500;

interface BlockscoutItem {
  [key: string]: unknown;
}

interface BlockscoutTransfersResponse {
  items: BlockscoutItem[];
  next_page_params?: Record<string, unknown> | null;
}

interface TokenRow {
  id: string;
  contract_address: string;
  price_usd: number;
}

interface TransactionRow {
  wallet_id: string;
  token_id: string;
  type: "buy" | "sell";
  amount: number;
  value_usd: number;
  tx_hash: string;
  occurred_at: string;
}

interface Party {
  address: string | null;
  isContract: boolean;
}

function firstDefined(item: BlockscoutItem, fields: string[]): unknown {
  for (const field of fields) {
    if (item[field] !== undefined && item[field] !== null) return item[field];
  }
  return undefined;
}

function toNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function extractParty(raw: unknown): Party {
  if (!raw || typeof raw !== "object") return { address: null, isContract: false };
  const obj = raw as BlockscoutItem;
  const address = firstDefined(obj, ADDRESS_FIELDS);
  return {
    address: typeof address === "string" && address.length > 0 ? address : null,
    isContract: obj.is_contract === true,
  };
}

function extractAmount(item: BlockscoutItem): number {
  const total = item.total as BlockscoutItem | undefined;
  if (!total) return 0;
  const value = toNumber(total.value);
  const decimals = Math.trunc(toNumber(total.decimals));
  if (decimals <= 0) return value;
  return value / Math.pow(10, decimals);
}

async function fetchTransfersForToken(
  contractAddress: string,
): Promise<{ items: BlockscoutItem[]; pages: number }> {
  const items: BlockscoutItem[] = [];
  const base = `${BLOCKSCOUT_BASE_URL}/api/v2/tokens/${encodeURIComponent(contractAddress)}/transfers`;
  let url = base;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_TOKEN) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) break; // token not indexed / has no transfers
    if (!res.ok) {
      throw new Error(`Blockscout API returned ${res.status} ${res.statusText} for ${url}`);
    }
    const data = (await res.json()) as BlockscoutTransfersResponse;
    items.push(...(data.items ?? []));
    pages++;

    if (data.next_page_params && Object.keys(data.next_page_params).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data.next_page_params)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      url = `${base}?${params.toString()}`;
    } else {
      url = "";
    }
  }

  return { items, pages };
}

// deno-lint-ignore no-explicit-any
async function loadCursor(supabase: any): Promise<string | null> {
  const { data, error } = await supabase
    .from("sync_cursors")
    .select("last_token_id")
    .eq("cursor_name", CURSOR_NAME)
    .maybeSingle();
  if (error) throw new Error(`Failed to load sync cursor: ${error.message}`);
  return (data?.last_token_id as string | undefined) ?? null;
}

// deno-lint-ignore no-explicit-any
async function saveCursor(supabase: any, lastTokenId: string): Promise<void> {
  const { error } = await supabase
    .from("sync_cursors")
    .upsert(
      { cursor_name: CURSOR_NAME, last_token_id: lastTokenId, updated_at: new Date().toISOString() },
      { onConflict: "cursor_name" },
    );
  if (error) throw new Error(`Failed to save sync cursor: ${error.message}`);
}

// Fetches the next TOKENS_PER_RUN tokens after `afterId` (ordered by id for
// a stable, deterministic traversal), wrapping around to the start of the
// table if fewer than TOKENS_PER_RUN remain past that point.
// deno-lint-ignore no-explicit-any
async function loadNextTokenBatch(
  supabase: any,
  afterId: string | null,
): Promise<{ id: string; contract_address: string; price_usd: unknown }[]> {
  let query = supabase
    .from("tokens")
    .select("id,contract_address,price_usd")
    .order("id", { ascending: true })
    .limit(TOKENS_PER_RUN);
  if (afterId) query = query.gt("id", afterId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load tokens: ${error.message}`);
  let rows = data ?? [];

  if (afterId && rows.length < TOKENS_PER_RUN) {
    const remaining = TOKENS_PER_RUN - rows.length;
    const seenIds = rows.map((row: { id: string }) => row.id);
    let wrapQuery = supabase
      .from("tokens")
      .select("id,contract_address,price_usd")
      .order("id", { ascending: true })
      .limit(remaining);
    if (seenIds.length > 0) wrapQuery = wrapQuery.not("id", "in", `(${seenIds.join(",")})`);

    const { data: wrapData, error: wrapError } = await wrapQuery;
    if (wrapError) throw new Error(`Failed to load wrap-around tokens: ${wrapError.message}`);
    rows = rows.concat(wrapData ?? []);
  }

  return rows;
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars (should be auto-provided by the Edge Functions runtime)",
      );
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Load this run's batch of tokens, continuing from the cursor left
    // by the previous invoke (see the TOKENS_PER_RUN comment above).
    const cursorBefore = await loadCursor(supabase);
    const tokenRows = await loadNextTokenBatch(supabase, cursorBefore);

    const tokens: TokenRow[] = tokenRows.map((row) => ({
      id: row.id as string,
      contract_address: row.contract_address as string,
      price_usd: toNumber(row.price_usd),
    }));

    // 2. Fetch latest transfers per token.
    let transfersFetched = 0;
    let tokenFetchErrors = 0;
    const perTokenTransfers: { token: TokenRow; items: BlockscoutItem[] }[] = [];

    for (const token of tokens) {
      try {
        const { items } = await fetchTransfersForToken(token.contract_address);
        transfersFetched += items.length;
        perTokenTransfers.push({ token, items });
      } catch {
        tokenFetchErrors++;
      }
    }

    // 3. Collect every wallet address seen (either side of any transfer).
    const addressSet = new Set<string>();
    for (const { items } of perTokenTransfers) {
      for (const item of items) {
        const from = extractParty(item.from);
        const to = extractParty(item.to);
        if (from.address) addressSet.add(from.address);
        if (to.address) addressSet.add(to.address);
      }
    }
    const addresses = Array.from(addressSet);

    // 4. Insert any wallet we haven't seen before (address only -- other
    // columns are computed elsewhere and default on the table). Upsert with
    // ignoreDuplicates so existing wallet rows (and their computed stats)
    // are left untouched.
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const batch = addresses.slice(i, i + BATCH_SIZE).map((address) => ({ address }));
      const { error } = await supabase
        .from("wallets")
        .upsert(batch, { onConflict: "address", ignoreDuplicates: true });
      if (error) throw new Error(`Wallet upsert failed: ${error.message}`);
    }

    // 5. Build an address -> wallet id map for every address involved.
    const walletIdByAddress = new Map<string, string>();
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const batch = addresses.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase.from("wallets").select("id,address").in("address", batch);
      if (error) throw new Error(`Failed to load wallet ids: ${error.message}`);
      for (const row of data ?? []) {
        walletIdByAddress.set(String(row.address).toLowerCase(), row.id as string);
      }
    }

    // 6. Classify each transfer and build transaction rows.
    let unclassifiedSkipped = 0;
    let missingWalletSkipped = 0;
    let missingTxHashSkipped = 0;
    const txRows: TransactionRow[] = [];

    for (const { token, items } of perTokenTransfers) {
      for (const item of items) {
        const from = extractParty(item.from);
        const to = extractParty(item.to);

        let walletAddress: string | null = null;
        let type: "buy" | "sell" | null = null;

        if (to.isContract && !from.isContract) {
          walletAddress = from.address;
          type = "sell";
        } else if (from.isContract && !to.isContract) {
          walletAddress = to.address;
          type = "buy";
        }

        if (!type || !walletAddress) {
          unclassifiedSkipped++;
          continue;
        }

        const walletId = walletIdByAddress.get(walletAddress.toLowerCase());
        if (!walletId) {
          missingWalletSkipped++;
          continue;
        }

        const txHashRaw = firstDefined(item, TX_HASH_FIELDS);
        const txHash = typeof txHashRaw === "string" ? txHashRaw : "";
        if (!txHash) {
          missingTxHashSkipped++;
          continue;
        }

        const occurredAt =
          typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString();
        const amount = extractAmount(item);

        txRows.push({
          wallet_id: walletId,
          token_id: token.id,
          type,
          amount,
          value_usd: amount * token.price_usd,
          tx_hash: txHash,
          occurred_at: occurredAt,
        });
      }
    }

    // `transactions.tx_hash` is unique table-wide (one row per transaction
    // hash, not per token/wallet) -- confirmed by a live run that hit
    // "duplicate key value violates unique constraint
    // transactions_tx_hash_key" even though every row it sent had a
    // distinct (tx_hash, token_id, wallet_id) tuple. Dedupe on tx_hash
    // alone to match: same-batch duplicates (overlapping pages, or a
    // single transaction moving more than one tracked token) collapse to
    // one row -- last occurrence wins -- instead of tripping Postgres's
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const rowsByTxHash = new Map<string, TransactionRow>();
    for (const row of txRows) {
      rowsByTxHash.set(row.tx_hash, row);
    }
    const dedupedRows = Array.from(rowsByTxHash.values());
    const duplicateTxHashSkipped = txRows.length - dedupedRows.length;

    let buyCount = 0;
    let sellCount = 0;
    for (const row of dedupedRows) {
      if (row.type === "sell") sellCount++;
      else buyCount++;
    }

    // Already-seen tx_hash values (from an earlier invoke, or another
    // token's transfer list overlapping this one) are expected on every
    // run -- ignoreDuplicates makes that a quiet no-op (ON CONFLICT DO
    // NOTHING) instead of failing the whole batch.
    let upserted = 0;
    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
      const batch = dedupedRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("transactions")
        .upsert(batch, { onConflict: "tx_hash", ignoreDuplicates: true });
      if (error) throw new Error(`Transaction upsert failed: ${error.message}`);
      upserted += batch.length;
    }

    // Advance the cursor only after the whole run succeeds, so a failure
    // partway through (e.g. a Supabase write error) retries the same batch
    // next invoke instead of silently skipping it.
    let cursorAfter = cursorBefore;
    if (tokens.length > 0) {
      cursorAfter = tokens[tokens.length - 1].id;
      await saveCursor(supabase, cursorAfter);
    }

    const summary = {
      ok: true,
      cursor_before: cursorBefore,
      cursor_after: cursorAfter,
      tokens_processed: tokens.length,
      tokens_per_run_cap: TOKENS_PER_RUN,
      token_fetch_errors: tokenFetchErrors,
      transfers_fetched: transfersFetched,
      wallets_seen: addresses.length,
      transactions_classified_buy: buyCount,
      transactions_classified_sell: sellCount,
      transactions_unclassified_skipped: unclassifiedSkipped,
      transactions_missing_wallet_skipped: missingWalletSkipped,
      transactions_missing_tx_hash_skipped: missingTxHashSkipped,
      transactions_duplicate_tx_hash_skipped: duplicateTxHashSkipped,
      transactions_upserted: upserted,
      note:
        "Buy/sell is inferred from the Blockscout `is_contract` flag on the transfer counterpart, " +
        "not a curated list of known Robinhood Chain DEX pool addresses -- transfers touching a " +
        "non-DEX contract (bridge, staking, etc.) may be mislabeled, and wallet-to-wallet transfers " +
        "(neither side a contract) are skipped rather than guessed.",
      synced_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }, null, 2), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
