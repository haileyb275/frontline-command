-- =====================================================================
-- Frontline Command — Phase 8: experience, repairs, base supplies, escorts
-- Run after 007_specialists.sql. Safe to run more than once.
--
--   * Units gain EXPERIENCE from missions and hit harder as veterans.
--   * Units can come back DAMAGED and need time to recover. Field
--     Hospitals (people) and Supply Depots (vehicles) shorten it.
--   * Every base that houses units holds a STOCK of supplies. Sending a
--     unit out draws on it; convoys from the Headquarters refill it.
--   * Sea convoys carrying factory output can be THREATENED; escort them
--     with naval units or lose part of the cargo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.unit_categories
  add column if not exists supply_use  int  not null default 2,
  add column if not exists recovers_at text;          -- building type that speeds recovery

alter table public.building_types
  add column if not exists stock_capacity int not null default 0;   -- per base level

alter table public.bases
  add column if not exists stock         int,
  add column if not exists auto_resupply boolean not null default true;

alter table public.units
  add column if not exists missions_done int not null default 0,
  add column if not exists repair_until  timestamptz;

alter table public.units
  add column if not exists scout_mission_id uuid,
  add column if not exists scout_arrives_at timestamptz;

alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check
  check (status in ('idle', 'en_route', 'on_mission', 'returning', 'training', 'transferring', 'repairing', 'scouting'));

alter table public.shipments
  add column if not exists kind       text not null default 'cargo',   -- 'cargo' or 'resupply'
  add column if not exists to_base_id uuid references public.bases (id) on delete cascade,
  add column if not exists stock      int not null default 0,
  add column if not exists threatened boolean not null default false;

alter table public.missions
  add column if not exists shipment_id uuid;           -- the convoy an escort mission protects

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------

-- 0 = green, 1 = regular, 2 = veteran, 3 = elite
create or replace function public.fc_veterancy(p_missions int)
returns int language sql stable set search_path = public
as $$
  select case when p_missions >= public.fc_cfg('veteran_missions_3') then 3
              when p_missions >= public.fc_cfg('veteran_missions_2') then 2
              when p_missions >= public.fc_cfg('veteran_missions_1') then 1
              else 0 end;
$$;

-- New bases: zone from the building type (Phase 7) and a full stock.
create or replace function public.fc_base_defaults()
returns trigger language plpgsql security definer set search_path = public
as $$
declare btype public.building_types;
begin
  select * into btype from public.building_types where id = new.building_type;
  new.zone  := coalesce(btype.default_zone, 'front');
  new.stock := coalesce(btype.stock_capacity, 0) * new.level;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. fc_on_mission_complete(): experience and damage
--    fc_sync() (see 004) calls this once at the moment a mission is
--    settled, while its units are still listed as committed.
-- ---------------------------------------------------------------------
create or replace function public.fc_on_mission_complete(p_mission uuid, p_at timestamptz)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mtype   public.mission_types;
  d       record;
  chance  numeric;
  helpers int;
  secs    numeric;
begin
  select t.* into mtype
    from public.missions m join public.mission_types t on t.id = m.mission_type
   where m.id = p_mission;

  for d in
    select dp.unit_id, dp.player_id, dp.travel_seconds, u.missions_done, c.recovers_at
      from public.dispatches dp
      join public.units u on u.id = dp.unit_id
      join public.unit_types ut on ut.id = u.unit_type
      join public.unit_categories c on c.id = ut.category_id
     where dp.mission_id = p_mission and dp.returns_at is null
  loop
    update public.units set missions_done = missions_done + 1 where id = d.unit_id;

    -- Harder missions are riskier. Experienced units look after themselves
    -- better, and having medics or engineers along halves the risk.
    chance := public.fc_cfg('damage_chance_per_difficulty') * mtype.difficulty
              * (1 - 0.2 * public.fc_veterancy(d.missions_done))
              * case when mtype.requirements ? 'medical' or mtype.requirements ? 'engineers'
                     then 0.5 else 1 end;

    if random() < chance then
      -- Recovery is quicker the more Field Hospital / Supply Depot levels
      -- the unit's owner has.
      select coalesce(sum(b.level), 0) into helpers
        from public.bases b
       where b.owner_id = d.player_id and b.building_type = d.recovers_at;
      secs := public.fc_cfg('repair_seconds_per_difficulty') * mtype.difficulty
              / (1 + public.fc_cfg('recovery_bonus_per_level') * helpers);

      -- The clock starts when the unit gets home.
      update public.units
         set repair_until = p_at + make_interval(secs => d.travel_seconds + secs)
       where id = d.unit_id;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Resupply
-- ---------------------------------------------------------------------

