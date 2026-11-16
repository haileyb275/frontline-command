// Prints a table to help balance missions after you edit the JSON files.
//
// Run with:   npm run balance
//
// For each mission it estimates how long the units are tied up (typical
// travel there and back + the mission itself) and shows funds and XP earned
// per unit per minute. Rows far above or below their neighbours are worth a
// second look.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(readFileSync(join(root, 'src/data', name), 'utf8'));

const missions = read('missions.json');
const units = read('units.json');
const settings = read('settings.json');

// Average speed and cost of each category across all nations.
const average = (list, key) => list.reduce((sum, x) => sum + x[key], 0) / list.length;
const byCategory = {};
for (const unit of units) (byCategory[unit.category_id] ??= []).push(unit);
const speed = Object.fromEntries(Object.entries(byCategory).map(([c, list]) => [c, average(list, 'speed_kmh')]));
const cost = Object.fromEntries(Object.entries(byCategory).map(([c, list]) => [c, average(list, 'cost_money')]));

const rows = missions
  .map((m) => {
    const count = Object.values(m.requirements).reduce((a, b) => a + b, 0);
    const slowest = Math.min(...Object.keys(m.requirements).map((c) => speed[c]));
    const midKm = (m.min_km + m.max_km) / 2;
    const travel = Math.max(settings.min_travel_seconds, (midKm / slowest) * 3600 / settings.travel_time_scale);
    const minutes = (2 * travel + m.duration_seconds) / 60;
    const force = Object.entries(m.requirements).reduce((sum, [c, n]) => sum + cost[c] * n, 0);
    return {
      mission: m.id,
      level: m.min_level,
      units: count,
      'force cost': Math.round(force),
      minutes: +minutes.toFixed(1),
      funds: m.reward_money,
      'funds/unit/min': Math.round(m.reward_money / count / minutes),
      'xp/unit/min': +(m.reward_xp / count / minutes).toFixed(1),
      'payback %/min': +((m.reward_money / force / minutes) * 100).toFixed(1),
    };
  })
  .sort((a, b) => a.level - b.level || a.funds - b.funds);

console.table(rows);
