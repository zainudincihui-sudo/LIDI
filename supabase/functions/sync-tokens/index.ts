// sync-tokens
//
// Pulls real token data from the Robinhood Chain Blockscout explorer
// (public API, no key needed) and upserts it into the `tokens` table,
// replacing the sample/demo rows that shipped with the frontend.
//
// Also appends to `token_price_history` (issue #12 item 1 real fix -- see
// supabase/migrations/20260820060000_create_token_price_history_table.sql)
// whenever a token's price_usd actually changed from the value already on
// its `tokens` row, so recompute_wallet_performance() can look up a real
// historical price near a transfer's occurred_at instead of only ever
// knowing the current price.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke sync-tokens

import { createClient } from "jsr:@supabase/supabase-js@2";

const BLOCKSCOUT_TOKENS_URL =
  "https://robinhoodchain.blockscout.com/api/v2/tokens";

// Blockscout has renamed fields across API versions (e.g. `address` ->
// `address_hash`, `holders` -> `holders_count`). We don't have live access
// to this specific instance from the build environment, so each mapping
// tries the field names in order and falls back gracefully instead of
// silently writing nulls.
const ADDRESS_FIELDS = ["address_hash", "address", "contract_address_hash", "hash"];
const HOLDERS_FIELDS = ["holders_count", "holders"];
// Used by sync-transactions' extractAmount() as a fallback when a transfer
// payload doesn't carry its own `total.decimals` (see issue #12) -- so it's
// worth trying a couple of names here too rather than only the obvious one.
const DECIMALS_FIELDS = ["decimals", "token_decimals"];
// Candidate field names for a 24h price-change percentage. Blockscout's
// token-list endpoint is not known to expose one (it's a block explorer,
// not a price tracker) — these are checked just in case this instance adds
// it, and we fall back to 0 with a warning in the response if none exist.
const PRICE_CHANGE_FIELDS = [
  "exchange_rate_percent_change",
  "price_change_24h",
  "price_change_percentage_24h",
  "percent_change_24h",
];

const MAX_PAGES = 10; // safety cap so a runaway paginated response can't run forever
const BATCH_SIZE = 500;

interface BlockscoutTokenItem {
  [key: string]: unknown;
}

interface BlockscoutTokensResponse {
  items: BlockscoutTokenItem[];
  next_page_params?: Record<string, unknown> | null;
}

interface TokenRow {
  contract_address: string;
  name: string;
  ticker: string;
  price_usd: number;
  volume_24h: number;
  holder_count: number;
  price_change_24h: number;
  icon_url: string | null;
  // Null (not 0) when Blockscout's item has no decimals field at all, so
  // downstream fallback logic (sync-transactions' extractAmount()) can tell
  // "unknown" apart from a genuine 0-decimal token.
  decimals: number | null;
}

