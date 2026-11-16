-- =====================================================================
-- Frontline Command — Phase 11: research, alliance operations, seasons
-- Run after 010_orders.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RESEARCH
--    Every unit type has an introduction YEAR. A player starts at 1939
--    and runs research programmes at a Research Office to open later
--    years, one at a time.
-- ---------------------------------------------------------------------
alter table public.unit_types add column if not exists year int not null default 1939;

alter table public.profiles
  add column if not exists research_year   int not null default 1939,
  add column if not exists research_target int,
  add column if not exists research_until  timestamptz;

create table if not exists public.research_levels (
  year          int primary key,
  cost_money    bigint not null,
  cost_supplies bigint not null default 0,
  seconds       int not null,
  min_level     int not null default 1
);
alter table public.research_levels enable row level security;
drop policy if exists "readable by everyone" on public.research_levels;
create policy "readable by everyone" on public.research_levels for select using (true);

-- The year a player has effectively reached. A programme that has run its
-- time counts straight away, even before anything "collects" it — the same
-- timestamp trick used everywhere else, so nothing needs to tick.
create or replace function public.fc_research_year(p public.profiles)
returns int language sql stable
as $$
  select case when p.research_target is not null and p.research_until <= now()
              then p.research_target else p.research_year end;
$$;

-- Recruiting is checked by a trigger, so buy_unit() itself is unchanged.
create or replace function public.fc_check_unit_year()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  utype public.unit_types;
  prof  public.profiles;
begin
  select * into utype from public.unit_types where id = new.unit_type;
  select * into prof from public.profiles where id = new.owner_id;
  if utype.year > public.fc_research_year(prof) then
    raise exception '% entered service in %. Research that year first.', utype.name, utype.year;
  end if;
  return new;
end;
$$;
drop trigger if exists units_check_year on public.units;
create trigger units_check_year before insert on public.units
  for each row execute function public.fc_check_unit_year();

create or replace function public.start_research()
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  lvl  public.research_levels;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;

  if not exists (select 1 from public.bases where owner_id = me and building_type = 'research_office') then
    raise exception 'Build a Research Office first.';
  end if;
  if prof.research_target is not null and prof.research_until > now() then
    raise exception 'A research programme is already running.';
  end if;

  -- Bank a programme that has finished, then look up the next year.
  prof.research_year := public.fc_research_year(prof);
  select * into lvl from public.research_levels where year = prof.research_year + 1;
  if not found then raise exception 'There is nothing further to research.'; end if;
  if prof.level < lvl.min_level then raise exception 'Researching % needs level %.', lvl.year, lvl.min_level; end if;
  if prof.money < lvl.cost_money or prof.supplies < lvl.cost_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  update public.profiles
     set money = money - lvl.cost_money, supplies = supplies - lvl.cost_supplies,
         research_year = prof.research_year, research_target = lvl.year,
         research_until = now() + make_interval(secs => lvl.seconds)
   where id = me
  returning * into prof;
  return prof;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. ALLIANCE OPERATIONS
--    A joint effort with a shared target and a time limit. Officers launch
--    one from the treasury; every member who contributes can collect the
--    reward if the alliance reaches the target in time.
-- ---------------------------------------------------------------------
create table if not exists public.operation_types (
  id              text primary key,
  name            text not null,
  description     text not null default '',
  goal_text       text not null,
  counter         text not null,
  target          int not null,
  hours           int not null,
  cost            bigint not null,
  reward_money    bigint not null default 0,
  reward_supplies bigint not null default 0,
  reward_xp       bigint not null default 0,
  alliance_xp     bigint not null default 0,
  sort            int not null default 0
);

