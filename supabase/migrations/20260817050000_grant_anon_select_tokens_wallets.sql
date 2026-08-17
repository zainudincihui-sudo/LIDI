-- The Search feature in index.html now runs ilike queries directly against
-- tokens (ticker, name) and wallets (address, label) with the anon key,
-- instead of filtering the 12 rows already loaded client-side.
--
-- We've hit this exact class of bug before: SELECT/INSERT/UPDATE/DELETE
-- privileges aren't automatically inherited just because a table exists --
-- service_role needed an explicit grant on tokens/wallets too (see
-- 20260816160000_grant_tokens_service_role.sql and
-- 20260816170200_grant_wallets_transactions_service_role.sql). So make the
-- anon/authenticated SELECT grant explicit here rather than assuming
-- whatever was set up via the dashboard is still correct.
--
-- In practice this should be a no-op: the Trending and Smart Wallets grids
-- already do `select("*")` against both tables with the anon key today, so
-- anon SELECT already covers every column used by the new search queries.
grant select on public.tokens to anon, authenticated;
grant select on public.wallets to anon, authenticated;
