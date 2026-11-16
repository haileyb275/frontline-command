// Helpers for the database tests. These tests talk to a REAL Supabase
// project: they create throw-away players, play through the rules, and
// delete the players again.
//
// They need a Supabase access token (Dashboard → Account → Access Tokens)
// in the environment, because creating a confirmed test account and winding
// the clock forward both need direct SQL:
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  npm run test:db
//
// By default they run against the project in src/config.js. To use a
// separate test project instead (recommended once you have real players),
// also set FC_SUPABASE_URL and FC_SUPABASE_KEY.

import { randomBytes } from 'node:crypto';
import { SUPABASE_URL, SUPABASE_KEY } from '../../src/config.js';

const URL_BASE = process.env.FC_SUPABASE_URL ?? SUPABASE_URL;
const KEY = process.env.FC_SUPABASE_KEY ?? SUPABASE_KEY;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = new URL(URL_BASE).hostname.split('.')[0];

/** True when the tests can run; otherwise each file skips itself with a note. */
export const canRun = Boolean(TOKEN);
export const skipNote = 'set SUPABASE_ACCESS_TOKEN to run the database tests';

/** Run SQL directly on the database (bypasses every security rule: test set-up only). */
export async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function api(method, path, body, token) {
  const response = await fetch(URL_BASE + path, {
    method,
    headers: {
      apikey: KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

const created = [];

/**
 * Create a confirmed player and log in as them.
 * Returns an object with their id and helpers that act AS that player, with
 * only the rights a real browser would have.
 */
export async function createPlayer({ nation = null } = {}) {
  const tag = randomBytes(4).toString('hex');
  const email = `fc-test-${tag}@example.com`;
  const username = `T_${tag}`;
  const password = `Test-${tag}-pw`;
  // Insert straight into Supabase's auth tables, already confirmed, so no
  // email is sent. The game's own trigger then creates the profile row.
  await sql(`
    with u as (
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        '${email}', extensions.crypt('${password}', extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', '{"username":"${username}"}', now(), now(), '', '', '', '')
      returning id, email)
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), id, id::text, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
           'email', now(), now(), now() from u;`);
  created.push(email);

  const login = await api('POST', '/auth/v1/token?grant_type=password', { email, password });
  if (!login.ok) throw new Error(`login failed: ${JSON.stringify(login.data)}`);
  const token = login.data.access_token;
  const id = login.data.user.id;

  const player = {
    id,
    username,
    /** Call a server function as this player. Returns { ok, data, error }. */
    async rpc(name, args = {}) {
      const r = await api('POST', `/rest/v1/rpc/${name}`, args, token);
      return { ok: r.ok, data: r.ok ? r.data : null, error: r.ok ? null : (r.data?.message ?? String(r.data)) };
    },
    /** Call a server function and insist it works. */
    async must(name, args = {}) {
      const r = await player.rpc(name, args);
      if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
      return r.data;
    },
    /** Talk to a table directly, as a browser with dev tools could. */
    rest: (method, path, body) => api(method, `/rest/v1/${path}`, body, token),
    /** Check in. Winds last_seen back first so the one-second throttle never interferes. */
    async sync() {
      await sql(`update public.profiles set last_seen_at = now() - interval '1 minute' where id = '${id}'`);
      return player.must('sync_player');
    },
  };
  if (nation) await player.must('choose_nation', { p_nation_id: nation });
  return player;
}

/** Call with no login at all. */
export const anonRpc = async (name, args = {}) => {
  const r = await api('POST', `/rest/v1/rpc/${name}`, args);
  return { ok: r.ok, error: r.ok ? null : (r.data?.message ?? String(r.data)) };
};

/** Delete every player these tests created (and everything they owned). */
export async function cleanup() {
  if (created.length === 0) return;
  const list = created.map((e) => `'${e}'`).join(', ');
  await sql(`
    delete from public.alliances a where not exists (
      select 1 from public.alliance_members m join auth.users u on u.id = m.player_id
       where m.alliance_id = a.id and u.email not in (${list}));
    delete from public.admin_log where admin_name like 'T\\_%';
    delete from auth.users where email in (${list});`);
  created.length = 0;
}

/** A spot on land (near Caen, Normandy) plus small offsets for further bases. */
export const LAND = { lat: 49.18, lng: -0.37 };
