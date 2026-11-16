// Read-only game content, loaded from the JSON files in src/data/.
//
// The browser uses these to DISPLAY names, prices and requirements. The server
// has its own copy (loaded by supabase/seed.sql) and that is the one that
// counts: if you changed a price in here only, the button would show the new
// number but the server would still charge the real one.

import nations from '../data/nations.json';
import categories from '../data/categories.json';
import buildings from '../data/buildings.json';
import units from '../data/units.json';
import missions from '../data/missions.json';
import settings from '../data/settings.json';
import allianceBuildings from '../data/alliance_buildings.json';
import specialties from '../data/specialties.json';
import products from '../data/products.json';

export { nations, categories, buildings, units, missions, settings, allianceBuildings, specialties, products };

const index = (list) => new Map(list.map((item) => [item.id, item]));
const nationById = index(nations);
const categoryById = index(categories);
const buildingById = index(buildings);
const unitById = index(units);
const missionById = index(missions);
const specialtyById = index(specialties);
const productById = index(products);

export const getNation = (id) => nationById.get(id) ?? null;
export const getCategory = (id) => categoryById.get(id) ?? null;
export const getBuilding = (id) => buildingById.get(id) ?? null;
export const getUnitType = (id) => unitById.get(id) ?? null;
export const getMissionType = (id) => missionById.get(id) ?? null;

/**
 * A nation's multiplier for one kind of bonus (1 = no bonus).
 * Mirrors the SQL function fc_nation_bonus().
 */
export function nationBonus(nationId, type, category = null) {
  const nation = getNation(nationId);
  if (!nation) return 1;
  return nation.bonuses
    .filter((b) => b.type === type && (b.category == null || b.category === category))
    .reduce((mult, b) => mult * b.value, 1);
}

/** What a building costs this nation: { money, supplies }. */
export function buildingPrice(building, nationId) {
  const mult = nationBonus(nationId, 'building_cost_mult');
  return {
    money: Math.round(building.cost_money * mult),
    supplies: Math.round(building.cost_supplies * mult),
  };
}

/** What a unit costs this nation: { money, supplies }. */
export function unitPrice(unitType, nationId) {
  const mult = nationBonus(nationId, 'cost_mult', unitType.category_id);
  return {
    money: Math.round(unitType.cost_money * mult),
    supplies: Math.round(unitType.cost_supplies * mult),
  };
}

export function canAfford(profile, price) {
  return profile.money >= price.money && profile.supplies >= price.supplies;
}

/** The units of `nationId` that can be recruited at a building of this type. */
export function recruitableUnits(buildingTypeId, nationId) {
  const building = getBuilding(buildingTypeId);
  if (!building) return [];
  return units.filter(
    (u) => u.nation_id === nationId && building.unlocks_categories.includes(u.category_id)
  );
}

/** Distance between two { lat, lng } points in km. Mirrors fc_distance_km(). */
export function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How long a unit would take to drive from its base to a mission, in seconds.
 * This is only an ESTIMATE for the unit picker — the server works out the
 * real figure itself when you dispatch (see dispatch_units in the SQL).
 */
export function travelSeconds(unitType, base, mission, nationId, alliance = null, specialtyId = null) {
  const speed =
    unitType.speed_kmh *
    (getSpecialty(specialtyId)?.speed_mult ?? 1) *
    nationBonus(nationId, 'speed_mult', unitType.category_id) *
    (1 + allianceBonus(alliance, 'speed'));
  const seconds = (distanceKm(base, mission) / speed) * 3600 / settings.travel_time_scale;
  return Math.max(settings.min_travel_seconds, Math.round(seconds));
}

/** What a mission pays this nation: { money, supplies, xp }. */
export function missionReward(missionType, nationId) {
  return {
    money: Math.round(missionType.reward_money * nationBonus(nationId, 'reward_mult', 'money')),
    supplies: Math.round(missionType.reward_supplies * nationBonus(nationId, 'reward_mult', 'supplies')),
    xp: missionType.reward_xp,
  };
}

/** XP needed to reach a level. Mirrors fc_level_for_xp(). */
export const xpForLevel = (level) => 100 * (level - 1) ** 2;

/**
 * Total bonus of one type from an alliance's buildings (0 = none).
 * `alliance` is state.alliance; mirrors the SQL function fc_alliance_bonus().
 */
export function allianceBonus(alliance, type) {
  if (!alliance) return 0;
  return allianceBuildings
    .filter((b) => b.bonus.type === type)
    .reduce((total, b) => total + (alliance.buildings[b.id] ?? 0) * b.bonus.value, 0);
}

// ------------------------------------------------------------ phase 7

export const getSpecialty = (id) => specialtyById.get(id) ?? null;
export const getProduct = (id) => productById.get(id) ?? null;

/** A specialty's name for a nation: "Fallschirmjäger" for Germany, "Airborne" if none is listed. */
export function specialtyName(specialty, nationId) {
  if (!specialty) return '';
  return specialty.names?.[nationId] ?? specialty.name;
}

/** The specialties a unit of this category can train in. */
export const specialtiesFor = (categoryId) => specialties.filter((s) => s.category_ids.includes(categoryId));

/** What a building of this type can produce. */
export const productsFor = (buildingTypeId) => products.filter((p) => p.building_type === buildingTypeId);

/**
 * A mission requirement key is either a category ("infantry") or a specialty
 * ("airborne"). This gives the label, icon and movement domain for either.
 */
export function getSlot(key) {
  const category = getCategory(key);
  if (category) return category;
  const specialty = getSpecialty(key);
  if (!specialty) return { id: key, name: key, icon: '?', domain: 'ground' };
  return { ...specialty, domain: getCategory(specialty.category_ids[0])?.domain ?? 'ground' };
}

/** Can this unit fill the mission place `key`? */
export function unitFitsSlot(unit, key) {
  return unit.specialty === key || getUnitType(unit.unit_type)?.category_id === key;
}

/** Convoy / transfer time between two { lat, lng } points, in seconds. Mirrors fc_convoy_seconds(). */
export function convoySeconds(from, to) {
  if (!from || !to) return settings.min_convoy_seconds;
  const seconds = (distanceKm(from, to) / settings.convoy_speed_kmh) * 3600 / settings.convoy_time_scale;
  return Math.max(settings.min_convoy_seconds, Math.round(seconds));
}
