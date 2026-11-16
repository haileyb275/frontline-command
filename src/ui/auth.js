// The log in / sign up screen.

import { supabase, friendlyError } from '../supabase.js';
import { showOverlay } from './dom.js';

const USERNAME_RULE = /^[A-Za-z0-9_]{3,20}$/;

/** Show the auth overlay. `mode` is 'login' or 'signup'. */
export function showAuthScreen(mode = 'login') {
  const isSignup = mode === 'signup';

  const overlay = showOverlay(`
    <form class="dialog" id="auth-form" novalidate>
      <div class="dialog-head">
        <span class="brand-star" aria-hidden="true">★</span>
        <h1>Frontline Command</h1>
        <p>${isSignup ? 'Enlist to take command.' : 'Report for duty, Commander.'}</p>
      </div>

      <div class="seg" role="tablist">
        <button type="button" class="seg-btn ${isSignup ? '' : 'is-active'}" data-mode="login">Log in</button>
        <button type="button" class="seg-btn ${isSignup ? 'is-active' : ''}" data-mode="signup">Sign up</button>
      </div>

      ${
        isSignup
          ? `<label class="field">
               <span>Commander name</span>
               <input name="username" type="text" autocomplete="username" maxlength="20"
                      placeholder="3–20 letters, numbers or _" required />
             </label>`
          : ''
      }
      <label class="field">
        <span>Email</span>
        <input name="email" type="email" autocomplete="email" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input name="password" type="password" minlength="6"
               autocomplete="${isSignup ? 'new-password' : 'current-password'}"
               placeholder="${isSignup ? 'At least 6 characters' : ''}" required />
      </label>

      <p class="form-msg" id="auth-msg" role="alert"></p>

      <button class="btn btn--primary" type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
    </form>
  `);

  const form = overlay.querySelector('#auth-form');
  const msg = overlay.querySelector('#auth-msg');
  const submit = form.querySelector('button[type="submit"]');

  const setMsg = (text, kind = 'error') => {
    msg.textContent = text;
    msg.dataset.kind = kind;
  };

  // Switch between the Log in / Sign up tabs by re-drawing the screen.
  for (const btn of overlay.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => showAuthScreen(btn.dataset.mode));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); // stop the browser reloading the page
    const values = Object.fromEntries(new FormData(form));
    const email = values.email.trim();
    const password = values.password;
    const username = (values.username ?? '').trim();

    // Quick checks in the browser are only for friendly messages — the
    // server checks everything again (see handle_new_user in the SQL).
    if (isSignup && !USERNAME_RULE.test(username)) {
      return setMsg('Commander name must be 3–20 letters, numbers or underscores.');
    }
    if (!email.includes('@')) return setMsg('Please enter a valid email address.');
    if (password.length < 6) return setMsg('Password must be at least 6 characters.');

    submit.disabled = true;
    setMsg(isSignup ? 'Creating account…' : 'Logging in…', 'info');

    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Stored on the account; the database trigger reads it to
            // create the profile row.
            data: { username },
            // Where the "confirm your email" link sends the player back to.
            emailRedirectTo: window.location.origin + window.location.pathname,
          },
        });
        if (error) throw error;

        // If the project requires email confirmation there is no session
        // yet. (If it doesn't, onAuthStateChange in main.js takes over.)
        if (!data.session) {
          setMsg('Account created. Check your email for a confirmation link, then log in.', 'ok');
          form.reset();
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // Success: main.js notices the new session and moves on.
      }
    } catch (error) {
      setMsg(friendlyError(error));
    } finally {
      submit.disabled = false;
    }
  });

  form.querySelector('input')?.focus();
}
