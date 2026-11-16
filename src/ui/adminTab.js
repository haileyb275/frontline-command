// The admin panel. Only shown to players whose profile has is_admin set
// (which can only be done in the Supabase SQL Editor — see 009_admin.sql).
//
// Hiding this screen is NOT what keeps other players out: every admin
// function on the server refuses anyone who is not an administrator. The
// screen is hidden simply because it would be useless to them.
//
// Views (ui.adminView):  'home' → totals, search, reports, chat, audit log
//                        'player' → one player's account

import { getBuilding, getNation, getUnitType } from '../game/content.js';
import * as actions from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { formatLatLng } from '../map.js';
import { esc, fmt } from './dom.js';
import { toast } from './toast.js';

const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export function render(state, ui) {
  if (!state.profile?.is_admin) return '<p class="muted">Administrators only.</p>';
  return ui.adminView === 'player' ? renderPlayer(state, ui) : renderHome(state, ui);
}

// ------------------------------------------------------------------ home

function renderHome(state, ui) {
  const { players, overview } = state.admin;
  const totals = overview?.totals;

  const playerRows = (players ?? []).map((p) => `
    <button class="row" data-action="admin-open" data-player="${esc(p.id)}">
      <span class="row-main">
        <span class="row-title">${esc(p.username)}
          ${p.is_admin ? '<span class="tag">admin</span>' : ''}
          ${p.is_banned ? '<span class="tag tag--bad">suspended</span>' : ''}
          ${p.muted_until && new Date(p.muted_until) > new Date() ? '<span class="tag tag--bad">muted</span>' : ''}</span>
        <span class="row-sub">${esc(getNation(p.nation_id)?.short ?? 'no nation')} · level ${p.level} ·
          ${p.bases} bases · ${p.units} units · ${fmt(p.money)} funds</span>
      </span>
    </button>`).join('') || '<p class="muted">No players match.</p>';

  const reports = (overview?.reports ?? []).map((r) => `
    <div class="card option">
      <p><strong>${esc(r.target_name)}</strong> reported by ${esc(r.reporter_name)} · ${when(r.created_at)}</p>
      <p>${esc(r.reason)}</p>
      ${r.message_body ? `<p class="note">“${esc(r.message_body)}”</p>` : ''}
      <div class="option-foot">
        <button class="btn btn--small" data-action="admin-open" data-player="${esc(r.target_id)}">Open player</button>
        <button class="btn btn--small" data-action="admin-resolve" data-report="${r.id}">Mark resolved</button>
      </div>
    </div>`).join('') || '<p class="muted">No open reports.</p>';

  const chat = (overview?.messages ?? []).map((m) => `
    <div class="log-line">
      <span><span class="tag">${esc(m.alliance_tag ?? '?')}</span>
        <button class="link-btn" data-action="admin-open" data-player="${esc(m.sender_id)}">${esc(m.sender_name)}</button>:
        ${esc(m.body)}</span>
      <button class="btn btn--small btn--quiet" data-action="admin-delete-message" data-message="${m.id}"
              data-confirm="Delete this message for everyone?" aria-label="Delete message">✕</button>
    </div>`).join('') || '<p class="muted">No chat yet.</p>';

  const log = (overview?.log ?? []).map((l) => `
    <div class="log-line">
      <span>${esc(l.admin_name)} · <strong>${esc(l.action)}</strong>${l.target_name ? ` · ${esc(l.target_name)}` : ''}
        <span class="muted">${esc(describe(l.details))}</span></span>
      <span class="muted">${when(l.created_at)}</span>
    </div>`).join('') || '<p class="muted">Nothing logged yet.</p>';

  return `
    <div class="section-head">
      <h2>Admin panel</h2>
      <button class="btn btn--small" data-action="admin-refresh">Refresh</button>
    </div>
    ${totals ? `<div class="facts">
      <div><span>Players</span>${fmt(totals.players)} (${fmt(totals.active_today)} active today)</div>
      <div><span>Alliances</span>${fmt(totals.alliances)}</div>
      <div><span>Bases / units</span>${fmt(totals.bases)} / ${fmt(totals.units)}</div>
    </div>` : ''}

    <h3>Find a player</h3>
    <form class="inline-form" data-form="admin-search">
      <input name="admin_query" type="search" placeholder="Name (leave empty for most recent)" autocomplete="off" />
      <button class="btn btn--small" type="submit">Search</button>
    </form>
    <div class="rows">${playerRows}</div>

    <h3>Open reports <span class="count">${overview?.reports.length ?? 0}</span></h3>
    ${reports}

    <h3>Recent chat (all alliances)</h3>
    ${chat}

    <h3>Audit log</h3>
    ${log}`;
}

