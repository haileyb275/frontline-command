// The "Missions" tab. Two views, chosen by `ui.view`:
//
//   'list'    → every open / in-progress mission
//   'mission' → one mission: what it needs, what it pays, and the unit picker

import {
  categories,
  getCategory,
  getMissionType,
  getUnitType,
  missionReward,
  travelSeconds,
  distanceKm,
  getSlot,
  getSpecialty,
  specialtyName,
  unitFitsSlot,
  supplyUse,
  fuelUse,
  unitTitle,
  settings,
} from '../game/content.js';
import {
  dispatchUnits, recallUnits, shareMission, scoutMission, claimDailyOrder, claimObjective, loadObjectives, claimEventReward, loadGlobalEvent, loadHistory, startHistoryOp, saveTaskForce,
} from '../game/actions.js';
import { renderOrders, tickOrders, claimableCount } from './ordersView.js';
import { msUntil, formatDuration, liveUnitStatus, now } from '../game/clock.js';
import { weatherAt, isNight, travelSlowdown, conditionsText } from '../game/weather.js';
import { friendlyError } from '../supabase.js';
import { esc, fmt } from './dom.js';
import { toast } from './toast.js';
import { unitIcon, slotIcon } from './icons.js';

// ---------------------------------------------------------------- helpers

/** How many units of each category are committed to a mission (not recalled). */
function committedCounts(mission, dispatches) {
  const counts = {};
  for (const d of dispatches) {
    if (d.mission_id === mission.id && !d.returns_at) {
      counts[d.category_id] = (counts[d.category_id] ?? 0) + 1;
    }
  }
  return counts;
}

/** The one-line status under a mission's name. Re-computed every second by tick(). */
function statusText(mission, dispatches) {
  if (mission.hidden) {
    return mission.confirm_at
      ? `Scout arrives in ${formatDuration(msUntil(mission.confirm_at))}`
      : `Unconfirmed · expires in ${formatDuration(msUntil(mission.expires_at))}`;
  }
  if (mission.status === 'in_progress') {
    return msUntil(mission.started_at) > 0
      ? `Units en route · starts in ${formatDuration(msUntil(mission.started_at))}`
      : `In progress · ${formatDuration(msUntil(mission.completes_at))} left`;
  }
  const sent = Object.values(committedCounts(mission, dispatches)).reduce((a, b) => a + b, 0);
  const expires = `expires in ${formatDuration(msUntil(mission.expires_at))}`;
  return sent > 0 ? `Needs more units · ${expires}` : `Awaiting units · ${expires}`;
}

/** A committed unit's own symbol if it is ours; otherwise the symbol of the place it fills. */
function iconForDispatch(d, units) {
  const mine = units.find((u) => u.id === d.unit_id);
  return mine ? unitIcon(mine.unit_type) : slotIcon(d.unit_category ?? d.category_id);
}

/** The little "INF 1/2" boxes. */
function requirementChips(type, counts = {}) {
  return Object.entries(type.requirements)
    .map(([categoryId, needed]) => {
      const have = Math.min(counts[categoryId] ?? 0, needed);
      const cat = getSlot(categoryId); // a category or a specialty
      return `<span class="chip ${have >= needed ? 'is-met' : ''}" title="${esc(cat.name)}">
                ${slotIcon(categoryId)} ${have}/${needed}</span>`;
    })
    .join('');
}

const difficultyPips = (n) =>
  `<span class="pips" title="Difficulty ${n} of 5">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`;

/** Distance from a mission to the closest of our bases, in km. */
function nearestBaseKm(mission, bases) {
  return Math.min(...bases.map((b) => distanceKm(b, mission)));
}

// ---------------------------------------------------------------- render

