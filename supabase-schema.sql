-- Forma PWA: Supabase schema, run once in Supabase SQL Editor.
-- All user-owned rows are protected by RLS. The client uses only the publishable key.

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_logs (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.user_custom_foods (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Keep update cursors consistent across devices using the database clock.
create or replace function public.forma_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists forma_user_profiles_updated_at on public.user_profiles;
create trigger forma_user_profiles_updated_at
before insert or update on public.user_profiles
for each row execute function public.forma_set_updated_at();

drop trigger if exists forma_daily_logs_updated_at on public.daily_logs;
create trigger forma_daily_logs_updated_at
before insert or update on public.daily_logs
for each row execute function public.forma_set_updated_at();

drop trigger if exists forma_custom_foods_updated_at on public.user_custom_foods;
create trigger forma_custom_foods_updated_at
before insert or update on public.user_custom_foods
for each row execute function public.forma_set_updated_at();

-- Supports efficient per-user incremental timeline pulls after the first sync.
create index if not exists daily_logs_user_updated_idx
  on public.daily_logs (user_id, updated_at);

alter table public.user_profiles enable row level security;
alter table public.daily_logs enable row level security;
alter table public.user_custom_foods enable row level security;

-- Re-runnable policy setup.
drop policy if exists "profile_owner_all" on public.user_profiles;
create policy "profile_owner_all" on public.user_profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "daily_logs_owner_all" on public.daily_logs;
create policy "daily_logs_owner_all" on public.daily_logs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "custom_foods_owner_all" on public.user_custom_foods;
create policy "custom_foods_owner_all" on public.user_custom_foods
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.user_profiles to authenticated;
grant select, insert, update, delete on public.daily_logs to authenticated;
grant select, insert, update, delete on public.user_custom_foods to authenticated;

-- No anonymous access is granted. Supabase Auth's user UUID is the ownership key.
