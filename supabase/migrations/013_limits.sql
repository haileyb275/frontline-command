-- =====================================================================
-- Frontline Command — Phase 13: rate limits and housekeeping
-- Run after 012_places_weather.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A general-purpose rate limiter
--    fc_rate_limit('survey', 40, 3600) means: the calling player may do
--    the thing called "survey" at most 40 times in any 3600 seconds.
--    Call it at the top of any function you want to protect.
-- ---------------------------------------------------------------------
create table if not exists public.rate_limits (
  player_id    uuid not null references public.profiles (id) on delete cascade,
  key          text not null,
  window_start timestamptz not null default now(),
  count        int not null default 0,
  primary key (player_id, key)
);
alter table public.rate_limits enable row level security;   -- functions only

create or replace function public.fc_rate_limit(p_key text, p_max int, p_seconds int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  n  int;
begin
  if me is null then return; end if;
  -- One statement does it all: start a fresh window if the old one has
  -- run out, otherwise count this call against the current window.
  insert into public.rate_limits as r (player_id, key, window_start, count)
  values (me, p_key, now(), 1)
  on conflict (player_id, key) do update
    set window_start = case when r.window_start < now() - make_interval(secs => p_seconds) then now() else r.window_start end,
        count        = case when r.window_start < now() - make_interval(secs => p_seconds) then 1 else r.count + 1 end
  returning count into n;
  if n > p_max then
    raise exception 'You are doing that too often. Please wait a little and try again.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Housekeeping: things that would otherwise grow for ever
-- ---------------------------------------------------------------------
create or replace function public.fc_maintenance()
returns void
language sql security definer set search_path = public
as $$
  delete from public.alliance_messages where created_at < now() - interval '30 days';
  delete from public.treasury_log      where created_at < now() - interval '90 days';
  delete from public.reports           where status = 'resolved' and created_at < now() - interval '90 days';
  delete from public.admin_log         where created_at < now() - interval '365 days';
  delete from public.rate_limits       where window_start < now() - interval '2 days';
  delete from public.mission_payouts   where created_at < now() - interval '60 days';
  delete from public.alliance_operations where started_at < now() - interval '60 days';
  delete from public.missions where status in ('completed', 'expired')
    and coalesce(completed_at, expires_at) < now() - interval '3 days'
    and not exists (select 1 from public.dispatches d where d.mission_id = missions.id);
$$;

-- ---------------------------------------------------------------------
-- 3. sync_player(), throttled
--    The browser checks in every 20 seconds and after each known event. A
--    script hammering this function would make the server redo the whole
--    settling routine each time; instead, a check-in less than a second
--    after the last one just gets the current picture back.
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

  return public.fc_snapshot(me, public.fc_sync(me));
end;
$$;

-- ---------------------------------------------------------------------
-- 4. The map survey, now rate-limited (revises the Phase 12 version)
-- ---------------------------------------------------------------------
create or replace function public.submit_map_features(p_base_id uuid, p_features jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  me   uuid := auth.uid();
  base public.bases;
  n    int;
begin
  if me is null then raise exception 'You must be logged in.'; end if;
  select * into base from public.bases where id = p_base_id and owner_id = me;
  if not found then raise exception 'That is not one of your bases.'; end if;
  if jsonb_typeof(p_features) <> 'array' then raise exception 'Expected a list of places.'; end if;
  perform public.fc_rate_limit('survey', 40, 3600);   -- at most 40 surveys an hour

  delete from public.map_features where base_id = base.id;
  insert into public.map_features (owner_id, base_id, kind, name, lat, lng)
  select me, base.id, f ->> 'kind',
         left(trim(regexp_replace(coalesce(f ->> 'name', ''), '[[:cntrl:]]', '', 'g')), 60),
         (f ->> 'lat')::double precision, (f ->> 'lng')::double precision
    from jsonb_array_elements(p_features) as f
   where f ->> 'kind' in ('bridge', 'airfield', 'rail', 'town', 'harbour')
     and (f ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (f ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
     -- only places genuinely in this base's neighbourhood
     and public.fc_distance_km(base.lat, base.lng, (f ->> 'lat')::double precision, (f ->> 'lng')::double precision) <= 160
   limit 200;
  get diagnostics n = row_count;

  update public.bases set scanned_at = now() where id = base.id;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------
revoke all on function public.fc_rate_limit(text, int, int) from public, anon, authenticated;
revoke all on function public.fc_maintenance() from public, anon, authenticated;
revoke all on function public.sync_player() from public, anon;
grant execute on function public.sync_player() to authenticated;
revoke all on function public.submit_map_features(uuid, jsonb) from public, anon;
grant execute on function public.submit_map_features(uuid, jsonb) to authenticated;
