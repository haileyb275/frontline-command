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
  await sync();
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
