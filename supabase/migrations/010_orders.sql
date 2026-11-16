-- =====================================================================
-- Frontline Command — Phase 10: daily orders, campaigns, achievements,
-- task forces, renaming
-- Run after 009_admin.sql. Safe to run more than once.
--
-- Daily orders are OPTIONAL. Nothing is lost by ignoring them; finishing
-- one pays a bonus, and finishing all three of the day pays a further one.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Running totals of what a player has done. One row for all time
-- (scope 'life') and one per day (scope '2026-11-17'), each a small JSON
-- object like {"missions": 12, "missions_cat_fire": 3, "units_sent": 40}.
create table if not exists public.player_counters (
  player_id uuid not null references public.profiles (id) on delete cascade,
  scope     text not null,
  counters  jsonb not null default '{}',
  primary key (player_id, scope)
);

create table if not exists public.daily_order_types (
  id                text primary key,
  text              text not null,
  counter           text not null,        -- which running total it watches
  target            int  not null,
  reward_money      bigint not null default 0,
  reward_supplies   bigint not null default 0,
  reward_xp         bigint not null default 0,
  min_level         int not null default 1,
  requires_category text                  -- only offered if the player can field this
);

-- The three orders a player was given on a particular day.
create table if not exists public.daily_orders (
  player_id uuid not null references public.profiles (id) on delete cascade,
  day       date not null,
  order_id  text not null references public.daily_order_types (id) on delete cascade,
  claimed   boolean not null default false,
  primary key (player_id, day, order_id)
);

-- Campaigns (several steps, a larger reward) and achievements (one step).
create table if not exists public.objectives (
  id              text primary key,
  kind            text not null check (kind in ('campaign', 'achievement')),
  name            text not null,
  description     text not null default '',
  steps           jsonb not null,          -- [{"text": "...", "counter": "bases", "target": 4}]
  reward_money    bigint not null default 0,
  reward_supplies bigint not null default 0,
  reward_xp       bigint not null default 0,
  sort            int not null default 0
);

create table if not exists public.objective_claims (
  player_id    uuid not null references public.profiles (id) on delete cascade,
  objective_id text not null references public.objectives (id) on delete cascade,
  claimed_at   timestamptz not null default now(),
  primary key (player_id, objective_id)
);

-- Saved groups of units that can be picked for a mission with one click.
create table if not exists public.task_forces (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  name       text not null,
  unit_ids   uuid[] not null,
  created_at timestamptz not null default now()
);
create index if not exists task_forces_owner_idx on public.task_forces (owner_id);

alter table public.units add column if not exists name text;   -- optional call sign

alter table public.player_counters   enable row level security;  -- functions only
alter table public.daily_orders      enable row level security;  -- functions only
alter table public.objective_claims  enable row level security;  -- functions only
alter table public.daily_order_types enable row level security;
alter table public.objectives        enable row level security;
alter table public.task_forces       enable row level security;

drop policy if exists "readable by everyone" on public.daily_order_types;
create policy "readable by everyone" on public.daily_order_types for select using (true);
drop policy if exists "readable by everyone" on public.objectives;
create policy "readable by everyone" on public.objectives for select using (true);
drop policy if exists "players can read their own task forces" on public.task_forces;
create policy "players can read their own task forces"
  on public.task_forces for select using (auth.uid() = owner_id);

-- ---------------------------------------------------------------------
-- 2. Counting
-- ---------------------------------------------------------------------

-- Add p_amount to one running total, for all time and for today.
create or replace function public.fc_bump(p_player uuid, p_key text, p_amount int default 1)
returns void
language sql security definer set search_path = public
as $$
  insert into public.player_counters (player_id, scope, counters)
  select p_player, s, jsonb_build_object(p_key, p_amount)
    from unnest(array['life', to_char(now() at time zone 'UTC', 'YYYY-MM-DD')]) as s
  on conflict (player_id, scope) do update
    set counters = player_counters.counters
                   || jsonb_build_object(p_key, coalesce((player_counters.counters ->> p_key)::int, 0) + p_amount);
$$;

-- A player's lifetime totals, plus figures read straight from their
-- current state (bases, units, level…), which need no counting.
create or replace function public.fc_counters(p_player uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select counters from public.player_counters where player_id = p_player and scope = 'life'), '{}')
    || jsonb_build_object(
      'level', (select level from public.profiles where id = p_player),
      'bases', (select count(*) from public.bases where owner_id = p_player),
      'units', (select count(*) from public.units where owner_id = p_player),
      'specialists', (select count(*) from public.units where owner_id = p_player and specialty is not null),
      'elite_units', (select count(*) from public.units where owner_id = p_player and public.fc_veterancy(missions_done) >= 3),
      'naval_units', (select count(*) from public.units u join public.unit_types t on t.id = u.unit_type
                       where u.owner_id = p_player and t.category_id = 'naval'),
      'factories', (select count(*) from public.bases b where b.owner_id = p_player
                     and exists (select 1 from public.products p where p.building_type = b.building_type)),
      'training_centers', (select count(*) from public.bases b join public.building_types t on t.id = b.building_type
                            where b.owner_id = p_player and t.training_slots > 0),
      'in_alliance', (select count(*) from public.alliance_members where player_id = p_player));