export function render(state, ui) {
  const { profile, bases, missions } = state;
  if (!profile?.nation_id) return '';

  if (bases.length === 0) {
    return `
      <div class="card card--empty">
        <h2>No missions yet</h2>
        <p>Missions appear around your bases. Build your Headquarters in the
           <strong>Bases</strong> tab to get started.</p>
      </div>`;
  }

  if (ui.view === 'mission') {
    const mission = missions.find((m) => m.id === ui.missionId);
    if (mission) return renderMission(state, ui, mission);
  }

  // The switch between the mission list and the Orders view.
  const waiting = claimableCount(state);
  const nav = `
    <div class="seg seg--tabs">
      <button class="seg-btn ${ui.missionsView !== 'orders' ? 'is-active' : ''}" data-action="missions-view" data-view="list">
        Missions</button>
      <button class="seg-btn ${ui.missionsView === 'orders' ? 'is-active' : ''}" data-action="missions-view" data-view="orders">
        Orders${waiting > 0 ? ` <span class="dot" title="${waiting} reward${waiting === 1 ? '' : 's'} to collect"></span>` : ''}</button>
    </div>`;
  return nav + (ui.missionsView === 'orders' ? renderOrders(state, ui) : renderList(state, ui));
}

const FILTERS = [
  ['all', 'All', () => true],
  ['ready', 'Can staff now', (m, state) => m.status === 'open' && !m.hidden && fastestUnits(m, state).complete],
  ['active', 'Under way', (m) => m.status === 'in_progress'],
  ['land', 'Land', (m) => !m.hidden && getMissionType(m.mission_type).terrain === 'land'],
  ['water', 'Sea', (m) => !m.hidden && getMissionType(m.mission_type).terrain === 'water'],
  ['urgent', 'Urgent', (m) => Boolean(m.target_base_id) || msUntil(m.expires_at) < 30 * 60000],
];

function renderList(state, ui) {
  const { dispatches, profile } = state;
  const all = state.missions;
  const filter = FILTERS.find((f) => f[0] === ui.missionFilter) ?? FILTERS[0];
  const missions = all.filter((m) => filter[2](m, state));
  const auto = getAutoPrefs();
  if (all.length === 0) {
    return `
      <div class="card card--empty">
        <h2>All quiet</h2>
        <p>No missions right now. New reports come in every couple of minutes.</p>
      </div>`;
  }

  // Missions already under way first, then the newest reports.
  const sorted = [...missions].sort(
    (a, b) =>
      (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) ||
      new Date(b.spawned_at) - new Date(a.spawned_at)
  );

  const rows = sorted
    .map((mission) => {
      const type = getMissionType(mission.mission_type);
      return `
        <button class="row row--mission ${mission.status === 'in_progress' ? 'is-active' : ''}"
                data-action="open-mission" data-mission="${esc(mission.id)}">
          <span class="row-main">
            <span class="row-title">${esc(type.name)}${mission.site_name ? ` <span class="site">${esc(mission.site_name)}</span>` : ''}
              ${mission.alliance_id ? '<span class="tag tag--shared">Alliance</span>' : ''}
              ${mission.target_base_id ? '<span class="tag tag--bad">Offensive</span>' : ''}
              ${mission.history_op ? '<span class="tag tag--spec">Operation</span>' : ''}</span>
            ${mission.owner_id !== profile.id ? `<span class="row-sub">shared by ${esc(mission.owner_name)}</span>` : ''}
            <span class="row-sub js-mission-status" data-mission="${esc(mission.id)}">
              ${esc(statusText(mission, dispatches))}</span>
            <span class="chips">${requirementChips(type, committedCounts(mission, dispatches))}</span>
          </span>
          <span class="row-side">${difficultyPips(type.difficulty)}</span>
        </button>`;
    })
    .join('');

  return `
    <div class="section-head">
      <h2>Missions <span class="count">${missions.length}${missions.length !== all.length ? ` of ${all.length}` : ''}</span></h2>
    </div>
    <div class="chips chips--buttons">${FILTERS.map(([id, label]) => `
      <button class="btn btn--small ${filter[0] === id ? 'is-on' : ''}" data-action="mission-filter" data-filter="${id}">${label}</button>`).join('')}
    </div>
    <div class="rows">${rows || '<p class="muted">No missions match this filter.</p>'}</div>

    <h3>Standing orders <span class="count">${auto.on ? 'on' : 'off'}</span></h3>
    <div class="card">
      <label class="check-line"><input type="checkbox" data-action="auto-toggle" ${auto.on ? 'checked' : ''} />
        Send the fastest units by themselves to new reports</label>
      <p class="muted">Up to difficulty:
        ${[1, 2, 3, 4, 5].map((n) => `<button class="btn btn--small ${auto.max === n ? 'is-on' : ''}" data-action="auto-level" data-level="${n}">${n}</button>`).join(' ')}</p>
      <p class="muted">Only reports your free units can fully staff are answered, and only while the game is open in
         this browser. Unconfirmed reports and shared missions are left to you.</p>
    </div>`;
}

