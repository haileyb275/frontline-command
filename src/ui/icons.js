// Icons for units and buildings, drawn as small SVG pictures.
//
// UNITS use military map symbols: a frame with a mark inside that says what
// kind of unit it is (crossed lines for infantry, an oval for armor, a dot
// for artillery…). Variants of a branch add to the mark: a heavy tank's oval
// is filled, a tank destroyer shows the anti-tank chevron inside an oval.
//
// BUILDINGS use plain pictograms (a flag, an anchor, a flame…).
//
// To give a unit a different icon, set its "icon" in src/data/units.json to
// one of the keys in UNIT_MARKS below. To add a new one, add a key here.
// Everything is drawn in "currentColor", so icons take the colour of the
// text around them and need no separate styling per place they appear.

import { getCategory, getUnitType, getSpecialty } from '../game/content.js';

const svg = (inner, label) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}">${inner}</svg>`;

// The frame every unit symbol sits in.
const FRAME = '<rect x="2.5" y="5.5" width="19" height="13" rx="1"/>';
const OVAL = '<ellipse cx="12" cy="12" rx="6" ry="3.4"/>';

// The mark inside the frame, by icon key.
const UNIT_MARKS = {
  // ---- one per branch
  infantry: '<path d="M2.5 5.5 21.5 18.5M21.5 5.5 2.5 18.5"/>',
  armor: OVAL,
  anti_tank: '<path d="M2.5 18.5 12 6l9.5 12.5"/>',
  artillery: '<circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
  air: '<path d="M6 8.5v7l6-3.5zM18 8.5v7l-6-3.5z" fill="currentColor" stroke-width="1"/>',
  recon: '<path d="M2.5 18.5 21.5 5.5"/>',
  medical: '<path d="M12 5.5v13M2.5 12h19"/>',
  engineers: '<path d="M6 15V9.5h12V15M12 9.5V15"/>',
  logistics: '<path d="M2.5 14.5h19"/><circle cx="12" cy="10" r="1.6"/>',
  naval: '<path d="M12 8v8M9 10.5h6M7.5 13.5c.6 2 2.3 3 4.5 3s3.9-1 4.5-3"/><circle cx="12" cy="7.6" r=".9"/>',
  military_police: '<text x="12" y="15" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">MP</text>',
  fire: '<path d="M12 7.2c.6 2 2.8 2.9 2.8 5.3A2.8 2.8 0 0 1 12 15.4a2.8 2.8 0 0 1-2.8-2.9c0-1.2.7-1.8 1.2-2.6.4.7.9 1 1.2 1 .2-1.2-.3-2.4.400-3.700z" fill="currentColor" stroke-width="1"/>',
  command: '<path d="M8 16V8.200M8 8.200h7.500l-2 2.3 2 2.300H8" />',

  // ---- variants within a branch
  armor_heavy: '<ellipse cx="12" cy="12" rx="6" ry="3.4" fill="currentColor"/>',
  armor_light: '<ellipse cx="12" cy="12" rx="6" ry="3.4" stroke-dasharray="2.2 2"/>',
  armor_medium: OVAL + '<path d="M6 12h12"/>',
  anti_tank_sp: OVAL + '<path d="M2.5 18.5 12 6l9.5 12.5"/>',
  infantry_mg: '<path d="M2.5 5.5 21.5 18.5M21.5 5.5 2.5 18.5"/><path d="M12 8v8M10.3 9.7 12 8l1.7 1.7" stroke-width="1.5"/>',
  artillery_heavy: '<circle cx="8.8" cy="12" r="2.2" fill="currentColor"/><circle cx="15.2" cy="12" r="2.2" fill="currentColor"/>',
  artillery_rocket: '<circle cx="12" cy="14" r="2.2" fill="currentColor"/><path d="M8.5 10.5 12 7.500l3.5 3"/>',
  air_bomber: '<path d="M6 7.500v6l6-3zM18 7.500v6l-6-3z" fill="currentColor" stroke-width="1"/><path d="M8 16.200h8" stroke-width="2.2"/>',
  recon_light: '<path d="M2.5 18.5 21.5 5.5"/><circle cx="16.5" cy="14.5" r="1.9"/>',
};

