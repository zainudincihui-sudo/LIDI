-- Follow & Alerts (PR 2/5): lets a signed-in user follow a wallet or a
-- token so they can be notified about it later (see the alert_rules /
-- alert_events tables planned for PR 3-4 of this series). This is the
-- first table in LIDI holding personal per-account data, so RLS is
-- intentionally strict: authenticated users can only see and manage their
-- own rows, and anon has no grant on this table at all.
--
-- This migration originally failed to deploy with "relation follows
-- already exists" -- a public.follows table predating this PR was already
-- live on the project (id, user_id, wallet_id, created_at only -- no
-- token_id, so it never supported following a token; no FK on user_id
-- either). Checked directly in the Supabase SQL Editor before touching
-- anything: row_count = 0, so it's an unused leftover from before the
-- email-auth system existed, not live data. Safe to drop and recreate
-- with the schema below.
drop table if exists public.follows;

create table public.follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  wallet_id uuid references public.wallets (id) on delete cascade,
  token_id uuid references public.tokens (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint follows_exactly_one_target check ((wallet_id is not null) <> (token_id is not null))
);

-- A user can only follow the same wallet/token once each.
create unique index follows_user_wallet_unique on public.follows (user_id, wallet_id) where wallet_id is not null;
create unique index follows_user_token_unique on public.follows (user_id, token_id) where token_id is not null;
create index follows_user_id_idx on public.follows (user_id);

alter table public.follows enable row level security;

create policy "Users can view their own follows"
  on public.follows for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can create their own follows"
  on public.follows for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can delete their own follows"
  on public.follows for delete
  to authenticated
  using (user_id = auth.uid());

-- No update policy -- a follow row is only ever created or removed.

-- authenticated: what the frontend uses on behalf of a signed-in user, RLS
-- above scopes every row to auth.uid(). service_role: read-only, for the
-- alert-checking Edge Function (PR 4) to see who follows what -- it never
-- needs to create or remove a user's follows. anon gets no grant at all,
-- matching the "anon has no access" intent above (we've been bitten before
-- by assuming a grant exists just because a table does -- see
-- grant_tokens_service_role.sql / grant_wallets_transactions_service_role.sql).
grant select, insert, delete on public.follows to authenticated;
grant select on public.follows to service_role;
