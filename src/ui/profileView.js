// A player's public page: who they are, their bases and their units.
// Opened by clicking a commander's name anywhere (rankings, alliance, chat).
// It is drawn inside the Ranks tab, and the player's bases appear on the map.

import {
  categories, getBuilding, getNation, getSpecialty, getUnitType, specialtyName, veterancy, rankTitle, getObjective,
} from '../game/content.js';
import { esc, fmt } from './dom.js';

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
            <span class="row-icon ${b.zone === 'home' ? 'row-icon--home' : ''}">${esc(type?.icon ?? '?')}</span>
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
          <span class="row-icon row-icon--unit">${esc(cat.icon)}</span>
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

    <h3>Bases <span class="count">${p.bases.length}</span></h3>
    <div class="rows">${baseRows}</div>
    ${unitSections || '<h3>Units</h3><p class="muted">No units yet.</p>'}`;
}
