// The "Bases" tab. It has several views, chosen by `ui.view`:
//
//   'list'    → your bases                       (the default)
//   'build'   → pick which building to construct
//   'placing' → "click the map to choose a site"
//   'confirm' → name it and confirm the purchase
//   'base'    → one base: its units and the recruit list
//
// render() only produces HTML. Buttons carry a data-action attribute; panel.js
// catches the click and calls handleAction() below.

import {
  buildings,
  getBuilding,
  getCategory,
  getUnitType,
  buildingPrice,
  unitPrice,
  canAfford,
  recruitableUnits,
  settings,
} from '../game/content.js';
import { placeBase, buyUnit, upgradeBase, dismissUnit } from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { formatLatLng } from '../map.js';
import { liveUnitStatus } from '../game/clock.js';
import { esc, fmt, statusPillHtml } from './dom.js';
import { toast } from './toast.js';

/** "5,000 funds · 100 supplies" (supplies left out when zero). */
export function priceText(price) {
  const parts = [`${fmt(price.money)} funds`];
  if (price.supplies > 0) parts.push(`${fmt(price.supplies)} supplies`);
  return parts.join(' · ');
}

const statusPill = (unit, dispatches) => statusPillHtml(liveUnitStatus(unit, dispatches));
const categoryNames = (ids) => ids.map((id) => getCategory(id)?.name ?? id).join(', ');

// ---------------------------------------------------------------- render

export function render(state, ui) {
  const { profile, bases, units } = state;
  if (!profile?.nation_id) return '';

  switch (ui.view) {
    case 'build':
      return renderBuildMenu(profile, bases);
    case 'placing':
      return renderPlacing(ui);
    case 'confirm':
      return renderConfirm(profile, ui);
    case 'base':
      return renderBase(profile, bases, units, ui, state.dispatches);
    default:
      return renderList(profile, bases, units);
  }
}

function renderList(profile, bases, units) {
  if (bases.length === 0) {
    const hq = buildings.find((b) => b.is_hq);
    return `
      <div class="card">
        <h2>Establish your Headquarters</h2>
        <p>Every campaign starts with a command post. Choose where to build it —
           missions will appear in the area around your bases.</p>
        <p class="muted">Cost: ${priceText(buildingPrice(hq, profile.nation_id))}</p>
        <button class="btn btn--primary btn--block" data-action="build" data-type="${esc(hq.id)}">
          Choose a site
        </button>
      </div>`;
  }

  const rows = bases
    .map((base) => {
      const type = getBuilding(base.building_type);
      const stationed = units.filter((u) => u.base_id === base.id).length;
      return `
        <button class="row" data-action="open-base" data-base="${esc(base.id)}">
          <span class="row-icon">${esc(type.icon)}</span>
          <span class="row-main">
            <span class="row-title">${esc(base.name)}</span>
            <span class="row-sub">${esc(type.name)}</span>
          </span>
          <span class="row-side">${stationed} / ${type.unit_capacity * base.level}</span>
        </button>`;
    })
    .join('');

  return `
    <div class="section-head">
      <h2>Your bases <span class="count">${bases.length}</span></h2>
      <button class="btn btn--small" data-action="show-build">+ Build</button>
    </div>
    <div class="rows">${rows}</div>`;
}

function renderBuildMenu(profile, bases) {
  const hasHq = bases.some((b) => getBuilding(b.building_type)?.is_hq);

  const items = buildings
    .filter((b) => !(b.is_hq && hasHq)) // only one HQ allowed
    .map((b) => {
      const price = buildingPrice(b, profile.nation_id);
      // Work out why the button should be disabled, if at all.
      let blocked = '';
      if (profile.level < b.min_level) blocked = `Unlocks at level ${b.min_level}`;
      else if (!canAfford(profile, price)) blocked = 'Not enough funds or supplies';

      return `
        <div class="card option ${blocked ? 'is-blocked' : ''}">
          <div class="option-head">
            <span class="row-icon">${esc(b.icon)}</span>
            <h2>${esc(b.name)}</h2>
          </div>
          <p>${esc(b.description)}</p>
          <p class="muted">Stations ${b.unit_capacity} units: ${esc(categoryNames(b.unlocks_categories))}</p>
          <div class="option-foot">
            <span class="price">${priceText(price)}</span>
            <button class="btn btn--small" data-action="build" data-type="${esc(b.id)}"
                    ${blocked ? 'disabled' : ''}>${blocked || 'Choose a site'}</button>
          </div>
        </div>`;
    })
    .join('');

  return `
    <div class="section-head">
      <h2>Build a base</h2>
      <button class="btn btn--small" data-action="back">Back</button>
    </div>
    ${items}`;
}

