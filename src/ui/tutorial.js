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

const FINISH = {
  title: 'You are in command',
  text: 'That is the whole loop. Next: build a Barracks, look at the optional <strong>Orders</strong> in the Missions tab, and find an alliance.',
};

export function initTutorial() {
  let done = false;
  try { done = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
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
    if (shownIndex === -2 && s.profile.missions_completed > 0) return finish();

    const index = STEPS.findIndex((step) => step.when(s));
    if (index === shownIndex) return;
    shownIndex = index;
    const step = index === -1 ? FINISH : STEPS[index];

    card.hidden = false;
    card.innerHTML = `
      <strong class="tutorial-title">${step.title}</strong>
      <p>${step.text}</p>
      <button class="link-btn" data-tutorial-end>${index === -1 ? 'Close' : 'Skip the tutorial'}</button>`;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('is-hint', Boolean(step.tab) && tab.dataset.tab === step.tab);
    }
  };

  subscribe(update);
  update(state);
}
