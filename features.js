// features.js — loaded after app.js. Shares its global scope (workers, orders,
// wref, audit, nowDate …). Part A: putaway assignment + task timers.
// Hooks called from app.js: featuresAttach, featuresOnTab,
// featuresDecoratePacking, featuresAfterPacked.

// ---------- state ----------
let putawayTasks = [];
let packingInProgress = {};
let taskTimersCfg = { enabled: true };   // default ON until an admin switches it off
let pendingPutawayTaskId = null;

function taskTimersOn() { return taskTimersCfg.enabled !== false; }

function fmtSecs(s) {
  if (s == null || !isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function fmtClock(iso) {
  if (!iso) return '—';
  const tz = (typeof WAREHOUSE_TZ !== 'undefined' && WAREHOUSE_TZ[currentWarehouse]) || undefined;
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }); }
  catch (e) { return new Date(iso).toLocaleTimeString(); }
}
function fmtDay(iso) {
  if (!iso) return '';
  return typeof ymdInZone === 'function' ? ymdInZone(new Date(iso)) : String(iso).slice(0, 10);
}
function secsBetween(a, b) { return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)); }
function ftEsc(s) { return escHtml(s); }
function curProdWorker() { return workers.find(x => sameId(x.id, pendingProductionWorkerId)) || null; }

// ---------- listeners ----------
function featuresAttach() {
  putawayTasks = []; packingInProgress = {}; taskTimersCfg = { enabled: true };
  resetAdminCaches();
  const tL = wref('putawayTasks'); activeListeners.push(tL);
  tL.on('value', snap => {
    putawayTasks = [];
    snap.forEach(c => { const v = c.val(); if (v && typeof v === 'object') putawayTasks.push({ ...v, id: c.key }); });
    putawayTasks.sort((a, b) => (b.assignedAt || '').localeCompare(a.assignedAt || ''));
    safeRender('putaway', renderPutawayTab);
    safeRender('putaway-modal', refreshProductionTimerUI);
  });
  const pL = wref('packingInProgress'); activeListeners.push(pL);
  pL.on('value', snap => {
    packingInProgress = {};
    snap.forEach(c => { packingInProgress[c.key] = c.val(); });
    safeRender('packing-timer', refreshProductionTimerUI);
  });
  const cL = wref('config/taskTimers'); activeListeners.push(cL);
  cL.on('value', snap => {
    const v = snap.val();
    taskTimersCfg = (v && typeof v === 'object') ? v : { enabled: true };
    safeRender('putaway', renderPutawayTab);
    safeRender('timer-mode', refreshProductionTimerUI);
  });
}
function featuresOnTab(name) {
  if (name === 'putaway') { loadSkuCatalog(); renderPutawayTab(); }
}
function refreshProductionTimerUI() {
  const m = document.getElementById('production-modal');
  if (!m || m.classList.contains('hidden')) return;
  if (pendingProductionType === 'putaway') { syncPutawayUIFromFirebase(); renderPutawayAssignedList(); }
  if (pendingProductionType === 'packing') syncPackingTimerUI();
}

// ---------- admin: Putaway tab ----------
function renderPutawayTab() {
  const root = document.getElementById('putaway-admin-root');
  if (!root) return;
  // Don't wipe what an admin is typing: remember the form before re-rendering.
  const keep = {};
  ['pa-supplier', 'pa-worker', 'pa-qty', 'pa-note', 'pa-sku-search'].forEach(id => { const el = document.getElementById(id); if (el) keep[id] = el.value; });
  const focusId = document.activeElement && document.activeElement.id;

  const on = taskTimersOn();
  const canManage = adminHasPerm('putaway');
  const sevenDaysAgo = new Date(nowMs() - 7 * 86400000).toISOString();
  const recent = putawayTasks.filter(t => t.status === 'assigned' || t.status === 'started' || (t.assignedAt || '') >= sevenDaysAgo);
  const delays = recent.filter(t => t.startDelaySecs != null).map(t => t.startDelaySecs);
  const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
  const packDelays = (typeof production !== 'undefined' ? production : []).filter(p => p.taskType === 'packing' && p.startDelaySecs != null && (p.createdAt || '') >= sevenDaysAgo).map(p => p.startDelaySecs);
  const avgPack = packDelays.length ? packDelays.reduce((a, b) => a + b, 0) / packDelays.length : null;

  const sortedWorkers = workers.slice().sort((a, b) => {
    const ca = getCheckinState(a.id) ? 0 : 1, cb = getCheckinState(b.id) ? 0 : 1;
    return ca - cb || String(a.name).localeCompare(String(b.name));
  });
  const workerOpts = '<option value="">Select worker…</option>' + sortedWorkers.map(w =>
    '<option value="' + ftEsc(w.id) + '">' + ftEsc(w.name) + (getCheckinState(w.id) ? ' ✓ in' : '') + '</option>').join('');
  const supplierOpts = '<option value="">Select supplier…</option>' + SUPPLIER_LIST.map(s => '<option>' + ftEsc(s) + '</option>').join('');

  const statusChip = t => {
    const m = { assigned: ['var(--amber-bg)', 'var(--amber-text)', 'Waiting'], started: ['var(--blue-bg,#e6f1fb)', 'var(--blue-text,#0c447c)', 'In progress'], done: ['var(--green-bg)', 'var(--green-text)', 'Done'], cancelled: ['var(--bg2,#eee)', 'var(--text3)', 'Cancelled'] }[t.status] || ['var(--bg2,#eee)', 'var(--text3)', t.status];
    return '<span style="background:' + m[0] + ';color:' + m[1] + ';border-radius:20px;padding:2px 8px;font-size:11px">' + m[2] + '</span>';
  };
  const rows = recent.map(t => {
    const wait = t.status === 'assigned' && on
      ? '<span class="order-timer" data-assigned-at="' + ftEsc(t.assignedAt) + '">' + elapsedLabel(t.assignedAt) + '</span> <span style="color:var(--text3)">so far</span>'
      : (t.startDelaySecs != null ? fmtSecs(t.startDelaySecs) : '—');
    const dur = t.status === 'done' && t.durationMinutes != null ? t.durationMinutes + 'm' : '—';
    const acts = canManage
      ? (t.status === 'assigned' ? '<button class="btn" style="padding:3px 8px;font-size:12px" onclick="cancelPutawayAssignment(\'' + ftEsc(t.id) + '\')">Cancel</button> ' : '') +
        '<button class="btn danger" style="padding:3px 8px;font-size:12px" onclick="deletePutawayAssignment(\'' + ftEsc(t.id) + '\')"><i class="ti ti-trash"></i></button>'
      : '';
    return '<tr><td>' + ftEsc(t.workerName || t.workerId) + '</td><td>' + ftEsc(t.supplier) + taskItemsInline(t) + (t.note ? '<div style="color:var(--text3);font-size:11px">' + ftEsc(t.note) + '</div>' : '') + '</td>' +
      '<td>' + fmtClock(t.assignedAt) + '</td><td>' + (t.startedAt ? fmtClock(t.startedAt) : '—') + '</td><td>' + wait + '</td><td>' + dur + '</td><td>' + (t.qty != null ? t.qty : (t.expectedQty || '—')) + '</td><td>' + statusChip(t) + '</td><td>' + acts + '</td></tr>';
  }).join('');

  root.innerHTML =
    '<p class="section-title">Task timers</p>' +
    '<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500"><input type="checkbox" id="pa-timers-toggle" ' + (on ? 'checked ' : '') + (canManage ? '' : 'disabled ') + 'onchange="setTaskTimers(this.checked)"> Worker timers for putaway &amp; packing are <b>' + (on ? 'ON' : 'OFF') + '</b></label>' +
      '<span style="color:var(--text3);font-size:12px;flex:1;min-width:200px">ON: workers press Start / End, and the wait between assignment and Start is recorded. OFF: workers just log quantity — no timers, no waiting-time tracking. Existing records are kept.</span>' +
    '</div>' +
    '<div style="display:flex;gap:10px;margin:10px 0">' +
      '<div class="stat-card" style="flex:1"><div class="stat-label">Avg wait → start, putaway (7d)</div><div class="stat-value" style="font-size:18px">' + fmtSecs(avgDelay) + '</div></div>' +
      '<div class="stat-card" style="flex:1"><div class="stat-label">Avg wait → start, packing (7d)</div><div class="stat-value" style="font-size:18px">' + fmtSecs(avgPack) + '</div></div>' +
    '</div>' +
    (canManage ?
    (canManage ? skuCatalogCardHtml() : '') +
    '<p class="section-title">Assign putaway</p>' +
    '<div class="card"><div class="form-row">' +
      '<div class="form-group"><label class="form-label">Worker</label><select id="pa-worker">' + workerOpts + '</select></div>' +
      '<div class="form-group"><label class="form-label">Supplier</label><select id="pa-supplier">' + supplierOpts + '</select></div></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label">Expected qty <span style="font-weight:400">(optional)</span></label><input type="number" min="0" inputmode="numeric" id="pa-qty" placeholder="e.g. 200"></div>' +
      '<div class="form-group"><label class="form-label">Note / location <span style="font-weight:400">(optional)</span></label><input type="text" id="pa-note" maxlength="120" placeholder="e.g. Dock 2, aisle 7"></div></div>' +
      '<div class="form-group" style="margin-top:6px"><label class="form-label">SKUs to put away <span style="font-weight:400">(optional — search the catalog)</span></label>' +
        '<input type="text" id="pa-sku-search" placeholder="' + (skuCatalog.length ? 'Search ' + skuCatalog.length.toLocaleString() + ' SKUs by code or name…' : 'Type a SKU code (no catalog uploaded yet)') + '" autocomplete="off" oninput="paSkuSearch()">' +
        '<div id="pa-sku-results" style="max-height:200px;overflow-y:auto;border:0.5px solid var(--border2);border-radius:var(--radius);margin-top:6px;display:none"></div>' +
        '<div id="pa-sku-selected" style="margin-top:8px"></div></div>' +
      '<button class="btn primary" onclick="assignPutawayTask()" style="width:100%;justify-content:center;padding:10px"><i class="ti ti-send"></i> Assign putaway</button>' +
      '<p id="pa-error" style="color:var(--red-text);font-size:12px;text-align:center;display:none"></p></div>'
    : '<div class="card" style="color:var(--text3);font-size:13px">You can view putaway tasks but do not have permission to assign them.</div>') +
    '<p class="section-title" style="margin-top:14px">Tasks (open + last 7 days)</p>' +
    ((rows ? '<div class="card" style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr><th>Worker</th><th>Supplier</th><th>Assigned</th><th>Started</th><th>Wait to start</th><th>Took</th><th>Qty</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<div class="empty-state"><i class="ti ti-package-import"></i>No putaway tasks yet</div>')) +
    packingTimingHtml(sevenDaysAgo);

  ['pa-supplier', 'pa-worker', 'pa-qty', 'pa-note', 'pa-sku-search'].forEach(id => { const el = document.getElementById(id); if (el && keep[id] != null) el.value = keep[id]; });
  renderPaSelected(); paSkuSearch();
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
}

