// sync-launchpad
//
// Tags each row in `tokens` with the launchpad (factory / bonding-curve
// contract) that deployed it -- see issue #17.
//
// Blockscout's token-list endpoint (`/api/v2/tokens`, used by sync-tokens)
// does not carry a creator/deployer address -- confirmed against the
// official API v2 schema (blockscout/blockscout-api-v2-swagger). That field
// only exists on the *address* endpoint, `/api/v2/addresses/{address_hash}`
// (`creator_address_hash`), which means one extra API call per token. This
// is deliberately a separate Edge Function rather than folded into
// sync-tokens, so sync-tokens' existing full-table-per-invoke fetch stays
// cheap and untouched.
//
// A live run of sync-transactions hit WORKER_RESOURCE_LIMIT processing the
// full ~342-row tokens table in one invoke even before adding any per-token
// extra call, and was fixed by capping each invoke to a small batch
// (TOKENS_PER_RUN) tracked via a round-robin cursor in `sync_cursors`. This
// function follows the same pattern: every invoke only looks up creator
// addresses for a handful of tokens, continuing from where the previous
// invoke left off and wrapping back to the start once it reaches the end.
// It cycles over the *whole* tokens table on every pass (not just
// never-checked rows) rather than tracking a per-token "already checked"
// flag -- deliberately simple, and it means a token also gets re-evaluated
// automatically if the known factory address list grows later (e.g. once
// Clanker's Robinhood Chain factory address is confirmed), without a
// separate backfill run. The tradeoff is repeat lookups for tokens whose
// launchpad is already settled; at TOKENS_PER_RUN tokens per 5-minute cron
// tick that's an acceptable amount of waste for a background tagging job.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke sync-launchpad

import { createClient } from "jsr:@supabase/supabase-js@2";

const BLOCKSCOUT_BASE_URL = "https://robinhoodchain.blockscout.com";

// Confirmed from each launchpad's own documentation (see issue #17 research
// notes) -- not guessed or scraped from on-chain activity. Matched
// case-insensitively since addresses are compared as lowercase hex.
const FACTORY_LAUNCHPADS: Record<string, string> = {
  // Pons (docs.ponsfamily.com) -- active factory
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "pons",
  // Pons (docs.ponsfamily.com) -- legacy factory
  "0x0c37a24f5d23a486fa692d1500881d698b1f77a4": "pons",
  // Virtuals Protocol (whitepaper.virtuals.io) -- Robinhood Chain bonding curve
  "0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007": "virtuals",
};

// Same field-name-uncertainty defense as sync-tokens/sync-transactions:
// Blockscout has renamed fields across API versions, and this build
// environment can't reach the live instance to confirm the exact current
// name, so a couple of candidates are tried in order.
const CREATOR_FIELDS = ["creator_address_hash", "creator_address"];

// A single /api/v2/addresses/{address} call per token, vs. sync-transactions'
// up to MAX_PAGES_PER_TOKEN=2 calls per token at TOKENS_PER_RUN=5 -- so this
// stays at least as cheap per invoke while still erring conservative given
// the prior WORKER_RESOURCE_LIMIT hit.
const TOKENS_PER_RUN = 10;
const CURSOR_NAME = "sync-launchpad";

interface BlockscoutItem {
  [key: string]: unknown;
}

interface TokenRow {
  id: string;
  contract_address: string;
}

function firstDefined(item: BlockscoutItem, fields: string[]): unknown {
  for (const field of fields) {
    if (item[field] !== undefined && item[field] !== null) return item[field];
  }
  return undefined;
}

function classifyLaunchpad(creatorAddress: string | null): string | null {
  if (!creatorAddress) return null;
  return FACTORY_LAUNCHPADS[creatorAddress.toLowerCase()] ?? null;
}

// Returns the creator/deployer address for a token contract, or null if
// Blockscout has no address record for it (404) or the record has no
// creator field (e.g. an EOA, or an unverified/unindexed contract).
async function fetchCreatorAddress(contractAddress: string): Promise<string | null> {
  const url = `${BLOCKSCOUT_BASE_URL}/api/v2/addresses/${encodeURIComponent(contractAddress)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Blockscout API returned ${res.status} ${res.statusText} for ${url}`);
  }
  const data = (await res.json()) as BlockscoutItem;
  const creator = firstDefined(data, CREATOR_FIELDS);
  return typeof creator === "string" && creator.length > 0 ? creator : null;
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

// Same batch-with-wraparound traversal as sync-transactions' loadNextTokenBatch.
// deno-lint-ignore no-explicit-any
async function loadNextTokenBatch(supabase: any, afterId: string | null): Promise<TokenRow[]> {
  let query = supabase
    .from("tokens")
    .select("id,contract_address")
    .order("id", { ascending: true })
    .limit(TOKENS_PER_RUN);
  if (afterId) query = query.gt("id", afterId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load tokens: ${error.message}`);
  let rows = (data ?? []) as TokenRow[];

  if (afterId && rows.length < TOKENS_PER_RUN) {
    const remaining = TOKENS_PER_RUN - rows.length;
    const seenIds = rows.map((row) => row.id);
    let wrapQuery = supabase
      .from("tokens")
      .select("id,contract_address")
      .order("id", { ascending: true })
      .limit(remaining);
    if (seenIds.length > 0) wrapQuery = wrapQuery.not("id", "in", `(${seenIds.join(",")})`);

    const { data: wrapData, error: wrapError } = await wrapQuery;
    if (wrapError) throw new Error(`Failed to load wrap-around tokens: ${wrapError.message}`);
    rows = rows.concat((wrapData ?? []) as TokenRow[]);
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

    const cursorBefore = await loadCursor(supabase);
    const tokens = await loadNextTokenBatch(supabase, cursorBefore);

    let matchedPons = 0;
    let matchedVirtuals = 0;
    let noMatch = 0;
    let fetchErrors = 0;

    for (const token of tokens) {
      let creatorAddress: string | null;
      try {
        creatorAddress = await fetchCreatorAddress(token.contract_address);
      } catch (err) {
        fetchErrors++;
        console.warn(
          `[sync-launchpad] failed to fetch creator address for ${token.contract_address}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue; // leave this token's launchpad untouched; retried next cycle
      }

      const launchpad = classifyLaunchpad(creatorAddress);
      if (launchpad === "pons") matchedPons++;
      else if (launchpad === "virtuals") matchedVirtuals++;
      else noMatch++;

      const { error } = await supabase
        .from("tokens")
        .update({ launchpad })
        .eq("id", token.id);
      if (error) throw new Error(`Failed to update launchpad for token ${token.id}: ${error.message}`);
    }

    // Advance the cursor only after the whole run succeeds, so a failure
    // partway through retries the same batch next invoke instead of
    // silently skipping it.
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
      matched_pons: matchedPons,
      matched_virtuals: matchedVirtuals,
      no_match: noMatch,
      fetch_errors: fetchErrors,
      note:
        "Clanker's Robinhood Chain factory address is not yet documented, so Clanker-deployed tokens " +
        "fall under no_match (launchpad stays NULL) for now -- separate follow-up once that address " +
        "is confirmed.",
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
