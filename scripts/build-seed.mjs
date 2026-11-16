// Turns the JSON content files in src/data/ into supabase/seed.sql.
//
// Why: the SERVER needs to know the game content too (so it can check prices
// and rewards itself instead of trusting the browser). The JSON files are the
// single source of truth; this script copies them into SQL.
//
// Run it with:   npm run seed
// Then paste supabase/seed.sql into the Supabase SQL Editor and run it.
// The SQL uses "upsert", so re-running it updates existing rows.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(readFileSync(join(root, 'src/data', name), 'utf8'));

/** Turn a JS value into a safe SQL literal. */
function sql(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return `${sql(JSON.stringify(value))}::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`; // escape single quotes
}

/**
 * Build one "insert ... on conflict do update" statement.
 * @param {string} table
 * @param {string[]} columns   first column must be the primary key
 * @param {object[]} rows
 */
function upsert(table, columns, rows) {
  const values = rows
    .map((row) => `  (${columns.map((c) => sql(row[c])).join(', ')})`)
    .join(',\n');
  const updates = columns
    .slice(1)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return (
    `insert into public.${table} (${columns.join(', ')}) values\n${values}\n` +
    `on conflict (${columns[0]}) do update set ${updates};\n`
  );
}

const parts = [
  '-- GENERATED FILE — do not edit by hand.',
  '-- Edit the JSON files in src/data/ and run `npm run seed` instead.',
  '',
  upsert('nations', ['id', 'name', 'short', 'color', 'bonuses'], readJson('nations.json')),
  // Later phases add: unit_categories, unit_types, building_types, mission_types…
];

const outFile = join(root, 'supabase/seed.sql');
writeFileSync(outFile, parts.join('\n'));
console.log(`Wrote ${outFile}`);
