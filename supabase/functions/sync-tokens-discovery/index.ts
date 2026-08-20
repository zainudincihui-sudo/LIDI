// sync-tokens-discovery
//
// Expands token coverage beyond sync-tokens' first MAIN_SYNC_PAGES pages of
// Blockscout's /api/v2/tokens list, without touching sync-tokens itself --
// same reasoning as why sync-launchpad is a separate function (see its
// file-level comment): sync-tokens is the most frequently invoked,
// longest-stable function in this project, so anything newer/riskier goes
// in its own Edge Function instead of being folded in.
//
// Blockscout's token list is already sorted server-side -- confirmed
// against its public API v2 swagger (blockscout/blockscout-api-v2-swagger)
// and the underlying `list_top` sort order: circulating_market_cap desc
// nulls last, then fiat_value desc nulls last, then holder_count desc nulls
// last, then name/contract_address_hash asc. Nulls-last means real,
// actively-traded tokens cluster at the front of the list and pure
// launchpad spam (no market cap, no fiat value, no holders) sinks toward
// the back. So sync-tokens' first MAIN_SYNC_PAGES pages already capture
// the "top" tokens; this function's job is to slowly walk deeper into the
// list to pick up additional tokens that *do* have real holders/volume but
// didn't make the front page, while skipping (not upserting) anything with
// zero holders AND zero volume -- see `skipped_no_activity` below.
//
// The API itself has no sort/filter query params to ask for "top N by
// holders" directly (confirmed against the swagger spec: /tokens only
// takes `q` and `type`), which is why this walks the default-sorted list
// with a cursor instead of requesting a different order.
//
// Runs on a lighter cron than sync-tokens (see the schedule migration) and
// advances a small number of pages per invoke via a persisted cursor
// (`sync_cursors`, the same table sync-transactions uses for its own
// cursor, extended with a `next_page_params` column) -- so per-invoke
// compute stays bounded no matter how large Blockscout's total token list
// grows, following the same "small batch per invoke, cursor picks up where
// the last invoke left off" pattern already established by
// sync-transactions' TOKENS_PER_RUN.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke sync-tokens-discovery

import { createClient } from "jsr:@supabase/supabase-js@2";

const BLOCKSCOUT_TOKENS_URL =
  "https://robinhoodchain.blockscout.com/api/v2/tokens";

// Same field-name uncertainty as sync-tokens: Blockscout has renamed fields
// across API versions, and we don't have live access to this specific
// instance from the build environment, so each mapping tries a couple of
// candidate names in order.
const ADDRESS_FIELDS = ["address_hash", "address", "contract_address_hash", "hash"];
const HOLDERS_FIELDS = ["holders_count", "holders"];
const DECIMALS_FIELDS = ["decimals", "token_decimals"];

// Must match sync-tokens' MAX_PAGES: this is how many pages at the front of
// Blockscout's token list sync-tokens already owns and refreshes every 5
// minutes. This function starts *after* that boundary so the two never
// upsert the same front-page tokens at cross purposes. If sync-tokens'
// MAX_PAGES ever changes, update this to match.
const MAIN_SYNC_PAGES = 10;

// Small per-invoke step into the "long tail" beyond MAIN_SYNC_PAGES, so a
// single invoke's compute stays bounded regardless of how deep the cursor
// eventually gets -- same reasoning as sync-transactions' TOKENS_PER_RUN.
const DISCOVERY_PAGES_PER_RUN = 5;

const CURSOR_NAME = "sync-tokens-discovery";
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
  icon_url: string | null;
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

function buildUrl(params: Record<string, unknown> | null | undefined): string {
  if (!params || Object.keys(params).length === 0) return BLOCKSCOUT_TOKENS_URL;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return `${BLOCKSCOUT_TOKENS_URL}?${search.toString()}`;
}

async function fetchPage(
  params: Record<string, unknown> | null | undefined,
): Promise<BlockscoutTokensResponse> {
  const url = buildUrl(params);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Blockscout API returned ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as BlockscoutTokensResponse;
}

function tokenRowFromItem(item: BlockscoutTokenItem): TokenRow | null {
  const address = firstDefined(item, ADDRESS_FIELDS);
  if (typeof address !== "string" || address.length === 0) return null;

  const decimalsRaw = firstDefined(item, DECIMALS_FIELDS);

  // price_change_24h is deliberately not set here -- same reasoning as
  // sync-tokens/index.ts: Blockscout's token list has never carried a real
  // 24h-change field on this instance, and recompute_token_price_changes()
  // (20260820090000_compute_token_price_change_24h.sql) now owns that
  // column, computed from token_price_history.
  return {
    contract_address: address,
    name: typeof item.name === "string" ? item.name : "",
    ticker: typeof item.symbol === "string" ? item.symbol : "",
    price_usd: toNumber(item.exchange_rate),
    volume_24h: toNumber(item.volume_24h),
    holder_count: Math.trunc(toNumber(firstDefined(item, HOLDERS_FIELDS))),
    icon_url: typeof item.icon_url === "string" ? item.icon_url : null,
    decimals: decimalsRaw !== undefined ? Math.trunc(toNumber(decimalsRaw)) : null,
  };
}