$$;

-- Experience and damage (from Phase 8), and now the running totals too.
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
-- 3. Daily orders
-- ---------------------------------------------------------------------

-- Rewards grow a little with the player's level, so they stay worthwhile.
create or replace function public.fc_daily_scale(p_level int)
returns numeric language sql stable set search_path = public
as $$ select least(5, 1 + public.fc_cfg('daily_level_scale') * (greatest(p_level, 1) - 1)); $$;

-- Give a reward and keep level in step with XP.
create or replace function public.fc_grant(p_player uuid, p_money bigint, p_supplies bigint, p_xp bigint)
returns void
language sql security definer set search_path = public
as $$
  update public.profiles
     set money = money + p_money, supplies = supplies + p_supplies, xp = xp + p_xp,
         level = greatest(level, public.fc_level_for_xp(xp + p_xp))
   where id = p_player;
$$;

-- Today's orders (dealt on first look each day), every campaign and
-- achievement, and the totals needed to show progress on all of them.
create or replace function public.get_objectives()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  prof  public.profiles;
  today date := (now() at time zone 'UTC')::date;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;

  -- First look of the day: deal three orders the player could actually do.
  if not exists (select 1 from public.daily_orders where player_id = me and day = today) then
    insert into public.daily_orders (player_id, day, order_id)
    select me, today, t.id
      from public.daily_order_types t
     where t.min_level <= prof.level
       and (t.requires_category is null or exists (
              select 1 from public.bases b join public.building_types bt on bt.id = b.building_type
               where b.owner_id = me and bt.unlocks_categories ? t.requires_category))
     order by random() limit 3;
    -- Tidy away old days while we are here.
    delete from public.daily_orders where player_id = me and day < today - 7;
    delete from public.player_counters where player_id = me and scope <> 'life' and scope < to_char(today - 7, 'YYYY-MM-DD');
  end if;

  return jsonb_build_object(
    'day', today,
    'resets_at', (today + 1)::timestamp at time zone 'UTC',
    'scale', public.fc_daily_scale(prof.level),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('order_id', o.order_id, 'claimed', o.claimed) order by o.order_id)
                         from public.daily_orders o where o.player_id = me and o.day = today), '[]'),
    'today', coalesce((select counters from public.player_counters
                        where player_id = me and scope = to_char(today, 'YYYY-MM-DD')), '{}'),
    'counters', public.fc_counters(me),
    'claimed', coalesce((select jsonb_agg(objective_id) from public.objective_claims where player_id = me), '[]'));
end;
$$;

