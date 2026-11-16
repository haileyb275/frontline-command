// Time helpers.
//
// The player's computer clock may be wrong (or deliberately changed), so all
// countdowns use the SERVER's time. Each server answer includes its current
// time; we remember the difference and apply it to our own clock.

let offsetMs = 0;

/** Called with the `server_time` from every server snapshot. */
export function setServerTime(isoString) {
  offsetMs = new Date(isoString).getTime() - Date.now();
}

/** The current server time in milliseconds. */
export function now() {
  return Date.now() + offsetMs;
}

/** Milliseconds from now until an ISO timestamp (negative if it has passed). */
export function msUntil(isoString) {
  return new Date(isoString).getTime() - now();
}

/** 75000 → "1:15". Never goes below 0:00. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Where a dispatched unit is right now.
 * Returns { phase: 'en_route' | 'on_mission' | 'returning' | 'home', progress }
 * where progress runs 0 → 1 from base to mission (so 1 → 0 on the way back).
 */
export function dispatchPosition(dispatch) {
  const t = now();
  const travelMs = dispatch.travel_seconds * 1000;

  if (dispatch.returns_at) {
    const left = new Date(dispatch.returns_at).getTime() - t;
    if (left <= 0) return { phase: 'home', progress: 0 };
    // A recalled unit turns round part-way, so it may start below 1.
    return { phase: 'returning', progress: Math.min(1, left / travelMs) };
  }

  const arrives = new Date(dispatch.arrives_at).getTime();
  if (t >= arrives) return { phase: 'on_mission', progress: 1 };
  return { phase: 'en_route', progress: Math.max(0, 1 - (arrives - t) / travelMs) };
}

/** A unit's status right now, without waiting for the next server sync. */
export function liveUnitStatus(unit, dispatches) {
  const dispatch = dispatches.find((d) => d.unit_id === unit.id);
  if (!dispatch) return 'idle';
  const { phase } = dispatchPosition(dispatch);
  return phase === 'home' ? 'idle' : phase;
}
