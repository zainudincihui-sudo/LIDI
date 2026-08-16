-- The live deploy run confirmed sync-tokens failed with:
--   "permission denied for table tokens" (Postgres 42501)
-- Postgres's own hint: GRANT SELECT ON public.tokens TO service_role.
-- service_role is missing the privileges it needs to upsert into `tokens`
-- (the table was presumably created without the default grants Supabase
-- normally sets up for this role). Also cover the id sequence, if any,
-- since an insert without an explicit id would otherwise hit the same
-- error one level down.
grant select, insert, update, delete on public.tokens to service_role;
grant usage, select on all sequences in schema public to service_role;
