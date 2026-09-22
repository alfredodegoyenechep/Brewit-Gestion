const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMasterSync } = require('../toteat-masters');
function fixture(localId = '1') {
  return { restaurantId: 'r', localId, localRef: `local-${localId}`, capturedAt: '2026-09-22T01:00:00Z',
    products: [{ id: `p-${localId}`, custom_id: 'SAME-SKU', types: ['PRODUCT'], stock_enabled: true, stock_unit: 'UN', status: 'ACTIVE' }],
    items: [{ m_id: `p-${localId}`, tp: 10, pl: 'SAME-SKU', st: 1, det: { np: `Store ${localId}`, wact: true, ub: 'UN' } }],
    hierarchies: { products: [], ingredients: [], extras: [] }, warehouses: [] };
}
function setup(t, reader = async () => fixture()) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-masters-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  return createMasterSync({ uploadsRoot, credentials: () => ({ a: { restaurantId: 'r', localId: '1' }, b: { restaurantId: 'r', localId: '2' } }),
    activeLocation: id => ['a', 'b'].includes(id) ? { type: 'store' } : null, reader });
}
test('masters stay isolated by store even when their SKUs match, and are never backdated', t => {
  const sync = setup(t); sync.publish('a', fixture()); sync.publish('b', fixture('2'));
  assert.equal(sync.current('a').products[0].id, 'p-1');
  assert.equal(sync.current('b').products[0].id, 'p-2');
  assert.equal(sync.files('a', 'master-catalog')[0].validFrom, '2026-09-21');
  assert.equal(sync.files('a', 'master-catalog').some(f => f.validFrom <= '2026-08-30'), false);
  assert.throws(() => sync.current('../a'), /válida/);
});
test('incomplete or wrong-store captures retain the last good version', t => {
  const sync = setup(t); sync.publish('a', fixture()); const previous = sync.current('a');
  assert.throws(() => sync.publish('a', fixture('2')), /corresponde/);
  assert.throws(() => sync.publish('a', { ...fixture(), products: [] }), /incompletos/);
  assert.deepEqual(sync.current('a'), previous);
});
test('a session failure keeps masters and does not expose upstream credentials', async t => {
  const sync = setup(t, async () => { throw Error('sensitive-token'); }); sync.publish('a', fixture());
  await assert.rejects(sync.synchronize('a'), /sesión web/);
  assert.equal(sync.current('a').products.length, 1);
  assert.equal(sync.status('a').running, false);
  assert.equal(JSON.stringify(sync.status('a')).includes('sensitive-token'), false);
});
test('repeated captures preserve versions instead of replacing history', t => {
  const sync = setup(t); sync.publish('a', fixture()); sync.publish('a', fixture());
  assert.equal(sync.files('a', 'master-catalog').length, 2);
});

test('shared synchronization always reads La Concepcion and publishes all six categories together', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-shared-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  let fail = false, reads = 0;
  const sync = createMasterSync({ uploadsRoot, activeLocation: () => ({ type: 'store' }),
    credentials: () => ({ 'store-1': { restaurantId: 'r', localId: '1' }, 'store-2': { restaurantId: 'r', localId: '2' } }),
    reader: async (identity, options) => {
      reads++;
      assert.equal(identity.localId, '1'); assert.equal(options.includeSuppliers, true);
      const s = fixture();
      if (!fail) s.suppliers = [{ id: 's1', custom_id: '1', name: 'Supplier', vat: '11111111-1' }];
      s.items[0].det.conv = [{ umed: 'BOX', umedb: 'UN', cnum: 12, cden: 1 }];
      s.hierarchies.products = [{ listado: [['AB.', 0, 'Root', '', false, [], 0], ['AB.010', 10, 'Child', 'AB.', true, [], 1]] }];
      return s;
    } });
  const one = sync.synchronizeShared(), two = sync.synchronizeShared(); assert.equal(one, two);
  await one;
  const indexPath = path.join(uploadsRoot, 'masters', 'masters.json');
  const first = fs.readFileSync(indexPath, 'utf8'), index = JSON.parse(first), group = Object.values(index)[0];
  assert.equal(Object.keys(group).length, 6);
  assert.equal(sync.sharedStatus().counts.suppliers, 1);
  assert.equal(sync.sharedCurrent().localId, '1');
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(path.join(uploadsRoot, 'masters', group['master-catalog'].name));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Prod, { header: 1 });
  assert.equal(rows[2][rows[0].indexOf('conv.0.cnum')], 12);
  const hw = XLSX.readFile(path.join(uploadsRoot, 'masters', group['product-hierarchy'].name));
  assert.equal(XLSX.utils.sheet_to_json(hw.Sheets.Jerarquias)[1]['ID nodo padre'], 'AB.');
  assert.equal(reads, 1);
  // Reading Lyon independently must never change the global master index.
  sync.publish('store-2', fixture('2'));
  assert.equal(fs.readFileSync(indexPath, 'utf8'), first);
  fail = true;
  await assert.rejects(sync.synchronizeShared(), /versión compartida anterior/);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), first);
  assert.equal(sync.sharedCurrent().suppliers.length, 1);
  fail = false; await sync.synchronizeShared();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(indexPath, 'utf8'))).length, 2);
});
