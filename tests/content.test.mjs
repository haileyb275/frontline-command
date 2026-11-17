// Checks that the content files in src/data/ are consistent with each other.
// Needs no network and no accounts, so it runs on every push (see
// .github/workflows/deploy.yml) and stops a broken edit from being deployed.
//
// Run with:   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  nations, categories, buildings, units, missions, specialties, products, dailyOrders,
  objectives, research, operations, allianceBuildings, ranks, settings,
} from '../src/game/content.js';

const ids = (list) => list.map((x) => x.id);
const categoryIds = new Set(ids(categories));
const specialtyIds = new Set(ids(specialties));
const buildingIds = new Set(ids(buildings));
const missionIds = new Set(ids(missions));

/** Fail with a readable list instead of stopping at the first problem. */
function expectNone(problems, what) {
  assert.deepEqual(problems, [], `${what}:\n  ${problems.join('\n  ')}`);
}

test('ids are unique in every file', () => {
  for (const [name, list] of Object.entries({ nations, categories, buildings, units, missions, specialties,
    products, dailyOrders, objectives, operations, allianceBuildings })) {
    const seen = new Set();
    const dupes = ids(list).filter((id) => seen.size === seen.add(id).size);
    expectNone(dupes, `duplicate ids in ${name}`);
  }
});

test('units point at a real nation and category, with sensible numbers', () => {
  const nationIds = new Set(ids(nations));
  const problems = [];
  for (const u of units) {
    if (!nationIds.has(u.nation_id)) problems.push(`${u.id}: unknown nation ${u.nation_id}`);
    if (!categoryIds.has(u.category_id)) problems.push(`${u.id}: unknown category ${u.category_id}`);
    if (!(u.cost_money > 0 && u.speed_kmh > 0 && u.power > 0)) problems.push(`${u.id}: cost, speed and power must be above zero`);
    if (!(u.year >= 1939 && u.year <= 1945)) problems.push(`${u.id}: year ${u.year} is outside 1939–1945`);
    if (!u.note || u.note.length < 15) problems.push(`${u.id}: needs a historical note`);
    if (!/^[a-z_]+$/.test(u.icon ?? '')) problems.push(`${u.id}: needs an icon key`);
  }
  expectNone(problems, 'unit problems');
});

test('every nation can field every category from 1939', () => {
  const problems = [];
  for (const nation of nations) {
    for (const cat of categories) {
      if (!units.some((u) => u.nation_id === nation.id && u.category_id === cat.id && u.year === 1939)) {
        problems.push(`${nation.name} has no 1939 ${cat.name} unit`);
      }
    }
  }
  expectNone(problems, 'gaps in the rosters');
});

test('buildings: one headquarters, and every category has a home', () => {
  assert.equal(buildings.filter((b) => b.is_hq).length, 1, 'there must be exactly one Headquarters building');
  const problems = [];
  for (const b of buildings) {
    for (const c of b.unlocks_categories) if (!categoryIds.has(c)) problems.push(`${b.id} unlocks unknown category ${c}`);
    if (!['front', 'home'].includes(b.default_zone)) problems.push(`${b.id}: default_zone must be front or home`);
  }
  for (const c of categoryIds) {
    if (!buildings.some((b) => b.unlocks_categories.includes(c))) problems.push(`no building stations ${c} units`);
  }
  expectNone(problems, 'building problems');
});

test('missions ask only for things that exist', () => {
  const problems = [];
  for (const m of missions) {
    for (const [key, count] of Object.entries(m.requirements)) {
      if (!categoryIds.has(key) && !specialtyIds.has(key)) problems.push(`${m.id} requires unknown "${key}"`);
      if (!(Number.isInteger(count) && count > 0)) problems.push(`${m.id}: requirement ${key} must be a whole number above zero`);
    }
    for (const f of m.followups) {
      if (!missionIds.has(f.mission)) problems.push(`${m.id} follows up with unknown mission ${f.mission}`);
      if (!(f.chance > 0 && f.chance <= 1)) problems.push(`${m.id}: follow-up chance must be between 0 and 1`);
    }
    if (!['land', 'water', 'any'].includes(m.terrain)) problems.push(`${m.id}: bad terrain ${m.terrain}`);
    if (!['contact', 'front', 'any'].includes(m.zone_rule)) problems.push(`${m.id}: bad zone_rule ${m.zone_rule}`);
    if (![null, 'bridge', 'airfield', 'rail', 'town', 'harbour'].includes(m.site)) problems.push(`${m.id}: bad site ${m.site}`);
    if (!(m.min_km >= 0 && m.max_km > m.min_km)) problems.push(`${m.id}: max_km must be greater than min_km`);
    if (!(m.duration_seconds > 0 && m.reward_money >= 0 && m.spawn_weight >= 0)) problems.push(`${m.id}: bad duration, reward or weight`);
  }
  expectNone(problems, 'mission problems');
});

