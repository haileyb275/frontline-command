-- =====================================================================
-- Frontline Command — Phase 19: lending units to an alliance mate
-- Run after 018_history_stats.sql. Safe to run more than once.
--
-- A lent unit really changes hands for a while: the borrower sees it among
-- their own units and sends it out like any other, and it keeps the
-- experience it gains. When the time is up (and it is back at base) it
-- goes home by itself, at the next check-in of either player.
-- =====================================================================

alter table public.units
  add column if not exists lent_by      uuid references public.profiles (id) on delete set null,
  add column if not exists lent_until   timestamptz,
  add column if not exists home_base_id uuid;      -- where it came from (that base may be gone by then)
create index if not exists units_lent_by_idx on public.units (lent_by) where lent_by is not null;

-- ---------------------------------------------------------------------
-- 1. A unit on loan cannot be sold off, retrained or re-equipped
--    The functions that do those things were written before loans, so
--    the rule is enforced here, underneath all of them.
-- ---------------------------------------------------------------------
create or replace function public.fc_guard_loan()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  home uuid;
  copy public.units;
begin
  -- The loan functions below announce themselves and are let through.
  if current_setting('fc.loan_change', true) = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 then
      raise exception 'A unit on loan cannot be dismissed. Send it back to its owner instead.';
    end if;
    -- Deleted as part of something bigger (the borrower's base or account
    -- going): the unit is not lost, it goes home.
    select b.id into home from public.bases b
     where b.owner_id = old.lent_by order by (b.id = old.home_base_id) desc, b.created_at limit 1;
    if home is not null then
      copy := old;
      copy.id := gen_random_uuid(); copy.owner_id := old.lent_by; copy.base_id := home;
      copy.status := 'idle'; copy.mission_id := null; copy.busy_until := null; copy.division_id := null;
      copy.lent_by := null; copy.lent_until := null; copy.home_base_id := null;
      insert into public.units values (copy.*);
    end if;
    return old;
  end if;

  if new.owner_id <> old.owner_id or new.unit_type <> old.unit_type
     or new.specialty is distinct from old.specialty
     -- (lent_by going to null is the database's own doing, when the lender's account is deleted)
     or (new.lent_by is distinct from old.lent_by and new.lent_by is not null)
     or new.lent_until is distinct from old.lent_until
     or (new.status in ('training', 'transferring') and old.status <> new.status) then
    raise exception 'A unit on loan cannot be trained, refitted, transferred or handed on.';
  end if;
  return new;
end;
$$;
drop trigger if exists units_guard_loan on public.units;
create trigger units_guard_loan
  before update or delete on public.units
  for each row when (old.lent_by is not null)
  execute function public.fc_guard_loan();

