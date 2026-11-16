// Entry point: the first JavaScript that runs. Its only job is to start the
// other modules and connect them to each other.

import './style.css';
import { createMap, formatLatLng } from './map.js';
import { supabase, friendlyError } from './supabase.js';
import { state, setState, loadProfile } from './state.js';
import { initPanel } from './ui/panel.js';
import { initTopbar } from './ui/topbar.js';
import { showAuthScreen } from './ui/auth.js';
import { showNationPicker } from './ui/nationPicker.js';
import { esc, showOverlay, hideOverlay } from './ui/dom.js';

// ---------- The map and panel are always there, behind any overlay ----------

const coordsEl = document.getElementById('coords');

const map = createMap(document.getElementById('map'), {
  // Clicking reports the position. In Phase 3 this same click becomes
  // "place a base here".
  onClick: (latlng) => {
    coordsEl.textContent = formatLatLng(latlng);
  },
});

initPanel();
initTopbar();

// ---------- Deciding which screen to show ----------
//
//   not logged in            → log in / sign up
//   logged in, no nation yet → nation picker
//   logged in, has nation    → the game

async function route() {
  if (!state.session) {
    setState({ profile: null });
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
      showNationPicker();
    } else {
      hideOverlay();
    }
  } catch (error) {
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
supabase.auth.onAuthStateChange((_event, session) => {
  const userId = session?.user?.id ?? null;
  state.session = session;

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
