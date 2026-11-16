-- =====================================================================
-- Frontline Command — Phase 7: specialists, factories, home front, convoys
-- Run after 006_leaderboards.sql. Safe to run more than once.
--
--   * Units can TRAIN into a specialty at a Training Center.
--   * Factories run timed PRODUCTION jobs; the output travels to your
--     Headquarters as a convoy (by sea when the route crosses water).
--   * Units can be TRANSFERRED between bases the same way.
--   * Every base is either on the FRONT LINE or the HOME FRONT. Enemy
--     contact only happens around front-line bases, and never close to a
--     home-front base.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New columns and tables
-- ---------------------------------------------------------------------
alter table public.building_types
  add column if not exists training_slots int  not null default 0,
  add column if not exists default_zone   text not null default 'front';

-- zone_rule: 'contact' = enemy contact (front line only, away from the home front)
--            'front'   = front-area work without contact (front line only)
--            'any'     = can happen anywhere (fires, traffic, supply)
alter table public.mission_types
  add column if not exists zone_rule text not null default 'contact'
      check (zone_rule in ('contact', 'front', 'any'));

alter table public.bases
  add column if not exists zone text not null default 'front' check (zone in ('front', 'home')),
  add column if not exists production_id      text,
  add column if not exists production_done_at timestamptz;

alter table public.units
  add column if not exists specialty          text,
  add column if not exists training_specialty text,
  add column if not exists transfer_base_id   uuid references public.bases (id) on delete set null;

-- Two new things a unit can be busy doing.
alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check
  check (status in ('idle', 'en_route', 'on_mission', 'returning', 'training', 'transferring'));

create table if not exists public.specialties (
  id               text primary key,
  name             text not null,
  icon             text not null,
  category_ids     jsonb not null,          -- which unit categories may train in it
  description      text not null default '',
  cost_money       bigint not null,
  cost_supplies    bigint not null default 0,
  training_seconds int not null,
  power_mult       numeric not null default 1,
  speed_mult       numeric not null default 1,
  base_power       numeric not null default 10,
  min_level        int not null default 1,
  names            jsonb not null default '{}',   -- per-nation display names
  sort             int not null default 0
);

create table if not exists public.products (
  id               text primary key,
  name             text not null,
  building_type    text not null references public.building_types (id),
  duration_seconds int not null,
  cost_money       bigint not null default 0,
  cost_supplies    bigint not null default 0,
  output_money     bigint not null default 0,
  output_supplies  bigint not null default 0,
  min_level        int not null default 1,
  sort             int not null default 0
);

-- Cargo on its way from a factory to the Headquarters.
create table if not exists public.shipments (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  label       text not null,
  from_lat    double precision not null,
  from_lng    double precision not null,
  to_lat      double precision not null,
  to_lng      double precision not null,
  by_sea      boolean not null default false,
  money       bigint not null default 0,
  supplies    bigint not null default 0,
  departed_at timestamptz not null,
  arrives_at  timestamptz not null
);
create index if not exists shipments_owner_idx on public.shipments (owner_id);

alter table public.specialties enable row level security;
alter table public.products    enable row level security;
alter table public.shipments   enable row level security;
drop policy if exists "readable by everyone" on public.specialties;
create policy "readable by everyone" on public.specialties for select using (true);
drop policy if exists "readable by everyone" on public.products;
create policy "readable by everyone" on public.products for select using (true);
drop policy if exists "players can read their own shipments" on public.shipments;
create policy "players can read their own shipments"
  on public.shipments for select using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------

-- New bases start in the zone that suits their building: factories and
-- training centers on the home front, everything else on the front line.
create or replace function public.fc_base_defaults()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  select default_zone into new.zone from public.building_types where id = new.building_type;
  new.zone := coalesce(new.zone, 'front');
  return new;
end;
$$;
drop trigger if exists bases_defaults on public.bases;
create trigger bases_defaults before insert on public.bases
  for each row execute function public.fc_base_defaults();

