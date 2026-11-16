-- =====================================================================
-- Frontline Command — Phase 16: goods, infrastructure, supply lines, market
-- Run after 015_divisions.sql. Safe to run more than once.
--
--   * Three GOODS alongside funds and supplies: fuel, spare parts and
--     medical stores. Each makes one thing faster when you have it; being
--     out of one never stops you playing.
--       fuel     → fuelled vehicles, ships and aircraft travel faster
--       parts    → damaged vehicles are repaired in half the time
--       medical  → damaged troops recover in half the time
--   * RAIL YARDS and PORTS speed up convoys that start or end near them.
--   * Long supply lines cost extra supplies to run.
--   * A MARKET where goods are bought and sold at prices that move.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns and tables
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists fuel    bigint not null default 150 check (fuel >= 0),
  add column if not exists parts   bigint not null default 60  check (parts >= 0),
  add column if not exists medical bigint not null default 60  check (medical >= 0);

alter table public.unit_categories add column if not exists fuel_use int not null default 0;
alter table public.building_types  add column if not exists infra text;       -- 'rail' or 'port'

alter table public.products
  add column if not exists output_fuel    bigint not null default 0,
  add column if not exists output_parts   bigint not null default 0,
  add column if not exists output_medical bigint not null default 0;

alter table public.shipments
  add column if not exists fuel    bigint not null default 0,
  add column if not exists parts   bigint not null default 0,
  add column if not exists medical bigint not null default 0;

alter table public.dispatches add column if not exists fuelled boolean not null default false;

create table if not exists public.market (
  item       text primary key check (item in ('supplies', 'fuel', 'parts', 'medical')),
  name       text not null,
  base_price numeric not null,          -- the price it drifts back to
  price      numeric,                   -- the price right now (NULL = never traded yet)
  updated_at timestamptz not null default now()
);
alter table public.market enable row level security;      -- read through get_market() only

-- ---------------------------------------------------------------------
-- 2. Infrastructure: rail yards and ports
-- ---------------------------------------------------------------------

-- Does the calling player have a rail yard or port near either end of a route?
create or replace function public.fc_has_infra(
  p_kind text, lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.bases b join public.building_types t on t.id = b.building_type
     where b.owner_id = auth.uid() and t.infra = p_kind
       and least(public.fc_distance_km(b.lat, b.lng, lat1, lng1),
                 public.fc_distance_km(b.lat, b.lng, lat2, lng2)) <= public.fc_cfg('convoy_infra_km'));
$$;

