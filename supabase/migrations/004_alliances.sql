-- =====================================================================
-- Frontline Command — Phase 5: alliances, chat, shared missions, treasury
-- Run after 003_missions.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.alliances (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tag         text not null,                 -- short label, e.g. "1AD"
  description text not null default '',
  treasury    bigint not null default 0 check (treasury >= 0),
  xp          bigint not null default 0,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists alliances_name_idx on public.alliances (lower(name));
create unique index if not exists alliances_tag_idx  on public.alliances (upper(tag));

-- player_id is the primary key, so a player can be in ONE alliance at most.
-- There is no nation column and no nation check anywhere: any mix is allowed.
create table if not exists public.alliance_members (
  player_id     uuid primary key references public.profiles (id) on delete cascade,
  alliance_id   uuid not null references public.alliances (id) on delete cascade,
  role          text not null default 'member' check (role in ('leader', 'officer', 'member')),
  donated_total bigint not null default 0,
  joined_at     timestamptz not null default now()
);
create index if not exists alliance_members_alliance_idx on public.alliance_members (alliance_id);

create table if not exists public.alliance_messages (
  id            bigint generated always as identity primary key,
  alliance_id   uuid not null references public.alliances (id) on delete cascade,
  sender_id     uuid references public.profiles (id) on delete set null,  -- NULL = system message
  sender_name   text not null,     -- copied in by the server, so it can't be faked
  sender_nation text,
  body          text not null check (char_length(body) between 1 and 500),
  created_at    timestamptz not null default now()
);
create index if not exists alliance_messages_idx on public.alliance_messages (alliance_id, id desc);

create table if not exists public.alliance_building_types (
  id          text primary key,
  name        text not null,
  description text not null default '',
  cost        bigint not null,     -- treasury cost of level 1; level N costs N × this
  max_level   int not null default 5,
  bonus       jsonb not null,      -- {"type": "reward_money", "value": 0.02}  (per level)
  sort        int not null default 0
);

create table if not exists public.alliance_buildings (
  alliance_id   uuid not null references public.alliances (id) on delete cascade,
  building_type text not null references public.alliance_building_types (id),
  level         int not null default 1,
  primary key (alliance_id, building_type)
);

create table if not exists public.treasury_log (
  id          bigint generated always as identity primary key,
  alliance_id uuid not null references public.alliances (id) on delete cascade,
  player_name text not null,
  amount      bigint not null,     -- positive = paid in, negative = spent
  reason      text not null,
  created_at  timestamptz not null default now()
);

-- Rewards waiting to be collected. When a shared mission finishes, whoever's
-- browser notices first writes one row here per contributor; each player's
-- own next sync then moves their row into their profile. (Paying other
-- players' profiles directly would let two syncs block each other.)
create table if not exists public.mission_payouts (
  id           bigint generated always as identity primary key,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  mission_name text not null,
  kind         text not null default 'reward',   -- 'reward' or 'finder_bonus'
  money        bigint not null default 0,
  supplies     bigint not null default 0,
  xp           bigint not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists mission_payouts_player_idx on public.mission_payouts (player_id);

-- ---------------------------------------------------------------------
-- 2. Row-level security
-- ---------------------------------------------------------------------

-- "Which alliance am I in?" as a function, so the policies below can ask
-- without the alliance_members policy having to query itself.
create or replace function public.fc_my_alliance()
returns uuid language sql stable security definer set search_path = public
as $$ select alliance_id from public.alliance_members where player_id = auth.uid(); $$;

alter table public.alliances               enable row level security;
alter table public.alliance_members        enable row level security;
alter table public.alliance_messages       enable row level security;
alter table public.alliance_building_types enable row level security;
alter table public.alliance_buildings      enable row level security;
alter table public.treasury_log            enable row level security;
alter table public.mission_payouts         enable row level security;  -- no policies: server only

drop policy if exists "alliances are listed for logged-in players" on public.alliances;
create policy "alliances are listed for logged-in players"
  on public.alliances for select to authenticated using (true);

drop policy if exists "members can see their alliance's members" on public.alliance_members;
create policy "members can see their alliance's members"
  on public.alliance_members for select using (alliance_id = public.fc_my_alliance());

drop policy if exists "members can read their alliance's chat" on public.alliance_messages;
create policy "members can read their alliance's chat"
  on public.alliance_messages for select using (alliance_id = public.fc_my_alliance());

drop policy if exists "readable by everyone" on public.alliance_building_types;
create policy "readable by everyone" on public.alliance_building_types for select using (true);

drop policy if exists "members can see their alliance's buildings" on public.alliance_buildings;
create policy "members can see their alliance's buildings"
  on public.alliance_buildings for select using (alliance_id = public.fc_my_alliance());

drop policy if exists "members can see their alliance's treasury log" on public.treasury_log;
create policy "members can see their alliance's treasury log"
  on public.treasury_log for select using (alliance_id = public.fc_my_alliance());

-- Shared missions (and the units on them) are visible to the whole alliance.
drop policy if exists "members can read shared missions" on public.missions;
create policy "members can read shared missions"
  on public.missions for select
  using (alliance_id is not null and alliance_id = public.fc_my_alliance());

drop policy if exists "members can read dispatches on shared missions" on public.dispatches;
create policy "members can read dispatches on shared missions"
  on public.dispatches for select
  using (exists (select 1 from public.missions m
                  where m.id = mission_id
                    and m.alliance_id is not null
                    and m.alliance_id = public.fc_my_alliance()));

-- Realtime: let Supabase push changes on these tables to subscribed browsers
-- (it still applies the policies above, so players only receive their own).
do $$
declare t text;
begin
  foreach t in array array['alliance_messages', 'alliance_members', 'alliance_buildings',
                           'alliances', 'missions', 'dispatches'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------

-- Total alliance-building bonus of one type for a player (0 = none).
--   fc_alliance_bonus(me, 'reward_money') → 0.06 with a level-3 Supply Exchange
create or replace function public.fc_alliance_bonus(p_player uuid, p_type text)
returns numeric language sql stable security definer set search_path = public
as $$
  select coalesce(sum(b.level * (t.bonus ->> 'value')::numeric), 0)
    from public.alliance_members am
    join public.alliance_buildings b on b.alliance_id = am.alliance_id
    join public.alliance_building_types t on t.id = b.building_type
   where am.player_id = p_player and t.bonus ->> 'type' = p_type;
$$;

-- Post a grey "system" line in an alliance's chat.
create or replace function public.fc_system_message(p_alliance uuid, p_body text)
returns void language sql security definer set search_path = public
as $$
  insert into public.alliance_messages (alliance_id, sender_id, sender_name, body)
  values (p_alliance, null, 'System', left(p_body, 500));
$$;

-- fc_spawn_mission gains an optional alliance parameter (for follow-ups of
-- shared missions). The old 7-argument version is replaced.
drop function if exists public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid);
create or replace function public.fc_spawn_mission(
  p_owner uuid, p_type text,
  p_lat double precision, p_lng double precision,
  p_min_km numeric, p_max_km numeric,
  p_parent uuid default null, p_alliance uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  dist    double precision := p_min_km + random() * (p_max_km - p_min_km);
  bearing double precision := random() * 2 * pi();
  new_lat double precision;
  new_lng double precision;
begin
  new_lat := greatest(-84, least(84, p_lat + dist * cos(bearing) / 111.0));
  new_lng := p_lng + dist * sin(bearing) / (111.0 * greatest(0.1, cos(radians(p_lat))));
  if new_lng > 180 then new_lng := new_lng - 360; end if;
  if new_lng < -180 then new_lng := new_lng + 360; end if;

  insert into public.missions (mission_type, owner_id, alliance_id, lat, lng, expires_at, parent_mission_id)
  select t.id, p_owner, case when t.shareable then p_alliance end, new_lat, new_lng,
         now() + make_interval(secs => t.expires_seconds), p_parent
    from public.mission_types t where t.id = p_type;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. fc_sync(), now aware of shared missions
-- ---------------------------------------------------------------------
create or replace function public.fc_sync(p_me uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_now  timestamptz := now();
  prof   public.profiles;
  my_alliance uuid;
  events jsonb := '[]'::jsonb;
  m      record;
  po     record;
  f      jsonb;
  total_power numeric;
  pool_money  bigint;
  cut         bigint;
  finder      bigint;
  gain_money    bigint;
  gain_supplies bigint;
  gain_xp       bigint;
  new_level  int;
  n_bases    int;
  due        int;
  max_open   int;
  open_now   int;
  spawn_type text;
  spawn_base public.bases;
begin
  select * into prof from public.profiles where id = p_me for update;
  if not found or prof.nation_id is null then return events; end if;
  select alliance_id into my_alliance from public.alliance_members where player_id = p_me;

  -- ---- (a) Finish missions whose timer has run out.
  -- "Mine" now means: I own it, OR it is shared with my alliance, OR I have
  -- units on it. Any member's browser can settle a shared mission.
  for m in
    select ms.id, ms.owner_id, ms.alliance_id, ms.lat, ms.lng, ms.completes_at,
           t.name, t.reward_money, t.reward_supplies, t.reward_xp, t.followups
      from public.missions ms
      join public.mission_types t on t.id = ms.mission_type
     where ms.status = 'in_progress' and ms.completes_at <= v_now
       and (ms.owner_id = p_me
            or (ms.alliance_id is not null and ms.alliance_id = my_alliance)
            or exists (select 1 from public.dispatches d
                        where d.mission_id = ms.id and d.player_id = p_me))
     order by ms.completes_at
  loop
    -- Two members may sync at the same instant. Whoever gets this UPDATE in
    -- first wins; the other finds 0 rows changed and skips the mission, so
    -- rewards are only ever created once.
    update public.missions set status = 'completed', completed_at = m.completes_at
     where id = m.id and status = 'in_progress';
    if not found then continue; end if;

    select coalesce(sum(power), 0) into total_power
      from public.dispatches where mission_id = m.id and returns_at is null;

    pool_money := m.reward_money;
    if m.alliance_id is not null then
      -- Shared mission: a slice for the treasury, a finder's bonus for
      -- whoever shared it, and the rest split by contribution.
      cut    := round(pool_money * public.fc_cfg('alliance_treasury_cut'));
      finder := round(pool_money * public.fc_cfg('alliance_owner_bonus'));
      pool_money := pool_money - cut - finder;

      update public.alliances set treasury = treasury + cut, xp = xp + m.reward_xp
       where id = m.alliance_id;
      insert into public.mission_payouts (player_id, mission_name, kind, money)
      values (m.owner_id, m.name, 'finder_bonus', finder);
    end if;

    -- One payout per contributing player, in proportion to the combined
    -- power of the units they sent.
    if total_power > 0 then
      insert into public.mission_payouts (player_id, mission_name, money, supplies, xp)
      select d.player_id, m.name,
             round(pool_money        * sum(d.power) / total_power),
             round(m.reward_supplies * sum(d.power) / total_power),
             greatest(1, round(m.reward_xp * sum(d.power) / total_power))
        from public.dispatches d
       where d.mission_id = m.id and d.returns_at is null
       group by d.player_id;
    end if;

    update public.dispatches
       set returns_at = m.completes_at + make_interval(secs => travel_seconds)
     where mission_id = m.id and returns_at is null;

    for f in select * from jsonb_array_elements(m.followups) loop
      if random() < (f ->> 'chance')::numeric then
        perform public.fc_spawn_mission(m.owner_id, f ->> 'mission', m.lat, m.lng, 1, 4, m.id, m.alliance_id);
        if m.owner_id = p_me then
          events := events || jsonb_build_object('type', 'followup',
            'name', (select name from public.mission_types where id = f ->> 'mission'));
        end if;
      end if;
    end loop;
  end loop;

  -- ---- (a2) Collect the payouts waiting for me (from missions settled just
  -- now, or earlier by an alliance mate while I was offline). My own nation
  -- and alliance bonuses are applied here.
  for po in delete from public.mission_payouts where player_id = p_me returning * loop
    gain_money := round(po.money
                        * public.fc_nation_bonus(prof.nation_id, 'reward_mult', 'money')
                        * (1 + public.fc_alliance_bonus(p_me, 'reward_money')));
    gain_supplies := round(po.supplies * public.fc_nation_bonus(prof.nation_id, 'reward_mult', 'supplies'));
    gain_xp := round(po.xp * (1 + public.fc_alliance_bonus(p_me, 'reward_xp')));

    prof.money    := prof.money + gain_money;
    prof.supplies := prof.supplies + gain_supplies;
    prof.xp       := prof.xp + gain_xp;

    if po.kind = 'finder_bonus' then
      events := events || jsonb_build_object('type', 'finder_bonus', 'name', po.mission_name, 'money', gain_money);
    else
      prof.missions_completed := prof.missions_completed + 1;
      events := events || jsonb_build_object('type', 'mission_completed', 'name', po.mission_name,
        'money', gain_money, 'supplies', gain_supplies, 'xp', gain_xp);
    end if;
  end loop;

  new_level := public.fc_level_for_xp(prof.xp);
  if new_level > prof.level then
    prof.level := new_level;
    events := events || jsonb_build_object('type', 'level_up', 'level', new_level);
  end if;

  -- ---- (b) Expire open missions nobody completed in time
  for m in
    select ms.id, ms.expires_at from public.missions ms
     where ms.status = 'open' and ms.expires_at <= v_now
       and (ms.owner_id = p_me
            or (ms.alliance_id is not null and ms.alliance_id = my_alliance)
            or exists (select 1 from public.dispatches d
                        where d.mission_id = ms.id and d.player_id = p_me))
  loop
    update public.missions set status = 'expired' where id = m.id and status = 'open';
    if not found then continue; end if;
    update public.dispatches
       set returns_at = m.expires_at + make_interval(
             secs => least(travel_seconds, extract(epoch from m.expires_at - departed_at)))
     where mission_id = m.id and returns_at is null;
  end loop;

  -- ---- (c) Bring my units' status labels up to date
  update public.units u
     set status = case when d.returns_at is not null then 'returning'
                       when d.arrives_at <= v_now    then 'on_mission'
                       else 'en_route' end,
         busy_until = d.returns_at
    from public.dispatches d
   where d.unit_id = u.id and d.player_id = p_me;

  -- ---- (d) My units that have made it home are free again
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

  if prof.missions_completed = 0
     and not exists (select 1 from public.missions where owner_id = p_me) then
    due := greatest(due, 2);
  end if;

  if n_bases > 0 and due > 0 then
    max_open := least(public.fc_cfg('max_open_missions'),
                      public.fc_cfg('base_open_missions') + n_bases + prof.level);
    select count(*) into open_now from public.missions where owner_id = p_me and status = 'open';

    for i in 1 .. greatest(0, least(due, max_open - open_now)) loop
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

-- The snapshot now includes shared missions and every unit on them, with
-- the names needed to show "who has units en route".
create or replace function public.fc_snapshot(p_me uuid, p_events jsonb default '[]')
returns jsonb
language sql security definer set search_path = public
as $$
  with my as (
    select (select alliance_id from public.alliance_members where player_id = p_me) as alliance_id
  ),
  visible as (
    select m.* from public.missions m, my
     where m.status in ('open', 'in_progress')
       and (m.owner_id = p_me
            or (m.alliance_id is not null and m.alliance_id = my.alliance_id)
            or exists (select 1 from public.dispatches d where d.mission_id = m.id and d.player_id = p_me))
  )
  select jsonb_build_object(
    'server_time', now(),
    'events', p_events,
    'alliance_id', (select alliance_id from my),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = p_me),
    'units', coalesce((select jsonb_agg(to_jsonb(u) order by u.created_at)
                         from public.units u where u.owner_id = p_me), '[]'),
    'missions', coalesce((
        select jsonb_agg(to_jsonb(v) || jsonb_build_object(
                 'owner_name', (select username from public.profiles where id = v.owner_id))
               order by v.spawned_at)
          from visible v), '[]'),
    'dispatches', coalesce((
        select jsonb_agg(to_jsonb(d) || jsonb_build_object(
                 'player_name', p.username, 'player_nation', p.nation_id, 'unit_name', ut.name)
               order by d.departed_at)
          from public.dispatches d
          join public.profiles p on p.id = d.player_id
          join public.units un on un.id = d.unit_id
          join public.unit_types ut on ut.id = un.unit_type
         where d.player_id = p_me or d.mission_id in (select id from visible)), '[]'));
$$;

-- ---------------------------------------------------------------------
-- 5. Dispatch and recall, now allowing alliance missions
-- ---------------------------------------------------------------------
create or replace function public.dispatch_units(p_mission_id uuid, p_unit_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me      uuid := auth.uid();
  v_now   timestamptz := now();
  events  jsonb;
  prof    public.profiles;
  my_alliance uuid;
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

  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me;
  select alliance_id into my_alliance from public.alliance_members where player_id = me;

  -- My own mission, or one shared with my alliance. "for update" makes two
  -- members dispatching at the same moment take turns, so a mission can
  -- never end up with more units of a category than it needs.
  select * into mission from public.missions
   where id = p_mission_id
     and (owner_id = me or (alliance_id is not null and alliance_id = my_alliance))
     for update;
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

    needed := coalesce((mtype.requirements ->> u.category_id)::int, 0);
    select count(*) into sent from public.dispatches
     where mission_id = mission.id and category_id = u.category_id and returns_at is null;
    if sent >= needed then
      raise exception 'This mission does not need another % unit.',
        (select name from public.unit_categories where id = u.category_id);
    end if;

    travel := greatest(
      public.fc_cfg('min_travel_seconds'),
      round(public.fc_distance_km(u.lat, u.lng, mission.lat, mission.lng)
            / (u.speed_kmh
               * public.fc_nation_bonus(prof.nation_id, 'speed_mult', u.category_id)
               * (1 + public.fc_alliance_bonus(me, 'speed')))
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

  select bool_and(
           (select count(*) from public.dispatches d
             where d.mission_id = mission.id and d.category_id = req.key and d.returns_at is null)
           >= req.value::int)
    into all_met
    from jsonb_each_text(mtype.requirements) as req;

  if all_met then
    select max(arrives_at), sum(power) into starts, total_power
      from public.dispatches where mission_id = mission.id and returns_at is null;
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

  -- Any mission I have units on (mine or an ally's), as long as it hasn't started.
  if not exists (select 1 from public.missions where id = p_mission_id and status = 'open')
     or not exists (select 1 from public.dispatches
                     where mission_id = p_mission_id and player_id = me and returns_at is null) then
    raise exception 'Units can only be recalled before a mission starts.';
  end if;

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

-- Offer one of my missions to the whole alliance.
create or replace function public.share_mission(p_mission_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  my_alliance uuid;
  mission public.missions;
  mtype public.mission_types;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select alliance_id into my_alliance from public.alliance_members where player_id = me;
  if my_alliance is null then raise exception 'Join an alliance first.'; end if;

  select * into mission from public.missions where id = p_mission_id and owner_id = me for update;
  if not found then raise exception 'Mission not found.'; end if;
  if mission.status <> 'open' then raise exception 'Only missions that have not started can be shared.'; end if;
  if mission.alliance_id is not null then raise exception 'That mission is already shared.'; end if;

  select * into mtype from public.mission_types where id = mission.mission_type;
  if not mtype.shareable then raise exception 'Only large operations can be shared.'; end if;

  update public.missions set alliance_id = my_alliance where id = mission.id;
  perform public.fc_system_message(my_alliance,
    (select username from public.profiles where id = me) || ' shared a mission: ' || mtype.name);

  return public.fc_snapshot(me, '[]');
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Alliance management
-- ---------------------------------------------------------------------
create or replace function public.create_alliance(p_name text, p_tag text, p_description text default '')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  v_name text := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_tag  text := upper(trim(coalesce(p_tag, '')));
  cost   bigint := public.fc_cfg('alliance_create_cost');
  new_id uuid;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;
  if prof.nation_id is null then raise exception 'Choose a nation first.'; end if;
  if exists (select 1 from public.alliance_members where player_id = me) then
    raise exception 'You are already in an alliance.';
  end if;
  if v_name !~ '^[[:alnum:]][[:alnum:] ''\.\-]{2,29}$' then
    raise exception 'Alliance name must be 3–30 letters, numbers or spaces.';
  end if;
  if v_tag !~ '^[A-Z0-9]{2,5}$' then
    raise exception 'Tag must be 2–5 letters or numbers.';
  end if;
  if exists (select 1 from public.alliances where lower(name) = lower(v_name)) then
    raise exception 'That alliance name is taken.';
  end if;
  if exists (select 1 from public.alliances where upper(tag) = v_tag) then
    raise exception 'That tag is taken.';
  end if;
  if prof.money < cost then
    raise exception 'Founding an alliance costs % funds.', cost;
  end if;

  update public.profiles set money = money - cost where id = me;
  insert into public.alliances (name, tag, description, created_by)
  values (v_name, v_tag, left(trim(regexp_replace(coalesce(p_description, ''), '[[:cntrl:]]', ' ', 'g')), 200), me)
  returning id into new_id;
  insert into public.alliance_members (player_id, alliance_id, role) values (me, new_id, 'leader');
  perform public.fc_system_message(new_id, prof.username || ' founded the alliance.');
  return new_id;
end;
$$;

create or replace function public.join_alliance(p_alliance_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  cap  int;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me;
  if prof.nation_id is null then raise exception 'Choose a nation first.'; end if;
  if exists (select 1 from public.alliance_members where player_id = me) then
    raise exception 'You are already in an alliance.';
  end if;

  -- Lock the alliance row so two people can't take the last place at once.
  perform 1 from public.alliances where id = p_alliance_id for update;
  if not found then raise exception 'Alliance not found.'; end if;

  cap := public.fc_cfg('alliance_base_members')
         + coalesce((select b.level * (t.bonus ->> 'value')::numeric
                       from public.alliance_buildings b
                       join public.alliance_building_types t on t.id = b.building_type
                      where b.alliance_id = p_alliance_id and t.bonus ->> 'type' = 'member_cap'), 0);
  if (select count(*) from public.alliance_members where alliance_id = p_alliance_id) >= cap then
    raise exception 'That alliance is full.';
  end if;

  insert into public.alliance_members (player_id, alliance_id) values (me, p_alliance_id);
  perform public.fc_system_message(p_alliance_id, prof.username || ' joined the alliance.');
end;
$$;

-- Shared by leave and kick: take a player out, tidy up after them.
create or replace function public.fc_remove_member(p_player uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mem  public.alliance_members;
  heir uuid;
begin
  select * into mem from public.alliance_members where player_id = p_player;
  if not found then raise exception 'Not in an alliance.'; end if;

  -- Keeps things simple: nobody leaves with units still out on other
  -- members' missions.
  if exists (select 1 from public.dispatches d
               join public.missions m on m.id = d.mission_id
              where d.player_id = p_player and m.owner_id <> p_player) then
    raise exception 'Units are still deployed on alliance missions. Wait for them to return first.';
  end if;

  -- Missions this player shared go back to being private.
  update public.missions set alliance_id = null
   where owner_id = p_player and alliance_id = mem.alliance_id and status = 'open'
     and not exists (select 1 from public.dispatches d
                      where d.mission_id = missions.id and d.player_id <> p_player);

  delete from public.alliance_members where player_id = p_player;

  if not exists (select 1 from public.alliance_members where alliance_id = mem.alliance_id) then
    -- Last one out: the alliance is disbanded.
    update public.missions set alliance_id = null where alliance_id = mem.alliance_id;
    delete from public.alliances where id = mem.alliance_id;
    return;
  end if;

  if mem.role = 'leader' then
    -- Hand leadership to the longest-serving officer, else member.
    select player_id into heir from public.alliance_members
     where alliance_id = mem.alliance_id
     order by (role = 'officer') desc, joined_at limit 1;
    update public.alliance_members set role = 'leader' where player_id = heir;
    perform public.fc_system_message(mem.alliance_id,
      (select username from public.profiles where id = heir) || ' is the new leader.');
  end if;

  perform public.fc_system_message(mem.alliance_id,
    (select username from public.profiles where id = p_player) || ' ' || p_reason);
end;
$$;

create or replace function public.leave_alliance()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_remove_member(auth.uid(), 'left the alliance.');
end;
$$;

create or replace function public.kick_member(p_player_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  mine   public.alliance_members;
  theirs public.alliance_members;
begin
  select * into mine   from public.alliance_members where player_id = me;
  select * into theirs from public.alliance_members where player_id = p_player_id;
  if mine.alliance_id is null or theirs.alliance_id is distinct from mine.alliance_id then
    raise exception 'That player is not in your alliance.';
  end if;
  if p_player_id = me then raise exception 'Use Leave instead.'; end if;
  -- Leaders can remove anyone; officers can remove ordinary members.
  if not (mine.role = 'leader' or (mine.role = 'officer' and theirs.role = 'member')) then
    raise exception 'You do not have permission to remove that member.';
  end if;
  perform public.fc_remove_member(p_player_id, 'was removed from the alliance.');
end;
$$;

create or replace function public.set_member_role(p_player_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  mine   public.alliance_members;
  theirs public.alliance_members;
begin
  select * into mine   from public.alliance_members where player_id = me;
  select * into theirs from public.alliance_members where player_id = p_player_id;
  if mine.role is distinct from 'leader' then raise exception 'Only the leader can change roles.'; end if;
  if theirs.alliance_id is distinct from mine.alliance_id or p_player_id = me then
    raise exception 'Choose another member of your alliance.';
  end if;
  if p_role not in ('leader', 'officer', 'member') then raise exception 'Unknown role.'; end if;

  if p_role = 'leader' then
    -- Handing over command: the old leader steps down to officer.
    update public.alliance_members set role = 'officer' where player_id = me;
  end if;
  update public.alliance_members set role = p_role where player_id = p_player_id;

  perform public.fc_system_message(mine.alliance_id,
    (select username from public.profiles where id = p_player_id) || ' is now ' ||
    case p_role when 'leader' then 'the leader.' when 'officer' then 'an officer.' else 'a member.' end);
end;
$$;

create or replace function public.donate_to_treasury(p_amount bigint)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  my_alliance uuid;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;
  select alliance_id into my_alliance from public.alliance_members where player_id = me;
  if my_alliance is null then raise exception 'Join an alliance first.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero.'; end if;
  if p_amount > prof.money then raise exception 'You do not have that much.'; end if;

  update public.profiles set money = money - p_amount where id = me returning * into prof;
  update public.alliances set treasury = treasury + p_amount where id = my_alliance;
  update public.alliance_members set donated_total = donated_total + p_amount where player_id = me;
  insert into public.treasury_log (alliance_id, player_name, amount, reason)
  values (my_alliance, prof.username, p_amount, 'Donation');
  return prof;
end;
$$;

create or replace function public.build_alliance_building(p_building_type text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  mine  public.alliance_members;
  btype public.alliance_building_types;
  al    public.alliances;
  current_level int;
  price bigint;
begin
  select * into mine from public.alliance_members where player_id = me;
  if mine.alliance_id is null then raise exception 'Join an alliance first.'; end if;
  if mine.role not in ('leader', 'officer') then
    raise exception 'Only the leader and officers can spend the treasury.';
  end if;
  select * into btype from public.alliance_building_types where id = p_building_type;
  if not found then raise exception 'Unknown building.'; end if;

  select * into al from public.alliances where id = mine.alliance_id for update;
  select coalesce(max(level), 0) into current_level from public.alliance_buildings
   where alliance_id = al.id and building_type = btype.id;
  if current_level >= btype.max_level then raise exception '% is already at its maximum level.', btype.name; end if;

  price := btype.cost * (current_level + 1);
  if al.treasury < price then raise exception 'The treasury needs % funds for this.', price; end if;

  update public.alliances set treasury = treasury - price where id = al.id;
  insert into public.alliance_buildings (alliance_id, building_type, level)
  values (al.id, btype.id, 1)
  on conflict (alliance_id, building_type) do update set level = alliance_buildings.level + 1;
  insert into public.treasury_log (alliance_id, player_name, amount, reason)
  values (al.id, (select username from public.profiles where id = me), -price,
          btype.name || ' level ' || (current_level + 1));
  perform public.fc_system_message(al.id, btype.name || ' is now level ' || (current_level + 1) || '.');
end;
$$;

create or replace function public.send_alliance_message(p_body text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  my_alliance uuid;
  v_body text := trim(regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]+', ' ', 'g'));
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select alliance_id into my_alliance from public.alliance_members where player_id = me;
  if my_alliance is null then raise exception 'Join an alliance first.'; end if;
  if v_body = '' then raise exception 'Type a message first.'; end if;
  if char_length(v_body) > 500 then raise exception 'Messages can be up to 500 characters.'; end if;
  -- A simple brake on spam: one message per second per player.
  if exists (select 1 from public.alliance_messages
              where sender_id = me and created_at > now() - interval '1 second') then
    raise exception 'You are sending messages too quickly.';
  end if;

  select * into prof from public.profiles where id = me;
  insert into public.alliance_messages (alliance_id, sender_id, sender_name, sender_nation, body)
  values (my_alliance, me, prof.username, prof.nation_id, v_body);
end;
$$;

-- Everything the Alliance tab needs, in one call.
create or replace function public.get_my_alliance()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when am.alliance_id is null then null else jsonb_build_object(
    'info', to_jsonb(a),
    'my_role', am.role,
    'member_cap', public.fc_cfg('alliance_base_members')
        + coalesce((select b.level * (t.bonus ->> 'value')::numeric
                      from public.alliance_buildings b
                      join public.alliance_building_types t on t.id = b.building_type
                     where b.alliance_id = a.id and t.bonus ->> 'type' = 'member_cap'), 0),
    'members', (select jsonb_agg(jsonb_build_object(
                    'player_id', m.player_id, 'role', m.role, 'donated_total', m.donated_total,
                    'joined_at', m.joined_at, 'username', p.username, 'nation_id', p.nation_id,
                    'level', p.level, 'last_seen_at', p.last_seen_at)
                  order by array_position(array['leader', 'officer', 'member'], m.role), p.username)
                  from public.alliance_members m
                  join public.profiles p on p.id = m.player_id
                 where m.alliance_id = a.id),
    'buildings', coalesce((select jsonb_object_agg(b.building_type, b.level)
                             from public.alliance_buildings b where b.alliance_id = a.id), '{}'),
    'messages', coalesce((select jsonb_agg(to_jsonb(x) order by x.id)
                            from (select * from public.alliance_messages
                                   where alliance_id = a.id order by id desc limit 60) x), '[]'),
    'log', coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc)
                       from (select * from public.treasury_log
                              where alliance_id = a.id order by id desc limit 15) x), '[]')
  ) end
  from (select auth.uid() as uid) me
  left join public.alliance_members am on am.player_id = me.uid
  left join public.alliances a on a.id = am.alliance_id;
$$;

-- The list of alliances to browse, with member counts.
create or replace function public.list_alliances()
returns table (id uuid, name text, tag text, description text, members bigint, xp bigint)
language sql stable security definer set search_path = public
as $$
  select a.id, a.name, a.tag, a.description,
         (select count(*) from public.alliance_members m where m.alliance_id = a.id), a.xp
    from public.alliances a
   order by 5 desc, a.created_at
   limit 100;
$$;

-- ---------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_sync(uuid) from public, anon, authenticated;
revoke all on function public.fc_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fc_system_message(uuid, text) from public, anon, authenticated;
revoke all on function public.fc_remove_member(uuid, text) from public, anon, authenticated;
revoke all on function public.fc_alliance_bonus(uuid, text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'dispatch_units(uuid, uuid[])', 'recall_units(uuid)', 'share_mission(uuid)',
    'create_alliance(text, text, text)', 'join_alliance(uuid)', 'leave_alliance()',
    'kick_member(uuid)', 'set_member_role(uuid, text)', 'donate_to_treasury(bigint)',
    'build_alliance_building(text)', 'send_alliance_message(text)',
    'get_my_alliance()', 'list_alliances()'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
