// Icons for units and buildings, drawn as small SVG pictures.
//
// UNITS are little silhouettes of the thing itself: a tank for a tank, a
// truck for a supply column, an aircraft, a ship, a gun on its wheels.
// Variants within a branch get their own drawing (a heavy tank is bigger
// with a longer gun, a tank destroyer has no turret, a bomber has two engines).
//
// BUILDINGS use plain pictograms (a flag, an anchor, a flame…).
//
// To give a unit a different icon, set its "icon" in src/data/units.json to
// one of the keys in UNIT_PICTURES below. To add a new one, add a key here.
// Everything is drawn in "currentColor", so icons take the colour of the
// text around them and need no separate styling per place they appear.

import { getCategory, getUnitType, getSpecialty } from '../game/content.js';

// Outline-style drawing (used by the building pictograms).
const svg = (inner, label) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}">${inner}</svg>`;

// Solid silhouette (used by the unit pictures). Lines inside one opt back in with class="l".
const solid = (inner, label) =>
  `<svg class="icon icon--solid" viewBox="0 0 24 24" fill="currentColor" stroke="none"
        stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}">${inner}</svg>`;

// Re-used pieces.
const line = (d, w = 1.7) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}"/>`;
const wheels = (...xs) => xs.map((x) => `<circle cx="${x}" cy="18.2" r="2.4"/>`).join('');
const TRACKS = '<rect x="2.5" y="14.6" width="19" height="5.4" rx="2.7"/>';
const HULL = '<path d="M4.3 14.8 6 11.6h12l1.7 3.2z"/>';
const FIGHTER = '<path d="M12 2.5c.9 0 1.5 1 1.5 2.5v4.6l7.5 4.2v2.1l-7.5-2.1v4.4l2.2 1.6V21.500L12 20.5 8.3 21.500V19.800l2.2-1.600v-4.400L3 15.900v-2.100l7.5-4.200V5c0-1.5.6-2.5 1.5-2.500z"/>';

