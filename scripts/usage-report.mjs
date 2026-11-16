// Prints how much of the Supabase free tier the game is using, so you can
// see growth coming before it becomes a problem.
//
// Needs a Supabase access token (Dashboard → Account → Access Tokens):
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  npm run usage

import { SUPABASE_URL } from '../src/config.js';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Set SUPABASE_ACCESS_TOKEN first. See the comment at the top of scripts/usage-report.mjs.');
  process.exit(1);
}
const ref = new URL(process.env.FC_SUPABASE_URL ?? SUPABASE_URL).hostname.split('.')[0];

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const FREE_DB_MB = 500; // free-tier database allowance at the time of writing; check Supabase's pricing page

const [totals] = await sql(`
  select round(pg_database_size(current_database()) / 1048576.0, 1) as db_mb,
    (select count(*) from public.profiles) as players,
    (select count(*) from public.profiles where last_seen_at > now() - interval '1 day') as active_1d,
    (select count(*) from public.profiles where last_seen_at > now() - interval '7 days') as active_7d,
    (select count(*) from public.profiles where last_seen_at > now() - interval '2 minutes') as online_now,
    (select count(*) from public.alliances) as alliances,
    (select count(*) from public.bases) as bases,
    (select count(*) from public.units) as units,
    (select count(*) from public.missions where status in ('open', 'in_progress')) as live_missions,
    (select count(*) from public.alliance_messages) as chat_messages`);

const tables = await sql(`
  select c.relname as "table", round(pg_total_relation_size(c.oid) / 1048576.0, 2) as mb, c.reltuples::bigint as "rows (approx)"
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by pg_total_relation_size(c.oid) desc limit 10`);

console.log(`\nProject ${ref}`);
console.log(`Database: ${totals.db_mb} MB of about ${FREE_DB_MB} MB (${((totals.db_mb / FREE_DB_MB) * 100).toFixed(1)}%)`);
console.log(`Players: ${totals.players} total · ${totals.active_7d} active this week · ${totals.active_1d} today · ${totals.online_now} online now`);
console.log(`World: ${totals.alliances} alliances · ${totals.bases} bases · ${totals.units} units · ${totals.live_missions} live missions · ${totals.chat_messages} chat messages`);
console.log('\nLargest tables:');
console.table(tables);

// Plain-language warnings.
const notes = [];
if (totals.db_mb > FREE_DB_MB * 0.7) notes.push('The database is over 70% of the free allowance. See docs/OPERATIONS.md, "When you outgrow the free tier".');
if (totals.online_now > 120) notes.push('More than 120 players online at once: the free tier allows about 200 realtime connections.');
if (totals.active_7d === 0) notes.push('Nobody has played for a week. Free projects are paused after about 7 days without activity; log in to keep it awake.');
console.log(notes.length ? notes.map((n) => `! ${n}`).join('\n') : 'Nothing needs attention.');
