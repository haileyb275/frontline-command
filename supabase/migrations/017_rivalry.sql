-- =====================================================================
-- Frontline Command — Phase 17: alliance territory, weekly rivalry,
-- mutual aid, worldwide events
-- Run after 016_supply_chain.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- One row per alliance per week (weeks start on Monday, UTC).
create table if not exists public.alliance_week_scores (
  alliance_id uuid not null references public.alliances (id) on delete cascade,
  week        date not null,
  score       int not null default 0,
  primary key (alliance_id, week)
);

-- A target the whole game works toward together. An administrator starts one.
create table if not exists public.global_events (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text not null default '',
  counter         text not null,
  target          int not null,
  progress        int not null default 0,
  status          text not null default 'active' check (status in ('active', 'succeeded', 'failed')),
  reward_money    bigint not null default 0,
  reward_supplies bigint not null default 0,
  reward_xp       bigint not null default 0,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz not null
);

create table if not exists public.global_event_contributions (
  event_id  uuid not null references public.global_events (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  amount    int not null default 0,
  claimed   boolean not null default false,
  primary key (event_id, player_id)
);

alter table public.alliance_week_scores       enable row level security;   -- functions only
alter table public.global_events              enable row level security;   -- functions only
alter table public.global_event_contributions enable row level security;   -- functions only

-- ---------------------------------------------------------------------
-- 2. fc_bump: now also scores the weekly rivalry and the worldwide event
--    (revises the Phase 11 version)
-- ---------------------------------------------------------------------
create or replace function public.fc_bump(p_player uuid, p_key text, p_amount int default 1)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  op public.alliance_operations;
  ev uuid;
begin
  insert into public.player_counters (player_id, scope, counters)
  select p_player, s, jsonb_build_object(p_key, p_amount)
    from unnest(array['life', to_char(now() at time zone 'UTC', 'YYYY-MM-DD')]) as s
  on conflict (player_id, scope) do update
    set counters = player_counters.counters
                   || jsonb_build_object(p_key, coalesce((player_counters.counters ->> p_key)::int, 0) + p_amount);

  -- Is this player's alliance running an operation that counts this?
  select o.* into op
    from public.alliance_operations o
    join public.alliance_members m on m.alliance_id = o.alliance_id
   where m.player_id = p_player and o.status = 'active' and o.counter = p_key and o.ends_at > now()
   for update of o;
  if found then
    insert into public.operation_contributions (operation_id, player_id, amount)
    values (op.id, p_player, p_amount)
    on conflict (operation_id, player_id) do update
      set amount = operation_contributions.amount + p_amount;

    update public.alliance_operations
       set progress = least(target, progress + p_amount),
           status = case when progress + p_amount >= target then 'succeeded' else status end
     where id = op.id;

    if op.progress + p_amount >= op.target then
      update public.alliances
         set xp = xp + (select alliance_xp from public.operation_types where id = op.operation_id)
       where id = op.alliance_id;
      perform public.fc_system_message(op.alliance_id,
        (select name from public.operation_types where id = op.operation_id)
        || ' has succeeded. Everyone who took part can collect their reward.');
    end if;
  end if;

  -- Phase 17. Each completed mission scores a point for the player's
  -- alliance this week (a hard mission scores a second one)…
  if p_key in ('missions', 'missions_hard') then
    insert into public.alliance_week_scores (alliance_id, week, score)
    select m.alliance_id, date_trunc('week', now() at time zone 'UTC')::date, p_amount
      from public.alliance_members m where m.player_id = p_player
    on conflict (alliance_id, week) do update set score = alliance_week_scores.score + excluded.score;
  end if;

  -- …and feeds the worldwide event, if one is running that counts this.
  update public.global_events
     set progress = least(target, progress + p_amount),
         status = case when progress + p_amount >= target then 'succeeded' else status end
   where status = 'active' and counter = p_key and ends_at > now()
  returning id into ev;
  if ev is not null then
    insert into public.global_event_contributions (event_id, player_id, amount)
    values (ev, p_player, p_amount)
    on conflict (event_id, player_id) do update set amount = global_event_contributions.amount + p_amount;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Alliance territory: where our allies' bases are
--    Members can see each other's bases (name, kind, place and how much
--    ground each holds). Nothing else about them.
-- ---------------------------------------------------------------------
create or replace function public.get_alliance_map()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'owner', p.username, 'nation_id', p.nation_id, 'name', b.name,
           'building_type', b.building_type, 'lat', b.lat, 'lng', b.lng,
           'zone', b.zone, 'front_km', b.front_km)), '[]')
    from public.alliance_members me
    join public.alliance_members m on m.alliance_id = me.alliance_id and m.player_id <> me.player_id
    join public.profiles p on p.id = m.player_id
    join public.bases b on b.owner_id = m.player_id
   where me.player_id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- 4. The weekly rivalry board
