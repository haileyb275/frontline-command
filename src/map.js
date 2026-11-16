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
 * @param {{ onClick?: (latlng: {lat:number,lng:number}) => void, onHome?: () => void }} options
 * @returns {L.Map}
 */
export function createMap(element, { onClick, onHome } = {}) {
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

  // A custom button above the zoom buttons: "show all my bases and missions".
  if (onHome) {
    const HomeControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar');
        const link = L.DomUtil.create('a', 'home-control', wrap);
        link.href = '#';
        link.title = 'Show my bases and missions';
        link.setAttribute('role', 'button');
        link.setAttribute('aria-label', link.title);
        link.textContent = '⌂';
        L.DomEvent.disableClickPropagation(wrap); // don't let the click reach the map
        L.DomEvent.on(link, 'click', (event) => {
          L.DomEvent.preventDefault(event);
          onHome();
        });
        return wrap;
      },
    });
    new HomeControl().addTo(map);
  }

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
 * @param {string} symbol   a short label shown in the marker (from our JSON, not player text)
 * @param {string} kind     CSS modifiers, e.g. 'base', 'base is-selected', 'ghost'
 */
export function makeIcon(symbol, kind = 'base') {
  const classes = kind
    .split(' ')
    .map((k) => (k.startsWith('is-') ? k : `marker--${k}`))
    .join(' ');
  return L.divIcon({
    className: '', // stop Leaflet adding its default white box
    html: `<div class="marker ${classes}">${symbol}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16], // the centre of the icon sits on the coordinate
  });
}

/**
 * Manages the base markers. Call `sync()` whenever the list of bases or the
 * selected base changes and it adds / removes / restyles markers to match.
 *
 * @param {L.Map} map
 * @param {{ getIcon: (base) => string, onSelect: (base) => void }} options
 */
export function createBaseLayer(map, { getIcon, getKind, onSelect }) {
  const group = L.layerGroup().addTo(map);
  const markers = new Map(); // base id → Leaflet marker
  let ghost = null; // the "you are about to build here" marker

  return {
    sync(bases, selectedId = null) {
      const wanted = new Set(bases.map((b) => b.id));

      // Remove markers for bases that no longer exist (e.g. after logging out).
      for (const [id, marker] of markers) {
        if (!wanted.has(id)) {
          marker.remove();
          markers.delete(id);
        }
      }

      for (const base of bases) {
        let kind = getKind?.(base) ?? (base.zone === 'home' ? 'base home' : 'base');
        if (base.id === selectedId) kind += ' is-selected';
        let marker = markers.get(base.id);
        if (!marker) {
          marker = L.marker([base.lat, base.lng]).addTo(group);
          marker.on('click', () => onSelect(base));
          markers.set(base.id, marker);
        }
        marker.setLatLng([base.lat, base.lng]); // a base can be re-sited by an administrator
        marker.setIcon(makeIcon(getIcon(base), kind));
        // bindTooltip with a text node: player-chosen names are never parsed as HTML.
        marker.unbindTooltip();
        marker.bindTooltip(document.createTextNode(base.name), { direction: 'top', offset: [0, -14] });
      }
    },

    /** Show (or with null, hide) the placement preview marker. */
    setGhost(latlng, symbol = '') {
      ghost?.remove();
      ghost = latlng
        ? L.marker(latlng, { icon: makeIcon(symbol, 'base ghost'), interactive: false }).addTo(map)
        : null;
    },

    focus(base) {
      map.flyTo([base.lat, base.lng], Math.max(map.getZoom(), 10), { duration: 0.6 });
    },
  };
}

/**
 * Manages the mission markers, the same way createBaseLayer manages bases.
 * @param {L.Map} map
 * @param {{ getLabel: (mission) => string, getTitle: (mission) => string, onSelect: (mission) => void }} options
 */
export function createMissionLayer(map, { getLabel, getKind, getTitle, onSelect }) {
  const group = L.layerGroup().addTo(map);
  const markers = new Map();

  return {
    sync(missions, selectedId = null) {
      const wanted = new Set(missions.map((m) => m.id));
      for (const [id, marker] of markers) {
        if (!wanted.has(id)) {
          marker.remove();
          markers.delete(id);
        }
      }
      for (const mission of missions) {
        let kind = mission.status === 'in_progress' ? 'mission active' : 'mission';
        if (getKind) kind += ` ${getKind(mission)}`; // e.g. 'water' for missions at sea
        if (mission.id === selectedId) kind += ' is-selected';
        let marker = markers.get(mission.id);
        if (!marker) {
          marker = L.marker([mission.lat, mission.lng], { zIndexOffset: 500 }).addTo(group);
          marker.on('click', () => onSelect(mission));
          marker.bindTooltip(getTitle(mission), { direction: 'top', offset: [0, -14] });
          markers.set(mission.id, marker);
        }
        // Only swap the icon when it actually changes — doing it every
        // sync would cancel a click that is half-way through.
        if (marker._fcKind !== kind) {
          marker.setIcon(makeIcon(getLabel(mission), kind));
          marker._fcKind = kind;
        }
      }
    },

    focus(mission) {
      map.flyTo([mission.lat, mission.lng], Math.max(map.getZoom(), 11), { duration: 0.6 });
    },
  };
}

/**
 * Draws units moving between their base and a mission.
 *
 * Nothing is "really" moving on the server: each dispatch has a departure and
 * an arrival time, and several times a second we work out how far along the
 * line the unit should be and put its marker there.
 *
 * @param {L.Map} map
 * @param {{ getDispatches: () => object[], getTarget: (dispatch) => {lat,lng}|null,
 *           getLabel: (dispatch) => string, getPosition: (dispatch) => {phase, progress} }} options
 */
export function createTravelLayer(map, { getDispatches, getTarget, getLabel, getKind, getPosition, getRoute, pointAlong }) {
  const group = L.layerGroup().addTo(map);
  const items = new Map(); // dispatch id → { marker, line }

  function frame() {
    const dispatches = getDispatches();
    const wanted = new Set(dispatches.map((d) => d.id));

    for (const [id, item] of items) {
      if (!wanted.has(id)) {
        item.marker.remove();
        item.line.remove();
        items.delete(id);
      }
    }

    for (const d of dispatches) {
      const target = getTarget(d);
      if (!target) continue;
      const { phase, progress } = getPosition(d);

      let item = items.get(d.id);
      if (!item) {
        item = {
          line: L.polyline([[d.from_lat, d.from_lng], [target.lat, target.lng]], {
            className: 'route-line',
            interactive: false,
          }).addTo(group),
          marker: L.marker([d.from_lat, d.from_lng], {
            icon: makeIcon(getLabel(d), getKind?.(d) ?? 'unit'),
            interactive: false,
            zIndexOffset: 1000,
          }).addTo(group),
        };
        items.set(d.id, item);
      }

      // Ground units follow the road route once it has loaded (getRoute
      // returns null until then, and always for aircraft and ships).
      const route = getRoute?.(d, target) ?? null;
      if (route && !item.onRoad) {
        item.line.setLatLngs(route.points); // redraw the dashed line along the road
        item.onRoad = true;
      }
      item.marker.setLatLng(
        route
          ? pointAlong(route, progress)
          : [
              // Straight-line interpolation between base and mission.
              d.from_lat + (target.lat - d.from_lat) * progress,
              d.from_lng + (target.lng - d.from_lng) * progress,
            ]
      );
      // While a unit is at the mission (or home) its own marker is hidden.
      const moving = phase === 'en_route' || phase === 'returning';
      item.marker.setOpacity(moving ? 1 : 0);
      item.line.setStyle({ opacity: phase === 'home' ? 0 : 0.7 });
    }
  }

  const timer = setInterval(frame, 250);
  frame();
  return { refresh: frame, stop: () => clearInterval(timer) };
}

/** Format a position like "50.1234° N, 10.5678° E". */
export function formatLatLng({ lat, lng }) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}
