const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modeFor, selectSamples, timingEvidence, probeOrder } = require('../scripts/validate-toteat-delivery');

function payment(orderId, comment, products = [{ id: 'P1', lineId: `${orderId}1`, quantity: 1, payed: 100 }]) {
  return { orderId, comment, total: 100, fiscalType: 'BE', dateOpen: `2026-10-05T10:00:0${orderId}`,
    dateClosed: `2026-10-05T10:01:0${orderId}`, products };
}
test('short mode labels work and conflicting or missing labels remain unknown', () => {
  assert.equal(modeFor('servir'), 'local');
  assert.equal(modeFor('llevar'), 'takeaway');
  assert.equal(modeFor('servir y llevar'), 'unknown');
  assert.equal(modeFor(''), 'unknown');
});
test('five distinct orders cover local, takeaway and multiple main products without claiming staggered delivery', () => {
  const payments = [payment('1', 'Servir en el local'), payment('2', 'Servir en el local'),
    payment('3', 'Para llevar'), payment('4', 'Para llevar'), payment('5', 'Para llevar', [
      { id: 'P1', lineId: '51', quantity: 1, payed: 100 },
      { id: 'P2', lineId: '52', quantity: 1, payed: 100 }]),
    { ...payment('6', 'Servir en el local'), fiscalType: 'NC' }];
  const original = JSON.stringify(payments);
  const samples = selectSamples([...payments, { ...payments[0] }]);
  assert.equal(samples.length, 5);
  assert.equal(new Set(samples.map(s => s.orderId)).size, 5);
  assert.equal(samples.filter(s => s.scenario === 'local').length, 2);
  assert.equal(samples.filter(s => s.scenario === 'takeaway').length, 2);
  assert.match(samples[0].scenario, /staggered-delivery-unconfirmed/);
  assert.equal(samples[0].lines.length, 2);
  assert.ok(samples.every(s => s.observedDeliveryAt === null && s.comparison === 'pending'));
  assert.equal(JSON.stringify(payments), original);
  assert.ok(samples.every(s => !('comment' in s)));
});
test('extras cannot stand in for a second product and insufficient samples stop the pilot', () => {
  const rows = ['1', '2', '3', '4', '5'].map(id => payment(id, id < '3' ? 'Servir en el local' : 'Para llevar', [
    { id: 'P1', lineId: `${id}1`, quantity: 1, payed: 100 },
    { id: 'EXTRA', lineId: `${id}2`, lineReference: `${id}1`, quantity: 1, payed: 0 }]));
  assert.throws(() => selectSamples(rows), /cinco pedidos/);
});
test('timestamps keep their distinct roles and customer information is omitted', () => {
  const evidence = timingEvidence({ dateClosed: '2026-10-05T10:01:00',
    modificationDate: '2026-10-05T10:05:00', time: '2026-10-05T10:05:03Z',
    deliveredAt: '2026-10-05T10:04:00Z', status: 'DELIVERED',
    customer: { phone: 'private', modificationDate: '2026-10-05T10:00:00' },
    token: 'secret', comments: [{ deliveredAt: '2026-10-05T10:00:00' }] });
  assert.deepEqual(evidence.map(e => e.role), ['account-close', 'last-modification',
    'notification-generated', 'delivery-candidate-unverified', 'current-status']);
  assert.doesNotMatch(JSON.stringify(evidence), /private|secret|customer|comments/);
});
test('HTTP 200 with Not Authorized is access denied and does not expose upstream errors', async () => {
  const credential = { restaurantId: 'r', localId: 'l', userId: 'u', token: 'secret' };
  const result = await probeOrder(credential, { orderId: '123' }, async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('det'), 'true');
    return { ok: true, status: 200, json: async () => ({ ok: false,
      msg: { texto: 'Not Authorized secret https://private-url/' } }) };
  });
  assert.equal(result.status, 'access-denied');
  assert.deepEqual(result.evidence, []);
  assert.doesNotMatch(JSON.stringify(result), /secret|private-url/);
});
test('readable states are not certified delivery and mismatched order identities are rejected', async () => {
  const credential = { restaurantId: 'r', localId: 'l', userId: 'u', token: 'secret' };
  const response = data => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  const readable = await probeOrder(credential, { orderId: '123' }, response({ orderId: '123',
    status: 'DELIVERED', modificationDate: '2026-10-05T10:05:00' }));
  assert.equal(readable.status, 'readable; delivery-unverified');
  const wrong = await probeOrder(credential, { orderId: '123' }, response({ orderId: '456', status: 'DELIVERED' }));
  assert.equal(wrong.status, 'identity-unconfirmed');
  assert.deepEqual(wrong.evidence, []);
});
