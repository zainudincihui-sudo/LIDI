-- Schedule the sync-launchpad Edge Function to run every 5 minutes via
-- pg_cron, the same way sync-tokens and sync-transactions are scheduled
-- (see 20260816150100_schedule_sync_tokens.sql).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- pg_net needs the project's service role key to authenticate the call.
-- The deploy workflow (.github/workflows/deploy-sync-launchpad.yml) upserts
-- it into Vault as `sync_launchpad_service_role_key` before this migration
-- runs.

select
  cron.schedule(
    'sync-launchpad-every-5-min',
    '*/5 * * * *',
    $$
    select net.http_post(
      url := 'https://ruatieohvdxjnmcfhqwh.supabase.co/functions/v1/sync-launchpad',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'sync_launchpad_service_role_key'
          limit 1
        )
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );
