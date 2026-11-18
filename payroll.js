// payroll.js — loaded after features.js. HR & payroll: shift settings, lateness,
// absence, leave, bonuses/deductions, net pay on the ledger, payslips, bank
// payout export. Admin-only data (permission "hr"): loaded on demand, never
// downloaded by worker phones.

const HR_DEFAULTS = { shiftStart: { morning: '08:00', night: '12:00' }, graceMins: 10, workdays: '123456', holidays: {}, lateDeduction: 0 };
let hrCfg = JSON.parse(JSON.stringify(HR_DEFAULTS));
let hrLeave = [], hrAdj = [], hrLoaded = false, hrLoading = null;
let hrFrom = '', hrTo = '';
let hrAdjTarget = null;
const HR_MAX_ABSENCE_DAYS = 92;

// ---------- date helpers (pure strings, no time-zone surprises) ----------
function hrAddDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function hrDow(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }       // 0=Sun … 6=Sat
function hrDaysBetween(a, b) { const out = []; for (let d = a; d <= b; d = hrAddDays(d, 1)) { out.push(d); if (out.length > 800) break; } return out; }
function hrHHMM(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; }
const hrFmtCache = {};                              // building an Intl formatter is slow; reuse one per time zone
function hrMinsOfDay(iso) {                       // minutes since midnight in the warehouse's own time zone (NaN when the time is missing/invalid)
  if (!iso || isNaN(new Date(iso).getTime())) return NaN;
  const tz = (typeof WAREHOUSE_TZ !== 'undefined' && WAREHOUSE_TZ[currentWarehouse]) || 'Africa/Lagos';
  const p = (hrFmtCache[tz] = hrFmtCache[tz] || new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })).formatToParts(new Date(iso));
  const h = +p.find(x => x.type === 'hour').value % 24, m = +p.find(x => x.type === 'minute').value;
  return h * 60 + m;
}
function hrMoney(n) { return (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function hrOnLeave(wid, d) { return hrLeave.some(l => sameId(l.workerId, wid) && l.from <= d && d <= l.to); }
function hrIsWorkday(d) { return String(hrCfg.workdays || '').includes(String(hrDow(d))) && !(hrCfg.holidays && hrCfg.holidays[d]); }

// ---------- load / save ----------
function hrLoad(force) {
  if (!currentAdmin || !adminHasPerm('hr')) return Promise.resolve(false);
  if (hrLoaded && !force) return Promise.resolve(false);
  if (hrLoading) return hrLoading;
  hrLoading = Promise.all([wref('hrSettings').once('value'), wref('leave').once('value'), wref('adjustments').once('value')]).then(([s, l, a]) => {
    const v = s.val() || {};
    hrCfg = {
      shiftStart: Object.assign({}, HR_DEFAULTS.shiftStart, v.shiftStart || {}),
      graceMins: v.graceMins != null ? +v.graceMins : HR_DEFAULTS.graceMins,
      workdays: typeof v.workdays === 'string' ? v.workdays : HR_DEFAULTS.workdays,
      holidays: v.holidays || {},
      lateDeduction: v.lateDeduction != null ? +v.lateDeduction : 0
    };
    hrLeave = []; l.forEach(c => { const x = c.val(); if (x && x.from && x.to) hrLeave.push({ ...x, id: c.key }); });
    hrAdj = []; a.forEach(c => { const x = c.val(); if (x && x.amount != null) hrAdj.push({ ...x, id: c.key }); });
    hrLeave.sort((a, b) => b.from.localeCompare(a.from)); hrAdj.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    hrLoaded = true; return true;
  }).catch(() => false).then(r => { hrLoading = null; return r; });
  return hrLoading;
}
function hrDefaultRange() {
  const t = today(); hrFrom = hrFrom || t.slice(0, 8) + '01'; hrTo = hrTo || t;
}

// ---------- computation ----------
function hrCompute(from, to, opts) {
  opts = opts || {};
  const tod = today(), grace = +hrCfg.graceMins || 0;
  const rows = {};
  const rowFor = (id, name) => { const k = id != null ? String(id) : 'n:' + name; return rows[k] = rows[k] || { key: k, id, name, w: null, days: 0, base: 0, lates: [], absent: [], leaveDays: 0, bonus: 0, deduction: 0, lateDed: 0, net: 0 }; };
  workers.forEach(w => { const r = rowFor(w.id, w.name); r.w = w; });
  checkins.filter(c => c.status === 'approved' && c.date >= from && c.date <= to).forEach(c => {
    const r = rowFor(c.workerId, c.workerName); r.days++; r.base += Number(c.pay) || 0;
    const st = c.shift && hrCfg.shiftStart[c.shift] ? hrHHMM(hrCfg.shiftStart[c.shift]) : null;
    if (st != null && c.checkinTime) { const late = hrMinsOfDay(c.checkinTime) - st; if (late > grace) r.lates.push({ date: c.date, mins: late, shift: c.shift }); }
  });
  const span = hrDaysBetween(from, to);
  const canAbsent = !opts.skipAbsence && span.length <= HR_MAX_ABSENCE_DAYS;
  Object.values(rows).forEach(r => {
    if (r.id == null) return;
    const attended = new Set(checkins.filter(c => sameId(c.workerId, r.id) && c.status !== 'rejected' && c.date >= from && c.date <= to).map(c => c.date));
    const start = r.w && r.w.startDate ? String(r.w.startDate).slice(0, 10) : '0000-00-00';
    span.forEach(d => {
      if (!hrIsWorkday(d) || d < start) return;
      if (hrOnLeave(r.id, d)) { r.leaveDays++; return; }
      if (canAbsent && d < tod && r.w && !attended.has(d)) r.absent.push(d);
    });
    hrAdj.filter(a => sameId(a.workerId, r.id) && a.date >= from && a.date <= to).forEach(a => { if (a.kind === 'bonus') r.bonus += +a.amount || 0; else r.deduction += +a.amount || 0; });
    r.lateDed = r.lates.length * (+hrCfg.lateDeduction || 0);
    r.net = r.base + r.bonus - r.deduction - r.lateDed;
  });
  const list = Object.values(rows).filter(r => r.days || r.absent.length || r.leaveDays || r.bonus || r.deduction);
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { list, absenceSkipped: !canAbsent && !opts.skipAbsence, span: span.length };
}

// ---------- the Payroll tab ----------
function renderPayroll() {
  const root = document.getElementById('payroll-root'); if (!root) return;
  if (!currentAdmin || !adminHasPerm('hr')) { root.innerHTML = '<div class="empty-state"><i class="ti ti-lock"></i>You do not have access to HR &amp; Payroll</div>'; return; }
  hrDefaultRange();
  const ids = ['hr-from', 'hr-to', 'hr-lv-worker', 'hr-lv-from', 'hr-lv-to', 'hr-lv-type', 'hr-lv-note', 'hr-ad-worker', 'hr-ad-date', 'hr-ad-kind', 'hr-ad-amount', 'hr-ad-reason', 'hr-hol-date', 'hr-hol-name', 'hr-st-morning', 'hr-st-night', 'hr-grace', 'hr-latededuct'];
  const keep = {}; ids.forEach(id => { const el = document.getElementById(id); if (el) keep[id] = el.value; });
  const focusId = document.activeElement && document.activeElement.id;
  const from = keep['hr-from'] || hrFrom, to = keep['hr-to'] || hrTo; hrFrom = from; hrTo = to;
  const cur = currencyLabel();
  const data = hrCompute(from, to);
  const wopts = '<option value="">Select worker…</option>' + workers.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(w => '<option value="' + ftEsc(w.id) + '">' + ftEsc(w.name) + '</option>').join('');
  const totals = data.list.reduce((t, r) => { t.base += r.base; t.bonus += r.bonus; t.ded += r.deduction + r.lateDed; t.net += r.net; return t; }, { base: 0, bonus: 0, ded: 0, net: 0 });
  const wd = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']].map(([v, l]) => '<label style="font-size:12.5px;display:flex;gap:3px;align-items:center"><input type="checkbox" class="hr-wd" value="' + v + '"' + (String(hrCfg.workdays).includes(v) ? ' checked' : '') + '>' + l + '</label>').join('');
  const hols = Object.keys(hrCfg.holidays || {}).sort().map(d => '<span style="display:inline-flex;gap:4px;align-items:center;background:var(--bg2,#eee);border-radius:20px;padding:2px 8px;font-size:12px;margin:2px">' + d + ' · ' + ftEsc(hrCfg.holidays[d]) + ' <a href="#" data-k="' + ftEsc(d) + '" onclick="hrRemoveHoliday(this.dataset.k);return false" style="text-decoration:none">✕</a></span>').join('');
  const sumRows = data.list.map(r => '<tr><td>' + ftEsc(r.name) + '</td><td style="text-align:center">' + r.days + '</td><td style="text-align:center">' + (r.lates.length ? '<b style="color:var(--amber-text)">' + r.lates.length + '</b>' : 0) + '</td><td style="text-align:center">' + (r.absent.length ? '<b style="color:var(--red-text)">' + r.absent.length + '</b>' : (data.absenceSkipped ? '–' : 0)) + '</td><td style="text-align:center">' + r.leaveDays + '</td><td style="text-align:right">' + hrMoney(r.base) + '</td><td style="text-align:right;color:var(--green-text)">' + (r.bonus ? '+' + hrMoney(r.bonus) : '') + '</td><td style="text-align:right;color:var(--red-text)">' + ((r.deduction + r.lateDed) ? '−' + hrMoney(r.deduction + r.lateDed) : '') + '</td><td style="text-align:right"><b>' + hrMoney(r.net) + '</b></td><td style="white-space:nowrap"><button class="btn" style="padding:3px 8px;font-size:12px" data-k="' + ftEsc(r.key) + '" onclick="hrShowPayslip(this.dataset.k)">Payslip</button></td></tr>').join('');
  const leaveRows = hrLeave.filter(l => l.to >= from && l.from <= to).map(l => '<tr><td>' + ftEsc(l.workerName) + '</td><td>' + l.from + ' → ' + l.to + '</td><td>' + ftEsc(l.type) + '</td><td>' + ftEsc(l.note || '') + '</td><td><button class="btn danger" style="padding:2px 7px" data-k="' + ftEsc(l.id) + '" onclick="hrDeleteLeave(this.dataset.k)"><i class="ti ti-trash"></i></button></td></tr>').join('');
  const adjRows = hrAdj.filter(a => a.date >= from && a.date <= to).map(a => '<tr><td>' + ftEsc(a.workerName) + '</td><td>' + a.date + '</td><td>' + (a.kind === 'bonus' ? '<span style="color:var(--green-text)">Bonus</span>' : '<span style="color:var(--red-text)">Deduction</span>') + '</td><td style="text-align:right">' + hrMoney(a.amount) + '</td><td>' + ftEsc(a.reason || '') + '</td><td><button class="btn danger" style="padding:2px 7px" data-k="' + ftEsc(a.id) + '" onclick="hrDeleteAdjustment(this.dataset.k)"><i class="ti ti-trash"></i></button></td></tr>').join('');
  const detail = data.list.flatMap(r => r.lates.map(l => ({ d: l.date, n: r.name, t: 'Late', x: l.mins + ' min after ' + (hrCfg.shiftStart[l.shift] || '') + ' (' + (l.shift || '') + ')' })).concat(r.absent.map(d => ({ d, n: r.name, t: 'Absent', x: 'no check-in, no leave' })))).sort((a, b) => b.d.localeCompare(a.d));
  const detRows = detail.slice(0, 200).map(x => '<tr><td>' + x.d + '</td><td>' + ftEsc(x.n) + '</td><td>' + (x.t === 'Late' ? '<span style="color:var(--amber-text)">Late</span>' : '<span style="color:var(--red-text)">Absent</span>') + '</td><td>' + ftEsc(x.x) + '</td></tr>').join('');
  const tbl = (head, body, empty) => body ? '<div class="card" style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:13px"><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>' : '<div class="empty-state" style="padding:12px">' + empty + '</div>';

  root.innerHTML =
    '<p class="section-title">Pay period</p><div class="toolbar"><div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">From</div><input type="date" class="date-input" id="hr-from" value="' + from + '" onchange="renderPayroll()"></div>' +
    '<div><div style="font-size:12px;color:var(--text2);margin-bottom:4px">To</div><input type="date" class="date-input" id="hr-to" value="' + to + '" onchange="renderPayroll()"></div></div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">' +
      ['Base pay (' + cur + ')|' + hrMoney(totals.base), 'Bonuses|+' + hrMoney(totals.bonus), 'Deductions|−' + hrMoney(totals.ded), 'Net payable|' + hrMoney(totals.net)].map(s => { const [l, v] = s.split('|'); return '<div class="stat-card" style="flex:1;min-width:120px"><div class="stat-label">' + l + '</div><div class="stat-value" style="font-size:18px">' + v + '</div></div>'; }).join('') + '</div>' +
    '<p class="section-title">Payroll summary</p>' + (data.absenceSkipped ? '<p style="font-size:12px;color:var(--amber-text)">Absence is only calculated for periods of ' + HR_MAX_ABSENCE_DAYS + ' days or less.</p>' : '') +
    tbl(['Worker', 'Days', 'Late', 'Absent', 'Leave', 'Base', 'Bonus', 'Deduct', 'Net', ''], sumRows, 'No attendance in this period') +
    '<div class="export-row" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" onclick="hrExportPayrollCSV()"><i class="ti ti-download"></i> Payroll CSV</button><button class="btn primary" onclick="hrExportPayout(\'csv\')"><i class="ti ti-building-bank"></i> Bank payout CSV</button><button class="btn primary" onclick="hrExportPayout(\'xlsx\')"><i class="ti ti-file-spreadsheet"></i> Bank payout Excel</button></div>' +
    '<p class="section-title" style="margin-top:18px">Bonuses &amp; deductions</p><div class="card"><div class="form-row"><div class="form-group"><label class="form-label">Worker</label><select id="hr-ad-worker">' + wopts + '</select></div>' +
      '<div class="form-group"><label class="form-label">Type</label><select id="hr-ad-kind"><option value="bonus">Bonus</option><option value="deduction">Deduction</option></select></div></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label">Amount (' + cur + ')</label><input type="number" min="0" step="any" inputmode="decimal" id="hr-ad-amount"></div><div class="form-group"><label class="form-label">Date</label><input type="date" class="date-input" id="hr-ad-date" value="' + today() + '"></div></div>' +
      '<div class="form-group"><label class="form-label">Reason</label><input type="text" id="hr-ad-reason" maxlength="140" placeholder="e.g. Top picker for the week / damaged carton"></div>' +
      '<button class="btn primary" onclick="hrAddAdjustment()" style="width:100%;justify-content:center;padding:9px">Add</button><p id="hr-ad-err" style="color:var(--red-text);font-size:12px;display:none;text-align:center"></p></div>' +
    tbl(['Worker', 'Date', 'Type', 'Amount', 'Reason', ''], adjRows, 'No bonuses or deductions in this period') +
    '<p class="section-title" style="margin-top:18px">Leave</p><div class="card"><div class="form-row"><div class="form-group"><label class="form-label">Worker</label><select id="hr-lv-worker">' + wopts + '</select></div><div class="form-group"><label class="form-label">Type</label><select id="hr-lv-type"><option>Annual</option><option>Sick</option><option>Unpaid</option><option>Other</option></select></div></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label">From</label><input type="date" class="date-input" id="hr-lv-from"></div><div class="form-group"><label class="form-label">To</label><input type="date" class="date-input" id="hr-lv-to"></div></div>' +
      '<div class="form-group"><label class="form-label">Note (optional)</label><input type="text" id="hr-lv-note" maxlength="140"></div>' +
      '<button class="btn primary" onclick="hrAddLeave()" style="width:100%;justify-content:center;padding:9px">Record leave</button><p id="hr-lv-err" style="color:var(--red-text);font-size:12px;display:none;text-align:center"></p></div>' +
    tbl(['Worker', 'Dates', 'Type', 'Note', ''], leaveRows, 'No leave in this period') +
    '<p class="section-title" style="margin-top:18px">Lateness &amp; absence detail</p>' + tbl(['Date', 'Worker', 'Issue', 'Detail'], detRows, 'No lateness or absence in this period') +
    '<p class="section-title" style="margin-top:18px">Rules</p><div class="card">' +
      '<div class="form-row"><div class="form-group"><label class="form-label">Morning shift starts</label><input type="time" id="hr-st-morning" value="' + ftEsc(hrCfg.shiftStart.morning) + '"></div><div class="form-group"><label class="form-label">Night shift starts</label><input type="time" id="hr-st-night" value="' + ftEsc(hrCfg.shiftStart.night) + '"></div></div>' +
      '<div class="form-row"><div class="form-group"><label class="form-label">Grace period (min)</label><input type="number" min="0" max="240" id="hr-grace" value="' + hrCfg.graceMins + '"></div><div class="form-group"><label class="form-label">Deduction per late (' + cur + ')</label><input type="number" min="0" step="any" id="hr-latededuct" value="' + hrCfg.lateDeduction + '"></div></div>' +
      '<div class="form-label" style="margin:6px 0 4px">Working days</div><div style="display:flex;gap:10px;flex-wrap:wrap">' + wd + '</div>' +
      '<div class="form-label" style="margin:10px 0 4px">Public holidays (not counted as absence)</div><div>' + (hols || '<span style="color:var(--text3);font-size:12px">None</span>') + '</div>' +
      '<div class="form-row" style="margin-top:6px"><div class="form-group"><input type="date" class="date-input" id="hr-hol-date"></div><div class="form-group"><input type="text" id="hr-hol-name" placeholder="Name" maxlength="60"></div><button class="btn" onclick="hrAddHoliday()" style="align-self:flex-start">Add</button></div>' +
      '<button class="btn primary" onclick="hrSaveSettings()" style="width:100%;justify-content:center;padding:9px;margin-top:8px">Save rules</button></div>';
  ids.forEach(id => { const el = document.getElementById(id); if (el && keep[id] != null && id !== 'hr-from' && id !== 'hr-to') el.value = keep[id]; });
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
}
function hrReload() { return hrLoad(true).then(() => safeRender('payroll', renderPayroll)); }
function hrErr(id, m) { const e = document.getElementById(id); if (e) { e.textContent = m; e.style.display = m ? 'block' : 'none'; } }
function hrWorker(id) { return workers.find(w => String(w.id) === String(id)); }

function hrSaveSettings() {
  if (!adminHasPerm('hr')) return;
  const v = id => document.getElementById(id).value;
  const cfg = {
    shiftStart: { morning: v('hr-st-morning'), night: v('hr-st-night') },
    graceMins: Math.max(0, Math.min(240, parseInt(v('hr-grace'), 10) || 0)),
    lateDeduction: Math.max(0, Number(v('hr-latededuct')) || 0),
    workdays: Array.from(document.querySelectorAll('.hr-wd')).filter(c => c.checked).map(c => c.value).join(''),
    holidays: hrCfg.holidays || {}
  };
  if (hrHHMM(cfg.shiftStart.morning) == null || hrHHMM(cfg.shiftStart.night) == null) { showToast('Enter both shift start times'); return; }
  if (!cfg.workdays) { showToast('Pick at least one working day'); return; }
  wref('hrSettings').set(cfg).then(() => { audit('hr.settings', 'HR rules updated', { type: 'hr', id: 'settings', name: 'HR rules' }, cfg); hrCfg = cfg; showToast('Rules saved'); renderPayroll(); }).catch(() => showToast('Could not save'));
}
function hrAddHoliday() {
  const d = document.getElementById('hr-hol-date').value, n = document.getElementById('hr-hol-name').value.trim() || 'Holiday';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { showToast('Pick the holiday date'); return; }
  wref('hrSettings/holidays/' + d).set(n.slice(0, 60)).then(() => { audit('hr.holiday', 'Holiday added: ' + d + ' ' + n, { type: 'hr', id: d, name: n }); hrCfg.holidays = Object.assign({}, hrCfg.holidays, { [d]: n }); renderPayroll(); });
}
function hrRemoveHoliday(d) {
  wref('hrSettings/holidays/' + d).remove().then(() => { audit('hr.holiday', 'Holiday removed: ' + d, { type: 'hr', id: d, name: d }); const h = Object.assign({}, hrCfg.holidays); delete h[d]; hrCfg.holidays = h; renderPayroll(); });
}
function hrAddAdjustment() {
  if (!adminHasPerm('hr')) return;
  const w = hrWorker(document.getElementById('hr-ad-worker').value), kind = document.getElementById('hr-ad-kind').value;
  const amount = Number(document.getElementById('hr-ad-amount').value), date = document.getElementById('hr-ad-date').value, reason = document.getElementById('hr-ad-reason').value.trim().slice(0, 140);
  if (!w) return hrErr('hr-ad-err', 'Choose a worker');
  if (!Number.isFinite(amount) || amount <= 0) return hrErr('hr-ad-err', 'Enter an amount above zero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return hrErr('hr-ad-err', 'Pick a date');
  if (!reason) return hrErr('hr-ad-err', 'Give a reason — it appears on the payslip and in the audit log');
  hrErr('hr-ad-err', '');
  const rec = { workerId: w.id, workerName: w.name, kind, amount, date, reason, createdBy: (currentAdmin && currentAdmin.username) || 'admin', createdAt: nowDate().toISOString() };
  const ref = wref('adjustments').push();
  ref.set(rec).then(() => { audit('adjust.add', (kind === 'bonus' ? 'Bonus ' : 'Deduction ') + hrMoney(amount) + ' for ' + w.name + ': ' + reason, { type: 'worker', id: w.id, name: w.name }, { kind, amount, date, reason }); document.getElementById('hr-ad-amount').value = ''; document.getElementById('hr-ad-reason').value = ''; hrReload(); }).catch(() => hrErr('hr-ad-err', 'Not allowed'));
}
function hrDeleteAdjustment(id) {
  const a = hrAdj.find(x => x.id === id); if (!a || !confirm('Delete this ' + a.kind + ' for ' + a.workerName + '?')) return;
  wref('adjustments/' + id).remove().then(() => { audit('adjust.delete', 'Deleted ' + a.kind + ' ' + hrMoney(a.amount) + ' for ' + a.workerName + ' (' + (a.reason || '') + ')', { type: 'worker', id: a.workerId, name: a.workerName }, a); hrReload(); });
}
function hrAddLeave() {
  if (!adminHasPerm('hr')) return;
  const w = hrWorker(document.getElementById('hr-lv-worker').value), from = document.getElementById('hr-lv-from').value, to = document.getElementById('hr-lv-to').value;
  if (!w) return hrErr('hr-lv-err', 'Choose a worker');
  if (!from || !to) return hrErr('hr-lv-err', 'Pick both dates');
  if (from > to) return hrErr('hr-lv-err', '“From” must not be after “To”');
  hrErr('hr-lv-err', '');
  const rec = { workerId: w.id, workerName: w.name, from, to, type: document.getElementById('hr-lv-type').value, note: document.getElementById('hr-lv-note').value.trim().slice(0, 140), createdBy: (currentAdmin && currentAdmin.username) || 'admin', createdAt: nowDate().toISOString() };
  wref('leave').push(rec).then(() => { audit('leave.add', rec.type + ' leave for ' + w.name + ' ' + from + ' → ' + to, { type: 'worker', id: w.id, name: w.name }, rec); hrReload(); }).catch(() => hrErr('hr-lv-err', 'Not allowed'));
}
function hrDeleteLeave(id) {
  const l = hrLeave.find(x => x.id === id); if (!l || !confirm('Delete this leave record for ' + l.workerName + '?')) return;
  wref('leave/' + id).remove().then(() => { audit('leave.delete', 'Deleted leave for ' + l.workerName + ' ' + l.from + ' → ' + l.to, { type: 'worker', id: l.workerId, name: l.workerName }, l); hrReload(); });
}

// ---------- exports & payslip ----------
function hrPeriodLabel() { return hrFrom + '_to_' + hrTo; }
function hrExportPayrollCSV() {
  const d = hrCompute(hrFrom, hrTo); if (!d.list.length) { showToast('Nothing to export'); return; }
  const cur = currencyLabel();
  downloadCsvRows([['Worker', 'Days worked', 'Late', 'Absent', 'Leave days', 'Base pay (' + cur + ')', 'Bonuses', 'Deductions', 'Late deductions', 'Net pay'],
    ...d.list.map(r => [r.name, r.days, r.lates.length, r.absent.length, r.leaveDays, r.base, r.bonus, r.deduction, r.lateDed, r.net])], 'payroll_' + hrPeriodLabel() + '.csv');
  audit('payroll.export', 'Payroll CSV exported for ' + hrFrom + ' → ' + hrTo, { type: 'payroll', id: hrPeriodLabel(), name: 'Payroll' }, { rows: d.list.length });
}
function hrPayoutRows() {
  const d = hrCompute(hrFrom, hrTo, { skipAbsence: true }); const ok = [], skipped = [];
  d.list.forEach(r => {
    if (r.net <= 0) return;
    const b = r.w ? bankDetailsOf(r.w) : { accountNumber: '', bankName: '' };
    if (!b.accountNumber || !b.bankName) { skipped.push(r.name); return; }
    ok.push({ name: r.name, accountNumber: b.accountNumber, bankName: b.bankName, amount: Math.round(r.net * 100) / 100 });
  });
  return { ok, skipped };
}
function hrExportPayout(kind) {
  if (!adminHasPerm('hr')) return;
  const { ok, skipped } = hrPayoutRows(); if (!ok.length) { showToast(skipped.length ? 'No bank details on file for: ' + skipped.join(', ') : 'Nothing payable in this period'); return; }
  const narr = 'Wages ' + hrFrom + ' to ' + hrTo;
  const rows = [['Account Name', 'Account Number', 'Bank', 'Amount (' + currencyLabel() + ')', 'Narration', 'Reference'], ...ok.map((r, i) => [r.name, r.accountNumber, r.bankName, r.amount, narr, 'WG' + hrTo.replace(/-/g, '') + String(i + 1).padStart(3, '0')])];
  if (kind === 'xlsx') {
    if (typeof XLSX === 'undefined') { showToast('Excel library failed to load — check your connection'); return; }
    const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 20 }, { wch: 14 }, { wch: 28 }, { wch: 16 }];
    ok.forEach((r, i) => { const c = ws['B' + (i + 2)]; if (c) { c.t = 's'; c.z = '@'; } });   // keep leading zeros in account numbers
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Payout'); XLSX.writeFile(wb, 'bank_payout_' + hrPeriodLabel() + '.xlsx');
  } else downloadCsvRows(rows, 'bank_payout_' + hrPeriodLabel() + '.csv');
  audit('payroll.export', 'Bank payout ' + kind.toUpperCase() + ' exported: ' + ok.length + ' workers, total ' + hrMoney(ok.reduce((s, r) => s + r.amount, 0)), { type: 'payroll', id: hrPeriodLabel(), name: 'Bank payout' }, { workers: ok.length, skippedNoBank: skipped });
  showToast(ok.length + ' payments exported' + (skipped.length ? ' — skipped (no bank details): ' + skipped.join(', ') : ''));
}
function hrShowPayslip(key) {
  const d = hrCompute(hrFrom, hrTo); const r = d.list.find(x => x.key === key); if (!r) return;
  const cur = currencyLabel(), b = r.w ? bankDetailsOf(r.w) : null;
  const adj = hrAdj.filter(a => sameId(a.workerId, r.id) && a.date >= hrFrom && a.date <= hrTo);
  const line = (l, v, cls) => '<tr><td>' + l + '</td><td style="text-align:right;' + (cls || '') + '">' + v + '</td></tr>';
  let ov = document.getElementById('payslip-overlay');
  if (!ov) {
    const st = document.createElement('style'); st.textContent = '@media print{body>*:not(#payslip-overlay){display:none!important}#payslip-overlay{position:static!important;background:#fff!important;padding:0!important}#payslip-overlay .no-print{display:none!important}}';
    document.head.appendChild(st); ov = document.createElement('div'); ov.id = 'payslip-overlay'; ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;overflow:auto;padding:16px'; document.body.appendChild(ov);
  }
  ov.style.display = 'block';
  ov.innerHTML = '<div style="background:#fff;color:#111;max-width:520px;margin:0 auto;border-radius:10px;padding:22px;font-size:14px;font-family:system-ui,sans-serif">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline"><h2 style="margin:0;font-size:18px">Payslip</h2><span style="color:#666;font-size:12px">' + ftEsc(currentWarehouse.replace('_', ' ')) + '</span></div>' +
    '<div style="margin:8px 0 12px;color:#444">' + ftEsc(r.name) + '<br><span style="font-size:12px;color:#777">' + hrFrom + ' → ' + hrTo + '</span>' + (b && b.accountNumber ? '<br><span style="font-size:12px;color:#777">' + ftEsc(b.bankName) + ' ••••' + ftEsc(String(b.accountNumber).slice(-4)) + '</span>' : '') + '</div>' +
    '<table style="width:100%;border-collapse:collapse" cellpadding="5">' + line('Days worked', r.days) + line('Base pay (' + cur + ')', hrMoney(r.base)) +
    adj.map(a => line((a.kind === 'bonus' ? 'Bonus' : 'Deduction') + ' — ' + ftEsc(a.reason || '') + ' <span style="color:#888;font-size:11px">' + a.date + '</span>', (a.kind === 'bonus' ? '+' : '−') + hrMoney(a.amount), a.kind === 'bonus' ? 'color:#0a7a3d' : 'color:#b3261e')).join('') +
    (r.lateDed ? line('Late arrivals deduction (' + r.lates.length + ' × ' + hrMoney(hrCfg.lateDeduction) + ')', '−' + hrMoney(r.lateDed), 'color:#b3261e') : '') +
    '<tr><td colspan="2"><hr></td></tr>' + line('<b>Net pay (' + cur + ')</b>', '<b>' + hrMoney(r.net) + '</b>') + '</table>' +
    '<div style="margin-top:12px;font-size:12px;color:#666">Late: ' + r.lates.length + ' · Absent: ' + (d.absenceSkipped ? 'n/a' : r.absent.length) + ' · Leave days: ' + r.leaveDays + '</div>' +
    '<div class="no-print" style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" style="flex:1;justify-content:center" onclick="window.print()"><i class="ti ti-printer"></i> Print / save PDF</button><button class="btn" style="flex:1;justify-content:center" onclick="hrClosePayslip()">Close</button></div></div>';
  audit('payslip.view', 'Payslip opened for ' + r.name + ' (' + hrFrom + ' → ' + hrTo + ')', { type: 'worker', id: r.id, name: r.name });
}
function hrClosePayslip() { const o = document.getElementById('payslip-overlay'); if (o) o.style.display = 'none'; }

// ---------- ledger: add bonus / deduction / net columns ----------
function hrAugmentLedger() {
  if (!currentAdmin || !adminHasPerm('hr') || !hrLoaded || ledgerView !== 'summary') return;
  const approved = getFilteredApproved(); const hd = document.getElementById('ledger-head'), tb = document.getElementById('ledger-body');
  if (!hd || !tb || !approved.length) return;
  const dates = approved.map(c => c.date).sort(); const from = (document.getElementById('filter-from') || {}).value || dates[0], to = (document.getElementById('filter-to') || {}).value || dates[dates.length - 1];
  const d = hrCompute(from, to, { skipAbsence: true }); const byKey = {}; d.list.forEach(r => { byKey[r.name] = r; });
  hd.innerHTML = '<tr><th>Worker</th><th>Grade</th><th style="text-align:center">Days</th><th style="text-align:right">Base (' + currencyLabel() + ')</th><th style="text-align:right">Bonus</th><th style="text-align:right">Deductions</th><th style="text-align:right">Net</th></tr>';
  const rows = d.list.filter(r => r.days).sort((a, b) => b.net - a.net);
  tb.innerHTML = rows.map(r => '<tr><td>' + ftEsc(r.name) + '</td><td><span class="badge ' + (r.w ? getType(r.w) : 'senior') + '">' + (r.w && getType(r.w) === 'probation' ? 'Probation' : 'Senior') + '</span></td><td style="text-align:center">' + r.days + '</td><td class="pay-cell" style="text-align:right">' + hrMoney(r.base) + '</td><td style="text-align:right;color:var(--green-text)">' + (r.bonus ? '+' + hrMoney(r.bonus) : '') + '</td><td style="text-align:right;color:var(--red-text)">' + ((r.deduction + r.lateDed) ? '−' + hrMoney(r.deduction + r.lateDed) : '') + '</td><td class="pay-cell" style="text-align:right"><b>' + hrMoney(r.net) + '</b></td></tr>').join('');
}
(function wrapPayrollHooks() {
  const origLedger = renderLedger;
  renderLedger = function () {
    origLedger.apply(this, arguments);
    if (currentAdmin && adminHasPerm('hr')) { if (!hrLoaded) hrLoad().then(ch => { if (ch) renderLedger(); }); else hrAugmentLedger(); }
  };
  const origTab = featuresOnTab;
  featuresOnTab = function (name) {
    origTab(name);
    if (name === 'payroll') { hrLoad(true).then(() => renderPayroll()); renderPayroll(); }
  };
  const origLogout = logoutAdmin;
  logoutAdmin = function () { hrLoaded = false; hrLeave = []; hrAdj = []; const o = document.getElementById('payslip-overlay'); if (o) o.style.display = 'none'; return origLogout.apply(this, arguments); };
})();
