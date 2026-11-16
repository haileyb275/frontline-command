// Entry point: the first JavaScript that runs. Its only job is to start the
// other modules and connect them to each other.

import './style.css';
import { createMap, createBaseLayer, createMissionLayer, createTravelLayer, formatLatLng } from './map.js';
import { supabase, friendlyError } from './supabase.js';
import { state, setState, subscribe, loadProfile } from './state.js';
import { loadGame, startSyncLoop, stopSyncLoop, stopRealtime } from './game/actions.js';
import {
  getBuilding, getCategory, getMissionType, getSlot, getUnitType, convoySeconds, distanceKm,
} from './game/content.js';
import { dispatchPosition } from './game/clock.js';
import { getRoute, pointAlong } from './game/routes.js';
import { conditionsText } from './game/weather.js';
import { now } from './game/clock.js';
import { initTutorial } from './ui/tutorial.js';
import { missionMarkerLabel } from './ui/missionsTab.js';
import { initPanel } from './ui/panel.js';
import { initTopbar } from './ui/topbar.js';
import { showAuthScreen } from './ui/auth.js';
import { showNationPicker } from './ui/nationPicker.js';
import { showHelpFirstTime } from './ui/help.js';
import { showNewPasswordScreen } from './ui/auth.js';
import { esc, showOverlay, hideOverlay } from './ui/dom.js';

// ---------- The map and panel are always there, behind any overlay ----------

const coordsEl = document.getElementById('coords');
const mapEl = document.getElementById('map');

const map = createMap(mapEl, {
  onClick: (latlng) => {
    // If the panel is waiting for a building site it takes the click;
    // otherwise we just show the position.
    panel.handleMapClick(latlng);
    coordsEl.textContent = formatLatLng(latlng);
  },
  onHome: frameEverything,
});

/** Move the map so all our bases and missions are in view. */
function frameEverything() {
  const points = [...state.bases, ...state.missions].map((x) => [x.lat, x.lng]);
  if (points.length > 0) map.fitBounds(points, { padding: [60, 60], maxZoom: 11 });
}

const baseLayer = createBaseLayer(map, {
  getIcon: (base) => getBuilding(base.building_type)?.icon ?? '?',
  onSelect: (base) => panel.selectBase(base),
});

const missionLayer = createMissionLayer(map, {
  getLabel: missionMarkerLabel,
  getKind: (mission) => getMissionType(mission.mission_type)?.terrain ?? 'land',
  getTitle: (mission) =>
    (getMissionType(mission.mission_type)?.name ?? 'Mission') + (mission.site_name ? ` · ${mission.site_name}` : ''),
  onSelect: (mission) => panel.selectMission(mission),
});

// A finished mission disappears from state.missions, but its units still
// have to drive home from it — so remember where every mission was.
const missionTargets = new Map();
subscribe((s) => {
  for (const m of s.missions) missionTargets.set(m.id, { lat: m.lat, lng: m.lng });
});

// Moving unit markers. The layer asks us for the current dispatches several
// times a second and works out where each unit should be drawn.
createTravelLayer(map, {
  getDispatches: () => state.dispatches,
  getTarget: (d) => state.missions.find((m) => m.id === d.mission_id) ?? missionTargets.get(d.mission_id) ?? null,
  getLabel: (d) => getSlot(d.category_id).icon,
  // Allied units on shared missions are drawn in a different colour.
  getKind: (d) => (d.player_id === state.profile?.id ? 'unit' : 'unit ally'),
  getPosition: dispatchPosition,
  // Only ground units use roads; aircraft and ships travel in straight lines.
  getRoute: (d, target) =>
    // …and only for trips within one region. A unit sent from a base an
    // ocean away has no sensible road route, so it is drawn as a straight line.
    getCategory(d.unit_category ?? d.category_id)?.domain === 'ground' &&
    distanceKm({ lat: d.from_lat, lng: d.from_lng }, target) <= 400
      ? getRoute({ lat: d.from_lat, lng: d.from_lng }, target)
      : null,
  pointAlong,
});

// Convoys and transferring units use the same moving-marker layer. We
// describe each one in the shape the layer expects (start point, arrival
// time, journey length) and it does the rest.
createTravelLayer(map, {
  getDispatches: () => [
    ...state.shipments.map((s) => ({
      id: `ship-${s.id}`,
      from_lat: s.from_lat,
      from_lng: s.from_lng,
      to: { lat: s.to_lat, lng: s.to_lng },
      arrives_at: s.arrives_at,
      travel_seconds: (new Date(s.arrives_at) - new Date(s.departed_at)) / 1000,
      label: s.by_sea ? '⚓' : s.kind === 'resupply' ? 'SUP' : 'CGO',
    })),
    ...state.units
      .filter((u) => u.status === 'transferring' && u.busy_until)
      .map((u) => {
        const from = state.bases.find((b) => b.id === u.base_id);
        const to = state.bases.find((b) => b.id === u.transfer_base_id);
        if (!from || !to) return null;
        return {
          id: `move-${u.id}`,
          from_lat: from.lat,
          from_lng: from.lng,
          to: { lat: to.lat, lng: to.lng },
          arrives_at: u.busy_until,
          travel_seconds: convoySeconds(from, to),
          label: getCategory(getUnitType(u.unit_type)?.category_id)?.icon ?? '',
        };
      })
      .filter(Boolean),
  ],
  getTarget: (d) => d.to,
  getLabel: (d) => d.label,
  getKind: () => 'unit convoy',
  getPosition: dispatchPosition,
});

