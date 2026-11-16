// Checks the small pieces of game arithmetic the browser shares with the
// server (prices, bonuses, travel time, experience, weather). No network.
//
// Run with:   npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUnitType, getBuilding, nationBonus, unitPrice, buildingPrice, distanceKm, travelSeconds,
  veterancy, rankTitle, researchYear, xpForLevel, convoySeconds, settings,
} from '../src/game/content.js';
import { weatherAt, isNight, travelSlowdown } from '../src/game/weather.js';
import { formatDuration } from '../src/game/clock.js';

test('nation bonuses apply only where they should', () => {
  assert.equal(nationBonus('ussr', 'cost_mult', 'armor'), 0.9);
  assert.equal(nationBonus('ussr', 'cost_mult', 'artillery'), 1);
  assert.equal(nationBonus('usa', 'reward_mult', 'supplies'), 1.1);
  assert.equal(nationBonus('usa', 'reward_mult', 'money'), 1);
  assert.equal(nationBonus('nowhere', 'cost_mult', 'armor'), 1);
});

test('prices include the nation discount', () => {
  assert.deepEqual(unitPrice(getUnitType('ussr_infantry'), 'ussr'), { money: 720, supplies: 18 });
  assert.deepEqual(unitPrice(getUnitType('usa_infantry'), 'usa'), { money: 800, supplies: 20 });
  assert.deepEqual(buildingPrice(getBuilding('hq'), 'france'), { money: 4500, supplies: 0 });
});

test('distances and travel times', () => {
  const london = { lat: 51.5074, lng: -0.1278 };
  const paris = { lat: 48.8566, lng: 2.3522 };
  assert.ok(Math.abs(distanceKm(london, paris) - 344) < 3, 'London–Paris is about 344 km');
  // 30 km at 30 km/h is an hour, compressed by the game's time scale.
  const base = { lat: 50, lng: 10 };
  const mission = { lat: 50 + 30 / 111.19, lng: 10 };
  const seconds = travelSeconds(getUnitType('usa_infantry'), base, mission, 'usa');
  assert.ok(Math.abs(seconds - 3600 / settings.travel_time_scale) <= 2);
  // A storm slows ground units, and never makes a trip shorter than the minimum.
  assert.ok(travelSeconds(getUnitType('usa_infantry'), base, mission, 'usa', null, null, 1.3) > seconds);
  assert.equal(travelSeconds(getUnitType('usa_air'), base, base, 'usa'), settings.min_travel_seconds);
  assert.ok(convoySeconds(london, paris) >= settings.min_convoy_seconds);
});

test('experience, ranks, levels and research', () => {
  assert.equal(veterancy(0).name, 'Green');
  assert.equal(veterancy(settings.veteran_missions_1).tier, 1);
  assert.equal(veterancy(settings.veteran_missions_3).name, 'Elite');
  assert.equal(veterancy(999).next, null);
  assert.equal(rankTitle(1), 'Second Lieutenant');
  assert.equal(rankTitle(4), 'Captain'); // between two titles: keep the lower one
  assert.equal(xpForLevel(2), 100);
  assert.equal(xpForLevel(5), 1600);
  const t = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(researchYear({ research_year: 1940 }, t), 1940);
  assert.equal(researchYear({ research_year: 1940, research_target: 1941, research_until: '2025-12-31T23:00:00Z' }, t), 1941);
  assert.equal(researchYear({ research_year: 1940, research_target: 1941, research_until: '2026-01-01T01:00:00Z' }, t), 1940);
});

test('weather and night match the figures the server gives', () => {
  // These were produced by fc_weather() and fc_is_night() on the database.
  // If either side's arithmetic changes, this fails.
  const at = (iso) => Date.parse(iso);
  assert.equal(weatherAt(49.2, -0.4, at('2026-11-17T12:00:00Z')), 'rain');
  assert.equal(weatherAt(35.0, 139.0, at('2026-11-17T12:00:00Z')), 'rain');
  assert.equal(isNight(0, at('2026-11-17T23:00:00Z')), true);
  assert.equal(isNight(139.7, at('2026-11-17T03:00:00Z')), false);
  // Roughly half the world is clear at any moment, and storms are rare.
  const counts = {};
  for (let lat = -60; lat <= 60; lat += 2) for (let lng = -180; lng < 180; lng += 2) {
    const w = weatherAt(lat, lng, at('2026-06-01T00:00:00Z'));
    counts[w] = (counts[w] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(counts.clear / total > 0.4 && counts.clear / total < 0.7, 'clear share out of range');
  assert.ok(counts.storm / total < 0.15, 'too many storms');
  assert.equal(travelSlowdown('storm', 'air'), 1);
  assert.equal(travelSlowdown('storm', 'ground'), settings.weather_storm_slow);
});

test('durations are formatted for people', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(75000), '1:15');
  assert.equal(formatDuration(3723000), '1:02:03');
  assert.equal(formatDuration(-5000), '0:00');
});
