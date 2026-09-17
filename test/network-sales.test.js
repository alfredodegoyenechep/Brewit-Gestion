const test = require('node:test');
const assert = require('node:assert/strict');
const { businessClock, percentageChange, aggregateNetworkMetrics, buildNetworkSalesDashboard } = require('../network-sales');

const fact = (locationId, date, sales, time = '12:00:00', extra = {}) => ({
  locationId, date, time, sales, cost: sales / 2, discounts: sales / 10,
  grossBeforeDiscount: sales * 1.1, transactions: 1, costAvailable: true, ...extra
});

test('uses Chilean wall time across daylight-saving transitions', () => {
  assert.deepEqual(businessClock(new Date('2026-09-06T03:30:00Z')),
    { today: '2026-09-05', cutoff: '23:30:00' });
  assert.deepEqual(businessClock(new Date('2026-09-06T04:30:00Z')),
    { today: '2026-09-06', cutoff: '01:30:00' });
});

test('aggregates network monetary amounts before calculating ratios', () => {
  const total = aggregateNetworkMetrics([
    fact('a', '2026-09-17', 100, '12:00:00', { cost: 20, transactions: 1 }),
    fact('b', '2026-09-17', 900, '12:00:00', { cost: 540, transactions: 9 })
  ]);
  assert.equal(total.sales, 1000);
  assert.equal(total.marginPercent, 44);
  assert.equal(total.averageTicket, 100);
  assert.ok(Math.abs(total.discountPercent - 100 / 1100 * 100) < 1e-9);
  assert.equal(percentageChange(100, 0), null);
});

test('compares partial days and weeks at the same cutoff, including Monday versus Sunday', () => {
  const stores = [{ id: 'a', name: 'Local A', operatingWeekdays: [0, 1, 2, 3, 4, 5, 6], openingDate: '2026-01-01' }];
  const facts = [fact('a', '2026-09-14', 50, '12:00:00'), fact('a', '2026-09-14', 50, '18:00:00'),
    fact('a', '2026-09-13', 40, '12:00:00'), fact('a', '2026-09-13', 60, '18:00:00'),
    fact('a', '2026-09-07', 25, '12:00:00'), fact('a', '2026-09-07', 75, '18:00:00')];
  const report = buildNetworkSalesDashboard({ stores, facts, today: '2026-09-14', cutoff: '15:00:00' });
  assert.equal(report.rows[0].today.sales, 50);
  assert.equal(report.rows[0].today.vsYesterday, 25);
  assert.equal(report.rows[0].currentWeek.vsPreviousWeek, 100);
});

test('requires eight valid equivalent weekdays and includes scheduled open zero-sale days', () => {
  const stores = [{ id: 'a', name: 'Local A', operatingWeekdays: [1], openingDate: '2026-08-01' }];
  const facts = [fact('a', '2026-09-14', 100), fact('a', '2026-09-07', 50)];
  const report = buildNetworkSalesDashboard({ stores, facts, today: '2026-09-14', cutoff: '15:00:00' });
  assert.equal(report.rows[0].today.vsEquivalentDays, null);
  assert.equal(report.rows[0].yesterday.vsFourWeeks, -100);
  assert.equal(report.rows[0].previousWeek.sales, 50);
});

test('clamps previous month comparison when current month has more calendar days', () => {
  const stores = [{ id: 'a', name: 'Local A', openingDate: '2026-01-01' }];
  const facts = [fact('a', '2026-03-31', 100), fact('a', '2026-02-28', 50)];
  const report = buildNetworkSalesDashboard({ stores, facts, today: '2026-03-31', cutoff: '15:00:00' });
  assert.equal(report.rows[0].currentMonth.vsPreviousMonth, 100);
});
