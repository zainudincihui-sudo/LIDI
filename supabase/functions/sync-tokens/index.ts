// sync-tokens
//
// Pulls real token data from the Robinhood Chain Blockscout explorer
// (public API, no key needed) and upserts it into the `tokens` table,
// replacing the sample/demo rows that shipped with the frontend.
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
    let skipped = 0;
    const rows: TokenRow[] = [];

    for (const item of items) {
      const address = firstDefined(item, ADDRESS_FIELDS);
      if (typeof address !== "string" || address.length === 0) {
        skipped++;
        continue;
      }

      const priceChangeRaw = firstDefined(item, PRICE_CHANGE_FIELDS);
      if (priceChangeRaw !== undefined) priceChangeFieldFound = true;

      rows.push({
        contract_address: address,
        name: typeof item.name === "string" ? item.name : "",
        ticker: typeof item.symbol === "string" ? item.symbol : "",
        price_usd: toNumber(item.exchange_rate),
        volume_24h: toNumber(item.volume_24h),
        holder_count: Math.trunc(toNumber(firstDefined(item, HOLDERS_FIELDS))),
        price_change_24h: toNumber(priceChangeRaw), // 0 if the field doesn't exist
      });
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

    const summary = {
      ok: true,
      fetched: items.length,
      pages,
      upserted,
      skipped_missing_address: skipped,
      price_change_24h_field_found: priceChangeFieldFound,
      note: priceChangeFieldFound
        ? undefined
        : "Blockscout response has no 24h price-change field; price_change_24h was written as 0 for every row.",
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
