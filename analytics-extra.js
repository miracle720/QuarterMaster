'use strict';
// Extra Analytics sections: period comparison, waiting times (packing + putaway), activity & idle time,
// scanner use, peak hours, pick-vs-pack accuracy. Pure reads of data the app already loads.
// Also flags check-ins with no work logged on the Approvals list.
const IDLE_MIN_MINS = 10;      // a gap shorter than this is normal turnaround
const BREAK_CAP_MINS = 90;     // a gap longer than this is treated as a break, not idle time
const axEsc = s => escHtml(s == null ? '' : String(s));
const axStat = (l, v, sub) => '<div class="stat-card"><div class="stat-label">' + l + '</div><div class="stat-value">' + v + '</div>' + (sub ? '<div style="font-size:11px;color:var(--text3)">' + sub + '</div>' : '') + '</div>';
const axAvg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const axTable = (head, rows, empty) => '<div class="log-wrap"><table><thead><tr>' + head.map(h => '<th' + (h[1] ? ' style="text-align:' + h[1] + '"' : '') + '>' + h[0] + '</th>').join('') + '</tr></thead><tbody>' +
  (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" style="text-align:center;color:var(--text3)">' + empty + '</td></tr>') + '</tbody></table></div>';
const axSub = (t, extra) => '<p class="section-title" style="font-size:12px;color:var(--text2);text-transform:none;letter-spacing:normal;margin-top:18px">' + t + (extra ? ' <span style="font-weight:400">' + extra + '</span>' : '') + '</p>';
const axNote = t => '<p style="font-size:11.5px;color:var(--text3)"><i class="ti ti-info-circle"></i> ' + t + '</p>';
function axRange() { return [document.getElementById('analytics-from').value || today(), document.getElementById('analytics-to').value || today()]; }
const axWorkerKey = (id, name) => id != null ? 'id:' + id : 'n:' + name;
const axCell = (s, al) => '<td' + (al ? ' style="text-align:' + al + '"' : '') + '>' + s + '</td>';

// ===== 1. This period vs the previous period of the same length =====
function renderComparison() {
  const root = document.getElementById('analytics-compare-root'); if (!root) return;
  const [from, to] = axRange();
  if (typeof analyticsRangeType !== 'undefined' && analyticsRangeType === 'all') { root.innerHTML = ''; return; }
  const n = hrDaysBetween(from, to).length, pTo = hrAddDays(from, -1), pFrom = hrAddDays(pTo, -(n - 1));
  const cur = computeAnalytics(from, to), prev = computeAnalytics(pFrom, pTo);
  const sum = (d, k) => Object.values(d.dailyMap).reduce((s, x) => s + (x[k] || 0), 0);
  const M = [
    ['Orders', cur.totalOrders, prev.totalOrders], ['SKUs', cur.totalSkus, prev.totalSkus], ['Orders picked', sum(cur, 'picked'), sum(prev, 'picked')], ['Orders packed', sum(cur, 'packed'), sum(prev, 'packed')],
    ['Approved check-ins', cur.approvedCI.length, prev.approvedCI.length], ['Workers', cur.uniqueWorkers.size, prev.uniqueWorkers.size],
    ['Avg orders / worker', cur.uniqueWorkers.size ? cur.totalOrders / cur.uniqueWorkers.size : 0, prev.uniqueWorkers.size ? prev.totalOrders / prev.uniqueWorkers.size : 0],
    ['Total pay (' + currencyLabel() + ')', cur.totalPay, prev.totalPay]
  ];
  const fmt = v => Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toLocaleString();
  const rows = M.map(([l, c, p]) => {
    const d = c - p, pct = p ? d / p * 100 : null, up = d > 0, flat = d === 0;
    const col = flat || l.startsWith('Total pay') ? 'var(--text2)' : (up ? 'var(--green-text)' : 'var(--red-text)');
    return '<tr><td>' + l + '</td>' + axCell(fmt(c), 'right') + axCell(fmt(p), 'right') + '<td style="text-align:right;color:' + col + '">' + (flat ? '—' : (up ? '▲ ' : '▼ ') + fmt(Math.abs(d)) + (pct != null ? ' (' + Math.abs(Math.round(pct)) + '%)' : '')) + '</td></tr>';
  });
  root.innerHTML = '<p class="section-title" style="margin-top:6px">Compared with the previous ' + n + ' day' + (n > 1 ? 's' : '') + ' <span style="font-weight:400;font-size:12px;color:var(--text3)">(' + pFrom + ' → ' + pTo + ')</span></p>' +
    axTable([['Measure'], ['This period', 'right'], ['Previous', 'right'], ['Change', 'right']], rows, '');
}

// ===== 2. Waiting times: packing and putaway (picking is in renderOrderTiming) =====
function renderWaitingExtras() {
  const [from, to] = axRange();
  const pk = document.getElementById('analytics-wait-packing-root'), pa = document.getElementById('analytics-wait-putaway-root');
  if (pk) {
    const rows = (production || []).filter(p => p.taskType === 'packing' && p.timed && p.date >= from && p.date <= to).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const waits = rows.filter(r => r.startDelaySecs != null).map(r => r.startDelaySecs), works = rows.filter(r => r.durationSecs != null).map(r => r.durationSecs);
    pk.innerHTML = axSub('Packing', '— order ready to pack → packer pressed Start') +
      '<div class="stat-grid stat-grid-4">' + axStat('Packed (timed)', rows.length) + axStat('Avg wait to start', fmtSecs(axAvg(waits))) + axStat('Longest wait', fmtSecs(waits.length ? Math.max(...waits) : null)) + axStat('Avg packing time', fmtSecs(axAvg(works))) + '</div>' +
      axTable([['Packer'], ['Customer'], ['Ready'], ['Started'], ['Wait to start', 'right'], ['Packing time', 'right'], ['SKUs', 'right']], rows.slice(0, 100).map(r => '<tr>' + axCell(axEsc(r.workerName)) + axCell(axEsc(r.customer || '')) + axCell(r.readyAt ? fmtClock(r.readyAt) : '—') + axCell(fmtClock(r.startedAt)) + axCell(fmtSecs(r.startDelaySecs), 'right') + axCell(r.durationSecs != null ? fmtSecs(r.durationSecs) : '—', 'right') + axCell(r.skus != null ? r.skus : '—', 'right') + '</tr>'), 'No timed packing in this range');
  }
  if (pa) {
    const rows = (putawayTasks || []).filter(t => { const d = fmtDay(t.assignedAt); return d >= from && d <= to && t.status !== 'cancelled'; }).sort((a, b) => (b.assignedAt || '').localeCompare(a.assignedAt || ''));
    const wOf = t => t.startDelaySecs != null ? t.startDelaySecs : (t.startedAt ? secsBetween(t.assignedAt, t.startedAt) : null);
    const waits = rows.map(wOf).filter(x => x != null), now = Date.now();
    const waiting = rows.filter(t => t.status === 'assigned'), stuck = waiting.filter(t => now - new Date(t.assignedAt).getTime() > 30 * 60000).length;
    pa.innerHTML = axSub('Putaway', '— task assigned → worker pressed Start') +
      '<div class="stat-grid stat-grid-4">' + axStat('Tasks assigned', rows.length) + axStat('Avg wait to start', fmtSecs(axAvg(waits))) + axStat('Longest wait', fmtSecs(waits.length ? Math.max(...waits) : null)) + axStat('Waiting over 30 min now', stuck) + '</div>' +
      axTable([['Worker'], ['Supplier'], ['Assigned'], ['Started'], ['Wait to start', 'right'], ['Duration', 'right'], ['Qty', 'right'], ['Status']], rows.slice(0, 100).map(t => '<tr>' + axCell(axEsc(t.workerName)) + axCell(axEsc(t.supplier || '')) + axCell(fmtDay(t.assignedAt) + ' ' + fmtClock(t.assignedAt)) + axCell(t.startedAt ? fmtClock(t.startedAt) : '—') +
        axCell(t.status === 'assigned' ? '<span style="color:var(--text3)">waiting ' + fmtSecs((now - new Date(t.assignedAt).getTime()) / 1000) + '</span>' : fmtSecs(wOf(t)), 'right') + axCell(t.durationMinutes != null ? t.durationMinutes + 'm' : '—', 'right') + axCell(t.qty != null ? t.qty : '—', 'right') + axCell(t.status) + '</tr>'), 'No putaway tasks in this range');
  }
}

// ===== 3. Activity: signed in but logged nothing; idle gaps =====
function axWorkedSet() {            // "workerKey|date" for every day a worker logged any work
  const s = new Set(); (production || []).forEach(p => { if (p.date) s.add(sameKey(p.workerId, p.workerName) + '|' + p.date); }); return s;
}
function sameKey(id, name) { return id != null ? String(id) : 'n:' + name; }
function checkinsWithoutWork(from, to) {
  const worked = axWorkedSet(), t = today();
  return (checkins || []).filter(c => c.status !== 'rejected' && c.date >= from && c.date <= to && !worked.has(sameKey(c.workerId, c.workerName) + '|' + c.date))
    .sort((a, b) => b.date.localeCompare(a.date) || (a.checkinTime || '').localeCompare(b.checkinTime || ''));
}
function axHoursSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : null; }
function idleGaps(from, to) {
  const days = {};
  (production || []).filter(p => p.date >= from && p.date <= to).forEach(p => {
    const end = p.doneAt || p.createdAt, start = p.startedAt || null; if (!end) return;
    const k = sameKey(p.workerId, p.workerName) + '|' + p.date; (days[k] = days[k] || { id: p.workerId, name: p.workerName, date: p.date, ev: [] }).ev.push({ start, end });
  });
  const ciBy = {}; (checkins || []).forEach(c => { if (c.status !== 'rejected' && c.checkinTime) ciBy[sameKey(c.workerId, c.workerName) + '|' + c.date] = c.checkinTime; });
  const per = {};
  Object.entries(days).forEach(([k, d]) => {
    d.ev.sort((a, b) => (a.start || a.end).localeCompare(b.start || b.end));
    let prevEnd = ciBy[k] || null;
    const w = per[sameKey(d.id, d.name)] = per[sameKey(d.id, d.name)] || { name: d.name, days: 0, idleMin: 0, gaps: 0, longest: 0, breaks: 0 };
    w.days++;
    d.ev.forEach(e => {
      if (e.start && prevEnd) {
        const m = (new Date(e.start) - new Date(prevEnd)) / 60000;
        if (m > BREAK_CAP_MINS) w.breaks++; else if (m >= IDLE_MIN_MINS) { w.idleMin += m; w.gaps++; w.longest = Math.max(w.longest, m); }
      }
      if (new Date(e.end) > new Date(prevEnd || 0)) prevEnd = e.end;
    });
  });
  return Object.values(per).sort((a, b) => b.idleMin - a.idleMin);
}
function renderActivity() {
  const root = document.getElementById('analytics-activity-root'); if (!root) return;
  const [from, to] = axRange(), t = today();
  const all = (checkins || []).filter(c => c.status !== 'rejected' && c.date >= from && c.date <= to);
  const none = checkinsWithoutWork(from, to), nowAll = none.filter(c => c.date === t);
  const rows = none.slice(0, 300).map(c => {
    const hrs = c.date === t ? axHoursSince(c.checkinTime) : null;
    const assigned = c.date === t ? (orders || []).filter(o => o.status === 'assigned' && getOrderAssignees(o).some(a => sameId(a.workerId, c.workerId) && !a.done)).length : 0;
    return '<tr>' + axCell(c.date) + axCell(axEsc(c.workerName)) + axCell(c.shift ? shiftLabel(c.shift) : '—') + axCell(c.checkinTime ? formatCheckinTime(c.checkinTime) : '—') +
      axCell(c.status === 'approved' ? '<span style="color:var(--green-text)">Approved</span>' : '<span style="color:var(--amber-text)">Pending</span>') +
      axCell(c.date === t ? (hrs != null ? 'nothing yet · ' + (Math.round(hrs * 10) / 10) + 'h since check-in' : 'nothing yet') + (assigned ? ' · ' + assigned + ' assigned order' + (assigned > 1 ? 's' : '') + ' open' : '') : 'nothing all day') + '</tr>';
  });
  const idle = idleGaps(from, to), totalIdle = idle.reduce((s, w) => s + w.idleMin, 0);
  root.innerHTML = '<div class="stat-grid stat-grid-4">' + axStat('Check-ins (not rejected)', all.length) + axStat('Logged nothing', none.length, all.length ? Math.round(none.length / all.length * 100) + '% of check-ins' : '') + axStat('Nothing logged so far today', nowAll.length) + axStat('Idle time (all workers)', Math.round(totalIdle) + ' min') + '</div>' +
    axSub('Signed in, but no work logged', '— check-ins with no picking, packing, putaway or replenishment entry that day') +
    axTable([['Date'], ['Worker'], ['Shift'], ['Checked in'], ['Check-in'], ['Work logged']], rows, 'Everyone who signed in logged work 🎉') +
    axNote('For today this is "so far" — people may still be working. Open assigned orders are shown because a worker can hold an order without having finished (and so logged) it yet.') +
    axSub('Idle time per worker', '— gaps of ' + IDLE_MIN_MINS + '–' + BREAK_CAP_MINS + ' min between finishing one task and starting the next') +
    axTable([['Worker'], ['Days', 'center'], ['Idle gaps', 'center'], ['Idle total', 'right'], ['Longest gap', 'right'], ['Long gaps (breaks)', 'center']], idle.map(w => '<tr>' + axCell(axEsc(w.name)) + axCell(w.days, 'center') + axCell(w.gaps, 'center') + axCell(Math.round(w.idleMin) + ' min', 'right') + axCell(w.longest ? Math.round(w.longest) + ' min' : '—', 'right') + axCell(w.breaks, 'center') + '</tr>'), 'No timed work in this range to measure gaps from') +
    axNote('A gap is only measured when the next task has a real Start time (timed putaway/packing/picking), counted from the end of the previous task — or from check-in for the first task of the day. Gaps over ' + BREAK_CAP_MINS + ' min are counted as breaks, not idle.');
}

