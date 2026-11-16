// Road routes for ground units.
//
// We ask a free public routing service (OSRM, built on OpenStreetMap data)
// for the road route between a base and a mission, then draw the unit moving
// along it. This is DRAWING ONLY: how long the trip takes is still decided by
// the server. If the service is slow, down, or finds no road, the unit simply
// moves in a straight line as before.

import { ROUTING_URL } from '../config.js';
import { distanceKm } from './content.js';

const cache = new Map(); // "lat,lng>lat,lng" → route object, or null while loading / if it failed
const queue = []; // requests waiting their turn
let working = false;

const key = (from, to) =>
  [from.lat, from.lng].map((n) => n.toFixed(4)).join(',') + '>' +
  [to.lat, to.lng].map((n) => n.toFixed(4)).join(',');

/**
 * Get the road route between two { lat, lng } points.
 * Returns it if we already have it; otherwise returns null and starts
 * fetching, so asking again a moment later will succeed.
 */
export function getRoute(from, to) {
  const k = key(from, to);
  if (cache.has(k)) return cache.get(k);
  cache.set(k, null);
  queue.push({ k, from, to });
  work();
  return null;
}

// One request at a time with a short pause between them: the public server
// is shared by everyone, so we must be polite to it.
async function work() {
  if (working) return;
  working = true;
  while (queue.length > 0) {
    const { k, from, to } = queue.shift();
    try {
      const url = `${ROUTING_URL}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const response = await fetch(url);
      const data = await response.json();
      const coords = data.routes?.[0]?.geometry?.coordinates;
      if (data.code === 'Ok' && coords?.length > 1) {
        // The service gives [lng, lat]; Leaflet wants [lat, lng]. We add the
        // exact base and mission positions at the ends, because the nearest
        // road may stop a little short of either.
        cache.set(k, buildRoute([[from.lat, from.lng], ...coords.map(([lng, lat]) => [lat, lng]), [to.lat, to.lng]]));
      }
    } catch {
      // Leave it as null → straight line.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  working = false;
}

/** Pre-compute how far along the route each point is, so lookups are quick. */
function buildRoute(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        distanceKm({ lat: points[i - 1][0], lng: points[i - 1][1] }, { lat: points[i][0], lng: points[i][1] })
    );
  }
  return { points, cumulative, total: cumulative[cumulative.length - 1] };
}

/** The [lat, lng] that is `progress` (0…1) of the way along a route. */
export function pointAlong(route, progress) {
  const target = Math.min(1, Math.max(0, progress)) * route.total;
  const { points, cumulative } = route;

  // Binary search for the segment containing `target`.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = cumulative[hi] - cumulative[lo];
  const f = span > 0 ? (target - cumulative[lo]) / span : 0;
  return [
    points[lo][0] + (points[hi][0] - points[lo][0]) * f,
    points[lo][1] + (points[hi][1] - points[lo][1]) * f,
  ];
}
