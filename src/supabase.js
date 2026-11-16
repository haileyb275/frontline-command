// The one shared Supabase client. Every other file imports `supabase` from
// here, so there is exactly one connection and one login session.

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Supabase errors come in a few shapes; turn any of them into one readable
 * sentence for the player.
 */
export function friendlyError(error) {
  const msg = error?.message ?? String(error);
  if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/already registered/i.test(msg)) return 'That email already has an account. Try logging in.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first (check your inbox).';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Could not reach the server. Check your connection.';
  if (/schema cache|does not exist/i.test(msg))
    return 'The database is not set up yet. Run the SQL files in the supabase/ folder.';
  return msg;
}