// ===== 5. Scanner use =====
function axClock(s) { const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(s || '')); if (!m) return null; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + (+m[2]); }
function renderScannerStats() {
  const root = document.getElementById('analytics-scanners-root'); if (!root) return;
  const [from, to] = axRange(), t = today();
  const logs = (scannerLogs || []).filter(s => s.date >= from && s.date <= to);
  const info = s => { const a = axClock(s.pickedUpAt), b = axClock(s.returnedAt); const lost = s.autoClosed === true || (s.returnedAt == null && s.date < t); const open = s.returnedAt == null && s.date === t;
    return { s, lost, open, mins: !lost && !open && a != null && b != null && b >= a ? b - a : null }; };
  const L = logs.map(info), pocket = x => x.s.isMobile || x.s.scannerNum === 'Mobile' || x.s.scannerNum == null;
  const group = (keyFn, labelFn) => { const m = {}; L.forEach(x => { const k = keyFn(x); if (k == null) return; const g = m[k] = m[k] || { label: labelFn(x), n: 0, mins: [], lost: 0, last: '' }; g.n++; if (x.mins != null) g.mins.push(x.mins); if (x.lost) g.lost++; if ((x.s.date + ' ' + (x.s.pickedUpAt || '')) >= g.last) { g.last = x.s.date + ' ' + (x.s.pickedUpAt || ''); g.who = x.s.workerName; } }); return Object.entries(m).map(([k, g]) => Object.assign({ k }, g)); };
  const hold = m => m.length ? Math.round(axAvg(m)) + ' min' : '—';
  const bySc = group(x => pocket(x) ? 'Mobile' : String(x.s.scannerNum), x => pocket(x) ? 'Mobile phone' : 'Scanner ' + x.s.scannerNum).sort((a, b) => (+a.k || 999) - (+b.k || 999));
  const byW = group(x => x.s.workerName, x => x.s.workerName).sort((a, b) => b.n - a.n);
  const lostN = L.filter(x => x.lost).length, openN = L.filter(x => x.open).length, allM = L.filter(x => x.mins != null).map(x => x.mins);
  const idleScanners = []; for (let i = 1; i <= TOTAL_SCANNERS; i++) if (!bySc.some(g => g.k === String(i))) idleScanners.push(i);
  root.innerHTML = '<div class="stat-grid stat-grid-4">' + axStat('Pickups', L.length) + axStat('Avg time out', hold(allM)) + axStat('Not returned', lostN, 'auto-closed at 11:59 PM or left open') + axStat('Out right now', openN) + '</div>' +
    axSub('By scanner') + axTable([['Device'], ['Pickups', 'center'], ['Avg time out', 'right'], ['Not returned', 'center'], ['Last used by']], bySc.map(g => '<tr>' + axCell(g.label) + axCell(g.n, 'center') + axCell(hold(g.mins), 'right') + axCell(g.lost ? '<span style="color:var(--red-text)">' + g.lost + '</span>' : '0', 'center') + axCell(axEsc(g.who || '')) + '</tr>'), 'No scanner use in this range') +
    (idleScanners.length && logs.length ? axNote('Never used in this range: ' + idleScanners.map(i => 'Scanner ' + i).join(', ')) : '') +
    axSub('By worker') + axTable([['Worker'], ['Pickups', 'center'], ['Avg time out', 'right'], ['Not returned', 'center']], byW.map(g => '<tr>' + axCell(axEsc(g.label)) + axCell(g.n, 'center') + axCell(hold(g.mins), 'right') + axCell(g.lost ? '<span style="color:var(--red-text)">' + g.lost + '</span>' : '0', 'center') + '</tr>'), 'No scanner use in this range') +
    axNote('Time out = pickup to return as typed by the worker. Logs closed automatically at 11:59 PM (never returned) or still open from an earlier day count as "not returned" and are left out of the averages.');
}

