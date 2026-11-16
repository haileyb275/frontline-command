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

export { nations, categories, buildings, units };

const index = (list) => new Map(list.map((item) => [item.id, item]));
const nationById = index(nations);
const categoryById = index(categories);
const buildingById = index(buildings);
const unitById = index(units);

export const getNation = (id) => nationById.get(id) ?? null;
export const getCategory = (id) => categoryById.get(id) ?? null;
export const getBuilding = (id) => buildingById.get(id) ?? null;
export const getUnitType = (id) => unitById.get(id) ?? null;

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
