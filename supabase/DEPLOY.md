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
`price_change_24h_field_found`). Then confirm the table actually changed:

```sql
select contract_address, ticker, name, price_usd, volume_24h, holder_count, price_change_24h
from tokens
order by volume_24h desc
limit 10;
```

## About `price_change_24h`

Blockscout's `/api/v2/tokens` endpoint is a block-explorer API, not a price
tracker — its documented schema (`address`/`address_hash`, `name`, `symbol`,
`exchange_rate`, `volume_24h`, `holders`/`holders_count`) has no field for a
24h percentage change as far as could be checked without live access. The
function looks for a handful of likely field names anyway
(`exchange_rate_percent_change`, `price_change_24h`,
`price_change_percentage_24h`, `percent_change_24h`) and falls back to `0`
if none are present, flagging that in its response
(`price_change_24h_field_found: false`). If the response shows `false`,
that confirms the field doesn't exist on this instance and `0` is what's
being written for every row until a price-history source is added.

## Field-name fallbacks

The task description named `address_hash` and `holders_count` as the
Blockscout field names; some Blockscout deployments use `address`/`holders`
instead. The function tries both (`address_hash` → `address`,
`holders_count` → `holders`) so it works either way; the
`skipped_missing_address` count in its response will be non-zero if neither
address field matches, which would mean the schema differs further and
needs a look.
