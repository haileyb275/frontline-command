// Central place for settings the whole app shares.
// Keeping "magic numbers" here means you never have to hunt through the
// game logic to tweak them.

export const MAP_CONFIG = {
  // Where the map opens the first time: central Europe.
  startCenter: [50.0, 10.0], // [latitude, longitude]
  startZoom: 5,
  minZoom: 3,
  maxZoom: 18,

  // OpenStreetMap's free tile server. No API key needed, but the
  // attribution below is REQUIRED by their licence — never remove it.
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
};

// localStorage keys (browser-only conveniences; real game data will live in
// Supabase from Phase 2 onward).
export const STORAGE_KEYS = {
  mapView: 'fc.mapView',
};

// ---------- Supabase ----------
// These two values are SAFE to publish: the "publishable" key only lets a
// browser do what the database's row-level security rules allow. The keys
// that must NEVER go in this file (or anywhere in the repo) are the
// "secret" / service_role key and the database password.
export const SUPABASE_URL = 'https://rluljthdnkejrsrtpavi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_snnW1wpe-b0WCtBblBD5Rg_gyXZA5mR';
