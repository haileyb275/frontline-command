-- =====================================================================
-- Frontline Command — Phase 20: events started by alliances
-- Run after 019_loans.sql. Safe to run more than once.
--
-- An alliance can start an event of one of three sizes (content in
-- src/data/alliance_events.json): two that only its own members' missions
-- count toward, and a worldwide one that every player in the game feeds.
--
--   * Free:      a leader or officer, once per alliance per day (UTC).
--   * Sponsored: any member, paid from their own funds, once per player per
--                day. If the event succeeds the sponsor collects more than
--                they paid (sponsor_return); if it fails the money is gone.
--   * One event per alliance at a time; one worldwide event at a time.
--
-- Events reuse the Phase 17 tables: a row in global_events with
-- alliance_id set counts only that alliance's members.
-- =====================================================================

create table if not exists public.alliance_event_types (
  id              text primary key,
  name            text not null,
  scope           text not null check (scope in ('alliance', 'world')),
  description     text not null default '',
  goal_text       text not null default '',
  counter         text not null,
  target          int not null,
  hours           int not null,
  cost            bigint not null,
  sponsor_return  bigint not null,
  reward_money    bigint not null default 0,
  reward_supplies bigint not null default 0,
  reward_xp       bigint not null default 0,
  sort            int not null default 0
);
alter table public.alliance_event_types enable row level security;
drop policy if exists "alliance_event_types are readable" on public.alliance_event_types;
create policy "alliance_event_types are readable" on public.alliance_event_types for select to authenticated using (true);

alter table public.global_events
  add column if not exists alliance_id         uuid references public.alliances (id) on delete cascade,  -- null = everyone counts
  add column if not exists sponsor_alliance_id uuid references public.alliances (id) on delete set null, -- who called it
  add column if not exists sponsor_id          uuid references public.profiles (id) on delete set null,  -- who paid, if anyone
  add column if not exists sponsor_cost        bigint not null default 0,
  add column if not exists sponsor_return      bigint not null default 0,
  add column if not exists sponsor_claimed     boolean not null default false,
  add column if not exists type_id             text;
create index if not exists global_events_active_idx on public.global_events (status, counter) where status = 'active';

-- Mark events whose time ran out.
create or replace function public.fc_expire_events()
returns void language sql security definer set search_path = public
as $$ update public.global_events set status = 'failed' where status = 'active' and ends_at <= now(); $$;

-- ---------------------------------------------------------------------
-- 1. fc_bump feeds alliance events too (revises the Phase 17 version)
-- ---------------------------------------------------------------------
create or replace function public.fc_bump(p_player uuid, p_key text, p_amount int default 1)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  op public.alliance_operations;
  ev public.global_events;
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

  -- …and feeds every event running that counts this: the worldwide one,
  -- and any event of the player's own alliance (Phase 20).
  for ev in
    update public.global_events g
       set progress = least(target, progress + p_amount),
           status = case when progress + p_amount >= target then 'succeeded' else status end
     where g.status = 'active' and g.counter = p_key and g.ends_at > now()
       and (g.alliance_id is null
            or g.alliance_id = (select alliance_id from public.alliance_members where player_id = p_player))
    returning g.*
  loop
    insert into public.global_event_contributions (event_id, player_id, amount)
    values (ev.id, p_player, p_amount)
    on conflict (event_id, player_id) do update set amount = global_event_contributions.amount + p_amount;
    if ev.status = 'succeeded' and coalesce(ev.alliance_id, ev.sponsor_alliance_id) is not null then
      perform public.fc_system_message(coalesce(ev.alliance_id, ev.sponsor_alliance_id),
        ev.name || ' has succeeded. Everyone who took part can collect their reward.');
    end if;
  end loop;
end;
$$;


-- Only one worldwide event at a time; alliance events do not count here
-- (revises the Phase 17 version).
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
  perform public.fc_expire_events();
  if exists (select 1 from public.global_events where status = 'active' and alliance_id is null) then
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


