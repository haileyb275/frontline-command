-- =====================================================================
-- Frontline Command — Phase 3: bases and units
-- Run after 001_profiles.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Config tables (filled by seed.sql from the JSON files)
-- ---------------------------------------------------------------------
create table if not exists public.unit_categories (
  id    text primary key,          -- 'infantry', 'armor', ...
  name  text not null,
  icon  text not null,             -- short label drawn on the map
  sort  int  not null default 0
);

create table if not exists public.building_types (
  id                 text primary key,     -- 'hq', 'barracks', ...
  name               text not null,
  icon               text not null,
  description        text not null default '',
  cost_money         bigint not null,
  cost_supplies      bigint not null default 0,
  unit_capacity      int    not null,      -- how many units can be stationed there
  unlocks_categories jsonb  not null,      -- ["infantry","recon"]
  min_level          int    not null default 1,
  is_hq              boolean not null default false,
  sort               int    not null default 0
);

create table if not exists public.unit_types (
  id            text primary key,          -- 'usa_armor', ...
  nation_id     text not null references public.nations (id),
  category_id   text not null references public.unit_categories (id),
  name          text not null,
  cost_money    bigint not null,
  cost_supplies bigint not null default 0,
  speed_kmh     numeric not null,
  power         numeric not null,
  min_level     int not null default 1
);

alter table public.unit_categories enable row level security;
alter table public.building_types  enable row level security;
alter table public.unit_types      enable row level security;

drop policy if exists "readable by everyone" on public.unit_categories;
create policy "readable by everyone" on public.unit_categories for select using (true);
drop policy if exists "readable by everyone" on public.building_types;
create policy "readable by everyone" on public.building_types for select using (true);
drop policy if exists "readable by everyone" on public.unit_types;
create policy "readable by everyone" on public.unit_types for select using (true);

-- ---------------------------------------------------------------------
-- 2. Player tables
-- ---------------------------------------------------------------------
create table if not exists public.bases (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  building_type text not null references public.building_types (id),
  name          text not null,
  lat           double precision not null check (lat between -85 and 85),
  lng           double precision not null check (lng between -180 and 180),
  level         int  not null default 1,
  created_at    timestamptz not null default now()
);
create index if not exists bases_owner_idx on public.bases (owner_id);

create table if not exists public.units (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  base_id    uuid not null references public.bases (id) on delete cascade,
  unit_type  text not null references public.unit_types (id),
  status     text not null default 'idle'
             check (status in ('idle', 'en_route', 'on_mission', 'returning')),
  mission_id uuid,                  -- filled in Phase 4
  busy_until timestamptz,           -- filled in Phase 4
  created_at timestamptz not null default now()
);
create index if not exists units_owner_idx on public.units (owner_id);
create index if not exists units_base_idx  on public.units (base_id);

alter table public.bases enable row level security;
alter table public.units enable row level security;

-- Read your own rows; no direct writes at all (functions only).
drop policy if exists "players can read their own bases" on public.bases;
create policy "players can read their own bases"
  on public.bases for select using (auth.uid() = owner_id);

drop policy if exists "players can read their own units" on public.units;
create policy "players can read their own units"
  on public.units for select using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------
-- 3. Helper functions
-- ---------------------------------------------------------------------

-- Distance between two points on Earth in km (the "haversine" formula).
create or replace function public.fc_distance_km(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )));
$$;

-- Look up a nation's multiplier for one kind of bonus.
--   fc_nation_bonus('ussr', 'cost_mult', 'armor')      → 0.9
--   fc_nation_bonus('usa',  'cost_mult', 'armor')      → 1     (no bonus)
--   fc_nation_bonus('france', 'building_cost_mult')    → 0.9
-- A bonus with no "category" applies to every category.
create or replace function public.fc_nation_bonus(
  p_nation_id text, p_type text, p_category text default null)
returns numeric
language sql stable
set search_path = public
as $$
  select coalesce(exp(sum(ln((b ->> 'value')::numeric))), 1)   -- multiply them together
    from public.nations n, jsonb_array_elements(n.bonuses) as b
   where n.id = p_nation_id
     and b ->> 'type' = p_type
     and (b ->> 'category' is null or b ->> 'category' = p_category);
$$;