/** An unconfirmed report: nothing is known until a scout has looked. */
function renderUnconfirmed(state, ui, mission) {
  const { profile, bases, units, dispatches } = state;
  const type = getMissionType(mission.mission_type);
  const baseById = new Map(bases.map((b) => [b.id, b]));

  let body;
  if (mission.confirm_at) {
    body = `<div class="card card--notice"><p>A scout is on the way. The report will be confirmed in
              <strong class="js-countdown" data-until="${esc(mission.confirm_at)}"></strong>.</p></div>`;
  } else {
    // Only reconnaissance units and aircraft can go and look.
    const scouts = units
      .filter((u) => ['recon', 'air'].includes(getUnitType(u.unit_type)?.category_id) && liveUnitStatus(u, dispatches) === 'idle')
      .map((unit) => ({ unit, eta: etaFor(unit, mission, state, baseById) }))
      .sort((a, b) => a.eta - b.eta);
    body = scouts.length
      ? `<h3>Send a scout</h3><div class="rows">${scouts.map(({ unit, eta }) => {
          const stormed = grounded(unit, mission);
          return `
            <div class="row row--static">
              <span class="row-icon row-icon--unit">${unitIcon(unit.unit_type)}</span>
              <span class="row-main">
                <span class="row-title">${esc(unitTitle(unit))}</span>
                <span class="row-sub">${esc(baseById.get(unit.base_id)?.name ?? '')} · ${stormed ? 'grounded by the storm' : `there in ${formatDuration(eta * 1000)}`}</span>
              </span>
              <button class="btn btn--small" data-action="scout" data-unit="${esc(unit.id)}" ${stormed || ui.busy ? 'disabled' : ''}>Send</button>
            </div>`;
        }).join('')}</div>`
      : '<p class="muted">No reconnaissance unit or aircraft is free. Recruit a recon unit at your Headquarters, or wait for one to return.</p>';
  }

  return `
    <div class="section-head">
      <h2>${esc(type.name)}</h2>
      <button class="btn btn--small" data-action="back">Back</button>
    </div>
    <p>${esc(type.description)}</p>
    <p class="muted">
      <span class="js-mission-status" data-mission="${esc(mission.id)}">${esc(statusText(mission, dispatches))}</span>
      · <button class="link-btn" data-action="focus-mission">Show on map</button>
    </p>
    <div class="facts">
      <div><span>Conditions</span>${conditionsText(mission.lat, mission.lng, now())}</div>
      <div><span>Location</span>${Math.round(nearestBaseKm(mission, bases))} km from base</div>
      <div><span>Needs</span>Unknown until confirmed</div>
    </div>
    ${body}`;
}

