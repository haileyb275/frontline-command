-- =====================================================================
-- Frontline Command — Phase 14: the front line, offensives, reconnaissance
-- Run after 013_limits.sql. Safe to run more than once.
--
--   * Every front-line base holds ground out to its FRONT (a radius in km).
--     Winning contact missions pushes it out; letting them expire lets it
--     fall back. Contact happens along the edge of it.
--   * Now and then the enemy mounts an OFFENSIVE against a base. Beat it in
--     time, or the base is out of action for a while.
--   * Some reports arrive UNCONFIRMED: a reconnaissance unit or aircraft
--     has to look before anyone knows what is needed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.bases
  add column if not exists front_km       numeric not null default 15,
  add column if not exists disabled_until timestamptz;

alter table public.missions
  add column if not exists confirmed      boolean not null default true,
  add column if not exists confirm_at     timestamptz,       -- when a scout gets there
  add column if not exists target_base_id uuid references public.bases (id) on delete cascade,
  add column if not exists reward_mult    numeric not null default 1;

alter table public.units
  add column if not exists scout_mission_id uuid,
  add column if not exists scout_arrives_at timestamptz;

alter table public.units drop constraint if exists units_status_check;
alter table public.units add constraint units_status_check
  check (status in ('idle', 'en_route', 'on_mission', 'returning', 'training', 'transferring', 'repairing', 'scouting'));

-- ---------------------------------------------------------------------
-- 2. The front
-- ---------------------------------------------------------------------

-- The front-line base nearest to a point (the one whose front it affects).
create or replace function public.fc_front_base(p_owner uuid, p_lat double precision, p_lng double precision)
returns uuid language sql stable security definer set search_path = public
as $$
  select id from public.bases
   where owner_id = p_owner and zone = 'front'
   order by public.fc_distance_km(lat, lng, p_lat, p_lng) limit 1;
$$;

-- Move a base's front out (positive) or back (negative), within limits.
create or replace function public.fc_front_adjust(p_base uuid, p_km numeric)
returns void language sql security definer set search_path = public
as $$
  update public.bases
     set front_km = greatest(public.fc_cfg('front_min_km'),
                             least(public.fc_cfg('front_max_km'), front_km + p_km))
   where id = p_base;
$$;

-- Is this mission still an unconfirmed report right now?
create or replace function public.fc_mission_hidden(m public.missions)
returns boolean language sql stable
as $$ select not m.confirmed and (m.confirm_at is null or m.confirm_at > now()); $$;

