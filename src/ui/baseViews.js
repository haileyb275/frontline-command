// The detailed views inside the Bases tab:
//
//   renderBase() → one base: zone, upgrade, production / training, units, recruiting
//   renderUnit() → one unit: specialty training, transfer to another base, dismissal

import {
  getBuilding,
  getCategory,
  getUnitType,
  getSpecialty,
  specialtyName,
  specialtiesFor,
  productsFor,
  getProduct,
  buildingPrice,
  unitPrice,
  canAfford,
  recruitableUnits,
  convoySeconds,
  veterancy,
  stockCapacity,
  unitTitle,
  settings,
} from '../game/content.js';
import { liveUnitStatus, formatDuration } from '../game/clock.js';
import { formatLatLng } from '../map.js';
import { esc, fmt, statusPillHtml } from './dom.js';
import { priceText } from './basesTab.js';

const pct = (mult) => `${mult > 1 ? '+' : ''}${Math.round((mult - 1) * 100)}%`;

/** A live countdown; basesTab.tick() refreshes the text every second. */
const countdown = (iso) => `<span class="js-countdown" data-until="${esc(iso)}"></span>`;

/** "Fallschirmjäger" tag for a unit that holds a specialty. */
export function specialtyTag(unit, nationId) {
  const spec = getSpecialty(unit.specialty);
  return spec ? `<span class="tag tag--spec" title="${esc(spec.name)}">${esc(specialtyName(spec, nationId))}</span>` : '';
}

/** "★★ Veteran" for a unit (nothing for green units). */
export function veterancyLabel(unit) {
  const v = veterancy(unit.missions_done);
  return v.tier > 0 ? `<span class="vet" title="${v.name}: +${Math.round((v.powerMult - 1) * 100)}% power">${'★'.repeat(v.tier)} ${v.name}</span>` : '';
}

/** How many training places the player has, and how many are in use. */
export function trainingPlaces(state) {
  const total = state.bases.reduce(
    (sum, b) => sum + (getBuilding(b.building_type)?.training_slots ?? 0) * b.level, 0);
  const used = state.units.filter((u) => u.status === 'training').length;
  return { total, used };
}

// ------------------------------------------------------------------ base

export function renderBase(state, ui) {
  const { profile, bases, units, dispatches } = state;
  const base = bases.find((b) => b.id === ui.baseId);
  if (!base) return null;

  const type = getBuilding(base.building_type);
  const stationed = units.filter((u) => u.base_id === base.id);
  const capacity = type.unit_capacity * base.level;

  let sections = '';

  // ---- Factory
  const products = productsFor(type.id);
  if (products.length > 0) sections += renderProduction(state, ui, base, products);

  // ---- Training Center
  if (type.training_slots > 0) {
    const places = trainingPlaces(state);
    const trainees = units.filter((u) => u.status === 'training');
    const rows = trainees.length
      ? trainees.map((u) => `
          <div class="row row--static">
            <span class="row-icon row-icon--unit">${esc(getSpecialty(u.training_specialty)?.icon ?? '')}</span>
            <span class="row-main">
              <span class="row-title">${esc(getUnitType(u.unit_type).name)}</span>
              <span class="row-sub">training as ${esc(specialtyName(getSpecialty(u.training_specialty), profile.nation_id))}</span>
            </span>
            <span class="status">${countdown(u.busy_until)}</span>
          </div>`).join('')
      : '<p class="muted">No courses running. Open any idle unit (from its base or the Units tab) and choose a specialty.</p>';
    sections += `<h3>Courses <span class="count">${places.used} / ${places.total}</span></h3><div class="rows">${rows}</div>`;
  }

  // ---- Units and recruiting (only for buildings that station units)
  if (type.unit_capacity > 0) {
    const full = stationed.length >= capacity;
    const stationedRows = stationed.length
      ? stationed.map((unit) => {
          const ut = getUnitType(unit.unit_type);
          return `
            <button class="row" data-action="open-unit" data-unit="${esc(unit.id)}">
              <span class="row-icon row-icon--unit">${esc(getCategory(ut.category_id).icon)}</span>
              <span class="row-main">
                <span class="row-title">${esc(unitTitle(unit))}</span>
                <span class="row-sub">${unit.name ? `${esc(ut.name)} ` : ''}${veterancyLabel(unit)} ${specialtyTag(unit, profile.nation_id)}</span>
              </span>
              ${statusPillHtml(liveUnitStatus(unit, dispatches))}
            </button>`;
        }).join('')
      : '<p class="muted">No units stationed here yet.</p>';

    const recruitRows = recruitableUnits(base.building_type, profile.nation_id).map((ut) => {
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
    }).join('');

    sections += `
      <h3>Stationed <span class="count">${stationed.length} / ${capacity}</span></h3>
      <div class="rows">${stationedRows}</div>
      <h3>Recruit</h3>
      <div class="rows">${recruitRows}</div>`;
  }

  return `
    <div class="section-head">
      <h2>${esc(base.name)}</h2>
      <button class="btn btn--small" data-action="back">Back</button>
    </div>
    <p class="muted">${esc(type.name)} · ${esc(formatLatLng(base))}
      · <button class="link-btn" data-action="focus-base">Show on map</button>
      · <button class="link-btn" data-action="rename-base">Rename</button></p>

    ${renderZone(base, ui)}
    ${renderUpgrade(profile, base, type, ui)}
    ${renderStock(state, base, ui)}
    ${sections}`;
}

