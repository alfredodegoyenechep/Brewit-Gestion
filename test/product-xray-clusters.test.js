const test = require('node:test'), assert = require('node:assert/strict');
const { analyze } = require('../product-xray-clusters');
const report = { family: { id: 'coffee', codes: ['CL', 'GR', 'XTR'] }, scope: { location: 'store-1' }, period: { from: '2026-10-01', to: '2026-10-30' }, asOf: '2026-10-30T15:00:00', sourceVersion: 'source-reviews-v1' };
function order(i, group = i % 2) {
  const lines = [{ code: group ? 'GR' : 'CL', name: 'Café', quantity: 1, netSales: 2000, categoryPath: ['Barra'], rootHierarchyId: 'COFFEE' },
    ...(group ? [{ code: 'SAND', name: 'Sándwich', quantity: 2, netSales: 6000, categoryPath: ['Retail'], rootHierarchyId: 'FOOD' }] : [])];
  return { orderKey: `store-1:${i}`, locationId: 'store-1', locationName: 'Local', date: `2026-10-${String(1 + Math.floor(i / 2) % 10).padStart(2, '0')}`, time: group ? '18:00' : '09:00',
    netSales: group ? 8000 : 2000, orderDiscount: 0, mode: group ? 'dineIn' : 'takeaway', validatedGender: group ? 'feminine' : 'masculine', genderBasis: 'manual', lines };
}
test('automatic analysis keeps full baskets, all formats, current gender and production statistical checks', () => {
  const orders = Array.from({ length: 120 }, (_, i) => order(i)); const updates = [];
  const r = analyze(report, orders, message => updates.push(message));
  assert.equal(r.automatic, true); assert.equal(r.sourceVersion, report.sourceVersion); assert.deepEqual(r.filters.productCodes, report.family.codes);
  assert.equal(r.summary.orders, 120); assert.equal(r.summary.netSales, 600000);
  assert.equal(r.validation.complete, true); assert.equal(r.validation.bootstrapRuns, 20); assert.equal(r.validation.nullRuns, 20);
  assert.ok(r.clusters.length >= 2); assert.ok(r.clusters.some(c => c.profile.products.some(p => p.code === 'SAND')));
  assert.equal(r.coverage.find(d => d.key === 'gender').coverage, 100);
  assert.equal(r.clusters.reduce((n, c) => n + c.orders, 0) + r.unassigned.orders, 120);
  assert.ok(r.clusters.every(c => !('examples' in c) && !('representative' in c) && (c.status === 'solid') === c.checks.every(check => check.passed)));
  assert.ok(updates.length > 20); assert.equal('membership' in r, false);
});
test('insufficient data explains lack of clusters and cutoff and source versions remain aligned', () => {
  const late = { ...order('late'), date: '2026-10-30', dateTime: '2026-10-30T16:00:00' };
  const r = analyze(report, [order(0), order(0), order(1), late, { ...order(2), date: '2026-09-30' }]);
  assert.equal(r.summary.orders, 2); assert.equal(r.status, 'insufficient'); assert.equal(r.clusters.length, 0); assert.match(r.conclusion, /No se identifican/);
  assert.equal(r.parameters.minimumOrders, 100); assert.equal(r.sourceFingerprint, report.sourceVersion);
  const next = analyze({ ...report, sourceVersion: 'source-reviews-v2' }, [order(0)]); assert.notEqual(next.sourceVersion, r.sourceVersion); assert.notEqual(next.seed, r.seed);
});
