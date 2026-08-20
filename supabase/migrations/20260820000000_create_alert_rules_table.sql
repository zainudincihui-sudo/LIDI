-- Follow & Alerts (PR 3/5): lets a signed-in user define alert conditions
-- ("kondisi alert") on a wallet they follow or a token -- e.g. "notify me
-- if this wallet makes a transaction over $X" or "notify me if this
-- token's price moves Y%". This table only stores the *rules*; nothing
-- evaluates them yet -- the alert-checking Edge Function and the
-- alert_events table it writes to land in PR 4. Same strict RLS posture
-- as follows (PR 2): authenticated users only see/manage their own rows,
-- anon has no grant on the table at all.
create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  wallet_id uuid references public.wallets (id) on delete cascade,
  token_id uuid references public.tokens (id) on delete cascade,
  condition_type text not null check (condition_type in ('wallet_large_tx', 'price_change_pct')),
  direction text check (direction in ('up', 'down')),
  threshold numeric not null check (threshold > 0),
  is_active boolean not null default true,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  -- wallet_large_tx rules target a wallet (no direction -- a big trade is a
  -- big trade either way); price_change_pct rules target a token and
  -- require a direction. Keeps a rule from being created with a target/type
  -- mismatch (e.g. a "price change" rule pointing at a wallet_id).
  constraint alert_rules_target_matches_type check (
    (condition_type = 'wallet_large_tx' and wallet_id is not null and token_id is null and direction is null)
    or
    (condition_type = 'price_change_pct' and token_id is not null and wallet_id is null and direction is not null)
  )
);

create index alert_rules_user_id_idx on public.alert_rules (user_id);
-- What PR 4's alert-checker will scan on every run: active rules, grouped by
-- what they watch.
create index alert_rules_active_wallet_idx on public.alert_rules (wallet_id) where is_active and wallet_id is not null;
create index alert_rules_active_token_idx on public.alert_rules (token_id) where is_active and token_id is not null;

alter table public.alert_rules enable row level security;

create policy "Users can view their own alert rules"
  on public.alert_rules for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can create their own alert rules"
  on public.alert_rules for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their own alert rules"
  on public.alert_rules for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own alert rules"
  on public.alert_rules for delete
  to authenticated
  using (user_id = auth.uid());

-- authenticated: full CRUD on their own rows via RLS above, for the
-- frontend built in this PR. service_role: select + update (not insert/
-- delete -- it never creates or removes a user's rules), for PR 4's
-- alert-checker to read active rules and stamp last_triggered_at after
-- firing one. anon gets no grant at all, same as follows.
grant select, insert, update, delete on public.alert_rules to authenticated;
grant select, update on public.alert_rules to service_role;