function renderMission(state, ui, mission) {
  if (mission.hidden) return renderUnconfirmed(state, ui, mission);
  const { profile, bases, units, dispatches } = state;
  const type = getMissionType(mission.mission_type);
  const counts = committedCounts(mission, dispatches);
  const reward = missionReward(type, profile.nation_id);
  // Contact out beyond a well-advanced front pays more.
  reward.money = Math.round(reward.money * (mission.reward_mult ?? 1));
  // Every unit committed to this mission — ours and, on shared missions, our allies'.
  const committed = dispatches.filter((d) => d.mission_id === mission.id && !d.returns_at);
  const iHaveUnitsHere = committed.some((d) => d.player_id === profile.id);

  let body = '';

  if (mission.status === 'open') {
    body += renderPicker(state, ui, mission, type, counts);
  }

  if (committed.length > 0) {
    const rows = committed
      .map((d) => {
        const ally = d.player_id !== profile.id;
        return `
          <div class="row row--static">
            <span class="row-icon row-icon--unit ${ally ? 'row-icon--ally' : ''}">${iconForDispatch(d, units)}</span>
            <span class="row-main">
              <span class="row-title">${esc(d.unit_name)}</span>
              ${mission.alliance_id ? `<span class="row-sub">${ally ? esc(d.player_name) : 'You'}</span>` : ''}
            </span>
            <span class="status js-arrival" data-arrives="${esc(d.arrives_at)}"></span>
          </div>`;
      })
      .join('');
    body += `<h3>Committed <span class="count">${committed.length}</span></h3><div class="rows">${rows}</div>`;
    if (mission.status === 'open' && iHaveUnitsHere) {
      body += `<button class="btn btn--block btn--spaced" data-action="recall" ${ui.busy ? 'disabled' : ''}>
                 Recall units</button>`;
    }
  }

  return `
    <div class="section-head">
      <h2>${esc(type.name)}</h2>
      <button class="btn btn--small" data-action="back">Back</button>
    </div>
    <p>${esc(type.description)}</p>
    <p class="muted">
      <span class="js-mission-status" data-mission="${esc(mission.id)}">${esc(statusText(mission, dispatches))}</span>
      · <button class="link-btn" data-action="focus-mission">Show on map</button>
    </p>

    <div class="facts">
      <div><span>Difficulty</span>${difficultyPips(type.difficulty)}</div>
      ${mission.site_name ? `<div><span>Place</span>${esc(mission.site_name)}</div>` : ''}
      <div><span>Conditions</span>${conditionsText(mission.lat, mission.lng, now())}</div>
      <div><span>Location</span>${{ land: 'On land', water: 'At sea', any: 'Air operation' }[type.terrain] ?? ''}
        · ${Math.round(nearestBaseKm(mission, bases))} km from base</div>
      <div><span>Duration</span>${formatDuration(type.duration_seconds * 1000)}</div>
      <div><span>Reward</span>${fmt(reward.money)} funds · ${fmt(reward.supplies)} supplies · ${reward.xp} XP</div>
    </div>

    ${mission.target_base_id
      ? `<p class="note note--danger">The enemy is advancing on <strong>${esc(mission.site_name ?? 'one of your bases')}</strong>.
           If this runs out of time the base is out of action for ${Math.round(settings.offensive_disable_seconds / 60)} minutes
           and its front falls back. Stop it and the front moves out.</p>` : ''}
    ${(mission.reward_mult ?? 1) > 1
      ? `<p class="muted">Forward-area bonus: +${Math.round((mission.reward_mult - 1) * 100)}% funds for fighting beyond a well-advanced front.</p>` : ''}
    ${renderSharing(state, ui, mission, type)}

    <h3>Required</h3>
    <div class="chips">${requirementChips(type, counts)}</div>
    ${body}`;
}

/** The "share with alliance" button, or a note about how sharing works. */
function renderSharing(state, ui, mission, type) {
  if (mission.alliance_id) {
    const by = mission.owner_id === state.profile.id ? 'you' : esc(mission.owner_name);
    return `<p class="note">Shared with the alliance by ${by}. Any member can send units;
              the reward is split by what each member contributes.</p>`;
  }
  if (!type.shareable || mission.status !== 'open') return '';
  if (!state.alliance) {
    return `<p class="note">This is a large operation. Join an alliance to share it with other players.</p>`;
  }
  return `<button class="btn btn--block btn--spaced" data-action="share" ${ui.busy ? 'disabled' : ''}>
            Share with ${esc(state.alliance.info.name)}</button>`;
}