function renderPlacing(ui) {
  const type = getBuilding(ui.buildingType);
  return `
    <div class="card card--notice">
      <h2>Choose a site</h2>
      <p>Click the map where you want to build your <strong>${esc(type.name)}</strong>.</p>
      <button class="btn btn--block" data-action="back">Cancel</button>
    </div>`;
}

function renderConfirm(profile, ui) {
  const type = getBuilding(ui.buildingType);
  return `
    <form class="card card--notice" data-form="confirm-base">
      <h2>Build ${esc(type.name)} here?</h2>
      <p class="muted">${esc(formatLatLng(ui.latlng))}<br />Click the map again to move it.</p>
      <label class="field">
        <span>Base name</span>
        <input name="name" type="text" maxlength="40" placeholder="${esc(type.name)}" autocomplete="off" />
      </label>
      <p>Cost: <strong>${priceText(buildingPrice(type, profile.nation_id))}</strong></p>
      <button class="btn btn--primary btn--block" type="submit" ${ui.busy ? 'disabled' : ''}>
        ${ui.busy ? 'Building…' : 'Confirm'}
      </button>
      <button class="btn btn--block" type="button" data-action="back">Cancel</button>
    </form>`;
}

function renderBase(profile, bases, units, ui, dispatches) {
  const base = bases.find((b) => b.id === ui.baseId);
  if (!base) return renderList(profile, bases, units);

  const type = getBuilding(base.building_type);
  const stationed = units.filter((u) => u.base_id === base.id);
  const capacity = type.unit_capacity * base.level;
  const full = stationed.length >= capacity;

  const stationedRows = stationed.length
    ? stationed
        .map((unit) => {
          const ut = getUnitType(unit.unit_type);
          return `
            <div class="row row--static">
              <span class="row-icon row-icon--unit">${esc(getCategory(ut.category_id).icon)}</span>
              <span class="row-main"><span class="row-title">${esc(ut.name)}</span></span>
              ${statusPill(unit, dispatches)}
              ${liveUnitStatus(unit, dispatches) === 'idle'
                ? `<button class="btn btn--small btn--quiet" data-action="dismiss" data-unit="${esc(unit.id)}"
                           title="Dismiss for a ${Math.round(settings.dismiss_refund * 100)}% refund"
                           data-confirm="Dismiss this ${esc(ut.name)}? You get ${Math.round(settings.dismiss_refund * 100)}% of its cost back."
                           aria-label="Dismiss ${esc(ut.name)}">✕</button>`
                : ''}
            </div>`;
        })
        .join('')
    : '<p class="muted">No units stationed here yet.</p>';

  const recruitRows = recruitableUnits(base.building_type, profile.nation_id)
    .map((ut) => {
      const price = unitPrice(ut, profile.nation_id);
      let blocked = '';
      if (full) blocked = 'Base full';
      else if (profile.level < ut.min_level) blocked = `Level ${ut.min_level}`;
      else if (!canAfford(profile, price)) blocked = 'Too costly';

      return `
        <div class="row row--static">
          <span class="row-icon row-icon--unit">${esc(getCategory(ut.category_id).icon)}</span>
          <span class="row-main">
            <span class="row-title">${esc(ut.name)}</span>
            <span class="row-sub">${esc(getCategory(ut.category_id).name)} · ${ut.speed_kmh} km/h · power ${ut.power}</span>
            <span class="row-sub price">${priceText(price)}</span>
          </span>
          <button class="btn btn--small" data-action="buy" data-unit="${esc(ut.id)}"
                  ${blocked || ui.busy ? 'disabled' : ''}>${blocked || 'Recruit'}</button>
        </div>`;
    })
    .join('');

  return `
    <div class="section-head">
      <h2>${esc(base.name)}</h2>
      <button class="btn btn--small" data-action="back">Back</button>
    </div>
    <p class="muted">${esc(type.name)} · ${esc(formatLatLng(base))}
      · <button class="link-btn" data-action="focus-base">Show on map</button></p>

    ${renderUpgrade(profile, base, type, ui)}

    <h3>Stationed <span class="count">${stationed.length} / ${capacity}</span></h3>
    <div class="rows">${stationedRows}</div>

    <h3>Recruit</h3>
    <div class="rows">${recruitRows}</div>`;
}

