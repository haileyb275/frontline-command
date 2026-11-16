-- =====================================================================
-- Frontline Command — Phase 15: divisions, refits, captured equipment
-- Run after 014_front.sql. Safe to run more than once.
--
-- This phase changes no earlier function. Everything new hangs off
-- TRIGGERS: small functions the database runs by itself when a row is
-- inserted or updated. That is why dispatch_units() and fc_sync() did
-- not have to be rewritten again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables and columns
-- ---------------------------------------------------------------------
create table if not exists public.divisions (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  name          text not null,
  missions_done int not null default 0,       -- the division's own experience
  created_at    timestamptz not null default now()
);
create index if not exists divisions_owner_idx on public.divisions (owner_id);

alter table public.units
  add column if not exists division_id uuid references public.divisions (id) on delete set null,
  add column if not exists captured    boolean not null default false;

alter table public.dispatches
  add column if not exists division_bonus boolean not null default false;

alter table public.divisions enable row level security;
drop policy if exists "players can read their own divisions" on public.divisions;
create policy "players can read their own divisions"
  on public.divisions for select using (auth.uid() = owner_id);

-- 0 = raw, 1 = trained, 2 = seasoned, 3 = crack
create or replace function public.fc_division_tier(p_missions int)
returns int language sql stable set search_path = public
as $$
  select case when p_missions >= public.fc_cfg('division_missions_3') then 3
              when p_missions >= public.fc_cfg('division_missions_2') then 2
              when p_missions >= public.fc_cfg('division_missions_1') then 1
              else 0 end;
$$;

-- ---------------------------------------------------------------------
-- 2. Managing divisions
-- ---------------------------------------------------------------------
create or replace function public.create_division(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 40);
  allowed int;
  new_id uuid;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;
  if v_name = '' then raise exception 'Give the division a name.'; end if;
  -- One division to start with, and another every few levels.
  allowed := public.fc_cfg('division_base_slots') + floor(prof.level / public.fc_cfg('division_level_step'));
  if (select count(*) from public.divisions where owner_id = me) >= allowed then
    raise exception 'You can command % division(s) at your level. Another opens every % levels.',
      allowed, public.fc_cfg('division_level_step')::int;
  end if;
  insert into public.divisions (owner_id, name) values (me, v_name) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.rename_division(p_division_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 40);
begin
  if v_name = '' then raise exception 'Give the division a name.'; end if;
  update public.divisions set name = v_name where id = p_division_id and owner_id = auth.uid();
  if not found then raise exception 'Division not found.'; end if;
end;
$$;

