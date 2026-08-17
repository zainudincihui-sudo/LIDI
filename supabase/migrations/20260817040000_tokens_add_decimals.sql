-- Adds `decimals` to `tokens` so sync-tokens can store each token's decimal
-- precision from Blockscout's /api/v2/tokens response (`decimals` field).
--
-- This is the second-best source extractAmount() (sync-transactions) falls
-- back to when a Blockscout *transfer* payload is missing `total.decimals`
-- -- see issue #12. Before this column existed, that fallback had nowhere
-- to go and extractAmount() silently returned the raw, undivided token
-- amount instead, which could overstate amount/value_usd by up to 10^18x
-- for an 18-decimal token. Nullable because a token row may predate this
-- column being synced, or Blockscout's token-list item may itself lack a
-- decimals field -- extractAmount() has a further DEFAULT_DECIMALS (18)
-- fallback for that case.
alter table public.tokens
  add column if not exists decimals integer;
