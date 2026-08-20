-- Issue #12 item 1 follow-up (second half -- see 20260820040000 for the
-- other half, the pnl_30d_reliable flag).
--
-- sync-tokens' 5-minute cadence is the size of the staleness window that
-- makes sync-transactions' `amount * tokens.price_usd` pricing imprecise:
-- every transfer processed in one sync-transactions invoke gets priced off
-- whatever `tokens.price_usd` happened to be at that moment, so the longer
-- price_usd goes between updates, the more a buy and its later sell within
-- that window get priced off the same stale snapshot (see
-- 20260817020000_flag_pnl_30d_low_precision.sql for the full mechanism).
--
-- This does not fix that -- it shrinks the window. Moving from 5 minutes to
-- 1 minute (pg_cron's finest granularity; sub-minute isn't supported) cuts
-- the maximum staleness 5x, at the cost of 5x the Blockscout token-list API
-- calls from sync-tokens. Blockscout's public API needs no key and this
-- project already polls it on a schedule elsewhere (sync-transactions,
-- sync-launchpad, sync-tokens-discovery) without hitting rate limits, so
-- the added load is accepted here as a reasonable trade for a real (if
-- partial) reduction in pnl_30d's imprecision. sync-transactions' own
-- 5-minute schedule is unchanged -- only the price snapshot it reads from
-- gets fresher.
--
-- cron.schedule() upserts by job name rather than erroring on a duplicate,
-- but the old job's name embeds the old interval ("every-5-min"), so it's
-- unscheduled explicitly and replaced with a correctly-named job rather
-- than left behind under a now-misleading name.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-tokens-every-5-min') then
    perform cron.unschedule('sync-tokens-every-5-min');
  end if;
end $$;

select
  cron.schedule(
    'sync-tokens-every-1-min',
    '* * * * *',
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
