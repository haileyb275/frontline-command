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
  upsert(
    'unit_categories',
    ['id', 'name', 'icon', 'sort', 'base_power', 'supply_use', 'recovers_at', 'domain'],
    readJson('categories.json')
  ),
  upsert(
    'building_types',
    ['id', 'name', 'icon', 'description', 'cost_money', 'cost_supplies', 'unit_capacity',
     'unlocks_categories', 'min_level', 'is_hq', 'sort', 'requires_coast', 'training_slots',
     'default_zone', 'stock_capacity'],
    readJson('buildings.json')
  ),
  upsert(
    'unit_types',
    ['id', 'nation_id', 'category_id', 'name', 'cost_money', 'cost_supplies', 'speed_kmh',
     'power', 'min_level', 'year'],
    readJson('units.json')
  ),
  upsert(
    'mission_types',
    ['id', 'name', 'description', 'requirements', 'duration_seconds', 'reward_money',
     'reward_supplies', 'reward_xp', 'difficulty', 'min_level', 'spawn_weight', 'shareable',
     'followups', 'expires_seconds', 'terrain', 'min_km', 'max_km', 'zone_rule', 'site'],
    readJson('missions.json')
  ),
  upsert(
    'specialties',
    ['id', 'name', 'icon', 'category_ids', 'description', 'cost_money', 'cost_supplies',
     'training_seconds', 'power_mult', 'speed_mult', 'base_power', 'min_level', 'names', 'sort'],
    readJson('specialties.json')
  ),
  upsert(
    'products',
    ['id', 'name', 'building_type', 'duration_seconds', 'cost_money', 'cost_supplies',
     'output_money', 'output_supplies', 'min_level', 'sort'],
    readJson('products.json')
  ),
  upsert(
    'daily_order_types',
    ['id', 'text', 'counter', 'target', 'reward_money', 'reward_supplies', 'reward_xp', 'min_level',
     'requires_category'],
    readJson('daily_orders.json')
  ),
  upsert(
    'objectives',
    ['id', 'kind', 'name', 'description', 'steps', 'reward_money', 'reward_supplies', 'reward_xp', 'sort'],
    readJson('objectives.json')
  ),
  upsert('research_levels', ['year', 'cost_money', 'cost_supplies', 'seconds', 'min_level'], readJson('research.json')),
  upsert(
    'operation_types',
    ['id', 'name', 'description', 'goal_text', 'counter', 'target', 'hours', 'cost', 'reward_money',
     'reward_supplies', 'reward_xp', 'alliance_xp', 'sort'],
    readJson('operations.json')
  ),
  // settings.json is one object; the table wants one row per setting.
  upsert(
    'game_config',
    ['key', 'value'],
    Object.entries(readJson('settings.json')).map(([key, value]) => ({ key, value }))
  ),
  upsert(
    'alliance_building_types',
    ['id', 'name', 'description', 'cost', 'max_level', 'bonus', 'sort'],
    readJson('alliance_buildings.json')
  ),
];

const outFile = join(root, 'supabase/seed.sql');
writeFileSync(outFile, parts.join('\n'));
console.log(`Wrote ${outFile}`);
