// The "Ranks" tab: global leaderboards for players and alliances.

import { getNation } from '../game/content.js';
import { loadLeaderboard } from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { esc, fmt } from './dom.js';
import { toast } from './toast.js';

function nationChip(nationId) {
  const nation = getNation(nationId);
  return nation
    ? `<span class="nation-chip nation-chip--sm" style="--nation: ${esc(nation.color)}"
             title="${esc(nation.name)}">${esc(nation.short)}</span>`
    : '';
}

export function render(state, ui) {
  const board = state.leaderboard;
  if (!board) return '<p class="muted">Loading rankings…</p>';

  const nav = [['players', 'Commanders'], ['alliances', 'Alliances']]
    .map(([id, label]) => `
      <button class="seg-btn ${ui.ranksView === id ? 'is-active' : ''}"
              data-action="ranks-view" data-view="${id}">${label}</button>`)
    .join('');

  return `
    <div class="section-head">
      <h2>Rankings</h2>
      <button class="btn btn--small" data-action="refresh-ranks">Refresh</button>
    </div>
    <div class="seg seg--tabs">${nav}</div>
    ${ui.ranksView === 'alliances' ? renderAlliances(state, board) : renderPlayers(state, board)}`;
}

function renderPlayers(state, board) {
  const myName = state.profile?.username;
  const rows = board.players
    .map((p) => `
      <div class="row row--static ${p.username === myName ? 'is-me' : ''}">
        <span class="rank-no">${p.position}</span>
        ${nationChip(p.nation_id)}
        <span class="row-main">
          <span class="row-title">${p.alliance_tag ? `<span class="tag">${esc(p.alliance_tag)}</span> ` : ''}${esc(p.username)}</span>
          <span class="row-sub">Level ${p.level} · ${fmt(p.missions_completed)} missions</span>
        </span>
        <span class="row-side">${fmt(p.xp)} XP</span>
      </div>`)
    .join('');

  // If we're outside the top 50, show our own line underneath.
  const mine = board.me && board.me.position > board.players.length
    ? `<h3>Your position</h3>
       <div class="row row--static is-me">
         <span class="rank-no">${board.me.position}</span>
         ${nationChip(board.me.nation_id)}
         <span class="row-main"><span class="row-title">${esc(board.me.username)}</span>
           <span class="row-sub">Level ${board.me.level}</span></span>
         <span class="row-side">${fmt(board.me.xp)} XP</span>
       </div>`
    : '';

  return `
    <p class="muted">${fmt(board.player_count)} commander${board.player_count === 1 ? '' : 's'} in the field, ranked by experience.</p>
    <div class="rows">${rows}</div>${mine}`;
}

function renderAlliances(state, board) {
  if (board.alliances.length === 0) {
    return '<p class="muted">No alliances yet. Found one in the Alliance tab.</p>';
  }
  const myId = state.alliance?.info.id;
  const rows = board.alliances
    .map((a) => `
      <div class="row row--static ${a.id === myId ? 'is-me' : ''}">
        <span class="rank-no">${a.position}</span>
        <span class="row-main">
          <span class="row-title"><span class="tag">${esc(a.tag)}</span> ${esc(a.name)}</span>
          <span class="row-sub">${a.members} member${a.members === 1 ? '' : 's'}</span>
        </span>
        <span class="row-side">${fmt(a.xp)} XP</span>
      </div>`)
    .join('');
  return `<p class="muted">Alliances earn XP from the shared missions their members complete.</p>
          <div class="rows">${rows}</div>`;
}

/** Called by panel.js each time this tab is opened. */
export function onShow() {
  loadLeaderboard().catch((error) => toast(friendlyError(error), 'error'));
}

export function handleAction(action, data, ctx) {
  if (action === 'ranks-view') return ctx.update({ ranksView: data.view });
  if (action === 'refresh-ranks') return onShow();
}
