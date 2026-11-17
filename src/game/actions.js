// Everything the player can DO goes through this file. Each action asks a
// server function to make the change, then copies the server's answer into
// the local state so the screen updates.

import { supabase } from '../supabase.js';
import { state, setState } from '../state.js';
import { setServerTime, msUntil } from './clock.js';
import { toast } from '../ui/toast.js';
import { playSound, notify } from '../ui/alerts.js';
import { surveyBases } from './features.js';
import { fmt } from '../ui/dom.js';

// ------------------------------------------------------------ snapshots
//
// sync_player, dispatch_units and recall_units all answer with the same
// "snapshot": profile, units, missions, dispatches, the server's time, and a
// list of events (things that happened since we last asked).

function applySnapshot(snapshot) {
  setServerTime(snapshot.server_time);

  // Units that have just come home damaged (the server marks them 'repairing').
  const wasRepairing = new Set(state.units.filter((u) => u.status === 'repairing').map((u) => u.id));
  const newlyDamaged = state.units.length
    ? snapshot.units.filter((u) => u.status === 'repairing' && !wasRepairing.has(u.id)).length
    : 0;
  // New mission reports since the last check-in (not on the very first load).
  const known = new Set(state.missions.map((m) => m.id));
  const fresh = state.profile ? snapshot.missions.filter((m) => !known.has(m.id)) : [];
  const attack = fresh.find((m) => m.target_base_id);
  if (attack && state.units.length > 0) {
    toast(`Enemy offensive against ${attack.site_name ?? 'one of your bases'}! Answer it before the timer runs out.`, 'error');
  }
  if (fresh.length > 0 && state.missions.length + state.units.length > 0) {
    playSound(attack || fresh.some((m) => m.mission_type === 'convoy_threat') ? 'warning' : 'mission');
    notify('New mission report', `${fresh.length} new mission${fresh.length === 1 ? '' : 's'} waiting.`);
  }

  if (newlyDamaged > 0) {
    toast(`${newlyDamaged} unit${newlyDamaged === 1 ? ' has' : 's have'} come back needing repairs or rest.`, 'info');
  }

  announce(snapshot.events ?? []);
  setState({
    profile: snapshot.profile,
    bases: snapshot.bases ?? state.bases,
    shipments: snapshot.shipments ?? [],
    units: snapshot.units,
    missions: snapshot.missions,
    dispatches: snapshot.dispatches,
  });
  scheduleNextSync();

  // The snapshot says which alliance we are in. If that no longer matches
  // what we have loaded (we joined, left, or were removed), reload it.
  if ((snapshot.alliance_id ?? null) !== (state.alliance?.info.id ?? null)) {
    loadAlliance().catch(() => {});
  }
}

