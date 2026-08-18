-- Schedule the sync-tokens-discovery Edge Function via pg_cron, the same
-- way sync-tokens/sync-transactions/sync-launchpad are scheduled (see
-- 20260816150100_schedule_sync_tokens.sql). Runs every 15 minutes rather
-- than every 5: this function only advances a handful of pages per invoke
-- (see DISCOVERY_PAGES_PER_RUN), so there's no benefit to a tighter
-- schedule, and it keeps this newer/riskier function's total call volume
-- to Blockscout's public API well below sync-tokens' own.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- pg_net needs the project's service role key to authenticate the call.
-- The deploy workflow (.github/workflows/deploy-sync-tokens-discovery.yml)
-- upserts it into Vault as `sync_tokens_discovery_service_role_key` before
-- this migration runs.

select
  cron.schedule(
    'sync-tokens-discovery-every-15-min',
    '*/15 * * * *',
    $$
    select net.http_post(
      url := 'https://ruatieohvdxjnmcfhqwh.supabase.co/functions/v1/sync-tokens-discovery',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'sync_tokens_discovery_service_role_key'
          limit 1
        )
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );
