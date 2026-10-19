const test = require('node:test');
const assert = require('node:assert/strict');
const { inboundResults } = require('../inventory-inbound');
const { finalizeCell, value } = require('../weekly-results');

const period = { from: '2026-10-05', to: '2026-10-11', through: '2026-10-11' };
const catalog = new Map([
  ['ING', { type: 'ingredient', unit: 'KG' }], ['SUB005', { type: 'product', unit: 'KG' }],
  ['PROD', { type: 'product', unit: 'UN' }], ['UNKNOWN-COST', { type: 'ingredient', unit: 'KG' }]
]);
function fixture(location = 'store-1') {
  const state = { sourceKind: 'native-documents', range: { from: '2026-09-01', to: '2026-10-13' },
    warehouses: [{ id: 'central', custom_id: 1 }, { id: 'operative', custom_id: 2 }, { id: 'waste', custom_id: 3 }],
    sourceCoverage: { transfers: { from: '2026-09-01', to: '2026-10-13' }, localTransfers: { from: '2026-09-01', to: '2026-10-13' }, purchases: { from: '2026-09-01', to: '2026-10-13' } },
    documents: [], operationLines: [], movements: [], issues: [] };
  const options = { state, location: { id: location }, centralIdentity: { restaurantId: 'r', localId: '1' }, period, catalog,
    costResolver: { resolve: code => code === 'UNKNOWN-COST' ? { source: 'missing', unitCost: 0 } : { source: 'purchase', unitCost: 10, sourceDate: '2026-10-04' } } };
  function add(id, column, quantity, extra = {}) {
    const line = { id, document: id, date: '2026-10-06', warehouse: 'operative', code: 'ING', unit: 'KG', column, quantity, active: true, ...extra };
    state.movements.push(line); return line;
  }
  function transfer(id, quantity, extra = {}) {
    state.documents.push({ key: id, id, status: 'APPROVED', originWarehouse: 'central' });
    return add(id, 'transfer_warehouse_in', quantity, extra);
  }
  function local(id, quantity, localId = '1', originWarehouseCode = 1, extra = {}) {
    state.documents.push({ key: id, id, status: 'APPROVED', originIdentity: { restaurantId: 'r', localId } });
    return add(id, 'transfer_local_in', quantity, { originWarehouseCode, ...extra });
  }
  return { options, state, add, transfer, local, result: () => inboundResults(options) };
}

test('central receipts include ingredients and SUB005, use the operative destination and deduplicate source copies only', () => {
  const f = fixture();
  const ingredient = f.transfer('one', 2);
  f.state.operationLines.push(ingredient);
  f.transfer('two', 2); // Equal legitimate entries remain separate.
  f.transfer('coffee', 3, { code: 'SUB005' });
  f.transfer('product', 100, { code: 'PROD' });
  f.transfer('waste', 100, { warehouse: 'waste' });
  f.transfer('future', 100, { date: '2026-10-12' });
  f.transfer('old', 100, { date: '2026-10-04' });
  f.transfer('cancelled', 100, { active: false });
  f.transfer('created', 100, { status: 'CREATED' });
  f.add('return', 'transfer_warehouse_out', 100);
  f.add('transform', 'transformed_in', 100);
  const data = f.result();
  assert.equal(data.values.centralWarehouseInbound.amount, 70);
  assert.equal(data.values.centralWarehouseInbound.status, 'complete');
  assert.deepEqual(data.sources.centralWarehouseInbound.items.map(item => item.id), ['one', 'two', 'coffee']);
  assert.equal(data.values.directSupplierInbound.amount, 0);
  const values = finalizeCell({ values: { ...data.values, netSales: value(1000, 'complete') } }, false).values;
  assert.equal(values.centralWarehouseInbound.amount, 70);
  assert.ok(Math.abs(values.centralWarehouseInbound.percent - 7) < 1e-9);
});

test('Lyon central receipts require restaurant, local 001 and dispatch warehouse 1, not the receiving warehouse or local name', () => {
  const f = fixture('store-2');
  f.local('central', 2);
  f.local('concepcion-cafe', 100, '1', 2);
  f.local('other-local', 100, '3', 1);
  f.local('other-restaurant', 100);
  f.state.documents.at(-1).originIdentity.restaurantId = 'other';
  f.transfer('lyon-central', 100);
  assert.equal(f.result().values.centralWarehouseInbound.amount, 20);
  f.local('unknown-origin', 5, '1', null);
  const data = f.result();
  assert.equal(data.values.centralWarehouseInbound.amount, 20);
  assert.equal(data.values.centralWarehouseInbound.status, 'partial');
  assert.equal(data.values.centralWarehouseInbound.unresolvedOriginCount, 1);
});

test('direct suppliers count only positive purchases received in the operative warehouse, including non-ingredient purchases', () => {
  const f = fixture();
  f.add('purchase', 'purchase', 2);
  f.add('product-purchase', 'purchase', 3, { code: 'PROD', unit: 'UN' });
  f.add('central-purchase', 'purchase', 100, { warehouse: 'central' });
  f.add('credit-note', 'purchase', -100);
  f.add('future', 'purchase', 100, { date: '2026-10-12' });
  f.transfer('transfer', 10);
  f.local('local-transfer', 10, '3');
  const data = f.result();
  assert.equal(data.values.directSupplierInbound.amount, 50);
  assert.deepEqual(data.sources.directSupplierInbound.items.map(item => item.id), ['purchase', 'product-purchase']);
});

test('verified no receipts is zero; absent coverage, rejected conversions and missing costs never certify a zero', () => {
  const f = fixture();
  assert.equal(f.result().values.directSupplierInbound.amount, 0);
  f.state.sourceCoverage.purchases = null;
  assert.equal(f.result().values.directSupplierInbound.amount, null);
  f.add('missing', 'purchase', 2, { code: 'UNKNOWN-COST' });
  assert.equal(f.result().values.directSupplierInbound.amount, null);
  f.add('known', 'purchase', 3);
  let metric = f.result().values.directSupplierInbound;
  assert.equal(metric.amount, 30);
  assert.equal(metric.status, 'partial');
  assert.deepEqual(metric.missingCostCodes, ['UNKNOWN-COST']);
  f.add('unconverted', 'purchase', 50, { active: false, conversionPending: true });
  assert.equal(f.result().values.directSupplierInbound.amount, 30);
  const empty = fixture();
  empty.state.issues.push({ kind: 'purchase-line', message: 'Compra sin unidad convertible.' });
  assert.equal(empty.result().values.directSupplierInbound.amount, null);
  empty.state.issues = [{ kind: 'unit-conversion', source: 'purchases', date: '2026-10-06', message: 'Conversión pendiente.' }];
  assert.equal(empty.result().values.directSupplierInbound.amount, null);
  empty.state.issues = [];
  empty.options.period = { from: '2026-08-01', through: '2026-08-31' };
  assert.equal(empty.result().values.directSupplierInbound.amount, null);
});

test('daily valuation retains the parent period cutoff and missing provenance marks central amounts incomplete', () => {
  const f = fixture();
  f.options.period = { from: '2026-10-06', to: '2026-10-06', through: '2026-10-06', valuationThrough: '2026-10-11' };
  f.transfer('in', 2);
  assert.equal(f.result().sources.centralWarehouseInbound.costCutoff, '2026-10-11');
  delete f.state.documents[0].originWarehouse;
  assert.equal(f.result().values.centralWarehouseInbound.amount, null);
  f.add('out', 'transfer_warehouse_out', 2, { warehouse: 'central', document: 'in' });
  assert.equal(f.result().values.centralWarehouseInbound.amount, 20);
  assert.throws(() => inboundResults({ ...f.options, state: null }), /documentos originales/);
});

test('main warehouse separates supplier receipts, returns and dispatches without counting waste twice', () => {
  const f = fixture();
  f.options.location = { id: 'main-warehouse', type: 'warehouse' };
  f.state.warehouses.push({ id: 'central-waste', custom_id: 4 });
  const move = (id, column, quantity, other = {}) => f.add(id, column, quantity, { warehouse: 'central', ...other });
  move('purchase', 'purchase', 10);
  move('cafeteria-purchase', 'purchase', 100, { warehouse: 'operative' });
  f.state.documents.push({ key: 'return', originWarehouse: 'operative' },
    { key: 'dispatch', destinationWarehouse: 'operative' },
    { key: 'waste', destinationWarehouse: 'central-waste' },
    { key: 'local-return', originIdentity: { restaurantId: 'r', localId: '2' } });
  move('return', 'transfer_warehouse_in', 2);
  move('local-return', 'transfer_local_in', 3, { originWarehouseCode: 2 });
  move('dispatch', 'transfer_warehouse_out', 4);
  move('local-dispatch', 'transfer_local_out', 5);
  move('waste', 'transfer_warehouse_out', 100);
  move('cancelled', 'transfer_local_out', 100, { active: false });
  move('future', 'purchase', 100, { date: '2026-10-12' });
  const data = f.result();
  assert.equal(data.values.directSupplierInbound.amount, 100);
  assert.equal(data.values.centralWarehouseInbound.amount, 50);
  assert.equal(data.values.suppliesOutbound.amount, 90);
  assert.equal(data.values.suppliesOutbound.status, 'complete');
  assert.deepEqual(data.sources.suppliesOutbound.items.map(item => item.id), ['dispatch', 'local-dispatch']);
  delete f.state.sourceCoverage.localTransfers;
  assert.equal(f.result().values.suppliesOutbound.status, 'partial');
  move('unknown', 'transfer_warehouse_in', 100);
  assert.equal(f.result().values.centralWarehouseInbound.unresolvedOriginCount, 1);
  assert.equal(f.result().values.centralWarehouseInbound.amount, 50);
});