/** The base's own stock of supplies, with resupply controls. */
function renderStock(state, base, ui) {
  const cap = stockCapacity(base);
  if (cap === 0) return ''; // factories and training centers send nobody out
  const stock = base.stock ?? cap;
  const inbound = state.shipments.filter((s) => s.to_base_id === base.id);
  const low = stock < cap * settings.resupply_threshold;
  return `
    <div class="upgrade stock ${low ? 'is-low' : ''}">
      <span>
        <strong>Supplies on hand: ${fmt(stock)} / ${fmt(cap)}</strong>
        <span class="meter"><span style="width: ${Math.round((stock / cap) * 100)}%"></span></span>
        <span class="muted">Every unit sent out draws on this.
          ${inbound.length ? `A resupply convoy arrives in ${countdown(inbound[0].arrives_at)}.` : ''}</span>
        <label class="check-line">
          <input type="checkbox" data-action="auto-resupply" ${base.auto_resupply ? 'checked' : ''} />
          Resupply automatically when low
        </label>
      </span>
      <button class="btn btn--small" data-action="resupply"
              ${stock >= cap || inbound.length || ui.busy ? 'disabled' : ''}>
        ${inbound.length ? 'On its way' : stock >= cap ? 'Full' : 'Resupply'}</button>
    </div>`;
}

function renderZone(base, ui) {
  const home = base.zone === 'home';
  return `
    <div class="upgrade zone zone--${esc(base.zone)}">
      <span>
        <strong>${home ? 'Home front' : 'Front line'}</strong>
        <span class="muted">${home
          ? ` · no enemy contact within ${settings.home_safe_km} km; only fires, security and supply calls`
          : ' · enemy contact can occur around this base'}</span>
      </span>
      <button class="btn btn--small" data-action="set-zone" data-zone="${home ? 'front' : 'home'}"
              ${ui.busy ? 'disabled' : ''}>${home ? 'Move to front line' : 'Move to home front'}</button>
    </div>`;
}

function renderUpgrade(profile, base, type, ui) {
  if (base.level >= settings.max_base_level) {
    return `<p class="muted">Level ${base.level} (maximum).</p>`;
  }
  // Going from level N to N+1 costs N times the building's price.
  const price = buildingPrice(type, profile.nation_id);
  price.money *= base.level;
  price.supplies *= base.level;
  const affordable = canAfford(profile, price);
  const gain = type.unit_capacity > 0
    ? `adds room for ${type.unit_capacity} more units`
    : type.training_slots > 0
      ? `adds ${type.training_slots} more training places`
      : 'increases what each production run makes';
  return `
    <div class="upgrade">
      <span class="muted">Level ${base.level} of ${settings.max_base_level}. Upgrading ${gain}.</span>
      <button class="btn btn--small" data-action="upgrade-base" ${!affordable || ui.busy ? 'disabled' : ''}>
        ${affordable ? 'Upgrade' : 'Needs'} · ${priceText(price)}</button>
    </div>`;
}

