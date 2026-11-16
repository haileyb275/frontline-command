// Small helpers shared by the UI files.

/**
 * Escape text before putting it into innerHTML. ALWAYS use this for anything
 * a player typed (usernames, chat, alliance names) — otherwise someone could
 * name themselves "<script>…" and run code in other players' browsers.
 */
export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

/** Format a number with thousands separators: 20000 → "20,000". */
export function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/**
 * Show a full-screen overlay containing `html`, replacing any overlay that
 * is already open. Returns the overlay element.
 */
export function showOverlay(html) {
  hideOverlay();
  const el = document.createElement('div');
  el.id = 'overlay';
  el.className = 'overlay';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

export function hideOverlay() {
  document.getElementById('overlay')?.remove();
}