const BUILDING_PICTURES = {
  hq: '<path d="M6 21V3M6 4h11l-2.5 3.500L17 11H6"/>',
  barracks: '<path d="M3 20V11l9-6 9 6v9M3 20h18M10 20v-5h4v5"/>',
  supply_depot: '<path d="M4 8.5 12 5l8 3.500v9L12 21l-8-3.500zM4 8.5 12 12l8-3.500M12 12v9"/>',
  field_hospital: '<path d="M3 20V10l9-5 9 5v10z"/><path d="M12 10.500v6M9 13.500h6" stroke-width="2.2"/>',
  artillery_park: '<circle cx="8" cy="16" r="3.5"/><path d="M8 16 20 7.500M17.8 6l2.7 3.700M3 20h18"/>',
  tank_depot: '<rect x="3" y="13" width="18" height="5.5" rx="2.7"/><path d="M7 13V9.500h7V13M14 11h6"/>',
  airfield: '<path d="M12 3c.9 0 1.5 1 1.5 2.500V10l7 4v2l-7-2v4.500l2 1.500V21l-3.5-1L8.5 21v-1l2-1.500V14l-7 2v-2l7-4V5.500C10.5 4 11.1 3 12 3z" fill="currentColor" stroke-width=".8"/>',
  naval_base: '<circle cx="12" cy="5.5" r="2"/><path d="M12 7.500V21M8 11h8M4.5 14c.7 4 3.5 7 7.5 7s6.8-3 7.5-7"/>',
  mp_post: '<path d="M12 3 5 6v5.500c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.500V6z"/><text x="12" y="14.5" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">MP</text>',
  fire_station: '<path d="M12 3c1 3.5 5 5 5 9.500a5 5 0 0 1-10 0c0-2.2 1.3-3.3 2.2-4.8.700 1.3 1.6 1.8 2.2 1.8.300-2.2-.5-4.2.600-6.500z" fill="currentColor" stroke-width="1"/>',
  training_center: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  munitions_factory: '<path d="M3 21V11l5 3v-3l5 3V6h3l1 15zM3 21h18"/><path d="M15 3.500c.6-.8 1.8-.8 2.4 0" stroke-width="1.4"/>',
  vehicle_works: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.600l2.1 2.100M16.3 16.300l2.1 2.100M5.6 18.400l2.1-2.100M16.3 7.700l2.1-2.1"/>',
  research_office: '<path d="M9.5 3h5M10.5 3v6L5 18.500A1.7 1.7 0 0 0 6.5 21h11a1.7 1.7 0 0 0 1.5-2.500L13.5 9V3M7.8 15h8.4"/>',
};

/** The symbol for a unit type (pass the object from units.json, or its id). */
export function unitIcon(unitType) {
  const type = typeof unitType === 'string' ? getUnitType(unitType) : unitType;
  if (!type) return '';
  const mark = UNIT_MARKS[type.icon] ?? UNIT_MARKS[type.category_id];
  const label = getCategory(type.category_id)?.name ?? '';
  // Anything we have no drawing for falls back to the branch's short label.
  return mark ? svg(FRAME + mark, label) : escapeText(getCategory(type.category_id)?.icon ?? '?');
}

/** The symbol for a whole branch ("infantry"), used where no single unit is meant. */
export function categoryIcon(categoryId) {
  const mark = UNIT_MARKS[categoryId];
  const cat = getCategory(categoryId);
  return mark ? svg(FRAME + mark, cat?.name ?? categoryId) : escapeText(cat?.icon ?? '?');
}

/**
 * The symbol for a place on a mission: a branch, or a specialty. Specialties
 * keep their three-letter labels (ABN, MTN…), which are quicker to read.
 */
export function slotIcon(key) {
  if (getCategory(key)) return categoryIcon(key);
  return escapeText(getSpecialty(key)?.icon ?? '?');
}

/** The pictogram for a building type. */
export function buildingIcon(buildingType) {
  const picture = BUILDING_PICTURES[buildingType?.id ?? buildingType];
  return picture ? svg(picture, buildingType?.name ?? '') : escapeText(buildingType?.icon ?? '?');
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
