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
  unitTitle,
} from '../game/content.js';
import {
  dispatchUnits, recallUnits, shareMission, claimDailyOrder, claimObjective, loadObjectives, saveTaskForce,
} from '../game/actions.js';
import { renderOrders, tickOrders, claimableCount } from './ordersView.js';
import { msUntil, formatDuration, liveUnitStatus } from '../game/clock.js';
import { friendlyError } from '../supabase.js';
import { esc, fmt } from './dom.js';
import { toast } from './toast.js';

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
  if (mission.status === 'in_progress') {
    return msUntil(mission.started_at) > 0
      ? `Units en route · starts in ${formatDuration(msUntil(mission.started_at))}`
      : `In progress · ${formatDuration(msUntil(mission.completes_at))} left`;
  }
  const sent = Object.values(committedCounts(mission, dispatches)).reduce((a, b) => a + b, 0);
  const expires = `expires in ${formatDuration(msUntil(mission.expires_at))}`;
  return sent > 0 ? `Needs more units · ${expires}` : `Awaiting units · ${expires}`;
}

/** The little "INF 1/2" boxes. */
function requirementChips(type, counts = {}) {
  return Object.entries(type.requirements)
    .map(([categoryId, needed]) => {
      const have = Math.min(counts[categoryId] ?? 0, needed);
      const cat = getSlot(categoryId); // a category or a specialty
      return `<span class="chip ${have >= needed ? 'is-met' : ''}" title="${esc(cat.name)}">
                ${esc(cat.icon)} ${have}/${needed}</span>`;
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
  return nav + (ui.missionsView === 'orders' ? renderOrders(state, ui) : renderList(state));
}

function renderList({ missions, dispatches, profile }) {
  if (missions.length === 0) {
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
            <span class="row-title">${esc(type.name)}
              ${mission.alliance_id ? '<span class="tag tag--shared">Alliance</span>' : ''}</span>
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
      <h2>Missions <span class="count">${missions.length}</span></h2>
    </div>
    <div class="rows">${rows}</div>`;
}

function renderMission(state, ui, mission) {
  const { profile, bases, units, dispatches } = state;
  const type = getMissionType(mission.mission_type);
  const counts = committedCounts(mission, dispatches);
  const reward = missionReward(type, profile.nation_id);
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
            <span class="row-icon row-icon--unit ${ally ? 'row-icon--ally' : ''}">${esc(getSlot(d.category_id).icon)}</span>
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
      <div><span>Location</span>${{ land: 'On land', water: 'At sea', any: 'Air operation' }[type.terrain] ?? ''}
        · ${Math.round(nearestBaseKm(mission, bases))} km from base</div>
      <div><span>Duration</span>${formatDuration(type.duration_seconds * 1000)}</div>
      <div><span>Reward</span>${fmt(reward.money)} funds · ${fmt(reward.supplies)} supplies · ${reward.xp} XP</div>
    </div>

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

const etaFor = (unit, mission, state, baseById) =>
  travelSeconds(getUnitType(unit.unit_type), baseById.get(unit.base_id), mission,
    state.profile.nation_id, state.alliance, unit.specialty);

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
            const dry = home && (home.stock ?? Infinity) < supplyUse(unit);
            return `
              <button class="row row--pick ${on ? 'is-picked' : ''}" data-action="toggle-unit"
                      data-unit="${esc(unit.id)}" aria-pressed="${on}" ${dry ? 'disabled title="Its base is out of supplies"' : ''}>
                <span class="check">${on ? '✓' : ''}</span>
                <span class="row-main">
                  <span class="row-title">${esc(unitTitle(unit))}</span>
                  <span class="row-sub">${esc(baseById.get(unit.base_id)?.name ?? '')}
                    ${spec ? `<span class="tag tag--spec">${esc(specialtyName(spec, profile.nation_id))}</span>` : ''}</span>
                </span>
                <span class="row-side">${dry ? 'no supplies' : formatDuration(eta * 1000)}</span>
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
  const forces = state.taskForces.length
    ? `<h3>Task forces</h3>
       <div class="chips chips--buttons">${state.taskForces.map((f) =>
         `<button class="btn btn--small" data-action="pick-force" data-force="${esc(f.id)}">${esc(f.name)}</button>`).join('')}</div>`
    : '';

  return `
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
      if (data.view === 'orders') loadObjectives().catch(() => {}); // fresh figures each time it is opened
      return update({ missionsView: data.view });

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

    case 'pick-force': {
      // Add each member in turn if it is idle, supplied, and the mission has a place for it.
      const force = state.taskForces.find((f) => f.id === data.force);
      if (!force) return;
      const baseById = new Map(state.bases.map((b) => [b.id, b]));
      const picked = [...ui.picked];
      for (const id of force.unit_ids) {
        const unit = state.units.find((u) => u.id === id);
        if (!unit || picked.includes(id) || liveUnitStatus(unit, state.dispatches) !== 'idle') continue;
        if ((baseById.get(unit.base_id)?.stock ?? Infinity) < supplyUse(unit)) continue;
        if (unitsFit([...picked, id], mission, state)) picked.push(id);
      }
      if (picked.length === ui.picked.length) toast('No free member of that task force fits this mission.', 'info');
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

    case 'auto-pick': {
      // For each place still needed, take the units with the shortest trip.
      const type = getMissionType(mission.mission_type);
      const counts = committedCounts(mission, state.dispatches);
      const baseById = new Map(state.bases.map((b) => [b.id, b]));
      const picked = [];
      for (const key of slotKeys(type)) {
        const remaining = type.requirements[key] - (counts[key] ?? 0);
        idleUnitsFor(key, state.units, state.dispatches)
          .filter((unit) => !picked.includes(unit.id))
          .filter((unit) => (baseById.get(unit.base_id)?.stock ?? Infinity) >= supplyUse(unit))
          // For ordinary places, send ordinary units before specialists.
          .map((unit) => ({ id: unit.id, eta: etaFor(unit, mission, state, baseById), special: unit.specialty ? 1 : 0 }))
          .sort((a, b) => (getCategory(key) ? a.special - b.special : 0) || a.eta - b.eta)
          .slice(0, Math.max(0, remaining))
          .forEach((x) => picked.push(x.id));
      }
      return update({ picked });
    }

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
  return mission.status === 'in_progress' && msUntil(mission.started_at) <= 0 ? '⚔' : '!';
}