// deno-lint-ignore no-explicit-any
async function loadCursor(supabase: any): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("sync_cursors")
    .select("next_page_params")
    .eq("cursor_name", CURSOR_NAME)
    .maybeSingle();
  if (error) throw new Error(`Failed to load sync cursor: ${error.message}`);
  const params = data?.next_page_params as Record<string, unknown> | null | undefined;
  return params ?? null;
}

// deno-lint-ignore no-explicit-any
async function saveCursor(
  supabase: any,
  nextPageParams: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await supabase
    .from("sync_cursors")
    .upsert(
      {
        cursor_name: CURSOR_NAME,
        next_page_params: nextPageParams,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "cursor_name" },
    );
  if (error) throw new Error(`Failed to save sync cursor: ${error.message}`);
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

    let cursor = await loadCursor(supabase);
    let bootstrapPages = 0;
    let boundaryReachedListEnd = false;

    // No stored cursor means either this is the very first-ever run, or the
    // previous run walked off the end of Blockscout's list and reset it
    // (see the wrap-around save at the end of this handler). Either way,
    // walk past the first MAIN_SYNC_PAGES pages -- sync-tokens' territory --
    // without upserting anything, purely to get positioned at the
    // discovery boundary.
    if (cursor === null) {
      let params: Record<string, unknown> | null | undefined = undefined;
      for (let i = 0; i < MAIN_SYNC_PAGES; i++) {
        const page = await fetchPage(params);
        bootstrapPages++;
        if (!page.next_page_params || Object.keys(page.next_page_params).length === 0) {
          // Blockscout's whole list is <= MAIN_SYNC_PAGES pages -- sync-tokens
          // already covers everything that exists, nothing left to discover.
          boundaryReachedListEnd = true;
          break;
        }
        params = page.next_page_params;
      }
      cursor = boundaryReachedListEnd ? null : (params as Record<string, unknown>);
    }

    let upserted = 0;
    let itemsSeen = 0;
    let skippedNoActivity = 0;
    let skippedMissingAddress = 0;
    let discoveryPages = 0;
    let reachedEndOfList = false;
    const rowsByAddress = new Map<string, TokenRow>();

    if (!boundaryReachedListEnd) {
      let params: Record<string, unknown> | null | undefined = cursor;
      for (let i = 0; i < DISCOVERY_PAGES_PER_RUN; i++) {
        const page = await fetchPage(params);
        discoveryPages++;
        itemsSeen += page.items.length;

        for (const item of page.items) {
          const row = tokenRowFromItem(item);
          if (!row) {
            skippedMissingAddress++;
            continue;
          }
          // The whole point of this function: only widen coverage to
          // tokens with real activity, never the launchpad-spam long tail.
          if (row.holder_count <= 0 && row.volume_24h <= 0) {
            skippedNoActivity++;
            continue;
          }
          rowsByAddress.set(row.contract_address.toLowerCase(), row);
        }

        if (!page.next_page_params || Object.keys(page.next_page_params).length === 0) {
          reachedEndOfList = true;
          params = null;
          break;
        }
        params = page.next_page_params;
      }

      const rows = Array.from(rowsByAddress.values());
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from("tokens")
          .upsert(batch, { onConflict: "contract_address" });
        if (error) throw new Error(`Upsert failed: ${error.message}`);
        upserted += batch.length;
      }

      // Reaching the true end of Blockscout's list resets the cursor to
      // null, so the *next* invoke re-does the boundary skip and restarts
      // discovery from MAIN_SYNC_PAGES+1 -- a full wrap-around, the same
      // idea as sync-transactions wrapping back to the start of the tokens
      // table once it runs off the end.
      await saveCursor(supabase, reachedEndOfList ? null : (params as Record<string, unknown>));
    } else {
      // Nothing to discover this run -- leave the cursor cleared so the
      // next invoke checks again (cheap: MAIN_SYNC_PAGES fetches, zero
      // discovery fetches) in case Blockscout's list has grown past
      // MAIN_SYNC_PAGES since.
      await saveCursor(supabase, null);
    }

    const summary = {
      ok: true,
      bootstrap_pages_fetched: bootstrapPages,
      discovery_pages_fetched: discoveryPages,
      main_sync_pages: MAIN_SYNC_PAGES,
      discovery_pages_per_run_cap: DISCOVERY_PAGES_PER_RUN,
      items_seen: itemsSeen,
      upserted,
      skipped_no_activity: skippedNoActivity,
      skipped_missing_address: skippedMissingAddress,
      reached_end_of_blockscout_list: reachedEndOfList || boundaryReachedListEnd,
      note: boundaryReachedListEnd
        ? "Blockscout's token list is not yet longer than sync-tokens' own MAX_PAGES coverage -- nothing beyond it to discover yet."
        : undefined,
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