function renderProduction(state, ui, base, products) {
  const { profile, bases, shipments } = state;
  const hq = bases.find((b) => getBuilding(b.building_type)?.is_hq);
  const shipping = hq && hq.id !== base.id
    ? `Finished goods travel to ${esc(hq.name)} by convoy: about ${formatDuration(convoySeconds(base, hq) * 1000)}.`
    : '';

  if (base.production_id) {
    const product = getProduct(base.production_id);
    return `
      <h3>Production</h3>
      <div class="card card--notice">
        <h2>${esc(product?.name ?? 'Production run')}</h2>
        <p>Ready in <strong>${countdown(base.production_done_at)}</strong>. ${shipping}</p>
      </div>`;
  }

  const rows = products.map((p) => {
    const input = { money: p.cost_money * base.level, supplies: p.cost_supplies * base.level };
    const out = [p.output_money && `${fmt(p.output_money * base.level)} funds`,
                 p.output_supplies && `${fmt(p.output_supplies * base.level)} supplies`].filter(Boolean).join(' · ');
    const cost = [input.money && `${fmt(input.money)} funds`, input.supplies && `${fmt(input.supplies)} supplies`]
      .filter(Boolean).join(' · ');
    let blocked = '';
    if (profile.level < p.min_level) blocked = `Level ${p.min_level}`;
    else if (!canAfford(profile, input)) blocked = 'Too costly';
    return `
      <div class="row row--static">
        <span class="row-main">
          <span class="row-title">${esc(p.name)}</span>
          <span class="row-sub">${formatDuration(p.duration_seconds * 1000)} · uses ${cost}</span>
          <span class="row-sub price">makes ${out}</span>
        </span>
        <button class="btn btn--small" data-action="produce" data-product="${esc(p.id)}"
                ${blocked || ui.busy ? 'disabled' : ''}>${blocked || 'Start'}</button>
      </div>`;
  }).join('');

  const afloat = shipments.length
    ? `<p class="muted">${shipments.length} convoy${shipments.length === 1 ? '' : 's'} on the way to your Headquarters.</p>`
    : '';
  return `<h3>Production</h3>
          <p class="muted">One run at a time. ${shipping}</p>
          <div class="rows">${rows}</div>${afloat}`;
}

// ------------------------------------------------------------------ unit

