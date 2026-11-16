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
} from '../game/content.js';
import { dispatchUnits, recallUnits, shareMission } from '../game/actions.js';
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
      const cat = getCategory(categoryId);
      return `<span class="chip ${have >= needed ? 'is-met' : ''}" title="${esc(cat.name)}">
                ${esc(cat.icon)} ${have}/${needed}</span>`;
    })
    .join('');
}

const difficultyPips = (n) =>
  `<span class="pips" title="Difficulty ${n} of 5">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`;

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
  return renderList(state);
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
            <span class="row-icon row-icon--unit ${ally ? 'row-icon--ally' : ''}">${esc(getCategory(d.category_id).icon)}</span>
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

/** The list of idle units you can tick and send. */
function renderPicker(state, ui, mission, type, counts) {
  const { profile, bases, units, dispatches } = state;
  const baseById = new Map(bases.map((b) => [b.id, b]));
  const picked = new Set(ui.picked);
  let sections = '';
  let anyChoice = false;

  // One section per category the mission still needs, in the usual order.
  for (const cat of categories) {
    const needed = type.requirements[cat.id];
    if (!needed) continue;
    const remaining = needed - (counts[cat.id] ?? 0);
    if (remaining <= 0) continue;

    const candidates = idleUnitsOf(cat.id, units, dispatches)
      .map((unit) => ({
        unit,
        eta: travelSeconds(getUnitType(unit.unit_type), baseById.get(unit.base_id), mission, profile.nation_id, state.alliance),
      }))
      .sort((a, b) => a.eta - b.eta); // fastest first

    const rows = candidates.length
      ? candidates
          .map(({ unit, eta }) => {
            const on = picked.has(unit.id);
            return `
              <button class="row row--pick ${on ? 'is-picked' : ''}" data-action="toggle-unit"
                      data-unit="${esc(unit.id)}" data-category="${esc(cat.id)}" aria-pressed="${on}">
                <span class="check">${on ? '✓' : ''}</span>
                <span class="row-main">
                  <span class="row-title">${esc(getUnitType(unit.unit_type).name)}</span>
                  <span class="row-sub">${esc(baseById.get(unit.base_id)?.name ?? '')}</span>
                </span>
                <span class="row-side">${formatDuration(eta * 1000)}</span>
              </button>`;
          })
          .join('')
      : `<p class="muted">No ${esc(cat.name)} units ready. Recruit some at a base that stations them.</p>`;

    if (candidates.length) anyChoice = true;
    sections += `<h3>${esc(cat.name)} <span class="count">need ${remaining}</span></h3>
                 <div class="rows">${rows}</div>`;
  }

  if (!sections) return ''; // everything already committed

  return `
    ${sections}
    <div class="btn-row btn--spaced">
      <button class="btn" data-action="auto-pick" ${anyChoice ? '' : 'disabled'}>Select fastest</button>
      <button class="btn btn--primary" data-action="dispatch"
              ${picked.size === 0 || ui.busy ? 'disabled' : ''}>
        ${ui.busy ? 'Sending…' : `Dispatch ${picked.size || ''}`}
      </button>
    </div>`;
}

function idleUnitsOf(categoryId, units, dispatches) {
  return units.filter(
    (u) =>
      getUnitType(u.unit_type)?.category_id === categoryId &&
      liveUnitStatus(u, dispatches) === 'idle'
  );
}

// ---------------------------------------------------------------- ticking

/** Called once a second by panel.js: refresh countdowns without re-drawing. */
export function tick(root, state) {
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

    case 'toggle-unit': {
      const picked = new Set(ui.picked);
      if (picked.has(data.unit)) {
        picked.delete(data.unit);
      } else {
        // Don't let the player tick more units of a category than are needed.
        const type = getMissionType(mission.mission_type);
        const remaining =
          type.requirements[data.category] -
          (committedCounts(mission, state.dispatches)[data.category] ?? 0);
        const already = [...picked].filter((id) => {
          const unit = state.units.find((u) => u.id === id);
          return unit && getUnitType(unit.unit_type).category_id === data.category;
        }).length;
        if (already >= remaining) {
          return toast(`This mission only needs ${remaining} more ${getCategory(data.category).name}.`, 'info');
        }
        picked.add(data.unit);
      }
      return update({ picked: [...picked] });
    }

    case 'auto-pick': {
      // For each category still needed, take the units with the shortest trip.
      const type = getMissionType(mission.mission_type);
      const counts = committedCounts(mission, state.dispatches);
      const baseById = new Map(state.bases.map((b) => [b.id, b]));
      const picked = [];
      for (const [categoryId, needed] of Object.entries(type.requirements)) {
        const remaining = needed - (counts[categoryId] ?? 0);
        idleUnitsOf(categoryId, state.units, state.dispatches)
          .map((unit) => ({
            id: unit.id,
            eta: travelSeconds(getUnitType(unit.unit_type), baseById.get(unit.base_id), mission, state.profile.nation_id, state.alliance),
          }))
          .sort((a, b) => a.eta - b.eta)
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

