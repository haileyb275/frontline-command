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

export { nations, categories, buildings, units, missions, settings, allianceBuildings };

const index = (list) => new Map(list.map((item) => [item.id, item]));
const nationById = index(nations);
const categoryById = index(categories);
const buildingById = index(buildings);
const unitById = index(units);
const missionById = index(missions);

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
export function travelSeconds(unitType, base, mission, nationId, alliance = null) {
  const speed =
    unitType.speed_kmh *
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
