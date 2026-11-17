// Translations.
//
// The game is written in English. A language file (src/data/lang/xx.json)
// maps an English label to its translation, and this module swaps the labels
// it recognises as they appear on the page. Text it does not recognise stays
// in English, so a language can be added a few labels at a time.
//
// To add a language: copy de.json to xx.json, translate the right-hand
// sides, and add it to LANGUAGES below.

import de from './data/lang/de.json' with { type: 'json' };

export const LANGUAGES = { en: { name: 'English', words: null }, de: { name: 'Deutsch', words: de } };
const KEY = 'fc.language';

export function getLanguage() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGUAGES[saved]) return saved;
  } catch { /* private mode */ }
  return 'en'; // translations are still partial, so a language is something you choose (Help → Settings)
}

export function setLanguage(code) {
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  window.location.reload(); // simplest way to redraw everything in the new language
}

// Never touch text that players typed.
const SKIP = '.chat-body, .chat-meta, .link-btn--name, input, textarea, .leaflet-tooltip, .player-name';

function translateNode(node, words) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue.trim();
    // (the "differs" check matters: writing the same text back would wake the observer for ever)
    if (text && words[text] && words[text] !== text && !node.parentElement?.closest(SKIP)) {
      node.nodeValue = node.nodeValue.replace(text, words[text]);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    const value = node.getAttribute(attr);
    if (value && words[value] && words[value] !== value) node.setAttribute(attr, words[value]);
  }
  for (const child of node.childNodes) translateNode(child, words);
}

/** Start translating the page, now and whenever it changes. Does nothing for English. */
export function initLanguage() {
  const code = getLanguage();
  document.documentElement.lang = code;
  const words = LANGUAGES[code].words;
  if (!words) return;
  translateNode(document.body, words);
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'characterData') translateNode(change.target, words);
      for (const node of change.addedNodes) translateNode(node, words);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