-- How long a convoy (cargo or transferring troops) takes between two points.
create or replace function public.fc_convoy_seconds(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns int language sql stable set search_path = public
as $$
  select greatest(public.fc_cfg('min_convoy_seconds'),
                  round(public.fc_distance_km(lat1, lng1, lat2, lng2)
                        / public.fc_cfg('convoy_speed_kmh') * 3600 / public.fc_cfg('convoy_time_scale')))::int;
$$;

-- Does the straight line between two points cross open water? (Checked at
-- nine points along the way.) Decides whether a convoy is drawn as a ship.
create or replace function public.fc_route_by_sea(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns boolean language sql stable set search_path = public
as $$
  select exists (select 1 from generate_series(1, 9) as i
                  where not public.fc_is_land(lat1 + (lat2 - lat1) * i / 10.0,
                                              lng1 + (lng2 - lng1) * i / 10.0));
$$;

-- ---------------------------------------------------------------------
-- 3. fc_sync_extras(): the timed things this phase adds. fc_sync() calls
--    it first on every check-in (see 004).
-- ---------------------------------------------------------------------
create or replace function public.fc_sync_extras(p_me uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_now  timestamptz := now();
  events jsonb := '[]'::jsonb;
  hq     public.bases;
  r      record;
begin
  perform 1 from public.profiles where id = p_me for update;
  if not found then return events; end if;

  -- (a) Training courses that have finished
  for r in
    update public.units u
       set specialty = training_specialty, training_specialty = null, status = 'idle', busy_until = null
     where u.owner_id = p_me and u.status = 'training' and u.busy_until <= v_now
    returning (select name from public.unit_types where id = u.unit_type) as unit_name,
              (select name from public.specialties where id = u.specialty) as specialty_name
  loop
    events := events || jsonb_build_object('type', 'training_done', 'unit', r.unit_name, 'specialty', r.specialty_name);
  end loop;

  -- (b) Transfers that have arrived at their new base
  for r in
    update public.units u
       set base_id = transfer_base_id, transfer_base_id = null, status = 'idle', busy_until = null
     where u.owner_id = p_me and u.status = 'transferring' and u.busy_until <= v_now
       and u.transfer_base_id is not null
    returning (select name from public.unit_types where id = u.unit_type) as unit_name,
              (select name from public.bases where id = u.base_id) as base_name
  loop
    events := events || jsonb_build_object('type', 'transfer_done', 'unit', r.unit_name, 'base', r.base_name);
  end loop;

  -- (c) Factory jobs that have finished: load the output onto a convoy bound
  --     for the Headquarters. The convoy leaves at the moment the job ended,
  --     even if that was hours ago while the player was offline.
  select b.* into hq from public.bases b
    join public.building_types t on t.id = b.building_type
   where b.owner_id = p_me and t.is_hq limit 1;

  for r in
    select b.id, b.lat, b.lng, b.level, b.production_done_at,
           p.name, p.output_money, p.output_supplies
      from public.bases b join public.products p on p.id = b.production_id
     where b.owner_id = p_me and b.production_done_at <= v_now
  loop
    insert into public.shipments
      (owner_id, label, from_lat, from_lng, to_lat, to_lng, by_sea, money, supplies, departed_at, arrives_at)
    values
      (p_me, r.name, r.lat, r.lng, coalesce(hq.lat, r.lat), coalesce(hq.lng, r.lng),
       hq.id is not null and public.fc_route_by_sea(r.lat, r.lng, hq.lat, hq.lng),
       r.output_money * r.level, r.output_supplies * r.level,
       r.production_done_at,
       r.production_done_at + make_interval(secs =>
         public.fc_convoy_seconds(r.lat, r.lng, coalesce(hq.lat, r.lat), coalesce(hq.lng, r.lng))));
    update public.bases set production_id = null, production_done_at = null where id = r.id;
    events := events || jsonb_build_object('type', 'production_done', 'name', r.name);
  end loop;

  -- (d) Convoys that have arrived: unload into the player's stocks
  for r in
    delete from public.shipments where owner_id = p_me and arrives_at <= v_now returning *
  loop
    update public.profiles set money = money + r.money, supplies = supplies + r.supplies where id = p_me;
    events := events || jsonb_build_object('type', 'shipment_arrived', 'name', r.label,
                                           'money', r.money, 'supplies', r.supplies);
  end loop;

  return events;
end;
$$;

-- The snapshot now also carries bases (their zone and production change)
-- and convoys.
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
    'bases', coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at)
                         from public.bases b where b.owner_id = p_me), '[]'),
    'units', coalesce((select jsonb_agg(to_jsonb(u) order by u.created_at)
                         from public.units u where u.owner_id = p_me), '[]'),
    'shipments', coalesce((select jsonb_agg(to_jsonb(s) order by s.arrives_at)
                             from public.shipments s where s.owner_id = p_me), '[]'),
    'missions', coalesce((
        select jsonb_agg(to_jsonb(v) || jsonb_build_object(
                 'owner_name', (select username from public.profiles where id = v.owner_id))
               order by v.spawned_at)
          from visible v), '[]'),
    'dispatches', coalesce((
        select jsonb_agg(to_jsonb(d) || jsonb_build_object(
                 'player_name', p.username, 'player_nation', p.nation_id, 'unit_name', ut.name,
                 'unit_category', ut.category_id)
               order by d.departed_at)
          from public.dispatches d
          join public.profiles p on p.id = d.player_id
          join public.units un on un.id = d.unit_id
          join public.unit_types ut on ut.id = un.unit_type
         where d.player_id = p_me or d.mission_id in (select id from visible)), '[]'));
