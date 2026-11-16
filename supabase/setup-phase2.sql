-- ONE-PASTE SETUP for Phase 2: this is 001_profiles.sql followed by seed.sql.
-- Paste the whole file into Supabase → SQL Editor and press Run. Safe to run twice.

-- =====================================================================
-- Frontline Command — Phase 2: nations + player profiles
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. It is safe to run more than once.
-- After this file, run supabase/seed.sql the same way.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. nations  (a CONFIG table: players can read it, never change it)
--    Filled by supabase/seed.sql, which is generated from
--    src/data/nations.json.
-- ---------------------------------------------------------------------
create table if not exists public.nations (
  id         text primary key,            -- 'usa', 'uk', ...
  name       text not null,
  short      text not null,               -- 'USA', 'UK', ...
  color      text not null,
  bonuses    jsonb not null default '[]'  -- read by server functions in later phases
);

alter table public.nations enable row level security;

drop policy if exists "nations are readable by everyone" on public.nations;
create policy "nations are readable by everyone"
  on public.nations for select
  using (true);
-- No insert/update/delete policies exist, so with RLS switched on the
-- browser can do none of those things.

-- ---------------------------------------------------------------------
-- 2. profiles  (one row per player account)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  username           text not null unique,
  nation_id          text references public.nations (id),  -- NULL until the player chooses
  money              bigint not null default 0 check (money >= 0),
  supplies           bigint not null default 0 check (supplies >= 0),
  xp                 bigint not null default 0 check (xp >= 0),
  level              int    not null default 1 check (level >= 1),
  missions_completed int    not null default 0,
  last_spawn_at      timestamptz not null default now(),   -- used by mission spawning (Phase 4)
  last_seen_at       timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A player may READ their own row, and that is all. There is deliberately
-- no update policy: money, xp and nation can only be changed by the
-- server functions below. This is the heart of the anti-cheat design.
drop policy if exists "players can read their own profile" on public.profiles;
create policy "players can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- ---------------------------------------------------------------------
-- 3. Create a profile automatically whenever someone signs up
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer            -- runs with the table owner's rights, not the player's
set search_path = public    -- always set this on security definer functions
as $$
declare
  wanted text := trim(coalesce(new.raw_user_meta_data ->> 'username', ''));
  fallback text := 'Commander_' || substr(replace(new.id::text, '-', ''), 1, 8);
begin
  -- Usernames: 3–20 characters, letters / digits / underscore.
  -- If the requested name is invalid or already taken we fall back to a
  -- generated one, so that sign-up itself can never fail because of it.
  if wanted !~ '^[A-Za-z0-9_]{3,20}$'
     or exists (select 1 from public.profiles where lower(username) = lower(wanted)) then
    wanted := fallback;
  end if;

  begin
    insert into public.profiles (id, username) values (new.id, wanted);
  exception when unique_violation then
    -- Two people grabbed the same name in the same instant.
    insert into public.profiles (id, username) values (new.id, fallback);
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Case-insensitive uniqueness: "Patton" and "patton" are the same name.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- ---------------------------------------------------------------------
-- 4. choose_nation(): the ONLY way a player's nation gets set
-- ---------------------------------------------------------------------
create or replace function public.choose_nation(p_nation_id text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();           -- who is calling? Comes from their login token.
  result public.profiles;
begin
  if me is null then
    raise exception 'You must be logged in.';
  end if;

  if not exists (select 1 from public.nations where id = p_nation_id) then
    raise exception 'Unknown nation.';
  end if;

  -- The "nation_id is null" condition makes this a one-time choice, and
  -- means the starting funds can only ever be granted once.
  update public.profiles
     set nation_id = p_nation_id,
         money     = 20000,
         supplies  = 500
   where id = me
     and nation_id is null
  returning * into result;

  if not found then
    raise exception 'You have already chosen a nation.';
  end if;

  return result;
end;
$$;

-- Functions are callable by everyone by default; lock that down so only
-- logged-in players can call choose_nation, and nobody can call the
-- trigger function directly.
revoke all on function public.choose_nation(text) from public, anon;
grant execute on function public.choose_nation(text) to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- GENERATED FILE — do not edit by hand.
-- Edit the JSON files in src/data/ and run `npm run seed` instead.

insert into public.nations (id, name, short, color, bonuses) values
  ('usa', 'United States', 'USA', '#4f6d8f', '[{"type":"speed_mult","category":"logistics","value":1.15},{"type":"reward_mult","resource":"supplies","value":1.1}]'::jsonb),
  ('uk', 'United Kingdom', 'UK', '#8f4f4f', '[{"type":"speed_mult","category":"recon","value":1.1},{"type":"speed_mult","category":"air","value":1.1}]'::jsonb),
  ('ussr', 'Soviet Union', 'USSR', '#a8552f', '[{"type":"cost_mult","category":"infantry","value":0.9},{"type":"cost_mult","category":"armor","value":0.9}]'::jsonb),
  ('germany', 'Germany', 'GER', '#6b6b63', '[{"type":"power_mult","category":"armor","value":1.1}]'::jsonb),
  ('france', 'France', 'FRA', '#4f5f9f', '[{"type":"building_cost_mult","value":0.9}]'::jsonb),
  ('italy', 'Italy', 'ITA', '#4f8f62', '[{"type":"cost_mult","category":"engineers","value":0.9},{"type":"cost_mult","category":"artillery","value":0.9}]'::jsonb),
  ('japan', 'Japan', 'JPN', '#9f8f4f', '[{"type":"speed_mult","category":"infantry","value":1.15}]'::jsonb)
on conflict (id) do update set name = excluded.name, short = excluded.short, color = excluded.color, bonuses = excluded.bonuses;
