// The "Ranks" tab: global leaderboards for players and alliances.

import { getNation, rankTitle } from '../game/content.js';
import { loadLeaderboard, loadSeasonBoard, loadAllianceWeek, openProfile, closeProfile, reportPlayer } from '../game/actions.js';
import { msUntil, formatDuration } from '../game/clock.js';
import { renderProfile } from './profileView.js';
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
  if (ui.ranksView === 'profile') return renderProfile(state);
  const board = state.leaderboard;
  if (!board) return '<p class="muted">Loading rankings…</p>';

  const nav = [['players', 'Commanders'], ['season', 'Season'], ['alliances', 'Alliances']]
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
    ${ui.ranksView === 'alliances' ? renderAlliances(state, board)
      : ui.ranksView === 'season' ? renderSeason(state) : renderPlayers(state, board)}`;
}

function renderPlayers(state, board) {
  const myName = state.profile?.username;
  const rows = board.players
    .map((p) => `
      <button class="row ${p.username === myName ? 'is-me' : ''}" data-action="open-profile" data-username="${esc(p.username)}">
        <span class="rank-no">${p.position}</span>
        ${nationChip(p.nation_id)}
        <span class="row-main">
          <span class="row-title">${p.alliance_tag ? `<span class="tag">${esc(p.alliance_tag)}</span> ` : ''}${esc(p.username)}</span>
          <span class="row-sub">${esc(rankTitle(p.level))} · level ${p.level} · ${fmt(p.missions_completed)} missions</span>
        </span>
        <span class="row-side">${fmt(p.xp)} XP</span>
      </button>`)
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

function renderSeason(state) {
  const s = state.season;
  if (!s) return '<p class="muted">Loading season…</p>';
  const myName = state.profile?.username;
  const days = Math.max(0, Math.ceil(msUntil(s.season.ends_at) / 86400000));
  const rows = s.players.map((p) => `
    <button class="row ${p.username === myName ? 'is-me' : ''}" data-action="open-profile" data-username="${esc(p.username)}">
      <span class="rank-no">${p.position}</span>
      ${nationChip(p.nation_id)}
      <span class="row-main">
        <span class="row-title">${p.alliance_tag ? `<span class="tag">${esc(p.alliance_tag)}</span> ` : ''}${esc(p.username)}</span>
        <span class="row-sub">${esc(rankTitle(p.level))}</span>
      </span>
      <span class="row-side">${fmt(p.xp)} XP</span>
    </button>`).join('') || '<p class="muted">Nobody has scored this season yet. The first mission puts you on the board.</p>';
  return `
    <p class="muted"><strong>${esc(s.season.name)}</strong> · ${days} day${days === 1 ? '' : 's'} left.
       Only XP earned this season counts here. When it ends, the top ten keep a permanent award on their profile
       and everyone starts again from zero. Your level, funds and bases are never reset.</p>
    <div class="rows">${rows}</div>
    ${s.me && s.me.position > s.players.length
      ? `<h3>Your position</h3><p>#${s.me.position} with ${fmt(s.me.xp)} XP</p>` : ''}`;
}

function renderAlliances(state, board) {
  if (board.alliances.length === 0) {
    return '<p class="muted">No alliances yet. Found one in the Alliance tab.</p>';
  }
  const myId = state.alliance?.info.id;
  const week = state.allianceWeek;
  const weekRow = (a) => `
      <div class="row row--static ${a.id === myId ? 'is-me' : ''}">
        <span class="rank-no">${a.position}</span>
        <span class="row-main"><span class="row-title"><span class="tag">${esc(a.tag)}</span> ${esc(a.name)}</span></span>
        <span class="row-side">${fmt(a.score)} pts</span>
      </div>`;
  const days = week ? Math.max(0, Math.ceil(msUntil(week.ends_at) / 86400000)) : 0;
  const rivalry = week ? `
    <h3>This week's rivalry <span class="count">${days} day${days === 1 ? '' : 's'} left</span></h3>
    <p class="muted">One point for every mission a member completes, two for a hard one. The board starts again each Monday.</p>
    <div class="rows">${week.this_week.map(weekRow).join('') || '<p class="muted">No alliance has scored yet this week.</p>'}</div>
    ${week.last_week.length ? `<h3>Last week's winners</h3><div class="rows">${week.last_week.map(weekRow).join('')}</div>` : ''}
    <h3>All time</h3>` : '';
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
  return `${rivalry}<p class="muted">Alliances earn XP from the shared missions their members complete.</p>
          <div class="rows">${rows}</div>`;
}

/** Called by panel.js each time this tab is opened. */
export function onShow() {
  loadSeasonBoard().catch(() => {});
  loadAllianceWeek().catch(() => {});
  loadLeaderboard().catch((error) => toast(friendlyError(error), 'error'));
}

export async function handleAction(action, data, ctx) {
  const viewed = ctx.state.viewedProfile;
  if (action === 'profile-close') {
    closeProfile();
    return ctx.update({ ranksView: 'players' });
  }
  if (action === 'profile-focus') return ctx.flyTo({ lat: +data.lat, lng: +data.lng });
  if (action === 'profile-show-map' && viewed) return ctx.fitTo(viewed.bases);
  if (action === 'profile-report' && viewed) {
    const reason = window.prompt(`Why are you reporting ${viewed.username}? An administrator will read this.`, '');
    if (!reason) return;
    try {
      await reportPlayer(viewed.username, reason);
      toast('Report sent. Thank you.', 'ok');
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
    return;
  }
  if (action === 'ranks-view') return ctx.update({ ranksView: data.view });
  if (action === 'refresh-ranks') return onShow();
}
