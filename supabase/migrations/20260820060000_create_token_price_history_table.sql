-- Issue #12 item 1, real fix (not another mitigation): the previous two
-- follow-ups -- 20260820040000_flag_pnl_30d_reliability.sql (the
-- pnl_30d_reliable flag) and 20260820050000_reschedule_sync_tokens_1_min.sql
-- (5min -> 1min sync-tokens cadence) -- both explicitly said they don't fix
-- the root cause: sync-transactions prices every transfer off
-- `tokens.price_usd` as it stands *at sync time*, and `tokens` keeps no
-- history to re-derive the true execution-time price from afterwards.
-- Shrinking the staleness window (the reschedule) or hiding the noisy
-- result (the flag) both work around that; this table is what actually
-- lets us go back and answer "what was this token worth at time T" instead
-- of only ever knowing "what is it worth right now".
--
-- Append-only: a row is a price observation at a point in time, never
-- updated or upserted -- see sync-tokens/index.ts for the write side, which
-- inserts a new row only when a token's price_usd actually changed from the
-- last-recorded value (not on every 1-minute sync-tokens run regardless of
-- movement -- at that cadence across ~342 tokens, unconditional inserts
-- would be on the order of 15M+ rows/month for no extra precision, since
-- the price is constant between two real changes anyway).
--
-- token_address (not token_id) because that's what sync-tokens has on hand
-- for every row it fetches from Blockscout -- upserting `tokens` by
-- contract_address doesn't hand back the row's uuid without an extra
-- round-trip select, and this table needs to be cheap to write from a
-- 1-minute cron. recompute_wallet_performance() joins through
-- tokens.contract_address to get here (see
-- 20260820070000_wallet_performance_use_price_history.sql).
create table if not exists public.token_price_history (
  id bigint generated always as identity primary key,
  token_address text not null,
  price_usd numeric not null,
  recorded_at timestamptz not null default now()
);

-- Primary access pattern: "the price of this token closest to (at or
-- before) a given timestamp" -- recompute_wallet_performance() does this
-- once per transaction row. token_address leading, recorded_at descending
-- so `where token_address = $1 and recorded_at <= $2 order by recorded_at
-- desc limit 1` is a single index range scan, not a sort over every row for
-- that token.
create index if not exists token_price_history_token_recorded_idx
  on public.token_price_history (token_address, recorded_at desc);

-- Retention delete (20260820080000) filters by recorded_at alone across
-- every token, which the composite index above can't serve efficiently
-- (recorded_at isn't the leading column) -- a plain index on recorded_at
-- covers that scan.
create index if not exists token_price_history_recorded_at_idx
  on public.token_price_history (recorded_at);

-- Internal table, same as sync_cursors (20260816180000): written only by
-- sync-tokens and read only by recompute_wallet_performance(), both via
-- service_role -- no anon/authenticated grant, no RLS needed.
grant select, insert on public.token_price_history to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Same PGRST205 trap as PR 3 (alert_rules) and yesterday's Leaderboard
-- hotfix (wallets.pnl_30d_reliable): `supabase db push` applies this over a
-- direct Postgres connection, which doesn't itself notify PostgREST to
-- reload its schema cache. sync-tokens writes here through supabase-js,
-- i.e. over PostgREST's REST API (`.from("token_price_history").insert(...)`),
-- so without this, every insert would 404 with "Could not find the table
-- 'public.token_price_history' in the schema cache" until PostgREST's own
-- periodic reload happened to catch up.
notify pgrst, 'reload schema';
