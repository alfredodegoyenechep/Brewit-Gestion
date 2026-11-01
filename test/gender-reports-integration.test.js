const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { setup, fill, IDS } = require('./helpers/gender-review-fixture');
const { DEFAULT_DIMENSIONS } = require('../sales-clusters');

test('current assignments reach product, characterization, filtered sections and the persistent cluster worker', async t => {
  const s = await setup(t, { clusterSourceWorker: true });
  const get = async path => { const r = await fetch(s.base + path); assert.equal(r.status, 200); return r.json(); };
  const demand = '/api/demand-analysis?locations=all&mode=custom&dateFrom=2026-10-01&dateTo=2026-10-07';
  const product = '/api/sales/product-gender?location=all&period=custom&dateFrom=2026-10-01&dateTo=2026-10-07';
  const clusters = '/api/sales-clusters/options?locations=all&mode=custom&dateFrom=2026-10-01&dateTo=2026-10-07';
  async function assign(assignments) {
    const book = XLSX.read(Buffer.from(await (await fetch(s.base + '/api/sales/gender-review/export?status=all')).arrayBuffer()));
    const form = new FormData(); form.append('file', new Blob([fill(book, assignments)]), 'asignaciones.xlsx');
    const preview = await fetch(s.base + '/api/sales/gender-review/import/preview', { method: 'POST', body: form });
    assert.equal(preview.status, 200); const { id } = await preview.json();
    const applied = await fetch(s.base + '/api/sales/gender-review/import/apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    assert.equal(applied.status, 200);
  }
  const beforeProduct = await get(product), beforeDemand = await get(demand);
  assert.equal(beforeDemand.nameSegments.classifiableOrders, 1);
  assert.equal((await get(clusters)).coverage.find(d => d.key === 'gender').known, 1);
  await assign({ [`store-1:${IDS.name}`]: 'Femenino', [`store-1:${IDS.literal}`]: 'Femenino',
    [`store-1:${IDS.blank}`]: 'Sin información', [`store-1:${IDS.negation}`]: 'No atribuible', [`store-2:${IDS.name}`]: 'Masculino' });
  const afterProduct = await get(product), afterDemand = await get(demand);
  assert.equal(afterProduct.totals.netSales, beforeProduct.totals.netSales);
  assert.deepEqual(Object.values(afterProduct.totals.genders).map(g => g.netSales), [1000, 2000, 2000]);
  assert.equal(afterDemand.summary.orders, beforeDemand.summary.orders);
  assert.deepEqual(afterDemand.nameSegments.segments.map(s => s.orders), [2, 1, 1, 1]);
  assert.equal(afterDemand.nameSegments.reviewedOrders, 5);
  const options = await get(clusters);
  assert.equal(options.coverage.find(d => d.key === 'gender').known, 3);
  assert.equal(options.identityDiagnostics.gender.named, 3);
  const female = await get(demand + '&nameGender=feminine-associated');
  assert.equal(female.summary.orders, 2); assert.equal(female.summary.netSales, 2000);
  assert.equal(female.coverage.orders, 2); assert.equal(female.priceSignals.paidPriceObservations, 2);
  assert.equal(female.nameSegments.segments.find(s => s.key === 'feminine-associated').orders, 2);
  const details = await get(demand.replace('/api/demand-analysis?', '/api/demand-analysis/orders?') + '&nameGender=feminine-associated');
  assert.equal(details.total, 2); assert.ok(details.orders.every(o => o.nameClassificationMethod === 'manual'));
  const filteredCoverage = await get(clusters + '&nameGender=feminine-associated'); assert.equal(filteredCoverage.orders, 2);
  const body = { filters: { locations: 'all', mode: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', nameGender: 'feminine-associated' },
    dimensions: Object.fromEntries(Object.entries(DEFAULT_DIMENSIONS).map(([key, d]) => [key, { ...d, enabled: key === 'gender' }])),
    parameters: { minimumOrders: 2 } };
  const created = await fetch(s.base + '/api/sales-clusters/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(created.status, 202); const job = await created.json();
  for (let i = 0; i < 200; i++) {
    const state = await get(`/api/sales-clusters/jobs/${job.id}`);
    if (state.status === 'completed') break;
    assert.notEqual(state.status, 'failed'); await new Promise(r => setTimeout(r, 20));
  }
  const result = await get(`/api/sales-clusters/jobs/${job.id}/result`); assert.equal(result.summary.orders, 2); assert.equal(result.stale, false);
  await assign({ [`store-1:${IDS.literal}`]: 'Sin información' });
  assert.equal((await get(product)).totals.genders.feminine.netSales, 1000);
  assert.equal((await get(demand)).nameSegments.classifiableOrders, 2);
  assert.equal((await get(clusters)).coverage.find(d => d.key === 'gender').known, 2);
  assert.equal((await get(`/api/sales-clusters/jobs/${job.id}/result`)).stale, true);
  for (const extra of [{ parent: { jobId: job.id, clusterId: 'old' } }, { referenceJobId: job.id }]) {
    const stale = await fetch(s.base + '/api/sales-clusters/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) });
    assert.equal(stale.status, 409); assert.match((await stale.json()).error, /asignaciones de género cambiaron/);
  }
});
