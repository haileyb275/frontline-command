-- =====================================================================
-- Frontline Command — Phase 12: real places, weather and night
-- Run after 011_research_ops_seasons.sql. Safe to run more than once.
--
--   * A player's browser surveys the real map around each base (bridges,
--     airfields, stations, towns, harbours — from OpenStreetMap) and files
--     what it finds. Missions tied to such a place then appear AT one.
--   * Weather and day/night are worked out from position and time alone,
--     so the server and every browser agree without storing anything.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Surveyed places
-- ---------------------------------------------------------------------
create table if not exists public.map_features (
  id       bigint generated always as identity primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  base_id  uuid not null references public.bases (id) on delete cascade,
  kind     text not null check (kind in ('bridge', 'airfield', 'rail', 'town', 'harbour')),
  name     text not null default '',
  lat      double precision not null,
  lng      double precision not null
);
create index if not exists map_features_owner_idx on public.map_features (owner_id, kind);
alter table public.map_features enable row level security;     -- functions only

alter table public.bases         add column if not exists scanned_at timestamptz;
alter table public.mission_types add column if not exists site text;       -- kind of place it belongs at
alter table public.missions      add column if not exists site_name text;  -- the real place it landed on
alter table public.unit_categories add column if not exists domain text not null default 'ground';

