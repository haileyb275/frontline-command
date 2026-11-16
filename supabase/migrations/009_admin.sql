-- =====================================================================
-- Frontline Command — Phase 9: admin panel, moderation, public profiles
-- Run after 008_logistics.sql. Safe to run more than once.
--
-- SECURITY MODEL
--   * profiles.is_admin marks an administrator. Players cannot write to
--     the profiles table at all (see 001), so nobody can grant it to
--     themselves from the browser. You set it by hand in the Supabase SQL
--     Editor:   update public.profiles set is_admin = true where username = 'you';
--   * Every admin function starts by calling fc_require_admin(), which
--     stops with an error unless the CALLER's own row says is_admin.
--   * Everything an admin changes is written to admin_log.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns and tables
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_admin      boolean not null default false,
  add column if not exists is_banned     boolean not null default false,
  add column if not exists banned_reason text,
  add column if not exists muted_until   timestamptz;

create table if not exists public.admin_log (
  id            bigint generated always as identity primary key,
  admin_id      uuid,
  admin_name    text not null,
  action        text not null,
  target_id     uuid,
  target_name   text,
  details       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create table if not exists public.reports (
  id            bigint generated always as identity primary key,
  reporter_id   uuid references public.profiles (id) on delete set null,
  reporter_name text not null,
  target_id     uuid references public.profiles (id) on delete cascade,
  target_name   text not null,
  message_id    bigint,
  message_body  text,              -- a copy, in case the message is later deleted
  reason        text not null,
  status        text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by   text,
  created_at    timestamptz not null default now()
);

alter table public.admin_log enable row level security;   -- no policies: functions only
alter table public.reports   enable row level security;   -- no policies: functions only

-- ---------------------------------------------------------------------
-- 2. Guards
-- ---------------------------------------------------------------------
create or replace function public.fc_require_admin()
returns public.profiles
language plpgsql stable security definer set search_path = public
as $$
declare me public.profiles;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or not me.is_admin then
    raise exception 'Administrators only.';
  end if;
  return me;
end;
$$;

create or replace function public.fc_admin_log(
  p_admin public.profiles, p_action text, p_target uuid, p_details jsonb default '{}')
returns void language sql security definer set search_path = public
as $$
  insert into public.admin_log (admin_id, admin_name, action, target_id, target_name, details)
  values (p_admin.id, p_admin.username, p_action, p_target,
          (select username from public.profiles where id = p_target), p_details);
$$;

-- Called at the start of every check-in (see fc_sync_extras in 008).
create or replace function public.fc_assert_active(p_me uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_me;
  if p.is_banned then
    raise exception 'ACCOUNT_SUSPENDED: %', coalesce(nullif(p.banned_reason, ''), 'No reason was given.');
  end if;
end;
$$;

-- Called before a chat message is posted (see send_alliance_message in 004).
create or replace function public.fc_assert_can_chat(p_me uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_me;
  if p.is_banned then raise exception 'Your account is suspended.'; end if;
  if p.muted_until > now() then
    raise exception 'You are muted in chat until %.', to_char(p.muted_until at time zone 'UTC', 'DD Mon HH24:MI "UTC"');
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Public profiles: what any logged-in player may see about another.
--    Name, nation, progress, alliance, bases and units — like looking at
--    another player's page. Never funds, supplies, or account details.
-- ---------------------------------------------------------------------
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
    'bases', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', b.id, 'name', b.name, 'building_type', b.building_type, 'level', b.level,
                 'lat', b.lat, 'lng', b.lng, 'zone', b.zone,
                 'units', (select count(*) from public.units u where u.base_id = b.id))
               order by b.created_at)
               from public.bases b where b.owner_id = p.id), '[]'),
    'units', coalesce((select jsonb_agg(jsonb_build_object(
                 'unit_type', u.unit_type, 'specialty', u.specialty,
                 'missions_done', u.missions_done, 'base_id', u.base_id)
               order by u.created_at)
               from public.units u where u.owner_id = p.id), '[]'))
    from public.profiles p
   where lower(p.username) = lower(p_username) and p.nation_id is not null;
