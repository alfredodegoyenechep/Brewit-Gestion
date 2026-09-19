const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSourceDiagnostics } = require('../source-diagnostics');

test('keeps sales and MercadoPago activity separate by location and event date', () => {
  const result = buildSourceDiagnostics({
    stores: [{ id: 'store-1', name: 'Centro' }, { id: 'store-2', name: 'Norte' }],
    transactions: [{ locationId: 'store-1', date: '2026-08-30', paymentMatched: true,
      paymentDuePartial: true, reversalSignals: ['negative-order-amount'], paymentReconciliation: { status: 'matched' } }],
    settlements: [{ locationId: 'store-1', date: '2026-08-31', amount: 1190, fee: -35 }],
    fileCoverage: { 'store-1': { sales: 1, paymentDetails: 1, mercadoPago: 1 } }
  });
  assert.equal(result.rows.find(row => row.date === '2026-08-30').salesOrders, 1);
  assert.equal(result.rows.find(row => row.date === '2026-08-30').paymentPartialDue, 1);
  assert.equal(result.rows.find(row => row.date === '2026-08-30').reversalReviewRequired, 1);
  assert.equal(result.rows.find(row => row.date === '2026-08-30').mpSettlements, 0);
  assert.equal(result.rows.find(row => row.date === '2026-08-31').mpAmount, 1190);
  assert.equal(result.rows.find(row => row.date === '2026-08-31').mpFeesGross, 35);
  assert.equal(result.rows.some(row => row.locationId === 'store-2'), false);
  assert.equal(result.filesByStore.find(store => store.locationId === 'store-2').mercadoPago, 0);
});