function assignPutawayTask() {
  if (!adminHasPerm('putaway')) { showToast('You do not have permission to assign putaway'); return; }
  const err = document.getElementById('pa-error');
  const wid = document.getElementById('pa-worker').value;
  const supplier = document.getElementById('pa-supplier').value;
  const qtyRaw = document.getElementById('pa-qty').value;
  const note = document.getElementById('pa-note').value.trim().slice(0, 120);
  const fail = m => { err.textContent = m; err.style.display = 'block'; };
  if (!wid) return fail('Choose a worker');
  if (!supplier) return fail('Choose a supplier');
  const w = workers.find(x => String(x.id) === String(wid));
  if (!w) return fail('Worker not found');
  const expectedQty = qtyRaw === '' ? null : parseInt(qtyRaw, 10);
  if (expectedQty != null && (!Number.isFinite(expectedQty) || expectedQty < 0)) return fail('Expected quantity must be a number');
  err.style.display = 'none';
  const t = {
    workerId: w.id, workerName: w.name, supplier, status: 'assigned',
    assignedAt: nowDate().toISOString(),
    assignedBy: (currentAdmin && currentAdmin.username) || 'admin',
    assignedByUid: (currentAdmin && currentAdmin.fbKey) || null
  };
  if (expectedQty != null) t.expectedQty = expectedQty;
  const itemKeys = Object.keys(paSelected);
  if (itemKeys.length) { t.items = {}; itemKeys.forEach(k => { const it = paSelected[k]; t.items[k] = { sku: it.sku, name: it.name || '', qty: it.qty != null ? it.qty : null }; }); }
  if (note) t.note = note;
  const ref = wref('putawayTasks').push();
  ref.set(t).then(() => {
    audit('putaway.assign', 'Putaway for ' + supplier + ' assigned to ' + w.name, { type: 'putaway', id: ref.key, name: supplier }, { worker: w.name, expectedQty, note });
    showToast('Putaway assigned to ' + w.name);
    ['pa-qty', 'pa-note', 'pa-sku-search'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    paSelected = {}; renderPaSelected(); paSkuSearch();
  }).catch(e => { showToast('Could not assign: ' + (e && e.message || 'permission denied')); });
}
function cancelPutawayAssignment(id) {
  const t = putawayTasks.find(x => x.id === id); if (!t || t.status !== 'assigned') return;
  if (!confirm('Cancel this putaway assignment for ' + t.workerName + '?')) return;
  wref('putawayTasks/' + id).update({ status: 'cancelled', cancelledAt: nowDate().toISOString() }).then(() => {
    audit('putaway.cancel', 'Putaway for ' + t.supplier + ' cancelled (' + t.workerName + ')', { type: 'putaway', id, name: t.supplier });
  });
}
function deletePutawayAssignment(id) {
  const t = putawayTasks.find(x => x.id === id); if (!t) return;
  if (!confirm('Delete this putaway record? The logged work entry (if any) stays in Analytics.')) return;
  wref('putawayTasks/' + id).remove().then(() => {
    audit('putaway.delete', 'Putaway task deleted: ' + t.supplier + ' (' + t.workerName + ', ' + t.status + ')', { type: 'putaway', id, name: t.supplier });
  });
}
function setTaskTimers(enabled) {
  if (!adminHasPerm('putaway')) { showToast('You do not have permission'); renderPutawayTab(); return; }
  wref('config/taskTimers').set({ enabled: !!enabled, updatedBy: (currentAdmin && currentAdmin.username) || 'admin', updatedAt: firebase.database.ServerValue.TIMESTAMP })
    .then(() => {
      audit('config.timers', 'Task timers switched ' + (enabled ? 'ON' : 'OFF'), { type: 'config', id: 'taskTimers', name: 'Task timers' });
      showToast('Task timers ' + (enabled ? 'ON' : 'OFF'));
    }).catch(() => { showToast('Could not change the setting'); renderPutawayTab(); });
}

// ---------- worker: putaway ----------
function renderPutawayAssignedList() {
  const box = document.getElementById('putaway-assigned-list'); if (!box) return;
  const w = curProdWorker();
  const on = taskTimersOn();
  const session = w ? putawayInProgress[w.id] : null;
  const mine = w ? putawayTasks.filter(t => sameId(t.workerId, w.id) && t.status === 'assigned') : [];
  if (pendingProductionType !== 'putaway' || pendingEditFbKey || !mine.length || session) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="form-label" style="margin-bottom:6px">Assigned to you</div>' + mine.slice().reverse().map(t =>
    '<div style="display:flex;align-items:center;gap:8px;border:0.5px solid ' + (pendingPutawayTaskId === t.id ? 'var(--accent,#185fa5)' : 'var(--border2)') + ';border-radius:var(--radius);padding:8px 10px;margin-bottom:6px">' +
      '<div style="flex:1;min-width:0"><div style="font-weight:500;font-size:13.5px">' + ftEsc(t.supplier) + (t.expectedQty ? ' · ' + t.expectedQty + ' units' : '') + '</div>' +
      taskItemsBlock(t) + '<div style="font-size:11.5px;color:var(--text3)">' + (t.note ? ftEsc(t.note) + ' · ' : '') + 'assigned ' + fmtClock(t.assignedAt) + (on ? ' · waiting <span class="order-timer" data-assigned-at="' + ftEsc(t.assignedAt) + '">' + elapsedLabel(t.assignedAt) + '</span>' : '') + '</div></div>' +
      (on ? '<button type="button" class="btn primary" style="padding:6px 12px" onclick="startAssignedPutaway(\'' + ftEsc(t.id) + '\')"><i class="ti ti-player-play"></i> Start</button>'
          : '<button type="button" class="btn" style="padding:6px 12px" onclick="chooseAssignedPutaway(\'' + ftEsc(t.id) + '\')">' + (pendingPutawayTaskId === t.id ? 'Selected' : 'Use') + '</button>') +
    '</div>').join('');
}
function startAssignedPutaway(id) {
  const w = curProdWorker(); if (!w) return;
  const t = putawayTasks.find(x => x.id === id);
  if (!t || t.status !== 'assigned' || !sameId(t.workerId, w.id)) { showToast('That task is no longer available'); return; }
  if (putawayInProgress[w.id]) { showToast('Finish your current putaway first'); return; }
  const startedAt = nowDate().toISOString();
  const delay = secsBetween(t.assignedAt, startedAt);
  const up = {};
  up['putawayTasks/' + id + '/status'] = 'started';
  up['putawayTasks/' + id + '/startedAt'] = startedAt;
  up['putawayTasks/' + id + '/startDelaySecs'] = delay;
  up['putawayInProgress/' + w.id] = { supplier: t.supplier, workerName: w.name, startedAt, taskId: id, assignedAt: t.assignedAt, startDelaySecs: delay };
  db.ref(currentWarehouse).update(up).then(() => {
    showToast('Started — you waited ' + fmtSecs(delay) + ' before starting');
  }).catch(e => showToast('Could not start: ' + (e && e.message || 'try again')));
}
function chooseAssignedPutaway(id) {
  pendingPutawayTaskId = pendingPutawayTaskId === id ? null : id;
  syncPutawayUIFromFirebase(); renderPutawayAssignedList();
}
// Ad-hoc putaway (nobody assigned it) — original behaviour, plus the mode switch.
function startPutawayTask() {
  const sel = document.getElementById('production-supplier-input');
  const supplier = sel ? sel.value : '';
  if (!supplier) { showToast('Select a supplier first'); return; }
  const w = curProdWorker(); if (!w) return;
  wref('putawayInProgress/' + w.id).set({ supplier, workerName: w.name, startedAt: nowDate().toISOString() });
  showToast('Started putaway for ' + supplier);
  syncPutawayUIFromFirebase();
}
function endPutawayTask() {
  const w = curProdWorker(); if (!w) return;
  const session = putawayInProgress[w.id];
  if (!session) { showToast('Press Start first'); return; }
  const qty = parseInt(document.getElementById('production-putaway-qty-input').value, 10);
  if (!Number.isFinite(qty) || qty <= 0) { showToast('Enter the quantity supplied'); return; }
  const now = nowDate();
  const ci = getCheckinState(w.id);
  const durationMinutes = Math.max(0, Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 60000));
  const key = wref('production').push().key;
  const entry = {
    workerId: w.id, workerName: w.name, date: today(), shift: ci ? (ci.shift || null) : null,
    taskType: 'putaway', supplier: session.supplier, qty, timed: true,
    startedAt: session.startedAt, doneAt: now.toISOString(), durationMinutes,
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }), createdAt: now.toISOString()
  };
  const _tk = session.taskId ? putawayTasks.find(x => x.id === session.taskId) : null;
  if (_tk && _tk.items) entry.putawaySkus = Object.values(_tk.items).map(i => i.sku);
  if (session.taskId) { entry.taskId = session.taskId; entry.assignedAt = session.assignedAt || null; if (session.startDelaySecs != null) entry.startDelaySecs = session.startDelaySecs; }
  const up = {};
  up['production/' + key] = entry;
  up['putawayInProgress/' + w.id] = null;
  if (session.taskId) {
    up['putawayTasks/' + session.taskId + '/status'] = 'done';
    up['putawayTasks/' + session.taskId + '/doneAt'] = entry.doneAt;
    up['putawayTasks/' + session.taskId + '/qty'] = qty;
    up['putawayTasks/' + session.taskId + '/durationMinutes'] = durationMinutes;
  }
  db.ref(currentWarehouse).update(up).then(() => {
    showToast(qty + ' units put away for ' + session.supplier + ' (' + durationLabel(session.startedAt, entry.doneAt) + ')');
    resetPutawayUI();
  }).catch(e => showToast('Could not save — nothing was lost, your timer is still running (' + (e && e.message || 'try again') + ')'));
}
// Timers OFF: just log the quantity.
function logPutawayNoTimer() {
  const w = curProdWorker(); if (!w) return;
  const err = document.getElementById('production-error');
  const task = pendingPutawayTaskId ? putawayTasks.find(t => t.id === pendingPutawayTaskId && t.status === 'assigned' && sameId(t.workerId, w.id)) : null;
  const supplier = task ? task.supplier : document.getElementById('production-supplier-input').value.trim();
  const qty = parseInt(document.getElementById('production-putaway-qty-input').value, 10);
  const fail = m => { err.textContent = m; err.style.display = 'block'; };
  if (!supplier) return fail('Select a supplier');
  if (!Number.isFinite(qty) || qty <= 0) return fail('Enter the quantity supplied');
  err.style.display = 'none';
  const now = nowDate(), ci = getCheckinState(w.id);
  const key = wref('production').push().key;
  const entry = {
    workerId: w.id, workerName: w.name, date: today(), shift: ci ? (ci.shift || null) : null,
    taskType: 'putaway', supplier, qty, timed: false,
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }), createdAt: now.toISOString()
  };
  const up = { ['production/' + key]: entry };
  if (task) {
    entry.taskId = task.id;
    if (task.items) entry.putawaySkus = Object.values(task.items).map(i => i.sku);
    up['putawayTasks/' + task.id + '/status'] = 'done';
    up['putawayTasks/' + task.id + '/doneAt'] = now.toISOString();
    up['putawayTasks/' + task.id + '/qty'] = qty;
    up['putawayTasks/' + task.id + '/durationMinutes'] = 0;
  }
  db.ref(currentWarehouse).update(up).then(() => {
    showToast(qty + ' units put away for ' + supplier);
    pendingPutawayTaskId = null;
    document.getElementById('production-putaway-qty-input').value = '';
    resetPutawayUI(); renderPutawayAssignedList();
  }).catch(e => showToast('Could not save: ' + (e && e.message || 'try again')));
}
function cancelPutawayTask() {
  const w = curProdWorker(); if (!w) return;
  const s = putawayInProgress[w.id];
  if (s && s.taskId) { showToast('This was assigned to you — ask an admin to cancel it'); return; }
  if (!confirm('Discard this putaway session? Nothing has been logged yet.')) return;
  wref('putawayInProgress/' + w.id).remove();
  resetPutawayUI();
}
function syncPutawayUIFromFirebase() {
  const w = curProdWorker();
  const session = w ? putawayInProgress[w.id] : null;
  const on = taskTimersOn();
  const q = id => document.getElementById(id);
  const sel = q('production-supplier-input');
  const show = (id, v) => { const e = q(id); if (e) e.style.display = v; };
  if (session) {   // a running timer is always honoured, even if the switch was turned off meanwhile
    if (sel) { sel.value = session.supplier; sel.disabled = true; }
    show('putaway-start-btn', 'none'); show('putaway-end-btn', 'flex');
    show('putaway-cancel-btn', session.taskId ? 'none' : 'flex');
    show('putaway-timer-row', 'flex');
    const span = q('putaway-timer-span');
    span.dataset.assignedAt = session.startedAt; span.textContent = elapsedLabel(session.startedAt);
  } else {
    if (sel) sel.disabled = false;
    const task = pendingPutawayTaskId ? putawayTasks.find(t => t.id === pendingPutawayTaskId) : null;
    if (task && sel) { sel.value = task.supplier; sel.disabled = true; }
    show('putaway-start-btn', on ? 'flex' : 'none'); show('putaway-end-btn', 'none');
    show('putaway-cancel-btn', 'none'); show('putaway-timer-row', 'none');
  }
  // Submit button: only used in timers-OFF mode.
  const sub = q('production-submit-btn');
  if (sub && pendingProductionType === 'putaway' && !pendingEditFbKey) {
    sub.style.display = (!on && !session) ? 'flex' : 'none';
    sub.innerHTML = '<i class="ti ti-check"></i> Log putaway';
  } else if (sub && !pendingEditFbKey && sub.innerHTML.indexOf('Log putaway') >= 0) {
    sub.innerHTML = '<i class="ti ti-plus"></i> Add entry';
  }
}
(function wrapProductionModal() {
  const origReset = resetPutawayUI;
  resetPutawayUI = function () {
    // The original reset clears the form and shows Start; re-apply the mode.
    const keepTask = pendingPutawayTaskId;
    origReset();
    pendingPutawayTaskId = keepTask;
    const w = curProdWorker();
    if (!taskTimersOn() || (w && putawayInProgress[w.id])) syncPutawayUIFromFirebase();
  };
  const origSet = setProductionType;
  setProductionType = function (type) {
    origSet.apply(this, arguments);
    syncPutawayUIFromFirebase();
    renderPutawayAssignedList();
    syncPackingTimerUI();
  };
  const origAdd = addProductionEntry;
  addProductionEntry = function () {
    if (pendingProductionType === 'putaway' && !pendingEditFbKey && !taskTimersOn()) { const w0 = curProdWorker(); if (w0 && putawayInProgress[w0.id]) return endPutawayTask(); return logPutawayNoTimer(); }
    return origAdd.apply(this, arguments);
  };
  const origOpen = openProductionModal;
  openProductionModal = function () { pendingPutawayTaskId = null; return origOpen.apply(this, arguments); };
  const origClose = closeProductionModal;
  closeProductionModal = function () { pendingPutawayTaskId = null; return origClose.apply(this, arguments); };
})();

