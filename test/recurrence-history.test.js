const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../recurrence');
const { addDays } = require('../network-sales');
const { monthlyHistory, networkHistory } = require('../recurrence-history');
const { createRecurrenceService } = require('../recurrence-service');
const locations = [{ id: 'lyon', name: 'Lyon' }, { id: 'concepcion', name: 'La Concepción' }, { id: 'third', name: 'Tercera' }];
const coverage = locations.map(l => ({ locationId: l.id, source: 'mercadopago', from: '2024-01-01', to: '2026-12-31', complete: true }));
const row = (id, date, location, amount = 100, card = '1111') => ({ locationId: location, data: { SOURCE_ID: id, TRANSACTION_DATE: `${date}T12:00:00`, TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: amount, CARD_INITIAL_NUMBER: card ? '123456' : null, LAST_FOUR_DIGITS: card, STATUS: 'approved', REFUNDED_AMOUNT: 0, ACCOUNT_ID: 'shared' } });
const source = (records, ids = ['lyon'], extra = {}) => ({ records, today: '2026-11-01', cutoff: '23:59:59', secret: 'fixture', locationIds: ids,
  scope: { location: ids.length === 1 ? ids[0] : 'all', label: ids.join(', '), locations: locations.filter(l => ids.includes(l.id)) }, coverage, ...extra });
