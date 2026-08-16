# Deploying `sync-tokens`

This function could not be deployed or run from the build environment that
wrote it — outbound network access to `*.supabase.co`, `api.supabase.com`,
and `robinhoodchain.blockscout.com` is blocked by that sandbox's egress
policy (confirmed via direct 403s on all three hosts). Everything below is
written but unverified against the live project. Run these steps yourself,
or in a session that has network access.

## 1. Install the CLI and link the project

```bash
npm install -g supabase
supabase login   # or: export SUPABASE_ACCESS_TOKEN=<your personal access token>
supabase link --project-ref ruatieohvdxjnmcfhqwh
```

## 2. Store the service role key in Vault

`sync-tokens` is invoked on a schedule by pg_cron, which calls it over HTTP
and needs the project's **service role key** (Project Settings → API) to
authenticate. Run this once in the SQL editor (Dashboard → SQL Editor),
replacing the placeholder:

```sql
select vault.create_secret('<SERVICE_ROLE_KEY>', 'sync_tokens_service_role_key');
```

## 3. Apply migrations and deploy the function

```bash
supabase db push          # adds the unique constraint + pg_cron schedule
supabase functions deploy sync-tokens
```

## 4. Run it once manually and check the result

```bash
supabase functions invoke sync-tokens --project-ref ruatieohvdxjnmcfhqwh
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
(`price_change_24h_field_found: false`). If step 4's output shows `false`,
that confirms the field doesn't exist on this instance and `0` is what's
being written for every row until a price-history source is added.

## Field-name fallbacks

The task description named `address_hash` and `holders_count` as the
Blockscout field names, but the CLI in this build environment couldn't
reach the API to confirm — some Blockscout deployments use `address`/
`holders` instead. The function tries both (`address_hash` → `address`,
`holders_count` → `holders`) so it works either way; the `skipped_missing_address`
count in its response will be non-zero if neither address field matches,
which would mean the schema differs further and needs a look.