// ---------- worker: packing timer ----------
function syncPackingTimerUI() {
  const row = document.getElementById('packing-timer-row'); if (!row) return;
  const w = curProdWorker();
  const s0 = w ? packingInProgress[w.id] : null;
  const visible = pendingProductionType === 'packing' && !pendingEditFbKey && (taskTimersOn() || !!s0) && !!w;
  row.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  const s = s0;
  document.getElementById('packing-start-btn').style.display = s ? 'none' : (taskTimersOn() ? 'inline-flex' : 'none');
  document.getElementById('packing-timer-live').style.display = s ? 'inline' : 'none';
  document.getElementById('packing-cancel-btn').style.display = s ? 'inline-flex' : 'none';
  if (s) {
    const span = document.getElementById('packing-timer-span');
    span.dataset.assignedAt = s.startedAt; span.textContent = elapsedLabel(s.startedAt);
    if (s.orderKey && !pendingProductionOrderId && orders.some(o => o.fbKey === s.orderKey && o.status === 'picked')) selectPackOrder(s.orderKey);
  }
}
function startPackingTimer() {
  const w = curProdWorker(); if (!w) return;
  if (packingInProgress[w.id]) { showToast('A packing timer is already running'); return; }
  const customer = (document.getElementById('production-customer-input').value || '').trim();
  if (!pendingProductionOrderId && !customer) { showToast('Pick the order you are packing first'); return; }
  const o = pendingProductionOrderId ? orders.find(x => x.fbKey === pendingProductionOrderId) : null;
  const startedAt = nowDate().toISOString();
  const s = { customer: o ? o.customer : customer, startedAt, workerName: w.name };
  if (o) { s.orderKey = o.fbKey; if (o.pickedAt) s.readyAt = o.pickedAt; }
  wref('packingInProgress/' + w.id).set(s).then(() => {
    showToast(s.readyAt ? 'Packing started — ready ' + fmtSecs(secsBetween(s.readyAt, startedAt)) + ' before you began' : 'Packing started');
  });
}
function cancelPackingTimer() {
  const w = curProdWorker(); if (!w) return;
  if (!confirm('Discard the packing timer? Nothing is logged yet.')) return;
  wref('packingInProgress/' + w.id).remove();
}
let packingTimerUsed = false;
function featuresDecoratePacking(entry, w) {
  packingTimerUsed = false;
  const s = packingInProgress[w.id]; if (!s) return;
  if (s.orderKey && pendingProductionOrderId && s.orderKey !== pendingProductionOrderId) { showToast('Your running timer was for a different order (' + (s.customer || '') + ') — it was not used for this entry'); return; }
  packingTimerUsed = true;
  const now = nowDate();
  entry.timed = true;
  entry.startedAt = s.startedAt;
  entry.doneAt = now.toISOString();
  entry.durationSecs = secsBetween(s.startedAt, entry.doneAt);
  entry.durationMinutes = Math.round(entry.durationSecs / 60);
  if (s.readyAt) { entry.readyAt = s.readyAt; entry.startDelaySecs = secsBetween(s.readyAt, s.startedAt); }
}
function featuresAfterPacked(w) {
  if (packingTimerUsed && packingInProgress[w.id]) wref('packingInProgress/' + w.id).remove();
  packingTimerUsed = false;
}


