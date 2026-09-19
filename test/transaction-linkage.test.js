const test = require('node:test');
const assert = require('node:assert/strict');
const { linkOrdersToSettlements } = require('../transaction-linkage');

test('vincula solo coincidencias mutuas y deja ambigüedades visibles', () => {
  const orders = [{ orderKey: 'o1', locationId: 's1', date: '2026-09-01', dateTime: '2026-09-01T10:00:00', paymentPaid: 5000 },
    { orderKey: 'o2', locationId: 's1', date: '2026-09-01', dateTime: '2026-09-01T11:00:00', paymentPaid: 7000 },
    { orderKey: 'o3', locationId: 's1', date: '2026-09-01', dateTime: '2026-09-01T11:01:00', paymentPaid: 7000 }];
  const settlements = [{ key: 'm1', locationId: 's1', date: '2026-09-01', dateTime: '2026-09-01T10:01:00', amount: 5000, instrumentKey: 'h1' },
    { key: 'm2', locationId: 's1', date: '2026-09-01', dateTime: '2026-09-01T11:00:00', amount: 7000, instrumentKey: 'h2' }];
  const result = linkOrdersToSettlements(orders, settlements);
  assert.equal(result.links.get('o1').status, 'estimated-high');
  assert.equal(result.links.get('o1').instrumentKey, 'h1');
  assert.equal(result.links.get('o2').status, 'ambiguous');
  assert.equal(result.links.get('o3').status, 'ambiguous');
  assert.equal(result.coverage.linkedHigh, 1);
  assert.match(result.coverage.method, /estimada/i);
});