-- ---------------------------------------------------------------------
-- 2. Starting an event
-- ---------------------------------------------------------------------
create or replace function public.start_alliance_event(p_type text, p_sponsored boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     uuid := auth.uid();
  mem    public.alliance_members;
  t      public.alliance_event_types;
  prof   public.profiles;
  today  timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  who    text;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_rate_limit('alliance_event', 10, 3600);
  select * into mem from public.alliance_members where player_id = me;
  if not found then raise exception 'You need to be in an alliance to start an alliance event.'; end if;
  select * into t from public.alliance_event_types where id = p_type;
  if not found then raise exception 'Unknown event.'; end if;

  -- One start at a time per alliance, so two officers cannot both use the free one.
  perform 1 from public.alliances where id = mem.alliance_id for update;
  perform public.fc_expire_events();

  if exists (select 1 from public.global_events
              where status = 'active' and (alliance_id = mem.alliance_id or sponsor_alliance_id = mem.alliance_id)) then
    raise exception 'Your alliance already has an event running. Finish it first.';
  end if;
  if t.scope = 'world' and exists (select 1 from public.global_events where status = 'active' and alliance_id is null) then
    raise exception 'A worldwide event is already running. Try again when it ends.';
  end if;

  select * into prof from public.profiles where id = me for update;
  if p_sponsored then
    if exists (select 1 from public.global_events
                where sponsor_id = me and sponsor_cost > 0 and starts_at >= today) then
      raise exception 'You have already sponsored an event today. You can sponsor another tomorrow.';
    end if;
    if prof.money < t.cost then raise exception 'Sponsoring this event costs % funds.', t.cost; end if;
    update public.profiles set money = money - t.cost where id = me;
  else
    if mem.role not in ('leader', 'officer') then
      raise exception 'Only the alliance leader and officers can start the free event. You can sponsor one instead.';
    end if;
    if exists (select 1 from public.global_events
                where sponsor_alliance_id = mem.alliance_id and sponsor_cost = 0 and starts_at >= today) then
      raise exception 'Your alliance has used today''s free event. A member can still sponsor one.';
    end if;
  end if;

  insert into public.global_events
    (name, description, counter, target, reward_money, reward_supplies, reward_xp, ends_at,
     alliance_id, sponsor_alliance_id, sponsor_id, sponsor_cost, sponsor_return, type_id)
  values
    (t.name, t.description, t.counter, t.target, t.reward_money, t.reward_supplies, t.reward_xp,
     now() + make_interval(hours => t.hours),
     case when t.scope = 'alliance' then mem.alliance_id end, mem.alliance_id,
     case when p_sponsored then me end,
     case when p_sponsored then t.cost else 0 end,
     case when p_sponsored then t.sponsor_return else 0 end, t.id);

  who := case when p_sponsored then prof.username || ' sponsored' else prof.username || ' started' end;
  perform public.fc_system_message(mem.alliance_id,
    who || ' ' || t.name || ': ' || t.goal_text || ' within ' || t.hours || ' hours.');
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Collecting: a contributor's reward, and the sponsor's return
--    (revises the Phase 17 version)
-- ---------------------------------------------------------------------
create or replace function public.claim_event_reward(p_event uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  ev   public.global_events;
  paid boolean := false;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform 1 from public.profiles where id = me for update;
  select * into ev from public.global_events where id = p_event for update;
  if not found or ev.status <> 'succeeded' then raise exception 'That event did not succeed.'; end if;

  update public.global_event_contributions set claimed = true
   where event_id = ev.id and player_id = me and amount > 0 and not claimed;
  if found then
    perform public.fc_grant(me, ev.reward_money, ev.reward_supplies, ev.reward_xp);
    paid := true;
  end if;

  if ev.sponsor_id = me and ev.sponsor_return > 0 and not ev.sponsor_claimed then
    update public.global_events set sponsor_claimed = true where id = ev.id;
    perform public.fc_grant(me, ev.sponsor_return, 0, 0);
    paid := true;
  end if;

  if not paid then raise exception 'There is no reward waiting for you from this event.'; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Reading
-- ---------------------------------------------------------------------
create or replace function public.fc_event_json(e public.global_events, p_me uuid)
returns jsonb language sql stable security definer set search_path = public
as $$
  select to_jsonb(e) || jsonb_build_object(
    'sponsor_name', (select username from public.profiles where id = e.sponsor_id),
    'sponsor_tag', (select tag from public.alliances where id = e.sponsor_alliance_id),
    'mine', (select jsonb_build_object('amount', c.amount, 'claimed', c.claimed)
               from public.global_event_contributions c where c.event_id = e.id and c.player_id = p_me),
    'players', (select count(*) from public.global_event_contributions c where c.event_id = e.id),
    'top', coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'nation_id', p.nation_id, 'amount', c.amount)
                                      order by c.amount desc)
                       from (select * from public.global_event_contributions
                              where event_id = e.id order by amount desc limit 5) c
                       join public.profiles p on p.id = c.player_id), '[]'));
$$;

-- The current (or latest) worldwide event (revises the Phase 17 version).
create or replace function public.get_global_event()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_expire_events();
  return (select public.fc_event_json(e, me) from public.global_events e
           where e.alliance_id is null and e.starts_at > now() - interval '14 days'
           order by e.starts_at desc limit 1);
end;
$$;

-- Our alliance's events from the last three days, and what we may start today.
create or replace function public.get_alliance_events()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me    uuid := auth.uid();
  mem   public.alliance_members;
  today timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into mem from public.alliance_members where player_id = me;
  if not found then return null; end if;
  perform public.fc_expire_events();
  return jsonb_build_object(
    'events', coalesce((select jsonb_agg(public.fc_event_json(e, me) order by e.starts_at desc)
                          from public.global_events e
                         where (e.alliance_id = mem.alliance_id or e.sponsor_alliance_id = mem.alliance_id)
                           and e.starts_at > now() - interval '3 days'), '[]'),
    'running', exists (select 1 from public.global_events
                        where status = 'active' and (alliance_id = mem.alliance_id or sponsor_alliance_id = mem.alliance_id)),
    'world_running', exists (select 1 from public.global_events where status = 'active' and alliance_id is null),
    'free_used', exists (select 1 from public.global_events
                          where sponsor_alliance_id = mem.alliance_id and sponsor_cost = 0 and starts_at >= today),
    'sponsored_today', exists (select 1 from public.global_events
                                where sponsor_id = me and sponsor_cost > 0 and starts_at >= today),
    'can_start_free', mem.role in ('leader', 'officer'),
    'resets_at', today + interval '1 day');
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_bump(uuid, text, int) from public, anon, authenticated;
revoke all on function public.fc_expire_events() from public, anon, authenticated;
revoke all on function public.fc_event_json(public.global_events, uuid) from public, anon, authenticated;
do $$
declare fn text;
begin
  foreach fn in array array['start_alliance_event(text, boolean)', 'claim_event_reward(uuid)', 'get_global_event()',
                            'get_alliance_events()',
                            'admin_start_event(text, text, int, int, bigint, bigint, bigint, text)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
