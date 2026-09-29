const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createCountSync } = require('../toteat-counts');
const source = () => ({ restaurantId: 'r', localId: '1', localRef: 'local', capturedAt: '2026-09-28T19:00:00Z',
  range: { from: '2026-08-23', to: '2026-09-28' }, products: [{ id: 'p', custom_id: 'CCB001', stock_unit: 'KG', name: { translations: { default: 'Boba' } } }],
  warehouses: [{ id: 'central', custom_id: 1, name: 'Central' }, { id: 'local', custom_id: 2, name: 'Local' }],
  operations: { counts: [
    { id: 1, status: 'APPROVED', registration_date: '2026-08-30 00:00:00', warehouse_ref: 'local', take_inventory_products: [{ id: 1, product_ref: 'p', quantity: 2500, measure_unit_ref: 'G' }] },
    { id: 2, status: 'CREATED', registration_date: '2026-08-30 00:00:00', warehouse_ref: 'central', take_inventory_products: [{ id: 2, product_ref: 'p', quantity: 0, measure_unit_ref: 'KG' }] }
  ] } });
function options(t) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-counts-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  return { uploadsRoot, activeLocation: id => id === 'store-1' ? { type: 'store' } : null, credentials: () => ({ 'store-1': { restaurantId: 'r', localId: '1' } }) };
}
test('original counts retain documents, zeros, units and statuses and filter warehouse records', t => {
  const sync = createCountSync(options(t)); sync.publish('store-1', source());
  assert.equal(sync.status('store-1').documents, 2); assert.equal(sync.status('store-1').approved, 1);
  const local = sync.records('store-1', '2026-08-30', '2026-08-30');
  assert.equal(local.rows.length, 1); assert.equal(local.rows[0]['Cantidad toma'], 2.5);
  assert.equal(local.rows[0]['Cantidad original'], 2500); assert.equal(local.rows[0].Documento, 1);
  const central = sync.records('main-warehouse', '2026-08-30', '2026-08-30');
  assert.equal(central.rows[0]['Cantidad toma'], 0); assert.equal(central.rows[0]['Afecta inventario'], 'No');
  assert.equal(sync.records('store-1', '2026-09-01', '2026-09-28').rows.length, 0);
});
test('invalid/incomplete reads preserve last publication; later success clears persisted error', async t => {
  const opts = options(t); let fail = true;
  const sync = createCountSync({ ...opts, reader: async (_, query) => { assert.deepEqual(query.operationKinds, ['counts']); if (fail) throw Error('secret'); return source(); } });
  sync.publish('store-1', source());
  const bad = source(); bad.operations.counts[0].warehouse_ref = 'foreign';
  assert.throws(() => sync.publish('store-1', bad), /Bodega/);
  assert.throws(() => sync.publish('store-1', { ...source(), localId: '2' }), /otro local/);
  await assert.rejects(sync.synchronize('store-1', source().range), /última versión/);
  assert.equal(sync.current('store-1').documents.length, 2);
  assert(!sync.status('store-1').error.includes('secret'));
  fail = false; await sync.synchronize('store-1', source().range); assert.equal(sync.status('store-1').error, null);
});
test('record and overview endpoints expose original count documents as their own source', async t => {
  const opts = options(t), { createApp } = require('../server');
  const folder = path.join(opts.uploadsRoot, '.integrations/toteat-api');fs.mkdirSync(folder, { recursive: true });fs.writeFileSync(path.join(folder, 'credentials.json'), JSON.stringify(opts.credentials()));
  const app = createApp({ uploadsRoot: opts.uploadsRoot }); app.locals.toteatCountSync.publish('store-1', source());
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = await fetch(base + '/api/uploads/records?location=store-1&field=counts&from=2026-08-23&to=2026-09-28').then(r => r.json());
  assert.equal(data.rows[0].Documento, 1); assert.equal(data.total, 1);
  const overview = await fetch(base + '/api/uploads/overview').then(r => r.json());
  assert.match(overview.rows.find(r => r.id === 'store-1').cells.find(c => c.key === 'counts').origin, /documentos originales/);
});