$$;

-- ---------------------------------------------------------------------
-- 4. Player actions
-- ---------------------------------------------------------------------

-- Send a unit on a specialty course.
create or replace function public.train_unit(p_unit_id uuid, p_specialty text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  events jsonb;
  prof  public.profiles;
  unit  public.units;
  utype public.unit_types;
  spec  public.specialties;
  slots int;
  busy  int;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me for update;

  select * into unit from public.units where id = p_unit_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your units.'; end if;
  if unit.status <> 'idle' then raise exception 'Only units waiting at their base can start training.'; end if;
  select * into utype from public.unit_types where id = unit.unit_type;

  select * into spec from public.specialties where id = p_specialty;
  if not found then raise exception 'Unknown specialty.'; end if;
  if not (spec.category_ids ? utype.category_id) then
    raise exception '% cannot train as %.', utype.name, spec.name;
  end if;
  if unit.specialty = spec.id then raise exception 'This unit already holds that specialty.'; end if;
  if prof.level < spec.min_level then raise exception '% unlocks at level %.', spec.name, spec.min_level; end if;

  -- Each Training Center runs a few courses at once (more when upgraded).
  select coalesce(sum(t.training_slots * b.level), 0) into slots
    from public.bases b join public.building_types t on t.id = b.building_type
   where b.owner_id = me;
  if slots = 0 then raise exception 'Build a Training Center first.'; end if;
  select count(*) into busy from public.units where owner_id = me and status = 'training';
  if busy >= slots then raise exception 'All training places are taken (% of %).', busy, slots; end if;

  if prof.money < spec.cost_money or prof.supplies < spec.cost_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  update public.profiles set money = money - spec.cost_money, supplies = supplies - spec.cost_supplies
   where id = me;
  update public.units
     set status = 'training', training_specialty = spec.id,
         busy_until = now() + make_interval(secs => spec.training_seconds)
   where id = unit.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- Start a production job at a factory.
create or replace function public.start_production(p_base_id uuid, p_product text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  events jsonb;
  prof  public.profiles;
  base  public.bases;
  prod  public.products;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);            -- also clears a job that has just finished
  select * into prof from public.profiles where id = me for update;

  select * into base from public.bases where id = p_base_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your bases.'; end if;
  select * into prod from public.products where id = p_product;
  if not found or prod.building_type <> base.building_type then
    raise exception 'This building cannot produce that.';
  end if;
  if base.production_id is not null then raise exception 'This factory is already busy.'; end if;
  if prof.level < prod.min_level then raise exception '% unlocks at level %.', prod.name, prod.min_level; end if;
  -- A higher-level factory makes proportionally more, from proportionally more input.
  if prof.money < prod.cost_money * base.level or prof.supplies < prod.cost_supplies * base.level then
    raise exception 'Not enough funds or supplies.';
  end if;

  update public.profiles
     set money = money - prod.cost_money * base.level, supplies = supplies - prod.cost_supplies * base.level
   where id = me;
  update public.bases
     set production_id = prod.id, production_done_at = now() + make_interval(secs => prod.duration_seconds)
   where id = base.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- Move a unit to another of your bases.
create or replace function public.transfer_unit(p_unit_id uuid, p_base_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  events jsonb;
  unit   public.units;
  utype  public.unit_types;
  origin public.bases;
  dest   public.bases;
  dtype  public.building_types;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);

  select * into unit from public.units where id = p_unit_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your units.'; end if;
  if unit.status <> 'idle' then raise exception 'Only units waiting at their base can be transferred.'; end if;
  select * into utype from public.unit_types where id = unit.unit_type;
  select * into origin from public.bases where id = unit.base_id;

  select * into dest from public.bases where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  if dest.id = unit.base_id then raise exception 'The unit is already stationed there.'; end if;
  select * into dtype from public.building_types where id = dest.building_type;
  if not (dtype.unlocks_categories ? utype.category_id) then
    raise exception 'A % cannot station that kind of unit.', dtype.name;
  end if;
  -- Count units already there plus any still on their way.
  if (select count(*) from public.units
       where owner_id = me and (base_id = dest.id or transfer_base_id = dest.id))
     >= dtype.unit_capacity * dest.level then
    raise exception '% is full.', dest.name;
  end if;

  update public.units
     set status = 'transferring', transfer_base_id = dest.id,
         busy_until = now() + make_interval(secs =>
           public.fc_convoy_seconds(origin.lat, origin.lng, dest.lat, dest.lng))
   where id = unit.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- Declare a base front line or home front.
create or replace function public.set_base_zone(p_base_id uuid, p_zone text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if p_zone not in ('front', 'home') then raise exception 'Unknown zone.'; end if;
  update public.bases set zone = p_zone where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  return public.fc_snapshot(me, '[]');
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Dispatching, now with specialties
--    A mission requirement key can be a category ("infantry") or a
--    specialty ("airborne"). A specialist fills its specialty's place if
--    the mission has one free, otherwise an ordinary place of its category.
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

  for u in
    select un.id, un.status, un.specialty, ut.category_id, ut.name, ut.speed_kmh, ut.power, b.lat, b.lng,
           coalesce(sp.power_mult, 1) as sp_power, coalesce(sp.speed_mult, 1) as sp_speed
      from unnest(p_unit_ids) with ordinality as wanted(id, pos)
      left join public.units un on un.id = wanted.id and un.owner_id = me
      left join public.unit_types ut on ut.id = un.unit_type
      left join public.bases b on b.id = un.base_id
      left join public.specialties sp on sp.id = un.specialty
     order by wanted.pos
  loop
    if u.id is null then raise exception 'One of those units is not yours.'; end if;
    if u.status <> 'idle' then raise exception '% is not available.', u.name; end if;

    -- Which place on the mission does this unit take?
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

    travel := greatest(
      public.fc_cfg('min_travel_seconds'),
      round(public.fc_distance_km(u.lat, u.lng, mission.lat, mission.lng)
            / (u.speed_kmh * u.sp_speed
               * public.fc_nation_bonus(prof.nation_id, 'speed_mult', u.category_id)
               * (1 + public.fc_alliance_bonus(me, 'speed')))
            * 3600 / public.fc_cfg('travel_time_scale')));

    -- dispatches.category_id records the PLACE the unit fills (a category
    -- or a specialty), which is what the requirement counts look at.
    insert into public.dispatches
      (mission_id, unit_id, player_id, category_id, power, from_lat, from_lng,
       travel_seconds, departed_at, arrives_at)
    values
      (mission.id, u.id, me, slot,
       u.power * u.sp_power * public.fc_nation_bonus(prof.nation_id, 'power_mult', u.category_id),
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
-- 6. Spawning, now with zones and specialties
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
    anchor := null;

    -- Go through the missions this player could do, in weighted random
    -- order, and take the first one that has somewhere sensible to happen.
    for mtype in
      select t.*
        from public.mission_types t
       where t.min_level <= p_level
         and t.spawn_weight > 0          -- weight 0 = only ever created by the game itself
         and not exists (
               -- every requirement must be something the player can field:
               -- a category one of their buildings houses, or a specialty
               -- one of their units holds
               select 1 from jsonb_object_keys(t.requirements) as need(key)
                where not exists (
                        select 1 from public.bases b
                          join public.building_types bt on bt.id = b.building_type
                         where b.owner_id = p_me and bt.unlocks_categories ? need.key)
                  and not exists (
                        select 1 from public.units u
                         where u.owner_id = p_me and u.specialty = need.key))
       order by -ln(1 - random()) / t.spawn_weight
       limit 6
    loop
      -- Measure from a base that houses one of the unit types needed.
      -- Contact and front-area missions only happen around FRONT-LINE bases.
      select b.* into anchor
        from public.bases b
        join public.building_types bt on bt.id = b.building_type
       where b.owner_id = p_me
         and (mtype.zone_rule = 'any' or b.zone = 'front')
         and exists (select 1 from jsonb_object_keys(mtype.requirements) as need(key)
                      where bt.unlocks_categories ? need.key)
       order by random() limit 1;
      exit when found;
    end loop;

    exit when anchor.id is null;   -- nothing suitable (e.g. every base is on the home front)
    perform public.fc_spawn_mission(p_me, mtype.id, anchor.lat, anchor.lng, mtype.min_km, mtype.max_km);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_sync_extras(uuid) from public, anon, authenticated;
revoke all on function public.fc_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fc_spawn_mission(uuid, text, double precision, double precision, numeric, numeric, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fc_spawn_due_missions(uuid, int, int) from public, anon, authenticated;
revoke all on function public.fc_base_defaults() from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['train_unit(uuid, text)', 'start_production(uuid, text)',
                            'transfer_unit(uuid, uuid)', 'set_base_zone(uuid, text)',
                            'dispatch_units(uuid, uuid[])'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
