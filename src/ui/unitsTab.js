// The "Units" tab: every unit you own, grouped by category.

import { categories, getUnitType, unitTitle } from '../game/content.js';
import { deleteTaskForce } from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { toast } from './toast.js';
import { liveUnitStatus } from '../game/clock.js';
import { esc, statusPillHtml } from './dom.js';
import { specialtyTag, veterancyLabel } from './baseViews.js';

const statusPill = (unit, dispatches) => statusPillHtml(liveUnitStatus(unit, dispatches));

export function render(state) {
  const { profile, bases, units, dispatches } = state;
  if (!profile?.nation_id) return '';

  if (units.length === 0) {
    return `
      <div class="card card--empty">
        <h2>No units yet</h2>
        <p>Open one of your bases in the <strong>Bases</strong> tab to recruit units.</p>
      </div>`;
  }

  const baseName = new Map(bases.map((b) => [b.id, b.name]));

  // Build one section per category, in the order defined in categories.json.
  const sections = categories
    .map((cat) => {
      const mine = units.filter((u) => getUnitType(u.unit_type)?.category_id === cat.id);
      if (mine.length === 0) return '';

      const rows = mine
        .map(
          (unit) => `
          <button class="row" data-action="open-unit" data-unit="${esc(unit.id)}">
            <span class="row-icon row-icon--unit">${esc(cat.icon)}</span>
            <span class="row-main">
              <span class="row-title">${esc(unitTitle(unit))}</span>
              <span class="row-sub">${esc(baseName.get(unit.base_id) ?? 'Unknown base')}
                ${veterancyLabel(unit)} ${specialtyTag(unit, profile.nation_id)}</span>
            </span>
            ${statusPill(unit, dispatches)}
          </button>`
        )
        .join('');

      return `<h3>${esc(cat.name)} <span class="count">${mine.length}</span></h3>
              <div class="rows">${rows}</div>`;
    })
    .join('');

  const idle = units.filter((u) => liveUnitStatus(u, dispatches) === 'idle').length;

  return `
    <div class="section-head">
      <h2>Your units <span class="count">${units.length}</span></h2>
      <span class="muted">${idle} ready</span>
    </div>
    ${sections}
    ${renderTaskForces(state)}`;
}

function renderTaskForces({ taskForces, units }) {
  if (taskForces.length === 0) {
    return `<h3>Task forces</h3>
            <p class="muted">None saved. When choosing units for a mission, use
              “Save this selection as a task force” to pick the same group again with one click.</p>`;
  }
  const rows = taskForces.map((f) => {
    const members = f.unit_ids.map((id) => units.find((u) => u.id === id)).filter(Boolean);
    return `
      <div class="row row--static">
        <span class="row-main">
          <span class="row-title">${esc(f.name)}</span>
          <span class="row-sub">${members.length} unit${members.length === 1 ? '' : 's'}:
            ${esc(members.slice(0, 4).map(unitTitle).join(', '))}${members.length > 4 ? '…' : ''}</span>
        </span>
        <button class="btn btn--small btn--quiet" data-action="delete-force" data-force="${esc(f.id)}"
                data-confirm="Delete the task force ${esc(f.name)}? The units themselves are not affected."
                aria-label="Delete task force">✕</button>
      </div>`;
  }).join('');
  return `<h3>Task forces <span class="count">${taskForces.length}</span></h3><div class="rows">${rows}</div>`;
}

export async function handleAction(action, data) {
  if (action !== 'delete-force') return;
  try {
    await deleteTaskForce(data.force);
    toast('Task force deleted.', 'info');
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}
