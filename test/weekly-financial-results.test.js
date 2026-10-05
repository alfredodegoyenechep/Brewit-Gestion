const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWeeks, buildWeeklyResults, buildWeeklyResultsWithProgress } = require('../weekly-financial-results');
test('five full Monday–Sunday weeks span month and year boundaries', () => {
  for (const today of ['2026-09-28', '2026-10-04', '2027-01-01', '2028-03-01']) {
    const weeks = currentWeeks(today);
    assert.equal(weeks.length, 5);
    for (const [i, week] of weeks.entries()) {
      assert.equal(new Date(week.from).getUTCDay(), 1);
      assert.equal(new Date(week.to).getUTCDay(), 0);
      assert.equal(Date.parse(week.to) - Date.parse(week.from), 6 * 86400000);
      if (i) assert.equal(Date.parse(week.from) - Date.parse(weeks[i - 1].to), 86400000);
    }
    assert.ok(weeks[4].from <= today && today <= weeks[4].to);
  }
  assert.deepEqual(currentWeeks('2026-09-28')[4], { from: '2026-09-28', to: '2026-10-04' });
});
const query = { today: '2026-09-28', location: 'store-1' };
const build = q => ({ scope: { label: q.location }, warnings: [],
  revenue: { filesRead: 1, total: { netSales: q.dateFrom === '2026-08-31' ? 100 : 200 }, discountsNet: 10 },
  statement: {
    mercadoPagoCollection: { amount: q.dateFrom === '2026-08-31' ? 150 : 250, available: true, complete: true },
    mercadoPagoTips: { amount: 12, available: true, complete: true },
    cashSales: { amount: 5, available: true, complete: true }
  },
  inventorySummaries: [{ metrics: { otherConsumables: { available: true, amount: 12, partial: true },
    adjustedKardexTotalCost: { available: true, amount: -20 } } }, null] });
test('uses inventory summary amounts, zeros for missing data and ratios of totals', () => {
  const data = buildWeeklyResults(query, build);
  assert.equal(data.weeks[0].values.discounts.percent, 10);
  assert.equal(data.total.discounts.percent, 50 / 900 * 100);
  assert.equal(data.total.otherConsumables.amount, -60);
  assert.equal(data.total.adjustedKardexTotalCost.amount, -100);
  assert.equal(data.total.waste.amount, 0);
  assert.equal(data.total.combined.amount, -160);
  assert.equal(data.total.combined.complete, false);
  assert.deepEqual(data.metrics.slice(0, 2), [['grossSales', 'Venta Bruta'], ['mercadoPagoCollection', 'Recaudación MercadoPago']]);
  assert.equal(data.weeks[0].values.mercadoPagoCollection.amount, 150);
  assert.equal(data.total.mercadoPagoCollection.amount, 1150);
  assert.equal(data.total.mercadoPagoCollection.complete, true);
});
test('missing MercadoPago collections use zero and retain incomplete coverage', () => {
  const data = buildWeeklyResults(query, q => ({ ...build(q), statement: {} }));
  assert.equal(data.total.mercadoPagoCollection.amount, 0);
  assert.equal(data.total.mercadoPagoCollection.complete, false);
  assert.equal(data.total.combined.amount, -160);
  assert.equal(data.total.collectionDifference.complete, false);
  assert.equal(data.total.collectionDifference.available, false);
});
test('reconciles VAT-inclusive sales against MercadoPago less tips plus cash, by week and total', () => {
  const data = buildWeeklyResults(query, build);
  assert.equal(data.weeks[0].values.grossSales.amount, 119);
  assert.equal(data.weeks[0].values.mercadoPagoNet.amount, 138);
  assert.equal(data.weeks[0].values.mercadoPagoDifference.amount, 19);
  assert.equal(data.weeks[0].values.collectedSales.amount, 143);
  assert.equal(data.weeks[0].values.collectionDifference.amount, 24);
  assert.equal(data.total.grossSales.amount, 1071);
  assert.equal(data.total.mercadoPagoTips.amount, 60);
  assert.equal(data.total.cashSales.amount, 25);
  assert.equal(data.total.collectedSales.amount, 1115);
  assert.equal(data.total.collectionDifference.amount, 44);
  assert.equal(data.total.collectionDifference.complete, true);
  for (const [key] of data.metrics) assert.equal(data.total[key].amount, data.weeks.reduce((sum, week) => sum + week.values[key].amount, 0));
  const balanced = buildWeeklyResults(query, q => ({ ...build(q), statement: {
    mercadoPagoCollection: { amount: 1090, available: true, complete: true },
    mercadoPagoTips: { amount: 100, available: true, complete: true },
    cashSales: { amount: 200, available: true, complete: true }
  }, revenue: { ...build(q).revenue, total: { netSales: 1000 } } }));
  assert.equal(balanced.total.collectionDifference.amount, 0);
  const partial = buildWeeklyResults(query, q => ({ ...build(q), statement: { ...build(q).statement, cashSales: { amount: 5, available: true, complete: false } } }));
  assert.equal(partial.total.collectionDifference.complete, false);
});
test('streaming matches synchronous results and supports cancellation', async () => {
  const events = [];
  assert.deepEqual(await buildWeeklyResultsWithProgress(query, build, e => events.push(e)), buildWeeklyResults(query, build));
  assert.equal(events[0].completed, 0);
  assert.equal(events.at(-1).completed, 5);
  let calls = 0;
  assert.equal(await buildWeeklyResultsWithProgress(query, q => { calls++; return build(q); }, () => {}, () => calls === 1), null);
  assert.equal(calls, 1);
});

test('current week keeps Sunday header but calculates only through today', () => {
  const calls = [];
  const result = buildWeeklyResults(query, q => { calls.push(q); return build(q); });
  assert.equal(result.weeks[4].period.to, '2026-10-04');
  assert.equal(calls[4].dateTo, '2026-09-28');
  assert.equal(calls[3].dateTo, '2026-09-27');
});
