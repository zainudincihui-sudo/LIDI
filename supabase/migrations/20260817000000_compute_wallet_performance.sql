-- Computes real wallet performance (win_rate, pnl_30d, total_trades) from
-- the `transactions` data sync-transactions has been collecting, replacing
-- the 0%/0/0 defaults every wallet currently shows.
--
-- Methodology (approved in conversation before this was written):
--
-- 1. Cost basis: weighted-average buy price per (wallet, token), computed
--    as SUM(value_usd) / SUM(amount) over that wallet's `buy` rows for that
--    token, across all of history -- not a time-ordered FIFO lot match.
--    FIFO would imply a precision the data doesn't have: sync-transactions
--    only ever pulls each token's *latest* transfers (MAX_PAGES_PER_TOKEN
--    in supabase/functions/sync-transactions/index.ts), not full history,
--    so transaction coverage is already incomplete and unordered-complete.
--    A single average cost is an honest reflection of that uncertainty and
--    is far cheaper to compute (plain aggregate, no per-lot loop).
--
-- 2. Realized PnL per `sell` row = value_usd - (amount * avg_buy_price for
--    that wallet+token). `value_usd` on both sides is itself a snapshot
--    (sync-transactions prices transfers at the token's price_usd *when
--    the sync ran*, not the true execution price), so this is already an
--    approximation one layer up.
--
-- 3. Sells with NO matching buy on record for that wallet+token (avg_buy_price
--    is null -- e.g. the wallet bought before LIDI started indexing that
--    token) are EXCLUDED from pnl_30d and win_rate entirely, rather than
--    assumed to have a $0 cost basis. Assuming $0 cost would count every
--    unmatched sell as pure profit and bias both numbers up; excluding
--    them just means "we don't have enough data on this trade" instead of
--    guessing. total_trades is unaffected -- it counts every transaction
--    row regardless of whether it could be matched.
--
-- 4. pnl_30d sums realized PnL from matched sells in the last 30 days.
--    win_rate is the share of matched sells (all-time, not just 30d) with
--    positive realized PnL -- total_trades is also all-time, and nothing
--    in the wallets table scopes win_rate to a window the way the `_30d`
--    suffix does for pnl.
--
-- 5. Unrealized PnL (tokens still held, never sold) is not represented
--    anywhere here -- pnl_30d is purely realized gains/losses from sells.
--
-- Implemented as a plain SQL function (not an Edge Function) because this
-- is pure aggregation over data already in Postgres -- no external API call
-- like sync-tokens/sync-transactions need, so there's no reason to pay for
-- an Edge Function invoke or route through pg_net/HTTP. It's scheduled
-- directly via pg_cron below.
create or replace function public.recompute_wallet_performance()
returns table (
  wallets_total bigint,
  wallets_with_performance bigint,
  wallets_zero_performance bigint,
  sell_transactions_total bigint,
  sell_transactions_matched bigint,
  sell_transactions_unmatched bigint,
  computed_at timestamptz
)
language sql
as $$
  with avg_buy as (
    select wallet_id, token_id, sum(value_usd) / nullif(sum(amount), 0) as avg_buy_price
    from public.transactions
    where type = 'buy'
    group by wallet_id, token_id
  ),
  matched_sells as (
    select
      t.wallet_id,
      t.occurred_at,
      t.value_usd - t.amount * ab.avg_buy_price as realized_pnl
    from public.transactions t
    join avg_buy ab on ab.wallet_id = t.wallet_id and ab.token_id = t.token_id
    where t.type = 'sell'
  ),
  trade_counts as (
    select wallet_id, count(*) as total_trades
    from public.transactions
    group by wallet_id
  ),
  pnl_30d_agg as (
    select wallet_id, sum(realized_pnl) as pnl_30d
    from matched_sells
    where occurred_at >= now() - interval '30 days'
    group by wallet_id
  ),
  win_rate_agg as (
    select
      wallet_id,
      100.0 * count(*) filter (where realized_pnl > 0) / count(*) as win_rate
    from matched_sells
    group by wallet_id
  ),
  wallet_agg as (
    select
      w.id as wallet_id,
      coalesce(tc.total_trades, 0) as total_trades,
      coalesce(p.pnl_30d, 0) as pnl_30d,
      coalesce(wr.win_rate, 0) as win_rate,
      (wr.wallet_id is not null) as has_matched_sells
    from public.wallets w
    left join trade_counts tc on tc.wallet_id = w.id
    left join pnl_30d_agg p on p.wallet_id = w.id
    left join win_rate_agg wr on wr.wallet_id = w.id
  ),
  updated as (
    update public.wallets w
    set win_rate = s.win_rate,
        pnl_30d = s.pnl_30d,
        total_trades = s.total_trades
    from wallet_agg s
    where s.wallet_id = w.id
    returning w.id, s.has_matched_sells
  )
  select
    count(*)::bigint as wallets_total,
    count(*) filter (where has_matched_sells)::bigint as wallets_with_performance,
    count(*) filter (where not has_matched_sells)::bigint as wallets_zero_performance,
    (select count(*) from public.transactions where type = 'sell')::bigint as sell_transactions_total,
    (select count(*) from matched_sells)::bigint as sell_transactions_matched,
    (
      (select count(*) from public.transactions where type = 'sell')
      - (select count(*) from matched_sells)
    )::bigint as sell_transactions_unmatched,
    now() as computed_at
  from updated;
$$;

-- Only service_role (used by the deploy workflow's manual invoke, and any
-- future Edge Function wrapper) can call this -- it rewrites every wallet's
-- performance columns, so it shouldn't be exposed to anon/authenticated
-- over the REST RPC endpoint. Postgres grants EXECUTE on new functions to
-- PUBLIC by default, which would otherwise let anon/authenticated trigger
-- a full-table recompute via PostgREST's RPC endpoint -- revoke that first.
revoke execute on function public.recompute_wallet_performance() from public;
grant execute on function public.recompute_wallet_performance() to service_role;

-- Run on a schedule so performance numbers stay fresh as sync-transactions
-- keeps collecting data. Every 15 minutes (vs. sync-transactions' 5) since
-- this only needs to catch up periodically, not race new data in -- it's a
-- derived aggregate, not a source of new rows.
create extension if not exists pg_cron with schema pg_catalog;

select
  cron.schedule(
    'recompute-wallet-performance-every-15-min',
    '*/15 * * * *',
    $$select public.recompute_wallet_performance();$$
  );
