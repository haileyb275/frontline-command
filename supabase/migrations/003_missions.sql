-- =====================================================================
-- Frontline Command — Phase 4: missions, dispatching, rewards
-- Run after 002_bases_units.sql. Safe to run more than once.
--
-- The big idea: NOTHING RUNS IN THE BACKGROUND. We store timestamps
-- ("this unit arrives at 14:02:10", "this mission completes at 14:05:00")
-- and whenever a player's browser checks in, fc_sync() looks at the clock
-- and settles everything that should have happened by now. Being offline
-- for a minute or a week makes no difference.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Config tables
-- ---------------------------------------------------------------------
alter table public.unit_categories
  add column if not exists base_power numeric not null default 10;

-- Tunable numbers (from src/data/settings.json)
create table if not exists public.game_config (
  key   text primary key,
  value numeric not null
);

create table if not exists public.mission_types (
  id               text primary key,
  name             text not null,
  description      text not null default '',
  requirements     jsonb not null,           -- {"infantry": 2, "artillery": 1}
  duration_seconds int    not null,
  reward_money     bigint not null,
  reward_supplies  bigint not null default 0,
  reward_xp        bigint not null,
  difficulty       int    not null default 1,
  min_level        int    not null default 1,
  spawn_weight     numeric not null default 1,   -- bigger = spawns more often
  shareable        boolean not null default false,
  followups        jsonb  not null default '[]', -- [{"mission": "...", "chance": 0.3}]
  expires_seconds  int    not null default 10800
);

alter table public.game_config   enable row level security;
alter table public.mission_types enable row level security;
drop policy if exists "readable by everyone" on public.game_config;
create policy "readable by everyone" on public.game_config for select using (true);
drop policy if exists "readable by everyone" on public.mission_types;
create policy "readable by everyone" on public.mission_types for select using (true);

-- ---------------------------------------------------------------------
-- 2. Player tables
-- ---------------------------------------------------------------------
create table if not exists public.missions (
  id                uuid primary key default gen_random_uuid(),
  mission_type      text not null references public.mission_types (id),
  owner_id          uuid not null references public.profiles (id) on delete cascade,
  alliance_id       uuid,                    -- set when shared (Phase 5)
  lat               double precision not null,
  lng               double precision not null,
  status            text not null default 'open'
                    check (status in ('open', 'in_progress', 'completed', 'expired')),
  spawned_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  started_at        timestamptz,             -- when the last required unit arrives
  completes_at      timestamptz,             -- started_at + duration
  completed_at      timestamptz,
  parent_mission_id uuid
);
create index if not exists missions_owner_status_idx on public.missions (owner_id, status);

-- One row per unit that is out on a mission (or on its way home).
create table if not exists public.dispatches (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references public.missions (id) on delete cascade,
  unit_id        uuid not null unique references public.units (id) on delete cascade,
  player_id      uuid not null references public.profiles (id) on delete cascade,
  category_id    text not null,
  power          numeric not null,
  from_lat       double precision not null,
  from_lng       double precision not null,
  travel_seconds int not null,
  departed_at    timestamptz not null default now(),
  arrives_at     timestamptz not null,
  returns_at     timestamptz                 -- NULL until the unit turns for home
);
create index if not exists dispatches_mission_idx on public.dispatches (mission_id);
create index if not exists dispatches_player_idx  on public.dispatches (player_id);

alter table public.missions   enable row level security;
alter table public.dispatches enable row level security;

drop policy if exists "players can read their own missions" on public.missions;
create policy "players can read their own missions"
  on public.missions for select using (auth.uid() = owner_id);

drop policy if exists "players can read their own dispatches" on public.dispatches;
create policy "players can read their own dispatches"
  on public.dispatches for select using (auth.uid() = player_id);

-- ---------------------------------------------------------------------
-- 3. Small helpers
-- ---------------------------------------------------------------------
create or replace function public.fc_cfg(p_key text)
returns numeric language sql stable set search_path = public
as $$ select value from public.game_config where key = p_key; $$;

-- Level 2 at 100 XP, level 3 at 400, level 4 at 900, level 5 at 1600 …
create or replace function public.fc_level_for_xp(p_xp bigint)
returns int language sql immutable
as $$ select floor(sqrt(greatest(p_xp, 0) / 100.0))::int + 1; $$;

