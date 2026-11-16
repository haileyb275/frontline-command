// Everything the player can DO goes through this file. Each action asks a
// server function to make the change, then copies the server's answer into
// the local state so the screen updates.

import { supabase } from '../supabase.js';
import { state, setState } from '../state.js';

/** Load the player's bases and units after logging in. */
export async function loadGame() {
  // Row-level security already limits both queries to our own rows.
  const [bases, units] = await Promise.all([
    supabase.from('bases').select('*').order('created_at'),
    supabase.from('units').select('*').order('created_at'),
  ]);
  if (bases.error) throw bases.error;
  if (units.error) throw units.error;
  setState({ bases: bases.data, units: units.data });
}

/** Build a base. Throws an Error with a readable message if the server says no. */
export async function placeBase(buildingType, latlng, name) {
  const { data, error } = await supabase.rpc('place_base', {
    p_building_type: buildingType,
    p_lat: latlng.lat,
    p_lng: latlng.lng,
    p_name: name,
  });
  if (error) throw error;
  // The function returns our updated profile (less money) and the new base.
  setState({ profile: data.profile, bases: [...state.bases, data.base] });
  return data.base;
}

/** Recruit one unit at a base. */
export async function buyUnit(baseId, unitType) {
  const { data, error } = await supabase.rpc('buy_unit', {
    p_base_id: baseId,
    p_unit_type: unitType,
  });
  if (error) throw error;
  setState({ profile: data.profile, units: [...state.units, data.unit] });
  return data.unit;
}