// Another player's bases, shown while their profile (or the admin view of
// their account) is open. Same layer type as our own bases, different style.
const visitorLayer = createBaseLayer(map, {
  getIcon: (base) => getBuilding(base.building_type)?.icon ?? '?',
  getKind: () => 'base foreign',
  onSelect: () => {},
});
subscribe((s) => visitorLayer.sync(s.overlayBases));

const panel = initPanel({
  baseLayer,
  missionLayer,
  mapElement: mapEl,
  flyTo: (point) => map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), 10), { duration: 0.6 }),
  fitTo: (points) => points.length && map.fitBounds(points.map((x) => [x.lat, x.lng]), { padding: [60, 60], maxZoom: 11 }),
});

// The weather where the map is looking, refreshed as it moves and once a minute.
const weatherEl = document.getElementById('weather');
function showWeather() {
  const c = map.getCenter();
  weatherEl.textContent = conditionsText(c.lat, c.lng, now());
}
map.on('moveend', showWeather);
setInterval(showWeather, 60000);
showWeather();

initTutorial();

// Top bar: our own name opens our profile; "Admin" opens the admin panel.
document.getElementById('player-name').addEventListener('click', () => state.profile && panel.openProfile(state.profile.username));
document.getElementById('admin-link').addEventListener('click', () => panel.showTab('admin'));
subscribe((s) => { document.getElementById('admin-link').hidden = !s.profile?.is_admin; });

// A suspended account is told why and can do nothing but log out.
function showSuspended(message) {
  stopSyncLoop();
  const reason = String(message).split('ACCOUNT_SUSPENDED:')[1]?.trim() || 'No reason was given.';
  showOverlay(`
    <div class="dialog">
      <div class="dialog-head">
        <h1>Account suspended</h1>
        <p>${esc(reason)}</p>
      </div>
      <button class="btn btn--primary" id="suspended-logout">Log out</button>
    </div>`);
  document.getElementById('suspended-logout').addEventListener('click', () => supabase.auth.signOut());
}
window.addEventListener('fc-suspended', (event) => showSuspended(event.detail));
initTopbar();

// ---------- Deciding which screen to show ----------
//
//   not logged in            → log in / sign up
//   logged in, no nation yet → nation picker
//   logged in, has nation    → the game

async function route() {
  if (!state.session) {
    stopSyncLoop();
    stopRealtime();
    setState({ profile: null, bases: [], units: [], missions: [], dispatches: [], shipments: [], alliance: null, alliances: [], unread: 0,
      viewedProfile: null, overlayBases: [], admin: { players: null, player: null, overview: null } });
    panel.reset();
    showAuthScreen();
    return;
  }

  try {
    const profile = await loadProfile();

    if (!profile) {
      // Should not happen (a database trigger creates the profile), but if
      // the SQL hasn't been run yet this is what we'd see.
      throw new Error('No profile found for this account. Has supabase/migrations/001_profiles.sql been run?');
    }

    if (!profile.nation_id) {
      showNationPicker(); // bases and units are empty for a brand-new player
      startSyncLoop(); // harmless until they have a base; then it brings missions
    } else {
      await loadGame(); // also settles anything that happened while we were offline
      startSyncLoop();
      hideOverlay();
      panel.showTab(state.bases.length > 0 ? 'missions' : 'bases');
      frameEverything(); // returning players: start with everything in view
      showHelpFirstTime();
    }
  } catch (error) {
    if (String(error?.message).includes('ACCOUNT_SUSPENDED')) return showSuspended(error.message);
    showOverlay(`
      <div class="dialog">
        <div class="dialog-head">
          <h1>Something went wrong</h1>
          <p>${esc(friendlyError(error))}</p>
        </div>
        <button class="btn btn--primary" id="retry">Try again</button>
        <button class="btn" id="signout">Log out</button>
      </div>
    `);
    document.getElementById('retry').addEventListener('click', route);
    document.getElementById('signout').addEventListener('click', () => supabase.auth.signOut());
  }
}

// Supabase calls this once at startup (with the saved session, if any) and
// again on every login / logout — so this one listener drives the whole flow.
let lastUserId; // undefined = "we haven't heard from Supabase yet"
supabase.auth.onAuthStateChange((event, session) => {
  const userId = session?.user?.id ?? null;
  state.session = session;

  // The player arrived through a "reset your password" email link: they are
  // logged in, but must choose a new password before anything else.
  if (event === 'PASSWORD_RECOVERY') {
    lastUserId = userId;
    setTimeout(() => showNewPasswordScreen(route), 0);
    return;
  }

  // Token refreshes fire this too; only re-route when the USER changes.
  if (userId === lastUserId) return;
  lastUserId = userId;

  // Supabase asks us not to call it again from inside this callback, so
  // we step outside with setTimeout before doing any database work.
  setTimeout(route, 0);
});

// Handy while developing: type `fc` in the browser console to inspect things.
// Vite strips this branch out of the production build.
if (import.meta.env.DEV) {
  window.fc = { map, state, supabase };
}