-- Create one mission of the given type somewhere between p_min_km and
-- p_max_km from a point.
create or replace function public.fc_spawn_mission(
  p_owner uuid, p_type text,
  p_lat double precision, p_lng double precision,
  p_min_km numeric, p_max_km numeric,
  p_parent uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  dist    double precision := p_min_km + random() * (p_max_km - p_min_km);
  bearing double precision := random() * 2 * pi();
  new_lat double precision;
  new_lng double precision;
begin
  -- One degree of latitude is about 111 km; a degree of longitude shrinks
  -- as you move away from the equator (hence the cos()).
  new_lat := greatest(-84, least(84, p_lat + dist * cos(bearing) / 111.0));
  new_lng := p_lng + dist * sin(bearing) / (111.0 * greatest(0.1, cos(radians(p_lat))));
  if new_lng > 180 then new_lng := new_lng - 360; end if;
  if new_lng < -180 then new_lng := new_lng + 360; end if;

  insert into public.missions (mission_type, owner_id, lat, lng, expires_at, parent_mission_id)
  select t.id, p_owner, new_lat, new_lng,
         now() + make_interval(secs => t.expires_seconds), p_parent
    from public.mission_types t where t.id = p_type;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. fc_sync(): settle everything that has happened up to now.
--    Returns a list of "events" (mission completed, level up…) so the
--    browser can tell the player what happened while they were away.
-- ---------------------------------------------------------------------
create or replace function public.fc_sync(p_me uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_now  timestamptz := now();
  prof   public.profiles;
  events jsonb := '[]'::jsonb;
  m      record;
  f      jsonb;
  gain_money    bigint;
  gain_supplies bigint;
  new_level  int;
  n_bases    int;
  due        int;
  max_open   int;
  open_now   int;
  spawn_type text;
  spawn_base public.bases;
begin
  -- Lock our profile row: if two tabs sync at once, the second waits here,
  -- so a reward can never be paid twice.
  select * into prof from public.profiles where id = p_me for update;
  if not found or prof.nation_id is null then return events; end if;

  -- ---- (a) Missions whose timer has run out: pay rewards, send units home
  for m in
    select ms.id, ms.lat, ms.lng, ms.completes_at,
           t.name, t.reward_money, t.reward_supplies, t.reward_xp, t.followups
      from public.missions ms
      join public.mission_types t on t.id = ms.mission_type
     where ms.owner_id = p_me and ms.status = 'in_progress' and ms.completes_at <= v_now
     order by ms.completes_at
  loop
    gain_money    := round(m.reward_money    * public.fc_nation_bonus(prof.nation_id, 'reward_mult', 'money'));
    gain_supplies := round(m.reward_supplies * public.fc_nation_bonus(prof.nation_id, 'reward_mult', 'supplies'));

    update public.missions set status = 'completed', completed_at = m.completes_at where id = m.id;

    -- Units start for home at the moment the mission finished (which may
    -- be well in the past if the player was offline).
    update public.dispatches
       set returns_at = m.completes_at + make_interval(secs => travel_seconds)
     where mission_id = m.id and returns_at is null;

    prof.money    := prof.money + gain_money;
    prof.supplies := prof.supplies + gain_supplies;
    prof.xp       := prof.xp + m.reward_xp;
    prof.missions_completed := prof.missions_completed + 1;

    events := events || jsonb_build_object(
      'type', 'mission_completed', 'name', m.name,
      'money', gain_money, 'supplies', gain_supplies, 'xp', m.reward_xp);

    -- Follow-up missions: roll the dice for each one listed.
    for f in select * from jsonb_array_elements(m.followups) loop
      if random() < (f ->> 'chance')::numeric then
        perform public.fc_spawn_mission(p_me, f ->> 'mission', m.lat, m.lng, 1, 4, m.id);
        events := events || jsonb_build_object('type', 'followup',
          'name', (select name from public.mission_types where id = f ->> 'mission'));
      end if;
    end loop;
  end loop;

  new_level := public.fc_level_for_xp(prof.xp);
  if new_level > prof.level then
    prof.level := new_level;
    events := events || jsonb_build_object('type', 'level_up', 'level', new_level);
  end if;

  -- ---- (b) Open missions nobody completed in time: expire, recall units
  for m in
    select id, expires_at from public.missions
     where owner_id = p_me and status = 'open' and expires_at <= v_now
  loop
    update public.missions set status = 'expired' where id = m.id;
    update public.dispatches
       set returns_at = m.expires_at + make_interval(
             secs => least(travel_seconds, extract(epoch from m.expires_at - departed_at)))
     where mission_id = m.id and returns_at is null;
  end loop;

  -- ---- (c) Bring the units' status labels up to date
  update public.units u
     set status = case when d.returns_at is not null then 'returning'
                       when d.arrives_at <= v_now    then 'on_mission'
                       else 'en_route' end,
         busy_until = d.returns_at
    from public.dispatches d
   where d.unit_id = u.id and d.player_id = p_me;

  -- ---- (d) Units that have made it home are free again
  with back as (
    delete from public.dispatches
     where player_id = p_me and returns_at <= v_now
    returning unit_id)
  update public.units
     set status = 'idle', mission_id = null, busy_until = null
   where id in (select unit_id from back);

  -- ---- (e) Tidy up old finished missions
  delete from public.missions ms
   where ms.owner_id = p_me and ms.status in ('completed', 'expired')
     and coalesce(ms.completed_at, ms.expires_at) < v_now - interval '1 day'
     and not exists (select 1 from public.dispatches d where d.mission_id = ms.id);

  -- ---- (f) Spawn the missions that are due
  select count(*) into n_bases from public.bases where owner_id = p_me;
  due := floor(extract(epoch from v_now - prof.last_spawn_at) / public.fc_cfg('spawn_interval_seconds'));

  -- A brand-new commander gets their first two missions straight away
  -- instead of staring at an empty map.
  if prof.missions_completed = 0
     and not exists (select 1 from public.missions where owner_id = p_me) then
    due := greatest(due, 2);
  end if;

  if n_bases > 0 and due > 0 then
    -- Bigger commands get more simultaneous missions, up to a hard cap.
    -- This cap is also what stops a week offline from creating 5,000 missions.
    max_open := least(public.fc_cfg('max_open_missions'),
                      public.fc_cfg('base_open_missions') + n_bases + prof.level);
    select count(*) into open_now from public.missions where owner_id = p_me and status = 'open';

    for i in 1 .. greatest(0, least(due, max_open - open_now)) loop
      -- Weighted random pick among missions this player could actually do:
      -- high enough level, and every required category is unlocked by a
      -- building they own.
      select t.id into spawn_type
        from public.mission_types t
       where t.min_level <= prof.level
         and not exists (
               select 1 from jsonb_object_keys(t.requirements) as need(category)
                where not exists (
                        select 1 from public.bases b
                          join public.building_types bt on bt.id = b.building_type
                         where b.owner_id = p_me and bt.unlocks_categories ? need.category))
       order by -ln(1 - random()) / t.spawn_weight
       limit 1;
      exit when spawn_type is null;

      select * into spawn_base from public.bases where owner_id = p_me order by random() limit 1;
      perform public.fc_spawn_mission(p_me, spawn_type, spawn_base.lat, spawn_base.lng,
                public.fc_cfg('spawn_radius_min_km'), public.fc_cfg('spawn_radius_max_km'));
    end loop;

    prof.last_spawn_at := v_now;
  end if;

  update public.profiles
     set money = prof.money, supplies = prof.supplies, xp = prof.xp, level = prof.level,
         missions_completed = prof.missions_completed,
         last_spawn_at = prof.last_spawn_at, last_seen_at = v_now
   where id = p_me;

  return events;
end;
$$;

-- Everything the browser needs to draw the game, in one answer.
create or replace function public.fc_snapshot(p_me uuid, p_events jsonb default '[]')
returns jsonb
language sql security definer set search_path = public
as $$
  select jsonb_build_object(
    'server_time', now(),
    'events', p_events,
    'profile', (select to_jsonb(p) from public.profiles p where p.id = p_me),
    'units', coalesce((select jsonb_agg(to_jsonb(u) order by u.created_at)
                         from public.units u where u.owner_id = p_me), '[]'),
    'missions', coalesce((select jsonb_agg(to_jsonb(m) order by m.spawned_at)
                            from public.missions m
                           where m.owner_id = p_me and m.status in ('open', 'in_progress')), '[]'),
    'dispatches', coalesce((select jsonb_agg(to_jsonb(d) order by d.departed_at)
                              from public.dispatches d where d.player_id = p_me), '[]'));
$$;

-- ---------------------------------------------------------------------
-- 5. The functions the browser may call
-- ---------------------------------------------------------------------

-- Called on login and every few seconds while playing.
create or replace function public.sync_player()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  return public.fc_snapshot(me, public.fc_sync(me));
end;
$$;

-- Send units to a mission.
create or replace function public.dispatch_units(p_mission_id uuid, p_unit_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me      uuid := auth.uid();
  v_now   timestamptz := now();
  events  jsonb;
  prof    public.profiles;
  mission public.missions;
  mtype   public.mission_types;
  u       record;
  needed  int;
  sent    int;
  travel  int;
  all_met boolean;
  total_power numeric;
  ref_power   numeric;
  starts  timestamptz;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then
    raise exception 'Select at least one unit.';
  end if;

  events := public.fc_sync(me);           -- settle the clock first
  select * into prof from public.profiles where id = me;

  select * into mission from public.missions where id = p_mission_id and owner_id = me for update;
  if not found then raise exception 'Mission not found.'; end if;
  if mission.status <> 'open' then raise exception 'That mission is no longer open.'; end if;
  select * into mtype from public.mission_types where id = mission.mission_type;

  for u in
    select un.id, un.status, ut.category_id, ut.name, ut.speed_kmh, ut.power, b.lat, b.lng
      from unnest(p_unit_ids) as wanted(id)
      left join public.units un on un.id = wanted.id and un.owner_id = me
      left join public.unit_types ut on ut.id = un.unit_type
      left join public.bases b on b.id = un.base_id
  loop
    if u.id is null then raise exception 'One of those units is not yours.'; end if;
    if u.status <> 'idle' then raise exception '% is not available.', u.name; end if;

    -- Does the mission still need a unit of this category?
    needed := coalesce((mtype.requirements ->> u.category_id)::int, 0);
    select count(*) into sent from public.dispatches
     where mission_id = mission.id and category_id = u.category_id and returns_at is null;
    if sent >= needed then
      raise exception 'This mission does not need another % unit.',
        (select name from public.unit_categories where id = u.category_id);
    end if;

    -- Travel time = distance ÷ speed, sped up by the game's time scale.
    -- Worked out HERE from the server's own numbers; the browser only
    -- says which units to send.
    travel := greatest(
      public.fc_cfg('min_travel_seconds'),
      round(public.fc_distance_km(u.lat, u.lng, mission.lat, mission.lng)
            / (u.speed_kmh * public.fc_nation_bonus(prof.nation_id, 'speed_mult', u.category_id))
            * 3600 / public.fc_cfg('travel_time_scale')));

    insert into public.dispatches
      (mission_id, unit_id, player_id, category_id, power, from_lat, from_lng,
       travel_seconds, departed_at, arrives_at)
    values
      (mission.id, u.id, me, u.category_id,
       u.power * public.fc_nation_bonus(prof.nation_id, 'power_mult', u.category_id),
       u.lat, u.lng, travel, v_now, v_now + make_interval(secs => travel));

    update public.units set status = 'en_route', mission_id = mission.id where id = u.id;
  end loop;

  -- Are all requirements now covered? If so we already know exactly when
  -- the mission will start (when the slowest unit arrives) and finish.
  select bool_and(
           (select count(*) from public.dispatches d
             where d.mission_id = mission.id and d.category_id = req.key and d.returns_at is null)
           >= req.value::int)
    into all_met
    from jsonb_each_text(mtype.requirements) as req;

  if all_met then
    select max(arrives_at), sum(power) into starts, total_power
      from public.dispatches where mission_id = mission.id and returns_at is null;

    -- A stronger force than the "textbook" one finishes faster (up to 30%),
    -- a weaker one slower.
    select sum(req.value::int * c.base_power) into ref_power
      from jsonb_each_text(mtype.requirements) as req
      join public.unit_categories c on c.id = req.key;

    update public.missions
       set status = 'in_progress',
           started_at = starts,
           completes_at = starts + make_interval(secs => round(
             mtype.duration_seconds * greatest(0.7, least(1.3, ref_power / total_power))))
     where id = mission.id;
  end if;

  return public.fc_snapshot(me, events);
end;
$$;

-- Call your units back from a mission that has not started yet.
create or replace function public.recall_units(p_mission_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  v_now  timestamptz := now();
  events jsonb;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);

  if not exists (select 1 from public.missions
                  where id = p_mission_id and owner_id = me and status = 'open') then
    raise exception 'Units can only be recalled before a mission starts.';
  end if;

  -- The trip home takes as long as the unit has been travelling so far
  -- (or the full trip, if it had already arrived).
  update public.dispatches
     set returns_at = v_now + make_interval(
           secs => least(travel_seconds, extract(epoch from v_now - departed_at)))
   where mission_id = p_mission_id and player_id = me and returns_at is null;

  update public.units u set status = 'returning', busy_until = d.returns_at
    from public.dispatches d
   where d.unit_id = u.id and d.mission_id = p_mission_id and d.player_id = me;

  return public.fc_snapshot(me, events);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Permissions: players may call the three action functions and
--    nothing else. The fc_ helpers that change data are internal.
-- ---------------------------------------------------------------------
revoke all on function public.fc_sync(uuid) from public, anon, authenticated;
revoke all on function public.fc_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid)
  from public, anon, authenticated;

revoke all on function public.sync_player() from public, anon;
grant execute on function public.sync_player() to authenticated;
revoke all on function public.dispatch_units(uuid, uuid[]) from public, anon;
grant execute on function public.dispatch_units(uuid, uuid[]) to authenticated;
revoke all on function public.recall_units(uuid) from public, anon;
grant execute on function public.recall_units(uuid) to authenticated;
