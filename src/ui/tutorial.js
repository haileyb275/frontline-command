// The guided tutorial: a small card over the map that tells a new player
// what to do next, and points at the tab to use. It reads the game state to
// decide which step applies, so it moves on by itself as the player acts,
// and it never appears again once finished or skipped.

import { state, subscribe } from '../state.js';

const KEY = 'fc.tutorialDone';

// Each step: when it applies, what to say, and which tab to point at.
const STEPS = [
  {
    when: (s) => s.bases.length === 0,
    tab: 'bases',
    title: 'Step 1 of 4 · Build your Headquarters',
    text: 'Open the <strong>Bases</strong> tab and press <em>Choose a site</em>. Click somewhere on land, then confirm.',
  },
  {
    when: (s) => s.units.length < 2,
    tab: 'bases',
    title: 'Step 2 of 4 · Recruit two units',
    text: 'In <strong>Bases</strong>, open your Headquarters and recruit an infantry squad and a recon unit.',
  },
  {
    when: (s) => s.profile.missions_completed === 0 && s.dispatches.length === 0,
    tab: 'missions',
    title: 'Step 3 of 4 · Answer a mission',
    text: 'Open <strong>Missions</strong> and pick one. Press <em>Select fastest</em>, then <em>Dispatch</em>. If none fits your units yet, a new report arrives every couple of minutes.',
  },
  {
    when: (s) => s.profile.missions_completed === 0,
    tab: null,
    title: 'Step 4 of 4 · Units under way',
    text: 'Your units are driving to the mission along the roads. When the timer ends you are paid and they come home, even if you close the game.',
  },
];

// After the four steps: a short list of things worth trying next. Each line
// ticks itself off as the player does it; the card stays until it is closed.
const NEXT = [
  ['Build a second base, such as a Barracks', (s) => s.bases.length >= 2],
  ['Complete five missions', (s) => s.profile.missions_completed >= 5],
  ['Collect a daily order (Missions → Orders)', (s) => Boolean(s.objectives?.daily.some((d) => d.claimed))],
  ['Join or found an alliance', (s) => Boolean(s.alliance)],
  ['Form a division (Units tab)', (s) => s.divisions.length > 0],
  ['Begin a historical operation (Missions → Orders)', (s) => s.history.length > 0],
];

function nextHtml(s) {
  const lines = NEXT.map(([text, isDone]) => {
    const ok = isDone(s);
    return `<div class="tutorial-line ${ok ? 'is-done' : ''}">${ok ? '✓' : '○'} ${text}</div>`;
  }).join('');
  const all = NEXT.every(([, isDone]) => isDone(s));
  return `
    <strong class="tutorial-title">${all ? 'All done, Commander' : 'You are in command · what to try next'}</strong>
    ${lines}
    <p>Tip: <em>Standing orders</em> under the mission list send units out by themselves while the game is open.
       Everything else is explained under <strong>Help</strong>.</p>
    <button class="link-btn" data-tutorial-end>Close</button>`;
}

export function initTutorial() {
  let done = false;
  let stage = null; // '2' = the four steps are finished and the "what next" list is showing
  try { stage = localStorage.getItem(KEY); } catch { /* ignore */ }
  done = stage === '1';
  if (done) return;

  const card = document.createElement('div');
  card.className = 'tutorial';
  card.hidden = true;
  document.querySelector('.map-wrap').appendChild(card);

  const finish = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
    done = true;
    card.remove();
    document.querySelectorAll('.tab.is-hint').forEach((t) => t.classList.remove('is-hint'));
  };
  card.addEventListener('click', (event) => {
    if (event.target.closest('[data-tutorial-end]')) finish();
  });

  let shownIndex = -2;
  const update = (s) => {
    if (done) return;
    // Only while actually playing (logged in, nation chosen).
    if (!s.profile?.nation_id) {
      card.hidden = true;
      return;
    }
    // A returning player with an established command doesn't need this.
    if (shownIndex === -2 && stage !== '2' && s.profile.missions_completed > 0) return finish();

    const index = stage === '2' ? -1 : STEPS.findIndex((step) => step.when(s));
    if (index === -1) {
      // The "what next" list: redraw only when a line changes.
      if (stage !== '2') {
        stage = '2';
        try { localStorage.setItem(KEY, '2'); } catch { /* ignore */ }
      }
      const html = nextHtml(s);
      if (card.dataset.html !== html) {
        card.dataset.html = html;
        card.innerHTML = html;
      }
      card.hidden = false;
      shownIndex = -1;
      document.querySelectorAll('.tab.is-hint').forEach((t) => t.classList.remove('is-hint'));
      return;
    }
    if (index === shownIndex) return;
    shownIndex = index;
    const step = STEPS[index];

    card.hidden = false;
    card.innerHTML = `
      <strong class="tutorial-title">${step.title}</strong>
      <p>${step.text}</p>
      <button class="link-btn" data-tutorial-end>Skip the tutorial</button>`;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('is-hint', Boolean(step.tab) && tab.dataset.tab === step.tab);
    }
  };

  subscribe(update);
  update(state);
}
