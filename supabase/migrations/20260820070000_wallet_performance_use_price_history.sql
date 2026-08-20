-- Issue #12 item 1, real fix (part 2 of 2 -- see
-- 20260820060000_create_token_price_history_table.sql for the table and
-- sync-tokens/index.ts for how it gets populated).
--
-- Every prior pnl_30d migration (20260817000000 through 20260820050000)
-- used transactions.value_usd as-is for both sides of realized_pnl. That
-- column is fine as a stored fact about what sync-transactions believed a
-- transfer was worth *when it synced it*, but it's the wrong input for PnL:
-- it's amount * tokens.price_usd at sync time, not at occurred_at, so a buy
-- and a later sell of the same token routinely got priced off nearly the
-- same stale snapshot (see 20260817020000_flag_pnl_30d_low_precision.sql
-- for the full mechanism) -- structurally compressing pnl_30d towards zero
-- regardless of the token's real price movement between those two trades.
--
-- Fix: for every transaction row, re-derive its USD value from
-- token_price_history instead of trusting the stored snapshot --
-- amount * (price_usd from the row in token_price_history for this token
-- with the latest recorded_at at or before this transaction's occurred_at).
-- That's a real historical price close to the actual trade time, not
-- whatever price_usd happened to be whenever sync-transactions last ran.
--
-- Transactions with no matching history row -- anything that happened
-- before this table started being populated, or (once
-- 20260820080000_token_price_history_retention.sql starts pruning) older
-- than the retention window -- fall back to the original stored
-- value_usd. That's an accepted, expected gap: those transfers simply
-- predate having real price history to look up, same as any other
-- backfill-less migration. It only affects data older than the table;
-- everything synced going forward gets the precise lookup.
--
-- Return columns are unchanged from 20260820040000_flag_pnl_30d_reliability.sql,
-- so `create or replace` is fine here -- no 42P13 "cannot change return
-- type" (that only bites when a `returns table (...)` column is added or
-- removed, not when just the body changes).
create or replace function public.recompute_wallet_performance()
returns table (
  wallets_total bigint,
  wallets_with_performance bigint,
  wallets_zero_performance bigint,
  wallets_pnl_30d_reliable bigint,
  sell_transactions_total bigint,
  sell_transactions_matched bigint,
  sell_transactions_unmatched bigint,
  computed_at timestamptz,
  pnl_30d_caveat text
)
language sql
as $$
  with priced as (
    -- One row per transaction, with value_usd re-derived from the token's
    -- price history as of occurred_at instead of the stored sync-time
    -- snapshot. The lateral subquery is the "closest price at or before
    -- this timestamp" lookup -- token_price_history_token_recorded_idx
    -- (token_address, recorded_at desc) makes it a single index range scan
    -- per transaction row, not a sort over the token's whole history.
    select
      t.wallet_id,
      t.token_id,
      t.type,
      t.amount,
      t.occurred_at,
      coalesce(h.price_usd * t.amount, t.value_usd) as value_usd
    from public.transactions t
    join public.tokens tok on tok.id = t.token_id
    left join lateral (
      select price_usd
      from public.token_price_history
      where token_address = tok.contract_address
        and recorded_at <= t.occurred_at
      order by recorded_at desc
      limit 1
    ) h on true
  ),
  avg_buy as (
    select wallet_id, token_id, sum(value_usd) / nullif(sum(amount), 0) as avg_buy_price
    from priced
    where type = 'buy'
    group by wallet_id, token_id
  ),
  matched_sells as (
    select
      p.wallet_id,
      p.occurred_at,
      p.value_usd - p.amount * ab.avg_buy_price as realized_pnl,
      p.amount * ab.avg_buy_price as cost_basis
    from priced p
    join avg_buy ab on ab.wallet_id = p.wallet_id and ab.token_id = p.token_id
    where p.type = 'sell'
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
      (wr.wallet_id is not null) as has_matched_sells,
      (wr.wallet_id is not null and abs(coalesce(p.pnl_30d, 0)) >= 1.0) as pnl_30d_reliable
    from public.wallets w
    left join trade_counts tc on tc.wallet_id = w.id
    left join pnl_30d_agg p on p.wallet_id = w.id
    left join win_rate_agg wr on wr.wallet_id = w.id
  ),
  updated as (
    update public.wallets w
    set win_rate = s.win_rate,
        pnl_30d = s.pnl_30d,
        total_trades = s.total_trades,
        pnl_30d_reliable = s.pnl_30d_reliable
    from wallet_agg s
    where s.wallet_id = w.id
    returning w.id, s.has_matched_sells, s.pnl_30d_reliable
  )
  select
    count(*)::bigint as wallets_total,
    count(*) filter (where has_matched_sells)::bigint as wallets_with_performance,
    count(*) filter (where not has_matched_sells)::bigint as wallets_zero_performance,
    count(*) filter (where pnl_30d_reliable)::bigint as wallets_pnl_30d_reliable,
    (select count(*) from public.transactions where type = 'sell')::bigint as sell_transactions_total,
    (select count(*) from matched_sells)::bigint as sell_transactions_matched,
    (
      (select count(*) from public.transactions where type = 'sell')
      - (select count(*) from matched_sells)
    )::bigint as sell_transactions_unmatched,
    now() as computed_at,
    'pnl_30d is now priced from token_price_history (the price closest to, at '
    'or before, each transfer''s occurred_at) instead of the value_usd sync-time '
    'snapshot -- see 20260820070000_wallet_performance_use_price_history.sql. '
    'Transactions that predate token_price_history coverage (or have aged out '
    'of its retention window) still fall back to the original stored value_usd '
    'for that one row, so pnl_30d accuracy improves as more history accumulates '
    'rather than being uniformly precise from day one. wallets.pnl_30d_reliable '
    '(|pnl_30d| >= 1% with matched sells) still gates Leaderboard/Smart Wallets '
    'consumption -- keep using it rather than raw pnl_30d.' as pnl_30d_caveat
  from updated;
$$;

revoke execute on function public.recompute_wallet_performance() from public;
grant execute on function public.recompute_wallet_performance() to service_role;

-- No REST-facing schema shape changed here (same return columns as
-- 20260820040000), but every migration in this project ends with this now
-- per the two production incidents it already caused (PR 3's alert_rules,
-- and the Leaderboard pnl_30d_reliable hotfix) -- cheap insurance against a
-- stale PostgREST schema cache.
notify pgrst, 'reload schema';
