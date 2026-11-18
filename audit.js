// audit.js — loaded after payroll.js. Audit-log viewer (permission "audit") and
// audit hooks for exports. Entries are append-only (enforced by database rules).
let auditRows = [], auditLoading = false, auditFrom = '', auditTo = '', auditError = '';
const AUDIT_LABELS = {
  login: 'Signed in', logout: 'Signed out',
  'checkin.approve': 'Approved check-in', 'checkin.unapprove': 'Un-approved check-in', 'checkin.reject': 'Rejected check-in', 'checkin.approveAll': 'Approved all check-ins',
  'worker.create': 'Added worker', 'worker.delete': 'Removed worker', 'worker.edit': 'Edited worker', 'worker.pin': 'Reset PIN', 'worker.email': 'Sign-in e-mail', 'checkin.restore': 'Restored rejected check-in', 'worker.email.bulk': 'Bulk sign-in e-mails', 'worker.revoke': 'Revoked phone sign-in',
  'order.create': 'Created order', 'order.delete': 'Deleted order', 'order.assign': 'Assigned order', 'order.unassign': 'Unassigned order',
  'production.edit': 'Edited work entry', 'production.delete': 'Deleted work entry', 'outbound.edit': 'Edited packed order', 'outbound.delete': 'Deleted packed order',
  'report.status': 'Report status', 'batch.status': 'Batch status', 'batch.delete': 'Deleted batch report', 'batch.bulk': 'Bulk batch upload mark',
  'expiry.status': 'Expiry status', 'expiry.delete': 'Deleted expiry correction', 'expiry.bulk': 'Bulk expiry upload mark',
  'putaway.assign': 'Assigned putaway', 'putaway.cancel': 'Cancelled putaway', 'putaway.delete': 'Deleted putaway', 'config.timers': 'Task timers switch',
  'sku.upload': 'SKU catalog upload', 'sku.clear': 'SKU catalog cleared', 'targets.update': 'Productivity targets',
  'adjust.add': 'Bonus / deduction added', 'adjust.delete': 'Bonus / deduction deleted', 'leave.add': 'Leave recorded', 'leave.delete': 'Leave deleted',
  'hr.settings': 'HR rules changed', 'hr.holiday': 'Holiday changed', 'payroll.export': 'Payroll export', 'payslip.view': 'Payslip opened', 'export.ledger': 'Ledger export',
  'admin.create': 'Admin created', 'admin.delete': 'Admin removed', 'admin.permissions': 'Permissions changed', 'admin.password': 'Password changed', 'admin.attach': 'Admin added to warehouse'
};
const auditLabel = a => AUDIT_LABELS[a] || a;

