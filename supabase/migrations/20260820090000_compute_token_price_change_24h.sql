-- Trending's 24h change badge was showing "+0.0%" for every token (reported
-- for $USDG, $VIRTUAL, $SYRUPUSDG, but confirmed to be every row -- see the
-- investigation that preceded this migration). Root cause turned out to be
-- unrelated to the pnl_30d precision issue (20260817020000 /
-- 20260820040000): pnl_30d's near-zero values were a real (if noisy)
-- *computed* result. tokens.price_change_24h was never computed at all --
-- sync-tokens/index.ts tries a handful of candidate field names
-- (`exchange_rate_percent_change`, `price_change_24h`, etc.) on Blockscout's
-- `/api/v2/tokens` response and falls back to a hardcoded `0` because that
-- endpoint is a block-explorer API, not a price tracker, and has never
-- carried a 24h-change field on this instance
-- (`price_change_24h_field_found: false` in every production sync-tokens
-- run's summary -- confirmed live in GitHub Actions run #12, 2026-08-20,
-- where every one of the top 10 tokens by volume, including $VIRTUAL, came
-- back with `"price_change_24h":0` exactly). So every token showed the same
-- literal zero, always -- not a rounding artifact.
--
-- Fix: now that token_price_history exists (20260820060000, built for the
-- pnl_30d fix), we can compute a real 24h change ourselves -- current
-- tokens.price_usd vs. the closest history observation at or before 24h
-- ago -- instead of depending on a field Blockscout doesn't provide. Same
-- pattern as recompute_wallet_performance(): a plain SQL function, scheduled
-- directly via pg_cron, no Edge Function/HTTP round-trip needed since this
-- is pure aggregation over data already in Postgres.
--
-- Tokens without a history observation reaching back 24h (just discovered
-- by sync-tokens/sync-tokens-discovery, or -- once
-- 20260820080000_token_price_history_retention.sql prunes rows older than
-- 60 days -- extremely stale ones far outside that window, though 60 days
-- is a wide margin over the 24h this needs) have no real percentage to
-- report. price_change_24h_reliable marks that case explicitly, same as
-- wallets.pnl_30d_reliable, so the frontend can render a neutral "Low data"
-- state instead of a misleading "+0.0%" that reads as "unchanged" when it
-- actually means "unknown".
alter table public.tokens
  add column if not exists price_change_24h_reliable boolean not null default false;

-- sync-tokens/index.ts and sync-tokens-discovery/index.ts no longer write
-- price_change_24h in their upsert payloads as of this change (see those
-- files) -- this function is now the column's only writer. Without a
-- default, a brand-new token (first-ever upsert of that contract_address,
-- an INSERT rather than an ON CONFLICT UPDATE) would omit price_change_24h
-- from the insert's column list entirely and rely on whatever default/
-- nullability the column happened to already have -- set one explicitly so
-- that doesn't depend on the table's original (pre-migration-history) shape.
alter table public.tokens
  alter column price_change_24h set default 0;

create or replace function public.recompute_token_price_changes()
returns table (
  tokens_total bigint,
  tokens_price_change_24h_reliable bigint,
  computed_at timestamptz
)
language sql
as $$
  with price_24h_ago as (
    -- "Closest price at or before 24h ago" per token -- same lateral-lookup
    -- shape as recompute_wallet_performance()'s per-transaction price
    -- lookup (20260820070000_wallet_performance_use_price_history.sql),
    -- served by the same token_price_history_token_recorded_idx
    -- (token_address, recorded_at desc) as a single index range scan per
    -- token rather than a sort over that token's whole history.
    select
      t.id as token_id,
      h.price_usd as price_usd_24h_ago
    from public.tokens t
    left join lateral (
      select price_usd
      from public.token_price_history
      where token_address = t.contract_address
        and recorded_at <= now() - interval '24 hours'
      order by recorded_at desc
      limit 1
    ) h on true
  ),
  computed as (
    select
      t.id as token_id,
      (p.price_usd_24h_ago is not null) as reliable,
      case
        when p.price_usd_24h_ago is not null and p.price_usd_24h_ago <> 0
          then 100.0 * (coalesce(t.price_usd, 0) - p.price_usd_24h_ago) / p.price_usd_24h_ago
        else 0
      end as price_change_24h
    from public.tokens t
    join price_24h_ago p on p.token_id = t.id
  ),
  updated as (
    update public.tokens t
    set price_change_24h = c.price_change_24h,
        price_change_24h_reliable = c.reliable
    from computed c
    where c.token_id = t.id
    returning t.id, c.reliable
  )
  select
    count(*)::bigint as tokens_total,
    count(*) filter (where reliable)::bigint as tokens_price_change_24h_reliable,
    now() as computed_at
  from updated;
$$;

-- Same reasoning as recompute_wallet_performance(): this rewrites every
-- token's price_change_24h/price_change_24h_reliable, so it shouldn't be
-- exposed to anon/authenticated over PostgREST's RPC endpoint. Postgres
-- grants EXECUTE on new functions to PUBLIC by default -- revoke that first.
revoke execute on function public.recompute_token_price_changes() from public;
grant execute on function public.recompute_token_price_changes() to service_role;

-- Every 15 minutes, matching recompute_wallet_performance()'s cadence
-- (20260817000000): this is a derived aggregate over token_price_history,
-- not a source of new data, so it only needs to catch up periodically, not
-- race sync-tokens' 1-minute writes. A 15-minute lag against a 24-hour
-- comparison window is negligible.
create extension if not exists pg_cron with schema pg_catalog;

select
  cron.schedule(
    'recompute-token-price-changes-every-15-min',
    '*/15 * * * *',
    $$select public.recompute_token_price_changes();$$
  );

-- New column (price_change_24h_reliable) referenced by index.html's
-- `.order("price_change_24h_reliable", ...)` and by check-alerts' select --
-- same PGRST205/"column not found" trap documented in DEPLOY.md and hit by
-- PR 3's alert_rules and the pnl_30d_reliable hotfix: `supabase db push`
-- applies this over a direct Postgres connection, which doesn't itself
-- notify PostgREST to reload its schema cache.
notify pgrst, 'reload schema';
