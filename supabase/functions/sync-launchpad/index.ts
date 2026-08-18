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
// (TOKENS_PER_RUN). This function follows the same "small batch per
// invoke" idea, but orders its queue by `tokens.launchpad_checked_at`
// (NULL/never-checked first, then least-recently-checked) instead of a
// persisted id cursor: every invoke re-writes `launchpad_checked_at` on
// the rows it processes, so those rows naturally sort to the back of the
// queue on the next invoke. This means never-checked tokens (new rows from
// sync-tokens) always get looked at before any already-classified token is
// re-checked, while still eventually cycling back around to every row --
// e.g. once Clanker's Robinhood Chain factory address is confirmed and
// added to FACTORY_LAUNCHPADS, existing no-match tokens get re-evaluated
// without a separate backfill run, just on a much longer cycle than brand
// new tokens.
//
// Triggered on a schedule via pg_cron (see supabase/migrations), and can
// also be invoked manually for testing:
//   supabase functions invoke sync-launchpad

import { createClient } from "jsr:@supabase/supabase-js@2";

const BLOCKSCOUT_BASE_URL = "https://robinhoodchain.blockscout.com";

// Confirmed from each launchpad's own documentation, except Virtuals which
// is confirmed empirically (see issue #17 research notes) -- not guessed or
// scraped from on-chain activity. Matched case-insensitively since
// addresses are compared as lowercase hex.
const FACTORY_LAUNCHPADS: Record<string, string> = {
  // Pons (docs.ponsfamily.com) -- active factory
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "pons",
  // Pons (docs.ponsfamily.com) -- legacy factory
  "0x0c37a24f5d23a486fa692d1500881d698b1f77a4": "pons",
  // Virtuals Protocol -- Robinhood Chain BondingV5 proxy. Confirmed by
  // looking up GTR (a known Virtuals agent token, address verified via
  // app.virtuals.io) on Blockscout and reading its actual
  // creator_address_hash -- NOT from documentation, which only publishes
  // Base/Ethereum/Solana addresses. The previously-used
  // 0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007 is a different Virtuals
  // proxy on the same chain (not the one that deploys tokens) and never
  // matched any of the 451 tokens checked against it.
  "0x43e4c17b15365596caae8e7d00e42bc8e988c2d4": "virtuals",
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

// Selects the next batch to check: NULL `launchpad_checked_at` (never
// checked) sorts first, then oldest-checked next, so new tokens always get
// priority over re-checking settled ones -- see the file-level comment.
// deno-lint-ignore no-explicit-any
async function loadNextTokenBatch(supabase: any): Promise<TokenRow[]> {
  const { data, error } = await supabase
    .from("tokens")
    .select("id,contract_address")
    .order("launchpad_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(TOKENS_PER_RUN);
  if (error) throw new Error(`Failed to load tokens: ${error.message}`);
  return (data ?? []) as TokenRow[];
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

    const tokens = await loadNextTokenBatch(supabase);

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
        // Deliberately don't touch launchpad_checked_at here: a fetch
        // failure means this token wasn't actually checked, so it should
        // stay at the front of the queue for a retry next invoke instead
        // of rotating to the back as if it had been.
        continue;
      }

      const launchpad = classifyLaunchpad(creatorAddress);
      if (launchpad === "pons") matchedPons++;
      else if (launchpad === "virtuals") matchedVirtuals++;
      else noMatch++;

      const { error } = await supabase
        .from("tokens")
        .update({ launchpad, launchpad_checked_at: new Date().toISOString() })
        .eq("id", token.id);
      if (error) throw new Error(`Failed to update launchpad for token ${token.id}: ${error.message}`);
    }

    const summary = {
      ok: true,
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