/** Turn server events into pop-up messages. */
function announce(events) {
  const done = events.filter((e) => e.type === 'mission_completed');
  // Finished missions move daily orders, campaigns and alliance operations along.
  if (done.length > 0) {
    playSound('complete');
    notify('Mission complete', done.length === 1 ? `${done[0].name}: +${fmt(done[0].money)} funds` : `${done.length} missions completed.`);
    refreshObjectivesSoon();
    if (state.alliance) refreshOperationSoon();
    if (state.globalEvent?.status === 'active') refreshEventSoon();
    if (state.history.some((h) => h.status === 'active')) refreshHistorySoon();
  }

  if (done.length > 3) {
    // Came back after a while: one summary instead of a wall of pop-ups.
    const sum = (key) => done.reduce((total, e) => total + e[key], 0);
    toast(
      `While you were away: ${done.length} missions completed, ` +
        `+${fmt(sum('money'))} funds, +${fmt(sum('supplies'))} supplies, +${fmt(sum('xp'))} XP`,
      'ok'
    );
  } else {
    for (const e of done) {
      toast(`${e.name} complete: +${fmt(e.money)} funds, +${fmt(e.supplies)} supplies, +${e.xp} XP`, 'ok');
    }
  }

  for (const e of events) {
    if (e.type === 'finder_bonus') toast(`Finder's bonus for sharing ${e.name}: +${fmt(e.money)} funds`, 'ok');
    if (e.type === 'training_done') toast(`${e.unit} qualified: ${e.specialty}`, 'ok');
    if (e.type === 'transfer_done') toast(`${e.unit} has arrived at ${e.base}.`, 'ok');
    if (e.type === 'production_done') toast(`${e.name} finished. A convoy is taking it to your Headquarters.`, 'info');
    if (e.type === 'shipment_arrived') {
      const parts = [e.money && `+${fmt(e.money)} funds`, e.supplies && `+${fmt(e.supplies)} supplies`,
        e.fuel && `+${fmt(e.fuel)} fuel`, e.parts && `+${fmt(e.parts)} spare parts`,
        e.medical && `+${fmt(e.medical)} medical stores`].filter(Boolean);
      const note = { escorted: ' Escorted in safely: bonus cargo.', raided: ' Raiders got through: part of the cargo was lost.' }[e.outcome] ?? '';
      toast(`Convoy arrived (${e.name}): ${parts.join(', ')}.${note}`, e.outcome === 'raided' ? 'error' : 'ok');
    }
    if (e.type === 'convoy_threat') toast(`Raiders are shadowing your ${e.name} convoy. Send warships to escort it.`, 'error');
    if (e.type === 'repairs_done') toast(`${e.count} unit${e.count === 1 ? ' is' : 's are'} fit for duty again.`, 'ok');
    if (e.type === 'notice') {
      toast(e.text, 'ok');
      playSound('complete');
    }
    if (e.type === 'level_up') toast(`Promoted to level ${e.level}. New options may be unlocked.`, 'ok');
    if (e.type === 'followup' && done.length <= 3) toast(`New intelligence: ${e.name}`, 'info');
  }
}

// ------------------------------------------------------------ syncing

let syncInFlight = null;
let nextSyncTimer = null;
let pollTimer = null;

