// The "Units" tab: every unit you own, grouped by category.

import { categories, getUnitType } from '../game/content.js';
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
              <span class="row-title">${esc(getUnitType(unit.unit_type).name)}</span>
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
    ${sections}`;
}
