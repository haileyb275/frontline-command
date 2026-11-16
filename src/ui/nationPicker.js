// The "choose your nation" screen, shown once after the first login.
// The cards are generated from src/data/nations.json — add a nation there
// (and re-run the seed) and it appears here automatically.

import nations from '../data/nations.json';
import { supabase, friendlyError } from '../supabase.js';
import { setState } from '../state.js';
import { esc, showOverlay, hideOverlay } from './dom.js';

/** Look up a nation's display data by id (used by the top bar too). */
export function getNation(id) {
  return nations.find((n) => n.id === id) ?? null;
}

export function showNationPicker() {
  let selectedId = null;

  const cards = nations
    .map(
      (n) => `
      <button type="button" class="nation-card" data-nation="${esc(n.id)}" style="--nation: ${esc(n.color)}">
        <span class="nation-chip">${esc(n.short)}</span>
        <span class="nation-name">${esc(n.name)}</span>
        <span class="nation-desc">${esc(n.description)}</span>
        <span class="nation-bonus">${esc(n.bonus_text)}</span>
        <span class="nation-units">${n.signature_units.map(esc).join(' · ')}</span>
      </button>`
    )
    .join('');

  const overlay = showOverlay(`
    <div class="dialog dialog--wide">
      <div class="dialog-head">
        <h1>Choose your nation</h1>
        <p>Each nation fields its own units and has one small advantage.
           This choice is permanent, and any nation can join any alliance.</p>
      </div>
      <div class="nation-grid">${cards}</div>
      <p class="form-msg" id="nation-msg" role="alert"></p>
      <button class="btn btn--primary" id="nation-confirm" disabled>Select a nation</button>
    </div>
  `);

  const confirm = overlay.querySelector('#nation-confirm');
  const msg = overlay.querySelector('#nation-msg');
  const cardEls = [...overlay.querySelectorAll('.nation-card')];

  for (const card of cardEls) {
    card.addEventListener('click', () => {
      selectedId = card.dataset.nation;
      for (const c of cardEls) c.classList.toggle('is-selected', c === card);
      confirm.disabled = false;
      confirm.textContent = `Command ${getNation(selectedId).name}`;
    });
  }

  confirm.addEventListener('click', async () => {
    if (!selectedId) return;
    confirm.disabled = true;
    msg.dataset.kind = 'info';
    msg.textContent = 'Signing your commission…';

    // We don't write to the profiles table ourselves (we're not allowed
    // to). We ASK the server function, which checks and makes the change.
    const { data, error } = await supabase.rpc('choose_nation', { p_nation_id: selectedId });

    if (error) {
      msg.dataset.kind = 'error';
      msg.textContent = friendlyError(error);
      confirm.disabled = false;
      return;
    }

    hideOverlay();
    setState({ profile: data }); // the function returns the updated profile row
  });
}