create table if not exists public.alliance_operations (
  id           uuid primary key default gen_random_uuid(),
  alliance_id  uuid not null references public.alliances (id) on delete cascade,
  operation_id text not null references public.operation_types (id),
  counter      text not null,
  target       int not null,
  progress     int not null default 0,
  status       text not null default 'active' check (status in ('active', 'succeeded', 'failed')),
  started_by   text not null,
  started_at   timestamptz not null default now(),
  ends_at      timestamptz not null
);
create index if not exists alliance_operations_idx on public.alliance_operations (alliance_id, started_at desc);

create table if not exists public.operation_contributions (
  operation_id uuid not null references public.alliance_operations (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  amount       int not null default 0,
  claimed      boolean not null default false,
  primary key (operation_id, player_id)
);

alter table public.operation_types         enable row level security;
alter table public.alliance_operations     enable row level security;   -- functions only
alter table public.operation_contributions enable row level security;   -- functions only
drop policy if exists "readable by everyone" on public.operation_types;
create policy "readable by everyone" on public.operation_types for select using (true);

-- fc_bump (from Phase 10) now also feeds the alliance's active operation.
create or replace function public.fc_bump(p_player uuid, p_key text, p_amount int default 1)
returns void
language plpgsql security definer set search_path = public
as $$
declare op public.alliance_operations;
begin
  insert into public.player_counters (player_id, scope, counters)
  select p_player, s, jsonb_build_object(p_key, p_amount)
    from unnest(array['life', to_char(now() at time zone 'UTC', 'YYYY-MM-DD')]) as s
  on conflict (player_id, scope) do update
    set counters = player_counters.counters
                   || jsonb_build_object(p_key, coalesce((player_counters.counters ->> p_key)::int, 0) + p_amount);

  -- Is this player's alliance running an operation that counts this?
  select o.* into op
    from public.alliance_operations o
    join public.alliance_members m on m.alliance_id = o.alliance_id
   where m.player_id = p_player and o.status = 'active' and o.counter = p_key and o.ends_at > now()
   for update of o;
  if found then
    insert into public.operation_contributions (operation_id, player_id, amount)
    values (op.id, p_player, p_amount)
    on conflict (operation_id, player_id) do update
      set amount = operation_contributions.amount + p_amount;

    update public.alliance_operations
       set progress = least(target, progress + p_amount),
           status = case when progress + p_amount >= target then 'succeeded' else status end
     where id = op.id;

    if op.progress + p_amount >= op.target then
      update public.alliances
         set xp = xp + (select alliance_xp from public.operation_types where id = op.operation_id)
       where id = op.alliance_id;
      perform public.fc_system_message(op.alliance_id,
        (select name from public.operation_types where id = op.operation_id)
        || ' has succeeded. Everyone who took part can collect their reward.');
    end if;
  end if;
end;
$$;

create or replace function public.start_operation(p_operation_id text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  mine  public.alliance_members;
  otype public.operation_types;
  al    public.alliances;
  who   text;
begin
  select * into mine from public.alliance_members where player_id = me;
  if mine.alliance_id is null then raise exception 'Join an alliance first.'; end if;
  if mine.role not in ('leader', 'officer') then
    raise exception 'Only the leader and officers can launch an operation.';
  end if;
  select * into otype from public.operation_types where id = p_operation_id;
  if not found then raise exception 'Unknown operation.'; end if;

  select * into al from public.alliances where id = mine.alliance_id for update;
  -- Close one that ran out of time, then make sure none is still running.
  update public.alliance_operations set status = 'failed'
   where alliance_id = al.id and status = 'active' and ends_at <= now();
  if exists (select 1 from public.alliance_operations where alliance_id = al.id and status = 'active') then
    raise exception 'An operation is already under way.';
  end if;
  if al.treasury < otype.cost then raise exception 'The treasury needs % funds for this.', otype.cost; end if;

  select username into who from public.profiles where id = me;
  update public.alliances set treasury = treasury - otype.cost where id = al.id;
  insert into public.alliance_operations (alliance_id, operation_id, counter, target, started_by, ends_at)
  values (al.id, otype.id, otype.counter, otype.target, who, now() + make_interval(hours => otype.hours));
  insert into public.treasury_log (alliance_id, player_name, amount, reason)
  values (al.id, who, -otype.cost, otype.name);
  perform public.fc_system_message(al.id, who || ' launched ' || otype.name || ': ' || otype.goal_text || '.');
end;
$$;

-- The alliance's current (or most recent) operation and who has done what.
create or replace function public.get_alliance_operation()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  my_alliance uuid;
begin
  select alliance_id into my_alliance from public.alliance_members where player_id = me;
  if my_alliance is null then return null; end if;

  update public.alliance_operations set status = 'failed'
   where alliance_id = my_alliance and status = 'active' and ends_at <= now();

  return (
    select to_jsonb(o) || jsonb_build_object(
      'contributions', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'player_id', c.player_id, 'username', p.username, 'nation_id', p.nation_id,
                   'amount', c.amount, 'claimed', c.claimed) order by c.amount desc)
            from public.operation_contributions c join public.profiles p on p.id = c.player_id
           where c.operation_id = o.id), '[]'))
      from public.alliance_operations o
     where o.alliance_id = my_alliance
     order by o.started_at desc limit 1);
