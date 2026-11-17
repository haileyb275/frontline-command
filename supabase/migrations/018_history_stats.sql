-- =====================================================================
-- Frontline Command — Phase 18: named historical operations, statistics
-- Run after 017_rivalry.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- The operations themselves (content: src/data/history.json).
create table if not exists public.history_ops (
  id              text primary key,
  name            text not null,
  place           text not null,
  lat             double precision not null,
  lng             double precision not null,
  range_km        numeric not null default 400,
  min_level       int not null default 1,
  description     text not null default '',
  steps           jsonb not null,          -- [{mission, name, lat, lng}, …] in order
  reward_money    bigint not null default 0,
  reward_supplies bigint not null default 0,
  reward_xp       bigint not null default 0,
  honour          text not null,
  sort            int not null default 0
);

-- How far each player has got in each one.
create table if not exists public.player_history (
  player_id   uuid not null references public.profiles (id) on delete cascade,
  op_id       text not null references public.history_ops (id) on delete cascade,
  step        int not null default 0,      -- index of the step now on the map
  status      text not null default 'active' check (status in ('active', 'done', 'failed')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  primary key (player_id, op_id)
);

-- Which operation (if any) a mission is a step of.
alter table public.missions add column if not exists history_op text;

alter table public.history_ops    enable row level security;
alter table public.player_history enable row level security;
drop policy if exists "history_ops are readable" on public.history_ops;
create policy "history_ops are readable" on public.history_ops for select to authenticated using (true);
drop policy if exists "players read own history" on public.player_history;
create policy "players read own history" on public.player_history for select to authenticated
  using (player_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. Putting a step on the map
-- ---------------------------------------------------------------------
create or replace function public.fc_history_spawn(p_player uuid, p_op public.history_ops, p_step int)
returns void
language sql security definer set search_path = public
as $$
  insert into public.missions (mission_type, owner_id, lat, lng, expires_at, site_name, history_op, reward_mult)
  select s->>'mission', p_player, (s->>'lat')::double precision, (s->>'lng')::double precision,
         now() + interval '12 hours', p_op.name || ': ' || (s->>'name'), p_op.id, 1.5
    from (select p_op.steps -> p_step as s) x;
$$;

-- ---------------------------------------------------------------------
-- 3. Starting an operation
--    Needs the rank, and a base of your own within reach of the place:
--    you fight a historical battle from somewhere near where it happened.
-- ---------------------------------------------------------------------
create or replace function public.start_history_op(p_op text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  prof public.profiles;
  op   public.history_ops;
  mine public.player_history;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  perform public.fc_rate_limit('history', 10, 3600);
  select * into prof from public.profiles where id = me for update;
  select * into op from public.history_ops where id = p_op;
  if not found then raise exception 'Unknown operation.'; end if;
  if prof.level < op.min_level then raise exception 'This operation needs level %.', op.min_level; end if;
  if exists (select 1 from public.player_history where player_id = me and status = 'active') then
    raise exception 'Finish the operation you have under way first.';
  end if;
  select * into mine from public.player_history where player_id = me and op_id = op.id;
  if mine.status = 'done' then raise exception 'You have already completed this operation.'; end if;
  if not exists (select 1 from public.bases b where b.owner_id = me
                  and public.fc_distance_km(b.lat, b.lng, op.lat, op.lng) <= op.range_km) then
    raise exception 'You need a base within % km of % to take part.', op.range_km::int, op.place;
  end if;

  insert into public.player_history (player_id, op_id) values (me, op.id)
  on conflict (player_id, op_id) do update
    set step = 0, status = 'active', started_at = now(), finished_at = null;
  perform public.fc_history_spawn(me, op, 0);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. When a step is won or lost
-- ---------------------------------------------------------------------
create or replace function public.fc_history_step()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  op   public.history_ops;
  mine public.player_history;
begin
  select * into mine from public.player_history
   where player_id = new.owner_id and op_id = new.history_op and status = 'active' for update;
  if not found then return new; end if;
  select * into op from public.history_ops where id = new.history_op;

  if new.status = 'expired' then
    update public.player_history set status = 'failed', finished_at = now()
     where player_id = mine.player_id and op_id = mine.op_id;
    insert into public.player_notices (player_id, kind, body)
    values (mine.player_id, 'info', op.name || ' was called off: a step ran out of time. It can be started again.');
  elsif mine.step + 1 < jsonb_array_length(op.steps) then
    update public.player_history set step = step + 1 where player_id = mine.player_id and op_id = mine.op_id;
    perform public.fc_history_spawn(mine.player_id, op, mine.step + 1);
  else
    update public.player_history set status = 'done', finished_at = now()
     where player_id = mine.player_id and op_id = mine.op_id;
    perform public.fc_grant(mine.player_id, op.reward_money, op.reward_supplies, op.reward_xp);
    insert into public.player_notices (player_id, kind, body)
    values (mine.player_id, 'info', op.name || ' is complete. The battle honour "' || op.honour || '" is now on your profile.');
  end if;
  return new;
end;
$$;
drop trigger if exists missions_history_step on public.missions;
create trigger missions_history_step
  after update of status on public.missions
  for each row when (new.history_op is not null and new.status in ('completed', 'expired')
                     and old.status is distinct from new.status)
  execute function public.fc_history_step();

-- Battle honours are public: they show on a player's profile.
create or replace function public.get_player_honours(p_username text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('honour', o.honour, 'place', o.place, 'finished_at', h.finished_at)
                            order by h.finished_at), '[]')
    from public.profiles p
    join public.player_history h on h.player_id = p.id and h.status = 'done'
    join public.history_ops o on o.id = h.op_id
   where lower(p.username) = lower(p_username) and auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------
-- 5. Statistics: the caller's own record
--    Payouts are deleted as they are paid (see fc_sync in 004), so a
--    trigger keeps a small running total per player and mission as they go.
-- ---------------------------------------------------------------------
create table if not exists public.mission_stats (
  player_id    uuid not null references public.profiles (id) on delete cascade,
  mission_name text not null,
  times        int not null default 0,
  money        bigint not null default 0,
  supplies     bigint not null default 0,
  xp           bigint not null default 0,
  primary key (player_id, mission_name)
);
alter table public.mission_stats enable row level security;   -- functions only

create or replace function public.fc_record_payout()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Paid payouts only: one the housekeeping throws away unpaid does not count,
  -- and nor does one that goes because its player's account was deleted.
  if old.created_at > now() - interval '60 days'
     and exists (select 1 from public.profiles where id = old.player_id) then
    insert into public.mission_stats (player_id, mission_name, times, money, supplies, xp)
    values (old.player_id, old.mission_name, case when old.kind = 'reward' then 1 else 0 end, old.money, old.supplies, old.xp)
    on conflict (player_id, mission_name) do update
      set times = mission_stats.times + excluded.times, money = mission_stats.money + excluded.money,
          supplies = mission_stats.supplies + excluded.supplies, xp = mission_stats.xp + excluded.xp;
  end if;
  return old;
end;
$$;
drop trigger if exists mission_payouts_record on public.mission_payouts;
create trigger mission_payouts_record before delete on public.mission_payouts
  for each row execute function public.fc_record_payout();

create or replace function public.get_my_stats()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'joined', (select created_at from public.profiles where id = auth.uid()),
    'life', coalesce((select counters from public.player_counters where player_id = auth.uid() and scope = 'life'), '{}'),
    -- the last seven days, one entry per day that saw any activity
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', scope, 'missions', coalesce((counters->>'missions')::int, 0))
                                       order by scope)
                        from public.player_counters
                       where player_id = auth.uid() and scope <> 'life'
                         and scope >= to_char((now() at time zone 'UTC')::date - 6, 'YYYY-MM-DD')), '[]'),
    'earned', (select jsonb_build_object('money', coalesce(sum(money), 0), 'supplies', coalesce(sum(supplies), 0),
                                         'xp', coalesce(sum(xp), 0))
                 from public.mission_stats where player_id = auth.uid()),
    'top_missions', coalesce((select jsonb_agg(to_jsonb(t) order by t.times desc)
                                from (select mission_name as name, times, money
                                        from public.mission_stats
                                       where player_id = auth.uid() and times > 0
                                       order by times desc limit 5) t), '[]'),
    'honours', (select count(*) from public.player_history where player_id = auth.uid() and status = 'done'))
   where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_history_spawn(uuid, public.history_ops, int) from public, anon, authenticated;
revoke all on function public.fc_history_step() from public, anon, authenticated;
revoke all on function public.fc_record_payout() from public, anon, authenticated;
do $$
declare fn text;
begin
  foreach fn in array array['start_history_op(text)', 'get_player_honours(text)', 'get_my_stats()'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
