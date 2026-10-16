const test = require('node:test');
const assert = require('node:assert/strict');
const details = require('../weekly-results-details');
const { value } = require('../weekly-results');
const { toteatPaymentCollections } = require('../payment-collections');
const sum = report => report.rows.reduce((total, row) => total + (row.amount ?? 0), 0);

test('detail rows preserve sales allocation, reversals and signed expenses', () => {
  const sales = details.sales([
    { code: 'A', name: 'A', quantity: 2, netSales: 120 },
    { code: 'A', name: 'A', quantity: -1, netSales: -60 },
    { code: 'BX', name: 'Extra', quantity: 1, netSales: 15 }
  ]);
  assert.equal(sum(sales), 75);
  assert.equal(sales.rows[0].quantity, 1);
  for (const amounts of [[100, -20], [-100, 20], [0, 0]]) {
    const expense = details.expense(amounts.map((amount, index) => ({ code: String(index), quantity: amount / 10,
      unit: 'UN', unitCost: 10, totalCost: amount, costSource: 'master' })));
    assert.equal(sum(expense), -Math.abs(amounts.reduce((a, b) => a + b, 0)) || 0);
  }
  const partial = details.expense([{ code: 'A', totalCost: 20, unitCost: 10, costSource: 'recipe', costIncomplete: true },
    { code: 'B', totalCost: 0, unitCost: 0, costSource: 'missing' }]);
  assert.equal(sum(partial), -20);
  assert.equal(partial.rows[0].status, 'Costo parcial');
  assert.equal(partial.rows[1].amount, null);
});

test('inventory details distinguish counted differences, missing costs and balances', () => {
  const items = [{ code: 'A', name: 'A', initialInventory: 100, adjustedTheoreticalFinal: 90,
    finalInventory: 85, finalIsPhysical: true, difference: -5, unitCost: 10, costAvailable: true, totalCost: -50 },
  { code: 'B', finalInventory: null, finalIsPhysical: false, costAvailable: true, unitCost: 10, totalCost: null },
  { code: 'C', finalInventory: 5, finalIsPhysical: true, costAvailable: false, totalCost: 0 }];
  const report = details.differences({ items, excluded: [{ code: 'X', reason: 'Sin apertura' }] });
  assert.equal(sum(report), -50);
  assert.equal(report.rows[1].amount, null);
  assert.equal(report.rows[1].status, 'Sin toma final');
  assert.equal(report.rows[2].amount, null);
  assert.deepEqual(report.excluded, [{ code: 'X', name: undefined, reason: 'Sin apertura' }]);
  assert.equal(sum(details.differences({ items: [{ ...items[0], totalCost: 50 }] }, { consumables: true })), -50);
  assert.equal(sum(details.balances([{ code: 'A', quantity: 0, unitCost: 10, costAvailable: true },
    { code: 'B', quantity: null, unitCost: 10, costAvailable: true }, { code: 'C', quantity: 5, costAvailable: false }])), 0);
});

test('tip details use the same validated and deduplicated payments as the total without exposing identities', () => {
  const location = { id: 'store-1', name: 'La Concepción' };
  const payment = { paymentId: 'PRIVATE', customerName: 'PRIVATE', dateClosed: '2026-10-05T12:00:00', change: 0,
    paymentForms: [{ id: 5008, amount: 1000, tip: 100 }, { id: 1000, amount: 200, tip: 10 }, { id: 1000, amount: 200, tip: 20 }] };
  const result = toteatPaymentCollections([{ location, state: { from: '2026-10-05', through: '2026-10-11',
    payments: [payment, payment, { ...payment, paymentId: 'invalid', paymentForms: [{ id: 1000, amount: 1 }] },
      { ...payment, paymentId: 'future', dateClosed: '2026-10-12T12:00:00' }] } }],
  '2026-10-05', '2026-10-11', { includeCollectionTotals: true, includeDetails: true });
  assert.equal(sum(details.tips(result.tipDetails)), result.tips.amount);
  assert.deepEqual(result.tipDetails.map(row => [row.method, row.payments, row.amount]), [['MercadoPago', 1, 100], ['Efectivo', 1, 30]]);
  assert.ok(!JSON.stringify(result.tipDetails).includes('PRIVATE'));
});

test('detail snapshots are stable for identical reports, expire and enforce the cache limit', () => {
  let now = 1000;
  const store = details.createDetailStore({ clock: () => now, ttl: 100, limit: 2 });
  const location = { id: 'store-1', name: 'Local', secret: 'PRIVATE' }, period = { from: '2026-10-05', through: '2026-10-11' };
  const put = amount => store.put('netSales', details.sales([{ code: 'A', name: 'A', quantity: 1, netSales: amount }]),
    value(amount, 'complete'), location, period, '2026-10-16');
  const id = put(10);
  assert.equal(put(10), id);
  assert.equal(store.get(id).total, 10);
  assert.ok(!JSON.stringify(store.get(id)).includes('PRIVATE'));
  const second = put(20); put(30);
  assert.equal(store.get(id), null);
  now += 100;
  assert.equal(store.get(second), null);
  assert.equal(store.put('netSales', {}, value(), location, period, '2026-10-16'), null);
});
