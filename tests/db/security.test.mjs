// Can a player cheat by going around the game and talking to the database
// directly? Every check here is something a browser's dev tools could try.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { canRun, skipNote, createPlayer, anonRpc, cleanup, sql, LAND } from './helpers.mjs';

after(cleanup);

test('visitors who are not logged in can do nothing', { skip: !canRun && skipNote }, async () => {
  for (const fn of ['sync_player', 'get_leaderboard', 'get_objectives', 'admin_overview']) {
    const r = await anonRpc(fn);
    assert.equal(r.ok, false, `${fn} should refuse an anonymous caller`);
  }
});

test('a player cannot edit their own account or create things directly', { skip: !canRun && skipNote }, async () => {
  const p = await createPlayer({ nation: 'usa' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;

  // Row-level security makes these updates match zero rows.
  for (const patch of [{ money: 999999999 }, { xp: 999999 }, { is_admin: true }, { research_year: 1945 }]) {
    const r = await p.rest('PATCH', `profiles?id=eq.${p.id}`, patch);
    assert.deepEqual(r.data, [], `changing ${Object.keys(patch)} directly should affect nothing`);
  }
  const [row] = await sql(`select money, xp, is_admin, research_year from public.profiles where id = '${p.id}'`);
  assert.deepEqual(row, { money: 15000, xp: 0, is_admin: false, research_year: 1939 });

  assert.equal((await p.rest('POST', 'units', { owner_id: p.id, base_id: hq.id, unit_type: 'usa_air' })).ok, false);
  assert.equal((await p.rest('POST', 'objective_claims', { player_id: p.id, objective_id: 'a_1000' })).ok, false);
  assert.deepEqual((await p.rest('DELETE', `bases?id=eq.${hq.id}`)).data, []);
});

test('a player sees only their own rows', { skip: !canRun && skipNote }, async () => {
  const a = await createPlayer({ nation: 'uk' });
  const b = await createPlayer({ nation: 'germany' });
  await b.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat - 0.3, p_lng: LAND.lng });

  const profiles = (await a.rest('GET', 'profiles?select=id')).data;
  assert.deepEqual(profiles.map((r) => r.id), [a.id]);
  assert.deepEqual((await a.rest('GET', 'bases?select=id')).data, []);
  for (const table of ['admin_log', 'reports', 'player_counters', 'mission_payouts', 'season_scores', 'rate_limits']) {
    assert.deepEqual((await a.rest('GET', `${table}?select=*`)).data, [], `${table} should be invisible to players`);
  }
});

test('internal and admin functions are closed to ordinary players', { skip: !canRun && skipNote }, async () => {
  const p = await createPlayer({ nation: 'italy' });
  for (const [fn, args] of [
    ['fc_sync', { p_me: p.id }], ['fc_grant', { p_player: p.id, p_money: 1, p_supplies: 1, p_xp: 1 }],
    ['fc_bump', { p_player: p.id, p_key: 'missions', p_amount: 100 }],
    ['admin_adjust_player', { p_player_id: p.id, p_money: 1000000 }], ['admin_search_players', {}],
  ]) {
    assert.equal((await p.rpc(fn, args)).ok, false, `${fn} should be refused`);
  }
});

test('public profiles show bases and units but never funds', { skip: !canRun && skipNote }, async () => {
  const a = await createPlayer({ nation: 'japan' });
  const b = await createPlayer({ nation: 'france' });
  await b.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat - 0.6, p_lng: LAND.lng });
  const profile = await a.must('get_player_profile', { p_username: b.username });
  assert.equal(profile.bases.length, 1);
  assert.equal(JSON.stringify(profile).includes('money'), false);
  assert.equal(JSON.stringify(profile).includes('supplies'), false);
});