const UNIT_PICTURES = {
  // ---- people
  infantry:
    '<path d="M8 8.200a4 4 0 0 1 8 0v.700H8z"/><circle cx="12" cy="9.6" r="2.3"/>' +
    '<path d="M7 21.500v-5.700c0-2.1 1.7-3.4 5-3.400s5 1.3 5 3.400v5.700z"/>' + line('M17.8 4.5 15.6 20.5', 1.3),
  infantry_mg:
    '<rect x="2.5" y="9.6" width="14" height="2" rx=".8"/><rect x="12.5" y="8.3" width="6.5" height="4.6" rx="1"/>' +
    '<rect x="16.5" y="13.8" width="5" height="3.8" rx=".6"/>' + line('M9.5 11.6 5.5 19.500M9.5 11.600l4 7.900M9.5 11.600v7.9'),
  military_police:
    '<path d="M6.3 6.500a3.7 3.7 0 0 1 7.4 0v.600H6.300z"/><circle cx="10" cy="7.9" r="2.2"/>' +
    '<path d="M5.5 21.500v-6c0-2 1.5-3.3 4.5-3.300s4.5 1.3 4.5 3.300v6z"/>' + line('M13.5 13.5 18 10.5', 2) +
    '<circle cx="19.3" cy="8.3" r="2.7"/>',

  // ---- tanks
  armor: TRACKS + HULL + '<rect x="8" y="7.6" width="7.5" height="4.2" rx="1.2"/><rect x="15" y="8.9" width="7" height="1.5" rx=".5"/>',
  armor_medium: TRACKS + HULL + '<rect x="7.8" y="7.6" width="8" height="4.2" rx="1.2"/><rect x="9.8" y="5.9" width="3" height="2" rx=".6"/><rect x="15.2" y="8.8" width="7.3" height="1.6" rx=".5"/>',
  armor_heavy: '<rect x="2" y="14.3" width="20" height="6" rx="3"/><path d="M3.5 14.5 5 10.800h14l1.5 3.700z"/>' +
    '<rect x="6.5" y="6" width="9.5" height="5.2" rx="1.3"/><rect x="15.5" y="7.5" width="6" height="2.1" rx=".6"/><rect x="21" y="6.9" width="1.8" height="3.3" rx=".4"/>',
  armor_light: '<rect x="4" y="15.2" width="16" height="4.8" rx="2.4"/><path d="M5.8 15.4 7.2 12.800h9.600l1.4 2.600z"/>' +
    '<rect x="9.3" y="9.4" width="5.2" height="3.6" rx="1"/><rect x="14" y="10.5" width="5.5" height="1.1" rx=".4"/>',
  anti_tank_sp: TRACKS + '<path d="M4.3 14.8 7 9.300h9.300l3.4 5.500z"/><rect x="15" y="10.6" width="7.5" height="1.7" rx=".5"/>',

  // ---- guns
  anti_tank: '<circle cx="9" cy="16.8" r="3.4"/><path d="M10 8.800l2.6-.6.9 8.2-2.6.6z"/>' +
    line('M11.5 12 22 9.8', 1.9) + line('M9 16.8 2.5 20.3', 1.9),
  artillery: '<circle cx="10" cy="16.8" r="3.6"/>' + line('M9.5 14.5 20.5 6.5', 2.6) + line('M10 16.8 3 20.5', 1.9) +
    '<rect x="7.3" y="12.8" width="4.4" height="3" rx=".7" transform="rotate(-36 9.5 14.3)"/>',
  artillery_heavy: '<circle cx="8" cy="17" r="3.3"/><circle cx="14.5" cy="17" r="3.3"/>' + line('M10 13.5 22 5.5', 3.1) + line('M8 17 2.5 20.5', 1.9),
  artillery_rocket: wheels(7, 17.5) + '<rect x="2.5" y="14.2" width="19" height="2.3" rx=".6"/><path d="M2.5 14.200v-2.700l1.6-2h3.400v4.700z"/>' +
    line('M9 12.8 21 6.300M9 10.3 19.5 4.6', 1.7),

  // ---- aircraft
  air: FIGHTER,
  air_bomber: '<ellipse cx="12" cy="12" rx="1.7" ry="9.5"/><path d="M1.5 10.800h21v2.700l-8.5 1.500h-4L1.5 13.500z"/>' +
    '<rect x="5.3" y="8.3" width="2.3" height="5" rx="1.1"/><rect x="16.4" y="8.3" width="2.3" height="5" rx="1.1"/><rect x="8" y="19" width="8" height="1.9" rx=".9"/>',

  // ---- wheeled vehicles
  recon: wheels(7, 17) + '<path d="M2.5 17v-3.600l3.2-3h10.600l5.2 3V17z"/><rect x="8.5" y="7" width="5.5" height="3.6" rx=".9"/><rect x="13.5" y="8.2" width="6" height="1.2" rx=".4"/>',
  recon_light:
    '<circle cx="6" cy="17" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="17" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    line('M6 17 9.5 11h5.500l3 6M9.5 11l3.5 6H6M15 11l1-2.800h2.5', 1.7) + '<circle cx="12" cy="7.5" r="1.9"/>',
  jeep: wheels(7, 17) + '<path d="M2.5 17v-3.200h4.200l1.6-3h5.200v3h8v3.200z"/>' + line('M13.5 10.800V8M8.3 10.8 7.3 8.3', 1.5),
  command: wheels(7, 17) + '<path d="M2.5 17v-3l3.3-.8L8.3 9.500h7l2.7 3.7 3.5.8v3z"/>' + line('M20.2 13V5.5', 1.3) + '<path d="M20.2 5.500h-5l1.6 1.8-1.6 1.800h5z"/>',
  logistics: wheels(7, 17.5) + '<path d="M2.5 17.500v-5l2-3h4v8z"/><rect x="9.3" y="7.3" width="12.2" height="10.2" rx=".7"/>',
  medical: wheels(7, 17.5) +
    '<path fill-rule="evenodd" d="M2.5 17.500v-4.800l2.3-3.200h3.700V7.300h13v10.200zM14.3 9.500v2h-2v1.900h2v2h1.900v-2h2v-1.900h-2v-2z"/>',
  fire: wheels(7, 17.5) + '<path d="M2.5 17.500v-4.500l2-3h4.500v2.500h12.500v5z"/>' + line('M9.5 8.8 22 6.300M9.8 10.3 22 7.900M13 8.100v1.600M16.5 7.400v1.600M20 6.700v1.6', 1.1),

  // ---- everything else
  engineers: '<rect x="2" y="8.5" width="20" height="2.3" rx=".6"/>' + line('M4 10.800V20M12 10.800V20M20 10.800V20', 1.9) + line('M4 19.500c0-5.5 8-5.5 8 0M12 19.500c0-5.5 8-5.5 8 0', 1.6),
  naval: '<path d="M1.5 15h21l-3 5H5z"/><rect x="8" y="11.3" width="8" height="3.7"/><rect x="10" y="8.3" width="3.5" height="3"/><rect x="14.3" y="9.3" width="1.9" height="2.1"/>' +
    '<rect x="3.8" y="13.3" width="4" height="1.1" rx=".3"/>' + line('M11.7 8.300V4.3', 1.2),
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
  fire_station: '<path d="M12 3c1 3.5 5 5 5 9.500a5 5 0 0 1-10 0c0-2.2 1.3-3.3 2.2-4.8.7 1.3 1.6 1.8 2.2 1.8.3-2.2-.5-4.2.6-6.500z" fill="currentColor" stroke-width="1"/>',
  training_center: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  munitions_factory: '<path d="M3 21V11l5 3v-3l5 3V6h3l1 15zM3 21h18"/><path d="M15 3.500c.6-.8 1.8-.8 2.4 0" stroke-width="1.4"/>',
  vehicle_works: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.600l2.1 2.100M16.3 16.300l2.1 2.100M5.6 18.400l2.1-2.100M16.3 7.700l2.1-2.1"/>',
  refinery: '<path d="M4 21V10.500h5.500V21M14 21V5.500h4.500V21M2.5 21h19M6.7 10.500V8"/><path d="M16.2 2.500c1 .9 1 1.8 0 3"/>',
  rail_yard: '<path d="M8.5 3 5 21M15.5 3 19 21M7.6 7.500h8.800M6.8 12h10.400M6 16.500h12"/>',
  port: '<path d="M2.5 21h19M7 21V5.500M7 5.500l12.5 3M7 5.5 4 9M18.5 8.300v5"/><rect x="16.3" y="13.3" width="4.4" height="3.4"/>',
  research_office: '<path d="M9.5 3h5M10.5 3v6L5 18.500A1.7 1.7 0 0 0 6.5 21h11a1.7 1.7 0 0 0 1.5-2.500L13.5 9V3M7.8 15h8.4"/>',
};

/** The picture for a unit type (pass the object from units.json, or its id). */
export function unitIcon(unitType) {
  const type = typeof unitType === 'string' ? getUnitType(unitType) : unitType;
  if (!type) return '';
  const picture = UNIT_PICTURES[type.icon] ?? UNIT_PICTURES[type.category_id];
  // Anything we have no drawing for falls back to the branch's short label.
  return picture ? solid(picture, type.name) : escapeText(getCategory(type.category_id)?.icon ?? '?');
}

/** The picture for a whole branch ("infantry"), used where no single unit is meant. */
export function categoryIcon(categoryId) {
  const picture = UNIT_PICTURES[categoryId];
  const cat = getCategory(categoryId);
  return picture ? solid(picture, cat?.name ?? categoryId) : escapeText(cat?.icon ?? '?');
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
