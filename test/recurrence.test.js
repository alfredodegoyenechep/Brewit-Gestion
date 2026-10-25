const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../recurrence');
const { createRecurrenceService } = require('../recurrence-service');
const coverage = [{ source: 'mercadopago', locationId: 'a', from: '2026-01-01', to: '2026-12-31', complete: true, evidenceId: 'fixture' }];
const row = (id, date, card = '1111', amount = 10, locationId = 'a', extra = {}) => ({ locationId, data: { SOURCE_ID: id, TRANSACTION_DATE: date.includes('T') ? date : `${date}T10:00:00`,
  TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: amount, CARD_INITIAL_NUMBER: card ? '123456' : null, LAST_FOUR_DIGITS: card,
  STATUS: 'approved', REFUNDED_AMOUNT: 0, ...extra }, observedAt: '2026-11-10T00:00:00Z' });
const fixture = () => [row('c0', '2026-09-20', '3333'), row('a1', '2026-10-01', '1111'), row('a2', '2026-10-01', '1111', 5),
  row('b', '2026-10-02', '2222', 30), row('c', '2026-10-02', '3333', 40), row('a3', '2026-10-03', '1111', 20), row('n', '2026-10-03', null, 25)];
const source = (records = fixture(), extra = {}) => ({ records, today: '2026-10-08', locationIds: ['a'], scope: { location: 'a', label: 'Cafetería A' }, coverage, secret: 'fixture-secret', ...extra });
const report = (records, query = {}, extra = {}) => r.buildReport(source(records, extra), { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', ...query });

test('fixture 12.1: instruments, dates, money, identification and previous history have distinct denominators', () => {
  const { report: data } = report(); const s = data.summary;
  assert.equal(s.payments, 6); assert.equal(s.identifiedPayments, 5); assert.equal(s.active.value, 3);
  assert.equal(s.returning.numerator, 2); assert.equal(s.returning.value, 66.7);
  assert.equal(s.firstObserved, 2); assert.equal(s.knownBefore, 1);
  assert.equal(s.days, 4); assert.equal(s.firstDays, 2); assert.equal(s.returnDays, 2); assert.equal(s.returnDaysRate.value, 50);
  assert.equal(s.identifiedAmount, 105); assert.equal(s.firstAmount, 45); assert.equal(s.returnAmount, 60);
  assert.equal(s.returnAmountRate.value, 57.1); assert.equal(s.totalAmount, 130); assert.equal(s.unidentifiedAmount, 25);
  assert.equal(s.identificationPayments.value, 83.3); assert.equal(s.identificationAmount.value, 80.8);
  assert.equal(Math.round(s.returnAmount / s.totalAmount * 1000) / 10, 46.2);
});
test('1: same-day payments make one purchase date and no completed interval', () => {
  const data = report([row('1', '2026-10-01'), row('2', '2026-10-01T11:00:00')]);
  assert.equal(data.report.summary.days, 1); assert.equal(data.report.summary.returnDays, 0); assert.equal(data.report.interval.value, null);
});
test('2: Santiago dates follow offsets across UTC midnight and daylight-saving changes', () => {
  const data = r.normalizePayments([row('1', '2026-10-02T01:00:00Z'), row('2', '2026-10-01T23:00:00-03:00'), row('3', '2026-10-02T03:10:00Z')]);
  assert.deepEqual(data.payments.map(p => p.date), ['2026-10-01', '2026-10-01', '2026-10-02']);
  assert.equal(r.localTimestamp('2026-09-06T03:30:00Z'), '2026-09-05T23:30:00');
  assert.equal(r.localTimestamp('2026-09-06T04:30:00Z'), '2026-09-06T01:30:00');
});
test('3: a sole purchase in P is a return if an earlier purchase exists', () => {
  const data = report([row('1', '2026-09-01'), row('2', '2026-10-01')]).report.summary;
  assert.equal(data.returnDays, 1); assert.equal(data.returning.value, 100);
});
test('4: a later purchase cannot change a historical classification', () => {
  const data = report([row('1', '2026-10-01'), row('2', '2026-11-01')]).report.summary;
  assert.equal(data.returning.value, 0); assert.equal(data.returnAmount, 0);
});
test('5: immature returns are outside both numerator and denominator', () => {
  const state = report([row('1', '2026-10-01'), row('2', '2026-10-03')]);
  const cohort = r.buildCohorts(state.histories, coverage, ['a'], { from: '2026-10-01', to: '2026-10-07', D: '2026-10-07' }).rows[0].horizons[30];
  assert.deepEqual([cohort.eligible, cohort.returned, cohort.pending, cohort.value], [0, 0, 1, null]);
});
test('6: return at day 30 counts, day 31 does not', () => {
  const state = r.buildReport(source([row('1', '2026-09-01'), row('2', '2026-10-01'), row('3', '2026-09-01', '2222'), row('4', '2026-10-02', '2222')], { today: '2026-11-01' }), { period: 'custom', dateFrom: '2026-09-01', dateTo: '2026-10-31' });
  const c = r.buildCohorts(state.histories, coverage, ['a'], { from: '2026-09-01', to: '2026-09-01', D: '2026-10-31' }).rows[0].horizons[30];
  assert.deepEqual([c.eligible, c.returned, c.value], [2, 1, 50]);
});
test('7: a coverage hole excludes an otherwise mature instrument', () => {
  const state = report([row('1', '2026-09-01'), row('2', '2026-09-03')]);
  const holes = [{ ...coverage[0], to: '2026-09-10' }, { ...coverage[0], from: '2026-09-12' }];
  const c = r.buildCohorts(state.histories, holes, ['a'], { from: '2026-09-01', to: '2026-09-01', D: '2026-10-07' }).rows[0].horizons[30];
  assert.equal(c.eligible, 0); assert.equal(c.excluded, 1); assert.equal(c.value, null);
});
test('8–9: no operations, no data and no identifiable denominator stay distinct', () => {
  const complete = report([]).report.summary, missing = report([], {}, { coverage: [] }).report.summary;
  assert.equal(complete.status, 'no_activity'); assert.equal(missing.status, 'no_data');
  assert.equal(complete.returnAmountRate.value, null); assert.equal(missing.returnDaysRate.value, null);
  const unidentified = report([row('n', '2026-10-01', null)]).report.summary;
  assert.equal(unidentified.active.value, 0); assert.equal(unidentified.returning.value, null);
  assert.ok(!JSON.stringify(unidentified).includes('NaN'));
});
test('10–11: local first observations differ from chain returns and same-day chain dates are deduplicated', () => {
  const rows = [row('1', '2026-09-01', '1111', 10, 'a'), row('2', '2026-10-01', '1111', 10, 'b'), row('3', '2026-10-01', '1111', 5, 'a')];
  const both = { locationIds: ['a', 'b'], coverage: [...coverage, { ...coverage[0], locationId: 'b' }] };
  const chain = report(rows, {}, both).report.summary, local = report(rows, {}, { ...both, locationIds: ['b'] }).report.summary;
  assert.equal(chain.active.value, 1); assert.equal(chain.days, 1); assert.equal(chain.returnAmount, 15);
  assert.equal(local.returnAmount, 0); assert.equal(local.firstObserved, 1);
});
test('12: missing or placeholder identifiers never form a shared instrument', () => {
  const data = report([row('1', '2026-10-01', null), row('2', '2026-10-02', null), row('3', '2026-10-03', '0000')]).report.summary;
  assert.equal(data.active.value, 0); assert.equal(data.identifiedPayments, 0);
});
test('13–14: identity deduplication retains real identical purchases with different payment IDs', () => {
  const a = row('1', '2026-10-01'); const data = r.normalizePayments([a, a, row('2', '2026-10-01')]);
  assert.equal(data.payments.length, 2); assert.equal(data.diagnostics.duplicates, 1);
});
test('15: full and partial refunds adjust the original payment without creating visits', () => {
  const full = row('f', '2026-10-02', null, 10, 'a', { TRANSACTION_TYPE: 'REFUND', ORIGINAL_SOURCE_ID: '1' });
  const part = row('p', '2026-10-03', null, 4, 'a', { TRANSACTION_TYPE: 'PARTIAL_REFUND', ORIGINAL_SOURCE_ID: '2' });
  const data = r.normalizePayments([row('1', '2026-10-01', '1111', 10, 'a', { REFUNDED_AMOUNT: null }), row('2', '2026-10-01', '2222', 10, 'a', { REFUNDED_AMOUNT: null }), full, part]);
  assert.equal(data.payments.length, 1); assert.equal(data.payments[0].amount, 6); assert.equal(data.payments[0].date, '2026-10-01');
});
const purchaseOrder = (key, date, amount = 10, extra = {}) => ({ orderKey: key, locationId: 'a', date, dateTime: `${date}T10:00:00`, time: '10:00',
  netSales: amount / 1.19, ticketGross: amount, monetaryVerified: true, paymentPaid: amount, lines: [{ code: 'P1', name: 'Café', quantity: 1, categoryId: 'C', categoryName: 'Café', netSales: amount / 1.19 }], ...extra });
test('16–17: ambiguous and split payments do not multiply classified orders or money', () => {
  const state = report([row('1', '2026-10-01'), row('2', '2026-10-01')]);
  const ambiguous = r.buildPurchases(state, [purchaseOrder('o', '2026-10-01')]);
  assert.equal(ambiguous.quality.classifiable, 0); assert.equal(ambiguous.reasons[0].reason, 'Vínculo ambiguo');
  const split = r.buildPurchases(report([row('1', '2026-10-01')]), [purchaseOrder('o', '2026-10-01', 10, { paymentDuePartial: true })]);
  assert.equal(split.quality.classifiable, 0); assert.equal(split.details.length, 1);
});
test('18: frequency groups partition active instruments and distinguish those known before the window', () => {
  const rows = Array.from({ length: 28 }, (_, i) => row(`x${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, '1111'));
  rows.push(row('y', '2026-10-01', '2222'), row('z', '2026-09-01', '2222'));
  const h = r.history(r.normalizePayments(rows).payments), f = r.frequency(h, coverage, ['a'], '2026-10-28');
  assert.equal(f.active, 2); assert.equal(f.rows.reduce((n, row) => n + row.instruments, 0), 2); assert.equal(f.rows[4].instruments, 1); assert.equal(f.knownBefore, 1);
});
test('19: recency boundaries are exclusive and old instruments have a separate count', () => {
  const { addDays } = require('../network-sales'); const rows = [];
  for (const age of [7, 8, 14, 15, 30, 31, 60, 61, 89, 90]) { const d = addDays('2026-10-31', -age); rows.push(row(`${age}a`, addDays(d, -1), String(age).padStart(4, '1')), row(`${age}b`, d, String(age).padStart(4, '1'))); }
  const result = r.recency(r.history(r.normalizePayments(rows).payments), coverage, ['a'], '2026-10-31');
  assert.deepEqual(result.rows.map(row => row.instruments), [1, 2, 2, 2, 2]); assert.equal(result.older, 1);
});
test('20–21: snapshots reject changed source data and late imports recalculate first dates and cohorts', async () => {
  let revision = 1, rows = [row('1', '2026-10-01')];
  const service = createRecurrenceService({ readSource: () => source(rows), fingerprint: () => ({ mp: revision, purchases: 1 }), readOrders: () => ({ orders: [] }) });
  const first = await service.request('generate', {});
  revision++; rows = [row('0', '2026-09-01'), ...rows];
  await assert.rejects(service.request('return', { id: first.id }), { status: 409 });
  const next = await service.request('generate', {});
  assert.equal(next.summary.returning.value, 100); assert.notEqual(next.id, first.id);
});
test('22: an unequal-month comparison limits both periods to their common ordinal dates', () => {
  const p = r.resolvePeriod({ period: 'current-month' }, '2026-03-31', '2026-03-30');
  assert.equal(p.to, '2026-03-28'); assert.equal(p.previous.to, '2026-02-28'); assert.equal(p.commonMonthTruncation, true);
});
test('23: common mature cohorts are monotone and include instruments with no subsequent activity', () => {
  const state = r.buildReport(source(fixture(), { today: '2026-11-11' }), { period: 'custom', dateFrom: '2026-11-01', dateTo: '2026-11-10' });
  const c = r.buildCohorts(state.histories, coverage, ['a'], { from: '2026-10-01', to: '2026-10-07', D: '2026-11-10', commonBase: true }).rows;
  const totals = [7, 14, 30].map(h => c.reduce((n, row) => n + row.horizons[h].returned, 0));
  assert.equal(c.reduce((n, row) => n + row.instruments, 0), 2);
  assert.ok(totals[0] <= totals[1] && totals[1] <= totals[2]);
  assert.equal(c.reduce((n, row) => n + row.horizons[30].eligible, 0), 2);
});
test('24–25: first-day money stays first-day after returning, and unlinked MP instruments remain active', () => {
  const state = report([row('1', '2026-10-01'), row('2', '2026-10-01T11:00:00', '1111', 5), row('3', '2026-10-03', '1111', 20)]);
  assert.equal(state.report.summary.firstAmount, 15); assert.equal(state.report.summary.returnAmount, 20);
  assert.equal(r.buildPurchases(state, []).quality.classifiable, 0); assert.equal(state.report.summary.active.value, 1);
});
test('26: late known refund revisions alter the old series and are identifiable as data revisions', () => {
  const original = row('1', '2026-10-01'), revised = { ...row('1', '2026-10-01', '1111', 10, 'a', { REFUNDED_AMOUNT: 4 }), observedAt: '2026-12-01T00:00:00Z' };
  const state = report([original, revised]); assert.equal(state.report.summary.totalAmount, 6); assert.equal(state.report.quality.diagnostics.revised, 1);
});
test('27: public aggregates and aliases do not expose card digits or claim unique people', () => {
  const state = report(); const output = JSON.stringify({ report: state.report, details: r.paymentDetails(state) });
  assert.ok(!output.includes('123456')); assert.ok(output.includes('approximate')); assert.ok(output.includes('MP-'));
});
test('intervals represent the typical instrument rather than over-weighting frequent instruments', () => {
  const h = new Map([['a', { dates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'] }], ['b', { dates: ['2026-10-01', '2026-10-11'] }]]);
  assert.equal(r.intervalSummary(h, { from: '2026-10-01', to: '2026-10-31' }).value, 5.5);
});
test('explicit split payments with a single instrument classify one order; multiple instruments remain unclassified', () => {
  const one = report([row('1', '2026-10-01', '1111', 4), row('2', '2026-10-01', '1111', 6)]);
  const purchase = purchaseOrder('o', '2026-10-01', 10, { paymentDuePartial: true, explicitPaymentIds: ['1', '2'] });
  const valid = r.buildPurchases(one, [purchase]);
  assert.equal(valid.quality.classifiable, 1); assert.equal(valid.quality.linked, 1); assert.equal(valid.rows[0].orders, 1); assert.equal(valid.details.length, 1);
  const two = report([row('1', '2026-10-01', '1111', 4), row('2', '2026-10-01', '2222', 6)]);
  assert.equal(r.buildPurchases(two, [purchase]).quality.classifiable, 0);
  const duplicate = r.buildPurchases(one, [purchase, { ...purchase, orderKey: 'another' }]); assert.equal(duplicate.quality.classifiable, 0);
});
test('status and unknown adjustments never claim verified complete payments or comparisons', () => {
  const state = report([row('1', '2026-10-01', '1111', 10, 'a', { STATUS: null }), row('unknown-refund', '2026-10-04', null, 5, 'a', { TRANSACTION_TYPE: 'REFUND', ORIGINAL_SOURCE_ID: '' })]);
  assert.equal(state.report.summary.status, 'partial'); assert.equal(state.report.summary.comparison.available, false); assert.equal(state.report.quality.diagnostics.unknownRefunds, 1);
});
test('a confirmed older source cutoff excludes newer unconfirmed activity without using Toteat coverage', () => {
  const mp = [{ ...coverage[0], to: '2026-10-02', through: '2026-10-02T12:00:00' }, { ...coverage[0], source: 'sales', to: '2026-10-07' }];
  const state = report([row('1', '2026-10-01'), row('2', '2026-10-03')], {}, { coverage: mp });
  assert.equal(state.report.asOf, '2026-10-02T12:00:00'); assert.equal(state.report.summary.payments, 1); assert.equal(state.report.summary.returnDays, 0);
});
test('refunds without verified accounting never fabricate order net sales from a VAT division', () => {
  const state = report([row('1', '2026-10-01')]);
  const result = r.buildPurchases(state, [purchaseOrder('o', '2026-10-01', 10, { netSales: null, ticketGross: 10, monetaryVerified: false })]);
  assert.equal(result.rows[0].netSales, null); assert.equal(result.rows[0].medianTicketGross, 10); assert.equal(result.quality.netSales, null);
});

test('unknown original adjustment, component quantities and accounting stay explicit', () => {
  const missing = row('refund', '2026-10-02', null, 5, 'a', { TRANSACTION_TYPE: 'REFUND', ORIGINAL_SOURCE_ID: 'absent' });
  assert.equal(r.normalizePayments([row('pay', '2026-10-01'), missing]).diagnostics.unknownRefunds, 1);
  const lines = r.eligibleOrderLines([{ code: 'P', quantity: 1 }, { code: 'P', quantity: 2 }, { code: 'Q', quantity: 3 }],
    [{ id: 'P', quantity: 1 }, { id: 'P', quantity: 2, lineReference: 'root' }, { id: 'Q', quantity: 3, lineReference: 'root' }]);
  assert.deepEqual(lines.map(l => l.quantity), [1, 0, 0]);
  assert.equal(lines[0].isComponent, false); assert.equal(lines[2].isComponent, true);
});

test('a section rejects a source change during preparation; closed-window cache ignores irrelevant clock seconds', async () => {
  let revision = 1, reads = 0;
  const service = createRecurrenceService({ readSource: () => source(), fingerprint: () => ({ mp: 1, purchases: revision }),
    readOrders: () => { reads++; revision++; return { orders: [] }; } });
  const first = await service.request('generate', { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', serverToday: '2026-10-08', serverCutoff: '10:00:00' });
  const cached = await service.request('generate', { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', serverToday: '2026-10-08', serverCutoff: '11:00:00' });
  assert.equal(first.id, cached.id);
  await assert.rejects(service.request('purchases', { id: first.id }), { status: 409 }); assert.equal(reads, 1);
});
