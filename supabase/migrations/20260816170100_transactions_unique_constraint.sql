-- Ensure (tx_hash, token_id, wallet_id) is unique so sync-transactions can
-- upsert transfers idempotently -- it runs every 5 minutes and will
-- re-fetch overlapping "latest transfers" pages on every run.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_tx_token_wallet_key'
  ) then
    alter table public.transactions
      add constraint transactions_tx_token_wallet_key unique (tx_hash, token_id, wallet_id);
  end if;
end $$;
