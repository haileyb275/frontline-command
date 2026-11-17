// The "How to play" screen. Shown automatically the first time, and from the
// "?" button in the top bar afterwards.

import { LANGUAGES, getLanguage, setLanguage } from '../i18n.js';
import { showOverlay, hideOverlay } from './dom.js';
import { getAlertPrefs, setAlertPref, requestNotifyPermission, playSound } from './alerts.js';

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
        <li><strong>Research.</strong> Every nation starts with its 1939 equipment. A Research
            Office opens later years one at a time, bringing heavier tanks, tank destroyers and bombers.</li>
        <li><strong>Orders are optional.</strong> The Orders view in the Missions tab offers three
            daily orders, campaigns and achievements. Ignoring them costs nothing; completing them
            pays extra funds, supplies and XP.</li>
        <li><strong>Join an alliance.</strong> Any nation can join any alliance. Share large
            missions, chat, and fund alliance buildings that help every member.</li>
        <li><strong>The front, offensives and scouting.</strong> The shaded area around a
            front-line base is the ground it holds. Win contact missions to push it out; ignore
            them and it falls back. Some reports arrive unconfirmed (marked ?) and need a recon unit
            or aircraft to look first. An enemy offensive (marked ⚠) against a base must be stopped
            in time, or the base is out of action for a while.</li>
        <li><strong>Stores, supply lines and the market.</strong> Fuel makes vehicles faster, spare
            parts halve repairs and medical stores halve recovery; a Refinery, Vehicle Works and
            Field Hospital make them. Lines on the map show each base's supply line from your
            Headquarters (red when it is running low). Rail Yards and Ports speed convoys. Buy and
            sell goods on the market from the Bases tab. Any base can be moved for a quarter of
            its cost.</li>
        <li><strong>Divisions, refits and captures.</strong> Form a division in the Units tab; with a
            command unit attached, its units fight harder together and the division gains its own
            experience. Open a unit to refit it with later equipment while keeping its experience.
            Hard-won contact occasionally yields a captured enemy vehicle.</li>
        <li><strong>Alliance life.</strong> Allies' bases and the ground they hold show in blue on
            your map. Every mission scores for your alliance in the weekly rivalry (Ranks → Alliances).
            Under Alliance → Members you can send supplies, fuel, parts or medical stores to an ally
            by convoy. Now and then a worldwide event sets one target for every player in the game.</li>
        <li><strong>Historical operations.</strong> Under Missions → Orders are named battles fought
            where they happened: a chain of missions, one after another, for a reward and a battle
            honour on your profile. You need the level and a base within 400 km.</li>
        <li><strong>Filters, standing orders and your record.</strong> Buttons above the mission list
            filter it. Standing orders, under the list, send the fastest units to easy reports by
            themselves while the game is open. Click your name to see your own statistics.</li>
        <li><strong>Weather and night.</strong> Rain and storms slow ground and sea units, storms
            ground aircraft, and scouts and commandos fight harder after dark. Conditions are shown
            on the map and on each mission.</li>
      </ol>

      <h2 class="help-sub">Settings</h2>
      <label class="check-line"><input type="checkbox" id="pref-sound" ${getAlertPrefs().sound ? 'checked' : ''} />
        Play a sound for new missions and completed missions</label>
      <label class="check-line"><input type="checkbox" id="pref-notify" ${getAlertPrefs().notify ? 'checked' : ''} />
        Show a notification when the game is in a background tab</label>

      <label class="check-line">Language
        <select id="pref-language">${Object.entries(LANGUAGES).map(([code, l]) =>
          `<option value="${code}" ${getLanguage() === code ? 'selected' : ''}>${l.name}</option>`).join('')}</select></label>
      <p class="muted">Translations cover labels, buttons and the names of missions, buildings, arms and ranks so far. Unit names, descriptions and longer texts remain in English.</p>

      <p class="muted">Everything keeps running while you are away: missions finish and units
         return on time, and you collect the results when you next log in.</p>
      <button class="btn btn--primary" id="help-close">Understood</button>
    </div>
  `);
  overlay.querySelector('#pref-sound').addEventListener('change', (event) => {
    setAlertPref('sound', event.target.checked);
    if (event.target.checked) playSound('complete'); // let them hear what they switched on
  });
  overlay.querySelector('#pref-notify').addEventListener('change', async (event) => {
    // The browser asks the player for permission the first time.
    const allowed = event.target.checked ? await requestNotifyPermission() : false;
    setAlertPref('notify', allowed);
    event.target.checked = allowed;
  });

  overlay.querySelector('#pref-language').addEventListener('change', (event) => setLanguage(event.target.value));

  overlay.querySelector('#help-close').addEventListener('click', () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode: fine */ }
    hideOverlay();
  });
}

/**
 * New players are now walked through by the tutorial card instead (see
 * tutorial.js), so the full help no longer opens by itself. It stays one
 * click away under "Help" in the top bar.
 */
export function showHelpFirstTime() {}
