// The core loop: nation, bases, units, missions, rewards, offline progress.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { canRun, skipNote, createPlayer, cleanup, sql, LAND } from './helpers.mjs';

after(cleanup);
const skip = !canRun && skipNote;

test('nation choice is permanent and pays the starting funds once', { skip }, async () => {
  const p = await createPlayer();
  assert.equal((await p.must('choose_nation', { p_nation_id: 'ussr' })).money, 20000);
  assert.match((await p.rpc('choose_nation', { p_nation_id: 'usa' })).error, /already chosen/);
  assert.match((await (await createPlayer()).rpc('choose_nation', { p_nation_id: 'atlantis' })).error, /Unknown nation/);
});

test('base rules: HQ first, one HQ, land only, spacing, level locks', { skip }, async () => {
  const p = await createPlayer({ nation: 'france' });
  const place = (type, dLat = 0, dLng = 0) =>
    p.rpc('place_base', { p_building_type: type, p_lat: LAND.lat + dLat, p_lng: LAND.lng + dLng });

  assert.match((await place('barracks')).error, /first base must be a Headquarters/);
  assert.match((await p.rpc('place_base', { p_building_type: 'hq', p_lat: 50.6, p_lng: 0.9 })).error, /on land/);
  const hq = await place('hq');
  assert.equal(hq.data.profile.money, 20000 - 4500, 'France pays 10% less for buildings');
  assert.equal(hq.data.base.stock, 250, 'a new base starts with a full stock');
  assert.match((await place('hq', 0.2)).error, /already have a Headquarters/);
  assert.match((await place('barracks', 0.001)).error, /Too close/);
  assert.match((await place('tank_depot', 0.2)).error, /unlocks at level 3/);
  assert.equal((await place('barracks', 0.1)).ok, true);
});

test('recruiting: own nation only, right building, capacity, research year', { skip }, async () => {
  const p = await createPlayer({ nation: 'germany' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const buy = (unit) => p.rpc('buy_unit', { p_base_id: hq.id, p_unit_type: unit });

  assert.equal((await buy('germany_infantry')).ok, true);
  assert.match((await buy('usa_infantry')).error, /another nation/);
  assert.match((await buy('germany_armor')).error, /cannot station/);
  assert.match((await buy('germany_recon_2')).error, /1941/, 'the BMW R75 needs 1941 research');
  for (let i = 0; i < 5; i++) await buy('germany_infantry');
  assert.match((await buy('germany_infantry')).error, /full/);
});

test('a mission: dispatch rules, payment once, experience, offline completion', { skip }, async () => {
  const p = await createPlayer({ nation: 'usa' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const buy = async (unit) => (await p.must('buy_unit', { p_base_id: hq.id, p_unit_type: unit })).unit.id;
  const inf = [await buy('usa_infantry'), await buy('usa_infantry')];
  const recon = await buy('usa_recon');

  // Put one known mission on the map (set-up, so done in SQL).
  await sql(`delete from public.missions where owner_id = '${p.id}';
    insert into public.missions (mission_type, owner_id, lat, lng, expires_at)
    values ('patrol_contact', '${p.id}', ${LAND.lat + 0.15}, ${LAND.lng}, now() + interval '3 hours');
    update public.game_config set value = 0 where key = 'damage_chance_per_difficulty';`);
  try {
    const mission = (await p.sync()).missions[0];
    assert.match((await p.rpc('dispatch_units', { p_mission_id: mission.id, p_unit_ids: [recon] })).error, /does not need/);
    assert.match((await p.rpc('dispatch_units', { p_mission_id: mission.id, p_unit_ids: ['00000000-0000-0000-0000-000000000001'] })).error, /not yours/);

    const sent = await p.must('dispatch_units', { p_mission_id: mission.id, p_unit_ids: inf });
    assert.equal(sent.missions[0].status, 'in_progress');
    assert.equal(sent.bases[0].stock, 250 - 2 * 2, 'two infantry units draw 2 supplies each from the base');
    assert.match((await p.rpc('dispatch_units', { p_mission_id: mission.id, p_unit_ids: inf })).error, /no longer open/);
    assert.match((await p.rpc('recall_units', { p_mission_id: mission.id })).error, /before a mission starts/);

    // "Go offline for an hour": move every timestamp of this mission into the past.
    await sql(`update public.missions set started_at = started_at - interval '1 hour', completes_at = completes_at - interval '1 hour' where id = '${mission.id}';
      update public.dispatches set departed_at = departed_at - interval '1 hour', arrives_at = arrives_at - interval '1 hour' where mission_id = '${mission.id}';`);
    const before = sent.profile;
    const back = await p.sync();
    const paid = back.events.filter((e) => e.type === 'mission_completed');
    assert.equal(paid.length, 1);
    assert.equal(back.profile.money, before.money + paid[0].money);
    assert.equal(back.profile.missions_completed, 1);
    assert.deepEqual(back.units.filter((u) => inf.includes(u.id)).map((u) => [u.status, u.missions_done]), [['idle', 1], ['idle', 1]]);
    assert.deepEqual((await p.sync()).events, [], 'a second check-in must not pay again');

    // The running totals behind daily orders moved too.
    const orders = await p.must('get_objectives');
    assert.equal(orders.today.missions, 1);
    assert.equal(orders.today.units_sent, 2);
  } finally {
    await sql(`update public.game_config set value = 0.04 where key = 'damage_chance_per_difficulty'`);
  }
});

test('check-ins closer than a second apart are answered without re-settling', { skip }, async () => {
  const p = await createPlayer({ nation: 'uk' });
  await p.must('sync_player');
  const second = await p.must('sync_player');   // immediately afterwards
  assert.deepEqual(second.events, []);
  assert.ok(second.profile, 'the current picture is still returned');
});
