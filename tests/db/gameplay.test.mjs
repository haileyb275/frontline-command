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

test('an unconfirmed report hides what it is until a scout has looked', { skip }, async () => {
  const p = await createPlayer({ nation: 'uk' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const buy = async (unit) => (await p.must('buy_unit', { p_base_id: hq.id, p_unit_type: unit })).unit.id;
  const infantry = await buy('uk_infantry');
  const recon = await buy('uk_recon');
  await sql(`delete from public.missions where owner_id = '${p.id}';
    insert into public.missions (mission_type, owner_id, lat, lng, expires_at, confirmed)
    values ('patrol_contact', '${p.id}', ${LAND.lat - 0.15}, ${LAND.lng}, now() + interval '3 hours', false);`);

  const mission = (await p.sync()).missions[0];
  assert.equal(mission.mission_type, 'unconfirmed_report', 'the snapshot must not reveal the real type');
  assert.deepEqual((await p.rest('GET', 'missions?select=mission_type')).data, [], 'nor may the table');
  assert.match((await p.rpc('dispatch_units', { p_mission_id: mission.id, p_unit_ids: [infantry] })).error, /unconfirmed/);
  assert.match((await p.rpc('scout_mission', { p_mission_id: mission.id, p_unit_id: infantry })).error, /Only reconnaissance/);

  await p.must('scout_mission', { p_mission_id: mission.id, p_unit_id: recon });
  assert.equal((await p.sync()).missions[0].mission_type, 'unconfirmed_report', 'still hidden while the scout is on the way');
  await sql(`update public.missions set confirm_at = now() - interval '1 second' where id = '${mission.id}'`);
  assert.equal((await p.sync()).missions[0].mission_type, 'patrol_contact');
});

test('the front moves out when contact is won and back when it is ignored', { skip }, async () => {
  const p = await createPlayer({ nation: 'usa' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  assert.equal(Number(hq.front_km), 15);
  // Contact that nobody answered and that has just run out of time.
  await sql(`delete from public.missions where owner_id = '${p.id}';
    insert into public.missions (mission_type, owner_id, lat, lng, expires_at)
    values ('patrol_contact', '${p.id}', ${LAND.lat - 0.15}, ${LAND.lng}, now() - interval '1 second');`);
  assert.equal(Number((await p.sync()).bases[0].front_km), 13, 'ignored contact costs 2 km');

  // An offensive nobody stopped puts the base out of action.
  await sql(`insert into public.missions (mission_type, owner_id, lat, lng, expires_at, target_base_id)
    values ('offensive_probe', '${p.id}', ${LAND.lat - 0.04}, ${LAND.lng}, now() - interval '1 second', '${hq.id}');`);
  const after = (await p.sync()).bases[0];
  assert.equal(Number(after.front_km), 8, 'the front cannot fall below its minimum');
  assert.ok(new Date(after.disabled_until) > new Date(), 'the base is out of action for a while');
});

test('divisions fight harder together, and a refit keeps a unit\'s experience', { skip }, async () => {
  const p = await createPlayer({ nation: 'germany' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const buy = async (unit) => (await p.must('buy_unit', { p_base_id: hq.id, p_unit_type: unit })).unit.id;
  const a = await buy('germany_infantry');
  const b = await buy('germany_infantry');

  const division = await p.must('create_division', { p_name: 'Test Division' });
  assert.match((await p.rpc('create_division', { p_name: 'Another' })).error, /can command 1 division/);
  await p.must('assign_division', { p_unit_id: a, p_division_id: division });
  await p.must('assign_division', { p_unit_id: b, p_division_id: division });

  const freshMission = async () => {
    await sql(`delete from public.dispatches where player_id = '${p.id}'; delete from public.missions where owner_id = '${p.id}';
      update public.units set status = 'idle' where owner_id = '${p.id}';
      insert into public.missions (mission_type, owner_id, lat, lng, expires_at)
      values ('patrol_contact', '${p.id}', ${LAND.lat - 0.15}, ${LAND.lng}, now() + interval '3 hours');`);
    return (await p.sync()).missions[0].id;
  };
  const powers = async () =>
    (await p.must('dispatch_units', { p_mission_id: await freshMission(), p_unit_ids: [a, b] }))
      .dispatches.map((d) => Number(d.power));

  assert.deepEqual(await powers(), [10, 10], 'no command unit attached: no bonus');
  await sql(`update public.profiles set level = 2, xp = 100 where id = '${p.id}'`);   // command units need level 2
  await p.must('assign_division', { p_unit_id: await buy('germany_command'), p_division_id: division });
  assert.deepEqual(await powers(), [10.5, 10.5], 'with a command unit: +5% each');

  // Refit: only own nation, same branch; experience survives.
  await sql(`delete from public.dispatches where player_id = '${p.id}'; delete from public.missions where owner_id = '${p.id}';
    update public.units set status = 'idle', missions_done = 12 where id = '${a}';`);
  assert.match((await p.rpc('refit_unit', { p_unit_id: a, p_unit_type: 'usa_infantry' })).error, /own nation/);
  assert.match((await p.rpc('refit_unit', { p_unit_id: a, p_unit_type: 'germany_recon' })).error, /same branch/);
  const refitted = (await p.must('refit_unit', { p_unit_id: a, p_unit_type: 'germany_infantry_2' })).units.find((u) => u.id === a);
  assert.deepEqual([refitted.unit_type, refitted.missions_done, refitted.status, refitted.division_id],
    ['germany_infantry_2', 12, 'repairing', division]);
});

test('fuel speeds vehicles, the market cannot be milked, and a base can be moved', { skip }, async () => {
  const p = await createPlayer({ nation: 'usa' });
  const hq = (await p.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const recon = (await p.must('buy_unit', { p_base_id: hq.id, p_unit_type: 'usa_recon' })).unit.id;
  const scout2 = (await p.must('buy_unit', { p_base_id: hq.id, p_unit_type: 'usa_recon' })).unit.id;

  // One unit's worth of fuel: the first scout is fuelled, the second is not.
  await sql(`update public.profiles set fuel = 2 where id = '${p.id}';
    delete from public.missions where owner_id = '${p.id}';
    insert into public.missions (mission_type, owner_id, lat, lng, expires_at)
    values ('recon_sweep', '${p.id}', ${LAND.lat - 0.2}, ${LAND.lng}, now() + interval '3 hours');`);
  const mission = (await p.sync()).missions[0];
  const sent = await p.must('dispatch_units', { p_mission_id: mission.id, p_unit_ids: [recon, scout2] });
  const [fast, slow] = sent.dispatches.map((d) => d.travel_seconds).sort((a, b) => a - b);
  assert.deepEqual(sent.dispatches.map((d) => d.fuelled).sort(), [false, true]);
  assert.ok(fast < slow, 'the fuelled unit gets there sooner');
  assert.equal(sent.profile.fuel, 0);

  // Market: buying and immediately selling always loses money.
  const before = (await p.sync()).profile.money;
  const paid = (await p.must('trade_market', { p_item: 'parts', p_quantity: 200, p_buy: true })).total;
  const got = (await p.must('trade_market', { p_item: 'parts', p_quantity: 200, p_buy: false })).total;
  assert.ok(got < paid, 'a round trip must cost something');
  assert.equal((await p.sync()).profile.money, before - paid + got);
  assert.match((await p.rpc('trade_market', { p_item: 'parts', p_quantity: 999999, p_buy: false })).error, /between 1 and/);
  assert.match((await p.rpc('trade_market', { p_item: 'medical', p_quantity: 5000, p_buy: false })).error, /do not have that much/);
  assert.deepEqual((await p.rest('GET', 'market?select=*')).data, [], 'prices are read through get_market() only');

  // Moving a base: not while a unit is out, not into the sea, and it costs a quarter of the price.
  assert.match((await p.rpc('move_base', { p_base_id: hq.id, p_lat: LAND.lat - 0.3, p_lng: LAND.lng })).error, /must be home/);
  await sql(`delete from public.dispatches where player_id = '${p.id}'; update public.units set status = 'idle' where owner_id = '${p.id}'`);
  assert.match((await p.rpc('move_base', { p_base_id: hq.id, p_lat: 50.6, p_lng: 0.9 })).error, /on land/);
  const funds = (await p.sync()).profile.money;
  const moved = await p.must('move_base', { p_base_id: hq.id, p_lat: LAND.lat - 0.3, p_lng: LAND.lng });
  assert.equal(moved.bases[0].lat, LAND.lat - 0.3);
  assert.equal(moved.profile.money, funds - 1250, 'a quarter of the 5,000 a Headquarters costs');
});
