-- =====================================================================
-- Frontline Command — Phase 5b: missions in sensible places
-- Run after 004_alliances.sql. Safe to run more than once.
--
--   * Every mission type has a TERRAIN: 'land', 'water' or 'any'.
--   * Every mission type has its own distance band (min_km … max_km), so
--     rear-area jobs appear close to your bases and enemy contact further out.
--   * Bases must stand on land; a Naval Base must be on the coast.
--
-- "Is this point land?" is answered by PostGIS (a Postgres add-on for map
-- shapes) using the coastline polygons loaded from supabase/land/*.sql.
-- =====================================================================

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------
-- 1. The land polygons (filled by `npm run land` → supabase/land/*.sql)
-- ---------------------------------------------------------------------
create table if not exists public.fc_land (
  id   bigint generated always as identity primary key,
  geom extensions.geometry(Geometry, 4326) not null
);
-- A spatial index: finds the few shapes near a point without scanning them all.
create index if not exists fc_land_geom_idx on public.fc_land using gist (geom);
alter table public.fc_land enable row level security;   -- no policies: server only

create or replace function public.fc_is_land(p_lat double precision, p_lng double precision)
returns boolean
language sql stable security definer set search_path = public, extensions
as $$
  select
    -- If the coastline data was never loaded, treat everywhere as land so
    -- the game still works (just without terrain awareness).
    not exists (select 1 from public.fc_land limit 1)
    or exists (select 1 from public.fc_land
                where ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)));
$$;

-- The point reached by travelling p_km from a start point on a compass bearing.
create or replace function public.fc_offset_point(
  p_lat double precision, p_lng double precision, p_km double precision, p_bearing double precision,
  out lat double precision, out lng double precision)
language plpgsql immutable
as $$
begin
  lat := greatest(-84, least(84, p_lat + p_km * cos(p_bearing) / 111.0));
  lng := p_lng + p_km * sin(p_bearing) / (111.0 * greatest(0.1, cos(radians(p_lat))));
  if lng > 180 then lng := lng - 360; end if;
  if lng < -180 then lng := lng + 360; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. New columns (values come from the JSON files via seed.sql)
-- ---------------------------------------------------------------------
alter table public.mission_types
  add column if not exists terrain text not null default 'land'
      check (terrain in ('land', 'water', 'any')),
  add column if not exists min_km numeric not null default 5,
  add column if not exists max_km numeric not null default 20;

alter table public.building_types
  add column if not exists requires_coast boolean not null default false;

-- ---------------------------------------------------------------------
-- 3. Where bases may be built
--    A trigger runs automatically before every insert into `bases`. If it
--    raises an exception the whole place_base() call is undone, including
--    the payment — so a rejected site costs nothing.
-- ---------------------------------------------------------------------
create or replace function public.fc_check_base_site()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  btype public.building_types;
  near_water boolean := false;
  pt record;
begin
  select * into btype from public.building_types where id = new.building_type;

  if not public.fc_is_land(new.lat, new.lng) then
    raise exception 'Bases must be built on land.';
  end if;

  if btype.requires_coast then
    -- "On the coast" = there is open water within 2 km in at least one of
    -- 12 compass directions.
    for i in 0 .. 11 loop
      pt := public.fc_offset_point(new.lat, new.lng, 2, i * pi() / 6);
      if not public.fc_is_land(pt.lat, pt.lng) then near_water := true; exit; end if;
    end loop;
    if not near_water then
      raise exception 'A % must be built on the coast (within 2 km of the sea).', btype.name;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists bases_check_site on public.bases;
create trigger bases_check_site
  before insert on public.bases
  for each row execute function public.fc_check_base_site();

-- ---------------------------------------------------------------------
-- 4. Placing a mission: try random spots until one fits the rules
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
begin
  select * into mtype from public.mission_types where id = p_type;
  if not found then return; end if;

  -- Up to 30 tries. If the neighbourhood simply has no suitable spot (a
  -- land mission on a tiny island, say) we give up quietly and no mission
  -- appears this time.
  for attempt in 1 .. 30 loop
    pt := public.fc_offset_point(p_lat, p_lng,
            p_min_km + random() * (p_max_km - p_min_km), random() * 2 * pi());

    ok := case mtype.terrain
            when 'land'  then public.fc_is_land(pt.lat, pt.lng)
            when 'water' then not public.fc_is_land(pt.lat, pt.lng)
            else true                       -- 'any': aircraft don't care
          end;

    -- Ordinary missions (not follow-ups) must also keep their minimum
    -- distance from EVERY base the player owns, not just the one we
    -- measured from — no enemy patrol on the HQ's doorstep.
    if ok and p_parent is null then
      ok := not exists (select 1 from public.bases b
                         where b.owner_id = p_owner
                           and public.fc_distance_km(b.lat, b.lng, pt.lat, pt.lng) < p_min_km);
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
-- 5. Choosing which missions to spawn, and around which base
-- ---------------------------------------------------------------------
create or replace function public.fc_spawn_due_missions(p_me uuid, p_level int, p_due int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  n_bases    int;
  max_open   int;
  open_now   int;
  mtype      public.mission_types;
  anchor     public.bases;
begin
  select count(*) into n_bases from public.bases where owner_id = p_me;
  max_open := least(public.fc_cfg('max_open_missions'),
                    public.fc_cfg('base_open_missions') + n_bases + p_level);
  select count(*) into open_now from public.missions where owner_id = p_me and status = 'open';

  for i in 1 .. greatest(0, least(p_due, max_open - open_now)) loop
    -- Weighted random pick among missions this player could actually do:
    -- high enough level, and every required category unlocked by a building
    -- they own.
    select t.* into mtype
      from public.mission_types t
     where t.min_level <= p_level
       and not exists (
             select 1 from jsonb_object_keys(t.requirements) as need(category)
              where not exists (
                      select 1 from public.bases b
                        join public.building_types bt on bt.id = b.building_type
                       where b.owner_id = p_me and bt.unlocks_categories ? need.category))
     order by -ln(1 - random()) / t.spawn_weight
     limit 1;
    exit when not found;

    -- Measure from a base that actually houses one of the unit types the
    -- mission needs: naval missions appear off your Naval Base, armored
    -- battles near your Tank Depot, and so on.
    select b.* into anchor
      from public.bases b
      join public.building_types bt on bt.id = b.building_type
     where b.owner_id = p_me
       and exists (select 1 from jsonb_object_keys(mtype.requirements) as need(category)
                    where bt.unlocks_categories ? need.category)
     order by random() limit 1;

    perform public.fc_spawn_mission(p_me, mtype.id, anchor.lat, anchor.lng, mtype.min_km, mtype.max_km);
  end loop;
end;
$$;

revoke all on function public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fc_spawn_due_missions(uuid, int, int) from public, anon, authenticated;
revoke all on function public.fc_check_base_site() from public, anon, authenticated;