-- Called by fc_sync() when an open mission runs out of time (see 004).
create or replace function public.fc_on_mission_expired(p_mission uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mission public.missions;
  mtype   public.mission_types;
  until   timestamptz;
begin
  select * into mission from public.missions where id = p_mission;
  select * into mtype from public.mission_types where id = mission.mission_type;

  if mission.target_base_id is not null then
    -- An offensive nobody stopped: the base is overrun for a while. Its
    -- idle units fall back to regroup, and its front collapses inward.
    until := mission.expires_at + make_interval(secs => public.fc_cfg('offensive_disable_seconds'));
    update public.bases set disabled_until = until where id = mission.target_base_id;
    update public.units set status = 'repairing', busy_until = until, repair_until = until
     where base_id = mission.target_base_id and status = 'idle' and until > now();
    perform public.fc_front_adjust(mission.target_base_id, -public.fc_cfg('offensive_front_loss'));
  elsif mtype.zone_rule = 'contact' then
    -- Contact left unanswered: the front creeps back.
    perform public.fc_front_adjust(
      public.fc_front_base(mission.owner_id, mission.lat, mission.lng), -public.fc_cfg('front_loss_km'));
  end if;
end;
$$;

-- Experience, damage and running totals as before, plus the front moving out.
create or replace function public.fc_on_mission_complete(p_mission uuid, p_at timestamptz)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  mission public.missions;
  mtype   public.mission_types;
  d       record;
  pl      record;
  key     text;
  chance  numeric;
  helpers int;
  secs    numeric;
begin
  select * into mission from public.missions where id = p_mission;
  select * into mtype from public.mission_types where id = mission.mission_type;

  for d in
    select dp.unit_id, dp.player_id, dp.travel_seconds, u.missions_done, c.recovers_at
      from public.dispatches dp
      join public.units u on u.id = dp.unit_id
      join public.unit_types ut on ut.id = u.unit_type
      join public.unit_categories c on c.id = ut.category_id
     where dp.mission_id = p_mission and dp.returns_at is null
  loop
    update public.units set missions_done = missions_done + 1 where id = d.unit_id;

    chance := public.fc_cfg('damage_chance_per_difficulty') * mtype.difficulty
              * (1 - 0.2 * public.fc_veterancy(d.missions_done))
              * case when mtype.requirements ? 'medical' or mtype.requirements ? 'engineers'
                     then 0.5 else 1 end;

    if random() < chance then
      select coalesce(sum(b.level), 0) into helpers
        from public.bases b
       where b.owner_id = d.player_id and b.building_type = d.recovers_at;
      secs := public.fc_cfg('repair_seconds_per_difficulty') * mtype.difficulty
              / (1 + public.fc_cfg('recovery_bonus_per_level') * helpers);
      update public.units
         set repair_until = p_at + make_interval(secs => d.travel_seconds + secs)
       where id = d.unit_id;
    end if;
  end loop;

  -- Driving the enemy off pushes the front out from the nearest front-line
  -- base. Beating an offensive pushes it further.
  if mtype.zone_rule = 'contact' or mission.target_base_id is not null then
    perform public.fc_front_adjust(
      coalesce(mission.target_base_id, public.fc_front_base(mission.owner_id, mission.lat, mission.lng)),
      case when mission.target_base_id is not null then public.fc_cfg('offensive_front_gain')
           else public.fc_cfg('front_gain_km') end);
  end if;

  -- Running totals for everyone who took part (used by daily orders,
  -- campaigns and achievements).
  for pl in
    select player_id, count(*)::int as sent
      from public.dispatches where mission_id = p_mission and returns_at is null
     group by player_id
  loop
    perform public.fc_bump(pl.player_id, 'missions');
    perform public.fc_bump(pl.player_id, 'units_sent', pl.sent);
    if mtype.difficulty >= 3   then perform public.fc_bump(pl.player_id, 'missions_hard');   end if;
    if mtype.terrain = 'water' then perform public.fc_bump(pl.player_id, 'missions_water');  end if;
    if mission.alliance_id is not null then perform public.fc_bump(pl.player_id, 'missions_shared'); end if;
    -- One total per kind of unit the mission called for: missions_cat_fire, …
    for key in select jsonb_object_keys(mtype.requirements) loop
      perform public.fc_bump(pl.player_id, 'missions_cat_' || key);
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Spawning: along the front, sometimes unconfirmed, sometimes an offensive
--    (revises the Phase 7 version)
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
  target     public.bases;
  otype      public.mission_types;
  pt         record;
  lo         numeric;
  hi         numeric;
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

    -- WHERE, relative to the front. Around a front-line base:
    --   * enemy contact happens out along the edge of the ground you hold;
    --   * everything else happens inside it.
    -- Long-range missions (aircraft, big operations) keep their own distances.
    lo := mtype.min_km;
    hi := mtype.max_km;
    if anchor.zone = 'front' and mtype.max_km <= 60 then
      if mtype.zone_rule = 'contact' then
        lo := greatest(mtype.min_km, anchor.front_km * 0.85);
        hi := greatest(lo + 3, anchor.front_km * 1.25);
      else
        hi := least(mtype.max_km, greatest(mtype.min_km + 3, anchor.front_km));
      end if;
    end if;
    perform public.fc_spawn_mission(p_me, mtype.id, anchor.lat, anchor.lng, lo, hi);

    -- Finishing touches on the mission just created (same transaction, so
    -- "spawned_at = now()" picks out exactly that row).
    if mtype.zone_rule = 'contact' then
      update public.missions
         set -- the further out you have pushed, the more a contact is worth
             reward_mult = 1 + least(public.fc_cfg('front_reward_cap'),
                                     greatest(0, anchor.front_km - public.fc_cfg('front_start_km'))
                                     * public.fc_cfg('front_reward_per_km')),
             -- and about half of the harder ones arrive as an unconfirmed
             -- report: someone has to go and look before you know what it is
             confirmed = not (mtype.difficulty >= 2 and random() < public.fc_cfg('unconfirmed_chance'))
       where owner_id = p_me and mission_type = mtype.id and spawned_at = now() and status = 'open';
    end if;
  end loop;

  -- ---- Enemy offensives: now and then the enemy comes to YOU.
  -- One at a time, only against a front-line base, and only with a force
  -- the player has the buildings to answer.
  if p_due > 0 and random() < public.fc_cfg('offensive_chance')
     and not exists (select 1 from public.missions
                      where owner_id = p_me and target_base_id is not null and status in ('open', 'in_progress')) then
    select t.* into otype
      from public.mission_types t
     where t.id in ('offensive_probe', 'offensive_armored') and t.min_level <= p_level
       and not exists (
             select 1 from jsonb_object_keys(t.requirements) as need(key)
              where not exists (select 1 from public.bases b
                                  join public.building_types bt on bt.id = b.building_type
                                 where b.owner_id = p_me and bt.unlocks_categories ? need.key))
     order by t.difficulty desc, random() limit 1;

    if found then
      select b.* into target from public.bases b
       where b.owner_id = p_me and b.zone = 'front' and (b.disabled_until is null or b.disabled_until < now())
       order by random() limit 1;
      if found then
        for attempt in 1 .. 20 loop
          pt := public.fc_offset_point(target.lat, target.lng,
                  otype.min_km + random() * (otype.max_km - otype.min_km), random() * 2 * pi());
          if public.fc_is_land(pt.lat, pt.lng) then
            insert into public.missions (mission_type, owner_id, lat, lng, expires_at, target_base_id, site_name)
            values (otype.id, p_me, pt.lat, pt.lng,
                    now() + make_interval(secs => otype.expires_seconds), target.id, target.name);
            exit;
          end if;
        end loop;
      end if;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Reconnaissance
-- ---------------------------------------------------------------------

-- Send a recon unit or an aircraft to look at an unconfirmed report. The
-- report is confirmed the moment the scout arrives; the scout then flies
-- or drives home.
create or replace function public.scout_mission(p_mission_id uuid, p_unit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me      uuid := auth.uid();
  events  jsonb;
  prof    public.profiles;
  mission public.missions;
  u       record;
  weather text;
  travel  int;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me;

  select * into mission from public.missions where id = p_mission_id and owner_id = me and status = 'open' for update;
  if not found then raise exception 'Mission not found.'; end if;
  if mission.confirmed then raise exception 'That report is already confirmed.'; end if;
  if mission.confirm_at is not null then raise exception 'A scout is already on the way.'; end if;

  select un.id, un.status, un.specialty, ut.category_id, ut.name, ut.speed_kmh, c.domain, c.supply_use,
         b.id as base_id, b.name as base_name, b.lat, b.lng, coalesce(sp.speed_mult, 1) as sp_speed
    into u
    from public.units un
    join public.unit_types ut on ut.id = un.unit_type
    join public.unit_categories c on c.id = ut.category_id
    join public.bases b on b.id = un.base_id
    left join public.specialties sp on sp.id = un.specialty
   where un.id = p_unit_id and un.owner_id = me;
  if not found then raise exception 'That is not one of your units.'; end if;
  if u.status <> 'idle' then raise exception '% is not available.', u.name; end if;
  if u.category_id not in ('recon', 'air') then
    raise exception 'Only reconnaissance units and aircraft can scout a report.';
  end if;

  weather := public.fc_weather(mission.lat, mission.lng, now());
  if u.domain = 'air' and weather = 'storm' then
    raise exception 'Aircraft are grounded: there is a storm over the area.';
  end if;

  update public.bases set stock = stock - u.supply_use where id = u.base_id and coalesce(stock, 0) >= u.supply_use;
  if not found then raise exception '% is out of supplies.', u.base_name; end if;

  travel := greatest(
    public.fc_cfg('min_travel_seconds'),
    round(public.fc_distance_km(u.lat, u.lng, mission.lat, mission.lng)
          / (u.speed_kmh * u.sp_speed
             * public.fc_nation_bonus(prof.nation_id, 'speed_mult', u.category_id)
             * (1 + public.fc_alliance_bonus(me, 'speed')))
          * 3600 / public.fc_cfg('travel_time_scale')
          * case when u.domain = 'air' then 1
                 when weather = 'storm' then public.fc_cfg('weather_storm_slow')
                 when weather = 'rain'  then public.fc_cfg('weather_rain_slow') else 1 end));

  update public.missions set confirm_at = now() + make_interval(secs => travel) where id = mission.id;
  update public.units
     set status = 'scouting', scout_mission_id = mission.id,
         scout_arrives_at = now() + make_interval(secs => travel),
         busy_until = now() + make_interval(secs => travel * 2)      -- there and back
   where id = u.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- Units cannot be committed to a report nobody has looked at. A trigger on
-- the dispatches table enforces it, so dispatch_units() itself is unchanged.
create or replace function public.fc_check_dispatch_confirmed()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare m public.missions;
begin
  select * into m from public.missions where id = new.mission_id;
  if public.fc_mission_hidden(m) then
    raise exception 'That report is unconfirmed. Send a reconnaissance unit or an aircraft to look first.';
  end if;
  return new;
end;
$$;
drop trigger if exists dispatches_check_confirmed on public.dispatches;
create trigger dispatches_check_confirmed before insert on public.dispatches
  for each row execute function public.fc_check_dispatch_confirmed();

-- Players could otherwise read the missions table directly and see what an
-- unconfirmed report really is. The game itself never reads that table
-- (everything comes through the snapshot), so the owner's read rule simply
-- leaves unconfirmed rows out.
drop policy if exists "players can read their own missions" on public.missions;
create policy "players can read their own missions"
  on public.missions for select
  using (auth.uid() = owner_id and (confirmed or (confirm_at is not null and confirm_at <= now())));

-- ---------------------------------------------------------------------
-- 5. The snapshot hides what an unconfirmed report really is
--    (revises the Phase 7 version)
-- ---------------------------------------------------------------------
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
        select jsonb_agg(
                 to_jsonb(v)
                 || jsonb_build_object('owner_name', (select username from public.profiles where id = v.owner_id))
                 -- An unconfirmed report is sent WITHOUT its real type, so
                 -- nobody can peek at it with the browser's dev tools.
                 || case when public.fc_mission_hidden(v)
                         then jsonb_build_object('mission_type', 'unconfirmed_report', 'hidden', true,
                                                 'reward_mult', 1, 'site_name', null)
                         else '{}'::jsonb end
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
-- 6. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_front_base(uuid, double precision, double precision) from public, anon, authenticated;
revoke all on function public.fc_front_adjust(uuid, numeric) from public, anon, authenticated;
revoke all on function public.fc_on_mission_expired(uuid) from public, anon, authenticated;
revoke all on function public.fc_on_mission_complete(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fc_spawn_due_missions(uuid, int, int) from public, anon, authenticated;
revoke all on function public.fc_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fc_check_dispatch_confirmed() from public, anon, authenticated;
revoke all on function public.scout_mission(uuid, uuid) from public, anon;
grant execute on function public.scout_mission(uuid, uuid) to authenticated;
