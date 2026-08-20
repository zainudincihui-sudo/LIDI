-- Follow & Alerts (PR 4/5): the notifications that actually get shown to a
-- user, produced by the check-alerts Edge Function (this PR) scanning
-- active alert_rules (PR 3) on a schedule. Email delivery is a separate
-- concern landing in PR 5 -- this table only drives the in-app bell panel
-- for now. Same strict RLS posture as follows/alert_rules: authenticated
-- users only see/manage their own rows, anon has no grant at all.
create table public.alert_events (
  id uuid primary key default gen_random_uuid(),
  alert_rule_id uuid not null references public.alert_rules (id) on delete cascade,
  -- Deliberately NOT `default auth.uid()` like follows/alert_rules -- these
  -- rows are written by check-alerts using the service_role key, where
  -- there's no authenticated request to derive auth.uid() from. The
  -- function sets this explicitly from the owning rule's user_id.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Which transaction triggered a wallet_large_tx event; null for
  -- price_change_pct events (there's no single transaction to point at).
  -- Doubles as this table's dedup key -- see the unique index below.
  trigger_transaction_id uuid references public.transactions (id) on delete set null,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index alert_events_user_id_idx on public.alert_events (user_id);
-- A wallet_large_tx rule can only produce one event per transaction, even
-- if check-alerts' scan window overlaps between runs.
create unique index alert_events_dedup_tx
  on public.alert_events (alert_rule_id, trigger_transaction_id)
  where trigger_transaction_id is not null;

alter table public.alert_events enable row level security;

create policy "Users can view their own alert events"
  on public.alert_events for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can update their own alert events"
  on public.alert_events for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own alert events"
  on public.alert_events for delete
  to authenticated
  using (user_id = auth.uid());

-- No insert policy for authenticated -- a user must never be able to
-- fabricate their own notifications; only check-alerts (service_role)
-- creates these rows.

-- authenticated: select + delete (clear notification history) on the full
-- row, but update is scoped to just the is_read column -- marking a
-- notification read/unread shouldn't let a client rewrite its message or
-- repoint it at a different alert_rule_id. service_role: select + insert
-- for check-alerts; it never needs to update or delete an event once
-- written. anon gets no grant at all, same as follows/alert_rules.
grant select, delete on public.alert_events to authenticated;
grant update (is_read) on public.alert_events to authenticated;
grant select, insert on public.alert_events to service_role;

-- Learned from PR 3/4's deploy: `supabase db push` applies DDL over a
-- direct Postgres connection and doesn't itself notify PostgREST to
-- reload its schema cache the way changes through the Supabase dashboard
-- do. Baking this in from the start this time instead of needing a
-- follow-up migration (see 20260820010000_notify_pgrst_reload_alert_rules.sql
-- and supabase/DEPLOY.md).
notify pgrst, 'reload schema';