-- Disbanding frees the units (the foreign key sets their division to none).
create or replace function public.disband_division(p_division_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.divisions where id = p_division_id and owner_id = auth.uid();
  if not found then raise exception 'Division not found.'; end if;
end;
$$;

-- Put a unit into a division, or take it out (p_division_id null).
create or replace function public.assign_division(p_unit_id uuid, p_division_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if not exists (select 1 from public.units where id = p_unit_id and owner_id = me) then
    raise exception 'That is not one of your units.';
  end if;
  if p_division_id is not null then
    if not exists (select 1 from public.divisions where id = p_division_id and owner_id = me) then
      raise exception 'Division not found.';
    end if;
    if (select count(*) from public.units where division_id = p_division_id and id <> p_unit_id)
       >= public.fc_cfg('division_max_units') then
      raise exception 'A division holds at most % units.', public.fc_cfg('division_max_units')::int;
    end if;
  end if;
  update public.units set division_id = p_division_id where id = p_unit_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Fighting as a formation
--    When two or more units of the same division go on the same mission,
--    and the division has a command unit attached, each of them fights
--    harder. This trigger runs as each unit is committed.
-- ---------------------------------------------------------------------
create or replace function public.fc_dispatch_division_bonus()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  div   public.divisions;
  bonus numeric;
begin
  select d.* into div
    from public.units u join public.divisions d on d.id = u.division_id
   where u.id = new.unit_id;
  if not found then return new; end if;

  -- No staff, no formation: the division needs a command unit on its books.
  if not exists (select 1 from public.units u join public.unit_types t on t.id = u.unit_type
                  where u.division_id = div.id and t.category_id = 'command') then
    return new;
  end if;

  -- Is a comrade from the same division already committed to this mission?
  if exists (select 1 from public.dispatches d join public.units u on u.id = d.unit_id
              where d.mission_id = new.mission_id and d.returns_at is null and u.division_id = div.id) then
    bonus := 1 + public.fc_cfg('division_power_step') * (1 + public.fc_division_tier(div.missions_done));
    -- Raise the comrades who went first (once each), and this unit too.
    update public.dispatches d
       set power = d.power * bonus, division_bonus = true
      from public.units u
     where u.id = d.unit_id and d.mission_id = new.mission_id and d.returns_at is null
       and u.division_id = div.id and not d.division_bonus;
    new.power := new.power * bonus;
    new.division_bonus := true;
  end if;
  return new;
end;
$$;
drop trigger if exists dispatches_division_bonus on public.dispatches;
create trigger dispatches_division_bonus before insert on public.dispatches
  for each row execute function public.fc_dispatch_division_bonus();

-- ---------------------------------------------------------------------
-- 4. When a mission is won: division experience and captured equipment
--    Runs at the moment fc_sync() marks the mission completed, while its
--    units are still listed as committed.
-- ---------------------------------------------------------------------
create or replace function public.fc_after_mission_won()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  mtype  public.mission_types;
  prof   public.profiles;
  prize  record;
begin
  -- A division gains experience when at least two of its units took part.
  update public.divisions dv
     set missions_done = missions_done + 1
   where dv.id in (
     select u.division_id
       from public.dispatches d join public.units u on u.id = d.unit_id
      where d.mission_id = new.id and d.returns_at is null and u.division_id is not null
      group by u.division_id having count(*) >= 2);

  -- Captured equipment: after hard-won contact, now and then the enemy
  -- leaves a serviceable vehicle behind.
  select * into mtype from public.mission_types where id = new.mission_type;
  if mtype.zone_rule = 'contact' and mtype.difficulty >= 3 and random() < public.fc_cfg('capture_chance') then
    select * into prof from public.profiles where id = new.owner_id;

    -- Another nation's vehicle, no newer than the player has researched,
    -- chosen together with somewhere to put it: a base of the right kind
    -- with a free place, the nearest such base to the battlefield.
    select t.id, t.name, b.id as base_id, b.name as base_name into prize
      from public.unit_types t
      join public.bases b on b.owner_id = prof.id
      join public.building_types bt on bt.id = b.building_type and bt.unlocks_categories ? t.category_id
     where t.nation_id <> prof.nation_id
       and t.category_id in ('armor', 'anti_tank', 'artillery', 'recon', 'logistics')
       and t.year <= public.fc_research_year(prof)
       and t.min_level <= prof.level + 1
       and (select count(*) from public.units u where u.base_id = b.id) < bt.unit_capacity * b.level
     order by random() limit 1;

    if found then
      insert into public.units (owner_id, base_id, unit_type, captured)
      values (prof.id, prize.base_id, prize.id, true);
      insert into public.player_notices (player_id, kind, body)
      values (prof.id, 'capture', 'Captured equipment: ' || prize.name || ' has been brought in to ' || prize.base_name || '.');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists missions_after_won on public.missions;
create trigger missions_after_won
  after update of status on public.missions
  for each row when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.fc_after_mission_won();

-- ---------------------------------------------------------------------
-- 5. Refits: re-equip a unit with a later model of the same kind.
--    It keeps its experience, specialty, call sign and division.
-- ---------------------------------------------------------------------
create or replace function public.refit_unit(p_unit_id uuid, p_unit_type text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  events jsonb;
  prof   public.profiles;
  unit   public.units;
  old_t  public.unit_types;
  new_t  public.unit_types;
  mult   numeric;
  price_money    bigint;
  price_supplies bigint;
  ready  timestamptz;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me for update;

  select * into unit from public.units where id = p_unit_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your units.'; end if;
  if unit.status <> 'idle' then raise exception 'Only a unit waiting at its base can be refitted.'; end if;
  select * into old_t from public.unit_types where id = unit.unit_type;
  select * into new_t from public.unit_types where id = p_unit_type;
  if not found then raise exception 'Unknown unit type.'; end if;

  if new_t.id = old_t.id then raise exception 'The unit already has that equipment.'; end if;
  if new_t.nation_id <> prof.nation_id then raise exception 'You can only refit with your own nation''s equipment.'; end if;
  if new_t.category_id <> old_t.category_id then raise exception 'A refit must stay within the same branch.'; end if;
  if new_t.year > public.fc_research_year(prof) then
    raise exception '% entered service in %. Research that year first.', new_t.name, new_t.year;
  end if;
  if prof.level < new_t.min_level then raise exception '% unlocks at level %.', new_t.name, new_t.min_level; end if;

  -- The old equipment is handed in for part of its value.
  mult := public.fc_nation_bonus(prof.nation_id, 'cost_mult', new_t.category_id);
  price_money    := greatest(0, round(new_t.cost_money * mult - old_t.cost_money * mult * public.fc_cfg('refit_credit')));
  price_supplies := greatest(0, round(new_t.cost_supplies * mult - old_t.cost_supplies * mult * public.fc_cfg('refit_credit')));
  if prof.money < price_money or prof.supplies < price_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  ready := now() + make_interval(secs => public.fc_cfg('refit_seconds'));
  update public.profiles set money = money - price_money, supplies = supplies - price_supplies where id = me;
  -- "repairing" doubles as "being re-equipped": the unit is off the board until it is done.
  update public.units
     set unit_type = new_t.id, captured = false, status = 'repairing', busy_until = ready, repair_until = ready
   where id = unit.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_dispatch_division_bonus() from public, anon, authenticated;
revoke all on function public.fc_after_mission_won() from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['create_division(text)', 'rename_division(uuid, text)', 'disband_division(uuid)',
                            'assign_division(uuid, uuid)', 'refit_unit(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
