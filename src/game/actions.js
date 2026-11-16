// Everything the player can DO goes through this file. Each action asks a
// server function to make the change, then copies the server's answer into
// the local state so the screen updates.

import { supabase } from '../supabase.js';
import { state, setState } from '../state.js';
import { setServerTime, msUntil } from './clock.js';
import { toast } from '../ui/toast.js';
import { fmt } from '../ui/dom.js';

// ------------------------------------------------------------ snapshots
//
// sync_player, dispatch_units and recall_units all answer with the same
// "snapshot": profile, units, missions, dispatches, the server's time, and a
// list of events (things that happened since we last asked).

function applySnapshot(snapshot) {
  setServerTime(snapshot.server_time);
  announce(snapshot.events ?? []);
  setState({
    profile: snapshot.profile,
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
    ...state.dispatches.map((d) => d.returns_at),
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
  sync().catch(() => {}); // a new base can mean new missions
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
  setState({ alliance, unread: alliance ? state.unread : 0 });
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