function firstDefined(item: BlockscoutTokenItem, fields: string[]): unknown {
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

async function fetchAllTokens(): Promise<{
  items: BlockscoutTokenItem[];
  pages: number;
}> {
  const items: BlockscoutTokenItem[] = [];
  let url = BLOCKSCOUT_TOKENS_URL;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Blockscout API returned ${res.status} ${res.statusText} for ${url}`,
      );
    }
    const data = (await res.json()) as BlockscoutTokensResponse;
    items.push(...(data.items ?? []));
    pages++;

    if (data.next_page_params && Object.keys(data.next_page_params).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data.next_page_params)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value));
        }
      }
      url = `${BLOCKSCOUT_TOKENS_URL}?${params.toString()}`;
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

    const { items, pages } = await fetchAllTokens();

    let priceChangeFieldFound = false;
    let decimalsFieldFound = false;
    let skipped = 0;
    // Keyed by lowercased address: a live run showed Blockscout can return
    // the same contract more than once (pagination overlap, or the same
    // address with different casing), which makes a single upsert batch
    // fail with "ON CONFLICT DO UPDATE command cannot affect row a second
    // time". Last occurrence wins.
    const rowsByAddress = new Map<string, TokenRow>();

    for (const item of items) {
      const address = firstDefined(item, ADDRESS_FIELDS);
      if (typeof address !== "string" || address.length === 0) {
        skipped++;
        continue;
      }

      const priceChangeRaw = firstDefined(item, PRICE_CHANGE_FIELDS);
      if (priceChangeRaw !== undefined) priceChangeFieldFound = true;

      const decimalsRaw = firstDefined(item, DECIMALS_FIELDS);
      if (decimalsRaw !== undefined) decimalsFieldFound = true;

      rowsByAddress.set(address.toLowerCase(), {
        contract_address: address,
        name: typeof item.name === "string" ? item.name : "",
        ticker: typeof item.symbol === "string" ? item.symbol : "",
        price_usd: toNumber(item.exchange_rate),
        volume_24h: toNumber(item.volume_24h),
        holder_count: Math.trunc(toNumber(firstDefined(item, HOLDERS_FIELDS))),
        price_change_24h: toNumber(priceChangeRaw), // 0 if the field doesn't exist
        icon_url: typeof item.icon_url === "string" ? item.icon_url : null,
        decimals: decimalsRaw !== undefined ? Math.trunc(toNumber(decimalsRaw)) : null,
      });
    }

    const rows = Array.from(rowsByAddress.values());
    const duplicatesSkipped = items.length - skipped - rows.length;

    // Load each token's price_usd as it stood *before* this run's upsert,
    // so we can tell afterwards whether the freshly-fetched price actually
    // moved. See token_price_history (20260820060000): at this function's
    // current 1-minute cron cadence, inserting a history row on every run
    // regardless of movement would be on the order of `rows.length` rows
    // every minute (~342 tokens today) for no extra precision, since the
    // price is constant between two real changes anyway -- only a change
    // needs its own row.
    const previousPriceByAddress = new Map<string, number>();
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE).map((row) => row.contract_address);
      const { data, error } = await supabase
        .from("tokens")
        .select("contract_address,price_usd")
        .in("contract_address", batch);
      if (error) throw new Error(`Failed to load existing prices: ${error.message}`);
      for (const row of data ?? []) {
        previousPriceByAddress.set(
          String(row.contract_address).toLowerCase(),
          toNumber(row.price_usd),
        );
      }
    }

    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("tokens")
        .upsert(batch, { onConflict: "contract_address" });
      if (error) throw new Error(`Upsert failed: ${error.message}`);
      upserted += batch.length;
    }

    // A token with no entry in previousPriceByAddress is one sync-tokens
    // has never seen before (first time this contract_address was upserted)
    // -- its price counts as "changed" so it gets a first history row too,
    // rather than silently having no history until its price next moves.
    const priceHistoryRows = rows
      .filter((row) => previousPriceByAddress.get(row.contract_address.toLowerCase()) !== row.price_usd)
      .map((row) => ({ token_address: row.contract_address, price_usd: row.price_usd }));

    let priceHistoryInserted = 0;
    for (let i = 0; i < priceHistoryRows.length; i += BATCH_SIZE) {
      const batch = priceHistoryRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from("token_price_history").insert(batch);
      if (error) throw new Error(`Price history insert failed: ${error.message}`);
      priceHistoryInserted += batch.length;
    }

    const summary = {
      ok: true,
      fetched: items.length,
      pages,
      upserted,
      skipped_missing_address: skipped,
      duplicates_skipped: duplicatesSkipped,
      price_history_inserted: priceHistoryInserted,
      price_history_unchanged: rows.length - priceHistoryRows.length,
      price_change_24h_field_found: priceChangeFieldFound,
      decimals_field_found: decimalsFieldFound,
      note: priceChangeFieldFound
        ? undefined
        : "Blockscout response has no 24h price-change field; price_change_24h was written as 0 for every row.",
      decimals_note: decimalsFieldFound
        ? undefined
        : "Blockscout response has no decimals field; tokens.decimals was written as null for every " +
          "row. sync-transactions' extractAmount() falls back to a hardcoded default (18) for these " +
          "tokens when a transfer payload also lacks decimals -- see issue #12.",
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
