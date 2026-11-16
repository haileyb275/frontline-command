// The "Alliance" tab.
//
// Not in an alliance  → browse the list, join one, or found your own.
// In an alliance      → four sub-views chosen by `ui.allianceView`:
//                       'overview' | 'chat' | 'members' | 'buildings'

import { allianceBuildings, getNation, getMissionType, settings } from '../game/content.js';
import * as actions from '../game/actions.js';
import { friendlyError } from '../supabase.js';
import { esc, fmt } from './dom.js';
import { toast } from './toast.js';

const VIEWS = [
  ['overview', 'Overview'],
  ['chat', 'Chat'],
  ['members', 'Members'],
  ['buildings', 'Buildings'],
];

function nationChip(nationId) {
  const nation = getNation(nationId);
  return nation
    ? `<span class="nation-chip nation-chip--sm" style="--nation: ${esc(nation.color)}"
             title="${esc(nation.name)}">${esc(nation.short)}</span>`
    : '';
}

// ---------------------------------------------------------------- render

export function render(state, ui) {
  if (!state.profile?.nation_id) return '';
  if (!state.alliance) return renderBrowse(state, ui);

  const { alliance } = state;
  const nav = VIEWS.map(
    ([id, label]) => `
      <button class="seg-btn ${ui.allianceView === id ? 'is-active' : ''}"
              data-action="alliance-view" data-view="${id}">
        ${label}${id === 'chat' && state.unread > 0 && ui.allianceView !== 'chat'
          ? ` <span class="dot" title="New messages"></span>` : ''}
      </button>`
  ).join('');

  const views = { overview: renderOverview, chat: renderChat, members: renderMembers, buildings: renderBuildings };

  return `
    <div class="section-head">
      <h2><span class="tag">${esc(alliance.info.tag)}</span> ${esc(alliance.info.name)}</h2>
    </div>
    <div class="seg seg--tabs">${nav}</div>
    ${(views[ui.allianceView] ?? renderOverview)(state, ui)}`;
}

function renderBrowse(state, ui) {
  const list = state.alliances ?? [];
  const cost = settings.alliance_create_cost;

  const rows = list.length
    ? list
        .map(
          (a) => `
          <div class="row row--static">
            <span class="row-main">
              <span class="row-title"><span class="tag">${esc(a.tag)}</span> ${esc(a.name)}</span>
              <span class="row-sub">${a.members} member${a.members === 1 ? '' : 's'}
                ${a.description ? ` · ${esc(a.description)}` : ''}</span>
            </span>
            <button class="btn btn--small" data-action="join-alliance" data-alliance="${esc(a.id)}"
                    ${ui.busy ? 'disabled' : ''}>Join</button>
          </div>`
        )
        .join('')
    : '<p class="muted">No alliances exist yet. Found the first one below.</p>';

  return `
    <div class="section-head"><h2>Alliances</h2>
      <button class="btn btn--small" data-action="refresh-alliances">Refresh</button></div>
    <p class="muted">Alliances are open to every nation. Members share large missions,
       a treasury and bonuses from alliance buildings.</p>
    <div class="rows">${rows}</div>

    <h3>Found a new alliance</h3>
    <form class="card card--notice" data-form="create-alliance">
      <label class="field"><span>Name</span>
        <input name="alliance_name" type="text" maxlength="30" placeholder="3–30 characters" autocomplete="off" required /></label>
      <label class="field"><span>Tag</span>
        <input name="alliance_tag" type="text" maxlength="5" placeholder="2–5 letters, e.g. 1AD" autocomplete="off" required /></label>
      <label class="field"><span>Description (optional)</span>
        <input name="alliance_description" type="text" maxlength="200" autocomplete="off" /></label>
      <button class="btn btn--primary btn--block" type="submit"
              ${ui.busy || state.profile.money < cost ? 'disabled' : ''}>
        ${state.profile.money < cost ? `Needs ${fmt(cost)} funds` : `Found alliance · ${fmt(cost)} funds`}
      </button>
    </form>`;
}

