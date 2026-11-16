// Runs SQL against the game's Supabase database from the command line, so
// nobody has to paste files into the dashboard.
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  node scripts/run-sql.mjs supabase/migrations/016_supply_chain.sql
//   SUPABASE_ACCESS_TOKEN=sbp_...  node scripts/run-sql.mjs --all        (every migration in order, then seed.sql)
//   echo "select count(*) from public.profiles" | SUPABASE_ACCESS_TOKEN=sbp_... node scripts/run-sql.mjs
//
// `npm run migrate` is the --all form. It is safe to repeat: every migration
// is written so that running it twice changes nothing.
//
// The token is a Supabase ACCESS TOKEN (Dashboard → Account → Access Tokens).
// It can manage your whole Supabase account: never commit it.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SUPABASE_URL } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Set SUPABASE_ACCESS_TOKEN first (see the comment at the top of this file).');
  process.exit(1);
}
const ref = new URL(process.env.FC_SUPABASE_URL ?? SUPABASE_URL).hostname.split('.')[0];

async function run(query, label) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`${label}: FAILED (${response.status})\n${text.slice(0, 600)}`);
    process.exit(1);
  }
  return text;
}

const args = process.argv.slice(2);
if (args[0] === '--all') {
  const dir = join(root, 'supabase/migrations');
  // Two passes. A later file sometimes adds a column that an earlier file's
  // revised function uses, so the first pass makes sure every table and
  // column exists, and the second leaves the newest version of every
  // function in place (the highest-numbered file always wins).
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const pass of [1, 2]) {
    for (const file of files) {
      await run(readFileSync(join(dir, file), 'utf8'), file);
      console.log(`pass ${pass}: ${file}`);
    }
  }
  await run(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'), 'seed.sql');
  console.log('seed.sql\nDone. (The coastline data in supabase/land/ is separate: see the README.)');
} else if (args[0]) {
  for (const file of args) {
    console.log(await run(readFileSync(file, 'utf8'), file) || `${file}: ok`);
  }
} else {
  console.log(await run(readFileSync(0, 'utf8'), 'stdin'));
}
