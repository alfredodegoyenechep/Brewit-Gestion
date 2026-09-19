const test = require('node:test');
const assert = require('node:assert/strict');
const { reversalSignals } = require('../transaction-signals');

test('flags explicit reversal evidence without treating an ordinary payment document as a refund', () => {
  assert.deepEqual(reversalSignals({ orderAmount: -100, quantity: -1, lineAmount: -100, status: '', documentType: '' }), [
    'negative-order-amount', 'negative-quantity', 'negative-line-amount'
  ]);
  assert.deepEqual(reversalSignals({ orderAmount: 100, quantity: 1, lineAmount: 100, status: 'Anulada', documentType: 'BE' }), [
    'explicit-reversal-label'
  ]);
  assert.deepEqual(reversalSignals({ orderAmount: 100, quantity: 1, lineAmount: 100, status: '', documentType: 'NC' }), [
    'explicit-reversal-label'
  ]);
  assert.deepEqual(reversalSignals({ orderAmount: 100, quantity: 1, lineAmount: 100, status: '', documentType: 'BM' }), []);
});
