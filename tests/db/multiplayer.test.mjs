// Alliances, shared missions, moderation and the admin panel.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { canRun, skipNote, createPlayer, cleanup, sql, LAND } from './helpers.mjs';

after(cleanup);
const skip = !canRun && skipNote;

test('players of different nations share an alliance, its chat stays private', { skip }, async () => {
  const leader = await createPlayer({ nation: 'germany' });
  const member = await createPlayer({ nation: 'usa' });
  const outsider = await createPlayer({ nation: 'japan' });
  const tag = leader.username.slice(2, 7).toUpperCase();

  const alliance = await leader.must('create_alliance', { p_name: `Test ${tag}`, p_tag: tag });
  await member.must('join_alliance', { p_alliance_id: alliance });
  await member.must('send_alliance_message', { p_body: 'hello <b>all</b>' });

  const seen = (await leader.rest('GET', 'alliance_messages?select=body&sender_id=not.is.null')).data;
  assert.deepEqual(seen.map((m) => m.body), ['hello <b>all</b>']);
  assert.deepEqual((await outsider.rest('GET', 'alliance_messages?select=body')).data, []);
  assert.match((await outsider.rpc('send_alliance_message', { p_body: 'hi' })).error, /Join an alliance/);
  // A member cannot post under someone else's name by writing to the table.
  assert.equal((await member.rest('POST', 'alliance_messages', { alliance_id: alliance, sender_name: 'Admin', body: 'x' })).ok, false);

  assert.match((await member.rpc('build_alliance_building', { p_building_type: 'motor_pool' })).error, /leader and officers/);
  assert.match((await member.rpc('set_member_role', { p_player_id: leader.id, p_role: 'member' })).error, /Only the leader/);
  assert.match((await leader.rpc('donate_to_treasury', { p_amount: 10 ** 9 })).error, /do not have that much/);
});

test('a shared mission pays each side by contribution, once', { skip }, async () => {
  const a = await createPlayer({ nation: 'usa' });
  const b = await createPlayer({ nation: 'uk' });
  const tag = a.username.slice(2, 7).toUpperCase();
  const alliance = await a.must('create_alliance', { p_name: `Test ${tag}`, p_tag: tag });
  await b.must('join_alliance', { p_alliance_id: alliance });

  const hqA = (await a.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat, p_lng: LAND.lng })).base;
  const hqB = (await b.must('place_base', { p_building_type: 'hq', p_lat: LAND.lat + 0.1, p_lng: LAND.lng })).base;
  // Give each side the units a River Crossing needs (set-up, so done in SQL).
  await sql(`insert into public.units (owner_id, base_id, unit_type)
      select '${a.id}', '${hqA.id}', x from unnest(array['usa_infantry','usa_infantry','usa_infantry','usa_engineers','usa_engineers']) x;
    insert into public.units (owner_id, base_id, unit_type) values ('${b.id}', '${hqB.id}', 'uk_armor');
    update public.bases set stock = 1000 where id in ('${hqA.id}', '${hqB.id}');
    delete from public.missions where owner_id in ('${a.id}', '${b.id}');
    insert into public.missions (mission_type, owner_id, lat, lng, expires_at)
    values ('river_crossing', '${a.id}', ${LAND.lat + 0.2}, ${LAND.lng}, now() + interval '3 hours');
    update public.game_config set value = 0 where key = 'damage_chance_per_difficulty';`);
  try {
    const mission = (await a.sync()).missions.find((m) => m.mission_type === 'river_crossing');
    const unitsB = (await b.sync()).units.map((u) => u.id);
    assert.match((await b.rpc('dispatch_units', { p_mission_id: mission.id, p_unit_ids: unitsB })).error, /not found/, 'not shared yet');

    await a.must('share_mission', { p_mission_id: mission.id });
    await b.must('dispatch_units', { p_mission_id: mission.id, p_unit_ids: unitsB });
    const unitsA = (await a.sync()).units.map((u) => u.id);
    const started = await a.must('dispatch_units', { p_mission_id: mission.id, p_unit_ids: unitsA });
    assert.equal(started.missions.find((m) => m.id === mission.id).status, 'in_progress');
    assert.match((await b.rpc('leave_alliance')).error, /still deployed/);

    await sql(`update public.missions set completes_at = now() - interval '1 second' where id = '${mission.id}'`);
    const settledByB = await b.sync();    // either member's check-in may settle it
    const collectedByA = await a.sync();
    const bPaid = settledByB.events.find((e) => e.type === 'mission_completed');
    const aPaid = collectedByA.events.find((e) => e.type === 'mission_completed');
    const finder = collectedByA.events.find((e) => e.type === 'finder_bonus');
    assert.ok(aPaid && bPaid && finder, 'both contributors are paid, and the sharer gets a finder\'s bonus');
    assert.ok(aPaid.money > bPaid.money, 'five units out-earn one');

    // Nothing was created from thin air: shares + finder's bonus + treasury cut = the reward.
    const [{ reward_money: reward }] = await sql(`select reward_money from public.mission_types where id = 'river_crossing'`);
    const [{ treasury }] = await sql(`select treasury from public.alliances where id = '${alliance}'`);
    assert.ok(Math.abs(aPaid.money + bPaid.money + finder.money + Number(treasury) - reward) <= 2);

    assert.deepEqual((await a.sync()).events.filter((e) => e.type === 'mission_completed'), []);
    assert.deepEqual((await b.sync()).events.filter((e) => e.type === 'mission_completed'), []);
  } finally {
    await sql(`update public.game_config set value = 0.04 where key = 'damage_chance_per_difficulty'`);
  }
});

test('administrators can adjust, mute and suspend; everything is logged', { skip }, async () => {
  const admin = await createPlayer({ nation: 'uk' });
  const target = await createPlayer({ nation: 'italy' });
  assert.match((await admin.rpc('admin_adjust_player', { p_player_id: target.id, p_money: 5 })).error, /Administrators only/);

  await sql(`update public.profiles set is_admin = true where id = '${admin.id}'`);   // only SQL can grant this
  const adjusted = await admin.must('admin_adjust_player', { p_player_id: target.id, p_money: -999999999, p_supplies: 250, p_reason: 'test' });
  assert.equal(adjusted.profile.money, 0, 'balances never go below zero');
  assert.equal(adjusted.profile.supplies, 750);

  await admin.must('admin_set_ban', { p_player_id: target.id, p_banned: true, p_reason: 'testing' });
  assert.match((await target.rpc('sync_player')).error, /ACCOUNT_SUSPENDED: testing/);
  assert.match((await admin.rpc('admin_set_ban', { p_player_id: admin.id, p_banned: true })).error, /cannot be suspended/);
  await admin.must('admin_set_ban', { p_player_id: target.id, p_banned: false });
  assert.equal((await target.rpc('sync_player')).ok, true);

  const log = (await admin.must('admin_overview')).log.filter((l) => l.target_id === target.id).map((l) => l.action);
  assert.deepEqual(log, ['unsuspend', 'suspend', 'adjust']);
});
