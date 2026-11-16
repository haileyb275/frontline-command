// Keeps the top bar (resources + player badge) in step with the state.

import { supabase } from '../supabase.js';
import { subscribe } from '../state.js';
import { getNation, xpForLevel } from '../game/content.js';
import { fmt } from './dom.js';

export function initTopbar() {
  const money = document.getElementById('res-money');
  const supplies = document.getElementById('res-supplies');
  const level = document.getElementById('res-level');
  const player = document.getElementById('player');
  const playerName = document.getElementById('player-name');
  const playerNation = document.getElementById('player-nation');
  const logout = document.getElementById('logout');

  logout.addEventListener('click', () => supabase.auth.signOut());

  // Re-draw whenever the state changes.
  subscribe(({ profile }) => {
    money.textContent = profile ? fmt(profile.money) : '—';
    supplies.textContent = profile ? fmt(profile.supplies) : '—';
    level.textContent = profile ? `Lv ${profile.level}` : '—';
    // Hover (or long-press) the rank to see progress to the next level.
    level.parentElement.title = profile
      ? `${fmt(profile.xp)} / ${fmt(xpForLevel(profile.level + 1))} XP to level ${profile.level + 1}`
      : '';

    player.hidden = !profile;
    if (!profile) return;

    // textContent (not innerHTML) is safe for player-chosen names.
    playerName.textContent = profile.username;

    const nation = getNation(profile.nation_id);
    playerNation.hidden = !nation;
    if (nation) {
      playerNation.textContent = nation.short;
      playerNation.title = nation.name;
      playerNation.style.setProperty('--nation', nation.color);
    }
  });
}