const state = records => r.buildReport(source(records), { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
test('monthly percentages classify each payment using preceding local dates, total MP denominator, and all 12 calendar months', () => {
  const data = state([row('prior', '2026-09-01', 'lyon', 5), row('1', '2026-10-01', 'lyon', 20), row('2', '2026-10-01', 'lyon', 30), row('3', '2026-10-02', 'lyon', 50), row('unknown', '2026-10-02', 'lyon', 100, null), row('new', '2026-10-03', 'lyon', 100, '2222')]);
  const result = monthlyHistory(data, coverage), october = result.rows.at(-1);
  assert.equal(result.rows.length, 12); assert.equal(result.rows[0].month, '2025-11'); assert.equal(october.month, '2026-10');
  assert.equal(october.amount, 300); assert.equal(october.identifiedAmount, 200); assert.equal(october.windows[30].numerator, 100); assert.equal(october.windows[30].value, 33.3);
  assert.equal(result.rows[0].windows[30].value, null); assert.equal(result.rows[0].windows[30].status, 'no_activity');
});
test('lookback limits are inclusive and same-day payments never manufacture purchase history', () => {
  const now = '2026-10-31';
  for (const days of [30, 60, 90, 180]) {
    for (const delta of [days, days + 1]) {
      const data = monthlyHistory(state([row('old', addDays(now, -delta), 'lyon'), row('new', now, 'lyon', 20)]), coverage);
      const last = data.rows.at(-1); assert.equal(last.windows[days].numerator, delta === days ? 20 : 0, `${days} / ${delta}`);
    }
  }
  const same = monthlyHistory(state([row('1', now, 'lyon'), row('2', now, 'lyon')]), coverage).rows.at(-1);
  assert.equal(same.windows[180].numerator, 0);
});
test('first payment stays first even after a later purchase, and next-month activity cannot qualify an earlier payment', () => {
  const data = monthlyHistory(state([row('first', '2026-10-30', 'lyon', 10), row('return', '2026-10-31', 'lyon', 30), row('future', '2026-11-01', 'lyon', 500)]), coverage);
  assert.equal(data.rows.at(-1).amount, 40); assert.equal(data.rows.at(-1).windows[30].value, 75);
});
test('network visits are directed, ignore same-day branches, and deduplicate overlapping origins per payment', () => {
  const rows = [row('old-a', '2026-10-01', 'concepcion', 10), row('old-b', '2026-10-02', 'third', 10), row('target', '2026-10-03', 'lyon', 60), row('same-day', '2026-10-04', 'concepcion', 20, '2222'), row('same-target', '2026-10-04', 'lyon', 40, '2222'), row('same-local', '2026-10-05', 'lyon', 100, '3333'), row('return-local', '2026-10-06', 'lyon', 100, '3333')];
  const local = state(rows), network = networkHistory(source(rows, locations.map(l => l.id)), local.report), month = network.rows.at(-1);
  assert.equal(month.amount, 300); assert.equal(month.windows[30].numerator, 60); assert.equal(month.windows[30].value, 20);
  for (const origin of ['concepcion', 'third']) assert.equal(network.origins.find(r => r.month === '2026-10' && r.originId === origin).windows[30].numerator, 60);
  const inverse = networkHistory(source(rows, locations.map(l => l.id)), { ...local.report, locationIds: ['concepcion'] });
  assert.equal(inverse.rows.at(-1).windows[30].numerator, 0);
});
test('chain recalculates local lookbacks as a union; source money, same-day dates and horizons are not added twice', () => {
  const rows = [row('a', '2026-09-01', 'concepcion'), row('b', '2026-10-01', 'lyon', 20), row('c', '2026-10-02', 'lyon', 40)];
  const local = monthlyHistory(state(rows), coverage).rows.at(-1);
  const chainState = r.buildReport(source(rows, ['lyon', 'concepcion']), { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  const chain = monthlyHistory(chainState, coverage).rows.at(-1);
  assert.equal(local.windows[30].numerator, 40); assert.equal(chain.windows[30].numerator, 60);
  assert.ok(chain.windows[30].value <= chain.windows[60].value && chain.windows[60].value <= chain.windows[90].value && chain.windows[90].value <= chain.windows[180].value);
});
test('coverage gaps, unknown accounts, missing identification and partial current months are explicit', () => {
  const rows = [row('old', '2026-09-01', 'concepcion'), row('new', '2026-10-01', 'lyon')];
  rows[0].data.ACCOUNT_ID = null;
  const src = source(rows, ['lyon', 'concepcion'], { coverage: [] });
  const result = networkHistory(src, state(rows).report); assert.equal(result.rows.at(-1).windows[30].status, 'partial');
  assert.equal(result.rows[0].windows[30].status, 'no_data'); assert.equal(result.rows[0].windows[30].value, null);
  assert.ok(result.warnings.some(w => w.includes('cuentas')));
  const partial = monthlyHistory(r.buildReport(source(rows, ['lyon'], { today: '2026-10-15', cutoff: '15:00:00' }), { period: 'today' }), coverage);
  assert.equal(partial.rows.at(-1).to, '2026-10-15'); assert.equal(partial.rows.at(-1).partialMonth, true);
});
test('history normalizes duplicate payments and verified refunds without including future amounts', () => {
  const a = row('1', '2026-10-01', 'lyon', 40); a.data.REFUNDED_AMOUNT = 10;
  const data = monthlyHistory(state([a, a, row('2', '2026-10-02', 'lyon', 20)]), coverage).rows.at(-1);
  assert.equal(data.amount, 50); assert.equal(data.windows[30].value, 40);
});
test('lazy history sections use a coherent network version and export only prepared results', async () => {
  let localVersion = 1, networkVersion = 1, networkReads = 0;
  const rows = [row('old', '2026-09-01', 'concepcion'), row('new', '2026-10-01', 'lyon')];
  const service = createRecurrenceService({ fingerprint: q => ({ mp: q.location === 'all' ? networkVersion : localVersion, purchases: 1 }), readSource: q => { if (q.location === 'all') networkReads++; return source(rows, q.location === 'all' ? locations.map(l => l.id) : ['lyon']); }, readOrders: () => { throw Error('No Toteat'); } });
  const first = await service.request('generate', { location: 'lyon', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  assert.equal(networkReads, 0); assert.equal((await service.request('export', { id: first.id })).monthly, null);
  const monthly = await service.request('monthly', { id: first.id }); assert.equal(monthly.rows.length, 12); assert.equal(networkReads, 0);
  networkVersion++; await assert.rejects(service.request('network', { id: first.id }), { status: 409 }); assert.equal(networkReads, 0);
  const fresh = await service.request('generate', { location: 'lyon', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-31' }); assert.notEqual(fresh.id, first.id);
  const network = await service.request('network', { id: fresh.id }); assert.equal(network.rows.at(-1).windows[30].value, 100); assert.equal(networkReads, 1);
  networkVersion++; const cached = await service.request('network', { id: fresh.id }); assert.deepEqual(cached, network); assert.equal(networkReads, 1);
  const exported = await service.request('export', { id: fresh.id }); assert.deepEqual(exported.network, network); assert.equal(exported.monthly, null);
});
