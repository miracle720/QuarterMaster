'use strict';
// Admin screens for worker Google sign-in: the e-mail saved on each EXISTING worker, whether that
// worker has signed in yet, revoking a phone, and a bulk "paste names + e-mails" import that only
// ever ATTACHES an e-mail to a worker already on the list (it never creates workers).
// Data (all admin-only except where a worker's own phone writes its own link):
//   <wh>/workerEmails/<workerKey>  = {email}                      what the admin typed
//   <wh>/workerByEmail/<e-mail>    = {key,id,idS,name,home}       index the database rules use to link a phone
//   <wh>/workerLink/<uid>          = {key,id,idS}                 written by the worker's own phone at sign-in
//   <wh>/workerAuth/<workerKey>    = {uid,email,at}               "has signed in" marker (and where the uid is found)
// weSync() keeps the index and links in step with the worker list (renamed/re-numbered/removed workers).
let wEmails = {}, wLinks = {}, wEmailsReady = false, bulkRows = [], wIndex = {}, wIndexReady = false, wLinkNodes = {}, wLinkNodesReady = false, weSyncTimer = null;
const weEk = em => String(em || '').trim().toLowerCase().replace(/\./g, ',');
const weBadKey = em => /[#$\[\]\/]/.test(String(em || ''));
const weEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Same rule as server/functions/lib/email.js (Gmail ignores dots and +tags).
function weNorm(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase(), at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  let local = s.slice(0, at), domain = s.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || /\s/.test(local)) return '';
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local ? local + '@' + domain : '';
}
function workerEmailsAttach() {              // called from attachAdminListeners
  wEmails = {}; wLinks = {}; wEmailsReady = false;
  wIndex = {}; wIndexReady = false; wLinkNodes = {}; wLinkNodesReady = false;
  const eRef = wref('workerEmails'), aRef = wref('workerAuth'), iRef = wref('workerByEmail'), lRef = wref('workerLink');
  adminListeners.push(eRef, aRef, iRef, lRef);
  iRef.on('value', s => { wIndex = {}; s.forEach(c => { wIndex[c.key] = c.val() || {}; }); wIndexReady = true; weSyncSoon(); }, () => { });
  lRef.on('value', s => { wLinkNodes = {}; s.forEach(c => { wLinkNodes[c.key] = c.val() || {}; }); wLinkNodesReady = true; weSyncSoon(); }, () => { });
  eRef.on('value', s => { wEmails = {}; s.forEach(c => { const v = c.val(); if (v && v.email) wEmails[c.key] = v.email; }); wEmailsReady = true; weRefresh(); }, () => { });
  aRef.on('value', s => { wLinks = {}; s.forEach(c => { wLinks[c.key] = c.val() || {}; }); weRefresh(); }, () => { });
}
function workerEmailsReset() { wEmails = {}; wLinks = {}; wEmailsReady = false; bulkRows = []; const p = document.getElementById('bulk-email-preview'); if (p) p.innerHTML = ''; }
function weRefresh() { try { if (typeof renderManage === 'function') renderManage(); weSummary(); } catch (e) { } weSyncSoon(); }
const weEntry = (key, ex) => { const w = workers.find(x => x.fbKey === key) || ex; return w ? { key, id: Number(w.id), idS: String(w.id), name: w.name || '', home: w.homeWarehouse || currentWarehouse } : null; };
// Bring the index and the links back in step with the worker list. Runs a moment after any change, in an
// admin session only, and only writes when something actually differs (so it settles by itself).
function weSyncSoon() { if (!currentAdmin) return; clearTimeout(weSyncTimer); weSyncTimer = setTimeout(weSync, 1500); }
function weSync() {
  if (!currentAdmin || !wEmailsReady || !wIndexReady || !wLinkNodesReady || !workers.length) return;
  const u = {}, same = (a, b) => !!a && !!b && a.key === b.key && Number(a.id) === Number(b.id) && String(a.idS) === String(b.idS) && (a.name || '') === (b.name || '') && (a.home || '') === (b.home || '');
  const wantIdx = {};
  Object.keys(wEmails).forEach(key => { const ent = weEntry(key); if (!ent || weBadKey(wEmails[key])) return; wantIdx[weEk(wEmails[key])] = ent; });
  Object.keys(wantIdx).forEach(ek => { if (!same(wIndex[ek], wantIdx[ek])) u['workerByEmail/' + ek] = wantIdx[ek]; });
  Object.keys(wIndex).forEach(ek => { if (!wantIdx[ek]) u['workerByEmail/' + ek] = null; });          // worker or e-mail gone
  Object.keys(wLinkNodes).forEach(uid => {
    const l = wLinkNodes[uid], w = workers.find(x => x.fbKey === l.key);
    const auth = wLinks[l.key];
    if (!w || !wEmails[l.key]) { u['workerLink/' + uid] = null; if (auth && auth.uid === uid) u['workerAuth/' + l.key] = null; return; }   // removed worker: lock the phone out
    if (auth && auth.uid && auth.uid !== uid) { u['workerLink/' + uid] = null; return; }                                                     // someone else now owns this worker
    if (String(l.idS) !== String(w.id) || Number(l.id) !== Number(w.id)) u['workerLink/' + uid] = { key: l.key, id: Number(w.id), idS: String(w.id) };   // worker was re-numbered
  });
  if (Object.keys(u).length) Promise.resolve(db.ref(currentWarehouse).update(u)).catch(() => { });
}
function workerLinkHtml(key) {
  if (!currentAdmin) return '';
  const e = wEmails[key];
  if (!e) return '<div class="worker-meta" style="color:var(--amber-text)">✉ No sign-in e-mail yet</div>';
  const l = wLinks[key];
  return '<div class="worker-meta">✉ ' + weEsc(e) + ' · ' + (l && l.uid ? '<span style="color:var(--green-text)">✓ has signed in</span>' : '<span style="color:var(--text2)">not signed in yet</span>') + '</div>';
}
function weSummary() {
  const el = document.getElementById('worker-email-summary'); if (!el) return;
  if (!currentAdmin) { el.textContent = ''; return; }
  const n = workers.length, withE = workers.filter(w => wEmails[w.fbKey]).length, linked = workers.filter(w => wLinks[w.fbKey] && wLinks[w.fbKey].uid).length;
  el.innerHTML = '<strong>' + withE + '</strong> of ' + n + ' workers have a sign-in e-mail · <strong>' + linked + '</strong> have signed in.';
}
// ---- one worker (Edit worker window) ----
// Returns an error message, or '' when the e-mail is fine to save for this worker.
function workerEmailCheck(key, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  const n = weNorm(v); if (!n) return 'That e-mail address does not look right';
  if (weBadKey(v)) return 'That e-mail has a character that cannot be used for sign-in (# $ [ ] /)';
  const other = Object.keys(wEmails).find(k => k !== key && weNorm(wEmails[k]) === n);
  if (other) { const w = workers.find(x => x.fbKey === other); return 'That e-mail is already saved on ' + (w ? w.name : 'another worker'); }
  return '';
}
function weUpdates(key, raw, ex) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase(), cur = wEmails[key], u = {};
  const link = wLinks[key];
  const dropLink = () => { if (link) { u['workerAuth/' + key] = null; if (link.uid) u['workerLink/' + link.uid] = null; } };
  if (!v) { if (cur) { u['workerEmails/' + key] = null; u['workerByEmail/' + weEk(cur)] = null; dropLink(); } return u; }
  const ent = weEntry(key, ex); if (!ent) return u;
  if (cur && weNorm(cur) === weNorm(v)) {                  // same mailbox, different spelling: keep the link, refresh the index
    if (cur !== v) { u['workerEmails/' + key] = { email: v }; u['workerByEmail/' + weEk(cur)] = null; u['workerByEmail/' + weEk(v)] = ent; }
    return u;
  }
  u['workerEmails/' + key] = { email: v };
  if (cur) u['workerByEmail/' + weEk(cur)] = null;
  u['workerByEmail/' + weEk(v)] = ent;
  dropLink();                                              // a different e-mail = a different person: the old sign-in stops working
  return u;
}
function workerEmailSave(key, raw, ex) {
  const u = weUpdates(key, raw, ex); if (!Object.keys(u).length) return Promise.resolve(false);
  const w = workers.find(x => x.fbKey === key);
  const p = db.ref(currentWarehouse).update(u);
  audit('worker.email', (u['workerEmails/' + key] ? 'Set sign-in e-mail for ' : 'Removed sign-in e-mail for ') + (w ? w.name : key), { type: 'worker', id: w ? w.id : null, name: w ? w.name : null });
  return Promise.resolve(p).then(() => true).catch(() => { showToast('Could not save the e-mail'); return false; });
}
function workerEmailPurge(key) {              // worker removed
  const u = {}; if (wEmails[key]) { u['workerEmails/' + key] = null; u['workerByEmail/' + weEk(wEmails[key])] = null; }
  if (wLinks[key]) { u['workerAuth/' + key] = null; if (wLinks[key].uid) u['workerLink/' + wLinks[key].uid] = null; }
  if (Object.keys(u).length) Promise.resolve(db.ref(currentWarehouse).update(u)).catch(() => { });
}
function weFillEdit(key) {
  const inp = document.getElementById('edit-worker-email'), st = document.getElementById('edit-worker-link-status'); if (!inp) return;
  inp.value = wEmails[key] || '';
  const l = wLinks[key];
  st.innerHTML = !wEmails[key] ? '<span style="color:var(--text2)">No e-mail yet — this worker cannot sign in.</span>'
    : l && l.uid ? '<span style="color:var(--green-text)">✓ Signed in on a phone</span><button class="btn danger" style="font-size:12px;padding:6px 10px" data-k="' + weEsc(key) + '" onclick="workerRevoke(this.dataset.k)"><i class="ti ti-logout"></i> Sign out their phone</button>'
    : '<span style="color:var(--text2)">E-mail saved — not signed in yet.</span>';
  st.style.display = 'flex';
}
function workerRevoke(key) {
  const w = workers.find(x => x.fbKey === key);
  if (!confirm('Sign out ' + (w ? w.name : 'this worker') + '\'s phone? They can sign in again with the same Google account.')) return;
  const up = { ['workerAuth/' + key]: null }; if (wLinks[key] && wLinks[key].uid) up['workerLink/' + wLinks[key].uid] = null;
  Promise.resolve(db.ref(currentWarehouse).update(up)).then(() => { showToast('Phone signed out'); audit('worker.revoke', 'Revoked sign-in for ' + (w ? w.name : key), { type: 'worker', id: w ? w.id : null, name: w ? w.name : null }); weFillEdit(key); }).catch(() => showToast('Could not revoke'));
}
// ---- bulk import ----
const weTokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
function weParse(text) {
  const rows = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const L = line.trim(); if (!L) return;
    const parts = L.split(/[\t,;]+/).map(x => x.trim()).filter(Boolean);
    const emailPart = parts.find(p => p.indexOf('@') > 0);
    if (!emailPart) { if (/name/i.test(L) && /mail/i.test(L)) return; rows.push({ line: L, name: L, email: '', err: 'No e-mail found on this line' }); return; }
    const name = parts.filter(p => p !== emailPart).join(' ').trim();
    rows.push({ line: L, name, email: emailPart.replace(/[<>\s]/g, '') });
  });
  return rows;
}
function weMatch(name) {
  const t = weTokens(name); if (!t.length) return { exact: [], close: [] };
  const key = a => a.slice().sort().join(' ');
  const exact = [], close = [];
  workers.forEach(w => {
    const wt = weTokens(w.name);
    if (key(wt) === key(t)) exact.push(w);
    else {
      const inter = t.filter(x => wt.some(y => y === x || (x.length >= 2 && y.startsWith(x)))).length, union = new Set(t.concat(wt)).size;
      if (t.length >= 2 && inter === t.length || union && inter / union >= 0.5) close.push({ w, score: inter / union });
    }
  });
  close.sort((a, b) => b.score - a.score);
  return { exact, close: close.map(c => c.w).slice(0, 4) };
}
function bulkEmailPreview() {
  const text = (document.getElementById('bulk-email-text') || {}).value || '';
  bulkRows = weParse(text).map(r => {
    const m = r.err ? { exact: [], close: [] } : weMatch(r.name);
    r.sel = m.exact.length === 1 ? m.exact[0].fbKey : '';
    r.options = m.exact.length ? m.exact : m.close;
    r.note = r.err || (m.exact.length === 1 ? 'Matched' : m.exact.length > 1 ? 'More than one worker has this name — choose' : m.close.length ? 'No exact match — pick the right worker or skip' : 'No worker with this name — skipped');
    return r;
  });
  weRenderBulk();
}
function weRenderBulk() {
  const el = document.getElementById('bulk-email-preview'); if (!el) return;
  if (!bulkRows.length) { el.innerHTML = ''; return; }
  const opt = (r, w) => '<option value="' + weEsc(w.fbKey) + '"' + (r.sel === w.fbKey ? ' selected' : '') + '>' + weEsc(w.name) + '</option>';
  el.innerHTML = '<div class="log-wrap"><table><thead><tr><th>Name in your list</th><th>E-mail</th><th>Worker</th><th>Result</th></tr></thead><tbody>' +
    bulkRows.map((r, i) => '<tr><td>' + weEsc(r.name) + '</td><td>' + weEsc(r.email) + '</td><td>' + (r.err ? '—' : '<select data-i="' + i + '" onchange="bulkPick(this.dataset.i,this.value)"><option value="">— skip —</option>' +
      (r.options.length ? r.options : workers).map(w => opt(r, w)).join('') + '</select>') + '</td><td id="bulk-note-' + i + '">' + weEsc(r.note) + '</td></tr>').join('') +
    '</tbody></table></div><button class="btn primary" style="margin-top:10px" onclick="bulkEmailSave()"><i class="ti ti-check"></i> Save e-mails</button>';
}
function bulkPick(i, key) { const r = bulkRows[Number(i)]; if (r) { r.sel = key; r.note = key ? 'Will be saved' : 'Skipped'; const n = document.getElementById('bulk-note-' + i); if (n) n.textContent = r.note; } }
// Final checks happen here, on what is actually selected.
function bulkEmailValidate() {
  const errs = [], ups = {}, seenKey = {}, seenMail = {};
  bulkRows.forEach(r => {
    if (r.err || !r.sel) return;
    const w = workers.find(x => x.fbKey === r.sel); if (!w) return;
    const n = weNorm(r.email);
    if (!n) { errs.push(r.name + ': "' + r.email + '" is not a valid e-mail'); return; }
    if (seenKey[r.sel]) { errs.push(w.name + ' is chosen on two lines'); return; } seenKey[r.sel] = 1;
    if (seenMail[n]) { errs.push(r.email + ' appears on two lines'); return; } seenMail[n] = 1;
    const e = workerEmailCheck(r.sel, r.email); if (e) { errs.push(w.name + ': ' + e); return; }
    Object.assign(ups, weUpdates(r.sel, r.email));
  });
  // An e-mail saved on this paste must not duplicate one that stays on a different worker.
  return { errs, ups };
}
function bulkEmailSave() {
  const { errs, ups } = bulkEmailValidate();
  if (errs.length) { alert('Nothing saved. Fix these first:\n\n' + errs.join('\n')); return; }
  const n = Object.keys(ups).filter(k => k.startsWith('workerEmails/')).length;
  if (!n) { showToast('Nothing new to save'); return; }
  Promise.resolve(db.ref(currentWarehouse).update(ups)).then(() => {
    audit('worker.email.bulk', 'Saved sign-in e-mails for ' + n + ' worker(s)', null, { count: n });
    showToast(n + ' e-mail' + (n > 1 ? 's' : '') + ' saved'); bulkRows = []; weRenderBulk(); const t = document.getElementById('bulk-email-text'); if (t) t.value = '';
  }).catch(() => showToast('Could not save — nothing was changed'));
}
