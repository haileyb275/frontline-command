// The "How to play" screen. Shown automatically the first time, and from the
// "?" button in the top bar afterwards.

import { showOverlay, hideOverlay } from './dom.js';

const SEEN_KEY = 'fc.helpSeen';

export function showHelp() {
  const overlay = showOverlay(`
    <div class="dialog dialog--help">
      <div class="dialog-head">
        <span class="brand-star" aria-hidden="true">★</span>
        <h1>How to play</h1>
      </div>
      <ol class="help-steps">
        <li><strong>Build your Headquarters.</strong> Open the Bases tab, choose a site on land,
            and confirm. Missions will start appearing around it.</li>
        <li><strong>Recruit units.</strong> Open a base to recruit. Each building houses certain
            categories: infantry, recon and command staff at the HQ, tanks at a Tank Depot, ships at a Naval Base.</li>
        <li><strong>Answer missions.</strong> Red markers are on land, blue are at sea, purple are
            for aircraft. Open one, press <em>Select fastest</em>, then <em>Dispatch</em>.</li>
        <li><strong>Collect and grow.</strong> When the timer ends you earn funds, supplies and XP.
            Higher levels unlock new buildings, units and larger operations.</li>
        <li><strong>Front line and home front.</strong> Each base is one or the other. Enemy
            contact only happens around front-line bases. Put factories and Training Centers on
            the home front, then ship their output and trained units forward by convoy.</li>
        <li><strong>Keep units supplied and rested.</strong> Each base holds its own stock of
            supplies, used up as units go out and topped up by convoy from your Headquarters.
            Units gain experience, and sometimes come back needing repair before they can go again.</li>
        <li><strong>Join an alliance.</strong> Any nation can join any alliance. Share large
            missions, chat, and fund alliance buildings that help every member.</li>
      </ol>
      <p class="muted">Everything keeps running while you are away: missions finish and units
         return on time, and you collect the results when you next log in.</p>
      <button class="btn btn--primary" id="help-close">Understood</button>
    </div>
  `);
  overlay.querySelector('#help-close').addEventListener('click', () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: fine */ }
    hideOverlay();
  });
}

/** Show the help once per browser. */
export function showHelpFirstTime() {
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* ignore */ }
  if (!seen) showHelp();
}
