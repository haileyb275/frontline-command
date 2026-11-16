// The side panel. This file is the "controller": it remembers which tab and
// view are showing, re-draws when anything changes, and passes clicks on to
// the tab that owns them. The tabs themselves live in basesTab.js etc.

import { state, subscribe } from '../state.js';
import { getBuilding } from '../game/content.js';
import * as basesTab from './basesTab.js';
import * as unitsTab from './unitsTab.js';
import * as missionsTab from './missionsTab.js';

function placeholder(heading, text, badge) {
  return `
    <div class="card card--empty">
      <h2>${heading}</h2>
      <p>${text}</p>
      <span class="badge">${badge}</span>
    </div>`;
}

const TABS = {
  missions: missionsTab,
  units: unitsTab,
  bases: basesTab,
  alliance: {
    render: () =>
      placeholder(
        'Not in an alliance',
        'Team up with players of any nation: shared missions, alliance chat and a common treasury.',
        'Arrives in Phase 5'
      ),
  },
};

/**
 * @param {{ baseLayer: object, missionLayer: object, mapElement: HTMLElement }} deps
 *        the two map layers from map.js, and the map's <div>
 */
export function initPanel({ baseLayer, missionLayer, mapElement }) {
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
    missionId: null, // mission being viewed
    picked: [], // unit ids ticked in the mission's unit picker
    busy: false, // true while waiting for the server
  };

  // The values that mean "nothing selected", used when switching tabs.
  const CLEAR = { view: 'list', buildingType: null, latlng: null, baseId: null, missionId: null, picked: [] };

  /** Change the UI state and re-draw. */
  function update(patch) {
    Object.assign(ui, patch);
    draw();
  }

  // Passed to the tabs so they can read state and change the view.
  const ctx = { state, ui, update, baseLayer, missionLayer };

  function draw() {
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === ui.tab;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }

    // Re-drawing replaces the HTML, which would wipe a half-typed base name.
    // Remember it and put it back.
    const typed = body.querySelector('input[name="name"]')?.value;

    body.innerHTML = TABS[ui.tab].render(state, ui);

    const nameInput = body.querySelector('input[name="name"]');
    if (nameInput && typed) nameInput.value = typed;

    // Keep the map in step with the panel.
    const placing = ui.tab === 'bases' && (ui.view === 'placing' || ui.view === 'confirm');
    mapElement.classList.toggle('is-placing', placing);
    baseLayer.setGhost(
      placing ? ui.latlng : null,
      placing ? getBuilding(ui.buildingType)?.icon : ''
    );
    baseLayer.sync(state.bases, ui.tab === 'bases' && ui.view === 'base' ? ui.baseId : null);
    missionLayer.sync(state.missions, ui.tab === 'missions' && ui.view === 'mission' ? ui.missionId : null);

    // If the mission being viewed has finished, drop back to the list.
    if (ui.view === 'mission' && !state.missions.some((m) => m.id === ui.missionId)) {
      Object.assign(ui, CLEAR);
      body.innerHTML = TABS[ui.tab].render(state, ui);
    }
    TABS[ui.tab].tick?.(body, state);
  }

  function showTab(name) {
    if (!TABS[name]) return;
    // Switching tabs cancels any half-finished placement or unit selection.
    update({ tab: name, ...CLEAR });
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

    // A few actions switch tabs, so they are handled here…
    if (action === 'open-base') {
      return update({ tab: 'bases', ...CLEAR, view: 'base', baseId: el.dataset.base });
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
    TABS[ui.tab].handleSubmit?.(form.dataset.form, Object.fromEntries(new FormData(form)), ctx);
  });

  // Once a second, let the current tab refresh its countdowns. This only
  // changes a few text labels — a full re-draw every second would make
  // buttons flicker and miss clicks.
  setInterval(() => TABS[ui.tab].tick?.(body, state), 1000);

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
      return ui.tab === 'bases' && basesTab.handleMapClick(latlng, ctx);
    },
    /** Called on logout so the next player doesn't see the last one's view. */
    reset() {
      update({ tab: 'bases', ...CLEAR, busy: false });
    },
  };
}
