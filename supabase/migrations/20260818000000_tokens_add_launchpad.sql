-- Adds `launchpad` to `tokens` so tokens can be tagged by the launchpad
-- (factory/bonding-curve contract) that deployed them -- see issue #17.
--
-- Nullable text rather than an enum: only Pons and Virtuals factory
-- addresses are confirmed so far (Clanker's Robinhood Chain factory
-- address isn't documented yet -- separate follow-up task), and a token
-- whose deployer doesn't match any known factory should stay NULL rather
-- than being forced into a fixed set of values or treated as an error.
alter table public.tokens
  add column if not exists launchpad text;
