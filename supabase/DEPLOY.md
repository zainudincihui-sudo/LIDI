# Deploying `sync-tokens`

## Recommended: GitHub Actions

The Claude Code sandbox this project is normally developed in has an egress
policy that blocks `*.supabase.co`, `api.supabase.com`, and
`*.blockscout.com` (confirmed via direct 403s from the proxy on all three,
across two separate sessions). GitHub Actions runners aren't behind that
policy, so `.github/workflows/deploy-sync-tokens.yml` runs the whole deploy
there instead:

1. In the repo, go to **Settings → Secrets and variables → Actions** and add
   a secret named `SUPABASE_ACCESS_TOKEN` with a Supabase personal access
   token (Dashboard → Account → Access Tokens). Never commit this token.
2. Go to **Actions → Deploy sync-tokens to Supabase → Run workflow**.

The workflow links the project, resolves the project's `service_role` key
from the Management API, upserts it into Vault as
`sync_tokens_service_role_key` (so the pg_cron schedule can authenticate),
pushes migrations, deploys the function with `--use-api` (no Docker needed),
invokes it once with `curl`, and reads back the top 10 rows of `tokens` by
volume. All of that is uploaded as a `sync-tokens-deploy-results` artifact
on the run, and shows up in the step logs too.

## Manual (from a machine with real internet access)

```bash
npm install -g supabase
supabase login   # or: export SUPABASE_ACCESS_TOKEN=<your personal access token>
supabase link --project-ref ruatieohvdxjnmcfhqwh
supabase db push
supabase functions deploy sync-tokens --project-ref ruatieohvdxjnmcfhqwh --use-api
```

`sync-tokens` is invoked on a schedule by pg_cron, which calls it over HTTP
and needs the project's **service role key** (Project Settings → API) to
authenticate. Run this once in the SQL editor (Dashboard → SQL Editor),
replacing the placeholder, before the cron job's first run:

```sql
select vault.create_secret('<SERVICE_ROLE_KEY>', 'sync_tokens_service_role_key');
```

Then test it directly (`supabase functions invoke` was removed from the CLI
— as of v2.114.0 `supabase functions` only has `list`/`delete`/`download`/
`deploy`/`new`/`serve`, so hit the deployed endpoint with `curl` instead):

```bash
curl -X POST "https://ruatieohvdxjnmcfhqwh.supabase.co/functions/v1/sync-tokens" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json"
```

It returns a JSON summary (`fetched`, `upserted`, `skipped_missing_address`,
`decimals_field_found`, `price_history_inserted`,
`price_history_unchanged`). Then confirm the table actually changed:

```sql
select contract_address, ticker, name, price_usd, volume_24h, holder_count, price_change_24h, icon_url
from tokens
order by volume_24h desc
limit 10;
```

## `token_price_history` (issue #12 item 1 real fix)

sync-tokens also appends to `token_price_history` (see
`supabase/migrations/20260820060000_create_token_price_history_table.sql`),
but only when a token's `price_usd` actually changed from what's already on
its `tokens` row -- not on every run. At the 1-minute cron cadence
(20260820050000), inserting unconditionally would be on the order of
`fetched` rows every minute for no extra precision, since the price is
constant between two real changes anyway. Verify it's populating:

```sql
select token_address, price_usd, recorded_at
from token_price_history
order by recorded_at desc
limit 10;
```

`recompute_wallet_performance()` (see
`20260820070000_wallet_performance_use_price_history.sql`) uses this table
to look up the price closest to (at or before) each transfer's
`occurred_at`, instead of trusting `transactions.value_usd`'s sync-time
snapshot. To verify the fix actually improved precision after deploying,
compare `wallets_pnl_30d_reliable` in the `recompute_wallet_performance`
RPC response (or the `recompute-result.json` artifact from the "Deploy
wallet performance recompute" workflow) against its value before this
change -- it should go up, since real historical pricing produces bigger,
less-noise-compressed `pnl_30d` swings that clear the 1% materiality
threshold more often (see
`20260820040000_flag_pnl_30d_reliability.sql`).

A daily pg_cron job (`20260820080000_token_price_history_retention.sql`)
prunes rows older than 60 days so this table doesn't grow unbounded --
transactions older than that fall back to their stored `value_usd`, same as
any transaction that predates this table entirely.

## About `price_change_24h`

Blockscout's `/api/v2/tokens` endpoint is a block-explorer API, not a price
tracker — its documented schema (`address`/`address_hash`, `name`, `symbol`,
`exchange_rate`, `volume_24h`, `holders`/`holders_count`) has no field for a
24h percentage change, confirmed live in production (every row synced came
back with no matching field, which is what made Trending's badge always
show "+0.0%"). sync-tokens and sync-tokens-discovery no longer try to read
or write this column at all — including a hardcoded `0` in every upsert
was actively harmful, since it reset the column back to 0 on every
1-minute sync-tokens run regardless of what had computed it in between.

`tokens.price_change_24h` is now computed by
`public.recompute_token_price_changes()`
(`20260820090000_compute_token_price_change_24h.sql`), scheduled every 15
minutes via pg_cron — same pattern as `recompute_wallet_performance()`. It
compares the token's current `price_usd` against the closest
`token_price_history` observation at or before 24 hours ago. Tokens without
history reaching back that far (just discovered, or a very old row that's
aged out of the 60-day retention window) get `price_change_24h_reliable =
false` instead of a computed percentage — the frontend renders "Low data"
for those rather than a `price_change_24h` of `0` that would read as "the
price hasn't moved" when it actually means "not enough history yet". Verify
it's populating real values:

```sql
select contract_address, ticker, price_usd, price_change_24h, price_change_24h_reliable
from tokens
order by price_change_24h_reliable desc, price_change_24h desc
limit 10;
```

## `icon_url`

Blockscout's `/api/v2/tokens` items include an `icon_url` field (token logo,
nullable when Blockscout has no logo for that token). The function writes it
straight into `tokens.icon_url` with no fallback field names, since this one
has been stable across Blockscout API versions.

## New tables need `NOTIFY pgrst, 'reload schema'`

`supabase db push` applies migrations over a direct Postgres connection,
which doesn't itself push a schema-reload notice to PostgREST the way
changes made through the Supabase dashboard do. A migration that adds a
table/column meant to be queried over the REST API (`/rest/v1/...`) can
succeed at the database level while PostgREST keeps serving `PGRST205
Could not find the table '...' in the schema cache` (HTTP 404) until its
own periodic reload catches up -- which is exactly what broke the first
deploy attempt for `alert_rules` (PR 3). End every such migration with:

```sql
notify pgrst, 'reload schema';
```

so PostgREST reloads immediately instead of racing whatever invokes the
REST API right after the migration runs (a deploy workflow's own
verification curl, a frontend request, etc). Even with the NOTIFY, the
reload isn't instantaneous, so a deploy workflow's post-migration checks
should retry a few times with a short delay rather than failing on the
first cold-cache response (see `deploy-alert-rules-schema.yml`).

## Field-name fallbacks

The task description named `address_hash` and `holders_count` as the
Blockscout field names; some Blockscout deployments use `address`/`holders`
instead. The function tries both (`address_hash` → `address`,
`holders_count` → `holders`) so it works either way; the
`skipped_missing_address` count in its response will be non-zero if neither
address field matches, which would mean the schema differs further and
needs a look.
