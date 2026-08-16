-- A live sync-transactions run hit "duplicate key value violates unique
-- constraint transactions_tx_hash_key" -- the `transactions` table already
-- enforces tx_hash as unique table-wide (one row per transaction hash),
-- separately from the (tx_hash, token_id, wallet_id) composite constraint
-- added in 20260816170100_transactions_unique_constraint.sql. That composite
-- constraint doesn't cover this: Postgres only suppresses conflicts an
-- ON CONFLICT clause explicitly targets, so upserting on the composite key
-- alone still failed on the pre-existing single-column constraint.
--
-- This migration is a no-op on this project (the constraint already
-- exists) -- it just makes that requirement explicit in the repo instead
-- of only discoverable by hitting the error. sync-transactions now upserts
-- with `onConflict: "tx_hash"` to match.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_tx_hash_key'
  ) then
    alter table public.transactions
      add constraint transactions_tx_hash_key unique (tx_hash);
  end if;
end $$;
