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
