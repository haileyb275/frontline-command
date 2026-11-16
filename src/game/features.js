// The map survey: finding real bridges, airfields, stations, towns and
// harbours around each base, so that missions tied to such places can appear
// AT one ("Bridge Repair — Pont de Bénouville").
//
// The data comes from OpenStreetMap through the free Overpass service. It is
// fetched by the browser, once per base, and filed with the server. If the
// service is busy or unreachable nothing breaks: those missions simply keep
// appearing at ordinary spots, and we try again on the next visit.

import { OVERPASS_URL } from '../config.js';
import { supabase } from '../supabase.js';
import { state } from '../state.js';

const RADIUS_M = 45000;
const RESURVEY_DAYS = 30;

/** The Overpass query for one base: five kinds of place, a capped number of each. */
function buildQuery({ lat, lng }) {
  const around = `(around:${RADIUS_M},${lat},${lng})`;
  return `[out:json][timeout:25];
    way[bridge=yes][highway~"^(motorway|trunk|primary|secondary)$"]${around}; out center 60;
    nwr[aeroway=aerodrome]${around}; out center 15;
    node[railway=station]${around}; out 30;
    node[place~"^(city|town)$"]${around}; out 40;
    (nwr[harbour=yes]${around}; nwr[landuse=port]${around};); out center 15;`;
}

function kindOf(tags = {}) {
  if (tags.bridge) return 'bridge';
  if (tags.aeroway) return 'airfield';
  if (tags.railway) return 'rail';
  if (tags.place) return 'town';
  if (tags.harbour || tags.landuse === 'port') return 'harbour';
  return null;
}

/** Turn Overpass's answer into the simple list the server expects. */
export function parseFeatures(json) {
  const seen = new Set();
  const features = [];
  for (const el of json.elements ?? []) {
    const kind = kindOf(el.tags);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!kind || lat == null || lng == null) continue;
    // A long bridge is often mapped as several pieces: keep one per ~200 m.
    const key = `${kind}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    features.push({ kind, name: el.tags.name ?? el.tags.ref ?? '', lat, lng });
  }
  return features;
}

async function surveyBase(base) {
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(buildQuery(base)),
  });
  if (!response.ok) throw new Error(`survey failed (${response.status})`);
  const features = parseFeatures(await response.json());
  const { error } = await supabase.rpc('submit_map_features', { p_base_id: base.id, p_features: features });
  if (error) throw error;
  base.scanned_at = new Date().toISOString(); // so we don't ask again this session
}

let running = false;

/**
 * Survey every base that has not been surveyed (or not for a month), one at
 * a time with a pause between — the service is shared and free, so we must
 * be gentle with it. Safe to call often; it does nothing if already running.
 */
export async function surveyBases() {
  if (running) return;
  running = true;
  try {
    const stale = Date.now() - RESURVEY_DAYS * 86400000;
    for (const base of state.bases) {
      if (base.scanned_at && new Date(base.scanned_at).getTime() > stale) continue;
      try {
        await surveyBase(base);
      } catch {
        break; // service unavailable: stop for now and try again next visit
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  } finally {
    running = false;
  }
}
