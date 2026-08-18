-- Adds `next_page_params` to `sync_cursors` for sync-tokens-discovery, which
-- needs to resume Blockscout's /api/v2/tokens pagination from wherever the
-- last invoke left off -- a JSON cursor blob (Blockscout's own
-- next_page_params object), not a row id like sync-transactions'
-- `last_token_id`. NULL means "not positioned past sync-tokens' own
-- MAIN_SYNC_PAGES coverage yet" (either never run, or just wrapped around
-- after reaching the end of Blockscout's list) -- see sync-tokens-discovery
-- for how that state is used.
alter table public.sync_cursors
  add column if not exists next_page_params jsonb;
