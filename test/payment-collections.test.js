const test = require('node:test');
const assert = require('node:assert/strict');
const { toteatPaymentCollections } = require('../payment-collections');
const location = { id: 'store-1', name: 'La Concepción' };
const payment = (overrides = {}) => ({ paymentId: 'p1', dateClosed: '2026-09-21T12:00:00', change: 0,
  paymentForms: [{ id: 5008, amount: 11000, tip: 1000 }], ...overrides });
const state = payments => ({ from: '2026-09-01', through: '2026-10-05', payments });

test('separates MercadoPago tips from cash sales and subtracts change once per payment', () => {
  const mixed = payment({ paymentId: 'mixed', change: 500, paymentForms: [
    { id: 5008, amount: 5500, tip: 500 },
    { id: 1000, amount: 3300, tip: 300 },
    { id: 1000, amount: 2200, tip: 200 },
    { id: 50001, amount: 1000, tip: 100 }
  ] });
  const result = toteatPaymentCollections([{ location, state: state([payment(), mixed, mixed]) }], '2026-09-21', '2026-09-27');
  assert.equal(result.mercadoPagoTips.amount, 1500);
  assert.equal(result.cashSales.amount, 4500);
  assert.equal(result.cashSales.complete, true);
  assert.deepEqual(result.warnings, []);
});

test('uses Chilean closing dates, retains reversals and scopes identities to each location', () => {
  const payments = [
    payment({ paymentId: 'prior', dateClosed: '2026-09-21T02:30:00Z' }),
    payment({ paymentId: 'boundary', dateClosed: '2026-09-28T02:30:00Z' }),
    payment({ paymentId: 'after', dateClosed: '2026-09-28T03:30:00Z' }),
    payment({ paymentId: 'reversal', paymentForms: [{ id: 5008, amount: -1100, tip: -100 }, { id: 1000, amount: -2000, tip: 0 }] })
  ];
  const result = toteatPaymentCollections([
    { location, state: state(payments) },
    { location: { id: 'store-2', name: 'Lyon' }, state: state([payment({ paymentId: 'boundary' })]) }
  ], '2026-09-21', '2026-09-27');
  assert.equal(result.mercadoPagoTips.amount, 1900);
  assert.equal(result.cashSales.amount, -2000);
  assert.equal(result.cashSales.coveredLocations, 2);
});

test('known empty periods are zero; absent, partial or invalid sources are incomplete', () => {
  const empty = toteatPaymentCollections([{ location, state: state([]) }], '2026-09-21', '2026-09-27');
  assert.equal(empty.cashSales.amount, 0);
  assert.equal(empty.cashSales.available, true);
  assert.equal(empty.cashSales.complete, true);
  const missing = toteatPaymentCollections([{ location, state: null }], '2026-09-21', '2026-09-27');
  assert.equal(missing.cashSales.available, false);
  assert.equal(missing.cashSales.complete, false);
  const partial = toteatPaymentCollections([{ location, state: { ...state([payment()]), through: '2026-09-23' } }], '2026-09-21', '2026-09-27');
  assert.equal(partial.mercadoPagoTips.amount, 1000);
  assert.equal(partial.cashSales.complete, false);
  assert.ok(partial.warnings.length);
  const invalid = toteatPaymentCollections([{ location, state: state([payment({ paymentForms: [{ id: 5008, amount: 1000 }] })]) }], '2026-09-21', '2026-09-27');
  assert.equal(invalid.mercadoPagoTips.complete, false);
  assert.equal(invalid.mercadoPagoTips.amount, 0);
});