function renderOverview(state, ui) {
  const { alliance, missions, profile } = state;
  const shared = missions.filter((m) => m.alliance_id === alliance.info.id);

  const sharedRows = shared.length
    ? shared
        .map(
          (m) => `
          <button class="row" data-action="open-mission" data-mission="${esc(m.id)}">
            <span class="row-main">
              <span class="row-title">${esc(getMissionType(m.mission_type).name)}</span>
              <span class="row-sub">shared by ${esc(m.owner_name)}</span>
            </span>
            <span class="status ${m.status === 'in_progress' ? 'status--en_route' : ''}">
              ${m.status === 'in_progress' ? 'under way' : 'needs units'}</span>
          </button>`
        )
        .join('')
    : '<p class="muted">No shared missions. Large operations can be shared from the Missions tab.</p>';

  const log = alliance.log.length
    ? alliance.log
        .map(
          (entry) => `
          <div class="log-line">
            <span>${esc(entry.player_name)} · ${esc(entry.reason)}</span>
            <span class="${entry.amount < 0 ? 'neg' : 'pos'}">${entry.amount > 0 ? '+' : ''}${fmt(entry.amount)}</span>
          </div>`
        )
        .join('')
    : '<p class="muted">No treasury activity yet.</p>';

  return `
    ${alliance.info.description ? `<p>${esc(alliance.info.description)}</p>` : ''}
    <div class="facts">
      <div><span>Members</span>${alliance.members.length} / ${alliance.member_cap}</div>
      <div><span>Treasury</span>${fmt(alliance.info.treasury)} funds</div>
      <div><span>Alliance XP</span>${fmt(alliance.info.xp)}</div>
      <div><span>Your role</span>${esc(alliance.my_role)}</div>
    </div>

    <h3>Shared missions <span class="count">${shared.length}</span></h3>
    <div class="rows">${sharedRows}</div>

    <h3>Donate to the treasury</h3>
    <form class="inline-form" data-form="donate">
      <input name="donate_amount" type="number" min="1" max="${profile.money}" step="1"
             placeholder="Amount" inputmode="numeric" required />
      <button class="btn btn--small" type="submit" ${ui.busy ? 'disabled' : ''}>Donate</button>
    </form>
    <p class="muted">The treasury pays for alliance buildings. It also receives
       ${Math.round(settings.alliance_treasury_cut * 100)}% of every shared mission's funds.</p>

    <h3>Treasury log</h3>
    ${log}

    <button class="btn btn--block btn--spaced" data-action="leave-alliance" ${ui.busy ? 'disabled' : ''}>
      Leave alliance</button>`;
}

function renderChat(state, ui) {
  const { alliance, profile } = state;

  const lines = alliance.messages.length
    ? alliance.messages
        .map((msg) => {
          const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          if (!msg.sender_id && msg.sender_name === 'System') {
            return `<div class="chat-line chat-line--system">${esc(msg.body)} <time>${time}</time></div>`;
          }
          return `
            <div class="chat-line ${msg.sender_id === profile.id ? 'is-mine' : ''}">
              <div class="chat-meta">${nationChip(msg.sender_nation)}
                <button class="link-btn link-btn--name" data-action="open-profile" data-username="${esc(msg.sender_name)}">${esc(msg.sender_name)}</button>
                <time>${time}</time>
                ${msg.sender_id !== profile.id
                  ? `<button class="link-btn" data-action="report-message" data-message="${msg.id}" data-username="${esc(msg.sender_name)}">report</button>` : ''}</div>
              <div class="chat-body">${esc(msg.body)}</div>
            </div>`;
        })
        .join('')
    : '<p class="muted">No messages yet. Say hello.</p>';

  return `
    <div class="chat">
      <div class="chat-log" aria-live="polite">${lines}</div>
      <form class="inline-form" data-form="chat">
        <input name="chat_body" type="text" maxlength="500" placeholder="Message your alliance"
               autocomplete="off" required />
        <button class="btn btn--small" type="submit">Send</button>
      </form>
    </div>`;
}

function renderMembers(state, ui) {
  const { alliance, profile } = state;
  const iAmLeader = alliance.my_role === 'leader';
  const iAmOfficer = alliance.my_role === 'officer';

  const rows = alliance.members
    .map((m) => {
      const isMe = m.player_id === profile.id;
      // "Online" = their browser checked in during the last minute.
      const online = Date.now() - new Date(m.last_seen_at).getTime() < 60000;

      let buttons = '';
      if (!isMe && iAmLeader) {
        buttons += m.role === 'member'
          ? `<button class="btn btn--small" data-action="set-role" data-player="${esc(m.player_id)}" data-role="officer">Promote</button>`
          : `<button class="btn btn--small" data-action="set-role" data-player="${esc(m.player_id)}" data-role="member">Demote</button>`;
        buttons += `<button class="btn btn--small" data-action="set-role" data-player="${esc(m.player_id)}" data-role="leader"
                            data-confirm="Hand leadership to ${esc(m.username)}? You will become an officer.">Make leader</button>`;
      }
      if (!isMe && (iAmLeader || (iAmOfficer && m.role === 'member'))) {
        buttons += `<button class="btn btn--small" data-action="kick" data-player="${esc(m.player_id)}"
                            data-confirm="Remove ${esc(m.username)} from the alliance?">Remove</button>`;
      }

      return `
        <div class="row row--static row--wrap">
          ${nationChip(m.nation_id)}
          <span class="row-main">
            <span class="row-title">${online ? '<span class="dot dot--ok" title="Online"></span> ' : ''}<button class="link-btn link-btn--name" data-action="open-profile" data-username="${esc(m.username)}">${esc(m.username)}</button>${isMe ? ' (you)' : ''}</span>
            <span class="row-sub">Level ${m.level} · donated ${fmt(m.donated_total)}</span>
          </span>
          <span class="status status--${esc(m.role)}">${esc(m.role)}</span>
          ${buttons ? `<span class="row-actions">${buttons}</span>` : ''}
        </div>`;
    })
    .join('');

  return `
    <h3>Members <span class="count">${alliance.members.length} / ${alliance.member_cap}</span></h3>
    <div class="rows">${rows}</div>`;
}

