-- Issue #12 item 1 follow-up: turns the pnl_30d precision problem documented
-- in 20260817020000_flag_pnl_30d_low_precision.sql into a per-wallet,
-- queryable flag instead of a static text caveat nobody but a log-reader
-- ever sees.
--
-- Recap of the root cause (full mechanism in 20260817020000): sync-transactions
-- prices every transfer with `amount * tokens.price_usd` as it stands *at
-- sync time*, not the transfer's true execution-time price, and `tokens`
-- keeps no price history to re-derive that from after the fact -- so
-- pnl_30d ends up compressed into a razor-thin band around zero
-- (+0.0000000000000192% to +0.0000000000000341% for the top 10 wallets in
-- production) that is floating-point noise from repricing a buy and its
-- later sell off nearly the same snapshot, not a real trading outcome.
--
-- That precision loss happens before recompute_wallet_performance() ever
-- sees the data (value_usd is already baked in by sync-transactions), so no
-- amount of aggregation logic here can recover the true number -- fixing
-- that for real means sync-transactions capturing a true per-transfer
-- price, which is deliberately out of scope for this change (see issue #12
-- discussion; changing sync-transactions/`transactions` is a separate,
-- larger piece of work).
--
-- What this migration does instead: stop presenting a falsely-precise
-- pnl_30d for wallets whose number is indistinguishable from that noise
-- floor. PNL_30D_MATERIALITY_PCT (1%) is chosen to sit many orders of
-- magnitude above the observed ~1e-14% noise band while still being far
-- below the kind of swing an actual memecoin trade produces (these tokens
-- move double- and triple-digit percentages routinely) -- so a wallet
-- landing below it is presumed to be a same-snapshot pricing artifact, not
-- a real (if small) result. Wallets at or above the threshold aren't
-- "fixed" either -- they're still priced from the same imprecise inputs --
-- but a swing that large is far less likely to be pure snapshot noise.
--
-- wallets.pnl_30d_reliable lets consumers (Leaderboard, Smart Wallets) stop
-- ranking/rendering pnl_30d as if it were meaningful when it isn't, without
-- having to reimplement this reasoning client-side.
alter table public.wallets
  add column if not exists pnl_30d_reliable boolean not null default false;

-- Adding a new output column to a `returns table (...)` function requires
-- drop + recreate (see 20260817020000 for why `create or replace` can't do
-- this -- Postgres 42P13) -- and DROP FUNCTION resets grants to the
-- default (EXECUTE to PUBLIC), so re-apply them below same as that
-- migration did.
drop function if exists public.recompute_wallet_performance();

create function public.recompute_wallet_performance()
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
    'pnl_30d is priced from tokens.price_usd snapshots at sync time, not true '
    'per-transfer execution price -- realized PnL magnitude is compressed near '
    'zero for most wallets as a result. win_rate and the presence/absence of '
    'matched performance data remain meaningful. wallets.pnl_30d_reliable is now '
    'set per-wallet (|pnl_30d| >= 1% with matched sells) so consumers can avoid '
    'ranking/rendering pnl_30d for wallets where it is indistinguishable from '
    'snapshot-pricing noise -- see wallets_pnl_30d_reliable above for how many '
    'currently qualify. Do NOT treat this as a fix for the underlying pricing '
    'precision; that still requires sync-transactions to capture true '
    'per-transfer historical pricing.' as pnl_30d_caveat
  from updated;
$$;

revoke execute on function public.recompute_wallet_performance() from public;
grant execute on function public.recompute_wallet_performance() to service_role;

-- Same PGRST205/"column not found" trap documented in DEPLOY.md ("New
-- tables need NOTIFY pgrst, 'reload schema'"), which broke the alert_rules
-- deploy in PR 3: `supabase db push` applies this ALTER TABLE over a direct
-- Postgres connection, which doesn't itself push a schema-reload notice to
-- PostgREST. Without this, wallets.pnl_30d_reliable exists in the database
-- but PostgREST keeps 404/column-not-found-ing requests that reference it
-- (e.g. index.html's `.order("pnl_30d_reliable", ...)` on the Leaderboard
-- and Smart Wallets queries) until its own periodic cache reload catches up.
notify pgrst, 'reload schema';