/** The "upgrade this base" line. */
function renderUpgrade(profile, base, type, ui) {
  if (base.level >= settings.max_base_level) {
    return `<p class="muted">Level ${base.level} (maximum).</p>`;
  }
  // Going from level N to N+1 costs N times the building's price.
  const price = buildingPrice(type, profile.nation_id);
  price.money *= base.level;
  price.supplies *= base.level;
  const affordable = canAfford(profile, price);
  return `
    <div class="upgrade">
      <span class="muted">Level ${base.level} of ${settings.max_base_level}.
        Upgrading adds room for ${type.unit_capacity} more units.</span>
      <button class="btn btn--small" data-action="upgrade-base" ${!affordable || ui.busy ? 'disabled' : ''}>
        ${affordable ? 'Upgrade' : 'Needs'} · ${priceText(price)}</button>
    </div>`;
}

// ---------------------------------------------------------------- actions

/**
 * Called by panel.js when something with data-action is clicked.
 * `ctx` gives access to: state, ui, update(patch) to change the view,
 * and baseLayer for map markers.
 */
export async function handleAction(action, data, ctx) {
  const { ui, update, baseLayer, state } = ctx;

  switch (action) {
    case 'show-build':
      return update({ view: 'build' });

    case 'build': // a building type was chosen → wait for a map click
      return update({ view: 'placing', buildingType: data.type, latlng: null });

    case 'open-base':
      return update({ view: 'base', baseId: data.base });

    case 'focus-base': {
      const base = state.bases.find((b) => b.id === ui.baseId);
      if (base) baseLayer.focus(base);
      return;
    }

    case 'back':
      return update({ view: 'list', buildingType: null, latlng: null, baseId: null });

    case 'upgrade-base': {
      update({ busy: true });
      try {
        await upgradeBase(ui.baseId);
        toast('Base upgraded.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });
    }

    case 'dismiss': {
      try {
        const result = await dismissUnit(data.unit);
        toast(`Unit dismissed: +${fmt(result.refund_money)} funds returned.`, 'info');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return;
    }

    case 'buy': {
      update({ busy: true });
      try {
        const unit = await buyUnit(ui.baseId, data.unit);
        toast(`${getUnitType(unit.unit_type).name} recruited.`, 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return update({ busy: false });
    }
  }
}

/** Called by panel.js when the confirm form is submitted. */
export async function handleSubmit(formName, values, ctx) {
  const { ui, update } = ctx;
  if (formName !== 'confirm-base' || !ui.latlng) return;

  update({ busy: true });
  try {
    const base = await placeBase(ui.buildingType, ui.latlng, values.name);
    toast(`${base.name} established.`, 'ok');
    ctx.baseLayer.focus(base); // zoom in so nearby missions are easy to see
    // Jump straight into the new base so the player can recruit.
    update({ busy: false, view: 'base', baseId: base.id, buildingType: null, latlng: null });
  } catch (error) {
    toast(friendlyError(error), 'error');
    update({ busy: false });
  }
}

/** Called by panel.js when the map is clicked. Returns true if we used the click. */
export function handleMapClick(latlng, ctx) {
  const { ui, update } = ctx;
  if (ui.view !== 'placing' && ui.view !== 'confirm') return false;
  update({ view: 'confirm', latlng });
  return true;
}
