-- Ensure `wallets.address` is unique so sync-transactions can upsert
-- (insert-if-missing) on it, the same way tokens_contract_address_unique
-- lets sync-tokens upsert on `tokens.contract_address`.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wallets_address_key'
  ) then
    alter table public.wallets
      add constraint wallets_address_key unique (address);
  end if;
end $$;