/**
 * Mission places are keyed by category ("infantry") or specialty ("airborne").
 * Specialty places are listed first, so specialists are offered where only
 * they can go before being spent on ordinary places.
 */
function slotKeys(type) {
  const keys = Object.keys(type.requirements);
  return [...keys.filter((k) => !getCategory(k)), ...keys.filter((k) => getCategory(k))];
}

/** Idle units that could fill the place `key`. */
function idleUnitsFor(key, units, dispatches) {
  return units.filter((u) => unitFitsSlot(u, key) && liveUnitStatus(u, dispatches) === 'idle');
}

/**
 * Would the server accept these units, in this order? It gives each unit its
 * specialty's place if one is free, otherwise a place of its category
 * (see dispatch_units in the SQL). Returns false if any unit has no place.
 */
function unitsFit(unitIds, mission, state) {
  const type = getMissionType(mission.mission_type);
  const counts = committedCounts(mission, state.dispatches);
  const left = Object.fromEntries(Object.entries(type.requirements).map(([k, n]) => [k, n - (counts[k] ?? 0)]));
  for (const id of unitIds) {
    const unit = state.units.find((u) => u.id === id);
    if (!unit) return false;
    const category = getUnitType(unit.unit_type).category_id;
    if (unit.specialty && left[unit.specialty] > 0) left[unit.specialty] -= 1;
    else if (left[category] > 0) left[category] -= 1;
    else return false;
  }
  return true;
}

/**
 * For each place a mission still needs, the idle units with the shortest
 * trip. `complete` is true when that fills every place.
 */
function fastestUnits(mission, state) {
  const type = getMissionType(mission.mission_type);
  const counts = committedCounts(mission, state.dispatches);
  const baseById = new Map(state.bases.map((b) => [b.id, b]));
  const ids = [];
  let complete = true;
  for (const key of slotKeys(type)) {
    const remaining = Math.max(0, type.requirements[key] - (counts[key] ?? 0));
    const chosen = idleUnitsFor(key, state.units, state.dispatches)
      .filter((unit) => !ids.includes(unit.id))
      .filter((unit) => (baseById.get(unit.base_id)?.stock ?? Infinity) >= supplyUse(unit))
      .filter((unit) => !grounded(unit, mission))
      // For ordinary places, send ordinary units before specialists.
      .map((unit) => ({ id: unit.id, eta: etaFor(unit, mission, state, baseById), special: unit.specialty ? 1 : 0 }))
      .sort((a, b) => (getCategory(key) ? a.special - b.special : 0) || a.eta - b.eta)
      .slice(0, remaining);
    if (chosen.length < remaining) complete = false;
    chosen.forEach((x) => ids.push(x.id));
  }
  return { ids, complete };
}

// ------------------------------------------------- standing orders (auto-dispatch)
//
// A convenience that lives in this browser only: while the game is open, a
// new report that the player's idle units can fully staff is answered at
// once. It presses the same "dispatch" the player would, so the server
// checks it exactly the same way. Nothing is sent while the game is closed.

const AUTO_KEY = 'fc.standingOrders';

export function getAutoPrefs() {
  try {
    return { on: false, max: 2, ...JSON.parse(localStorage.getItem(AUTO_KEY) ?? '{}') };
  } catch {
    return { on: false, max: 2 };
  }
}

function setAutoPrefs(patch) {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify({ ...getAutoPrefs(), ...patch })); } catch { /* private mode */ }
}

let autoBusy = false;
const autoTried = new Set(); // missions the server refused once: do not keep asking

