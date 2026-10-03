const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentLocalTimestamp } = require('../payment-timestamps');
const { linkOrdersToSettlements } = require('../transaction-linkage');

test('Mercado Pago respeta el instante y el horario de invierno/verano de Santiago', () => {
  assert.equal(paymentLocalTimestamp('2026-08-30T18:38:56.000-04:00'), '2026-08-30T18:38:56');
  assert.equal(paymentLocalTimestamp('2026-09-30T18:38:56.000-04:00'), '2026-09-30T19:38:56');
  assert.equal(paymentLocalTimestamp('2026-09-30T19:38:56-03:00'), '2026-09-30T19:38:56');
  assert.equal(paymentLocalTimestamp(new Date('2026-10-01T02:30:00Z')), '2026-09-30T23:30:00');
  assert.equal(paymentLocalTimestamp('2026-09-30T19:38:56'), null);
  assert.equal(paymentLocalTimestamp('invalid'), null);
});

test('la normalización recupera el vínculo sin ampliar la tolerancia de dos minutos', () => {
  const order = { orderKey: 'o', locationId: 's', date: '2026-09-30', dateTime: '2026-09-30T19:38:00', paymentPaid: 4800 };
  const payment = { key: 'm', locationId: 's', date: '2026-09-30',
    dateTime: paymentLocalTimestamp('2026-09-30T18:38:56.000-04:00'), amount: 4800, instrumentKey: 'hash' };
  assert.equal(linkOrdersToSettlements([order], [payment]).links.get('o').status, 'estimated-high');
});