// ---------- SKU catalog (admin upload + search) ----------
let skuCatalog = [];          // [{key, sku, name, uom}]
let skuCatalogLoaded = false, skuCatalogLoading = false, skuUploadMsg = '';
let paSelected = {};          // key -> {sku, name, qty}

function skuKey(s) {
  const raw = String(s == null ? '' : s).trim(); const clean = raw.replace(/[.$#\[\]\/'"`\\<>&]/g, '_');
  // A code that needed changing gets a short hash so 'A/B' and 'A_B' stay two different SKUs.
  return (clean === raw ? clean : clean.slice(0, 100) + '~' + pushHash(raw).slice(1)).slice(0, 120);
}
function loadSkuCatalog(force) {
  if (!currentAdmin || !adminHasPerm('putaway')) return Promise.resolve();
  if ((skuCatalogLoaded && !force) || skuCatalogLoading) return Promise.resolve();
  skuCatalogLoading = true;
  return wref('skuCatalog').once('value').then(snap => {
    const list = [];
    snap.forEach(c => { const v = c.val(); if (v && v.sku) list.push({ key: c.key, sku: String(v.sku), name: v.name || '', uom: v.uom || '' }); });
    list.sort((a, b) => a.sku.localeCompare(b.sku));
    skuCatalog = list; skuCatalogLoaded = true;
  }).catch(e => { skuUploadMsg = 'Could not load the catalog: ' + (e && e.message || 'error'); })
    .then(() => { skuCatalogLoading = false; safeRender('putaway', renderPutawayTab); });
}
function skuCatalogCardHtml() {
  return '<p class="section-title" style="margin-top:14px">SKU catalog</p>' +
    '<div class="card"><div style="font-size:13px;margin-bottom:8px"><b>' + skuCatalog.length.toLocaleString() + '</b> SKUs loaded' + (skuCatalogLoading ? ' …' : '') +
    '. Upload a CSV or Excel file with a <b>SKU / code</b> column and (optionally) <b>name</b> and <b>UoM</b> columns.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<input type="file" id="pa-sku-file" accept=".csv,.xlsx,.xls" style="flex:1;min-width:180px">' +
      '<select id="pa-sku-mode"><option value="merge">Add / update</option><option value="replace">Replace whole catalog</option></select>' +
      '<button class="btn primary" onclick="uploadSkuCatalog()"><i class="ti ti-upload"></i> Upload</button>' +
      (skuCatalog.length ? '<button class="btn danger" onclick="clearSkuCatalog()" title="Delete every SKU"><i class="ti ti-trash"></i></button>' : '') +
    '</div><p id="pa-sku-msg" style="font-size:12px;color:var(--text2);margin-top:8px">' + ftEsc(skuUploadMsg) + '</p></div>';
}
function parseSkuRows(rows) {
  const norm = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  const SKU_H = ['sku', 'skucode', 'itemcode', 'productcode', 'code', 'item', 'itemno', 'material', 'article', 'articlenumber', 'sku id', 'skuid'];
  const NAME_H = ['name', 'skuname', 'description', 'itemname', 'productname', 'itemdescription', 'desc', 'product'];
  const UOM_H = ['uom', 'unit', 'unitofmeasure'];
  if (!rows.length) return [];
  const heads = Object.keys(rows[0]);
  const find = list => heads.find(h => list.includes(norm(h)));
  const skuH = find(SKU_H) || heads[0];
  const nameH = find(NAME_H) || (heads.find(h => h !== skuH) || null);
  const uomH = find(UOM_H);
  const out = new Map();
  rows.forEach(r => {
    const sku = String(r[skuH] == null ? '' : r[skuH]).trim();
    if (!sku) return;
    const key = skuKey(sku); if (!key) return;
    out.set(key, { sku, name: nameH ? String(r[nameH] == null ? '' : r[nameH]).trim().slice(0, 200) : '', uom: uomH ? String(r[uomH] || '').trim().slice(0, 20) : '' });
  });
  return Array.from(out, ([key, v]) => ({ key, ...v }));
}
async function uploadSkuCatalog() {
  if (!adminHasPerm('putaway')) { showToast('You do not have permission'); return; }
  const f = document.getElementById('pa-sku-file') && document.getElementById('pa-sku-file').files[0];
  const msg = document.getElementById('pa-sku-msg');
  const say = m => { skuUploadMsg = m; if (msg) msg.textContent = m; };
  if (!f) { say('Choose a file first'); return; }
  if (typeof XLSX === 'undefined') { say('Excel library failed to load — check your connection'); return; }
  const mode = document.getElementById('pa-sku-mode').value;
  try {
    say('Reading file…');
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    const items = parseSkuRows(rows);
    if (!items.length) { say('No SKU rows found — check the file has a SKU/code column'); return; }
    if (items.length > 30000) { say('Too many rows (' + items.length + '). Maximum is 30,000 per upload.'); return; }
    if (mode === 'replace' && !confirm('Replace the whole catalog with ' + items.length + ' SKUs from this file?')) { say('Cancelled'); return; }
    if (mode === 'replace') await wref('skuCatalog').remove();
    for (let i = 0; i < items.length; i += 400) {
      const up = {};
      items.slice(i, i + 400).forEach(it => { up[it.key] = { sku: it.sku, name: it.name, uom: it.uom }; });
      await wref('skuCatalog').update(up);
      say('Uploading… ' + Math.min(i + 400, items.length) + ' / ' + items.length);
    }
    audit('sku.upload', 'SKU catalog ' + (mode === 'replace' ? 'replaced' : 'updated') + ': ' + items.length + ' SKUs from ' + f.name, { type: 'skuCatalog', id: 'catalog', name: f.name }, { count: items.length, mode });
    say('Done — ' + items.length.toLocaleString() + ' SKUs uploaded.');
    await loadSkuCatalog(true);
  } catch (e) { say('Upload failed: ' + (e && e.message || e)); }
}
function clearSkuCatalog() {
  if (!adminHasPerm('putaway')) return;
  if (!confirm('Delete every SKU in the catalog? Existing putaway tasks keep their SKUs.')) return;
  wref('skuCatalog').remove().then(() => {
    audit('sku.clear', 'SKU catalog cleared (' + skuCatalog.length + ' SKUs)', { type: 'skuCatalog', id: 'catalog', name: 'catalog' });
    skuCatalog = []; skuUploadMsg = 'Catalog cleared.'; renderPutawayTab();
  }).catch(() => showToast('Could not clear the catalog'));
}
function paSkuSearch() {
  const box = document.getElementById('pa-sku-results'); const inp = document.getElementById('pa-sku-search');
  if (!box || !inp) return;
  const q = inp.value.trim().toLowerCase();
  if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const starts = [], has = [];
  for (let i = 0; i < skuCatalog.length && starts.length < 25; i++) {
    const it = skuCatalog[i], a = it.sku.toLowerCase(), n = (it.name || '').toLowerCase();
    if (a.startsWith(q)) starts.push(it); else if ((a.includes(q) || n.includes(q)) && has.length < 25) has.push(it);
  }
  const hits = starts.concat(has).slice(0, 25);
  let html = hits.map(it => '<div style="padding:7px 10px;cursor:pointer;border-bottom:0.5px solid var(--border2);font-size:13px;' + (paSelected[it.key] ? 'opacity:.5' : '') + '" data-k="' + ftEsc(it.key) + '" onclick="paAddSku(this.dataset.k)"><b>' + ftEsc(it.sku) + '</b> <span style="color:var(--text3)">' + ftEsc(it.name) + (it.uom ? ' · ' + ftEsc(it.uom) : '') + '</span></div>').join('');
  if (!hits.length || !skuCatalog.length) {
    html += '<div style="padding:8px 10px;font-size:12.5px;color:var(--text3)">' + (skuCatalog.length ? 'No match. ' : 'Catalog is empty. ') + '<a href="#" onclick="paAddTypedSku();return false">Add “' + ftEsc(inp.value.trim()) + '” as typed</a></div>';
  }
  box.innerHTML = html; box.style.display = 'block';
}
function paAddSku(key) {
  const it = skuCatalog.find(x => x.key === key); if (!it || paSelected[key]) return;
  paSelected[key] = { sku: it.sku, name: it.name, qty: null };
  const inp = document.getElementById('pa-sku-search'); if (inp) { inp.value = ''; inp.focus(); }
  renderPaSelected(); paSkuSearch();
}
function paAddTypedSku() {
  const inp = document.getElementById('pa-sku-search'); const v = inp ? inp.value.trim().slice(0, 120) : '';
  const key = skuKey(v); if (!key) return;
  paSelected[key] = paSelected[key] || { sku: v, name: '', qty: null };
  inp.value = ''; renderPaSelected(); paSkuSearch();
}
function paRemoveSku(key) { delete paSelected[key]; renderPaSelected(); }
function paSetSkuQty(key, v) {
  const n = parseInt(v, 10); if (paSelected[key]) paSelected[key].qty = Number.isFinite(n) && n >= 0 ? n : null;
}
function renderPaSelected() {
  const box = document.getElementById('pa-sku-selected'); if (!box) return;
  const keys = Object.keys(paSelected);
  box.innerHTML = keys.map(k => {
    const it = paSelected[k]; const ek = ftEsc(k);
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:13px"><div style="flex:1;min-width:0"><b>' + ftEsc(it.sku) + '</b> <span style="color:var(--text3)">' + ftEsc(it.name) + '</span></div>' +
      '<input type="number" min="0" inputmode="numeric" placeholder="Qty" value="' + (it.qty != null ? it.qty : '') + '" style="width:70px;padding:4px 6px" data-k="' + ek + '" oninput="paSetSkuQty(this.dataset.k,this.value)">' +
      '<button type="button" class="btn danger" style="padding:3px 7px" data-k="' + ek + '" onclick="paRemoveSku(this.dataset.k)"><i class="ti ti-x"></i></button></div>';
  }).join('') + (keys.length ? '<div style="font-size:11.5px;color:var(--text3)">' + keys.length + ' SKU' + (keys.length > 1 ? 's' : '') + ' selected</div>' : '');
}
function taskItemList(t) { return t && t.items ? Object.values(t.items).filter(Boolean) : []; }
function taskItemsInline(t) {
  const it = taskItemList(t); if (!it.length) return '';
  return '<div style="color:var(--text3);font-size:11px">' + it.slice(0, 4).map(i => ftEsc(i.sku) + (i.qty ? '×' + i.qty : '')).join(', ') + (it.length > 4 ? ' +' + (it.length - 4) + ' more' : '') + '</div>';
}
function taskItemsBlock(t) {
  const it = taskItemList(t); if (!it.length) return '';
  return '<div style="font-size:12px;margin:3px 0;line-height:1.5">' + it.map(i => '<div><b>' + ftEsc(i.sku) + '</b>' + (i.name ? ' <span style="color:var(--text3)">' + ftEsc(i.name) + '</span>' : '') + (i.qty ? ' · ' + i.qty : '') + '</div>').join('') + '</div>';
}


// ---------- Part B: productivity targets (per task type, per hour) ----------
let perfTargets = {};            // { picking: 60, packing: 40, putaway: 300, replenishment: 200 }
let perfTargetsLoaded = false;
const PERF_TYPES = {
  picking:       { label: 'Picking',       unit: 'SKUs',  get: p => +p.skus || 0 },
  packing:       { label: 'Packing',       unit: 'SKUs',  get: p => +p.skus || 0 },
  putaway:       { label: 'Putaway',       unit: 'units', get: p => +p.qty || 0 },
  replenishment: { label: 'Replenishment', unit: 'units', get: p => +p.qty || 0 }
};
const PERF_EST_CAP_MINS = 90;    // an untimed gap longer than this is treated as a break, not work
const PERF_NEAR = 0.85;          // 85–99% of target = "near"

function perfLoadTargets(force) {
  if (!currentAdmin || (perfTargetsLoaded && !force)) return Promise.resolve();
  perfTargetsLoaded = true;
  return wref('targets').once('value').then(s => { const v = s.val(); perfTargets = (v && typeof v === 'object') ? v : {}; })
    .catch(() => { perfTargetsLoaded = false; })
    .then(() => safeRender('perf', renderPerfPanel));
}
// Exact seconds when the worker timed it; otherwise the gap since the previous
// entry (or check-in), capped so lunch / idle time is not counted as work.
function perfEntries(from, to) {
  const prod = production.filter(p => p.date >= from && p.date <= to);
  const ciTime = {};
  checkins.forEach(c => { if (c.status === 'approved' && c.checkinTime) ciTime[(c.workerId != null ? c.workerId : c.workerName) + '|' + c.date] = c.checkinTime; });
  const groups = {};
  prod.forEach(p => { const k = (p.workerId != null ? p.workerId : p.workerName) + '|' + p.date; (groups[k] = groups[k] || []).push(p); });
  const out = [];
  Object.keys(groups).forEach(k => {
    const list = groups[k].slice().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    let prev = ciTime[k] ? new Date(ciTime[k]).getTime() : null;
    list.forEach(p => {
      const type = getTaskType(p); const cur = p.createdAt ? new Date(p.createdAt).getTime() : null;
      let secs = null, exact = false;
      if (p.durationSecs != null) { secs = +p.durationSecs; exact = true; }
      else if (p.timed && p.durationMinutes != null) { secs = p.durationMinutes * 60; exact = true; }
      else if (prev != null && cur != null && !isNaN(prev) && !isNaN(cur)) { const g = Math.max(0, (cur - prev) / 1000); if (g > 0 && g <= PERF_EST_CAP_MINS * 60) secs = g; }
      if (cur != null && !isNaN(cur)) prev = cur;
      if (PERF_TYPES[type]) out.push({ wid: p.workerId, name: p.workerName, type, qty: PERF_TYPES[type].get(p), secs, exact });
    });
  });
  return out;
}
function perfStatus(rate, target) {
  if (!target || rate == null) return { cls: 'none', label: '—', pct: null };
  const pct = rate / target;
  if (pct >= 1) return { cls: 'above', label: 'On / above target', pct };
  if (pct >= PERF_NEAR) return { cls: 'near', label: 'Near target', pct };
  return { cls: 'below', label: 'Below target', pct };
}
function perfAggregate(entries) {
  const m = {};
  entries.forEach(e => {
    const k = e.type + '|' + (e.wid != null ? e.wid : e.name);
    const a = m[k] = m[k] || { type: e.type, name: e.name, qty: 0, secs: 0, nExact: 0, nEst: 0, nNone: 0 };
    // Work with no usable time (e.g. logged after a long break) is left out of
    // BOTH sides of the rate, otherwise it would inflate it.
    if (e.secs != null) { a.qty += e.qty; a.secs += e.secs; if (e.exact) a.nExact++; else a.nEst++; } else a.nNone++;
  });
  return Object.values(m).map(a => { a.rate = a.secs >= 60 ? a.qty / (a.secs / 3600) : null; return a; });
}
function renderPerfPanel() {
  const statsEl = document.getElementById('analytics-stats'); if (!statsEl) return;
  let root = document.getElementById('analytics-targets-root');
  if (!root) { root = document.createElement('div'); root.id = 'analytics-targets-root'; statsEl.parentNode.insertBefore(root, statsEl.nextSibling); }
  if (!currentAdmin) { root.innerHTML = ''; return; }
  const from = document.getElementById('analytics-from').value || today(), to = document.getElementById('analytics-to').value || today();
  const typed = Object.keys(PERF_TYPES);
  const perfKeep = {}; typed.forEach(t => { const el = document.getElementById('perf-target-' + t); if (el && el.dataset.dirty) perfKeep[t] = el.value; });   // only what the admin is typing, never stale values over freshly loaded ones
  const canEdit = adminHasPerm('analytics');
  const agg = perfAggregate(perfEntries(from, to));
  const editor = typed.map(t => '<div class="form-group" style="min-width:110px"><label class="form-label">' + PERF_TYPES[t].label + ' <span style="font-weight:400">' + PERF_TYPES[t].unit + '/hr</span></label><input type="number" min="0" step="1" inputmode="numeric" id="perf-target-' + t + '" oninput="this.dataset.dirty=1" value="' + (perfTargets[t] != null ? perfTargets[t] : '') + '" placeholder="not set"' + (canEdit ? '' : ' disabled') + '></div>').join('');
  const team = typed.map(t => {
    const rows = agg.filter(a => a.type === t); const qty = rows.reduce((s, a) => s + a.qty, 0), secs = rows.reduce((s, a) => s + a.secs, 0);
    const rate = secs >= 60 ? qty / (secs / 3600) : null; const st = perfStatus(rate, +perfTargets[t]);
    return '<div class="stat-card" style="flex:1;min-width:130px"><div class="stat-label">' + PERF_TYPES[t].label + ' · team</div><div class="stat-value" style="font-size:18px">' + (rate != null ? Math.round(rate) : '—') + ' <span style="font-size:11px;font-weight:400">' + PERF_TYPES[t].unit + '/hr</span></div>' +
      '<div style="font-size:11px;color:var(--text3)">target ' + (perfTargets[t] ? perfTargets[t] : 'not set') + (st.pct != null ? ' · ' + Math.round(st.pct * 100) + '%' : '') + '</div></div>';
  }).join('');
  const chip = st => { const c = { above: ['var(--green-bg)', 'var(--green-text)'], near: ['var(--amber-bg)', 'var(--amber-text)'], below: ['var(--red-bg)', 'var(--red-text)'], none: ['var(--bg2,#eee)', 'var(--text3)'] }[st.cls]; return '<span style="background:' + c[0] + ';color:' + c[1] + ';border-radius:20px;padding:2px 8px;font-size:11px;white-space:nowrap">' + st.label + '</span>'; };
  const body = agg.filter(a => a.rate != null).sort((a, b) => a.type.localeCompare(b.type) || (b.rate / (+perfTargets[b.type] || 1)) - (a.rate / (+perfTargets[a.type] || 1))).map(a => {
    const st = perfStatus(a.rate, +perfTargets[a.type]);
    const basis = a.nExact && !a.nEst ? 'timed' : (a.nExact ? a.nExact + ' timed + ' + a.nEst + ' est.' : 'estimated');
    return '<tr><td>' + ftEsc(a.name) + '</td><td>' + PERF_TYPES[a.type].label + '</td><td>' + a.qty.toLocaleString() + ' ' + PERF_TYPES[a.type].unit + '</td><td>' + (a.secs / 3600).toFixed(1) + 'h <span style="color:var(--text3);font-size:11px">' + basis + '</span></td><td><b>' + Math.round(a.rate) + '</b>/hr</td><td>' + (perfTargets[a.type] || '—') + '</td><td>' + (st.pct != null ? Math.round(st.pct * 100) + '%' : '—') + '</td><td>' + chip(st) + '</td></tr>';
  }).join('');
  root.innerHTML = '<p class="section-title" style="margin-top:20px">Performance vs target <span style="font-weight:400;font-size:12px;color:var(--text3)">(' + from + ' → ' + to + ')</span></p>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">' + team + '</div>' +
    '<div class="card" style="margin-bottom:10px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' + editor +
      (canEdit ? '<button class="btn primary" onclick="savePerfTargets()" style="margin-bottom:12px"><i class="ti ti-device-floppy"></i> Save targets</button>' : '') + '</div>' +
      '<p style="font-size:11.5px;color:var(--text3);margin:0">Rate = work logged ÷ hours worked. Timed tasks use the worker\'s own Start→End; others use the gap since their previous entry (gaps over ' + PERF_EST_CAP_MINS + ' min are ignored as breaks). “Near” = ' + Math.round(PERF_NEAR * 100) + '–99% of target.</p></div>' +
    (body ? '<div class="card" style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr><th>Worker</th><th>Task</th><th>Done</th><th>Time</th><th>Rate</th><th>Target</th><th>% of target</th><th>Status</th></tr></thead><tbody>' + body + '</tbody></table></div>'
          : '<div class="empty-state"><i class="ti ti-target"></i>No timed or estimable work in this range yet</div>');
  typed.forEach(t => { const el = document.getElementById('perf-target-' + t); if (el && perfKeep[t] != null) { el.value = perfKeep[t]; el.dataset.dirty = 1; } });
}
function savePerfTargets() {
  if (!adminHasPerm('analytics')) { showToast('You do not have permission'); return; }
  const next = {};
  for (const t of Object.keys(PERF_TYPES)) {
    const v = document.getElementById('perf-target-' + t).value.trim();
    if (v === '') continue;
    const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100000) { showToast('Targets must be numbers between 0 and 100000'); return; }
    next[t] = n;
  }
  wref('targets').set(Object.keys(next).length ? next : null).then(() => {
    perfTargets = next;
    audit('targets.update', 'Productivity targets updated', { type: 'targets', id: 'targets', name: 'Targets' }, next);
    showToast('Targets saved'); renderPerfPanel();
  }).catch(() => showToast('Could not save targets'));
}
(function wrapAnalytics() {
  const orig = renderAnalytics;
  renderAnalytics = function () { orig.apply(this, arguments); perfLoadTargets(); safeRender('perf', renderPerfPanel); };
})();


// Admin-only data is per warehouse and per login: clear it on warehouse switch and logout.
function resetAdminCaches() {
  skuCatalog = []; skuCatalogLoaded = false; skuCatalogLoading = false; skuUploadMsg = ''; paSelected = {};
  perfTargets = {}; perfTargetsLoaded = false;
  if (typeof hrLoaded !== 'undefined') { hrLoaded = false; hrLoading = null; hrLeave = []; hrAdj = []; hrCfg = JSON.parse(JSON.stringify(HR_DEFAULTS)); hrFrom = ''; hrTo = ''; }
  if (typeof auditRows !== 'undefined') { auditRows = []; auditFrom = ''; auditTo = ''; }
}
(function wrapLogoutCaches() { const o = logoutAdmin; logoutAdmin = function () { resetAdminCaches(); return o.apply(this, arguments); }; })();


// Packing has no assignment, so its "wait" runs from the order becoming ready to pack
// (picked) until the packer pressed Start. Listed here next to the putaway waits.
function packingTimingHtml(sinceIso) {
  const rows = (typeof production !== 'undefined' ? production : []).filter(p => p.taskType === 'packing' && p.timed && (p.createdAt || '') >= sinceIso)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100).map(p =>
      '<tr><td>' + ftEsc(p.workerName) + '</td><td>' + ftEsc(p.customer || '') + '</td><td>' + (p.readyAt ? fmtClock(p.readyAt) : '—') + '</td><td>' + fmtClock(p.startedAt) + '</td><td>' + (p.startDelaySecs != null ? fmtSecs(p.startDelaySecs) : '—') + '</td><td>' + (p.durationSecs != null ? fmtSecs(p.durationSecs) : (p.durationMinutes != null ? p.durationMinutes + 'm' : '—')) + '</td><td>' + (p.skus != null ? p.skus : '—') + '</td></tr>').join('');
  return '<p class="section-title" style="margin-top:14px">Packing timers (last 7 days)</p>' + (rows
    ? '<div class="card" style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr><th>Worker</th><th>Customer</th><th>Ready to pack</th><th>Started</th><th>Wait to start</th><th>Took</th><th>SKUs</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="empty-state"><i class="ti ti-package"></i>No timed packing yet</div>');
}

