// The "Units" tab: every unit you own, grouped by category.

import { categories, getUnitType, unitTitle, divisionTier, divisionSlots, settings } from '../game/content.js';
import { deleteTaskForce, createDivision, renameDivision, disbandDivision, endLoan, loadLoans } from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { toast } from './toast.js';
import { unitIcon } from './icons.js';
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
      </div>
      ${renderLoans(state)}`;
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
            <span class="row-icon row-icon--unit">${unitIcon(unit.unit_type)}</span>
            <span class="row-main">
              <span class="row-title">${esc(unitTitle(unit))}</span>
              <span class="row-sub">${esc(baseName.get(unit.base_id) ?? 'Unknown base')}
                ${unit.captured ? '<span class="tag tag--bad">Captured</span>' : ''}
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
    ${renderDivisions(state)}
    ${renderLoans(state)}
    ${renderTaskForces(state)}`;
}

function renderDivisions({ divisions, units, profile }) {
  const slots = divisionSlots(profile.level);
  const cards = divisions.map((d) => {
    const members = units.filter((u) => u.division_id === d.id);
    const hasStaff = members.some((u) => getUnitType(u.unit_type)?.category_id === 'command');
    const tier = divisionTier(d.missions_done);
    return `
      <div class="card option">
        <div class="option-head">
          <h2>${esc(d.name)}</h2>
          <span class="count">${tier.name}</span>
        </div>
        <p class="muted">${members.length} / ${settings.division_max_units} units · ${d.missions_done} missions together${
          tier.next ? ` (next standing at ${tier.next})` : ''}</p>
        <p class="${hasStaff ? 'price' : 'muted'}">${hasStaff
          ? `Fighting as a formation: +${Math.round(tier.bonus * 100)}% power when two or more of its units go on the same mission.`
          : 'No command unit attached, so no formation bonus yet. Add a command unit from your Headquarters.'}</p>
        <p class="muted">${esc(members.slice(0, 6).map(unitTitle).join(', '))}${members.length > 6 ? '…' : ''}${
          members.length === 0 ? 'No units yet. Open a unit and choose this division.' : ''}</p>
        <div class="option-foot">
          <button class="btn btn--small" data-action="rename-division" data-division="${esc(d.id)}">Rename</button>
          <button class="btn btn--small" data-action="disband-division" data-division="${esc(d.id)}"
                  data-confirm="Disband ${esc(d.name)}? Its units stay; its experience is lost.">Disband</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="section-head section-head--sub">
      <h3>Divisions <span class="count">${divisions.length} / ${slots}</span></h3>
      <button class="btn btn--small" data-action="create-division" ${divisions.length >= slots ? 'disabled' : ''}>
        ${divisions.length >= slots ? `Next at level ${(Math.floor(profile.level / settings.division_level_step) + 1) * settings.division_level_step}` : '+ Form a division'}</button>
    </div>
    ${cards || '<p class="muted">A division is a named group of up to ' + settings.division_max_units + ' units that gains experience by fighting together.</p>'}`;
}

/** Units of ours that an ally is using for now. */
function renderLoans({ loans }) {
  if (!loans.length) return '';
  const rows = loans.map((l) => `
    <div class="row row--static">
      <span class="row-icon row-icon--unit">${unitIcon(l.unit_type)}</span>
      <span class="row-main">
        <span class="row-title">${esc(l.name || getUnitType(l.unit_type)?.name || l.unit_type)}</span>
        <span class="row-sub">with ${esc(l.borrower)} until ${new Date(l.lent_until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
          ${l.status === 'idle' ? '' : '· out on a mission'}</span>
      </span>
      <button class="btn btn--small" data-action="recall-loan" data-unit="${esc(l.id)}">Recall</button>
    </div>`).join('');
  return `<h3>Out on loan <span class="count">${loans.length}</span></h3><div class="rows">${rows}</div>`;
}

/** Called by panel.js each time this tab is opened. */
export function onShow() {
  loadLoans().catch(() => {});
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

export async function handleAction(action, data, ctx) {
  try {
    if (action === 'recall-loan') {
      const home = await endLoan(data.unit);
      toast(home ? 'The unit is back with you.' : 'It will come home as soon as it is back at base.', 'ok');
    } else if (action === 'delete-force') {
      await deleteTaskForce(data.force);
      toast('Task force deleted.', 'info');
    } else if (action === 'create-division') {
      const name = window.prompt('Name for the division (for example "1st Infantry Division"):', '');
      if (!name) return;
      await createDivision(name);
      toast('Division formed. Open a unit to assign it.', 'ok');
    } else if (action === 'rename-division') {
      const current = ctx.state.divisions.find((d) => d.id === data.division);
      const name = window.prompt('New name for the division:', current?.name ?? '');
      if (!name) return;
      await renameDivision(data.division, name);
    } else if (action === 'disband-division') {
      await disbandDivision(data.division);
      toast('Division disbanded.', 'info');
    }
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}