end;
$$;

create or replace function public.claim_operation_reward(p_operation uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  op    public.alliance_operations;
  otype public.operation_types;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform 1 from public.profiles where id = me for update;
  select * into op from public.alliance_operations where id = p_operation;
  if not found or op.status <> 'succeeded' then raise exception 'That operation did not succeed.'; end if;

  -- Flip "claimed" and check we took part, in one statement, so a double
  -- click cannot pay twice.
  update public.operation_contributions set claimed = true
   where operation_id = op.id and player_id = me and amount > 0 and not claimed;
  if not found then raise exception 'There is no reward waiting for you from this operation.'; end if;

  select * into otype from public.operation_types where id = op.operation_id;
  perform public.fc_grant(me, otype.reward_money, otype.reward_supplies, otype.reward_xp);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. SEASONS
--    A second leaderboard that starts again every quarter. XP earned
--    during a season counts toward it; the top ten keep a permanent award.
-- ---------------------------------------------------------------------
create table if not exists public.seasons (
  id        int generated always as identity primary key,
  name      text not null,
  starts_at timestamptz not null unique,
  ends_at   timestamptz not null
);

create table if not exists public.season_scores (
  season_id int not null references public.seasons (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  xp        bigint not null default 0,
  primary key (season_id, player_id)
);
create index if not exists season_scores_idx on public.season_scores (season_id, xp desc);

create table if not exists public.season_awards (
  season_id int not null references public.seasons (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  position  int not null,
  primary key (season_id, player_id)
);

alter table public.seasons       enable row level security;
alter table public.season_scores enable row level security;   -- functions only
alter table public.season_awards enable row level security;   -- functions only
drop policy if exists "readable by everyone" on public.seasons;
create policy "readable by everyone" on public.seasons for select using (true);

-- The season running now. If the calendar has moved into a new quarter,
-- this opens it and hands out the previous season's awards.
create or replace function public.fc_current_season()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  sid   int;
  start timestamptz := date_trunc('quarter', now() at time zone 'UTC') at time zone 'UTC';
  prev  int;
begin
  select id into sid from public.seasons where starts_at = start;
  if sid is not null then return sid; end if;

  insert into public.seasons (name, starts_at, ends_at)
  values ('Season ' || to_char(start at time zone 'UTC', 'YYYY "Q"Q'), start, start + interval '3 months')
  on conflict (starts_at) do nothing;
  select id into sid from public.seasons where starts_at = start;

  -- Top ten of the season that has just closed.
  select id into prev from public.seasons where starts_at < start order by starts_at desc limit 1;
  if prev is not null then
    insert into public.season_awards (season_id, player_id, position)
    select prev, player_id, pos
      from (select player_id, rank() over (order by xp desc) as pos
              from public.season_scores where season_id = prev and xp > 0) r
     where pos <= 10
    on conflict do nothing;
  end if;
  return sid;
end;
$$;

-- Whenever a player's XP goes up, by any route, the gain also counts for
-- the current season. A trigger means no other function had to change.
create or replace function public.fc_track_season_xp()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.xp > old.xp then
    insert into public.season_scores (season_id, player_id, xp)
    values (public.fc_current_season(), new.id, new.xp - old.xp)
    on conflict (season_id, player_id) do update set xp = season_scores.xp + excluded.xp;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_season_xp on public.profiles;
create trigger profiles_season_xp after update of xp on public.profiles
  for each row execute function public.fc_track_season_xp();

create or replace function public.get_season_board()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare sid int := public.fc_current_season();
begin
  return (
    with ranked as (
      select s.player_id, s.xp, p.username, p.nation_id, p.level,
             (select a.tag from public.alliance_members am join public.alliances a on a.id = am.alliance_id
               where am.player_id = p.id) as alliance_tag,
             rank() over (order by s.xp desc) as position
        from public.season_scores s join public.profiles p on p.id = s.player_id
       where s.season_id = sid and s.xp > 0)
    select jsonb_build_object(
      'season', (select to_jsonb(x) from public.seasons x where x.id = sid),
      'players', coalesce((select jsonb_agg(to_jsonb(r) - 'player_id' order by r.position)
                             from ranked r where r.position <= 50), '[]'),
      'me', (select to_jsonb(r) - 'player_id' from ranked r where r.player_id = auth.uid())));
end;
$$;

-- Public profiles gain season awards.
create or replace function public.get_player_profile(p_username text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'nation_id', p.nation_id,
    'level', p.level,
    'xp', p.xp,
    'missions_completed', p.missions_completed,
    'research_year', public.fc_research_year(p),
    'joined_at', p.created_at,
    'last_seen_at', p.last_seen_at,
    'rank', (select count(*) + 1 from public.profiles o where o.xp > p.xp and o.nation_id is not null),
    'alliance', (select jsonb_build_object('name', a.name, 'tag', a.tag, 'role', m.role)
                   from public.alliance_members m join public.alliances a on a.id = m.alliance_id
                  where m.player_id = p.id),
    'honours', coalesce((select jsonb_agg(c.objective_id order by c.claimed_at)
                           from public.objective_claims c where c.player_id = p.id), '[]'),
    'season_awards', coalesce((select jsonb_agg(jsonb_build_object('season', s.name, 'position', a.position)
                                        order by s.starts_at desc)
                                 from public.season_awards a join public.seasons s on s.id = a.season_id
                                where a.player_id = p.id), '[]'),
    'bases', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', b.id, 'name', b.name, 'building_type', b.building_type, 'level', b.level,
                 'lat', b.lat, 'lng', b.lng, 'zone', b.zone,
                 'units', (select count(*) from public.units u where u.base_id = b.id))
               order by b.created_at)
               from public.bases b where b.owner_id = p.id), '[]'),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
                 'unit_type', u.unit_type, 'name', u.name, 'specialty', u.specialty,
                 'missions_done', u.missions_done, 'base_id', u.base_id)
               order by u.created_at)
               from public.units u where u.owner_id = p.id), '[]'))
    from public.profiles p
   where lower(p.username) = lower(p_username) and p.nation_id is not null;
$$;

-- ---------------------------------------------------------------------
-- 4. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_bump(uuid, text, int) from public, anon, authenticated;
revoke all on function public.fc_check_unit_year() from public, anon, authenticated;
revoke all on function public.fc_track_season_xp() from public, anon, authenticated;
revoke all on function public.fc_current_season() from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['start_research()', 'start_operation(text)', 'get_alliance_operation()',
                            'claim_operation_reward(uuid)', 'get_season_board()', 'get_player_profile(text)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
