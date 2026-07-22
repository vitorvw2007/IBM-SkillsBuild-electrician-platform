/**
 * AUTH (js-auth.js)
 * ----------------------------------------------------------------------------
 * Owns the Supabase client, the login/signup screen, and the session lifecycle.
 * Gates the app shell behind an authenticated session: shows #authScreen until
 * Supabase confirms a session, then reveals .app-shell and hands off to
 * js-app.js via window.App.onSignedIn(user) / window.App.onSignedOut().
 *
 * Password reset: clicking a reset-email link gives Supabase a "recovery"
 * session, which would otherwise just log the person in without ever letting
 * them pick a new password. inRecoveryFlow latches on PASSWORD_RECOVERY and
 * keeps #resetScreen up (even through any subsequent SIGNED_IN event for that
 * same session) until handleResetSubmit actually sets a new password.
 *
 * Depends on supabase-config.js (SUPABASE_URL / SUPABASE_ANON_KEY) and the
 * Supabase JS CDN bundle, both loaded before this file in index.html.
 */
const Auth = (function () {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Supabase is not configured. Fill in SUPABASE_URL and SUPABASE_ANON_KEY in supabase-config.js.');
  }
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let mode = 'login'; // 'login' | 'signup'
  let inRecoveryFlow = false;
  let recoveryUser = null;

  function el(id) { return document.getElementById(id); }

  function hideAllScreens() {
    el('authScreen').classList.add('hidden');
    el('resetScreen').classList.add('hidden');
    document.querySelector('.app-shell').classList.add('hidden');
  }

  function showAuthScreen() {
    hideAllScreens();
    el('authScreen').classList.remove('hidden');
  }

  function showResetScreen() {
    hideAllScreens();
    el('resetScreen').classList.remove('hidden');
  }

  function showApp(user) {
    hideAllScreens();
    document.querySelector('.app-shell').classList.remove('hidden');
    el('accountEmail').textContent = user.email || '';
  }

  function setMessage(text, isError) {
    const box = el('authMessage');
    box.textContent = text || '';
    box.classList.toggle('auth-error', !!isError);
    box.classList.toggle('hidden', !text);
  }

  function setResetMessage(text, isError) {
    const box = el('resetMessage');
    box.textContent = text || '';
    box.classList.toggle('auth-error', !!isError);
    box.classList.toggle('hidden', !text);
  }

  function setMode(next) {
    mode = next;
    el('authSubmitBtn').textContent = mode === 'signup' ? 'Create account' : 'Log in';
    el('authTitle').textContent = mode === 'signup' ? 'Create your account' : 'Log in';
    el('authToggleText').textContent = mode === 'signup' ? 'Already have an account?' : "Don't have an account?";
    el('authToggleBtn').textContent = mode === 'signup' ? 'Log in' : 'Sign up';
    el('authForgotBtn').classList.toggle('hidden', mode === 'signup');
    setMessage('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const email = el('authEmail').value.trim();
    const password = el('authPassword').value;
    if (!email || !password) {
      setMessage('Enter an email and password.', true);
      return;
    }
    if (password.length < 6) {
      setMessage('Password must be at least 6 characters.', true);
      return;
    }

    el('authSubmitBtn').disabled = true;
    setMessage('');
    try {
      if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setMessage('Account created. Check your email to confirm it, then log in.', false);
          setMode('login');
        }
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setMessage(err.message || 'Something went wrong. Try again.', true);
    } finally {
      el('authSubmitBtn').disabled = false;
    }
  }

  async function handleForgotPassword() {
    const email = el('authEmail').value.trim();
    if (!email) {
      setMessage('Enter your email above first, then click "Forgot password".', true);
      return;
    }
    try {
      const { error } = await client.auth.resetPasswordForEmail(email);
      if (error) throw error;
      setMessage('Password reset email sent, check your inbox.', false);
    } catch (err) {
      setMessage(err.message || 'Could not send reset email.', true);
    }
  }

  async function handleResetSubmit(e) {
    e.preventDefault();
    const pw = el('resetPassword').value;
    const pw2 = el('resetPasswordConfirm').value;
    if (!pw || pw.length < 6) {
      setResetMessage('Password must be at least 6 characters.', true);
      return;
    }
    if (pw !== pw2) {
      setResetMessage('Passwords do not match.', true);
      return;
    }

    el('resetSubmitBtn').disabled = true;
    setResetMessage('');
    try {
      const { data, error } = await client.auth.updateUser({ password: pw });
      if (error) throw error;
      const user = (data && data.user) || recoveryUser;
      inRecoveryFlow = false;
      recoveryUser = null;
      if (user) {
        showApp(user);
        if (window.App && typeof window.App.onSignedIn === 'function') {
          window.App.onSignedIn(user);
        }
      } else {
        showAuthScreen();
      }
    } catch (err) {
      setResetMessage(err.message || 'Could not update password. Try again.', true);
    } finally {
      el('resetSubmitBtn').disabled = false;
    }
  }

  async function logout() {
    await client.auth.signOut();
  }

  function wireDom() {
    el('authForm').addEventListener('submit', handleSubmit);
    el('authToggleBtn').addEventListener('click', () => setMode(mode === 'signup' ? 'login' : 'signup'));
    el('authForgotBtn').addEventListener('click', handleForgotPassword);
    el('logoutBtn').addEventListener('click', logout);
    el('resetForm').addEventListener('submit', handleResetSubmit);
    setMode('login');
  }

  document.addEventListener('DOMContentLoaded', wireDom);

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      inRecoveryFlow = true;
      recoveryUser = session && session.user;
      showResetScreen();
      return;
    }
    // A recovery session can also surface as a plain SIGNED_IN event; keep the
    // reset screen up until the user actually submits a new password.
    if (inRecoveryFlow) return;

    if (session && session.user) {
      showApp(session.user);
      if (window.App && typeof window.App.onSignedIn === 'function') {
        window.App.onSignedIn(session.user);
      }
    } else {
      showAuthScreen();
      if (window.App && typeof window.App.onSignedOut === 'function') {
        window.App.onSignedOut();
      }
    }
  });

  return { client };
})();

//Made with Bob