-- How long a convoy takes. A sea route is faster with a Port near either
-- end, a land route with a Rail Yard. (Revises the Phase 7 version.)
create or replace function public.fc_convoy_seconds(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns int
language plpgsql stable security definer set search_path = public
as $$
declare
  secs numeric := public.fc_distance_km(lat1, lng1, lat2, lng2)
                  / public.fc_cfg('convoy_speed_kmh') * 3600 / public.fc_cfg('convoy_time_scale');
begin
  if public.fc_has_infra(case when public.fc_route_by_sea(lat1, lng1, lat2, lng2) then 'port' else 'rail' end,
                         lat1, lng1, lat2, lng2) then
    secs := secs * public.fc_cfg('convoy_infra_mult');
  end if;
  return greatest(public.fc_cfg('min_convoy_seconds'), round(secs))::int;
end;
$$;

-- How much a resupply run costs compared with what it delivers (1 = nothing
-- extra). Longer lines and sea crossings cost more; a Rail Yard or Port on
-- the route halves the extra.
create or replace function public.fc_resupply_overhead(
  lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  by_sea boolean := public.fc_route_by_sea(lat1, lng1, lat2, lng2);
  extra  numeric;
begin
  extra := public.fc_distance_km(lat1, lng1, lat2, lng2) / 500 * public.fc_cfg('resupply_overhead_per_500km')
           + case when by_sea then public.fc_cfg('resupply_overhead_sea') else 0 end;
  extra := least(extra, public.fc_cfg('resupply_overhead_cap'));
  if public.fc_has_infra(case when by_sea then 'port' else 'rail' end, lat1, lng1, lat2, lng2) then
    extra := extra / 2;
  end if;
  return 1 + extra;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Fuel: a fuelled unit travels faster
--    Runs as each unit is committed to a mission. If the player has the
--    fuel its branch uses, the fuel is spent and the trip is shortened.
-- ---------------------------------------------------------------------
create or replace function public.fc_dispatch_fuel()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare need int;
begin
  select c.fuel_use into need
    from public.units u
    join public.unit_types t on t.id = u.unit_type
    join public.unit_categories c on c.id = t.category_id
   where u.id = new.unit_id;
  if coalesce(need, 0) = 0 then return new; end if;     -- troops on foot use none

  -- "fuel >= need" in the WHERE makes spending and checking one step.
  update public.profiles set fuel = fuel - need where id = new.player_id and fuel >= need;
  if found then
    new.fuelled := true;
    new.travel_seconds := greatest(public.fc_cfg('min_travel_seconds'),
                                   round(new.travel_seconds / (1 + public.fc_cfg('fuel_speed_bonus'))))::int;
    new.arrives_at := new.departed_at + make_interval(secs => new.travel_seconds);
  end if;
  return new;
end;
$$;
drop trigger if exists dispatches_fuel on public.dispatches;
create trigger dispatches_fuel before insert on public.dispatches
  for each row execute function public.fc_dispatch_fuel();

-- ---------------------------------------------------------------------
-- 4. Parts and medical stores: faster recovery
--    Runs at the moment a unit goes into repair (or a refit). If the
--    player has the right stores, they are spent and the wait is halved.
-- ---------------------------------------------------------------------
create or replace function public.fc_repair_with_stores()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  recovers text;
  cost     int := public.fc_cfg('repair_goods_cost');
  remaining interval := new.busy_until - now();
begin
  if remaining <= interval '0' then return new; end if;
  -- A base overrun by an offensive is regrouping, not being repaired:
  -- stores do not shorten that.
  if exists (select 1 from public.bases b where b.id = new.base_id and b.disabled_until = new.busy_until) then
    return new;
  end if;

  select c.recovers_at into recovers
    from public.unit_types t join public.unit_categories c on c.id = t.category_id
   where t.id = new.unit_type;

  if recovers = 'supply_depot' then          -- vehicles need spare parts
    update public.profiles set parts = parts - cost where id = new.owner_id and parts >= cost;
  else                                       -- troops need medical stores
    update public.profiles set medical = medical - cost where id = new.owner_id and medical >= cost;
  end if;
  if found then
    new.busy_until   := now() + remaining * public.fc_cfg('repair_goods_speedup');
    new.repair_until := new.busy_until;
  end if;
  return new;
end;
$$;
drop trigger if exists units_repair_with_stores on public.units;
create trigger units_repair_with_stores
  before update of status on public.units
  for each row when (new.status = 'repairing' and old.status is distinct from 'repairing' and new.busy_until is not null)
  execute function public.fc_repair_with_stores();

-- ---------------------------------------------------------------------
-- 5. The market
--    One shared price per item for the whole game. Buying pushes it up,
--    selling pushes it down, and left alone it drifts back to its base.
-- ---------------------------------------------------------------------

-- Bring a price up to date: move it part of the way back toward its base
-- price according to how long it has been since the last trade.
create or replace function public.fc_market_refresh(p_item text)
returns public.market
language plpgsql security definer set search_path = public
as $$
declare
  m public.market;
  hours numeric;
begin
  select * into m from public.market where item = p_item for update;
  if not found then raise exception 'That is not traded on the market.'; end if;
  hours := extract(epoch from now() - m.updated_at) / 3600;
  m.price := m.base_price + (coalesce(m.price, m.base_price) - m.base_price)
                            * exp(-hours / public.fc_cfg('market_recover_hours'));
  update public.market set price = m.price, updated_at = now() where item = p_item;
  return m;
end;
$$;

create or replace function public.get_market()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'item', m.item, 'name', m.name, 'base_price', m.base_price,
           -- the same drift-back sum as fc_market_refresh, without writing anything
           'price', round(m.base_price + (coalesce(m.price, m.base_price) - m.base_price)
                          * exp(-extract(epoch from now() - m.updated_at) / 3600 / public.fc_cfg('market_recover_hours')), 3))
           order by m.item), '[]')
    from public.market m
   where auth.uid() is not null;
$$;