test('specialties, products and research refer to real things', () => {
  const problems = [];
  for (const s of specialties) {
    for (const c of s.category_ids) if (!categoryIds.has(c)) problems.push(`specialty ${s.id}: unknown category ${c}`);
    if (categoryIds.has(s.id)) problems.push(`specialty ${s.id} has the same id as a category`);
  }
  for (const p of products) if (!buildingIds.has(p.building_type)) problems.push(`product ${p.id}: unknown building ${p.building_type}`);
  const latest = Math.max(...units.map((u) => u.year));
  for (let year = 1940; year <= latest; year++) {
    if (!research.some((r) => r.year === year)) problems.push(`units exist for ${year} but research.json has no step for it`);
  }
  expectNone(problems, 'problems');
});

test('orders, campaigns and operations watch totals the server actually keeps', () => {
  // The running totals written by fc_on_mission_complete(), plus the ones
  // fc_counters() reads straight from the player's state.
  const known = new Set(['missions', 'units_sent', 'missions_hard', 'missions_water', 'missions_shared',
    'level', 'bases', 'units', 'specialists', 'elite_units', 'naval_units', 'factories', 'training_centers', 'in_alliance']);
  const ok = (counter) => known.has(counter) ||
    (counter.startsWith('missions_cat_') && (categoryIds.has(counter.slice(13)) || specialtyIds.has(counter.slice(13))));
  const problems = [];
  for (const d of dailyOrders) {
    if (!ok(d.counter)) problems.push(`daily order ${d.id}: unknown counter ${d.counter}`);
    if (d.requires_category && !categoryIds.has(d.requires_category)) problems.push(`daily order ${d.id}: unknown category`);
  }
  for (const o of objectives) for (const s of o.steps) if (!ok(s.counter)) problems.push(`objective ${o.id}: unknown counter ${s.counter}`);
  for (const o of operations) if (!ok(o.counter)) problems.push(`operation ${o.id}: unknown counter ${o.counter}`);
  // Anyone must always be able to be dealt three daily orders.
  const always = dailyOrders.filter((d) => d.min_level <= 1 &&
    (!d.requires_category || buildings.find((b) => b.is_hq).unlocks_categories.includes(d.requires_category)));
  if (always.length < 3) problems.push('fewer than three daily orders are possible for a new player with only a Headquarters');
  expectNone(problems, 'problems');
});

test('ranks start at level 1 and settings are numbers', () => {
  assert.ok(ranks.some((r) => r.level === 1), 'ranks.json needs a title for level 1');
  const bad = Object.entries(settings).filter(([, v]) => typeof v !== 'number').map(([k]) => k);
  expectNone(bad, 'settings that are not numbers');
});

test('supabase/seed.sql matches the JSON files', () => {
  // The server reads its copy of the content from seed.sql. If someone edits
  // JSON and forgets `npm run seed`, the browser and the server disagree.
  const file = new URL('../supabase/seed.sql', import.meta.url);
  const before = readFileSync(file, 'utf8');
  execFileSync(process.execPath, ['scripts/build-seed.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'ignore' });
  const after = readFileSync(file, 'utf8');
  assert.equal(before, after,
    'seed.sql was out of date. It has just been regenerated: commit it, and run it in the Supabase SQL Editor.');
});

test('historical operations use real missions the player is senior enough for', async () => {
  const { history } = await import('../src/game/content.js');
  const problems = [];
  for (const op of history) {
    if (op.steps.length < 2) problems.push(`${op.id}: needs at least two steps`);
    for (const step of op.steps) {
      const type = missions.find((m) => m.id === step.mission);
      if (!type) problems.push(`${op.id}: unknown mission ${step.mission}`);
      else if (type.min_level > op.min_level) problems.push(`${op.id}: ${step.mission} needs level ${type.min_level}`);
      else if (Object.keys(type.requirements).some((k) => !categories.find((c) => c.id === k))) problems.push(`${op.id}: ${step.mission} needs a specialty`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every translation is a non-empty string that differs in shape only', async () => {
  const { LANGUAGES } = await import('../src/i18n.js');
  for (const [code, lang] of Object.entries(LANGUAGES)) {
    for (const [english, translated] of Object.entries(lang.words ?? {})) {
      assert.ok(typeof translated === 'string' && translated.trim(), `${code}: "${english}" has no translation`);
      assert.ok(!/[<>]/.test(translated), `${code}: "${english}" must be plain text`);
    }
  }
});