/** Ask the server to settle the clock and send us the current picture. */
export function sync() {
  // If a sync is already running, share it instead of starting another.
  syncInFlight ??= (async () => {
    try {
      const { data, error } = await supabase.rpc('sync_player');
      if (error?.message?.includes('ACCOUNT_SUSPENDED')) {
        window.dispatchEvent(new CustomEvent('fc-suspended', { detail: error.message }));
      }
      if (error) throw error;
      applySnapshot(data);
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/**
 * We know exactly when the next interesting thing happens (a mission
 * finishing, a unit getting home), so ask the server just after that moment
 * instead of hammering it every second.
 */
function scheduleNextSync() {
  clearTimeout(nextSyncTimer);
  const times = [
    ...state.missions.map((m) => m.completes_at),
    ...state.missions.map((m) => m.confirm_at).filter((t) => t && msUntil(t) > 0), // a scout arriving reveals the report
    ...state.missions.filter((m) => m.status === 'open').map((m) => m.expires_at), // an offensive running out matters at once
    ...state.dispatches.map((d) => d.returns_at),
    // Training courses, transfers, factory runs and convoys all end at a known time too.
    ...state.units.map((u) => u.busy_until),
    ...state.bases.map((b) => b.production_done_at),
    ...state.shipments.map((s) => s.arrives_at),
    state.profile?.research_until, // so the Research Office updates the moment a programme ends
    // Arrivals don't change anything on the server, but syncing then keeps
    // the status labels fresh. Only future ones, or we would loop forever.
    ...state.dispatches.map((d) => d.arrives_at).filter((t) => msUntil(t) > 0),
  ]
    .filter(Boolean)
    .map(msUntil);
  if (times.length === 0) return;
  const soonest = Math.max(0, Math.min(...times));
  nextSyncTimer = setTimeout(() => sync().catch(() => {}), soonest + 800);
}

/** Start checking in regularly (for newly spawned missions). */
export function startSyncLoop() {
  stopSyncLoop();
  pollTimer = setInterval(() => {
    if (!document.hidden) sync().catch(() => {}); // don't poll from a background tab
  }, 20000);
  document.addEventListener('visibilitychange', onVisible);
}

export function stopSyncLoop() {
  clearInterval(pollTimer);
  clearTimeout(nextSyncTimer);
  document.removeEventListener('visibilitychange', onVisible);
}

function onVisible() {
  if (!document.hidden) sync().catch(() => {}); // catch up as soon as the tab is looked at again
}

// ------------------------------------------------------------ actions

/** Load everything after logging in. */
export async function loadGame() {
  // Bases never change on their own, so they are fetched once here;
  // everything else arrives with each sync.
  const { data, error } = await supabase.from('bases').select('*').order('created_at');
  if (error) throw error;
  setState({ bases: data });
  await Promise.all([sync(), loadAlliance()]);
  surveyBases(); // look up real places around any base not yet surveyed
  // Not needed to start playing, so these load in the background.
  loadObjectives().catch(() => {});
  loadTaskForces().catch(() => {});
  loadDivisions().catch(() => {});
  loadGlobalEvent().catch(() => {});
  loadHistory().catch(() => {});
  loadLoans().catch(() => {});
}

/** Build a base. Throws an Error with a readable message if the server says no. */
export async function placeBase(buildingType, latlng, name) {
  const { data, error } = await supabase.rpc('place_base', {
    p_building_type: buildingType,
    p_lat: latlng.lat,
    p_lng: latlng.lng,
    p_name: name,
  });
  if (error) throw error;
  // The function returns our updated profile (less money) and the new base.
  setState({ profile: data.profile, bases: [...state.bases, data.base] });
  sync().catch(() => {}).then(surveyBases); // new missions, and survey the new neighbourhood
  return data.base;
}

/** Recruit one unit at a base. */
export async function buyUnit(baseId, unitType) {
  const { data, error } = await supabase.rpc('buy_unit', {
    p_base_id: baseId,
    p_unit_type: unitType,
  });
  if (error) throw error;
  setState({ profile: data.profile, units: [...state.units, data.unit] });
  return data.unit;
}

/** Send units to a mission. We only say WHICH units; the server does the rest. */
export async function dispatchUnits(missionId, unitIds) {
  const { data, error } = await supabase.rpc('dispatch_units', {
    p_mission_id: missionId,
    p_unit_ids: unitIds,
  });
  if (error) throw error;
  applySnapshot(data);
}

/** Call our units back from a mission that has not started. */
export async function recallUnits(missionId) {
  const { data, error } = await supabase.rpc('recall_units', { p_mission_id: missionId });
  if (error) throw error;
  applySnapshot(data);
}

/** Offer one of our missions to the whole alliance. */
export async function shareMission(missionId) {
  const { data, error } = await supabase.rpc('share_mission', { p_mission_id: missionId });
  if (error) throw error;
  applySnapshot(data);
}

// ------------------------------------------------------------ alliances

/** Call a server function that returns nothing useful; throw on error. */
async function call(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

/** Load our alliance (or the list to browse, if we are not in one). */
export async function loadAlliance() {
  const alliance = await call('get_my_alliance');
  setState({ alliance, unread: alliance ? state.unread : 0, ...(alliance ? {} : { allies: [], allianceWeek: null }) });
  if (alliance) loadAllianceMap().catch(() => {});
  watchAlliance(alliance?.info.id ?? null);
  if (!alliance) await loadAllianceList();
}

export async function loadAllianceList() {
  setState({ alliances: await call('list_alliances') });
}

export async function createAlliance(name, tag, description) {
  await call('create_alliance', { p_name: name, p_tag: tag, p_description: description ?? '' });
  await Promise.all([loadAlliance(), sync()]); // sync refreshes our funds
}

export async function joinAlliance(allianceId) {
  await call('join_alliance', { p_alliance_id: allianceId });
  await Promise.all([loadAlliance(), sync()]); // sync brings in the shared missions
}

export async function leaveAlliance() {
  await call('leave_alliance');
  await Promise.all([loadAlliance(), sync()]);
}

export async function kickMember(playerId) {
  await call('kick_member', { p_player_id: playerId });
  await loadAlliance();
}

export async function setMemberRole(playerId, role) {
  await call('set_member_role', { p_player_id: playerId, p_role: role });
  await loadAlliance();
}

export async function donate(amount) {
  const profile = await call('donate_to_treasury', { p_amount: amount });
  setState({ profile });
  await loadAlliance();
}

export async function buildAllianceBuilding(type) {
  await call('build_alliance_building', { p_building_type: type });
  await loadAlliance();
}

export async function sendMessage(text) {
  // We don't add the message to the screen ourselves: it comes back through
  // the realtime channel like everyone else's, so all members see the same order.
  await call('send_alliance_message', { p_body: text });
}

export function markChatRead() {
  if (state.unread > 0) setState({ unread: 0 });
}

// ------------------------------------------------------------ realtime
//
// Supabase Realtime pushes database changes to the browser over a WebSocket.
// We listen to our alliance's tables: chat lines are added straight to the
// screen; for everything else we simply re-fetch, which is easier to get
// right than patching the local copy by hand.

let channel = null;
let watchedAllianceId = null;

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
const reloadAllianceSoon = debounce(() => loadAlliance().catch(() => {}), 400);
const syncSoon = debounce(() => sync().catch(() => {}), 400);

function watchAlliance(allianceId) {
  if (allianceId === watchedAllianceId) return; // already listening
  if (channel) supabase.removeChannel(channel);
  channel = null;
  watchedAllianceId = allianceId;
  if (!allianceId) return;

  const changes = (table, filter, handler, event = '*') =>
    channel.on('postgres_changes', { event, schema: 'public', table, ...(filter && { filter }) }, handler);

  channel = supabase.channel(`alliance-${allianceId}`);
  changes('alliance_messages', `alliance_id=eq.${allianceId}`, onChatMessage, 'INSERT');
  changes('alliance_members', null, reloadAllianceSoon);
  changes('alliance_buildings', `alliance_id=eq.${allianceId}`, reloadAllianceSoon);
  changes('alliances', `id=eq.${allianceId}`, reloadAllianceSoon, 'UPDATE');
  changes('missions', `alliance_id=eq.${allianceId}`, syncSoon); // shared mission appeared / started
  changes('dispatches', null, syncSoon); // an ally sent or recalled units
  channel.subscribe();
}

function onChatMessage(payload) {
  const message = payload.new;
  if (!state.alliance || state.alliance.messages.some((m) => m.id === message.id)) return;
  setState({
    alliance: { ...state.alliance, messages: [...state.alliance.messages, message].slice(-200) },
    unread: state.unread + (message.sender_id === state.profile?.id ? 0 : 1),
  });
}

/** Stop listening (on logout). */
export function stopRealtime() {
  watchAlliance(null);
}

// ------------------------------------------------------------ phase 6

export async function loadLeaderboard() {
  setState({ leaderboard: await call('get_leaderboard') });
}

/** Raise a base's level (more room for units). */
export async function upgradeBase(baseId) {
  const data = await call('upgrade_base', { p_base_id: baseId });
  setState({
    profile: data.profile,
    bases: state.bases.map((b) => (b.id === data.base.id ? data.base : b)),
  });
}

/** Stand a unit down for a partial refund. Returns what was refunded. */
export async function dismissUnit(unitId) {
  const data = await call('dismiss_unit', { p_unit_id: unitId });
  setState({ profile: data.profile, units: state.units.filter((u) => u.id !== data.unit_id) });
  return data;
}

// ------------------------------------------------------------ phase 7
// These four all answer with a full snapshot, like dispatching does.

export async function trainUnit(unitId, specialtyId) {
  applySnapshot(await call('train_unit', { p_unit_id: unitId, p_specialty: specialtyId }));
}

export async function startProduction(baseId, productId) {
  applySnapshot(await call('start_production', { p_base_id: baseId, p_product: productId }));
}

export async function transferUnit(unitId, baseId) {
  applySnapshot(await call('transfer_unit', { p_unit_id: unitId, p_base_id: baseId }));
}

export async function setBaseZone(baseId, zone) {
  applySnapshot(await call('set_base_zone', { p_base_id: baseId, p_zone: zone }));
}

// ------------------------------------------------------------ phase 8

export async function resupplyBase(baseId) {
  applySnapshot(await call('resupply_base', { p_base_id: baseId }));
}

export async function setAutoResupply(baseId, on) {
  applySnapshot(await call('set_auto_resupply', { p_base_id: baseId, p_on: on }));
}

// ------------------------------------------------------------ phase 9: profiles

/** Open another player's public page (and show their bases on the map). */
export async function openProfile(username) {
  setState({ viewedProfile: null });
  const [profile, battleHonours] = await Promise.all([
    call('get_player_profile', { p_username: username }),
    call('get_player_honours', { p_username: username }).catch(() => []),
  ]);
  if (!profile) throw new Error('That commander could not be found.');
  profile.battle_honours = battleHonours ?? [];
  // Our own page also carries our private record.
  if (profile.id === state.profile?.id) profile.stats = await call('get_my_stats').catch(() => null);
  setState({ viewedProfile: profile, overlayBases: profile.id === state.profile?.id ? [] : profile.bases });
  return profile;
}

export function closeProfile() {
  setState({ viewedProfile: null, overlayBases: [] });
}

export async function reportPlayer(username, reason, messageId = null) {
  await call('report_player', { p_username: username, p_reason: reason, p_message_id: messageId });
}

// ------------------------------------------------------------ phase 9: admin
// Each of these is refused by the server unless we are an administrator.
// Most answer with the managed player's full record, which we keep in
// state.admin.player and also draw on the map.

function setAdminPlayer(player) {
  setState({ admin: { ...state.admin, player }, overlayBases: player?.bases ?? [] });
}

export async function adminLoadHome() {
  const [players, overview] = await Promise.all([call('admin_search_players', { p_query: '' }), call('admin_overview')]);
  setState({ admin: { ...state.admin, players, overview }, overlayBases: [] });
}

export async function adminSearch(query) {
  setState({ admin: { ...state.admin, players: await call('admin_search_players', { p_query: query }) } });
}

export async function adminOpenPlayer(playerId) {
  setAdminPlayer(null);
  setAdminPlayer(await call('admin_get_player', { p_player_id: playerId }));
}

export async function adminAdjust(playerId, money, supplies, xp, reason) {
  setAdminPlayer(await call('admin_adjust_player', {
    p_player_id: playerId, p_money: money, p_supplies: supplies, p_xp: xp, p_reason: reason,
  }));
  if (playerId === state.profile?.id) sync().catch(() => {}); // we changed our own balance
}

export const adminSetBan = async (playerId, banned, reason) =>
  setAdminPlayer(await call('admin_set_ban', { p_player_id: playerId, p_banned: banned, p_reason: reason ?? '' }));
export const adminSetMute = async (playerId, minutes) =>
  setAdminPlayer(await call('admin_set_mute', { p_player_id: playerId, p_minutes: minutes }));
export const adminRename = async (playerId, username) =>
  setAdminPlayer(await call('admin_rename_player', { p_player_id: playerId, p_username: username }));
export const adminDeleteBase = async (baseId) => setAdminPlayer(await call('admin_delete_base', { p_base_id: baseId }));
export const adminMoveBase = async (baseId, latlng) =>
  setAdminPlayer(await call('admin_move_base', { p_base_id: baseId, p_lat: latlng.lat, p_lng: latlng.lng }));
export const adminDeleteUnit = async (unitId) => setAdminPlayer(await call('admin_delete_unit', { p_unit_id: unitId }));
export const adminMoveUnit = async (unitId, baseId) =>
  setAdminPlayer(await call('admin_move_unit', { p_unit_id: unitId, p_base_id: baseId }));

export async function adminDeleteMessage(messageId) {
  await call('admin_delete_message', { p_message_id: messageId });
  await adminLoadHome();
}

export async function adminResolveReport(reportId) {
  await call('admin_resolve_report', { p_report_id: reportId });
  await adminLoadHome();
}

export const adminDisbandAlliance = (allianceId) => call('admin_disband_alliance', { p_alliance_id: allianceId });

// ------------------------------------------------------------ phase 10

export async function loadObjectives() {
  setState({ objectives: await call('get_objectives') });
}
const refreshObjectivesSoon = debounce(() => loadObjectives().catch(() => {}), 1500);

/** Collect a finished daily order. Returns true if the all-three bonus was paid too. */
export async function claimDailyOrder(orderId) {
  const result = await call('claim_daily_order', { p_order_id: orderId });
  setState({ objectives: result });
  await sync(); // show the new funds, supplies and XP
  return result.all_done_bonus;
}

export async function claimObjective(objectiveId) {
  setState({ objectives: await call('claim_objective', { p_objective_id: objectiveId }) });
  await sync();
}

export async function loadTaskForces() {
  // Row-level security limits this to our own task forces.
  const { data, error } = await supabase.from('task_forces').select('*').order('created_at');
  if (error) throw error;
  setState({ taskForces: data });
}

export async function saveTaskForce(name, unitIds) {
  await call('save_task_force', { p_name: name, p_unit_ids: unitIds });
  await loadTaskForces();
}

export async function deleteTaskForce(id) {
  await call('delete_task_force', { p_id: id });
  await loadTaskForces();
}

export async function renameBase(baseId, name) {
  applySnapshot(await call('rename_base', { p_base_id: baseId, p_name: name }));
}

export async function renameUnit(unitId, name) {
  applySnapshot(await call('rename_unit', { p_unit_id: unitId, p_name: name }));
}

// ------------------------------------------------------------ phase 11

export async function startResearch() {
  setState({ profile: await call('start_research') });
  scheduleNextSync();
}

export async function loadOperation() {
  setState({ operation: await call('get_alliance_operation') });
}
const refreshOperationSoon = debounce(() => loadOperation().catch(() => {}), 1500);

export async function startOperation(operationId) {
  await call('start_operation', { p_operation_id: operationId });
  await Promise.all([loadOperation(), loadAlliance()]); // the treasury changed too
}

export async function claimOperationReward(operationUuid) {
  await call('claim_operation_reward', { p_operation: operationUuid });
  await Promise.all([loadOperation(), sync()]);
}

export async function loadSeasonBoard() {
  setState({ season: await call('get_season_board') });
}

// ------------------------------------------------------------ phase 14

/** Send a recon unit or aircraft to look at an unconfirmed report. */
export async function scoutMission(missionId, unitId) {
  applySnapshot(await call('scout_mission', { p_mission_id: missionId, p_unit_id: unitId }));
}

// ------------------------------------------------------------ phase 15

export async function loadDivisions() {
  const { data, error } = await supabase.from('divisions').select('*').order('created_at');
  if (error) throw error;
  setState({ divisions: data });
}

export async function createDivision(name) {
  await call('create_division', { p_name: name });
  await loadDivisions();
}

export async function renameDivision(id, name) {
  await call('rename_division', { p_division_id: id, p_name: name });
  await loadDivisions();
}

export async function disbandDivision(id) {
  await call('disband_division', { p_division_id: id });
  await Promise.all([loadDivisions(), sync()]); // its units are free again
}

/** Put a unit in a division, or (with null) take it out. */
export async function assignDivision(unitId, divisionId) {
  await call('assign_division', { p_unit_id: unitId, p_division_id: divisionId });
  // Update our copy at once; the next check-in will agree.
  setState({ units: state.units.map((u) => (u.id === unitId ? { ...u, division_id: divisionId } : u)) });
}

export async function refitUnit(unitId, unitTypeId) {
  applySnapshot(await call('refit_unit', { p_unit_id: unitId, p_unit_type: unitTypeId }));
}

// ------------------------------------------------------------ phase 16

export async function loadMarket() {
  setState({ market: await call('get_market') });
}

/** Buy (buy = true) or sell goods on the market. Returns the funds paid or received. */
export async function tradeMarket(item, quantity, buy) {
  const result = await call('trade_market', { p_item: item, p_quantity: quantity, p_buy: buy });
  setState({ profile: result.profile, market: result.market });
  return result.total;
}

/** Re-site one of our own bases. */
export async function moveBase(baseId, latlng) {
  applySnapshot(await call('move_base', { p_base_id: baseId, p_lat: latlng.lat, p_lng: latlng.lng }));
  surveyBases(); // the new neighbourhood needs surveying
}

// ------------------------------------------------------------ phase 17

/** Where our alliance mates' bases are, for shading allied ground on the map. */
export async function loadAllianceMap() {
  setState({ allies: await call('get_alliance_map') });
}

export async function loadAllianceWeek() {
  setState({ allianceWeek: await call('get_alliance_week') });
}

/** Send supplies or goods to an alliance mate. They travel by convoy. */
export async function sendAid(username, item, quantity) {
  setState({ profile: await call('send_aid', { p_username: username, p_item: item, p_quantity: quantity }) });
}

export async function loadGlobalEvent() {
  setState({ globalEvent: await call('get_global_event') });
}
const refreshEventSoon = debounce(() => loadGlobalEvent().catch(() => {}), 1500);

export async function claimEventReward(eventId) {
  await call('claim_event_reward', { p_event: eventId });
  await Promise.all([loadGlobalEvent(), sync()]);
}

export async function adminStartEvent(v) {
  await call('admin_start_event', {
    p_name: v.name, p_counter: v.counter, p_target: v.target, p_hours: v.hours,
    p_reward_money: v.money, p_reward_supplies: v.supplies, p_reward_xp: v.xp, p_description: v.description,
  });
  await loadGlobalEvent();
}

// ------------------------------------------------------------ phase 18

/** How far we have got in each named historical operation. */
export async function loadHistory() {
  const { data, error } = await supabase.from('player_history').select('*');
  if (error) throw error;
  setState({ history: data });
}
const refreshHistorySoon = debounce(() => loadHistory().catch(() => {}), 1500);

export async function startHistoryOp(opId) {
  await call('start_history_op', { p_op: opId });
  await Promise.all([loadHistory(), sync()]); // the first step is on the map now
}

// ------------------------------------------------------------ phase 19

/** Units of ours that are out on loan (they are not in state.units while away). */
export async function loadLoans() {
  setState({ loans: await call('get_my_loans') });
}

/** Lend one of our idle units to an alliance mate for some hours. */
export async function lendUnit(unitId, username, hours) {
  await call('lend_unit', { p_unit_id: unitId, p_username: username, p_hours: hours });
  await Promise.all([sync(), loadLoans()]);
}

/** End a loan early, from either side. Returns false if the unit is still out on a mission. */
export async function endLoan(unitId) {
  const home = await call('end_loan', { p_unit_id: unitId });
  await Promise.all([sync(), loadLoans()]);
  return home;
}
