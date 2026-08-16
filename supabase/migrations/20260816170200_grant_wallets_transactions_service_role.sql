-- sync-tokens needed an explicit grant to service_role on `tokens`
-- (see 20260816160000_grant_tokens_service_role.sql) because the table was
-- created without Supabase's default grants for that role. Apply the same
-- fix preemptively to `wallets` and `transactions`, which sync-transactions
-- needs to read and write.
grant select, insert, update, delete on public.wallets to service_role;
grant select, insert, update, delete on public.transactions to service_role;
grant usage, select on all sequences in schema public to service_role;