create or replace function public.claim_daily_order(p_order_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  prof  public.profiles;
  today date := (now() at time zone 'UTC')::date;
  otype public.daily_order_types;
  done  int;
  scale numeric;
  bonus boolean := false;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into prof from public.profiles where id = me for update;
  select * into otype from public.daily_order_types where id = p_order_id;

  if not exists (select 1 from public.daily_orders
                  where player_id = me and day = today and order_id = p_order_id and not claimed) then
    raise exception 'That order is not waiting to be claimed.';
  end if;

  -- The server's own count for today decides, not anything the browser says.
  select coalesce((counters ->> otype.counter)::int, 0) into done
    from public.player_counters where player_id = me and scope = to_char(today, 'YYYY-MM-DD');
  if coalesce(done, 0) < otype.target then raise exception 'That order is not finished yet.'; end if;

  update public.daily_orders set claimed = true where player_id = me and day = today and order_id = p_order_id;
  scale := public.fc_daily_scale(prof.level);
  perform public.fc_grant(me, round(otype.reward_money * scale)::bigint, round(otype.reward_supplies * scale)::bigint,
                          round(otype.reward_xp * scale)::bigint);

  -- All of today's orders done: a further bonus.
  if not exists (select 1 from public.daily_orders where player_id = me and day = today and not claimed)
     and (select count(*) from public.daily_orders where player_id = me and day = today) >= 3 then
    bonus := true;
    perform public.fc_grant(me, round(public.fc_cfg('daily_bonus_money') * scale)::bigint,
                            round(public.fc_cfg('daily_bonus_supplies') * scale)::bigint,
                            round(public.fc_cfg('daily_bonus_xp') * scale)::bigint);
  end if;

  return jsonb_build_object('all_done_bonus', bonus) || public.get_objectives();
end;
$$;

create or replace function public.claim_objective(p_objective_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  obj  public.objectives;
  have jsonb;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform 1 from public.profiles where id = me for update;
  select * into obj from public.objectives where id = p_objective_id;
  if not found then raise exception 'Unknown objective.'; end if;
  if exists (select 1 from public.objective_claims where player_id = me and objective_id = obj.id) then
    raise exception 'You have already collected that reward.';
  end if;

  have := public.fc_counters(me);
  if exists (select 1 from jsonb_array_elements(obj.steps) as s
              where coalesce((have ->> (s ->> 'counter'))::numeric, 0) < (s ->> 'target')::numeric) then
    raise exception 'Not every step is complete yet.';
  end if;

  insert into public.objective_claims (player_id, objective_id) values (me, obj.id);
  perform public.fc_grant(me, obj.reward_money, obj.reward_supplies, obj.reward_xp);
  return public.get_objectives();
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Task forces
-- ---------------------------------------------------------------------
create or replace function public.save_task_force(p_name text, p_unit_ids uuid[])
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 30);
  new_id uuid;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if v_name = '' then raise exception 'Give the task force a name.'; end if;
  if p_unit_ids is null or cardinality(p_unit_ids) = 0 then raise exception 'Select at least one unit.'; end if;
  if cardinality(p_unit_ids) > 40 then raise exception 'A task force can hold at most 40 units.'; end if;
  if exists (select 1 from unnest(p_unit_ids) as x(id)
              where not exists (select 1 from public.units u where u.id = x.id and u.owner_id = me)) then
    raise exception 'One of those units is not yours.';
  end if;
  if (select count(*) from public.task_forces where owner_id = me) >= public.fc_cfg('max_task_forces') then
    raise exception 'You have the maximum number of task forces. Delete one first.';
  end if;

  insert into public.task_forces (owner_id, name, unit_ids) values (me, v_name, p_unit_ids) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.delete_task_force(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.task_forces where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'Task force not found.'; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Renaming
-- ---------------------------------------------------------------------
create or replace function public.rename_base(p_base_id uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 40);
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  if v_name = '' then raise exception 'Enter a name.'; end if;
  update public.bases set name = v_name where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  return public.fc_snapshot(me, '[]');
end;
$$;

-- An empty name removes the call sign again.
create or replace function public.rename_unit(p_unit_id uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_name text := left(trim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 30);
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  update public.units set name = nullif(v_name, '') where id = p_unit_id and owner_id = me;
  if not found then raise exception 'That is not one of your units.'; end if;
  return public.fc_snapshot(me, '[]');
end;
$$;

-- Public profiles now also list the achievements and campaigns a player has completed.
create or replace function public.get_player_profile(p_username text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'nation_id', p.nation_id,
    'level', p.level,
    'xp', p.xp,
    'missions_completed', p.missions_completed,
    'joined_at', p.created_at,
    'last_seen_at', p.last_seen_at,
    'rank', (select count(*) + 1 from public.profiles o where o.xp > p.xp and o.nation_id is not null),
    'alliance', (select jsonb_build_object('name', a.name, 'tag', a.tag, 'role', m.role)
                   from public.alliance_members m join public.alliances a on a.id = m.alliance_id
                  where m.player_id = p.id),
    'honours', coalesce((select jsonb_agg(c.objective_id order by c.claimed_at)
                           from public.objective_claims c where c.player_id = p.id), '[]'),
    'bases', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', b.id, 'name', b.name, 'building_type', b.building_type, 'level', b.level,
                 'lat', b.lat, 'lng', b.lng, 'zone', b.zone,
                 'units', (select count(*) from public.units u where u.base_id = b.id))
               order by b.created_at)
               from public.bases b where b.owner_id = p.id), '[]'),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
                 'unit_type', u.unit_type, 'name', u.name, 'specialty', u.specialty,
                 'missions_done', u.missions_done, 'base_id', u.base_id)
               order by u.created_at)
               from public.units u where u.owner_id = p.id), '[]'))
    from public.profiles p
   where lower(p.username) = lower(p_username) and p.nation_id is not null;
$$;

-- ---------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_bump(uuid, text, int) from public, anon, authenticated;
revoke all on function public.fc_counters(uuid) from public, anon, authenticated;
revoke all on function public.fc_grant(uuid, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.fc_on_mission_complete(uuid, timestamptz) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['get_objectives()', 'claim_daily_order(text)', 'claim_objective(text)',
                            'save_task_force(text, uuid[])', 'delete_task_force(uuid)',
                            'rename_base(uuid, text)', 'rename_unit(uuid, text)', 'get_player_profile(text)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
