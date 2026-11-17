// A player's public page: who they are, their bases and their units.
// Opened by clicking a commander's name anywhere (rankings, alliance, chat).
// It is drawn inside the Ranks tab, and the player's bases appear on the map.

import {
  categories, getBuilding, getNation, getSpecialty, getUnitType, specialtyName, veterancy, rankTitle, getObjective,
} from '../game/content.js';
import { esc, fmt } from './dom.js';
import { unitIcon, buildingIcon } from './icons.js';

/** Our own record: only shown on our own page. */
function renderStats(p) {
  const s = p.stats;
  if (!s) return '';
  const life = s.life ?? {};
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    week.push({ day, missions: s.days.find((d) => d.day === day)?.missions ?? 0 });
  }
  const peak = Math.max(1, ...week.map((d) => d.missions));
  const bars = week.map((d) => `
    <span class="bar" title="${d.day}: ${d.missions}">
      <span class="bar-fill" style="height: ${Math.round((d.missions / peak) * 100)}%"></span>
      <span class="bar-label">${new Date(d.day + 'T12:00:00Z').toLocaleDateString([], { weekday: 'narrow' })}</span>
    </span>`).join('');
  const byCat = categories
    .map((c) => [c.name, life[`missions_cat_${c.id}`] ?? 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const vets = p.units.filter((u) => veterancy(u.missions_done).tier > 0).length;
  return `
    <h3>Your record <span class="count">private</span></h3>
    <div class="facts">
      <div><span>Missions</span>${fmt(life.missions ?? 0)}</div>
      <div><span>Hard missions</span>${fmt(life.missions_hard ?? 0)}</div>
      <div><span>At sea</span>${fmt(life.missions_water ?? 0)}</div>
      <div><span>With the alliance</span>${fmt(life.missions_shared ?? 0)}</div>
      <div><span>Units sent out</span>${fmt(life.units_sent ?? 0)}</div>
      <div><span>Veteran units</span>${vets} of ${p.units.length}</div>
      <div><span>Battle honours</span>${s.honours}</div>
      <div><span>Earned from missions</span>${fmt(s.earned.money)} funds</div>
    </div>
    <h3>Missions, last 7 days</h3>
    <div class="bars">${bars}</div>
    ${s.top_missions.length ? `<h3>Most often fought</h3>${s.top_missions.map((m) => `
      <div class="log-line"><span>${esc(m.name)}</span><span>${fmt(m.times)} × · ${fmt(m.money)} funds</span></div>`).join('')}` : ''}
    ${byCat.length ? `<h3>Missions by arm</h3>${byCat.map(([name, n]) => `
      <div class="log-line"><span>${esc(name)}</span><span>${fmt(n)}</span></div>`).join('')}` : ''}`;
}

export function renderProfile(state) {
  const p = state.viewedProfile;
  if (!p) return '<p class="muted">Loading profile…</p>';

  const nation = getNation(p.nation_id);
  const isMe = p.id === state.profile?.id;
  const online = Date.now() - new Date(p.last_seen_at).getTime() < 60000;
  const baseName = new Map(p.bases.map((b) => [b.id, b.name]));

  const baseRows = p.bases.length
    ? p.bases.map((b) => {
        const type = getBuilding(b.building_type);
        return `
          <button class="row" data-action="profile-focus" data-lat="${b.lat}" data-lng="${b.lng}">
            <span class="row-icon ${b.zone === 'home' ? 'row-icon--home' : ''}">${buildingIcon(type ?? b.building_type)}</span>
            <span class="row-main">
              <span class="row-title">${esc(b.name)}</span>
              <span class="row-sub">${esc(type?.name ?? b.building_type)} · level ${b.level} · ${b.zone === 'home' ? 'home front' : 'front line'}</span>
            </span>
            <span class="row-side">${b.units} unit${b.units === 1 ? '' : 's'}</span>
          </button>`;
      }).join('')
    : '<p class="muted">No bases yet.</p>';

  // Units grouped by category, with a count for each type.
  const unitSections = categories.map((cat) => {
    const mine = p.units.filter((u) => getUnitType(u.unit_type)?.category_id === cat.id);
    if (mine.length === 0) return '';
    const rows = mine.map((u) => {
      const ut = getUnitType(u.unit_type);
      const spec = getSpecialty(u.specialty);
      const vet = veterancy(u.missions_done);
      return `
        <div class="row row--static">
          <span class="row-icon row-icon--unit">${unitIcon(u.unit_type)}</span>
          <span class="row-main">
            <span class="row-title">${esc(u.name || ut?.name || u.unit_type)}</span>
            <span class="row-sub">${esc(baseName.get(u.base_id) ?? '')}
              ${vet.tier > 0 ? `<span class="vet">${'★'.repeat(vet.tier)} ${vet.name}</span>` : ''}
              ${spec ? `<span class="tag tag--spec">${esc(specialtyName(spec, p.nation_id))}</span>` : ''}</span>
          </span>
        </div>`;
    }).join('');
    return `<h3>${esc(cat.name)} <span class="count">${mine.length}</span></h3><div class="rows">${rows}</div>`;
  }).join('');

  return `
    <div class="section-head">
      <h2>${nation ? `<span class="nation-chip nation-chip--sm" style="--nation: ${esc(nation.color)}">${esc(nation.short)}</span> ` : ''}${esc(p.username)}</h2>
      <button class="btn btn--small" data-action="profile-close">Back</button>
    </div>
    <p class="muted">${online ? '<span class="dot dot--ok"></span> Online · ' : ''}${esc(nation?.name ?? '')}
      ${p.alliance ? ` · <span class="tag">${esc(p.alliance.tag)}</span> ${esc(p.alliance.name)} (${esc(p.alliance.role)})` : ' · no alliance'}</p>

    <div class="facts">
      <div><span>Rank</span>${esc(rankTitle(p.level))}</div>
      <div><span>Standing</span>#${p.rank}</div>
      <div><span>Level</span>${p.level} · ${fmt(p.xp)} XP</div>
      <div><span>Missions completed</span>${fmt(p.missions_completed)}</div>
      <div><span>Bases / units</span>${p.bases.length} / ${p.units.length}</div>
      <div><span>Equipment year</span>${p.research_year ?? 1939}</div>
      <div><span>Enlisted</span>${new Date(p.joined_at).toLocaleDateString()}</div>
    </div>

    <div class="btn-row btn--spaced">
      <button class="btn" data-action="profile-show-map" ${p.bases.length ? '' : 'disabled'}>Show bases on map</button>
      ${isMe ? '' : '<button class="btn" data-action="profile-report">Report</button>'}
    </div>
    ${state.profile?.is_admin ? `<button class="btn btn--block btn--spaced" data-action="admin-open" data-player="${esc(p.id)}">Manage in admin panel</button>` : ''}

    <h3>Honours <span class="count">${(p.honours ?? []).length}</span></h3>
    ${(p.honours ?? []).length
      ? `<div class="chips">${p.honours.map((id) => getObjective(id)).filter(Boolean).map((o) =>
          `<span class="chip chip--honour" title="${esc(o.description)}">${o.kind === 'campaign' ? '★' : '●'} ${esc(o.name)}</span>`).join('')}</div>`
      : '<p class="muted">None yet.</p>'}
    ${(p.season_awards ?? []).length
      ? `<div class="chips">${p.season_awards.map((a) =>
          `<span class="chip chip--honour">🏅 ${esc(a.season)}: #${a.position}</span>`).join('')}</div>` : ''}

    ${(p.battle_honours ?? []).length
      ? `<div class="chips">${p.battle_honours.map((b) =>
          `<span class="chip chip--honour" title="${esc(b.place)}">⚔ ${esc(b.honour)}</span>`).join('')}</div>` : ''}
    ${isMe ? renderStats(p) : ''}

    <h3>Bases <span class="count">${p.bases.length}</span></h3>
    <div class="rows">${baseRows}</div>
    ${unitSections || '<h3>Units</h3><p class="muted">No units yet.</p>'}`;
}
