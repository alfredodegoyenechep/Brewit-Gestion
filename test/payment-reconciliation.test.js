const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcilePaymentDetail } = require('../payment-reconciliation');

test('compares only linked, unambiguous payment amounts', () => {
  const base = { saleWithDiscount: 9000, paymentDue: 9000, paymentMatched: true, paymentFilesRead: 1 };
  assert.deepEqual(reconcilePaymentDetail(base), { status: 'matched', difference: 0, basis: 'due', comparedAmount: 9000 });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentTotal: 9000, paymentDue: 4500 }),
    { status: 'matched', difference: 0, basis: 'total', comparedAmount: 9000 });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentTotal: 9000, paymentAmountAmbiguous: true }),
    { status: 'matched', difference: 0, basis: 'total', comparedAmount: 9000 });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentDue: 8000 }),
    { status: 'difference', difference: 1000, basis: 'due', comparedAmount: 8000 });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentDue: 8960 }),
    { status: 'matched', difference: 40, basis: 'due', comparedAmount: 8960 });
  for (const input of [
    { paymentAmountAmbiguous: true }, { paymentTotal: 9000, paymentTotalAmbiguous: true }
  ]) assert.deepEqual(reconcilePaymentDetail({ ...base, ...input }),
    { status: 'ambiguous', difference: null, basis: null, comparedAmount: null });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentMatched: false }),
    { status: 'not-linked', difference: null, basis: null, comparedAmount: null });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentFilesRead: 0 }),
    { status: 'no-source', difference: null, basis: null, comparedAmount: null });
  assert.deepEqual(reconcilePaymentDetail({ ...base, paymentDue: null }),
    { status: 'no-amount', difference: null, basis: null, comparedAmount: null });
  assert.deepEqual(reconcilePaymentDetail({ ...base, reversalReviewRequired: true }),
    { status: 'review-reversal', difference: null, basis: null, comparedAmount: null });
});