// ---------- Analytics: ORDER TIMING (assigned -> started -> done) ----------
// One row per worker per order. "Wait to start" is how long the order sat with the worker before
// their clock began on it. Picking clocks start automatically (when the worker has no other order
// running), so for picking this is QUEUE time, not a button press. Putaway/packing waits are in
// their own tables (Putaway tab).
function orderTimingRows(from, to) {
  const rows = [];
  (orders || []).forEach(o => {
    getOrderAssignees(o).forEach(a => {
      const as = a.assignedAt || o.assignedAt; if (!as) return;
      const day = fmtDay(as); if (day < from || day > to) return;
      const started = a.startedAt || null, done = a.done ? (a.doneAt || o.pickedAt || null) : null;
      rows.push({
        customer: o.customer || '', market: o.market || '', workerId: a.workerId, worker: a.workerName || '', assignedAt: as, startedAt: started, doneAt: done,
        wait: started ? secsBetween(as, started) : null, work: started && done ? secsBetween(started, done) : null, total: done ? secsBetween(as, done) : null,
        qty: a.qty != null ? a.qty : null, state: done ? 'done' : (started ? 'working' : 'waiting')
      });
    });
  });
  return rows.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
}
function renderOrderTiming() {
  const root = document.getElementById('analytics-timing-root'); if (!root) return;
  const from = document.getElementById('analytics-from').value || today(), to = document.getElementById('analytics-to').value || today();
  const rows = orderTimingRows(from, to);
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const waits = rows.filter(r => r.wait != null).map(r => r.wait), works = rows.filter(r => r.work != null).map(r => r.work), totals = rows.filter(r => r.total != null).map(r => r.total);
  const now = Date.now(), stuck = rows.filter(r => r.state === 'waiting' && now - new Date(r.assignedAt).getTime() > 30 * 60000).length;
  const stat = (l, v) => '<div class="stat-card"><div class="stat-label">' + l + '</div><div class="stat-value">' + v + '</div></div>';
  const by = {};
  rows.forEach(r => { const k = String(r.workerId); const w = by[k] = by[k] || { name: r.worker, n: 0, waits: [], works: [], totals: [] }; w.n++; if (r.wait != null) w.waits.push(r.wait); if (r.work != null) w.works.push(r.work); if (r.total != null) w.totals.push(r.total); });
  const perWorker = Object.values(by).sort((a, b) => (avg(b.waits) || 0) - (avg(a.waits) || 0)).map(w =>
    '<tr><td>' + ftEsc(w.name) + '</td><td style="text-align:center">' + w.n + '</td><td style="text-align:right">' + fmtSecs(avg(w.waits)) + '</td><td style="text-align:right">' + fmtSecs(avg(w.works)) + '</td><td style="text-align:right">' + fmtSecs(avg(w.totals)) + '</td></tr>').join('');
  const stateChip = s => s === 'done' ? '<span style="color:var(--green-text)">Done</span>' : s === 'working' ? '<span style="color:var(--amber-text)">Working</span>' : '<span style="color:var(--text3)">Waiting</span>';
  const body = rows.slice(0, 200).map(r =>
    '<tr><td>' + ftEsc(r.customer) + '<div style="font-size:11px;color:var(--text3)">' + ftEsc(r.market) + '</div></td><td>' + ftEsc(r.worker) + '</td><td>' + fmtDay(r.assignedAt) + ' ' + fmtClock(r.assignedAt) + '</td><td>' + fmtClock(r.startedAt) + '</td><td style="text-align:right">' + (r.state === 'waiting' ? '<span style="color:var(--text3)">waiting ' + fmtSecs((now - new Date(r.assignedAt).getTime()) / 1000) + '</span>' : fmtSecs(r.wait)) + '</td><td style="text-align:right">' + fmtSecs(r.work) + '</td><td style="text-align:right">' + fmtSecs(r.total) + '</td><td style="text-align:right">' + (r.qty != null ? r.qty : '—') + '</td><td>' + stateChip(r.state) + '</td></tr>').join('');
  root.innerHTML =
    '<div class="stat-grid stat-grid-4">' + stat('Orders assigned', rows.length) + stat('Avg wait to start', fmtSecs(avg(waits))) + stat('Longest wait', fmtSecs(waits.length ? Math.max(...waits) : null)) + stat('Waiting over 30 min now', stuck) + '</div>' +
    '<div class="stat-grid stat-grid-4">' + stat('Avg picking time', fmtSecs(avg(works))) + stat('Avg assigned → done', fmtSecs(avg(totals))) + stat('Finished', rows.filter(r => r.state === 'done').length) + stat('Still open', rows.filter(r => r.state !== 'done').length) + '</div>' +
    '<p class="section-title" style="font-size:12px;color:var(--text2);text-transform:none;letter-spacing:normal">By worker <span style="font-weight:400">— slowest to start first</span></p>' +
    '<div class="log-wrap"><table><thead><tr><th>Worker</th><th style="text-align:center">Orders</th><th style="text-align:right">Avg wait to start</th><th style="text-align:right">Avg picking time</th><th style="text-align:right">Avg assigned → done</th></tr></thead><tbody>' + (perWorker || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No orders assigned in this range</td></tr>') + '</tbody></table></div>' +
    '<p class="section-title" style="font-size:12px;color:var(--text2);text-transform:none;letter-spacing:normal;margin-top:16px">Every order <span style="font-weight:400">— newest first' + (rows.length > 200 ? ' (latest 200)' : '') + '</span></p>' +
    '<div class="log-wrap"><table><thead><tr><th>Order</th><th>Worker</th><th>Assigned</th><th>Started</th><th style="text-align:right">Wait to start</th><th style="text-align:right">Picking time</th><th style="text-align:right">Assigned → done</th><th style="text-align:right">Qty</th><th>Status</th></tr></thead><tbody>' + (body || '<tr><td colspan="9" style="text-align:center;color:var(--text3)">No orders assigned in this range</td></tr>') + '</tbody></table></div>' +
    '<p style="font-size:11.5px;color:var(--text3)"><i class="ti ti-info-circle"></i> Picking clocks start automatically when a worker has no other order running, so "wait to start" is how long the order queued behind their other work. Putaway and packing waits (Start button pressed) are on the Putaway tab.</p>';
}
(function wrapAnalyticsTiming() {
  const orig = renderAnalytics;
  renderAnalytics = function () { orig.apply(this, arguments); safeRender('order-timing', renderOrderTiming); };
})();