// ===== 6. Peak hours =====
const axHour = iso => { const m = hrMinsOfDay(iso); return m >= 0 ? Math.floor(m / 60) : 24; };   // 24 = time missing/invalid: counted in a spare slot that is not shown
function renderPeakHours() {
  const root = document.getElementById('analytics-peak-root'); if (!root) return;
  const [from, to] = axRange(), inR = iso => { if (!iso) return false; const d = fmtDay(iso); return d >= from && d <= to; };
  const H = Array.from({ length: 25 }, () => ({ assigned: 0, picked: 0, packed: 0, checkins: 0 })), D = Array.from({ length: 8 }, () => ({ picked: 0, packed: 0 }));
  const dow = iso => { const d = new Date(fmtDay(iso) + 'T00:00:00Z').getUTCDay(); return d >= 0 ? d : 7; };   // 7 = unknown day, not shown
  (orders || []).forEach(o => {
    getOrderAssignees(o).forEach(a => { if (inR(a.assignedAt)) H[axHour(a.assignedAt)].assigned++; if (a.done && inR(a.doneAt)) { H[axHour(a.doneAt)].picked++; D[dow(a.doneAt)].picked++; } });
    if (inR(o.packedAt)) { H[axHour(o.packedAt)].packed++; D[dow(o.packedAt)].packed++; }
  });
  (checkins || []).forEach(c => { if (c.status !== 'rejected' && inR(c.checkinTime)) H[axHour(c.checkinTime)].checkins++; });
  const mx = k => Math.max(1, ...H.slice(0, 24).map(h => h[k]));
  const bar = (v, m, col) => '<div style="display:flex;align-items:center;gap:6px"><div style="height:10px;border-radius:3px;background:' + col + ';width:' + Math.round(v / m * 100) + '%;min-width:' + (v ? 2 : 0) + 'px"></div><span style="font-size:11.5px;color:var(--text2)">' + (v || '') + '</span></div>';
  const used = H.slice(0, 24).map((h, i) => [i, h]).filter(([, h]) => h.assigned + h.picked + h.packed + h.checkins > 0);
  const load = h => h.picked + h.packed, busiest = used.slice().sort((a, b) => load(b[1]) - load(a[1]))[0];
  const hl = i => (i % 12 || 12) + (i < 12 ? ' AM' : ' PM');
  const rows = used.map(([i, h]) => '<tr><td style="white-space:nowrap">' + hl(i) + '</td><td>' + bar(h.checkins, mx('checkins'), '#6b7280') + '</td><td>' + bar(h.assigned, mx('assigned'), '#3b82f6') + '</td><td>' + bar(h.picked, mx('picked'), '#f59e0b') + '</td><td>' + bar(h.packed, mx('packed'), '#22c55e') + '</td></tr>');
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  root.innerHTML = '<div class="stat-grid stat-grid-4">' + axStat('Busiest hour (picked + packed)', busiest && load(busiest[1]) ? hl(busiest[0]) : '—', busiest && load(busiest[1]) ? load(busiest[1]) + ' orders' : '') + axStat('Orders assigned', H.reduce((s, h) => s + h.assigned, 0)) + axStat('Orders picked', H.reduce((s, h) => s + h.picked, 0)) + axStat('Orders packed', H.reduce((s, h) => s + h.packed, 0)) + '</div>' +
    axSub('By hour of day', '— warehouse local time') +
    '<div class="log-wrap"><table><thead><tr><th>Hour</th><th>Check-ins</th><th>Assigned</th><th>Picked</th><th>Packed</th></tr></thead><tbody>' + (rows.join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No activity in this range</td></tr>') + '</tbody></table></div>' +
    axSub('By day of week') + axTable([['Day'], ['Picked', 'right'], ['Packed', 'right']], [1, 2, 3, 4, 5, 6, 0].map(i => '<tr>' + axCell(names[i]) + axCell(D[i].picked, 'right') + axCell(D[i].packed, 'right') + '</tr>'), '');
}

// ===== 4. Pick vs pack quantity =====
function renderAccuracy() {
  const root = document.getElementById('analytics-accuracy-root'); if (!root) return;
  const [from, to] = axRange();
  const pickBy = {}; (production || []).filter(p => p.taskType === 'picking' && p.orderId).forEach(p => { const g = pickBy[p.orderId] = pickBy[p.orderId] || { qty: 0, who: [] }; g.qty += +p.skus || 0; if (!g.who.includes(p.workerName)) g.who.push(p.workerName); });
  const rows = [];
  (production || []).filter(p => p.taskType === 'packing' && p.orderId && p.date >= from && p.date <= to).forEach(p => {
    const o = (orders || []).find(x => x.fbKey === p.orderId), pk = pickBy[p.orderId], pickedQty = pk ? pk.qty : (o && o.qtyPicked != null ? +o.qtyPicked : null);
    if (pickedQty == null) return;
    rows.push({ date: p.date, customer: p.customer || (o && o.customer) || '', picker: pk ? pk.who.join(', ') : '—', packer: p.workerName, picked: pickedQty, packed: +p.skus || 0 });
  });
  const bad = rows.filter(r => r.picked !== r.packed).sort((a, b) => b.date.localeCompare(a.date));
  const anyPacking = (production || []).some(p => p.taskType === 'packing' && p.date >= from && p.date <= to);
  root.innerHTML = '<div class="stat-grid stat-grid-4">' + axStat('Orders compared', rows.length) + axStat('Quantities match', rows.length - bad.length) + axStat('Mismatches', bad.length) + axStat('Match rate', rows.length ? Math.round((rows.length - bad.length) / rows.length * 100) + '%' : '—') + '</div>' +
    axSub('Picked quantity ≠ packed quantity') + axTable([['Date'], ['Customer'], ['Picked by'], ['Packed by'], ['Picked', 'right'], ['Packed', 'right'], ['Difference', 'right']], bad.map(r => '<tr>' + axCell(r.date) + axCell(axEsc(r.customer)) + axCell(axEsc(r.picker)) + axCell(axEsc(r.packer)) + axCell(r.picked, 'right') + axCell(r.packed, 'right') + axCell('<span style="color:var(--red-text)">' + (r.packed - r.picked > 0 ? '+' : '') + (r.packed - r.picked) + '</span>', 'right') + '</tr>'), rows.length ? 'Every compared order matches 🎉' : 'Nothing to compare in this range yet') +
    axNote('Orders do not store an expected quantity, so accuracy is measured as what the picker counted against what the packer counted for the same order. Only orders packed from this update onward are compared (older packing entries are not tied to a specific order)' + (anyPacking && !rows.length ? ' — packing was logged in this range, but none of it is linked to an order yet.' : '.'));
}

// ===== Approvals: flag check-ins with no work logged =====
function decorateApprovals() {
  const list = document.getElementById('approve-list'); if (!list || !currentAdmin) return;
  const worked = axWorkedSet(), t = today();
  list.querySelectorAll('.worker-card').forEach(card => {
    if (card.querySelector('.no-work-chip')) return;
    const m = /(?:approveCI|rejectCI|unapproveCI|restoreCI)\('([^']+)'\)/.exec(card.innerHTML); if (!m) return;
    const c = checkins.find(x => x.fbKey === m[1]); if (!c || c.status === 'rejected') return;
    if (worked.has(sameKey(c.workerId, c.workerName) + '|' + c.date)) return;
    const meta = card.querySelector('.worker-meta'); if (!meta) return;
    const chip = document.createElement('div'); chip.className = 'worker-meta no-work-chip'; chip.style.color = 'var(--amber-text)';
    chip.textContent = c.date === t ? '⚠ No work logged yet today' : '⚠ No work logged this day';
    meta.parentNode.appendChild(chip);
  });
}

(function wrapAnalyticsExtras() {
  const orig = renderAnalytics;
  renderAnalytics = function () { orig.apply(this, arguments); ['compare', 'waiting', 'activity', 'scanners', 'peak', 'accuracy'].forEach((k, i) => safeRender('ax-' + k, [renderComparison, renderWaitingExtras, renderActivity, renderScannerStats, renderPeakHours, renderAccuracy][i])); };
  const oa = renderApprovals;
  renderApprovals = function () { oa.apply(this, arguments); try { decorateApprovals(); } catch (e) { console.error('[decorateApprovals]', e); } };
})();
