-- Round-robin cursor state for sync-transactions (and any future syncer
-- that needs the same pattern). Each Edge Function invoke only has enough
-- compute budget to process a small batch of tokens (see TOKENS_PER_RUN in
-- supabase/functions/sync-transactions/index.ts), so instead of picking
-- tokens every run (which would starve low-volume tokens forever), the
-- function remembers where it left off and continues from there, wrapping
-- back to the start once it reaches the end -- so every token still gets
-- covered eventually across many 5-minute cron runs.
create table if not exists public.sync_cursors (
  cursor_name text primary key,
  last_token_id uuid,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.sync_cursors to service_role;
