-- =====================================================================
-- Frontline Command — Phase 6: leaderboards, base upgrades, unit dismissal
-- Run after 005_terrain.sql. Safe to run more than once.
-- =====================================================================

create index if not exists missions_alliance_idx on public.missions (alliance_id) where alliance_id is not null;
create index if not exists profiles_xp_idx on public.profiles (xp desc);

-- ---------------------------------------------------------------------
-- 1. Leaderboards
--    Players can only read their OWN profile row (see 001), so rankings
--    come from this function, which hands out just the public columns:
--    name, nation, level, XP, missions completed. Never money or email.
-- ---------------------------------------------------------------------
create or replace function public.get_leaderboard()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with ranked as (
    select p.id, p.username, p.nation_id, p.level, p.xp, p.missions_completed,
           (select a.tag from public.alliance_members am
              join public.alliances a on a.id = am.alliance_id
             where am.player_id = p.id) as alliance_tag,
           rank() over (order by p.xp desc, p.created_at) as position
      from public.profiles p
     where p.nation_id is not null
  ),
  alliance_ranked as (
    select a.id, a.name, a.tag, a.xp,
           (select count(*) from public.alliance_members m where m.alliance_id = a.id) as members,
           rank() over (order by a.xp desc, a.created_at) as position
      from public.alliances a
  )
  select jsonb_build_object(
    'players', coalesce((select jsonb_agg(to_jsonb(r) - 'id' order by r.position)
                           from ranked r where r.position <= 50), '[]'),
    'me', (select to_jsonb(r) - 'id' from ranked r where r.id = auth.uid()),
    'player_count', (select count(*) from ranked),
    'alliances', coalesce((select jsonb_agg(to_jsonb(r) order by r.position)
                             from alliance_ranked r where r.position <= 50), '[]'));
$$;

-- ---------------------------------------------------------------------
-- 2. upgrade_base(): each level adds the building's capacity again
-- ---------------------------------------------------------------------
create or replace function public.upgrade_base(p_base_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  prof  public.profiles;
  base  public.bases;
  btype public.building_types;
  mult  numeric;
  price_money    bigint;
  price_supplies bigint;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;
  select * into base from public.bases where id = p_base_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your bases.'; end if;
  select * into btype from public.building_types where id = base.building_type;

  if base.level >= public.fc_cfg('max_base_level') then
    raise exception 'This base is already at its maximum level.';
  end if;

  -- Going from level N to N+1 costs N times the original price.
  mult := base.level * public.fc_nation_bonus(prof.nation_id, 'building_cost_mult');
  price_money    := round(btype.cost_money * mult);
  price_supplies := round(btype.cost_supplies * mult);
  if prof.money < price_money or prof.supplies < price_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  update public.profiles set money = money - price_money, supplies = supplies - price_supplies
   where id = me returning * into prof;
  update public.bases set level = level + 1 where id = base.id returning * into base;

  return jsonb_build_object('profile', to_jsonb(prof), 'base', to_jsonb(base));
end;
$$;

-- ---------------------------------------------------------------------
-- 3. dismiss_unit(): stand a unit down and get part of its cost back
-- ---------------------------------------------------------------------
create or replace function public.dismiss_unit(p_unit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  prof  public.profiles;
  unit  public.units;
  utype public.unit_types;
  refund_money    bigint;
  refund_supplies bigint;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_sync(me);        -- make sure "idle" is up to date
  select * into prof from public.profiles where id = me for update;
  select * into unit from public.units where id = p_unit_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your units.'; end if;
  if unit.status <> 'idle' then raise exception 'Only units waiting at their base can be dismissed.'; end if;
  select * into utype from public.unit_types where id = unit.unit_type;

  -- The refund is a share of what THIS nation would pay, so a nation with
  -- cheap units can't buy low and "sell" high.
  refund_money := floor(utype.cost_money
    * public.fc_nation_bonus(prof.nation_id, 'cost_mult', utype.category_id) * public.fc_cfg('dismiss_refund'));
  refund_supplies := floor(utype.cost_supplies
    * public.fc_nation_bonus(prof.nation_id, 'cost_mult', utype.category_id) * public.fc_cfg('dismiss_refund'));

  delete from public.units where id = unit.id;
  update public.profiles set money = money + refund_money, supplies = supplies + refund_supplies
   where id = me returning * into prof;

  return jsonb_build_object('profile', to_jsonb(prof), 'unit_id', unit.id,
                            'refund_money', refund_money, 'refund_supplies', refund_supplies);
end;
$$;

do $$
declare fn text;
begin
  foreach fn in array array['get_leaderboard()', 'upgrade_base(uuid)', 'dismiss_unit(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