-- ---------------------------------------------------------------------
create or replace function public.get_alliance_week()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with this_week as (select date_trunc('week', now() at time zone 'UTC')::date as d),
  board as (
    select a.id, a.name, a.tag, s.score, s.week, rank() over (partition by s.week order by s.score desc) as position
      from public.alliance_week_scores s join public.alliances a on a.id = s.alliance_id
     where s.week >= (select d - 7 from this_week) and s.score > 0)
  select jsonb_build_object(
    'week', (select d from this_week),
    'ends_at', ((select d from this_week) + 7)::timestamp at time zone 'UTC',
    'this_week', coalesce((select jsonb_agg(to_jsonb(b) - 'week' order by b.position)
                             from board b where b.week = (select d from this_week) and b.position <= 20), '[]'),
    'last_week', coalesce((select jsonb_agg(to_jsonb(b) - 'week' order by b.position)
                             from board b where b.week = (select d - 7 from this_week) and b.position <= 3), '[]'))
   where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------
-- 5. Mutual aid: send supplies or goods to an alliance mate by convoy
-- ---------------------------------------------------------------------
create or replace function public.send_aid(p_username text, p_item text, p_quantity int)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  prof   public.profiles;
  friend public.profiles;
  my_hq  public.bases;
  their_hq public.bases;
  have   bigint;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_rate_limit('aid', 10, 3600);
  if p_item not in ('supplies', 'fuel', 'parts', 'medical') then raise exception 'That cannot be sent.'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 2000 then
    raise exception 'Send between 1 and 2,000 at a time.';
  end if;

  select * into prof from public.profiles where id = me for update;
  select * into friend from public.profiles where lower(username) = lower(p_username);
  if not found or friend.id = me then raise exception 'Choose another member of your alliance.'; end if;
  if public.fc_my_alliance() is null
     or (select alliance_id from public.alliance_members where player_id = friend.id) is distinct from public.fc_my_alliance() then
    raise exception 'Aid can only go to a member of your own alliance.';
  end if;

  have := case p_item when 'supplies' then prof.supplies when 'fuel' then prof.fuel
                      when 'parts' then prof.parts else prof.medical end;
  if have < p_quantity then raise exception 'You do not have that much to send.'; end if;

  select b.* into my_hq from public.bases b join public.building_types t on t.id = b.building_type
   where b.owner_id = me and t.is_hq limit 1;
  select b.* into their_hq from public.bases b join public.building_types t on t.id = b.building_type
   where b.owner_id = friend.id and t.is_hq limit 1;
  if my_hq.id is null or their_hq.id is null then
    raise exception 'Both of you need a Headquarters for a convoy to run between.';
  end if;

  update public.profiles
     set supplies = supplies - case when p_item = 'supplies' then p_quantity else 0 end,
         fuel     = fuel     - case when p_item = 'fuel'     then p_quantity else 0 end,
         parts    = parts    - case when p_item = 'parts'    then p_quantity else 0 end,
         medical  = medical  - case when p_item = 'medical'  then p_quantity else 0 end
   where id = me
  returning * into prof;

  -- The convoy belongs to the RECEIVER: it shows on their map and is
  -- unloaded by their own next check-in, like any other cargo.
  insert into public.shipments
    (owner_id, kind, label, from_lat, from_lng, to_lat, to_lng, by_sea, supplies, fuel, parts, medical, departed_at, arrives_at)
  values
    (friend.id, 'cargo', 'Aid from ' || prof.username, my_hq.lat, my_hq.lng, their_hq.lat, their_hq.lng,
     public.fc_route_by_sea(my_hq.lat, my_hq.lng, their_hq.lat, their_hq.lng),
     case when p_item = 'supplies' then p_quantity else 0 end, case when p_item = 'fuel' then p_quantity else 0 end,
     case when p_item = 'parts' then p_quantity else 0 end, case when p_item = 'medical' then p_quantity else 0 end,
     now(), now() + make_interval(secs => public.fc_convoy_seconds(my_hq.lat, my_hq.lng, their_hq.lat, their_hq.lng)));

  perform public.fc_system_message(public.fc_my_alliance(),
    prof.username || ' sent ' || p_quantity || ' ' || replace(p_item, 'parts', 'spare parts') || ' to ' || friend.username || '.');
  return prof;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Worldwide events