/** Turn a log entry's details into a short readable phrase. */
function describe(details) {
  return Object.entries(details ?? {})
    .filter(([, v]) => v !== null && v !== '' && v !== 0)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((n) => (+n).toFixed(2)).join(', ') : v}`)
    .join(' · ');
}

// ---------------------------------------------------------------- player

function renderPlayer(state, ui) {
  const data = state.admin.player;
  if (!data) return '<p class="muted">Loading player…</p>';
  const p = data.profile;
  const muted = p.muted_until && new Date(p.muted_until) > new Date();
  const baseName = new Map(data.bases.map((b) => [b.id, b.name]));

  const bases = data.bases.map((b) => `
    <div class="row row--static row--wrap">
      <span class="row-icon">${esc(getBuilding(b.building_type)?.icon ?? '?')}</span>
      <span class="row-main">
        <span class="row-title">${esc(b.name)}</span>
        <span class="row-sub">${esc(getBuilding(b.building_type)?.name ?? b.building_type)} · level ${b.level} · ${esc(formatLatLng(b))}</span>
      </span>
      <span class="row-actions">
        <button class="btn btn--small" data-action="admin-focus" data-lat="${b.lat}" data-lng="${b.lng}">Show</button>
        <button class="btn btn--small ${ui.adminMoveBase === b.id ? 'btn--primary' : ''}" data-action="admin-move-base" data-base="${esc(b.id)}">
          ${ui.adminMoveBase === b.id ? 'Click the map…' : 'Move'}</button>
        <button class="btn btn--small" data-action="admin-delete-base" data-base="${esc(b.id)}"
                data-confirm="Delete ${esc(b.name)} and every unit stationed there? This cannot be undone.">Delete</button>
      </span>
    </div>`).join('') || '<p class="muted">No bases.</p>';

  const units = data.units.map((u) => {
    // Bases (of the same player) this unit could be moved to.
    const options = data.bases
      .filter((b) => b.id !== u.base_id && getBuilding(b.building_type)?.unlocks_categories.includes(getUnitType(u.unit_type)?.category_id))
      .map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
    return `
      <div class="row row--static row--wrap">
        <span class="row-main">
          <span class="row-title">${esc(getUnitType(u.unit_type)?.name ?? u.unit_type)}</span>
          <span class="row-sub">${esc(baseName.get(u.base_id) ?? '?')} · ${esc(u.status)} · ${u.missions_done} missions${u.specialty ? ` · ${esc(u.specialty)}` : ''}</span>
        </span>
        <span class="row-actions">
          ${options ? `<select class="select" data-change="admin-move-unit" data-unit="${esc(u.id)}" aria-label="Move unit to another base">
                         <option value="">Move to…</option>${options}</select>` : ''}
          <button class="btn btn--small" data-action="admin-delete-unit" data-unit="${esc(u.id)}"
                  data-confirm="Delete this unit? This cannot be undone.">Delete</button>
        </span>
      </div>`;
  }).join('') || '<p class="muted">No units.</p>';

  const log = data.log.map((l) => `
    <div class="log-line"><span>${esc(l.admin_name)} · <strong>${esc(l.action)}</strong>
      <span class="muted">${esc(describe(l.details))}</span></span><span class="muted">${when(l.created_at)}</span></div>`).join('')
    || '<p class="muted">No admin actions on this account.</p>';

  return `
    <div class="section-head">
      <h2>${esc(p.username)}</h2>
      <button class="btn btn--small" data-action="admin-home">Back</button>
    </div>
    <p class="muted">${esc(getNation(p.nation_id)?.name ?? 'No nation')}
      ${data.alliance ? ` · <span class="tag">${esc(data.alliance.tag)}</span> ${esc(data.alliance.role)}` : ''}
      · last seen ${when(p.last_seen_at)}
      ${p.is_admin ? ' · <span class="tag">admin</span>' : ''}
      ${p.is_banned ? ` · <span class="tag tag--bad">suspended</span> ${esc(p.banned_reason ?? '')}` : ''}
      ${muted ? ` · <span class="tag tag--bad">muted until ${when(p.muted_until)}</span>` : ''}</p>

    <div class="facts">
      <div><span>Funds</span>${fmt(p.money)}</div>
      <div><span>Supplies</span>${fmt(p.supplies)}</div>
      <div><span>Level / XP</span>${p.level} / ${fmt(p.xp)}</div>
      <div><span>Missions</span>${fmt(p.missions_completed)}</div>
    </div>

    <h3>Add or take away</h3>
    <form class="card card--notice" data-form="admin-adjust">
      <p class="muted">Enter amounts to add. Use a minus sign to take away. Balances never go below zero.</p>
      <div class="grid-3">
        <label class="field"><span>Funds</span><input name="adj_money" type="number" step="1" placeholder="0" /></label>
        <label class="field"><span>Supplies</span><input name="adj_supplies" type="number" step="1" placeholder="0" /></label>
        <label class="field"><span>XP</span><input name="adj_xp" type="number" step="1" placeholder="0" /></label>
      </div>
      <label class="field"><span>Reason (kept in the audit log)</span>
        <input name="adj_reason" type="text" maxlength="200" autocomplete="off" /></label>
      <button class="btn btn--primary btn--block" type="submit" ${ui.busy ? 'disabled' : ''}>Apply</button>
    </form>

    <h3>Moderation</h3>
    <div class="btn-row">
      ${muted
        ? '<button class="btn" data-action="admin-mute" data-minutes="0">Unmute</button>'
        : `<button class="btn" data-action="admin-mute" data-minutes="60">Mute 1 hour</button>
           <button class="btn" data-action="admin-mute" data-minutes="1440">Mute 1 day</button>`}
    </div>
    <div class="btn-row btn--spaced">
      ${p.is_banned
        ? '<button class="btn" data-action="admin-ban" data-banned="false">Lift suspension</button>'
        : `<button class="btn" data-action="admin-ban" data-banned="true" ${p.is_admin ? 'disabled' : ''}>Suspend account</button>`}
      <button class="btn" data-action="admin-rename">Rename</button>
    </div>
    ${data.alliance && data.alliance.role === 'leader'
      ? `<button class="btn btn--block btn--spaced" data-action="admin-disband" data-alliance="${esc(data.alliance.id)}"
                 data-confirm="Disband the alliance ${esc(data.alliance.name)} for all its members?">Disband their alliance</button>` : ''}

    <h3>Bases <span class="count">${data.bases.length}</span></h3>
    ${ui.adminMoveBase ? '<p class="note">Click the map where the base should go. <button class="link-btn" data-action="admin-move-cancel">Cancel</button></p>' : ''}
    <div class="rows">${bases}</div>

    <h3>Units <span class="count">${data.units.length}</span></h3>
    <div class="rows">${units}</div>

    <h3>Admin actions on this account</h3>
    ${log}`;
}

// ---------------------------------------------------------------- hooks

export function onShow() {
  actions.adminLoadHome().catch((error) => toast(friendlyError(error), 'error'));
}

async function run(ctx, fn, message) {
  ctx.update({ busy: true });
  try {
    await fn();
    if (message) toast(message, 'ok');
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
  ctx.update({ busy: false });
}

export async function handleAction(action, data, ctx) {
  const { ui, update, state } = ctx;
  const playerId = state.admin.player?.profile.id;

  switch (action) {
    case 'admin-home':
      update({ adminView: 'home', adminMoveBase: null });
      return onShow();
    case 'admin-refresh':
      return onShow();
    case 'admin-open':
      update({ adminView: 'player', adminMoveBase: null });
      return run(ctx, () => actions.adminOpenPlayer(data.player));
    case 'admin-focus':
      return ctx.flyTo({ lat: +data.lat, lng: +data.lng });
    case 'admin-resolve':
      return run(ctx, () => actions.adminResolveReport(+data.report), 'Report resolved.');
    case 'admin-delete-message':
      return run(ctx, () => actions.adminDeleteMessage(+data.message), 'Message deleted.');
    case 'admin-mute':
      return run(ctx, () => actions.adminSetMute(playerId, +data.minutes), +data.minutes ? 'Player muted.' : 'Mute lifted.');
    case 'admin-ban': {
      const banning = data.banned === 'true';
      const reason = banning ? window.prompt('Reason for the suspension (the player will see this):', '') : '';
      if (banning && reason === null) return; // cancelled
      return run(ctx, () => actions.adminSetBan(playerId, banning, reason), banning ? 'Account suspended.' : 'Suspension lifted.');
    }
    case 'admin-rename': {
      const name = window.prompt('New name (3–20 letters, numbers or underscores):', state.admin.player.profile.username);
      if (!name) return;
      return run(ctx, () => actions.adminRename(playerId, name.trim()), 'Player renamed.');
    }
    case 'admin-disband':
      return run(ctx, async () => { await actions.adminDisbandAlliance(data.alliance); await actions.adminOpenPlayer(playerId); }, 'Alliance disbanded.');
    case 'admin-move-base':
      return update({ adminMoveBase: ui.adminMoveBase === data.base ? null : data.base });
    case 'admin-move-cancel':
      return update({ adminMoveBase: null });
    case 'admin-delete-base':
      return run(ctx, () => actions.adminDeleteBase(data.base), 'Base deleted.');
    case 'admin-delete-unit':
      return run(ctx, () => actions.adminDeleteUnit(data.unit), 'Unit deleted.');
  }
}

/** <select data-change="…"> elements. */
export function handleChange(name, el, ctx) {
  if (name === 'admin-move-unit' && el.value) {
    return run(ctx, () => actions.adminMoveUnit(el.dataset.unit, el.value), 'Unit moved.');
  }
}

export async function handleSubmit(formName, values, ctx, form) {
  if (formName === 'admin-search') {
    return run(ctx, () => actions.adminSearch(values.admin_query ?? ''));
  }
  if (formName === 'admin-adjust') {
    const n = (v) => Math.trunc(Number(v) || 0);
    const [money, supplies, xp] = [n(values.adj_money), n(values.adj_supplies), n(values.adj_xp)];
    if (!money && !supplies && !xp) return toast('Enter at least one amount.', 'info');
    form.reset();
    return run(ctx, () => actions.adminAdjust(ctx.state.admin.player.profile.id, money, supplies, xp, values.adj_reason ?? ''), 'Account updated.');
  }
}

/** While "Move" is armed, the next map click chooses the base's new site. */
export function handleMapClick(latlng, ctx) {
  const { ui, update } = ctx;
  if (ui.adminView !== 'player' || !ui.adminMoveBase) return false;
  if (!window.confirm(`Move this base to ${formatLatLng(latlng)}?`)) return true;
  const baseId = ui.adminMoveBase;
  update({ adminMoveBase: null });
  run(ctx, () => actions.adminMoveBase(baseId, latlng), 'Base moved.');
  return true;
}
