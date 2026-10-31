const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCollectionReconciliation: build } = require('../collection-reconciliation');
const form = (amount, reference = '', id = 5008, tip = 0) => ({ id, amount, reference, tip, name: id === 1000 ? 'Efectivo' : 'MercadoPago' });
const payment = (id, forms, dateTime = '2026-10-26T12:00:00') => ({ paymentId: id, orderId: id, dateTime, change: 0, forms });
const settlement = (id, amount, time = '2026-10-26T12:00:00', fee = 20) => ({ key: id, sourceId: id, transactionAmount: amount, collectedAmount: amount - fee, fee, dateTime: time });
const sale = (id, amount) => ({ orderKey: `store-1:order:${id}`, date: '2026-10-26', netSales: amount / 1.19 });

test('unique explicit references take priority, unmatched amounts sum to the report including fees and mixed cash payments', () => {
  const result = build({
    sales: [sale('P1', 1000), sale('P2', 1000), sale('mixed', 2000)],
    payments: [payment('P1', [form(1100, 'ORD123 VISA 123456789012', 5008, 100)]),
      payment('P2', [form(1000)]), payment('mixed', [form(1500, '223456789012'), form(500, '', 1000)])],
    settlements: [settlement('123456789012', 1100), settlement('223456789012', 1500), settlement('323456789012', 400)],
    totals: { collectionDifference: -600 }
  });
  assert.equal(result.totals.explained, -600);
  assert.equal(result.totals.exceptionTotal, -600);
  assert.equal(result.totals.reconciled, true);
  assert.equal(result.rows.filter(row => row.status === 'matched').length, 2);
  assert.deepEqual(result.exceptions.map(row => row.status).sort(), ['mp-only', 'toteat-only']);
  assert.equal(result.rows.find(row => row.status === 'cash').amount, 0);
});

test('ambiguous identical amounts stay unmatched and no operation is used twice', () => {
  const result = build({ sales: [sale('P1', 1000), sale('P2', 1000)],
    payments: [payment('P1', [form(1000)]), payment('P2', [form(1000)])],
    settlements: [settlement('MP1', 1000)], totals: { collectionDifference: -1000 } });
  assert.equal(result.rows.filter(row => row.status === 'ambiguous').length, 3);
  assert.equal(result.totals.exceptionTotal, -1000);
  assert.equal(result.totals.reconciled, true);
});

test('an explicit reference is retained with a different amount and estimated links are labelled', () => {
  const result = build({ sales: [sale('P1', 1000), sale('P2', 1000)],
    payments: [payment('P1', [form(1000, '123456789012')]), payment('P2', [form(1000)])],
    settlements: [settlement('123456789012', 1100), settlement('MP2', 1000)], totals: { collectionDifference: 100 } });
  assert.equal(result.totals.reconciled, true);
  assert.equal(result.exceptions[0].status, 'difference');
  assert.equal(result.exceptions[0].amount, 100);
  assert.match(result.rows.find(row => row.paymentId === 'P2').matching, /Estimado/);
});

test('sales/payment gaps, missing payments, negative adjustments and unknown source coverage are not hidden by artificial matching', () => {
  const result = build({ sales: [sale('no-payment', 100), sale('NC', -500), sale('overpaid', 1000)],
    payments: [payment('NC', [form(-500)]), payment('overpaid', [form(1200)])],
    settlements: [settlement('NCMP', -500, '2026-10-26T12:00:00', 0), settlement('MP', 1200)],
    totals: { collectionDifference: 100 } });
  assert.equal(result.totals.explained, 100);
  assert.equal(result.totals.exceptionTotal, 100);
  assert.equal(result.exceptions.filter(row => row.status === 'sales-payment-gap').length, 2);
  const bad = build({ sales: [], payments: [], settlements: [], totals: { collectionDifference: 50 } });
  assert.equal(bad.totals.reconciled, false);
  assert.equal(bad.totals.reportGap, 50);
  assert.equal(bad.rows.length, 0);
});

test('an explicit reference wins over another payment with the same amount and time', () => {
  const result = build({ sales: [sale('P1', 1000), sale('P2', 1000)],
    payments: [payment('P1', [form(1000, '123456789012')]), payment('P2', [form(1000)])],
    settlements: [settlement('123456789012', 1000)], totals: { collectionDifference: -1000 } });
  assert.equal(result.rows.find(row => row.paymentId === 'P1').status, 'matched');
  assert.equal(result.rows.find(row => row.paymentId === 'P2').status, 'toteat-only');
  assert.equal(result.totals.reconciled, true);
});

test('unmatched TotEat credit notes identify the original payment and explain their signed contribution', () => {
  const note = { ...payment('NC', [form(-15200)]), documentType: 'NC', referencedPaymentId: 'original-payment' };
  const result = build({ sales: [sale('NC', -15200)], payments: [note], settlements: [], totals: { collectionDifference: 15200 } });
  assert.equal(result.totals.creditNoteCount, 1);
  assert.equal(result.totals.creditNoteContribution, 15200);
  assert.match(result.exceptions[0].reason, /Nota de crédito.*original-payment/);
  assert.equal(result.totals.reconciled, true);
});