/** Called whenever the game state changes. Sends at most one force at a time. */
export async function runAutoDispatch(state) {
  const prefs = getAutoPrefs();
  if (!prefs.on || autoBusy || !state.profile) return;
  const mission = state.missions.find((m) =>
    m.status === 'open' && !m.hidden && m.owner_id === state.profile.id && !autoTried.has(m.id)
    && getMissionType(m.mission_type).difficulty <= prefs.max
    && !state.dispatches.some((d) => d.mission_id === m.id)
    && fastestUnits(m, state).complete);
  if (!mission) return;
  autoBusy = true;
  try {
    await dispatchUnits(mission.id, fastestUnits(mission, state).ids);
    toast(`Standing orders: units sent to ${getMissionType(mission.mission_type).name}.`, 'ok');
  } catch {
    autoTried.add(mission.id);
  }
  autoBusy = false;
  runAutoDispatch(state); // the next one, if any
}

/** The movement domain ('ground', 'air' or 'sea') of a unit. */
const domainOf = (unit) => getCategory(getUnitType(unit.unit_type)?.category_id)?.domain ?? 'ground';

/** Aircraft cannot be sent into a storm (the server refuses too). */
const grounded = (unit, mission) =>
  domainOf(unit) === 'air' && weatherAt(mission.lat, mission.lng, now()) === 'storm';

const etaFor = (unit, mission, state, baseById) =>
  travelSeconds(getUnitType(unit.unit_type), baseById.get(unit.base_id), mission,
    state.profile.nation_id, state.alliance, unit.specialty,
    travelSlowdown(weatherAt(mission.lat, mission.lng, now()), domainOf(unit)),
    fuelUse(unit) > 0 && state.profile.fuel >= fuelUse(unit));

/** The list of idle units you can tick and send. */
function renderPicker(state, ui, mission, type, counts) {
  const { profile, bases, units, dispatches } = state;
  const baseById = new Map(bases.map((b) => [b.id, b]));
  const picked = new Set(ui.picked);
  let sections = '';
  let anyChoice = false;

  // One section per place the mission still needs.
  for (const key of slotKeys(type)) {
    const slot = getSlot(key);
    const remaining = type.requirements[key] - (counts[key] ?? 0);
    if (remaining <= 0) continue;
    const isSpecialty = !getCategory(key);
    const label = isSpecialty ? specialtyName(slot, profile.nation_id) : slot.name;

    const candidates = idleUnitsFor(key, units, dispatches)
      .map((unit) => ({ unit, eta: etaFor(unit, mission, state, baseById) }))
      .sort((a, b) => a.eta - b.eta); // fastest first

    const rows = candidates.length
      ? candidates
          .map(({ unit, eta }) => {
            const on = picked.has(unit.id);
            const spec = getSpecialty(unit.specialty);
            // Its base must have enough stock left to send it out.
            const home = baseById.get(unit.base_id);
            const stormed = grounded(unit, mission);
            const dry = stormed || (home && (home.stock ?? Infinity) < supplyUse(unit));
            return `
              <button class="row row--pick ${on ? 'is-picked' : ''}" data-action="toggle-unit"
                      data-unit="${esc(unit.id)}" aria-pressed="${on}" ${dry ? `disabled title="${stormed ? 'Grounded by the storm' : 'Its base is out of supplies'}"` : ''}>
                <span class="check">${on ? '✓' : ''}</span>
                <span class="row-main">
                  <span class="row-title">${esc(unitTitle(unit))}</span>
                  <span class="row-sub">${esc(baseById.get(unit.base_id)?.name ?? '')}
                    ${spec ? `<span class="tag tag--spec">${esc(specialtyName(spec, profile.nation_id))}</span>` : ''}</span>
                </span>
                <span class="row-side">${stormed ? 'grounded' : dry ? 'no supplies' : formatDuration(eta * 1000)}</span>
              </button>`;
          })
          .join('')
      : isSpecialty
        ? `<p class="muted">No ${esc(label)} ready. Train units in this specialty at a Training Center.</p>`
        : `<p class="muted">No ${esc(label)} units ready. Recruit some at a base that stations them.</p>`;

    if (candidates.length) anyChoice = true;
    sections += `<h3>${esc(label)} <span class="count">need ${remaining}</span></h3>
                 <div class="rows">${rows}</div>`;
  }

  if (!sections) return ''; // everything already committed

  // Saved task forces: one click ticks every member that is free and fits.
  const groups = [
    ...state.divisions.map((d) => `<button class="btn btn--small" data-action="pick-division" data-division="${esc(d.id)}">${esc(d.name)}</button>`),
    ...state.taskForces.map((f) => `<button class="btn btn--small" data-action="pick-force" data-force="${esc(f.id)}">${esc(f.name)}</button>`),
  ];
  const forces = groups.length
    ? `<h3>Divisions and task forces</h3><div class="chips chips--buttons">${groups.join('')}</div>`
    : '';

  // A line about what the conditions mean for this mission, if anything.
  const weather = weatherAt(mission.lat, mission.lng, now());
  const notes = [
    weather === 'storm' && 'Storm: ground and sea units are 30% slower, and aircraft cannot fly.',
    weather === 'rain' && 'Rain: ground and sea units are 15% slower.',
    isNight(mission.lng, now()) && 'Night: recon units and commandos fight 20% harder.',
  ].filter(Boolean);

  return `
    ${notes.length ? `<p class="note">${notes.join(' ')}</p>` : ''}
    ${forces}
    ${sections}
    <div class="btn-row btn--spaced">
      <button class="btn" data-action="auto-pick" ${anyChoice ? '' : 'disabled'}>Select fastest</button>
      <button class="btn btn--primary" data-action="dispatch"
              ${picked.size === 0 || ui.busy ? 'disabled' : ''}>
        ${ui.busy ? 'Sending…' : `Dispatch ${picked.size || ''}`}
      </button>
    </div>
    ${picked.size > 0
      ? '<button class="link-btn" data-action="save-force">Save this selection as a task force</button>' : ''}`;
}