-- Buy (p_buy true) or sell a quantity of one item. Returns the player's
-- profile and the new prices.
create or replace function public.trade_market(p_item text, p_quantity int, p_buy boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  prof   public.profiles;
  m      public.market;
  spread numeric := public.fc_cfg('market_spread');
  shift  numeric;
  average numeric;
  total  bigint;
  have   bigint;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_rate_limit('market', 60, 3600);
  if p_quantity is null or p_quantity < 1 or p_quantity > public.fc_cfg('market_max_trade') then
    raise exception 'Trade between 1 and % at a time.', public.fc_cfg('market_max_trade')::int;
  end if;

  select * into prof from public.profiles where id = me for update;
  m := public.fc_market_refresh(p_item);

  -- A big order moves the price as it is filled, so it is charged at the
  -- AVERAGE of the price before and after. Without this, two accounts
  -- could push the price up and cash in on the difference.
  shift := p_quantity / public.fc_cfg('market_depth');
  have := case p_item when 'supplies' then prof.supplies when 'fuel' then prof.fuel
                      when 'parts' then prof.parts else prof.medical end;

  if p_buy then
    average := m.price * (1 + shift / 2);
    total := ceil(p_quantity * average * (1 + spread));
    if prof.money < total then raise exception 'That costs % funds.', total; end if;
    m.price := least(m.base_price * 2.5, m.price * (1 + shift));
  else
    if have < p_quantity then raise exception 'You do not have that much to sell.'; end if;
    average := m.price * (1 - shift / 2);
    total := floor(p_quantity * average * (1 - spread));
    m.price := greatest(m.base_price * 0.4, m.price * (1 - shift));
  end if;

  update public.market set price = m.price, updated_at = now() where item = p_item;
  update public.profiles
     set money    = money + case when p_buy then -total else total end,
         supplies = supplies + case when p_item = 'supplies' then (case when p_buy then p_quantity else -p_quantity end) else 0 end,
         fuel     = fuel     + case when p_item = 'fuel'     then (case when p_buy then p_quantity else -p_quantity end) else 0 end,
         parts    = parts    + case when p_item = 'parts'    then (case when p_buy then p_quantity else -p_quantity end) else 0 end,
         medical  = medical  + case when p_item = 'medical'  then (case when p_buy then p_quantity else -p_quantity end) else 0 end
   where id = me
  returning * into prof;

  return jsonb_build_object('profile', to_jsonb(prof), 'total', total, 'market', public.get_market());
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Moving a base
--    A player may re-site one of their own bases for a quarter of what it
--    cost to build. The same siting rules apply as when building.
-- ---------------------------------------------------------------------
create or replace function public.move_base(p_base_id uuid, p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  events jsonb;
  prof   public.profiles;
  base   public.bases;
  btype  public.building_types;
  mult   numeric;
  price_money    bigint;
  price_supplies bigint;
  near_water boolean := false;
  pt     record;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  events := public.fc_sync(me);
  select * into prof from public.profiles where id = me for update;
  select * into base from public.bases where id = p_base_id and owner_id = me for update;
  if not found then raise exception 'That is not one of your bases.'; end if;
  select * into btype from public.building_types where id = base.building_type;

  -- The base has to be quiet before it can be packed up.
  if base.disabled_until > now() then raise exception 'This base is out of action and cannot be moved yet.'; end if;
  if exists (select 1 from public.units where base_id = base.id and status <> 'idle') then
    raise exception 'Every unit stationed here must be home and ready before the base can move.';
  end if;
  if base.production_id is not null then raise exception 'Wait for the current production run to finish.'; end if;
  if exists (select 1 from public.shipments where to_base_id = base.id) then
    raise exception 'A convoy is on its way here. Wait for it to arrive.';
  end if;

  -- The same siting rules as building.
  if p_lat is null or p_lng is null or p_lat not between -85 and 85 or p_lng not between -180 and 180 then
    raise exception 'That position is not on the map.';
  end if;
  if not public.fc_is_land(p_lat, p_lng) then raise exception 'Bases must be built on land.'; end if;
  if btype.requires_coast then
    for i in 0 .. 11 loop
      pt := public.fc_offset_point(p_lat, p_lng, 2, i * pi() / 6);
      if not public.fc_is_land(pt.lat, pt.lng) then near_water := true; exit; end if;
    end loop;
    if not near_water then
      raise exception 'A % must be built on the coast (within 2 km of the sea).', btype.name;
    end if;
  end if;
  if exists (select 1 from public.bases
              where owner_id = me and id <> base.id
                and public.fc_distance_km(lat, lng, p_lat, p_lng) < 0.5) then
    raise exception 'Too close to one of your other bases (minimum 500 m).';
  end if;

  mult := base.level * public.fc_cfg('move_cost_share') * public.fc_nation_bonus(prof.nation_id, 'building_cost_mult');
  price_money    := round(btype.cost_money * mult);
  price_supplies := round(btype.cost_supplies * mult);
  if prof.money < price_money or prof.supplies < price_supplies then
    raise exception 'Moving this base costs % funds and % supplies.', price_money, price_supplies;
  end if;

  update public.profiles set money = money - price_money, supplies = supplies - price_supplies where id = me;
  -- A base on new ground starts with a fresh front, and its neighbourhood
  -- has to be surveyed again.
  update public.bases
     set lat = p_lat, lng = p_lng, front_km = public.fc_cfg('front_start_km'), scanned_at = null
   where id = base.id;
  delete from public.map_features where base_id = base.id;

  return public.fc_snapshot(me, events);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_has_infra(text, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.fc_resupply_overhead(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.fc_dispatch_fuel() from public, anon, authenticated;
revoke all on function public.fc_repair_with_stores() from public, anon, authenticated;
revoke all on function public.fc_market_refresh(text) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['get_market()', 'trade_market(text, int, boolean)',
                            'move_base(uuid, double precision, double precision)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
