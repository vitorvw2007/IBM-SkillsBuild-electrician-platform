-- Electrician Job Dispatch Platform — Supabase schema
-- Run this once in the Supabase dashboard: SQL Editor > New query > paste > Run.
--
-- One row per signed-in user, holding the app's three state slices as JSON
-- (requests / settings / purchase).
-- Row-level security ensures a user can only ever read or write their own row.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requests jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  purchase jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "Users can view their own data"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "Users can insert their own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own data"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own data"
  on public.user_data for delete
  using (auth.uid() = user_id);

-- Keep updated_at current on every write.
create or replace function public.touch_user_data_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_user_data_updated_at on public.user_data;
create trigger set_user_data_updated_at
  before update on public.user_data
  for each row execute function public.touch_user_data_updated_at();

-- Made with Bob