$$;

-- ---------------------------------------------------------------------
-- 4. Reports (any player can file one; admins read them)
-- ---------------------------------------------------------------------
create or replace function public.report_player(p_username text, p_reason text, p_message_id bigint default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     public.profiles;
  target public.profiles;
  msg    public.alliance_messages;
  v_reason text := left(trim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), 300);
begin
  select * into me from public.profiles where id = auth.uid();
  if not found then raise exception 'You must be logged in.'; end if;
  select * into target from public.profiles where lower(username) = lower(p_username);
  if not found then raise exception 'Player not found.'; end if;
  if target.id = me.id then raise exception 'You cannot report yourself.'; end if;
  if v_reason = '' then raise exception 'Please say what the problem is.'; end if;
  -- A brake on abuse of the report button itself.
  if (select count(*) from public.reports where reporter_id = me.id and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You have sent several reports recently. Please wait a while.';
  end if;

  if p_message_id is not null then
    -- Only a message the reporter can actually see (their own alliance's chat).
    select * into msg from public.alliance_messages
     where id = p_message_id and alliance_id = public.fc_my_alliance() and sender_id = target.id;
  end if;

  insert into public.reports (reporter_id, reporter_name, target_id, target_name, message_id, message_body, reason)
  values (me.id, me.username, target.id, target.username, msg.id, msg.body, v_reason);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Admin: looking things up
-- ---------------------------------------------------------------------
create or replace function public.admin_search_players(p_query text default '')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.fc_require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.last_seen_at desc)
      from (
        select p.id, p.username, p.nation_id, p.level, p.money, p.supplies,
               p.is_admin, p.is_banned, p.muted_until, p.last_seen_at,
               (select count(*) from public.bases b where b.owner_id = p.id) as bases,
               (select count(*) from public.units u where u.owner_id = p.id) as units
          from public.profiles p
         where coalesce(p_query, '') = '' or p.username ilike '%' || replace(replace(p_query, '%', ''), '_', '\_') || '%'
         order by p.last_seen_at desc
         limit 50) x), '[]');
end;
$$;

create or replace function public.admin_get_player(p_player_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.fc_require_admin();
  return (
    select jsonb_build_object(
      'profile', to_jsonb(p),
      'alliance', (select jsonb_build_object('id', a.id, 'name', a.name, 'tag', a.tag, 'role', m.role)
                     from public.alliance_members m join public.alliances a on a.id = m.alliance_id
                    where m.player_id = p.id),
      'bases', coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at)
                           from public.bases b where b.owner_id = p.id), '[]'),
      'units', coalesce((select jsonb_agg(to_jsonb(u) order by u.created_at)
                           from public.units u where u.owner_id = p.id), '[]'),
      'log', coalesce((select jsonb_agg(to_jsonb(l) order by l.id desc)
                         from (select * from public.admin_log where target_id = p.id order by id desc limit 20) l), '[]'))
      from public.profiles p where p.id = p_player_id);
end;
$$;

-- Reports, recent chat across all alliances, and the audit trail.
create or replace function public.admin_overview()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.fc_require_admin();
  return jsonb_build_object(
    'reports', coalesce((select jsonb_agg(to_jsonb(r) order by r.id desc)
                           from (select * from public.reports where status = 'open' order by id desc limit 50) r), '[]'),
    'messages', coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc)
                            from (select m.id, m.sender_id, m.sender_name, m.body, m.created_at,
                                         (select tag from public.alliances a where a.id = m.alliance_id) as alliance_tag
                                    from public.alliance_messages m
                                   where m.sender_id is not null
                                   order by m.id desc limit 60) x), '[]'),
    'log', coalesce((select jsonb_agg(to_jsonb(l) order by l.id desc)
                       from (select * from public.admin_log order by id desc limit 40) l), '[]'),
    'totals', jsonb_build_object(
      'players', (select count(*) from public.profiles),
      'active_today', (select count(*) from public.profiles where last_seen_at > now() - interval '1 day'),
      'alliances', (select count(*) from public.alliances),
      'bases', (select count(*) from public.bases),
      'units', (select count(*) from public.units)));
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Admin: changing things
-- ---------------------------------------------------------------------