-- ---------------------------------------------------------------------
create or replace function public.admin_start_event(
  p_name text, p_counter text, p_target int, p_hours int,
  p_reward_money bigint default 0, p_reward_supplies bigint default 0, p_reward_xp bigint default 0,
  p_description text default '')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  new_id uuid;
begin
  update public.global_events set status = 'failed' where status = 'active' and ends_at <= now();
  if exists (select 1 from public.global_events where status = 'active') then
    raise exception 'An event is already running.';
  end if;
  if coalesce(trim(p_name), '') = '' or p_target < 1 or p_hours < 1 or p_hours > 336 then
    raise exception 'An event needs a name, a target above zero, and a length of 1 to 336 hours.';
  end if;
  insert into public.global_events (name, description, counter, target, reward_money, reward_supplies, reward_xp, ends_at)
  values (left(trim(p_name), 60), left(coalesce(p_description, ''), 200), p_counter, p_target,
          greatest(0, p_reward_money), greatest(0, p_reward_supplies), greatest(0, p_reward_xp),
          now() + make_interval(hours => p_hours))
  returning id into new_id;
  perform public.fc_admin_log(admin, 'start_event', null, jsonb_build_object('name', p_name, 'target', p_target));
  return new_id;
end;
$$;

-- The current (or most recent) event, the caller's part in it, and the top contributors.
create or replace function public.get_global_event()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  update public.global_events set status = 'failed' where status = 'active' and ends_at <= now();
  return (
    select to_jsonb(e) || jsonb_build_object(
      'mine', (select jsonb_build_object('amount', c.amount, 'claimed', c.claimed)
                 from public.global_event_contributions c where c.event_id = e.id and c.player_id = me),
      'players', (select count(*) from public.global_event_contributions c where c.event_id = e.id),
      'top', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'nation_id', p.nation_id, 'amount', c.amount)
                                        order by c.amount desc)
                         from (select * from public.global_event_contributions
                                where event_id = e.id order by amount desc limit 5) c
                         join public.profiles p on p.id = c.player_id), '[]'))
      from public.global_events e
     where e.starts_at > now() - interval '14 days'
     order by e.starts_at desc limit 1);
end;
$$;

create or replace function public.claim_event_reward(p_event uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  ev public.global_events;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform 1 from public.profiles where id = me for update;
  select * into ev from public.global_events where id = p_event;
  if not found or ev.status <> 'succeeded' then raise exception 'That event did not succeed.'; end if;
  update public.global_event_contributions set claimed = true
   where event_id = ev.id and player_id = me and amount > 0 and not claimed;
  if not found then raise exception 'There is no reward waiting for you from this event.'; end if;
  perform public.fc_grant(me, ev.reward_money, ev.reward_supplies, ev.reward_xp);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_bump(uuid, text, int) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array['get_alliance_map()', 'get_alliance_week()', 'send_aid(text, text, int)',
                            'admin_start_event(text, text, int, int, bigint, bigint, bigint, text)',
                            'get_global_event()', 'claim_event_reward(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
