-- token_price_history (20260820060000) is append-only and fed by
-- sync-tokens on every 1-minute run (20260820050000) -- unbounded, it grows
-- forever. Retention keeps it bounded without losing the precision that
-- matters: recompute_wallet_performance() only ever needs history back to
-- pnl_30d's 30-day window for sells, plus however far back a matching buy
-- sits for avg_buy_price (computed all-time, not windowed) -- 60 days gives
-- a real buffer past that 30-day floor. Rows older than the window fall
-- back to transactions.value_usd in the lookup (see
-- 20260820070000_wallet_performance_use_price_history.sql's coalesce),
-- exactly the same fallback already accepted for transactions that predate
-- this table existing at all -- so pruning old rows doesn't introduce a new
-- kind of gap, just extends the same one further back over time.
--
-- Runs once a day (not on sync-tokens' 1-minute cadence -- a delete this
-- cheap doesn't need to race new data, it only needs to keep the table from
-- growing without bound) via the same pg_cron extension already in use for
-- sync-tokens/sync-transactions/recompute_wallet_performance.
create extension if not exists pg_cron with schema pg_catalog;

select
  cron.schedule(
    'token-price-history-retention-daily',
    '0 3 * * *',
    $$delete from public.token_price_history where recorded_at < now() - interval '60 days';$$
  );

notify pgrst, 'reload schema';
