-- The Virtuals Protocol factory address in sync-launchpad's FACTORY_LAUNCHPADS
-- was wrong (0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007 -- a different Virtuals
-- proxy on Robinhood Chain, not the one that deploys tokens; see issue #17
-- research notes). All 451 tokens were already checked against that address
-- with zero Virtuals matches before the fix landed. Resetting
-- launchpad_checked_at to NULL for every token that came back with no match
-- (launchpad IS NULL but it WAS checked) puts them back at the front of
-- sync-launchpad's queue so they get re-evaluated against the corrected
-- address. Tokens that already matched Pons are untouched -- that address
-- didn't change and doesn't need re-checking.
update public.tokens
set launchpad_checked_at = null
where launchpad is null
  and launchpad_checked_at is not null;