-- ---------------------------------------------------------------------
-- 2. Sending loans home
--    Called at each check-in, for units this player lent or borrowed.
-- ---------------------------------------------------------------------
create or replace function public.fc_return_loans(p_player uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  u    public.units;
  home uuid;
  n    int := 0;
begin
  perform set_config('fc.loan_change', '1', true);
  -- A lender whose account is gone leaves the unit with the borrower.
  update public.units set lent_until = null, home_base_id = null
   where owner_id = p_player and lent_by is null and lent_until is not null;

  for u in select * from public.units
            where (owner_id = p_player or lent_by = p_player)
              and lent_by is not null and lent_until <= now() and status = 'idle'
            for update skip locked loop
    select b.id into home from public.bases b
     where b.owner_id = u.lent_by order by (b.id = u.home_base_id) desc, b.created_at limit 1;
    if home is null then
      -- The lender has no base left to take it: it stays where it is.
      update public.units set lent_by = null, lent_until = null, home_base_id = null where id = u.id;
    else
      update public.units
         set owner_id = u.lent_by, base_id = home, division_id = null,
             lent_by = null, lent_until = null, home_base_id = null
       where id = u.id;
      insert into public.player_notices (player_id, kind, body)
      values (u.lent_by, 'info', 'A unit you lent has returned to base.');
      n := n + 1;
    end if;
  end loop;
  perform set_config('fc.loan_change', '0', true);
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Lending
-- ---------------------------------------------------------------------
create or replace function public.lend_unit(p_unit_id uuid, p_username text, p_hours int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  unit   public.units;
  utype  public.unit_types;
  friend public.profiles;
  from_base public.bases;
  dest   uuid;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_rate_limit('lend', 20, 3600);
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'A loan lasts from 1 to 72 hours.'; end if;

  select * into unit from public.units where id = p_unit_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your units.'; end if;
  if unit.lent_by is not null then raise exception 'A borrowed unit cannot be lent on.'; end if;
  if unit.status <> 'idle' then raise exception 'Only units waiting at their base can be lent.'; end if;
  if (select count(*) from public.units where lent_by = me) >= 5 then
    raise exception 'You can have five units out on loan at a time.';
  end if;

  select * into friend from public.profiles where lower(username) = lower(p_username);
  if not found or friend.id = me or public.fc_my_alliance() is null
     or (select alliance_id from public.alliance_members where player_id = friend.id) is distinct from public.fc_my_alliance() then
    raise exception 'Units can only be lent to a member of your own alliance.';
  end if;

  -- It needs somewhere to live: the borrower's nearest base of the right
  -- kind with a free place.
  select * into utype from public.unit_types where id = unit.unit_type;
  select * into from_base from public.bases where id = unit.base_id;
  select b.id into dest
    from public.bases b join public.building_types t on t.id = b.building_type
   where b.owner_id = friend.id and t.unlocks_categories ? utype.category_id
     and (select count(*) from public.units x where x.base_id = b.id) < t.unit_capacity * b.level
   order by public.fc_distance_km(b.lat, b.lng, from_base.lat, from_base.lng) limit 1;
  if dest is null then
    raise exception '% has no base with a free place for that kind of unit.', friend.username;
  end if;

  perform set_config('fc.loan_change', '1', true);
  update public.units
     set owner_id = friend.id, base_id = dest, division_id = null,
         lent_by = me, lent_until = now() + make_interval(hours => p_hours), home_base_id = unit.base_id
   where id = unit.id;
  perform set_config('fc.loan_change', '0', true);

  insert into public.player_notices (player_id, kind, body)
  values (friend.id, 'info', (select username from public.profiles where id = me) || ' has lent you a unit: '
                              || coalesce(unit.name, utype.name) || ', for ' || p_hours || ' hours.');
  perform public.fc_system_message(public.fc_my_alliance(),
    (select username from public.profiles where id = me) || ' lent ' || utype.name || ' to ' || friend.username || '.');
end;
$$;

-- Either side can end a loan early. A unit that is out on a mission comes
-- home as soon as it is back at base.
create or replace function public.end_loan(p_unit_id uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform set_config('fc.loan_change', '1', true);
  update public.units set lent_until = now()
   where id = p_unit_id and lent_by is not null and (owner_id = me or lent_by = me);
  if not found then raise exception 'That unit is not on loan to or from you.'; end if;
  return public.fc_return_loans(me) > 0;
end;
$$;

-- What I have out on loan (those units no longer appear among my own).
create or replace function public.get_my_loans()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'unit_type', u.unit_type, 'name', u.name, 'missions_done', u.missions_done,
           'borrower', p.username, 'lent_until', u.lent_until, 'status', u.status) order by u.lent_until), '[]')
    from public.units u join public.profiles p on p.id = u.owner_id
   where u.lent_by = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 4. The check-in now also sends finished loans home
--    (revises the Phase 13 version)
-- ---------------------------------------------------------------------
create or replace function public.sync_player()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  seen timestamptz;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select last_seen_at into seen from public.profiles where id = me;
  if seen > now() - interval '1 second' then
    perform public.fc_assert_active(me);          -- a suspended account still gets nothing
    return public.fc_snapshot(me, '[]');
  end if;

  -- Roughly one check-in in a hundred also does the housekeeping.
  if random() < 0.01 then perform public.fc_maintenance(); end if;

  perform public.fc_return_loans(me);
  return public.fc_snapshot(me, public.fc_sync(me));
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_guard_loan() from public, anon, authenticated;
revoke all on function public.fc_return_loans(uuid) from public, anon, authenticated;
do $$
declare fn text;
begin
  foreach fn in array array['lend_unit(uuid, text, int)', 'end_loan(uuid)', 'get_my_loans()', 'sync_player()'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
