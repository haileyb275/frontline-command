// The side panel. This file is the "controller": it remembers which tab and
// view are showing, re-draws when anything changes, and passes clicks on to
// the tab that owns them. The tabs themselves live in basesTab.js etc.

import { state, subscribe } from '../state.js';
import { getBuilding } from '../game/content.js';
import * as basesTab from './basesTab.js';
import * as unitsTab from './unitsTab.js';
import * as missionsTab from './missionsTab.js';
import * as allianceTab from './allianceTab.js';
import * as ranksTab from './ranksTab.js';
import * as adminTab from './adminTab.js';
import { openProfile, closeProfile } from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { toast } from './toast.js';
import { buildingIcon } from './icons.js';

const TABS = {
  missions: missionsTab,
  units: unitsTab,
  bases: basesTab,
  alliance: allianceTab,
  ranks: ranksTab,
  admin: adminTab, // has no tab button: opened from the top bar, admins only
};

/**
 * @param {{ baseLayer: object, missionLayer: object, mapElement: HTMLElement }} deps
 *        the two map layers from map.js, and the map's <div>
 */
export function initPanel({ baseLayer, missionLayer, mapElement, flyTo, fitTo }) {
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  const toggle = document.getElementById('panel-toggle');
  const tabButtons = [...document.querySelectorAll('.tab')];

  // What the panel is currently showing. This is "UI state": it is not saved
  // anywhere and resets when the page reloads.
  const ui = {
    tab: 'bases',
    view: 'list', // which view inside the current tab — see basesTab.js / missionsTab.js
    buildingType: null, // building being placed
    latlng: null, // chosen site
    baseId: null, // base being viewed
    unitId: null, // unit being viewed
    missionId: null, // mission being viewed
    picked: [], // unit ids ticked in the mission's unit picker
    allianceView: 'overview', // which part of the Alliance tab is showing
    missionsView: 'list', // 'list' or 'orders' in the Missions tab
    ranksView: 'players', // 'players', 'alliances' or 'profile' in the Ranks tab
    adminView: 'home', // 'home' or 'player' in the admin panel
    adminMoveBase: null, // base the admin is about to re-site with a map click
    busy: false, // true while waiting for the server
  };

  // The values that mean "nothing selected", used when switching tabs.
  const CLEAR = { view: 'list', buildingType: null, latlng: null, baseId: null, unitId: null, missionId: null, picked: [] };

  /** Change the UI state and re-draw. */
  function update(patch) {
    Object.assign(ui, patch);
    draw();
  }

  // Passed to the tabs so they can read state and change the view.
  const ctx = { state, ui, update, baseLayer, missionLayer, flyTo, fitTo };

  function draw() {
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === ui.tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }

    // Re-drawing replaces the HTML, which would wipe anything half-typed
    // (a base name, a chat message) and drop the cursor. Remember every
    // input's text, and which one had focus, then put them back.
    const typed = new Map(
      [...body.querySelectorAll('input[name]')].map((input) => [input.name, input.value])
    );
    const focused = body.contains(document.activeElement) ? document.activeElement.name : null;

    body.innerHTML = TABS[ui.tab].render(state, ui);

    for (const input of body.querySelectorAll('input[name]')) {
      if (typed.get(input.name)) input.value = typed.get(input.name);
      if (focused && input.name === focused) {
        input.focus();
        // Text boxes: put the cursor back at the end. (Number inputs don't allow this.)
        if (input.type === 'text') input.setSelectionRange(input.value.length, input.value.length);
      }
    }

    // A dot on the Alliance tab when chat messages are waiting.
    tabButtons.find((b) => b.dataset.tab === 'alliance')
      ?.classList.toggle('has-unread', state.unread > 0);

    // Keep the map in step with the panel.
    const placing = ui.tab === 'bases' && ['placing', 'confirm', 'moving'].includes(ui.view);
    mapElement.classList.toggle('is-placing', placing);
    baseLayer.setGhost(
      placing ? ui.latlng : null,
      placing ? buildingIcon(getBuilding(ui.view === 'moving'
        ? state.bases.find((b) => b.id === ui.baseId)?.building_type : ui.buildingType)) : ''
    );
    baseLayer.sync(state.bases, ui.tab === 'bases' && ['base', 'unit', 'moving'].includes(ui.view) ? ui.baseId : null);
    missionLayer.sync(state.missions, ui.tab === 'missions' && ui.view === 'mission' ? ui.missionId : null);

    // If the mission being viewed has finished, drop back to the list.
    if (ui.view === 'mission' && !state.missions.some((m) => m.id === ui.missionId)) {
      Object.assign(ui, CLEAR);
      body.innerHTML = TABS[ui.tab].render(state, ui);
    }
    TABS[ui.tab].tick?.(body, state);
    TABS[ui.tab].afterRender?.(body, state, ui);
  }

  function showTab(name) {
    if (!TABS[name]) return;
    // Switching tabs cancels any half-finished placement or unit selection,
    // and puts away another player's page.
    if (state.viewedProfile || state.overlayBases.length) closeProfile();
    update({ tab: name, ...CLEAR, adminMoveBase: null, ranksView: ui.ranksView === 'profile' ? 'players' : ui.ranksView });
    TABS[name].onShow?.(ctx); // e.g. the Ranks tab fetches fresh rankings
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }

  // "Event delegation": one listener on the panel handles every button inside
  // it, including ones that are created later by a re-draw.
  body.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const action = el.dataset.action;

    // Any button can ask "are you sure?" first by carrying a data-confirm text.
    if (el.dataset.confirm && !window.confirm(el.dataset.confirm)) return;

    // A few actions switch tabs, so they are handled here…
    if (action === 'open-base') {
      return update({ tab: 'bases', ...CLEAR, view: 'base', baseId: el.dataset.base });
    }
    if (action === 'open-unit') {
      const unit = state.units.find((u) => u.id === el.dataset.unit);
      return update({ tab: 'bases', ...CLEAR, view: 'unit', unitId: el.dataset.unit, baseId: unit?.base_id ?? null });
    }
    if (action === 'open-profile') {
      update({ tab: 'ranks', ...CLEAR, ranksView: 'profile' });
      return openProfile(el.dataset.username).catch((error) => {
        toast(friendlyError(error), 'error');
        update({ ranksView: 'players' });
      });
    }
    if (action === 'admin-open' && ui.tab !== 'admin') {
      update({ tab: 'admin', ...CLEAR }); // then fall through so the admin tab opens the player
    }
    if (action === 'open-mission') {
      return update({ tab: 'missions', ...CLEAR, view: 'mission', missionId: el.dataset.mission });
    }
    // …everything else belongs to the tab that is showing.
    TABS[ui.tab].handleAction?.(action, el.dataset, ctx);
  });

  body.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    // event.submitter is the button that was pressed; include its name and
    // value so a form with two buttons (Buy / Sell) can tell them apart.
    const values = Object.fromEntries(new FormData(form, event.submitter));
    TABS[ui.tab].handleSubmit?.(form.dataset.form, values, ctx, form);
  });

  // Drop-down menus (<select data-change="…">) report through "change".
  body.addEventListener('change', (event) => {
    const el = event.target.closest('[data-change]');
    if (el) TABS[ui.tab].handleChange?.(el.dataset.change, el, ctx);
  });

  // Once a second, let the current tab refresh its countdowns. This only
  // changes a few text labels — a full re-draw every second would make
  // buttons flicker and miss clicks.
  setInterval(() => TABS[ui.tab].tick?.(body, state), 1000);

  // On phones the panel is a bottom sheet; this button makes it taller or shorter.
  document.getElementById('panel-size').addEventListener('click', (event) => {
    const tall = panel.classList.toggle('is-tall');
    event.currentTarget.textContent = tall ? '▼' : '▲';
    event.currentTarget.setAttribute('aria-label', tall ? 'Make panel smaller' : 'Make panel larger');
  });

  // The ☰ button collapses the panel so the map can use the whole screen.
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  // Re-draw whenever the game state changes (money spent, unit bought, …).
  subscribe(draw);
  draw();

  return {
    showTab,
    /** A base marker was clicked on the map. */
    selectBase(base) {
      panel.classList.remove('is-collapsed');
      update({ tab: 'bases', ...CLEAR, view: 'base', baseId: base.id });
    },
    /** A mission marker was clicked on the map. */
    selectMission(mission) {
      panel.classList.remove('is-collapsed');
      update({ tab: 'missions', ...CLEAR, view: 'mission', missionId: mission.id });
    },
    /** The map was clicked. Returns true if the panel used the click. */
    handleMapClick(latlng) {
      return TABS[ui.tab].handleMapClick?.(latlng, ctx) ?? false;
    },
    /** Called on logout so the next player doesn't see the last one's view. */
    /** Open a player's public page (used by the top bar for our own). */
    openProfile(username) {
      panel.classList.remove('is-collapsed');
      update({ tab: 'ranks', ...CLEAR, ranksView: 'profile' });
      openProfile(username).catch((error) => toast(friendlyError(error), 'error'));
    },
    reset() {
      update({ tab: 'bases', ...CLEAR, busy: false });
    },
  };
}