function auditDefaultRange() { const t = today(); auditTo = auditTo || t; auditFrom = auditFrom || hrAddDays(t, -7); }
function auditLoad() {
  if (!currentAdmin || !adminHasPerm('audit')) { auditRows = []; renderAudit(); return Promise.resolve(); }
  auditDefaultRange();
  auditLoading = true; auditError = ''; renderAudit();
  const lo = new Date(auditFrom + 'T00:00:00Z').getTime() - 86400000, hi = new Date(auditTo + 'T00:00:00Z').getTime() + 2 * 86400000;
  return wref('auditLog').orderByChild('at').startAt(lo).endAt(hi).limitToLast(2000).once('value').then(snap => {
    const list = []; snap.forEach(c => { const v = c.val(); if (v && v.at) list.push({ ...v, id: c.key }); });
    auditRows = list.filter(r => { const d = fmtDay(new Date(r.at).toISOString()); return d >= auditFrom && d <= auditTo; }).sort((a, b) => b.at - a.at);
  }).catch(e => { auditError = 'Could not load the audit log: ' + (e && e.message || 'error'); auditRows = []; })
    .then(() => { auditLoading = false; renderAudit(); });
}
function auditFiltered() {
  const actor = (document.getElementById('au-actor') || {}).value || '', act = (document.getElementById('au-action') || {}).value || '', text = ((document.getElementById('au-text') || {}).value || '').toLowerCase().trim();
  return auditRows.filter(r => (!actor || r.actorName === actor) && (!act || r.action === act) &&
    (!text || (String(r.summary || '') + ' ' + String(r.target && r.target.name || '') + ' ' + r.actorName).toLowerCase().includes(text)));
}
function renderAudit() {
  const root = document.getElementById('audit-root'); if (!root) return;
  if (!currentAdmin || !adminHasPerm('audit')) { root.innerHTML = '<div class="empty-state"><i class="ti ti-lock"></i>You do not have access to the audit log</div>'; return; }
  auditDefaultRange();
  const keep = {}; ['au-actor', 'au-action', 'au-text'].forEach(id => { const el = document.getElementById(id); if (el) keep[id] = el.value; });
  const focusId = document.activeElement && document.activeElement.id;
  const actors = Array.from(new Set(auditRows.map(r => r.actorName))).sort(), acts = Array.from(new Set(auditRows.map(r => r.action))).sort();
  const rows = auditFiltered();
  const body = rows.slice(0, 500).map((r, i) => {
    const iso = new Date(r.at).toISOString();
    const det = (r.detail !== undefined || r.target) ? '<details style="margin-top:2px"><summary style="cursor:pointer;color:var(--text3);font-size:11px">details</summary><pre style="white-space:pre-wrap;font-size:11px;margin:4px 0;max-width:420px">' + ftEsc(JSON.stringify({ target: r.target, detail: r.detail }, null, 1)) + '</pre></details>' : '';
    return '<tr><td style="white-space:nowrap">' + fmtDay(iso) + '<div style="color:var(--text3);font-size:11px">' + fmtClock(iso) + '</div></td><td>' + ftEsc(r.actorName) + '<div style="color:var(--text3);font-size:11px">' + ftEsc(r.actorRole || '') + '</div></td><td>' + ftEsc(auditLabel(r.action)) + '</td><td>' + ftEsc(r.summary || '') + det + '</td></tr>';
  }).join('');
  root.innerHTML =
    '<p class="section-title">Audit log</p><p style="font-size:12px;color:var(--text3);margin:0 0 8px">Who approved, edited, deleted or exported what. Entries are stamped with the server’s clock and cannot be changed or removed by anyone, including Super Admins.</p>' +
    '<div class="toolbar"><div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">From</div><input type="date" class="date-input" id="au-from" value="' + auditFrom + '" onchange="auditFrom=this.value;auditLoad()"></div>' +
    '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">To</div><input type="date" class="date-input" id="au-to" value="' + auditTo + '" onchange="auditTo=this.value;auditLoad()"></div>' +
    '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">Who</div><select id="au-actor" onchange="renderAudit()"><option value="">Everyone</option>' + actors.map(a => '<option>' + ftEsc(a) + '</option>').join('') + '</select></div>' +
    '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">Action</div><select id="au-action" onchange="renderAudit()"><option value="">All actions</option>' + acts.map(a => '<option value="' + ftEsc(a) + '">' + ftEsc(auditLabel(a)) + '</option>').join('') + '</select></div>' +
    '<div style="flex:1;min-width:140px"><div style="font-size:12px;color:var(--text2);margin-bottom:4px">Search</div><input type="text" id="au-text" placeholder="Worker, customer, SKU…" oninput="renderAudit()"></div>' +
    '<div style="align-self:flex-end"><button class="btn" onclick="auditLoad()"><i class="ti ti-refresh"></i></button> <button class="btn primary" onclick="auditExportCSV()"><i class="ti ti-download"></i> CSV</button></div></div>' +
    (auditError ? '<p style="color:var(--red-text);font-size:13px">' + ftEsc(auditError) + '</p>' : '') +
    '<div style="font-size:12px;color:var(--text3);margin:6px 0">' + (auditLoading ? 'Loading…' : rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') + (rows.length > 500 ? ' (showing the latest 500 — narrow the filters or export the CSV)' : '')) + '</div>' +
    (rows.length ? '<div class="card" style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th></tr></thead><tbody>' + body + '</tbody></table></div>' : (auditLoading ? '' : '<div class="empty-state"><i class="ti ti-list-search"></i>No entries match</div>'));
  ['au-actor', 'au-action', 'au-text'].forEach(id => { const el = document.getElementById(id); if (el && keep[id] != null) el.value = keep[id]; });
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) { f.focus(); if (f.setSelectionRange && f.type === 'text') { const n = f.value.length; f.setSelectionRange(n, n); } } }
}
function auditExportCSV() {
  const rows = auditFiltered(); if (!rows.length) { showToast('Nothing to export'); return; }
  downloadCsvRows([['Date', 'Time', 'Who', 'Role', 'Action', 'Summary', 'Target type', 'Target', 'Detail (JSON)'],
    ...rows.map(r => { const iso = new Date(r.at).toISOString(); return [fmtDay(iso), fmtClock(iso), r.actorName, r.actorRole || '', auditLabel(r.action), r.summary || '', r.target ? r.target.type : '', r.target ? r.target.name : '', r.detail !== undefined ? JSON.stringify(r.detail) : '']; })],
    'audit_log_' + auditFrom + '_to_' + auditTo + '.csv');
  audit('export.audit', 'Audit log exported (' + rows.length + ' entries, ' + auditFrom + ' → ' + auditTo + ')', { type: 'audit', id: 'export', name: 'Audit log' });
}
(function wrapAuditHooks() {
  const origTab = featuresOnTab;
  featuresOnTab = function (name) { origTab(name); if (name === 'audit') { auditLoad(); } };
  const origExport = exportCSV;
  exportCSV = function () { const r = origExport.apply(this, arguments); audit('export.ledger', 'Ledger exported (' + ledgerView + ' view, ' + ((document.getElementById('filter-from') || {}).value || 'start') + ' → ' + ((document.getElementById('filter-to') || {}).value || 'today') + ')', { type: 'ledger', id: 'export', name: 'Ledger' }); return r; };
  const origLogout = logoutAdmin;
  logoutAdmin = function () { auditRows = []; return origLogout.apply(this, arguments); };
})();