// ---------------------------------------------------------------- ticking

/** Called once a second by panel.js: refresh countdowns without re-drawing. */
export function tick(root, state) {
  tickOrders(root);
  for (const el of root.querySelectorAll('.js-mission-status')) {
    const mission = state.missions.find((m) => m.id === el.dataset.mission);
    if (mission) el.textContent = statusText(mission, state.dispatches);
  }
  for (const el of root.querySelectorAll('.js-arrival')) {
    const left = msUntil(el.dataset.arrives);
    el.textContent = left > 0 ? `arrives ${formatDuration(left)}` : 'on scene';
    el.classList.toggle('status--idle', left <= 0);
  }
}

// ---------------------------------------------------------------- actions

export async function handleAction(action, data, ctx) {
  const { ui, update, state, missionLayer } = ctx;
  const mission = state.missions.find((m) => m.id === ui.missionId);

  switch (action) {
    case 'back':
      return update({ view: 'list', missionId: null, picked: [] });

    case 'focus-mission':
      if (mission) missionLayer.focus(mission);
      return;

    case 'missions-view':
      if (data.view === 'orders') { loadObjectives().catch(() => {}); loadGlobalEvent().catch(() => {}); loadHistory().catch(() => {}); } // fresh figures each time it is opened
      return update({ missionsView: data.view });

    case 'history-show':
      return ctx.flyTo({ lat: +data.lat, lng: +data.lng });

    case 'history-start':
      update({ busy: true });
      try {
        await startHistoryOp(data.op);
        toast('Operation begun. The first objective is on your map.', 'ok');
        update({ busy: false, missionsView: 'list' });
      } catch (error) {
        toast(friendlyError(error), 'error');
        update({ busy: false });
      }
      return;

    case 'claim-event':
      update({ busy: true });
      try {
        await claimEventReward(data.event);
        toast('Event reward collected.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });

    case 'claim-daily':
      update({ busy: true });
      try {
        const bonus = await claimDailyOrder(data.order);
        toast(bonus ? 'Order complete. All three done today: bonus paid.' : 'Order complete: reward collected.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });

    case 'claim-objective':
      update({ busy: true });
      try {
        await claimObjective(data.objective);
        toast('Reward collected.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });

    case 'pick-division':
    case 'pick-force': {
      // Add each member in turn if it is idle, supplied, and the mission has a place for it.
      const force = action === 'pick-division'
        ? { unit_ids: state.units.filter((u) => u.division_id === data.division).map((u) => u.id) }
        : state.taskForces.find((f) => f.id === data.force);
      if (!force) return;
      const baseById = new Map(state.bases.map((b) => [b.id, b]));
      const picked = [...ui.picked];
      for (const id of force.unit_ids) {
        const unit = state.units.find((u) => u.id === id);
        if (!unit || picked.includes(id) || liveUnitStatus(unit, state.dispatches) !== 'idle') continue;
        if ((baseById.get(unit.base_id)?.stock ?? Infinity) < supplyUse(unit)) continue;
        if (unitsFit([...picked, id], mission, state)) picked.push(id);
      }
      if (picked.length === ui.picked.length) toast('No free member of that group fits this mission.', 'info');
      return update({ picked });
    }

    case 'save-force': {
      const name = window.prompt('Name for this task force:', '');
      if (!name) return;
      try {
        await saveTaskForce(name, ui.picked);
        toast('Task force saved. Manage it in the Units tab.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({});
    }

    case 'toggle-unit': {
      const picked = ui.picked.filter((id) => id !== data.unit);
      if (picked.length === ui.picked.length) {
        // Ticking a new unit: check the mission still has a place for it.
        if (!unitsFit([...picked, data.unit], mission, state)) {
          return toast('This mission has no free place for that unit.', 'info');
        }
        picked.push(data.unit);
      }
      return update({ picked });
    }

    case 'auto-pick':
      return update({ picked: fastestUnits(mission, state).ids });

    case 'mission-filter':
      return update({ missionFilter: data.filter });

    case 'auto-toggle':
      setAutoPrefs({ on: !getAutoPrefs().on });
      toast(getAutoPrefs().on ? 'Standing orders on: units go out by themselves while the game is open.' : 'Standing orders off.', 'info');
      runAutoDispatch(state);
      return update({});

    case 'auto-level':
      setAutoPrefs({ max: +data.level });
      runAutoDispatch(state);
      return update({});

    case 'dispatch': {
      if (ui.picked.length === 0) return;
      update({ busy: true });
      try {
        const count = ui.picked.length;
        await dispatchUnits(ui.missionId, ui.picked);
        toast(`${count} unit${count === 1 ? '' : 's'} dispatched.`, 'ok');
        update({ busy: false, picked: [] });
      } catch (error) {
        toast(friendlyError(error), 'error');
        update({ busy: false });
      }
      return;
    }

    case 'share': {
      update({ busy: true });
      try {
        await shareMission(ui.missionId);
        toast('Mission shared with your alliance.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });
    }

    case 'scout': {
      update({ busy: true });
      try {
        await scoutMission(ui.missionId, data.unit);
        toast('Scout dispatched. The report will be confirmed when it arrives.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });
    }

    case 'recall': {
      update({ busy: true });
      try {
        await recallUnits(ui.missionId);
        toast('Units recalled.', 'info');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });
    }
  }
}

/** Used by the map: a short label for the mission marker. */
export function missionMarkerLabel(mission) {
  if (mission.hidden) return '?';
  if (mission.target_base_id && mission.status === 'open') return '⚠';
  return mission.status === 'in_progress' && msUntil(mission.started_at) <= 0 ? '⚔' : '!';
}