-- Send a convoy from the Headquarters to top a base up. Takes the supplies
-- out of the player's main stock now; the base receives them on arrival.
-- Returns how much was sent (0 if nothing could be).
create or replace function public.fc_send_resupply(p_me uuid, p_base_id uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  prof  public.profiles;
  base  public.bases;
  hq    public.bases;
  cap   int;
  want  int;
begin
  select * into prof from public.profiles where id = p_me for update;
  select * into base from public.bases where id = p_base_id and owner_id = p_me for update;
  if not found then return 0; end if;
  select t.stock_capacity * base.level into cap from public.building_types t where t.id = base.building_type;

  -- Count what is already on its way, so we never over-order.
  want := cap - coalesce(base.stock, 0)
          - coalesce((select sum(stock) from public.shipments where to_base_id = base.id), 0);
  want := least(want, prof.supplies);
  if want <= 0 then return 0; end if;

  select b.* into hq from public.bases b join public.building_types t on t.id = b.building_type
   where b.owner_id = p_me and t.is_hq limit 1;
  if hq.id is null then return 0; end if;

  update public.profiles set supplies = supplies - want where id = p_me;
  insert into public.shipments
    (owner_id, kind, label, from_lat, from_lng, to_lat, to_lng, to_base_id, by_sea, stock, departed_at, arrives_at)
  values
    (p_me, 'resupply', 'Resupply for ' || base.name, hq.lat, hq.lng, base.lat, base.lng, base.id,
     public.fc_route_by_sea(hq.lat, hq.lng, base.lat, base.lng), want, now(),
     now() + make_interval(secs => public.fc_convoy_seconds(hq.lat, hq.lng, base.lat, base.lng)));
  return want;
end;
$$;

create or replace function public.resupply_base(p_base_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid(); events jsonb;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);
  if not exists (select 1 from public.bases where id = p_base_id and owner_id = me) then
    raise exception 'That is not one of your bases.';
  end if;
  if public.fc_send_resupply(me, p_base_id) = 0 then
    raise exception 'Nothing to send: the base is full, a convoy is already on its way, or you have no supplies.';
  end if;
  return public.fc_snapshot(me, events);
end;
$$;

create or replace function public.set_auto_resupply(p_base_id uuid, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  update public.bases set auto_resupply = coalesce(p_on, true) where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  return public.fc_snapshot(me, '[]');
end;
$$;

-- ---------------------------------------------------------------------
-- 5. fc_sync_extras(): everything timed from Phases 7 and 8
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
  pt     record;
  n      int;
  new_id uuid;
  arrive timestamptz;
  port   public.bases;
  cargo_money    bigint;
  cargo_supplies bigint;
  outcome text;
begin
  -- Suspended accounts stop here: this function runs at the start of every
  -- check-in and every action, so raising an error locks the account out.
  perform public.fc_assert_active(p_me);

  perform 1 from public.profiles where id = p_me for update;
  if not found then return events; end if;

  -- Bases built before this phase have no stock figure yet: fill them up
  -- the first time their owner checks in.
  update public.bases b
     set stock = t.stock_capacity * b.level
    from public.building_types t
   where t.id = b.building_type and b.owner_id = p_me and b.stock is null;

  -- (a) Repairs finished
  update public.units
     set status = 'idle', busy_until = null, repair_until = null
   where owner_id = p_me and status = 'repairing' and busy_until <= v_now;
  get diagnostics n = row_count;
  if n > 0 then events := events || jsonb_build_object('type', 'repairs_done', 'count', n); end if;

  -- Scouts back from looking at an unconfirmed report (Phase 14).
  update public.units
     set status = 'idle', busy_until = null, scout_mission_id = null, scout_arrives_at = null
   where owner_id = p_me and status = 'scouting' and busy_until <= v_now;

  -- (b) Training courses finished
  for r in
    update public.units u
       set specialty = training_specialty, training_specialty = null, status = 'idle', busy_until = null
     where u.owner_id = p_me and u.status = 'training' and u.busy_until <= v_now
    returning (select name from public.unit_types where id = u.unit_type) as unit_name,
              (select name from public.specialties where id = u.specialty) as specialty_name
  loop
    events := events || jsonb_build_object('type', 'training_done', 'unit', r.unit_name, 'specialty', r.specialty_name);
  end loop;

  -- (c) Transfers arrived
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

  select b.* into hq from public.bases b
    join public.building_types t on t.id = b.building_type
   where b.owner_id = p_me and t.is_hq limit 1;

  -- (d) Factory jobs finished: load a convoy for the Headquarters
  for r in
    select b.id, b.lat, b.lng, b.level, b.production_done_at,
           p.name, p.output_money, p.output_supplies
      from public.bases b join public.products p on p.id = b.production_id
     where b.owner_id = p_me and b.production_done_at <= v_now
  loop
    arrive := r.production_done_at + make_interval(secs =>
      public.fc_convoy_seconds(r.lat, r.lng, coalesce(hq.lat, r.lat), coalesce(hq.lng, r.lng)));

    insert into public.shipments
      (owner_id, kind, label, from_lat, from_lng, to_lat, to_lng, by_sea, money, supplies, departed_at, arrives_at)
    values
      (p_me, 'cargo', r.name, r.lat, r.lng, coalesce(hq.lat, r.lat), coalesce(hq.lng, r.lng),
       hq.id is not null and public.fc_route_by_sea(r.lat, r.lng, hq.lat, hq.lng),
       r.output_money * r.level, r.output_supplies * r.level, r.production_done_at, arrive)
    returning id into new_id;
    update public.bases set production_id = null, production_done_at = null where id = r.id;
    events := events || jsonb_build_object('type', 'production_done', 'name', r.name);

    -- A sea convoy may be shadowed by raiders in the approaches. Only if the
    -- player has a naval base to answer from, and there is time left to react.
    if hq.id is not null and arrive > v_now + interval '3 minutes'
       and (select by_sea from public.shipments where id = new_id)
       and random() < public.fc_cfg('convoy_threat_chance') then
      -- The naval base nearest the Headquarters guards the approaches.
      select b.* into port
        from public.bases b join public.building_types t on t.id = b.building_type
       where b.owner_id = p_me and t.unlocks_categories ? 'naval'
       order by public.fc_distance_km(b.lat, b.lng, hq.lat, hq.lng) limit 1;

      if port.id is not null then
        -- Look for open water 10–40 km off that base.
        for attempt in 1 .. 20 loop
          pt := public.fc_offset_point(port.lat, port.lng, 10 + random() * 30, random() * 2 * pi());
          if not public.fc_is_land(pt.lat, pt.lng) then
            insert into public.missions (mission_type, owner_id, lat, lng, expires_at, shipment_id)
            values ('convoy_threat', p_me, pt.lat, pt.lng, arrive, new_id);
            update public.shipments set threatened = true where id = new_id;
            events := events || jsonb_build_object('type', 'convoy_threat', 'name', r.name);
            exit;
          end if;
        end loop;
      end if;
    end if;
  end loop;

  -- (e) Convoys arrived
  for r in
    delete from public.shipments where owner_id = p_me and arrives_at <= v_now returning *
  loop
    if r.to_base_id is not null then
      -- A resupply run: into the base's own stock (never above its capacity).
      update public.bases b
         set stock = least(coalesce(b.stock, 0) + r.stock,
                           (select t.stock_capacity * b.level from public.building_types t where t.id = b.building_type))
       where b.id = r.to_base_id;
    else
      cargo_money := r.money;
      cargo_supplies := r.supplies;
      outcome := 'safe';
      if r.threatened then
        if exists (select 1 from public.missions where shipment_id = r.id and status = 'completed') then
          outcome := 'escorted';       -- seen in safely: a small bonus
          cargo_money    := round(cargo_money    * (1 + public.fc_cfg('convoy_escort_bonus')));
          cargo_supplies := round(cargo_supplies * (1 + public.fc_cfg('convoy_escort_bonus')));
        elsif exists (select 1 from public.missions where shipment_id = r.id and status = 'open') then
          outcome := 'raided';         -- nobody came: part of the cargo is lost
          cargo_money    := round(cargo_money    * (1 - public.fc_cfg('convoy_loss')));
          cargo_supplies := round(cargo_supplies * (1 - public.fc_cfg('convoy_loss')));
          -- Close the escort mission; fc_sync() expires it and recalls any units.
          update public.missions set expires_at = v_now where shipment_id = r.id and status = 'open';
        end if;
      end if;
      update public.profiles set money = money + cargo_money, supplies = supplies + cargo_supplies where id = p_me;
      events := events || jsonb_build_object('type', 'shipment_arrived', 'name', r.label,
                 'money', cargo_money, 'supplies', cargo_supplies, 'outcome', outcome);
    end if;
  end loop;

  -- (f) Automatic resupply: any base running low orders a top-up.
  for r in
    select b.id from public.bases b join public.building_types t on t.id = b.building_type
     where b.owner_id = p_me and b.auto_resupply and t.stock_capacity > 0
       and coalesce(b.stock, 0) < t.stock_capacity * b.level * public.fc_cfg('resupply_threshold')
       and not exists (select 1 from public.shipments s where s.to_base_id = b.id)
  loop
    perform public.fc_send_resupply(p_me, r.id);
  end loop;

  return events;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Dispatching: now draws on the base's stock and counts experience
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
    select un.id, un.status, un.specialty, un.missions_done, ut.category_id, ut.name, ut.speed_kmh, ut.power,
           b.id as base_id, b.name as base_name, b.lat, b.lng, c.supply_use,
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
            * 3600 / public.fc_cfg('travel_time_scale')));

    insert into public.dispatches
      (mission_id, unit_id, player_id, category_id, power, from_lat, from_lng,
       travel_seconds, departed_at, arrives_at)
    values
      (mission.id, u.id, me, slot,
       u.power * u.sp_power
         * public.fc_nation_bonus(prof.nation_id, 'power_mult', u.category_id)
         * (1 + public.fc_cfg('veteran_power_step') * public.fc_veterancy(u.missions_done)),
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
-- 7. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_sync_extras(uuid) from public, anon, authenticated;
revoke all on function public.fc_on_mission_complete(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fc_send_resupply(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fc_base_defaults() from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['resupply_base(uuid)', 'set_auto_resupply(uuid, boolean)', 'dispatch_units(uuid, uuid[])'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
