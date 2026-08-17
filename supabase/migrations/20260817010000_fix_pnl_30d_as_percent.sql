-- Fixes pnl_30d to be a dollar-weighted realized ROI percentage, not a raw
-- USD sum.
--
-- 20260817000000_compute_wallet_performance.sql computed pnl_30d as
-- SUM(value_usd_sell - amount_sell * avg_buy_price) -- an absolute dollar
-- figure. But the frontend (index.html, formatPct()) renders pnl_30d with
-- `.toFixed(1) + "%"`, the same way it renders win_rate -- it expects a
-- percentage return, not dollars. Robinhood Chain memecoins can have a
-- price_usd many orders of magnitude below $1, so realized dollar PnL for
-- an ordinary trade size comes out as e.g. 0.0000000505 -- a real number,
-- correctly computed, just in the wrong unit for what the UI displays,
-- rounding to "0.0%" for nearly every wallet regardless of actual
-- performance. (win_rate looked fine throughout because it only tests the
-- *sign* of realized_pnl, which is scale-invariant -- that's why this
-- didn't show up there.)
--
-- Fix: pnl_30d becomes
--   100 * SUM(realized_pnl_dollar over 30d matched sells)
--       / SUM(cost_basis_dollar over those same sells)
-- i.e. a dollar-weighted ROI across the wallet's matched sells in the
-- window, not an unweighted average of each trade's individual percentage
-- (which would let a $0.01 trade move the number as much as a $10,000
-- one). Sells with no matching buy on record are still excluded from both
-- the numerator and denominator, same as before -- not treated as $0 cost.
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
      t.value_usd - t.amount * ab.avg_buy_price as realized_pnl,
      t.amount * ab.avg_buy_price as cost_basis
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
    select
      wallet_id,
      100.0 * sum(realized_pnl) / nullif(sum(cost_basis), 0) as pnl_30d
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