-- Add to (or, with negative numbers, take from) a player's funds, supplies and XP.
create or replace function public.admin_adjust_player(
  p_player_id uuid, p_money bigint default 0, p_supplies bigint default 0, p_xp bigint default 0,
  p_reason text default '')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  p     public.profiles;
begin
  -- greatest(0, …) so taking away more than they have leaves zero, not a negative balance.
  update public.profiles
     set money    = greatest(0, money + coalesce(p_money, 0)),
         supplies = greatest(0, supplies + coalesce(p_supplies, 0)),
         xp       = greatest(0, xp + coalesce(p_xp, 0))
   where id = p_player_id
  returning * into p;
  if not found then raise exception 'Player not found.'; end if;
  -- Level follows XP in both directions here (normal play only ever raises it).
  update public.profiles set level = public.fc_level_for_xp(p.xp) where id = p.id;

  perform public.fc_admin_log(admin, 'adjust', p.id, jsonb_build_object(
    'money', p_money, 'supplies', p_supplies, 'xp', p_xp, 'reason', left(coalesce(p_reason, ''), 200)));
  return public.admin_get_player(p.id);
end;
$$;

create or replace function public.admin_set_ban(p_player_id uuid, p_banned boolean, p_reason text default '')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin  public.profiles := public.fc_require_admin();
  target public.profiles;
begin
  select * into target from public.profiles where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  if target.is_admin and p_banned then raise exception 'Administrators cannot be suspended.'; end if;

  update public.profiles
     set is_banned = coalesce(p_banned, false),
         banned_reason = case when p_banned then left(coalesce(p_reason, ''), 200) end
   where id = p_player_id;
  perform public.fc_admin_log(admin, case when p_banned then 'suspend' else 'unsuspend' end, p_player_id,
                              jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)));
  return public.admin_get_player(p_player_id);
end;
$$;

-- Mute in chat for a number of minutes (0 lifts the mute).
create or replace function public.admin_set_mute(p_player_id uuid, p_minutes int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare admin public.profiles := public.fc_require_admin();
begin
  update public.profiles
     set muted_until = case when coalesce(p_minutes, 0) > 0
                            then now() + make_interval(mins => least(p_minutes, 525600)) end
   where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  perform public.fc_admin_log(admin, 'mute', p_player_id, jsonb_build_object('minutes', p_minutes));
  return public.admin_get_player(p_player_id);
end;
$$;

create or replace function public.admin_rename_player(p_player_id uuid, p_username text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  old_name text;
begin
  if p_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Names must be 3–20 letters, numbers or underscores.';
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_username) and id <> p_player_id) then
    raise exception 'That name is taken.';
  end if;
  select username into old_name from public.profiles where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  update public.profiles set username = p_username where id = p_player_id;
  perform public.fc_admin_log(admin, 'rename', p_player_id, jsonb_build_object('from', old_name, 'to', p_username));
  return public.admin_get_player(p_player_id);
end;
$$;

