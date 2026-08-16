-- Schedule the sync-tokens Edge Function to run every 5 minutes via pg_cron,
-- calling it over HTTP with pg_net (this is how Supabase recommends invoking
-- Edge Functions on a schedule, since cron jobs run inside Postgres itself).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- pg_net needs the project's service role key to authenticate the call.
-- Migrations cannot read project secrets, so store it in Vault once, before
-- this migration runs, via the SQL editor:
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'sync_tokens_service_role_key');

select
  cron.schedule(
    'sync-tokens-every-5-min',
    '*/5 * * * *',
    $$
    select net.http_post(
      url := 'https://ruatieohvdxjnmcfhqwh.supabase.co/functions/v1/sync-tokens',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'sync_tokens_service_role_key'
          limit 1
        )
      ),
      body := '{}'::jsonb
    ) as request_id;
    $$
  );