export function renderUnit(state, ui) {
  const { profile, bases, units, dispatches } = state;
  const unit = units.find((u) => u.id === ui.unitId);
  if (!unit) return null;

  const ut = getUnitType(unit.unit_type);
  const cat = getCategory(ut.category_id);
  const home = bases.find((b) => b.id === unit.base_id);
  const status = liveUnitStatus(unit, dispatches);
  const idle = status === 'idle';
  const spec = getSpecialty(unit.specialty);
  const places = trainingPlaces(state);
  const vet = veterancy(unit.missions_done);

  // ---- Specialties
  let training = '';
  if (status === 'training') {
    training = `<div class="card card--notice"><p>Training as
      <strong>${esc(specialtyName(getSpecialty(unit.training_specialty), profile.nation_id))}</strong>:
      ${countdown(unit.busy_until)} left.</p></div>`;
  } else {
    const options = specialtiesFor(ut.category_id);
    training = options.length
      ? options.map((s) => {
          const price = { money: s.cost_money, supplies: s.cost_supplies };
          const effects = [s.power_mult !== 1 && `${pct(s.power_mult)} power`,
                           s.speed_mult !== 1 && `${pct(s.speed_mult)} speed`,
                           'can fill specialist places on missions'].filter(Boolean).join(' · ');
          let blocked = '';
          if (unit.specialty === s.id) blocked = 'Qualified';
          else if (!idle) blocked = 'Unit busy';
          else if (places.total === 0) blocked = 'Needs a Training Center';
          else if (profile.level < s.min_level) blocked = `Level ${s.min_level}`;
          else if (places.used >= places.total) blocked = 'Courses full';
          else if (!canAfford(profile, price)) blocked = 'Too costly';
          return `
            <div class="card option ${blocked ? 'is-blocked' : ''}">
              <div class="option-head">
                <span class="row-icon row-icon--unit">${esc(s.icon)}</span>
                <h2>${esc(specialtyName(s, profile.nation_id))}</h2>
              </div>
              <p>${esc(s.description)}</p>
              <p class="muted">${esc(effects)}</p>
              <div class="option-foot">
                <span class="price">${priceText(price)} · ${formatDuration(s.training_seconds * 1000)}</span>
                <button class="btn btn--small" data-action="train" data-specialty="${esc(s.id)}"
                        ${blocked || ui.busy ? 'disabled' : ''}>${blocked || 'Train'}</button>
              </div>
            </div>`;
        }).join('')
      : `<p class="muted">No specialty courses exist for ${esc(cat.name)} units.</p>`;
    if (options.length && spec) {
      training = `<p class="muted">A unit holds one specialty; a new course replaces the current one.</p>` + training;
    }
  }

  // ---- Transfer
  const destinations = bases.filter((b) =>
    b.id !== unit.base_id && getBuilding(b.building_type).unlocks_categories.includes(ut.category_id));
  let transfer;
  if (status === 'transferring') {
    const dest = bases.find((b) => b.id === unit.transfer_base_id);
    transfer = `<div class="card card--notice"><p>In transit to <strong>${esc(dest?.name ?? 'another base')}</strong>:
      ${countdown(unit.busy_until)} left.</p></div>`;
  } else if (destinations.length === 0) {
    transfer = `<p class="muted">You have no other base that can station ${esc(cat.name)} units.</p>`;
  } else {
    transfer = `<div class="rows">${destinations.map((b) => {
      const type = getBuilding(b.building_type);
      const there = units.filter((u) => u.base_id === b.id || u.transfer_base_id === b.id).length;
      const full = there >= type.unit_capacity * b.level;
      return `
        <div class="row row--static">
          <span class="row-icon">${esc(type.icon)}</span>
          <span class="row-main">
            <span class="row-title">${esc(b.name)}</span>
            <span class="row-sub">${b.zone === 'home' ? 'Home front' : 'Front line'} ·
              ${formatDuration(convoySeconds(home, b) * 1000)} journey</span>
          </span>
          <button class="btn btn--small" data-action="transfer" data-base="${esc(b.id)}"
                  ${!idle || full || ui.busy ? 'disabled' : ''}>${full ? 'Full' : !idle ? 'Unit busy' : 'Transfer'}</button>
        </div>`;
    }).join('')}</div>`;
  }

  const refund = Math.round(settings.dismiss_refund * 100);
  return `
    <div class="section-head">
      <h2>${esc(unitTitle(unit))}</h2>
      <button class="btn btn--small" data-action="open-base" data-base="${esc(unit.base_id)}">Back</button>
    </div>
    <p class="muted">${unit.name ? `${esc(ut.name)} · ` : ''}${esc(cat.name)} · stationed at ${esc(home?.name ?? '?')} ${statusPillHtml(status)}
      ${status === 'repairing' ? `· fit again in ${countdown(unit.busy_until)}` : ''}</p>
    <p><button class="link-btn" data-action="rename-unit">${unit.name ? 'Change call sign' : 'Give this unit a call sign'}</button></p>
    <div class="facts">
      <div><span>Speed</span>${Math.round(ut.speed_kmh * (spec?.speed_mult ?? 1))} km/h</div>
      <div><span>Power</span>${Math.round(ut.power * (spec?.power_mult ?? 1) * vet.powerMult * 10) / 10}</div>
      <div><span>Experience</span>${'★'.repeat(vet.tier)} ${vet.name} · ${unit.missions_done ?? 0} missions${
        vet.next ? ` (next level at ${vet.next})` : ''}</div>
      <div><span>Specialty</span>${spec ? esc(specialtyName(spec, profile.nation_id)) : 'None'}</div>
    </div>

    <h3>Specialty training <span class="count">${places.used} / ${places.total} places</span></h3>
    ${training}

    <h3>Transfer to another base</h3>
    ${transfer}

    <button class="btn btn--block btn--spaced" data-action="dismiss" data-unit="${esc(unit.id)}"
            ${idle ? '' : 'disabled'}
            data-confirm="Dismiss this ${esc(ut.name)}? You get ${refund}% of its cost back.">
      Dismiss unit (${refund}% refund)</button>`;
}
