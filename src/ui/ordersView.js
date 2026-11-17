// The "Orders" view inside the Missions tab:
//
//   * Daily orders  — three a day, entirely optional, each pays a bonus
//   * Campaigns     — several steps, a larger reward
//   * Achievements  — single milestones
//
// The browser only DISPLAYS progress. When a reward is claimed the server
// re-checks its own counts before paying (see 010_orders.sql).

import { dailyOrders, objectives, settings } from '../game/content.js';
import { msUntil, formatDuration } from '../game/clock.js';
import { esc, fmt } from './dom.js';

const rewardText = (money, supplies, xp) =>
  [money && `${fmt(money)} funds`, supplies && `${fmt(supplies)} supplies`, xp && `${fmt(xp)} XP`]
    .filter(Boolean).join(' · ');

function progressBar(have, target) {
  const pct = Math.min(100, Math.round((have / target) * 100));
  return `<span class="meter"><span style="width: ${pct}%"></span></span>
          <span class="muted">${fmt(Math.min(have, target))} / ${fmt(target)}</span>`;
}

/** How many rewards are waiting to be collected (for the dot on the button). */
export function claimableCount(state) {
  const o = state.objectives;
  if (!o) return 0;
  const daily = o.daily.filter((d) => {
    const type = dailyOrders.find((t) => t.id === d.order_id);
    return type && !d.claimed && (o.today[type.counter] ?? 0) >= type.target;
  }).length;
  const e = state.globalEvent;
  const event = e?.status === 'succeeded' && e.mine?.amount > 0 && !e.mine.claimed ? 1 : 0;
  const others = objectives.filter((obj) =>
    !o.claimed.includes(obj.id) && obj.steps.every((s) => (o.counters[s.counter] ?? 0) >= s.target)).length;
  return daily + others + event;
}

/** The worldwide event: one target every player in the game works toward. */
export function renderEvent(state, ui) {
  const e = state.globalEvent;
  if (!e) return '';
  const status = { active: `ends in <span class="js-countdown" data-until="${esc(e.ends_at)}"></span>`,
                   succeeded: 'target reached', failed: 'ran out of time' }[e.status];
  const top = e.top.map((c, i) => `
    <div class="log-line"><span>${i + 1}. ${esc(c.username)}</span><span>${fmt(c.amount)}</span></div>`).join('');
  const canClaim = e.status === 'succeeded' && e.mine && e.mine.amount > 0 && !e.mine.claimed;
  return `
    <h3>Worldwide event <span class="count">${fmt(e.players)} taking part</span></h3>
    <div class="card card--event">
      <h2>${esc(e.name)}</h2>
      ${e.description ? `<p>${esc(e.description)}</p>` : ''}
      <p class="muted">Every commander in the game counts toward one target · ${status}</p>
      <div class="progress">${progressBar(e.progress, e.target)}</div>
      <p class="price">Reward for everyone who takes part: ${rewardText(e.reward_money, e.reward_supplies, e.reward_xp) || 'honour'}</p>
      <p class="muted">Your part so far: ${fmt(e.mine?.amount ?? 0)}${e.mine?.claimed ? ' · reward collected' : ''}</p>
      ${canClaim ? `<button class="btn btn--primary btn--block" data-action="claim-event" data-event="${esc(e.id)}"
                            ${ui.busy ? 'disabled' : ''}>Collect your reward</button>` : ''}
      ${top}
    </div>`;
}

export function renderOrders(state, ui) {
  const o = state.objectives;
  if (!o) return '<p class="muted">Loading orders…</p>';

  // ---- Daily orders
  const round = (n) => Math.round(n * o.scale);
  const dailyCards = o.daily.map((d) => {
    const type = dailyOrders.find((t) => t.id === d.order_id);
    if (!type) return '';
    const have = o.today[type.counter] ?? 0;
    const done = have >= type.target;
    return `
      <div class="card option ${d.claimed ? 'is-claimed' : ''}">
        <div class="option-head"><h2>${esc(type.text)}</h2></div>
        <div class="progress">${progressBar(have, type.target)}</div>
        <div class="option-foot">
          <span class="price">${rewardText(round(type.reward_money), round(type.reward_supplies), round(type.reward_xp))}</span>
          <button class="btn btn--small ${done && !d.claimed ? 'btn--primary' : ''}" data-action="claim-daily"
                  data-order="${esc(type.id)}" ${!done || d.claimed || ui.busy ? 'disabled' : ''}>
            ${d.claimed ? 'Collected' : done ? 'Collect' : 'In progress'}</button>
        </div>
      </div>`;
  }).join('');

  const allClaimed = o.daily.length >= 3 && o.daily.every((d) => d.claimed);
  const bonus = rewardText(round(settings.daily_bonus_money), round(settings.daily_bonus_supplies), round(settings.daily_bonus_xp));

  // ---- Campaigns and achievements
  const card = (obj) => {
    const claimed = o.claimed.includes(obj.id);
    const steps = obj.steps.map((s) => {
      const have = o.counters[s.counter] ?? 0;
      return `<div class="step ${have >= s.target ? 'is-done' : ''}">
                <span>${have >= s.target ? '✓' : '○'} ${esc(s.text)}</span>
                <span class="muted">${fmt(Math.min(have, s.target))} / ${fmt(s.target)}</span>
              </div>`;
    }).join('');
    const done = obj.steps.every((s) => (o.counters[s.counter] ?? 0) >= s.target);
    return `
      <div class="card option ${claimed ? 'is-claimed' : ''}">
        <div class="option-head"><h2>${esc(obj.name)}</h2></div>
        <p>${esc(obj.description)}</p>
        ${steps}
        <div class="option-foot">
          <span class="price">${rewardText(obj.reward_money, obj.reward_supplies, obj.reward_xp)}</span>
          <button class="btn btn--small ${done && !claimed ? 'btn--primary' : ''}" data-action="claim-objective"
                  data-objective="${esc(obj.id)}" ${!done || claimed || ui.busy ? 'disabled' : ''}>
            ${claimed ? 'Completed' : done ? 'Collect' : 'In progress'}</button>
        </div>
      </div>`;
  };
  // Unfinished ones first, completed ones at the bottom.
  const order = (list) => [...list].sort((a, b) => o.claimed.includes(a.id) - o.claimed.includes(b.id) || a.sort - b.sort);
  const campaigns = order(objectives.filter((x) => x.kind === 'campaign'));
  const achievements = order(objectives.filter((x) => x.kind === 'achievement'));
  const count = (list) => `${list.filter((x) => o.claimed.includes(x.id)).length} / ${list.length}`;

  return `
    ${renderEvent(state, ui)}
    <h3>Daily orders <span class="count">optional</span></h3>
    <p class="muted">Three new orders each day. Ignore them freely: there is no penalty.
       Finish one for extra resources, or all three for a further bonus of ${bonus}.
       New orders in <span class="js-countdown" data-until="${esc(o.resets_at)}"></span>.</p>
    ${dailyCards || '<p class="muted">No orders today.</p>'}
    ${allClaimed ? '<p class="note">All of today\'s orders are done. The bonus has been paid.</p>' : ''}

    <h3>Campaigns <span class="count">${count(campaigns)}</span></h3>
    ${campaigns.map(card).join('')}

    <h3>Achievements <span class="count">${count(achievements)}</span></h3>
    ${achievements.map(card).join('')}`;
}

/** Called once a second by the Missions tab. */
export function tickOrders(root) {
  for (const el of root.querySelectorAll('.js-countdown')) {
    el.textContent = formatDuration(msUntil(el.dataset.until));
  }
}
