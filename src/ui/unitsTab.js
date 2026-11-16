// The "Units" tab: every unit you own, grouped by category.

import { categories, getUnitType } from '../game/content.js';
import { esc } from './dom.js';

export function render(state) {
  const { profile, bases, units } = state;
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
          <button class="row" data-action="open-base" data-base="${esc(unit.base_id)}">
            <span class="row-icon row-icon--unit">${esc(cat.icon)}</span>
            <span class="row-main">
              <span class="row-title">${esc(getUnitType(unit.unit_type).name)}</span>
              <span class="row-sub">${esc(baseName.get(unit.base_id) ?? 'Unknown base')}</span>
            </span>
            <span class="status status--${esc(unit.status)}">${esc(unit.status.replace('_', ' '))}</span>
          </button>`
        )
        .join('');

      return `<h3>${esc(cat.name)} <span class="count">${mine.length}</span></h3>
              <div class="rows">${rows}</div>`;
    })
    .join('');

  const idle = units.filter((u) => u.status === 'idle').length;

  return `
    <div class="section-head">
      <h2>Your units <span class="count">${units.length}</span></h2>
      <span class="muted">${idle} ready</span>
    </div>
    ${sections}`;
}