-- ---------------------------------------------------------------------
-- 4. place_base(): build a base on the map
-- ---------------------------------------------------------------------
create or replace function public.place_base(
  p_building_type text,
  p_lat double precision,
  p_lng double precision,
  p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  prof    public.profiles;
  btype   public.building_types;
  n_bases int;
  price_money    bigint;
  price_supplies bigint;
  clean_name text;
  new_base public.bases;
begin
  if me is null then raise exception 'You must be logged in.'; end if;

  -- "for update" locks our profile row until this function finishes, so
  -- two requests sent at the same instant can't both spend the same money.
  select * into prof from public.profiles where id = me for update;
  if prof.nation_id is null then raise exception 'Choose a nation first.'; end if;

  select * into btype from public.building_types where id = p_building_type;
  if not found then raise exception 'Unknown building type.'; end if;

  if p_lat is null or p_lng is null
     or p_lat not between -85 and 85 or p_lng not between -180 and 180 then
    raise exception 'That position is not on the map.';
  end if;

  select count(*) into n_bases from public.bases where owner_id = me;

  if n_bases = 0 and not btype.is_hq then
    raise exception 'Your first base must be a Headquarters.';
  end if;
  if btype.is_hq and exists (
       select 1 from public.bases b join public.building_types t on t.id = b.building_type
        where b.owner_id = me and t.is_hq) then
    raise exception 'You already have a Headquarters.';
  end if;
  if prof.level < btype.min_level then
    raise exception '% unlocks at level %.', btype.name, btype.min_level;
  end if;
  if n_bases >= 60 then
    raise exception 'You have reached the maximum number of bases.';
  end if;

  if exists (select 1 from public.bases
              where owner_id = me
                and public.fc_distance_km(lat, lng, p_lat, p_lng) < 0.5) then
    raise exception 'Too close to one of your other bases (minimum 500 m).';
  end if;

  -- The price comes from the server's own table, never from the browser.
  price_money    := round(btype.cost_money    * public.fc_nation_bonus(prof.nation_id, 'building_cost_mult'));
  price_supplies := round(btype.cost_supplies * public.fc_nation_bonus(prof.nation_id, 'building_cost_mult'));

  if prof.money < price_money or prof.supplies < price_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  -- Tidy the name: strip control characters, trim, limit to 40 characters.
  clean_name := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 40);
  if clean_name = '' then clean_name := btype.name; end if;

  update public.profiles
     set money = money - price_money, supplies = supplies - price_supplies
   where id = me
  returning * into prof;

  insert into public.bases (owner_id, building_type, name, lat, lng)
  values (me, btype.id, clean_name, p_lat, p_lng)
  returning * into new_base;

  return jsonb_build_object('profile', to_jsonb(prof), 'base', to_jsonb(new_base));
end;
$$;

-- ---------------------------------------------------------------------
-- 5. buy_unit(): recruit a unit at one of your bases
-- ---------------------------------------------------------------------
create or replace function public.buy_unit(p_base_id uuid, p_unit_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  prof   public.profiles;
  base   public.bases;
  btype  public.building_types;
  utype  public.unit_types;
  n_here int;
  mult   numeric;
  price_money    bigint;
  price_supplies bigint;
  new_unit public.units;
begin
  if me is null then raise exception 'You must be logged in.'; end if;

  select * into prof from public.profiles where id = me for update;

  select * into base from public.bases where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  select * into btype from public.building_types where id = base.building_type;

  select * into utype from public.unit_types where id = p_unit_type;
  if not found then raise exception 'Unknown unit type.'; end if;

  if utype.nation_id is distinct from prof.nation_id then
    raise exception 'That unit belongs to another nation''s roster.';
  end if;
  if not (btype.unlocks_categories ? utype.category_id) then
    raise exception 'A % cannot station that kind of unit.', btype.name;
  end if;
  if prof.level < utype.min_level then
    raise exception '% unlocks at level %.', utype.name, utype.min_level;
  end if;

  select count(*) into n_here from public.units where base_id = base.id;
  if n_here >= btype.unit_capacity * base.level then
    raise exception 'This base is full.';
  end if;

  mult := public.fc_nation_bonus(prof.nation_id, 'cost_mult', utype.category_id);
  price_money    := round(utype.cost_money    * mult);
  price_supplies := round(utype.cost_supplies * mult);

  if prof.money < price_money or prof.supplies < price_supplies then
    raise exception 'Not enough funds or supplies.';
  end if;

  update public.profiles
     set money = money - price_money, supplies = supplies - price_supplies
   where id = me
  returning * into prof;

  insert into public.units (owner_id, base_id, unit_type)
  values (me, base.id, utype.id)
  returning * into new_unit;

  return jsonb_build_object('profile', to_jsonb(prof), 'unit', to_jsonb(new_unit));
end;
$$;

-- Only logged-in players may call the two action functions.
revoke all on function public.place_base(text, double precision, double precision, text) from public, anon;
grant execute on function public.place_base(text, double precision, double precision, text) to authenticated;
revoke all on function public.buy_unit(uuid, text) from public, anon;
grant execute on function public.buy_unit(uuid, text) to authenticated;
