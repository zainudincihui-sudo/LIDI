-- Adds `launchpad_checked_at` to `tokens` so sync-launchpad can tell "never
-- checked" apart from "checked, confirmed no matching launchpad" -- both
-- cases leave `launchpad` NULL, so without a separate marker the function
-- would keep re-fetching already-confirmed-non-match tokens from
-- Blockscout on every pass, at the same priority as tokens it has never
-- looked at yet.
--
-- Nullable timestamptz: NULL means never checked (sorts first, so
-- never-checked tokens are always processed ahead of already-checked
-- ones); non-NULL is the last time this token's deployer address was
-- queried and classified. sync-launchpad rewrites it after every check, so
-- a checked row naturally sorts to the back of the queue -- no separate
-- cursor needed to avoid starving newer tokens.
alter table public.tokens
  add column if not exists launchpad_checked_at timestamptz;
