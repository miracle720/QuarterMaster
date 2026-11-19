'use strict';
// Worker sign-in with Google.
//   * Nothing loads until the phone is signed in: either a worker (Google, linked by e-mail) or an admin.
//   * The database rules match the verified Google e-mail to the e-mail an admin saved on an EXISTING
//     worker record (the admin-kept index <wh>/workerByEmail). Nothing here can create a worker, so all
//     history stays on the same worker id. There is no server code (works on the free Firebase plan).
//   * A worker's phone only ever shows and writes that one worker's records.
let currentWorker = null;          // { key, id, name, warehouse, warehouses[] } while a worker is signed in
let authBooted = false, dataStarted = false, claimBusy = false;
const gateEl = id => document.getElementById(id);

function isGoogleUser(u) { return !!u && (u.providerData || []).some(p => p.providerId === 'google.com'); }
function gateShow(state, msg, email) {
  const g = gateEl('worker-gate'); if (!g) return;
  g.classList.remove('hidden');
  gateEl('wg-busy').style.display = state === 'busy' ? 'flex' : 'none';
  gateEl('wg-signin').style.display = state === 'signin' ? 'block' : 'none'; if (state === 'signin') { gateWebviewHint(); gateBuildLine(); }
  gateEl('wg-problem').style.display = state === 'problem' ? 'block' : 'none';
  gateEl('wg-busy-msg').textContent = msg || 'Signing you in…';
  gateEl('wg-problem-msg').textContent = msg || '';
  gateEl('wg-problem-email').textContent = email || '';
  const ld = gateEl('loading-screen'); if (ld) ld.classList.add('hidden');
}
// Handheld scanners / in-app browsers (WebViews) cannot use Google sign-in: Google refuses them.
function inAppBrowser() { const ua = navigator.userAgent || ''; return /; wv\)|\bwv\b|FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\//.test(ua) || (/Android/.test(ua) && /Version\/[\d.]+/.test(ua) && !/Chrome\/[\d.]+ /.test(ua)); }
function gateWebviewHint() {
  const box = gateEl('wg-signin'); if (!box || gateEl('wg-webview-hint')) return;
  if (!inAppBrowser()) return;
  const d = document.createElement('div'); d.id = 'wg-webview-hint'; d.style.cssText = 'margin-top:12px;font-size:12.5px;color:var(--amber-text,#b45309)';
  d.textContent = 'This looks like a scanner / in-app browser. Google blocks sign-in there. Open this same web address in Chrome (or use a phone or laptop browser) to sign in.';
  box.appendChild(d);
}
// Shows which build this phone is really running, with a one-tap "force update" that clears the saved copy.
const APP_BUILD = 'v12 · 19 Nov 2026';
async function forceFreshApp() {
  try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } catch (e) { }
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) { }
  location.reload();
}
function gateBuildLine() {
  const box = gateEl('wg-signin'); if (!box || gateEl('wg-build')) return;
  const d = document.createElement('div'); d.id = 'wg-build'; d.style.cssText = 'margin-top:14px;font-size:11.5px;color:var(--text-3,#888)';
  d.innerHTML = 'App version ' + APP_BUILD + ' · <a href="#" id="wg-force" style="color:inherit;text-decoration:underline">Not the latest? Force update</a>';
  box.appendChild(d); const a = gateEl('wg-force'); if (a) a.onclick = function (ev) { ev.preventDefault(); forceFreshApp(); };
}
function gateHide() { const g = gateEl('worker-gate'); if (g) g.classList.add('hidden'); }

