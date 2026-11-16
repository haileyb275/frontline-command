// Optional sounds and browser notifications. Both are off until the player
// switches them on in the Help & settings screen, and the choice is
// remembered in this browser only.

const KEY = 'fc.alerts';

function load() {
  try {
    return { sound: false, notify: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { sound: false, notify: false };
  }
}

const prefs = load();

export const getAlertPrefs = () => ({ ...prefs });

export function setAlertPref(name, on) {
  prefs[name] = on;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // private mode: the setting just lasts until the tab closes
  }
}

/** Ask the browser for permission to show notifications. Resolves true if granted. */
export async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

// ---- Sounds: short tones made with the Web Audio API, so there are no
// sound files to download.

let audio = null;

const TUNES = {
  mission: [[660, 0.09], [880, 0.12]], // a new report: two rising notes
  complete: [[523, 0.08], [659, 0.08], [784, 0.16]], // mission complete: a little fanfare
  warning: [[330, 0.14], [262, 0.2]], // something needs attention: falling
};

export function playSound(name) {
  if (!prefs.sound || !TUNES[name]) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    let t = audio.currentTime;
    for (const [frequency, seconds] of TUNES[name]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      // Fade each note in and out so it doesn't click.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + seconds + 0.02);
      t += seconds;
    }
  } catch {
    // Browsers block sound until the page has been clicked: ignore.
  }
}

/** Show a system notification, but only while the game's tab is in the background. */
export function notify(title, body) {
  if (!prefs.notify || !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: './favicon.svg', tag: 'frontline-command' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
