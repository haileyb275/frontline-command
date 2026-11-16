// Small pop-up messages in the corner ("Barracks built", "Not enough funds").

let holder;

/** @param {string} text  @param {'ok'|'error'|'info'} kind */
export function toast(text, kind = 'info') {
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'toasts';
    holder.setAttribute('aria-live', 'polite'); // screen readers announce it
    document.body.appendChild(holder);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = text; // textContent, so messages can never inject HTML
  holder.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