// Called from app.js once Firebase is initialised.
function workerAuthStart(onReady) {
  if (authBooted) return; authBooted = true;
  workerAuthStart.onReady = onReady;
  gateShow('busy', 'Checking sign-in…');
  firebase.auth().getRedirectResult().catch(function (e) { gateShow('signin'); gateErr(e); });
  let first = true;
  firebase.auth().onAuthStateChanged(function (u) {
    if (!first) return; first = false;               // later changes are driven by our own code
    if (isGoogleUser(u)) { runClaim(u); return; }
    // Anonymous (old app) or admin e-mail/password sessions are not restored: admins sign in again, as before.
    if (u) { firebase.auth().signOut().catch(function () { }); }
    gateShow('signin');
  });
}
function gateErr(e) {
  const code = (e && e.code) || '';
  const el = gateEl('wg-error'); if (!el) return;
  const m = code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' ? '' :
    code === 'auth/network-request-failed' ? 'No connection — check your internet and try again.' :
    code === 'auth/unauthorized-domain' ? 'This site is not authorised for Google sign-in yet. Tell your admin.' :
    code === 'auth/internal-error' || code === 'auth/web-storage-unsupported' ? 'This browser cannot sign in with Google (scanner or in-app browser). Open this address in Chrome and try again.' :
    code === 'auth/operation-not-allowed' ? 'Google sign-in is not switched on yet. Tell your admin.' :
    (e && e.message) || 'Sign-in failed. Try again.';
  el.textContent = m; el.style.display = m ? 'block' : 'none';
}
async function workerGoogleSignIn() {
  if (claimBusy) return;
  gateErr(null); const el = gateEl('wg-error'); if (el) el.style.display = 'none';
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    gateShow('busy', 'Opening Google…');
    const cred = await firebase.auth().signInWithPopup(provider);
    await runClaim(cred.user);
  } catch (e) {
    const code = (e && e.code) || '';
    // Installed PWAs / some phones block popups: fall back to a full-page redirect.
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/web-storage-unsupported') {
      try { await firebase.auth().signInWithRedirect(provider); return; } catch (e2) { e = e2; }
    }
    gateShow('signin'); gateErr(e);
  }
}
function claimMessage(e) {
  const code = (e && (e.code || '')).replace('functions/', '');
  if (code === 'not-found') return (e.message && e.message !== 'not-found' ? e.message : "Your e-mail isn't on a worker profile yet. Ask your supervisor to add this e-mail to your name, then sign in again.");
  if (code === 'failed-precondition') return (e.message || 'Your account needs attention from an admin.');
  if (code === 'permission-denied') return (e.message || 'This Google account cannot be used for check-in.');
  if (code === 'PERMISSION_DENIED' || /permission/i.test(String(e && e.message))) return 'This Google account is not linked to a worker. Ask your supervisor to add this exact e-mail to your name, then sign in again.';
  if (code === 'unavailable' || code === 'internal' || code === 'deadline-exceeded' || code === 'network-error') return 'Could not reach the server. Check your internet and try again.';
  return e && e.message ? e.message : 'Sign-in failed.';
}
const claimErr = (code, message) => Object.assign(new Error(message), { code });
// The e-mail as a database key: lower-case, '.' stored as ','.
const emailKeyOf = em => String(em || '').trim().toLowerCase().replace(/\./g, ',');
// Link this Google account to its worker. The admin-kept index <wh>/workerByEmail/<e-mail> says which
// worker the e-mail belongs to; the database rules only accept the link when it matches that index.
async function claimFor(user, warehouse) {
  const email = user && user.email;
  if (!email || user.emailVerified === false) throw claimErr('permission-denied', 'Sign in with a verified Google account');
  const ek = emailKeyOf(email), hits = [];
  for (const wh of Object.keys(WAREHOUSE_LOCATIONS)) {
    try { const s = await firebase.database().ref(wh + '/workerByEmail/' + ek).once('value'); const v = s.exists() ? s.val() : null; if (v && v.key) hits.push({ wh, e: v }); }
    catch (x) { /* not readable or not there = not registered at that warehouse */ }
  }
  if (!hits.length) throw claimErr('not-found', 'This Google account (' + email + ') is not registered for any worker. Ask your admin to add this exact e-mail to your worker profile.');
  let pick = warehouse ? hits.find(h => h.wh === warehouse) : null;
  if (warehouse && !pick) throw claimErr('permission-denied', 'You are not registered at ' + warehouse);
  if (!pick) pick = hits.find(h => h.e.home === h.wh) || hits[0];
  const e = pick.e, upd = {};
  upd['workerLink/' + user.uid] = { key: e.key, id: e.id, idS: e.idS };
  upd['workerAuth/' + e.key] = { uid: user.uid, email: String(email).toLowerCase(), at: firebase.database.ServerValue.TIMESTAMP };
  await firebase.database().ref(pick.wh).update(upd);
  currentWorker = { key: e.key, id: Number(e.id), name: e.name || '', warehouse: pick.wh, warehouses: hits.map(h => h.wh) };
  return currentWorker;
}
async function runClaim(user) {
  if (claimBusy) return; claimBusy = true;
  gateShow('busy', 'Signing you in…');
  try {
    let wanted = null; try { wanted = localStorage.getItem(DEVICE_WAREHOUSE_KEY); } catch (e) { }
    if (wanted && !WAREHOUSE_LOCATIONS[wanted]) wanted = null;
    let r;
    try { r = await claimFor(user, wanted); }
    catch (e) {
      // This phone was locked to a warehouse the worker isn't registered at: retry with their own.
      if (wanted && ((e && e.code) || '').indexOf('permission-denied') >= 0) { r = await claimFor(user, null); try { localStorage.removeItem(DEVICE_WAREHOUSE_KEY); } catch (e2) { } }
      else throw e;
    }
    onWorkerReady();
  } catch (e) {
    currentWorker = null;
    gateShow('problem', claimMessage(e), user && user.email);
  } finally { claimBusy = false; }
}
function onWorkerReady() {
  gateHide();
  const pill = gateEl('worker-pill');
  if (pill) { pill.style.display = 'flex'; pill.textContent = '👤 ' + (currentWorker.name || 'Me') + ' ▾'; }
  const lb = gateEl('login-btn'); if (lb) lb.style.display = 'none';
  startData();
}
function startData() {
  if (dataStarted) { if (typeof renderCheckin === 'function') renderCheckin(); return; }
  dataStarted = true;
  const ld = gateEl('loading-screen'); if (ld) ld.classList.remove('hidden');
  if (typeof workerAuthStart.onReady === 'function') workerAuthStart.onReady();
}
// A worker travelling to the other site: ask the server for claims for that warehouse.
// Resolves true when the phone may load that warehouse's data.
async function workerEnsureWarehouse(wh) {
  if (!currentWorker || currentAdmin) return true;
  if (currentWorker.warehouse === wh) return true;
  try { await claimFor(firebase.auth().currentUser, wh); return true; }
  catch (e) {
    // Not registered at that site: stay on the worker's own warehouse instead of dead-ending them.
    if (((e && e.code) || '').indexOf('permission-denied') >= 0) { try { localStorage.setItem(DEVICE_WAREHOUSE_KEY, currentWorker.warehouse); } catch (x) { } showToast('You are registered at ' + currentWorker.warehouse + ', not ' + wh); setDeviceWarehouse(currentWorker.warehouse); return false; }
    gateShow('problem', claimMessage(e), firebase.auth().currentUser && firebase.auth().currentUser.email); return false;
  }
}
// The phone lost access (an admin revoked the link, removed the worker, or changed the e-mail).
let lockedOutBusy = false;
async function workerLockedOut(err) {
  if (!currentWorker || currentAdmin || lockedOutBusy) return;
  if (!err || (err.code !== 'PERMISSION_DENIED' && !/permission/i.test(String(err.message || '')))) return;
  lockedOutBusy = true;
  const u = firebase.auth().currentUser, mail = u && u.email;
  await showWorkerGate();
  gateShow('problem', 'Your access was changed or removed by an admin. If this is a mistake, ask your supervisor, then sign in again.', mail);
  lockedOutBusy = false;
}
// Worker-name drop-downs: a signed-in worker can only choose themselves (preselected).
function nameOpts(placeholder) {
  const list = visibleWorkers(workers), own = !!(currentWorker && !currentAdmin);
  return '<option value="">— ' + placeholder + ' —</option>' + list.map(w => '<option value="' + String(w.name).replace(/"/g, '&quot;') + '"' + (own && list.length === 1 ? ' selected' : '') + '>' + w.name + '</option>').join('');
}
// Back to the sign-in screen (worker sign-out, admin sign-out, or an account problem).
async function showWorkerGate() {
  try { activeListeners.forEach(r => r.off()); } catch (e) { } activeListeners = [];
  try { if (typeof detachAdminListeners === 'function') detachAdminListeners(); } catch (e) { }
  workers = []; checkins = []; production = []; orders = []; scannerLogs = []; reports = []; messages = []; batchReports = []; expiryReports = [];
  dataStarted = false; currentWorker = null; try { loadedOnce = false; loadedAsAdmin = false; } catch (e) { }
  const pill = gateEl('worker-pill'); if (pill) pill.style.display = 'none';
  const lb = gateEl('login-btn'); if (lb) lb.style.display = 'flex';
  try { await firebase.auth().signOut(); } catch (e) { }
  gateShow('signin');
}
async function handleWorkerPill() {
  if (!confirm('Sign out' + (currentWorker ? ' (' + currentWorker.name + ')' : '') + '?')) return;
  // Drop this phone's alert token while still signed in, so the next person on it doesn't get this worker's alerts.
  try { if (typeof pushReg === 'function' && pushReg() && typeof disablePush === 'function') await disablePush(); } catch (e) { }
  showWorkerGate();
}
// Admin signed in from the sign-in screen (or from a worker phone): hand over to the admin session.
function workerAuthAfterAdmin() {
  currentWorker = null;
  const pill = gateEl('worker-pill'); if (pill) pill.style.display = 'none';
  gateHide();
  startData();
}
// The worker card list shows only the signed-in worker.
function visibleWorkers(list) { return (currentWorker && !currentAdmin) ? list.filter(w => sameId(w.id, currentWorker.id)) : list; }

// "Try again" on the problem screen (e.g. after the admin saved the e-mail, or the network came back).
function workerRetry() { const u = firebase.auth().currentUser; if (isGoogleUser(u)) runClaim(u); else gateShow('signin'); }
