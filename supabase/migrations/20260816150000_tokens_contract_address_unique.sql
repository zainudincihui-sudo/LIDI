-- Ensure `tokens.contract_address` is unique so sync-tokens can upsert on it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tokens_contract_address_key'
  ) then
    alter table public.tokens
      add constraint tokens_contract_address_key unique (contract_address);
  end if;
end $$;