function renderBuildings(state, ui) {
  const { alliance } = state;
  const canBuild = alliance.my_role === 'leader' || alliance.my_role === 'officer';

  const cards = allianceBuildings
    .map((b) => {
      const level = alliance.buildings[b.id] ?? 0;
      const maxed = level >= b.max_level;
      const price = b.cost * (level + 1); // each level costs more than the last

      let label = `${level === 0 ? 'Build' : 'Upgrade'} · ${fmt(price)}`;
      let blocked = ui.busy;
      if (maxed) { label = 'Maximum level'; blocked = true; }
      else if (!canBuild) { label = `${fmt(price)} · officers only`; blocked = true; }
      else if (alliance.info.treasury < price) { label = `Needs ${fmt(price)}`; blocked = true; }

      return `
        <div class="card option">
          <div class="option-head">
            <h2>${esc(b.name)}</h2>
            <span class="count">Level ${level} / ${b.max_level}</span>
          </div>
          <p>${esc(b.description)}</p>
          <p class="price">${esc(b.bonus_text)}</p>
          <div class="option-foot">
            <span class="muted">Paid from the treasury</span>
            <button class="btn btn--small" data-action="alliance-build" data-type="${esc(b.id)}"
                    ${blocked ? 'disabled' : ''}>${label}</button>
          </div>
        </div>`;
    })
    .join('');

  return `<p class="muted">Treasury: <strong>${fmt(alliance.info.treasury)} funds</strong>.
            Buildings give their bonus to every member.</p>${cards}`;
}

// ---------------------------------------------------------------- hooks

/** Called by panel.js after each draw. Keeps the chat scrolled to the newest line. */
export function afterRender(root, state, ui) {
  const log = root.querySelector('.chat-log');
  if (log) log.scrollTop = log.scrollHeight;
  if (ui.tab === 'alliance' && ui.allianceView === 'chat' && state.unread > 0) {
    actions.markChatRead();
  }
}

/** Run a server action with the usual busy / error handling. */
async function run(ctx, fn, successMessage) {
  ctx.update({ busy: true });
  try {
    await fn();
    if (successMessage) toast(successMessage, 'ok');
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
  ctx.update({ busy: false });
}

export async function handleAction(action, data, ctx) {
  switch (action) {
    case 'report-message': {
      const reason = window.prompt(`Report this message from ${data.username}? Say briefly what is wrong with it.`, '');
      if (!reason) return;
      try {
        await actions.reportPlayer(data.username, reason, +data.message);
        toast('Report sent. Thank you.', 'ok');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
      return;
    }
    case 'alliance-view':
      return ctx.update({ allianceView: data.view });
    case 'refresh-alliances':
      return run(ctx, () => actions.loadAllianceList());
    case 'join-alliance':
      return run(ctx, () => actions.joinAlliance(data.alliance), 'Welcome to the alliance.');
    case 'leave-alliance':
      if (!window.confirm('Leave this alliance?')) return;
      return run(ctx, () => actions.leaveAlliance(), 'You left the alliance.');
    case 'set-role':
      return run(ctx, () => actions.setMemberRole(data.player, data.role));
    case 'kick':
      return run(ctx, () => actions.kickMember(data.player));
    case 'alliance-build':
      return run(ctx, () => actions.buildAllianceBuilding(data.type), 'Construction complete.');
  }
}

export async function handleSubmit(formName, values, ctx, form) {
  switch (formName) {
    case 'create-alliance':
      return run(
        ctx,
        () => actions.createAlliance(values.alliance_name, values.alliance_tag, values.alliance_description),
        'Alliance founded.'
      );

    case 'donate': {
      const amount = Math.floor(Number(values.donate_amount));
      if (!(amount > 0)) return toast('Enter an amount greater than zero.', 'error');
      form.reset();
      return run(ctx, () => actions.donate(amount), `Donated ${fmt(amount)} funds.`);
    }

    case 'chat': {
      const text = values.chat_body.trim();
      if (!text) return;
      form.reset(); // clear the box straight away so the next message can be typed
      try {
        await actions.sendMessage(text);
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
    }
  }
}
