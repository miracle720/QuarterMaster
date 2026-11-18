// push.js — loaded after audit.js. Worker push notifications (FCM web push).
// A worker taps "Turn on alerts" in their Log-work window; their phone registers
// a token under <warehouse>/pushTokens/<workerId>. Cloud Functions send a push
// when an order or a putaway task is assigned to them (server/functions/index.js).
//
// SETUP: Firebase console → Project settings → Cloud Messaging → Web Push
// certificates → generate a key pair, then either paste the public key below or
// add  vapidKey: "…"  to the firebaseConfig block pasted into the app's setup screen.
const PUSH_VAPID_KEY = '';
const PUSH_REG_KEY = 'wh_push_reg_v1';

function pushVapid() {
  try { const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); return c.vapidKey || PUSH_VAPID_KEY; } catch (e) { return PUSH_VAPID_KEY; }
}
function pushSupported() {
  try { return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && !!firebase.messaging && (!firebase.messaging.isSupported || firebase.messaging.isSupported()); } catch (e) { return false; }
}
function pushHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return 't' + h.toString(36) + s.length.toString(36); }
function pushReg() { try { return JSON.parse(localStorage.getItem(PUSH_REG_KEY) || 'null'); } catch (e) { return null; } }
function pushSetReg(v) { try { if (v) localStorage.setItem(PUSH_REG_KEY, JSON.stringify(v)); else localStorage.removeItem(PUSH_REG_KEY); } catch (e) { } }
function pushIsIOSBrowserTab() { try { return /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); } catch (e) { return false; } }

async function pushGetToken() {
  const reg = await navigator.serviceWorker.ready;
  return firebase.messaging().getToken({ vapidKey: pushVapid(), serviceWorkerRegistration: reg });
}
let pushGen = 0;   // bumped by disablePush so an in-flight silent re-register cannot undo it
async function pushRegister(w, quiet) {
  const gen = pushGen;
  const token = await pushGetToken();
  if (!token) throw new Error('no token');
  if (quiet && (gen !== pushGen || !pushReg())) return;      // alerts were turned off while we were fetching the token
  const tid = pushHash(token), prev = pushReg();
  // One device = one worker: if this phone was registered for someone else, move it.
  if (prev && prev.tid === tid && (prev.wh !== currentWarehouse || String(prev.wid) !== String(w.id))) {
    try { await db.ref(prev.wh + '/pushTokens/' + prev.wid + '/' + prev.tid).remove(); } catch (e) { }
  }
  await wref('pushTokens/' + w.id + '/' + tid).set({ token, createdAt: nowDate().toISOString(), ua: String(navigator.userAgent || '').slice(0, 120) });
  if (quiet && gen !== pushGen) { try { await wref('pushTokens/' + w.id + '/' + tid).remove(); } catch (e) { } return; }
  pushSetReg({ wh: currentWarehouse, wid: String(w.id), tid });
}
async function enablePush() {
  const w = curProdWorker(); if (!w) return;
  if (!pushSupported()) { showToast('This browser does not support notifications'); return; }
  if (!pushVapid()) { showToast('Notifications are not set up yet — tell your admin'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { showToast('Notifications were not allowed'); refreshPushBanner(); return; }
    await pushRegister(w);
    showToast('Alerts on — you will be notified when work is assigned to you');
  } catch (e) { showToast('Could not turn on alerts: ' + (e && e.message || 'try again')); }
  refreshPushBanner();
}
async function disablePush() {
  pushGen++;
  const r = pushReg();
  try { if (r) await db.ref(r.wh + '/pushTokens/' + r.wid + '/' + r.tid).remove(); } catch (e) { }
  try { await firebase.messaging().deleteToken(); } catch (e) { }
  pushSetReg(null); showToast('Alerts turned off on this phone'); refreshPushBanner();
}
// Tokens rotate; quietly re-register if this phone is already set up for this worker.
async function pushEnsure() {
  const w = curProdWorker(), r = pushReg();
  if (!w || !r || !pushSupported() || !pushVapid() || Notification.permission !== 'granted') return;
  if (r.wh !== currentWarehouse || String(r.wid) !== String(w.id)) return;
  try { await pushRegister(w, true); } catch (e) { }
}
function refreshPushBanner() {
  const modal = document.getElementById('production-modal'); if (!modal) return;
  let box = document.getElementById('push-banner');
  if (!box) { const anchor = document.getElementById('production-assigned-orders'); if (!anchor) return; box = document.createElement('div'); box.id = 'push-banner'; box.style.cssText = 'margin-bottom:12px;font-size:12.5px'; anchor.parentNode.insertBefore(box, anchor); }
  const w = curProdWorker();
  if (!w || currentAdmin || !pushSupported() || !pushVapid()) { box.style.display = 'none'; return; }
  const r = pushReg(), mine = r && r.wh === currentWarehouse && String(r.wid) === String(w.id);
  box.style.display = 'block';
  if (Notification.permission === 'denied') { box.innerHTML = '<span style="color:var(--text3)">🔕 Notifications are blocked for this app in your phone settings.</span>'; return; }
  if (mine && Notification.permission === 'granted') { box.innerHTML = '<span style="color:var(--green-text)">🔔 Alerts are on for ' + ftEsc(w.name) + '</span> <a href="#" onclick="disablePush();return false" style="margin-left:6px">Turn off</a>'; return; }
  box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--bg2,#f4f4f2);border-radius:var(--radius);padding:8px 10px"><span style="flex:1;min-width:160px">🔔 Get an alert on this phone when work is assigned to you.' + (pushIsIOSBrowserTab() ? ' <span style="color:var(--text3)">On iPhone, first add this app to your Home Screen.</span>' : '') + '</span><button type="button" class="btn primary" style="padding:6px 12px" onclick="enablePush()">Turn on alerts</button></div>';
}
(function wrapPushHooks() {
  const origOpen = openProductionModal;
  openProductionModal = function () { const r = origOpen.apply(this, arguments); try { refreshPushBanner(); pushEnsure(); } catch (e) { } return r; };
})();
