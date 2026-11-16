// Everything that touches Leaflet lives in this file. The rest of the game
// asks this module to do map things ("add a marker here") instead of calling
// Leaflet directly, which keeps the other files simple.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css'; // Leaflet's own CSS — the map breaks without it
import { MAP_CONFIG, STORAGE_KEYS } from './config.js';

/** Read the last map position the player looked at (or null). */
function loadSavedView() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.mapView));
    if (saved && Array.isArray(saved.center) && typeof saved.zoom === 'number') return saved;
  } catch {
    // localStorage can be unavailable (private mode) or hold bad data — ignore.
  }
  return null;
}

function saveView(map) {
  try {
    const c = map.getCenter();
    localStorage.setItem(
      STORAGE_KEYS.mapView,
      JSON.stringify({ center: [c.lat, c.lng], zoom: map.getZoom() })
    );
  } catch {
    // Not being able to remember the view is harmless.
  }
}

/**
 * Create the Leaflet map inside the given element.
 * @param {HTMLElement} element  the <div id="map">
 * @param {{ onClick?: (latlng: {lat:number,lng:number}) => void }} options
 * @returns {L.Map}
 */
export function createMap(element, { onClick } = {}) {
  const saved = loadSavedView();

  const map = L.map(element, {
    center: saved?.center ?? MAP_CONFIG.startCenter,
    zoom: saved?.zoom ?? MAP_CONFIG.startZoom,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    worldCopyJump: true, // keeps markers sane when you scroll past the date line
    zoomControl: false, // we add it ourselves below, in a better corner
  });

  // The "tile layer" is the actual map imagery: small square images that
  // Leaflet downloads and stitches together as you pan and zoom.
  L.tileLayer(MAP_CONFIG.tileUrl, {
    attribution: MAP_CONFIG.tileAttribution,
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: true, metric: true }).addTo(map);

  // Remember where the player was looking for next time.
  map.on('moveend', () => saveView(map));

  if (onClick) {
    map.on('click', (event) => onClick(event.latlng));
  }

  // If the map's box changes size (window resize, side panel opening on
  // mobile), Leaflet must be told or it leaves grey gaps.
  new ResizeObserver(() => map.invalidateSize()).observe(element);

  return map;
}

/**
 * Build a marker icon out of HTML/CSS instead of an image file.
 * We'll use this for bases, units and missions in later phases.
 * @param {string} symbol   a short label or emoji shown in the marker
 * @param {string} kind     CSS modifier: 'base' | 'mission' | 'unit'
 */
export function makeIcon(symbol, kind = 'base') {
  return L.divIcon({
    className: '', // stop Leaflet adding its default white box
    html: `<div class="marker marker--${kind}">${symbol}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16], // the centre of the icon sits on the coordinate
  });
}

/** Format a position like "50.1234° N, 10.5678° E". */
export function formatLatLng({ lat, lng }) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}