-- The browser files what it found around one base. This is a HINT only:
-- the server still decides which mission appears, checks the distance band
-- itself, and ignores anything implausible, so a doctored list gains nothing.
create or replace function public.submit_map_features(p_base_id uuid, p_features jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  base public.bases;
  n    int;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into base from public.bases where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  if jsonb_typeof(p_features) <> 'array' then raise exception 'Expected a list of places.'; end if;

  delete from public.map_features where base_id = base.id;
  insert into public.map_features (owner_id, base_id, kind, name, lat, lng)
  select me, base.id, f ->> 'kind',
         left(trim(regexp_replace(coalesce(f ->> 'name', ''), '[[:cntrl:]]', '', 'g')), 60),
         (f ->> 'lat')::double precision, (f ->> 'lng')::double precision
    from jsonb_array_elements(p_features) as f
   where f ->> 'kind' in ('bridge', 'airfield', 'rail', 'town', 'harbour')
     and (f ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (f ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
     -- only places genuinely in this base's neighbourhood
     and public.fc_distance_km(base.lat, base.lng, (f ->> 'lat')::double precision, (f ->> 'lng')::double precision) <= 160
   limit 200;
  get diagnostics n = row_count;

  update public.bases set scanned_at = now() where id = base.id;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Weather and night
-- ---------------------------------------------------------------------

-- The weather over a point at a moment: 'clear', 'overcast', 'rain' or
-- 'storm'. The world is cut into 2-degree squares and time into 3-hour
-- blocks; each square-and-block gets a number from simple whole-number
-- arithmetic, which src/game/weather.js repeats exactly.
create or replace function public.fc_weather(p_lat double precision, p_lng double precision, p_at timestamptz)
returns text language sql immutable
as $$
  with v as (
    select ((floor((p_lat + 90) / 2)::bigint * 7919
           + floor((p_lng + 180) / 2)::bigint * 104729
           + floor(extract(epoch from p_at) / 10800)::bigint * 1299709) % 1000) as n
  ), r as (select (n * n * 31 + n * 17 + 7) % 100 as roll from v)
  select case when roll < 55 then 'clear' when roll < 75 then 'overcast'
              when roll < 92 then 'rain' else 'storm' end from r;
$$;

-- Is it night at this longitude? (Local solar time: 15 degrees per hour.)
create or replace function public.fc_is_night(p_lng double precision, p_at timestamptz)
returns boolean language sql stable set search_path = public
as $$
  with h as (
    select mod((extract(epoch from p_at) / 3600 + p_lng / 15)::numeric + 2400, 24) as hour
  )
  select hour >= public.fc_cfg('night_start_hour') or hour < public.fc_cfg('night_end_hour') from h;
$$;

-- ---------------------------------------------------------------------
-- 3. Spawning at real places (revises the Phase 7 version)
-- ---------------------------------------------------------------------
create or replace function public.fc_spawn_mission(
  p_owner uuid, p_type text,
  p_lat double precision, p_lng double precision,
  p_min_km numeric, p_max_km numeric,
  p_parent uuid default null, p_alliance uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mtype public.mission_types;
  pt    record;
  ok    boolean;
  site  public.map_features;
begin
  select * into mtype from public.mission_types where id = p_type;
  if not found then return; end if;

  -- Missions tied to a kind of real place (a bridge, an airfield, a town…)
  -- first look for one the player's map survey has found in the right band.
  if mtype.site is not null and p_parent is null then
    select f.* into site
      from public.map_features f
     where f.owner_id = p_owner and f.kind = mtype.site
       and public.fc_distance_km(p_lat, p_lng, f.lat, f.lng) between p_min_km and p_max_km
       -- not on top of any of the player's bases
       and not exists (select 1 from public.bases b
                        where b.owner_id = p_owner
                          and public.fc_distance_km(b.lat, b.lng, f.lat, f.lng) < least(p_min_km, 3))
       -- enemy contact still keeps clear of the home front
       and (mtype.zone_rule <> 'contact' or not exists (
              select 1 from public.bases b
               where b.owner_id = p_owner and b.zone = 'home'
                 and public.fc_distance_km(b.lat, b.lng, f.lat, f.lng) < public.fc_cfg('home_safe_km')))
       -- and not where a mission is already waiting
       and not exists (select 1 from public.missions m
                        where m.owner_id = p_owner and m.status in ('open', 'in_progress')
                          and abs(m.lat - f.lat) < 0.002 and abs(m.lng - f.lng) < 0.002)
     order by random() limit 1;
    if found then
      insert into public.missions (mission_type, owner_id, alliance_id, lat, lng, expires_at, parent_mission_id, site_name)
      values (mtype.id, p_owner, case when mtype.shareable then p_alliance end, site.lat, site.lng,
              now() + make_interval(secs => mtype.expires_seconds), p_parent, nullif(site.name, ''));
      return;
    end if;
    -- No suitable real place nearby: fall through to a random spot as before.
  end if;

  for attempt in 1 .. 30 loop
    pt := public.fc_offset_point(p_lat, p_lng,
            p_min_km + random() * (p_max_km - p_min_km), random() * 2 * pi());

    ok := case mtype.terrain
            when 'land'  then public.fc_is_land(pt.lat, pt.lng)
            when 'water' then not public.fc_is_land(pt.lat, pt.lng)
            else true
          end;

    if ok and p_parent is null then
      ok := not exists (select 1 from public.bases b
                         where b.owner_id = p_owner
                           and public.fc_distance_km(b.lat, b.lng, pt.lat, pt.lng) < p_min_km);
    end if;

    -- Enemy contact never happens close to a home-front base.
    if ok and mtype.zone_rule = 'contact' then
      ok := not exists (select 1 from public.bases b
                         where b.owner_id = p_owner and b.zone = 'home'
                           and public.fc_distance_km(b.lat, b.lng, pt.lat, pt.lng)
                               < public.fc_cfg('home_safe_km'));
    end if;

    if ok then
      insert into public.missions (mission_type, owner_id, alliance_id, lat, lng, expires_at, parent_mission_id)
      values (mtype.id, p_owner, case when mtype.shareable then p_alliance end, pt.lat, pt.lng,
              now() + make_interval(secs => mtype.expires_seconds), p_parent);
      return;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Dispatching in weather and darkness (revises the Phase 8 version)
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
  slot    text;
  travel  int;
  all_met boolean;
  total_power numeric;
  ref_power   numeric;
  starts  timestamptz;
  weather text;
  night   boolean;
  slow    numeric;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then
    raise exception 'Select at least one unit.';
  end if;

  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me;
  select alliance_id into my_alliance from public.alliance_members where player_id = me;

  select * into mission from public.missions
   where id = p_mission_id
     and (owner_id = me or (alliance_id is not null and alliance_id = my_alliance))
     for update;
  if not found then raise exception 'Mission not found.'; end if;
  if mission.status <> 'open' then raise exception 'That mission is no longer open.'; end if;
  select * into mtype from public.mission_types where id = mission.mission_type;

  -- Conditions at the mission right now.
  weather := public.fc_weather(mission.lat, mission.lng, v_now);
  night   := public.fc_is_night(mission.lng, v_now);

  for u in
    select un.id, un.status, un.specialty, un.missions_done, ut.category_id, ut.name, ut.speed_kmh, ut.power,
           b.id as base_id, b.name as base_name, b.lat, b.lng, c.supply_use, c.domain,
           coalesce(sp.power_mult, 1) as sp_power, coalesce(sp.speed_mult, 1) as sp_speed
      from unnest(p_unit_ids) with ordinality as wanted(id, pos)
      left join public.units un on un.id = wanted.id and un.owner_id = me
      left join public.unit_types ut on ut.id = un.unit_type
      left join public.unit_categories c on c.id = ut.category_id
      left join public.bases b on b.id = un.base_id
      left join public.specialties sp on sp.id = un.specialty
     order by wanted.pos
  loop
    if u.id is null then raise exception 'One of those units is not yours.'; end if;
    if u.status <> 'idle' then raise exception '% is not available.', u.name; end if;

    slot := null;
    if u.specialty is not null
       and (select count(*) from public.dispatches
             where mission_id = mission.id and category_id = u.specialty and returns_at is null)
           < coalesce((mtype.requirements ->> u.specialty)::int, 0) then
      slot := u.specialty;
    elsif (select count(*) from public.dispatches
            where mission_id = mission.id and category_id = u.category_id and returns_at is null)
          < coalesce((mtype.requirements ->> u.category_id)::int, 0) then
      slot := u.category_id;
    end if;
    if slot is null then
      raise exception 'This mission does not need another % unit.',
        (select name from public.unit_categories where id = u.category_id);
    end if;

    -- Aircraft cannot fly into a storm; rain and storms slow everything
    -- that moves on the ground or at sea.
    if u.domain = 'air' and weather = 'storm' then
      raise exception 'Aircraft are grounded: there is a storm over the target area.';
    end if;
    slow := case when u.domain = 'air' then 1
                 when weather = 'storm' then public.fc_cfg('weather_storm_slow')
                 when weather = 'rain'  then public.fc_cfg('weather_rain_slow')
                 else 1 end;

    -- Fuel, rations and ammunition for the trip come out of the unit's own
    -- base. "stock >= use" in the WHERE makes this safe if two requests race.
    update public.bases set stock = stock - u.supply_use
     where id = u.base_id and coalesce(stock, 0) >= u.supply_use;
    if not found then
      raise exception '% is out of supplies. Resupply it before sending more units.', u.base_name;
    end if;

    travel := greatest(
      public.fc_cfg('min_travel_seconds'),
      round(public.fc_distance_km(u.lat, u.lng, mission.lat, mission.lng)
            / (u.speed_kmh * u.sp_speed
               * public.fc_nation_bonus(prof.nation_id, 'speed_mult', u.category_id)
               * (1 + public.fc_alliance_bonus(me, 'speed')))
            * 3600 / public.fc_cfg('travel_time_scale') * slow));

    insert into public.dispatches
      (mission_id, unit_id, player_id, category_id, power, from_lat, from_lng,
       travel_seconds, departed_at, arrives_at)
    values
      (mission.id, u.id, me, slot,
       u.power * u.sp_power
         * public.fc_nation_bonus(prof.nation_id, 'power_mult', u.category_id)
         * (1 + public.fc_cfg('veteran_power_step') * public.fc_veterancy(u.missions_done))
         -- After dark, scouts and commandos are in their element.
         * case when night and (u.category_id = 'recon' or u.specialty = 'commando')
                then 1 + public.fc_cfg('night_power_bonus') else 1 end,
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
    select sum(req.value::int * coalesce(c.base_power, s.base_power, 10)) into ref_power
      from jsonb_each_text(mtype.requirements) as req
      left join public.unit_categories c on c.id = req.key
      left join public.specialties s on s.id = req.key;

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

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid, uuid)
  from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['submit_map_features(uuid, jsonb)', 'dispatch_units(uuid, uuid[])'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
