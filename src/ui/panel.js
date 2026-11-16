// The side panel: four tabs (Missions / Units / Bases / Alliance).
// In Phase 1 each tab just shows a short "what goes here" card. Later phases
// replace the `render` functions below with real content.

const TABS = {
  missions: {
    title: 'Missions',
    render: () =>
      placeholder(
        'No active missions',
        'Missions will appear on the map near your bases. Select one here to see which unit types it needs, then dispatch.',
        'Arrives in Phase 4'
      ),
  },
  units: {
    title: 'Units',
    render: () =>
      placeholder(
        'No units yet',
        'Your infantry, armor, artillery and support units will be listed here with their current status.',
        'Arrives in Phase 3'
      ),
  },
  bases: {
    title: 'Bases',
    render: () =>
      placeholder(
        'No bases yet',
        'Place a headquarters on the map, then expand with tank depots, airfields, field hospitals and more.',
        'Arrives in Phase 3'
      ),
  },
  alliance: {
    title: 'Alliance',
    render: () =>
      placeholder(
        'Not in an alliance',
        'Team up with players of any nation: shared missions, alliance chat and a common treasury.',
        'Arrives in Phase 5'
      ),
  },
};

function placeholder(heading, text, badge) {
  return `
    <div class="card card--empty">
      <h2>${heading}</h2>
      <p>${text}</p>
      <span class="badge">${badge}</span>
    </div>`;
}

/**
 * Wire up the tab buttons and the mobile open/close toggle.
 * @returns {{ showTab: (name: string) => void }}
 */
export function initPanel() {
  const panel = document.getElementById('panel');
  const body = document.getElementById('panel-body');
  const toggle = document.getElementById('panel-toggle');
  const tabButtons = [...document.querySelectorAll('.tab')];

  function showTab(name) {
    const tab = TABS[name];
    if (!tab) return;
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    body.innerHTML = tab.render();
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }

  // The ☰ button collapses the panel so the map can use the whole screen.
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  showTab('missions');
  return { showTab };
}
