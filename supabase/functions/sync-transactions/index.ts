// sync-transactions
//
// For every token in the `tokens` table, pulls its most recent transfers
// from the Robinhood Chain Blockscout explorer
// (/api/v2/tokens/{address_hash}/transfers, public API, no key needed),
// makes sure the wallets involved exist in the `wallets` table, and inserts
// the transfers into `transactions`.
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

const MAX_PAGES_PER_TOKEN = 3; // "latest transfers", not full history
const MAX_TOKENS_PER_RUN = 300; // safety cap so a huge tokens table can't run forever
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

    // 1. Load every known token, paging past PostgREST's default row cap.
    const tokens: TokenRow[] = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("tokens")
          .select("id,contract_address,price_usd")
          .range(from, from + pageSize - 1);
        if (error) throw new Error(`Failed to load tokens: ${error.message}`);
        if (!data || data.length === 0) break;
        for (const row of data) {
          tokens.push({
            id: row.id as string,
            contract_address: row.contract_address as string,
            price_usd: toNumber(row.price_usd),
          });
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }

    const tokensToProcess = tokens.slice(0, MAX_TOKENS_PER_RUN);

    // 2. Fetch latest transfers per token.
    let transfersFetched = 0;
    let tokenFetchErrors = 0;
    const perTokenTransfers: { token: TokenRow; items: BlockscoutItem[] }[] = [];

    for (const token of tokensToProcess) {
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
    let buyCount = 0;
    let sellCount = 0;
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

        if (type === "sell") sellCount++;
        else buyCount++;
      }
    }

    // Same-batch duplicates (overlapping pages, the same transfer touching
    // more than one page boundary) would otherwise trip Postgres's "ON
    // CONFLICT DO UPDATE command cannot affect row a second time" -- keyed
    // to match the (tx_hash, token_id, wallet_id) unique constraint.
    const rowsByKey = new Map<string, TransactionRow>();
    for (const row of txRows) {
      rowsByKey.set(`${row.tx_hash}|${row.token_id}|${row.wallet_id}`, row);
    }
    const dedupedRows = Array.from(rowsByKey.values());

    let upserted = 0;
    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
      const batch = dedupedRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("transactions")
        .upsert(batch, { onConflict: "tx_hash,token_id,wallet_id", ignoreDuplicates: true });
      if (error) throw new Error(`Transaction upsert failed: ${error.message}`);
      upserted += batch.length;
    }

    const summary = {
      ok: true,
      tokens_known: tokens.length,
      tokens_processed: tokensToProcess.length,
      token_fetch_errors: tokenFetchErrors,
      transfers_fetched: transfersFetched,
      wallets_seen: addresses.length,
      transactions_classified_buy: buyCount,
      transactions_classified_sell: sellCount,
      transactions_unclassified_skipped: unclassifiedSkipped,
      transactions_missing_wallet_skipped: missingWalletSkipped,
      transactions_missing_tx_hash_skipped: missingTxHashSkipped,
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
