-- Documents (does not fix -- see note below) a pricing-precision limitation
-- discovered after deploying 20260817010000_fix_pnl_30d_as_percent.sql to
-- production: pnl_30d values came back real but clustered within a razor
-- -thin band around zero (the wallets ranked #1-#10 by pnl_30d were all
-- between +0.0000000000000192% and +0.0000000000000341%, despite 100%
-- win_rate) -- too uniform to be genuine market outcomes across 1417
-- different wallets.
--
-- Root cause: sync-transactions prices every transfer it processes using
-- `tokens.price_usd` -- a snapshot of "the token's price right now", the
-- same value for every transfer in that invoke regardless of when the
-- transfer actually happened -- not the token's true price at the moment
-- of that specific transfer. `tokens.price_usd` itself only advances on
-- sync-tokens' own 5-minute cadence. So when a wallet buys and later sells
-- the same token within a window where price_usd hasn't been refreshed
-- (very common, since both sync-transactions invokes and sync-tokens'
-- price updates are infrequent relative to how fast trades can happen),
-- both the buy and the sell get priced from nearly the same snapshot --
-- structurally driving realized_pnl (and therefore pnl_30d) towards zero
-- independent of the token's real price movement between those two trades.
--
-- This is NOT a bug in recompute_wallet_performance()'s formula -- the
-- weighted-average-cost and %-ROI math is correct given its inputs (see
-- 20260817000000_compute_wallet_performance.sql and
-- 20260817010000_fix_pnl_30d_as_percent.sql). It's a precision ceiling
-- imposed by what sync-transactions currently records: it has never
-- captured a true per-transfer historical price, only a shared snapshot.
--
-- Decision (agreed in conversation): do NOT change the pricing
-- architecture right now -- that's a sync-transactions change, a separate
-- and larger piece of work. Instead:
--   1. This comment records the mechanism for whoever picks up that work.
--   2. recompute_wallet_performance()'s summary now carries an explicit
--      pnl_30d_caveat string (below) so this is visible wherever the
--      function's output is read (deploy workflow logs/artifacts, any
--      future caller), not just in migration history.
--   3. A tracking issue has been filed covering this together with the
--      other known, separately-deferred data-quality gap: sync-transactions'
--      extractAmount() falls back to raw (undivided) amount when a
--      transfer's `total.decimals` field is missing, which would misprice
--      that row if it occurs. Both are sync-transactions pricing/decimals
--      issues, tracked together rather than fixed piecemeal here.
--
-- Practical implication for consumers of the `wallets` table right now:
-- win_rate (a sign test on realized_pnl) is unaffected by this and stays
-- meaningful. pnl_30d's sign and rough presence/absence of performance
-- data (see wallets_with_performance/wallets_zero_performance in the
-- summary) are still informative, but its MAGNITUDE is compressed near
-- zero for most wallets, so ranking the Leaderboard by pnl_30d does not
-- currently produce a meaningful ordering -- treat it as a placeholder
-- until sync-transactions captures real per-transfer pricing.
create or replace function public.recompute_wallet_performance()
returns table (
  wallets_total bigint,
  wallets_with_performance bigint,
  wallets_zero_performance bigint,
  sell_transactions_total bigint,
  sell_transactions_matched bigint,
  sell_transactions_unmatched bigint,
  computed_at timestamptz,
  pnl_30d_caveat text
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
    now() as computed_at,
    'pnl_30d is priced from tokens.price_usd snapshots at sync time, not true '
    'per-transfer execution price -- realized PnL magnitude is compressed near '
    'zero for most wallets as a result. win_rate and the presence/absence of '
    'matched performance data remain meaningful; do NOT treat Leaderboard '
    'ordering by pnl_30d as reliable until sync-transactions captures real '
    'per-transfer historical pricing.' as pnl_30d_caveat
  from updated;
$$;
