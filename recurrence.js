/* Recurrence v2: one calendar-date definition shared by payments and linked orders. */
const crypto = require('node:crypto');
const { addDays } = require('./network-sales');
const { paymentLocalTimestamp } = require('./payment-timestamps');
const { linkOrdersToSettlements, daysBetween } = require('./transaction-linkage');
const { topMix } = require('./demand-intelligence');
const VERSION = 'recurrence-dates-v2';
const KEY_VERSION = 'mp-prefix-last4-approximate-v1';
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));
const sum = values => values.reduce((n, value) => n + value, 0);
const median = values => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const monday = date => addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
const monthOffset = (date, offset) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10); };
function dates(from, to) { const output = []; if (!validDate(from) || !validDate(to) || daysBetween(from, to) > 3660) return output; for (let day = from; day <= to; day = addDays(day, 1)) output.push(day); return output; }
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const normalizedRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toUpperCase().replace(/\s+/g, '_'), value]));
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
function localTimestamp(value) {
  const converted = paymentLocalTimestamp(value);
  if (converted) return converted;
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/);
  return match && validDate(match[1]) ? `${match[1]}T${match[2]}:${match[3] || '00'}` : null;
}
function instrumentKey(row, secret) {
  const prefix = String(row.CARD_INITIAL_NUMBER ?? '').replace(/^'+/, '').replace(/\.0+$/, '');
  const suffix = String(row.LAST_FOUR_DIGITS ?? '').replace(/^'+/, '').replace(/\.0+$/, '');
  if (!/^\d{6}(?:\d{2})?$/.test(prefix) || /^0+$/.test(prefix) || !/^\d{1,4}$/.test(suffix) || /^0+$/.test(suffix)) return null;
  return crypto.createHmac('sha256', secret).update(`${KEY_VERSION}|${prefix}|${suffix.padStart(4, '0')}`).digest('hex').slice(0, 24);
}
function normalizePayments(records, { secret = 'test-only', locationIds = [], until = '9999-12-31' } = {}) {
  const diagnostics = { rows: records.length, duplicates: 0, revised: 0, excluded: {}, unknownRefunds: 0, missingAccount: 0, missingStatus: 0 };
  const excluded = reason => { diagnostics.excluded[reason] = (diagnostics.excluded[reason] || 0) + 1; };
  const events = new Map();
  for (const record of records) {
    if (locationIds.length && !locationIds.includes(record.locationId)) continue;
    const row = normalizedRow(record.data), type = String(row.TRANSACTION_TYPE || '').toUpperCase();
    if (row.LIVE_MODE === false || String(row.LIVE_MODE).toLowerCase() === 'false' || String(row.TEST_MODE).toLowerCase() === 'true') { excluded('test'); continue; }
    const status = String(row.STATUS || row.PAYMENT_STATUS || '').toLowerCase();
    if (['pending', 'in_process', 'rejected', 'cancelled', 'canceled', 'failed', 'test'].includes(status)) { excluded(status); continue; }
    const timestamp = localTimestamp(row.TRANSACTION_DATE), amount = number(row.TRANSACTION_AMOUNT);
    const id = String(row.SOURCE_ID || '').trim().replace(/^'+/, '');
    if (!id || !timestamp || amount === null) { excluded('missing-identity-date-or-amount'); continue; }
    if (!['SETTLEMENT', 'REFUND', 'PARTIAL_REFUND', 'CHARGEBACK'].includes(type)) { excluded('unsupported-type'); continue; }
    const account = String(row.COLLECTOR_ID || row.ACCOUNT_ID || record.accountId || '').trim();
    const namespace = account ? `account:${account}` : `location:${record.locationId}`;
    const key = `${namespace}:${id}:${type}`;
    const entry = { id, namespace, key, locationId: record.locationId, dateTime: timestamp, date: timestamp.slice(0, 10), amount,
      instrumentKey: instrumentKey(row, secret), statusKnown: ['approved', 'captured', 'settled', 'refunded', 'partially_refunded'].includes(status),
      refunded: status === 'refunded', refundedAmount: number(row.REFUNDED_AMOUNT),
      originalId: String(row.ORIGINAL_SOURCE_ID || row.ORIGINAL_PAYMENT_ID || row.RELATED_SOURCE_ID || '').trim(),
      type, observedAt: record.observedAt || '', source: record.source || 'stored-report', accountKnown: Boolean(account) };
    const previous = events.get(key);
    if (previous) {
      if (JSON.stringify({ ...previous, observedAt: '' }) === JSON.stringify({ ...entry, observedAt: '' })) diagnostics.duplicates++;
      else { diagnostics.revised++; if (previous.observedAt > entry.observedAt) continue; }
    }
    events.set(key, entry);
  }
  const adjustments = new Map();
  for (const event of events.values()) if (event.type !== 'SETTLEMENT') {
    if (!event.originalId || !events.has(`${event.namespace}:${event.originalId}:SETTLEMENT`)) { diagnostics.unknownRefunds++; excluded('unlinked-adjustment'); continue; }
    const key = `${event.namespace}:${event.originalId}`;
    adjustments.set(key, (adjustments.get(key) || 0) + Math.abs(event.amount));
  }
  const payments = [];
  for (const event of events.values()) {
    if (event.type !== 'SETTLEMENT') continue;
    if (event.date > until) { excluded('after-cutoff'); continue; }
    if (event.refunded || event.amount <= 0) { excluded(event.refunded ? 'fully-refunded' : 'nonpositive'); continue; }
    const refund = Math.max(event.refundedAmount || 0, adjustments.get(`${event.namespace}:${event.id}`) || 0);
    const amount = Math.max(0, event.amount - refund);
    if (!amount) { excluded('fully-refunded'); continue; }
    if (!event.statusKnown) diagnostics.missingStatus++;
    if (!event.accountKnown) diagnostics.missingAccount++;
    const { refundedAmount, originalId, refunded, ...payment } = event;
    payments.push({ ...payment, amount, originalAmount: event.amount, adjusted: refund > 0,
      refundVerified: event.refundedAmount !== null || adjustments.has(`${event.namespace}:${event.id}`) });
  }
  payments.sort((a, b) => a.dateTime.localeCompare(b.dateTime) || a.key.localeCompare(b.key));
  return { payments, diagnostics, identityQuality: 'approximate', keyVersion: KEY_VERSION,
    monetaryBasis: 'Importe cobrado MP observado; composición de propinas y devoluciones no acreditada salvo evidencia explícita.' };
}
function history(payments) {
  const histories = new Map();
  for (const payment of payments) if (payment.instrumentKey) {
    const item = histories.get(payment.instrumentKey) || { alias: `MP-${payment.instrumentKey.slice(0, 12)}`, dates: new Set(), payments: 0 };
    item.dates.add(payment.date); item.payments++; histories.set(payment.instrumentKey, item);
  }
  for (const item of histories.values()) { item.dates = [...item.dates].sort(); item.first = item.dates[0]; item.last = item.dates.at(-1); }
  return histories;
}
function coverageFor(coverage, locationIds, from, to, source = 'mercadopago') {
  const days = dates(from, to);
  const locations = locationIds.map(locationId => {
    const segments = coverage.filter(c => c.locationId === locationId && c.source === source && c.complete && validDate(c.from) && validDate(c.to));
    const missing = days.filter(date => !segments.some(c => c.from <= date && c.to >= date));
    return { locationId, from, to, expectedDays: days.length, coveredDays: days.length - missing.length, missing, complete: Boolean(days.length) && !missing.length,
      evidence: [...new Set(segments.filter(c => c.from <= to && c.to >= from).map(c => c.evidenceId).filter(Boolean))] };
  });
  return { source, from, to, locations, complete: Boolean(days.length && locations.length) && locations.every(l => l.complete),
    coveredDays: days.filter(day => locations.every(l => !l.missing.includes(day))).length, expectedDays: days.length };
}
function lastCompleteDay(coverage, locationIds, requestedEnd, today) {
  const last = locationIds.map(locationId => coverage.filter(c => c.locationId === locationId && c.source === 'mercadopago' && c.complete && c.from <= requestedEnd)
    .map(c => ({ date: [c.to, requestedEnd, addDays(today, -1)].sort()[0], from: c.from })).filter(c => validDate(c.date) && c.date >= c.from).map(c => c.date).sort().at(-1));
  return last.length && last.every(Boolean) ? last.sort()[0] : null;
}
function effectiveCutoff(coverage, locationIds, requested) {
  const byLocation = locationIds.map(locationId => coverage.filter(c => c.locationId === locationId && c.source === 'mercadopago')
    .map(c => c.through || (c.complete ? `${c.to}T23:59:59` : null)).filter(Boolean).sort().at(-1));
  return byLocation.length && byLocation.every(Boolean) ? [requested, ...byLocation].sort()[0] : requested;
}
function resolvePeriod(query, today, confirmedDay) {
  const mode = query.period || 'last-28-days', end = confirmedDay || addDays(today, -1);
  let period;
  if (mode === 'last-28-days') period = { from: addDays(end, -27), to: end };
  else if (mode === 'today') period = { from: today, to: today };
  else if (mode === 'current-week') period = { from: monday(today), to: today };
  else if (mode === 'current-month') period = { from: `${today.slice(0, 7)}-01`, to: today };
  else if (mode === 'custom') period = { from: query.dateFrom, to: query.dateTo };
  else fail('Selecciona un período válido.');
  if (!validDate(period.from) || !validDate(period.to) || period.from > period.to || period.to > today || daysBetween(period.from, period.to) > 3660) fail('Selecciona fechas válidas, en orden y no futuras.');
  let previous;
  if (mode === 'today') previous = { from: addDays(today, -7), to: addDays(today, -7) };
  else if (mode === 'current-week') previous = { from: addDays(period.from, -7), to: addDays(period.to, -7) };
  else if (mode === 'current-month') {
    const previousStart = monthOffset(today, -1), previousEnd = addDays(`${today.slice(0, 7)}-01`, -1);
    const day = Math.min(Number(today.slice(8)), Number(previousEnd.slice(8)));
    period.to = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`;
    previous = { from: previousStart, to: `${previousStart.slice(0, 8)}${String(day).padStart(2, '0')}` };
  } else { const length = daysBetween(period.from, period.to) + 1; previous = { from: addDays(period.from, -length), to: addDays(period.from, -1) }; }
  return { ...period, mode, previous, commonMonthTruncation: mode === 'current-month' && period.to !== today };
}
function metric(value, unit, population, period, status, extras = {}) {
  return { value, unit, population, periodStart: period.from, periodEnd: period.to, asOf: period.to,
    source: 'mercadopago', status, definitionVersion: VERSION, ...extras };
}
function ratio(numerator, denominator, population, period, status, reason) {
  return metric(denominator ? round(numerator / denominator * 100) : null, 'percent', population, period,
    denominator ? status : status === 'no_data' ? 'no_data' : 'no_activity', { numerator, denominator, reason: denominator ? reason || null : reason || 'Sin base identificable' });
}
function inPeriod(payment, period, time = '23:59:59') { return payment.date >= period.from && payment.date <= period.to && (payment.date !== period.to || payment.dateTime.slice(11, 19) <= time); }
function classifyPayment(payment, histories) { return !payment.instrumentKey ? 'unidentified' : payment.date > histories.get(payment.instrumentKey).first ? 'return' : 'first'; }
function summarize(payments, histories, period, coverage, locationIds, cutoffTime = '23:59:59') {
  const selected = payments.filter(p => inPeriod(p, period, cutoffTime));
  const identified = selected.filter(p => p.instrumentKey), active = new Set(identified.map(p => p.instrumentKey));
  const days = new Map();
  for (const p of identified) { const key = `${p.instrumentKey}|${p.date}`; const row = days.get(key) || { instrumentKey: p.instrumentKey, date: p.date, amount: 0 }; row.amount += p.amount; days.set(key, row); }
  const dayRows = [...days.values()], returningDays = dayRows.filter(p => p.date > histories.get(p.instrumentKey).first);
  const identifiedAmount = sum(identified.map(p => p.amount)), returnAmount = sum(identified.filter(p => classifyPayment(p, histories) === 'return').map(p => p.amount));
  const returned = [...active].filter(key => histories.get(key).dates.filter(day => day <= period.to).length >= 2);
  const first = [...active].filter(key => histories.get(key).first >= period.from);
  const cov = coverageFor(coverage, locationIds, period.from, period.to);
  const status = cov.complete ? (selected.length ? 'complete' : 'no_activity') : selected.length ? 'partial' : 'no_data';
  const extras = { coverage: cov, identityQuality: 'approximate' };
  return { period, status, coverage: cov, payments: selected.length, identifiedPayments: identified.length,
    totalAmount: sum(selected.map(p => p.amount)), identifiedAmount, unidentifiedAmount: sum(selected.filter(p => !p.instrumentKey).map(p => p.amount)),
    firstAmount: identifiedAmount - returnAmount, returnAmount, days: dayRows.length, firstDays: dayRows.length - returningDays.length, returnDays: returningDays.length,
    active: metric(status === 'no_data' ? null : active.size, 'count', 'Instrumentos identificables activos en el período', period, status, extras),
    returning: ratio(returned.length, active.size, 'Instrumentos activos con compras en dos fechas distintas hasta el corte', period, status),
    firstObserved: first.length, knownBefore: active.size - first.length,
    returnDaysRate: ratio(returningDays.length, dayRows.length, 'Días con compra identificados', period, status),
    returnAmountRate: ratio(returnAmount, identifiedAmount, 'Importe de pagos identificados', period, status),
    identificationPayments: ratio(identified.length, selected.length, 'Todos los pagos observados', period, status),
    identificationAmount: ratio(identifiedAmount, sum(selected.map(p => p.amount)), 'Todo el importe MP observado', period, status) };
}
function frequency(histories, coverage, locationIds, D) {
  const period = { from: addDays(D, -27), to: D }, cov = coverageFor(coverage, locationIds, period.from, period.to);
  const rows = [['1 día', 1, 1], ['2–3 días', 2, 3], ['4–7 días', 4, 7], ['8–11 días', 8, 11], ['12–28 días', 12, 28]].map(([label, min, max]) => ({ label, min, max, instruments: 0, knownBefore: 0 }));
  const active = [];
  for (const [key, item] of histories) { const count = item.dates.filter(date => date >= period.from && date <= D).length; if (!count) continue;
    const row = rows.find(r => count >= r.min && count <= r.max); row.instruments++; if (item.first < period.from) row.knownBefore++; active.push({ key, days: count }); }
  rows.forEach(row => { row.percent = active.length ? round(row.instruments / active.length * 100) : null; });
  return { period, coverage: cov, status: cov.complete ? 'complete' : active.length ? 'partial' : 'no_data', active: active.length, rows,
    average: active.length ? round(sum(active.map(a => a.days)) / active.length, 2) : null,
    knownBefore: rows.reduce((n, row) => n + row.knownBefore, 0) };
}
function recency(histories, coverage, locationIds, D) {
  const period = { from: addDays(D, -89), to: D }, cov = coverageFor(coverage, locationIds, period.from, period.to);
  const rows = [[0, 7], [8, 14], [15, 30], [31, 60], [61, 89]].map(([min, max]) => ({ label: `${min}–${max} días`, min, max, instruments: 0 }));
  let older = 0;
  for (const item of histories.values()) { const until = item.dates.filter(d => d <= D); if (until.length < 2) continue; const age = daysBetween(until.at(-1), D); const row = rows.find(r => age >= r.min && age <= r.max); if (row) row.instruments++; else older++; }
  const total = sum(rows.map(r => r.instruments)); rows.forEach(r => { r.percent = total ? round(r.instruments / total * 100) : null; });
  return { period, coverage: cov, status: cov.complete ? 'complete' : total ? 'partial' : 'no_data', population: 'Instrumentos recurrentes con actividad en los últimos 90 días completos', total, older, rows };
}
function intervalSummary(histories, period) {
  const medians = [];
  for (const item of histories.values()) { const ds = item.dates.filter(d => d >= period.from && d <= period.to); if (ds.length > 1) medians.push(median(ds.slice(1).map((d, i) => daysBetween(ds[i], d)))); }
  return { value: median(medians), instruments: medians.length, unit: 'days', period, definition: 'Mediana de las medianas de intervalos por instrumento; fechas distintas, sin agregar la espera posterior a la última compra.' };
}
function buildCohorts(histories, coverage, locationIds, { from, to, D, granularity = 'week', commonBase = false } = {}) {
  if (!validDate(from) || !validDate(to) || from > to || to > D || daysBetween(from, to) > 3660) fail('Selecciona fechas de primera observación válidas y anteriores al corte de seguimiento.');
  if (!['week', 'month'].includes(granularity)) fail('Selecciona detalle semanal o mensual.');
  const rows = new Map();
  for (const item of histories.values()) {
    if (item.first < from || item.first > to) continue;
    const key = granularity === 'month' ? item.first.slice(0, 7) : monday(item.first);
    const row = rows.get(key) || { key, instruments: 0, horizons: Object.fromEntries([7, 14, 30].map(h => [h, { horizon: h, eligible: 0, returned: 0, pending: 0, excluded: 0 }])) };
    row.instruments++;
    for (const h of [7, 14, 30]) {
      const cell = row.horizons[h], follow = commonBase ? 30 : h;
      if (addDays(item.first, follow) > D) { cell.pending++; continue; }
      if (!coverageFor(coverage, locationIds, item.first, addDays(item.first, follow)).complete) { cell.excluded++; continue; }
      cell.eligible++; if (item.dates.some(d => d > item.first && daysBetween(item.first, d) <= h && d <= D)) cell.returned++;
    }
    rows.set(key, row);
  }
  for (const row of rows.values()) for (const cell of Object.values(row.horizons)) {
    cell.value = cell.eligible ? round(cell.returned / cell.eligible * 100) : null;
    cell.status = cell.eligible ? cell.excluded || cell.pending ? 'partial' : 'complete' : cell.excluded ? 'no_data' : 'immature';
    cell.smallBase = cell.eligible > 0 && cell.eligible < 30;
  }
  return { from, to, D, granularity, commonBase, rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    definition: 'Primera observación en el historial MP, incluidos los instrumentos que no volvieron. Seguimiento en días calendario completos y con cobertura acreditada.' };
}
function returnCard(histories, coverage, locationIds, D) {
  const period = { from: addDays(D, -119), to: addDays(D, -30) };
  const cohorts = buildCohorts(histories, coverage, locationIds, { ...period, D, granularity: 'month' });
  const values = cohorts.rows.map(r => r.horizons[30]);
  const eligible = sum(values.map(v => v.eligible)), returned = sum(values.map(v => v.returned)), excluded = sum(values.map(v => v.excluded));
  const result = ratio(returned, eligible, 'Primeras observaciones entre D−119 y D−30 con seguimiento completo', period, excluded ? 'partial' : 'complete');
  const entryCoverage = coverageFor(coverage, locationIds, period.from, period.to);
  return { ...result, status: eligible ? excluded ? 'partial' : 'complete' : excluded || !entryCoverage.complete ? 'no_data' : 'no_activity', asOf: D, excluded,
    reason: !eligible ? excluded ? 'Sin cobertura para verificar el seguimiento' : !entryCoverage.complete ? 'Sin primeras observaciones acreditadas en la ventana de entrada' : 'Sin instrumentos elegibles en la ventana de entrada' : null };
}
function compare(current, previous) {
  if (!current.coverage.complete || !previous.coverage.complete || !current.identifiedPayments || !previous.identifiedPayments) return { available: false, reason: 'Sin base comparable: faltan datos completos o denominador identificable.', period: previous.period };
  return { available: true, period: previous.period, activeDelta: current.active.value - previous.active.value,
    activePercent: previous.active.value ? round((current.active.value - previous.active.value) / previous.active.value * 100) : null,
    returnDaysPoints: round(current.returnDaysRate.value - previous.returnDaysRate.value),
    returnAmountPoints: round(current.returnAmountRate.value - previous.returnAmountRate.value), returningPoints: round(current.returning.value - previous.returning.value) };
}
function buildReport(source, query = {}) {
  const { today, cutoff = '23:59:59', locationIds, coverage = [] } = source;
  const requestedEnd = query.period === 'custom' ? query.dateTo : query.period && query.period !== 'last-28-days' ? today : addDays(today, -1);
  const D = lastCompleteDay(coverage, locationIds, requestedEnd, today), anchor = D || (requestedEnd < today ? requestedEnd : addDays(today, -1));
  const period = resolvePeriod(query, today, D);
  const requestedCutoff = period.to < today ? `${period.to}T23:59:59` : `${today}T${cutoff}`;
  const T = effectiveCutoff(coverage, locationIds, requestedCutoff);
  const normalized = normalizePayments(source.records, { secret: source.secret, locationIds, until: T.slice(0, 10) });
  const payments = normalized.payments.filter(p => p.dateTime <= T), histories = history(payments);
  const summary = summarize(payments, histories, period, coverage, locationIds, T.slice(11));
  const priorPayments = payments.filter(p => p.date <= period.previous.to), priorHistories = history(priorPayments);
  summary.comparison = compare(summary, summarize(priorPayments, priorHistories, period.previous, coverage, locationIds, T.slice(11)));
  const weeks = Array.from({ length: 12 }, (_, i) => { const from = addDays(monday(anchor), (i - 11) * 7), to = [addDays(from, 6), anchor].sort()[0]; return summarize(payments, histories, { from, to }, coverage, locationIds); });
  const months = Array.from({ length: 6 }, (_, i) => { const from = monthOffset(anchor, i - 5), to = [addDays(monthOffset(from, 1), -1), anchor].sort()[0]; return summarize(payments, histories, { from, to }, coverage, locationIds); });
  const interval = intervalSummary(histories, { from: addDays(anchor, -89), to: anchor });
  const cohortDefaults = { from: monthOffset(anchor, -5), to: anchor, D: anchor, granularity: 'week', commonBase: false };
  const eligibilityPartial = (normalized.diagnostics.excluded['missing-identity-date-or-amount'] || 0) > 0 || normalized.diagnostics.missingStatus > 0 || normalized.diagnostics.unknownRefunds > 0 || (source.warnings || []).length > 0;
  if (eligibilityPartial) {
    if (summary.status === 'complete') summary.status = 'partial';
    for (const value of Object.values(summary)) if (value && typeof value === 'object' && value.status === 'complete') value.status = 'partial';
    summary.comparison = { available: false, reason: 'Sin base comparable: estados de pago, ajustes o lectura de fuentes no acreditados por completo.', period: period.previous };
    for (const row of [...weeks, ...months]) if (row.status === 'complete') row.status = 'partial';
  }
  const report = { definitionVersion: VERSION, keyVersion: KEY_VERSION, generatedAt: new Date().toISOString(),
    scope: source.scope, locationIds, today, period, asOf: T, lastCompleteDay: D, observationDay: anchor,
    warnings: [...new Set([...(source.warnings || []),
      'Identidad aproximada: un medio de pago no equivale a una persona.',
      ...(normalized.payments.some(p => p.adjusted) || normalized.diagnostics.excluded['fully-refunded'] ? ['Los importes reflejan los ajustes conocidos: una devolución posterior puede revisar series anteriores.'] : []),
      ...(locationIds.length > 1 ? ['Consolidado aproximado: no está acreditada una identidad global entre cuentas de pago.'] : []),
      ...(normalized.diagnostics.missingStatus ? ['Los reportes SETTLEMENT acreditan operaciones observadas, no todos los estados de aprobación y devolución.'] : []),
      ...(!D ? ['No existe evidencia suficiente de un último día completamente cubierto. Los datos observados son provisionales.'] : [])])],
    eligibilityPartial, summary, trend: { weeks, months }, frequency: frequency(histories, coverage, locationIds, anchor), recency: recency(histories, coverage, locationIds, anchor),
    interval, return30: returnCard(histories, coverage, locationIds, anchor), cohortDefaults,
    quality: { identificationPayments: summary.identificationPayments, identificationAmount: summary.identificationAmount, coverage,
      diagnostics: normalized.diagnostics, monetaryBasis: normalized.monetaryBasis, keyQuality: 'approximate',
      refunds: normalized.payments.every(p => p.refundVerified) && normalized.payments.length ? 'verified-fields' : 'unavailable', purchases: null },
    fieldMapping: { paymentId: 'SOURCE_ID (ámbito de cuenta cuando existe; local en caso contrario)', type: 'TRANSACTION_TYPE=SETTLEMENT',
      date: 'TRANSACTION_DATE → America/Santiago', amount: 'TRANSACTION_AMOUNT, sin inferir neto ni propina', instrument: 'CARD_INITIAL_NUMBER + LAST_FOUR_DIGITS → alias HMAC aproximado',
      refund: 'REFUNDED_AMOUNT o ajuste con ORIGINAL_SOURCE_ID / ORIGINAL_PAYMENT_ID / RELATED_SOURCE_ID; no inferir vínculos' } };
  for (const value of Object.values(summary)) if (value && typeof value === 'object' && value.definitionVersion === VERSION) value.asOf = T;
  report.return30.asOf = T;
  const priorFrequency = frequency(histories, coverage, locationIds, addDays(anchor, -28));
  report.frequency.comparison = !eligibilityPartial && report.frequency.coverage.complete && priorFrequency.coverage.complete
    ? { available: true, period: priorFrequency.period, activeDelta: report.frequency.active - priorFrequency.active, averageDelta: report.frequency.average !== null && priorFrequency.average !== null ? round(report.frequency.average - priorFrequency.average, 2) : null }
    : { available: false, reason: 'Sin base comparable de dos ventanas completas de 28 días.' };
  if (eligibilityPartial) {
    for (const value of [report.frequency, report.recency, report.return30]) if (value.status === 'complete') value.status = 'partial';
  }
  return { report, payments, histories, normalized };
}
function validationForCohorts(result, partial) {
  if (partial) for (const row of result.rows) for (const cell of Object.values(row.horizons)) if (cell.status === 'complete') { cell.status = 'partial'; cell.unverifiedPayments = true; }
  return { ...result, paymentValidation: partial ? 'partial' : 'complete' };
}
function paymentDetails(state, kind = 'active') {
  const { payments, histories, report } = state;
  return payments.filter(p => inPeriod(p, report.period, report.asOf.slice(11))).filter(p => kind !== 'return' || classifyPayment(p, histories) === 'return').map(p => ({
    alias: p.instrumentKey ? histories.get(p.instrumentKey).alias : 'No identificable', date: p.date, time: p.dateTime.slice(11), locationId: p.locationId,
    classification: classifyPayment(p, histories), amount: p.amount, sourcePaymentId: p.id, adjusted: p.adjusted }));
}
function eligibleOrderLines(lines, rawProducts = []) {
  // The same product can occur as both a sold root line and a component in one order.
  const childCodes = new Set(rawProducts.filter(l => l.lineReference).map(l => String(l.id)));
  const remaining = new Map([...childCodes].map(code => [code, sum(rawProducts.filter(l => String(l.id) === code && !l.lineReference).map(l => Number(l.quantity) || 0))]));
  return lines.map(line => {
    if (!remaining.has(line.code)) return { ...line };
    const quantity = Math.max(0, Math.min(line.quantity, remaining.get(line.code)));
    remaining.set(line.code, remaining.get(line.code) - quantity);
    return { ...line, quantity, isComponent: quantity === 0 };
  });
}
function buildPurchases(state, orders, coverage = []) {
  const knownSum = values => values.some(v => v === null || v === undefined || !Number.isFinite(v)) ? null : sum(values);
  const { payments, histories, report } = state;
  const settlements = payments.map(p => ({ ...p, instrumentKey: p.instrumentKey }));
  const candidates = orders.filter(o => o.date >= report.period.from && o.date <= report.period.to && o.date <= report.asOf.slice(0, 10) && (!o.dateTime || o.dateTime <= report.asOf) && !o.reversalSignals?.length);
  const referenceOwners = new Map();
  for (const order of candidates) for (const id of order.explicitPaymentIds || []) { const k = `${order.locationId}:${id}`; referenceOwners.set(k, (referenceOwners.get(k) || 0) + 1); }
  const explicitIds = new Set([...referenceOwners.keys()]);
  const linked = linkOrdersToSettlements(candidates.filter(o => !o.explicitPaymentIds?.length).map(o => ({ ...o, netSales: null })), settlements.filter(p => !explicitIds.has(`${p.locationId}:${p.id}`)), { maximumMinutes: 2, amountTolerance: 2 });
  const paymentByKey = new Map(payments.map(p => [p.key, p]));
  const groups = new Map([['first', []], ['return', []]]), unclassified = [], details = [];
  let resolvedLinks = 0, explicitLinks = 0;
  for (const order of candidates) {
    const link = linked.links.get(order.orderKey);
    let payment = link?.status === 'estimated-high' ? paymentByKey.get(link.settlementKey) : null;
    const references = order.explicitPaymentIds || [];
    const explicit = references.map(id => payments.find(p => p.locationId === order.locationId && p.id === id));
    const explicitUnique = references.length > 0 && explicit.every(Boolean) && references.every(id => referenceOwners.get(`${order.locationId}:${id}`) === 1);
    const instruments = new Set(explicit.filter(Boolean).map(p => p.instrumentKey));
    if (explicitUnique && instruments.size === 1 && !instruments.has(null)) payment = explicit[0];
    if (payment) { resolvedLinks++; if (explicitUnique) explicitLinks++; }
    let reason = link?.status === 'ambiguous' ? 'Vínculo ambiguo' : !payment ? 'Sin vínculo confiable' : !payment.instrumentKey ? 'Pago no identificable' : null;
    // A partial due amount cannot stand in for the whole order, nor for multiple instruments.
    if ((order.paymentDuePartial || order.paymentTotalAmbiguous || order.multipleInstruments) && !(explicitUnique && instruments.size === 1 && payment)) reason = 'Pago dividido, mixto o múltiples instrumentos sin atribución comprobada';
    if (order.dateTime && order.dateTime > report.asOf) reason = 'Posterior al corte';
    if (references.length && (!explicitUnique || instruments.size !== 1 || instruments.has(null))) reason = 'Referencia explícita ambigua o múltiples instrumentos';
    const lines = (order.lines || []).filter(l => !l.isExtra && !l.extraHierarchyId && !l.isComponent && !l.parentLineId && l.quantity > 0);
    const clean = { ...order, lines };
    const category = reason ? 'unclassified' : classifyPayment(payment, histories);
    if (reason) unclassified.push({ reason, netSales: order.netSales }); else groups.get(category).push(clean);
    details.push({ orderKey: order.orderKey, date: order.date, time: order.time, locationId: order.locationId,
      alias: payment?.instrumentKey ? histories.get(payment.instrumentKey).alias : 'No identificable', classification: category, reason,
      linkMethod: payment ? explicitUnique ? 'explicit-reference' : 'inferred-local-date-amount-2min' : null, monetaryVerified: order.monetaryVerified || false,
      netSales: order.netSales, ticketGross: Number.isFinite(order.ticketGross) ? order.ticketGross : null, units: sum(lines.map(l => l.quantity)), products: lines.map(l => `${l.code} · ${l.name} × ${l.quantity}`).join(' · ') });
  }
  const rows = [...groups].map(([key, values]) => ({ key, label: key === 'first' ? 'Pedidos de primera fecha observada' : 'Pedidos de regreso', orders: values.length,
    netSales: knownSum(values.map(o => o.netSales)), medianTicketGross: median(values.map(o => o.ticketGross).filter(Number.isFinite)),
    unitsPerOrder: values.length ? round(sum(values.flatMap(o => o.lines).map(l => l.quantity)) / values.length, 2) : null,
    mix: topMix(values, 3), takeaway: values.filter(o => o.mode === 'takeaway').length, unknownMode: values.filter(o => !['takeaway', 'dineIn'].includes(o.mode)).length }));
  const allSales = knownSum(candidates.map(o => o.netSales)), classifiable = sum(rows.map(r => r.orders)), classifiedSales = knownSum(rows.map(r => r.netSales));
  const reasons = [...new Set(unclassified.map(o => o.reason))].map(reason => ({ reason, orders: unclassified.filter(o => o.reason === reason).length, netSales: knownSum(unclassified.filter(o => o.reason === reason).map(o => o.netSales)) }));
  const sourceCoverage = coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'sales');
  const paymentCoverage = coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'payment-details');
  const ambiguous = unclassified.filter(o => /ambigu|múltiples/i.test(o.reason)).length;
  const linkage = { ...linked.coverage, orders: candidates.length, linkedHigh: resolvedLinks, explicit: explicitLinks, ambiguous,
    unlinked: Math.max(0, candidates.length - resolvedLinks - ambiguous), linkedPercent: candidates.length ? round(resolvedLinks / candidates.length * 100) : null };
  return { rows, details, period: report.period, asOf: report.asOf, coverage: sourceCoverage, paymentCoverage, linkage, reasons,
    quality: { orders: candidates.length, linked: resolvedLinks, classifiable, monetaryVerifiedOrders: candidates.filter(o => o.monetaryVerified).length, netSales: allSales, classifiedSales,
      orderCoveragePercent: candidates.length ? round(classifiable / candidates.length * 100) : null,
      salesCoveragePercent: allSales && classifiedSales !== null ? round(classifiedSales / allSales * 100) : null },
    monetaryBasis: 'Ticket Toteat después de descuentos, sin propina. Venta neta solo cuando total, descuentos e impuestos originales permiten verificarla; de lo contrario no disponible. No se divide MercadoPago por 1,19.',
    status: sourceCoverage.complete && paymentCoverage.complete && report.summary.coverage.complete && !report.eligibilityPartial && allSales !== null ? 'complete' : candidates.length ? 'partial' : 'no_data' };
}
module.exports = { VERSION, KEY_VERSION, validDate, localTimestamp, instrumentKey, normalizePayments, history, coverageFor, lastCompleteDay,
  effectiveCutoff, validationForCohorts, resolvePeriod, summarize, classifyPayment, frequency, recency, intervalSummary, buildCohorts, returnCard, compare, buildReport, buildPurchases,
  paymentDetails, eligibleOrderLines, dates, median, monday, monthOffset };
