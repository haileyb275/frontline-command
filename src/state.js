// A tiny "store": one object holding what the app currently knows, plus a way
// for UI code to be told when it changes.
//
// Important: this is only a COPY of the truth for drawing the screen. The
// real values live in the database. Changing `state.profile.money` here
// changes what you see, not what you have.

import { supabase } from './supabase.js';

export const state = {
  session: null, // Supabase login session (null = logged out)
  profile: null, // the player's row from the `profiles` table
  bases: [], // the player's rows from the `bases` table
  units: [], // the player's rows from the `units` table
  missions: [], // open and in-progress missions
  dispatches: [], // units out on (or returning from) a mission — ours, and allies' on shared missions
  alliance: null, // our alliance: { info, my_role, members, buildings, messages, log } or null
  alliances: [], // the list to browse when not in an alliance
  unread: 0, // chat messages that arrived while not looking at the chat
};

const listeners = new Set();

/** Run `fn(state)` every time the state changes. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Merge changes into the state and notify everyone who subscribed. */
export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

/** Fetch the logged-in player's profile row from the database. */
export async function loadProfile() {
  const userId = state.session?.user?.id;
  if (!userId) {
    setState({ profile: null });
    return null;
  }

  // Row-level security means this query can only ever return our own row,
  // even if someone edited the `.eq()` filter in the browser.
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  setState({ profile: data });
  return data;
}