create or replace function public.admin_delete_base(p_base_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  base  public.bases;
begin
  -- Deleting a base also deletes the units stationed there (and recalls
  -- nothing: units out on a mission simply disappear from it).
  delete from public.bases where id = p_base_id returning * into base;
  if not found then raise exception 'Base not found.'; end if;
  perform public.fc_admin_log(admin, 'delete_base', base.owner_id,
    jsonb_build_object('base', base.name, 'type', base.building_type));
  return public.admin_get_player(base.owner_id);
end;
$$;

create or replace function public.admin_move_base(p_base_id uuid, p_lat double precision, p_lng double precision)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  base  public.bases;
begin
  if p_lat is null or p_lng is null or p_lat not between -85 and 85 or p_lng not between -180 and 180 then
    raise exception 'That position is not on the map.';
  end if;
  if not public.fc_is_land(p_lat, p_lng) then raise exception 'Bases must be on land.'; end if;
  select * into base from public.bases where id = p_base_id;
  if not found then raise exception 'Base not found.'; end if;

  update public.bases set lat = p_lat, lng = p_lng where id = p_base_id;
  perform public.fc_admin_log(admin, 'move_base', base.owner_id, jsonb_build_object(
    'base', base.name, 'from', jsonb_build_array(base.lat, base.lng), 'to', jsonb_build_array(p_lat, p_lng)));
  return public.admin_get_player(base.owner_id);
end;
$$;

create or replace function public.admin_delete_unit(p_unit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  unit  public.units;
begin
  delete from public.units where id = p_unit_id returning * into unit;
  if not found then raise exception 'Unit not found.'; end if;
  perform public.fc_admin_log(admin, 'delete_unit', unit.owner_id, jsonb_build_object('unit_type', unit.unit_type));
  return public.admin_get_player(unit.owner_id);
end;
$$;

-- Move a unit to another base belonging to the same player, at once.
create or replace function public.admin_move_unit(p_unit_id uuid, p_base_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  unit  public.units;
  dest  public.bases;
begin
  select * into unit from public.units where id = p_unit_id;
  if not found then raise exception 'Unit not found.'; end if;
  select * into dest from public.bases where id = p_base_id and owner_id = unit.owner_id;
  if not found then raise exception 'The destination must be one of the same player''s bases.'; end if;
  if unit.status <> 'idle' then raise exception 'Only an idle unit can be moved.'; end if;
  if not ((select unlocks_categories from public.building_types where id = dest.building_type)
          ? (select category_id from public.unit_types where id = unit.unit_type)) then
    raise exception 'That building cannot station this kind of unit.';
  end if;

  update public.units set base_id = dest.id where id = unit.id;
  perform public.fc_admin_log(admin, 'move_unit', unit.owner_id,
    jsonb_build_object('unit_type', unit.unit_type, 'to', dest.name));
  return public.admin_get_player(unit.owner_id);
end;
$$;

create or replace function public.admin_delete_message(p_message_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  msg   public.alliance_messages;
begin
  delete from public.alliance_messages where id = p_message_id returning * into msg;
  if not found then raise exception 'Message not found.'; end if;
  perform public.fc_admin_log(admin, 'delete_message', msg.sender_id, jsonb_build_object('body', msg.body));
end;
$$;

create or replace function public.admin_resolve_report(p_report_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare admin public.profiles := public.fc_require_admin();
begin
  update public.reports set status = 'resolved', resolved_by = admin.username where id = p_report_id;
  if not found then raise exception 'Report not found.'; end if;
end;
$$;

create or replace function public.admin_disband_alliance(p_alliance_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  admin public.profiles := public.fc_require_admin();
  al    public.alliances;
begin
  update public.missions set alliance_id = null where alliance_id = p_alliance_id;
  delete from public.alliances where id = p_alliance_id returning * into al;
  if not found then raise exception 'Alliance not found.'; end if;
  perform public.fc_admin_log(admin, 'disband_alliance', null, jsonb_build_object('name', al.name, 'tag', al.tag));
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Permissions
--    Admin functions are callable by any logged-in player at the API
--    level, but each one refuses unless the caller is an administrator.
-- ---------------------------------------------------------------------
revoke all on function public.fc_require_admin() from public, anon, authenticated;
revoke all on function public.fc_admin_log(public.profiles, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fc_assert_active(uuid) from public, anon, authenticated;
revoke all on function public.fc_assert_can_chat(uuid) from public, anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'get_player_profile(text)', 'report_player(text, text, bigint)',
    'admin_search_players(text)', 'admin_get_player(uuid)', 'admin_overview()',
    'admin_adjust_player(uuid, bigint, bigint, bigint, text)', 'admin_set_ban(uuid, boolean, text)',
    'admin_set_mute(uuid, int)', 'admin_rename_player(uuid, text)',
    'admin_delete_base(uuid)', 'admin_move_base(uuid, double precision, double precision)',
    'admin_delete_unit(uuid)', 'admin_move_unit(uuid, uuid)', 'admin_delete_message(bigint)',
    'admin_resolve_report(bigint)', 'admin_disband_alliance(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
