const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const {reconcilePurchaseWarehouses} = require('../purchase-warehouses');
const {createPurchaseSync} = require('../toteat-purchases');
const {createApp} = require('../server');

const document = (id = '322985', sku = 'CCB001', quantity = 3.4, warehouse = 1) => ({
  movement_id: id, document_id: '22978', document_type: 'STANDARD_INVOICE', movement_class: 'PROVIDERS', local_id: 1,
  provider_id: '763646696', provider: 'ADELE ORIGINAL', emission_date: '20260904', received_date: '20260904', total_amount: quantity * 8581,
  products: [{sku, product: sku, warehouse, invoice_quantity: quantity, received_quantity: quantity,
    invoice_measurement: 'KG', received_measurement: 'KG', unit_price: 8581, total_price: quantity * 8581}]
});
const evidence = (sku = 'CCB001', quantities = [0, 3.4], unit = 'KG') => ({sku, unit,
  warehouses: quantities.map((purchase, index) => ({warehouse_id: index + 1, inventory: [{date: '20260904', purchase}]}))});
const batches = (...data) => [{from: '2026-08-31', to: '2026-09-07', capturedAt: '2026-10-06T00:00:00Z', data}];

test('invoice 22978 retains the purchase API warehouse despite conflicting inventory', () => {
  const doc = document(); doc.products.push({...doc.products[0], sku: 'CCB006'});
  const before = structuredClone(doc);
  const input = batches(evidence(), evidence('CCB006'));
  const result = reconcilePurchaseWarehouses([doc], input);
  assert.deepEqual(doc, before);
  assert.deepEqual(result.documents[0].products.map(line => line.warehouse), [1, 1]);
  assert.equal(result.documents[0].products[0].received_quantity, 3.4);
  assert.equal(result.documents[0].total_amount, before.total_amount);
  assert.equal(result.documents[0].products[0].warehouse_reconciliation.status, 'discrepancy');
  assert.equal(result.documents[0].products[0].warehouse_reconciliation.source, 'accountingmovements');
  assert.equal(result.warnings.filter(w => w.type === 'warehouse-discrepancy').length, 2);
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(reconcilePurchaseWarehouses(result.documents, input), result);
});

test('split receipts, identical lines, credits and quantity differences never reroute or block purchases', () => {
  const docs = [document('a', 'CCB001', 100, 1), document('b', 'CCB001', 200, 2), document('credit', 'CCB001', -10, 2)];
  docs[0].products.push({...docs[0].products[0]});
  for (const amounts of [[200, 190], [390, 0], [0, 0], [1, 2]]) {
    const result = reconcilePurchaseWarehouses(docs, batches(evidence('CCB001', amounts)));
    assert.deepEqual(result.documents.map(d => d.products.map(line => line.warehouse)), [[1, 1], [2], [2]]);
    assert.deepEqual(result.documents.map(d => d.products.map(line => line.received_quantity)), [[100, 100], [200], [-10]]);
    assert.equal(result.corrections.length, 0);
  }
});

test('converted units are advisory; missing stock and unknown conversions retain purchase warehouses', () => {
  const doc = document(); doc.products[0].received_quantity = 3400; doc.products[0].received_measurement = 'G';
  assert.equal(reconcilePurchaseWarehouses([doc], batches(evidence('CCB001', [3.4, 0]))).documents[0].products[0].warehouse_reconciliation.status, 'verified');
  assert.equal(reconcilePurchaseWarehouses([doc], batches()).documents[0].products[0].warehouse, 1);
  doc.products[0].received_measurement = 'BAG';
  const result = reconcilePurchaseWarehouses([doc], batches(evidence()));
  assert.equal(result.documents[0].products[0].warehouse, 1);
  assert.equal(result.warnings[0].type, 'warehouse-unverified');
  assert.equal(reconcilePurchaseWarehouses([doc], batches(), [{code: 'CCB001', stockManaged: false}]).warnings[0].type, 'warehouse-not-applicable');
});

test('comparison still detects invalid evidence without ever modifying input documents', () => {
  const docs = [document()], before = structuredClone(docs);
  assert.throws(() => reconcilePurchaseWarehouses(docs, batches(evidence(), evidence())), /duplicada/);
  assert.throws(() => reconcilePurchaseWarehouses(docs, batches(evidence('CCB001', [NaN, 0]))), /inválida/);
  assert.deepEqual(docs, before);
});

test('bottle conversion tolerances affect comparison only, never warehouse or purchased quantity', () => {
  const doc = document('syrup', 'SSR018', 12, 2); doc.products[0].received_measurement = 'BOT';
  const master = [{code: 'SSR018', conversions: [{conversion_unit: 'BOT', base_unit: 'L', numerator: 1, denominator: 1.33333}]}];
  for (const [quantity, status] of [[9, 'verified'], [8.25, 'discrepancy']]) {
    const result = reconcilePurchaseWarehouses([doc], batches(evidence('SSR018', [0, quantity], 'L')), master);
    assert.equal(result.documents[0].products[0].warehouse_reconciliation.status, status);
    assert.equal(result.documents[0].products[0].warehouse, 2);
    assert.equal(result.documents[0].products[0].received_quantity, 12);
  }
});

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-purchase-authority-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('synchronization, exports, purchase views and ledger honor accounting, including future updates and API failures', async t => {
  const uploadsRoot = tempRoot(t), base = path.join(uploadsRoot, '.integrations/toteat-api'); fs.mkdirSync(base, {recursive: true});
  fs.writeFileSync(path.join(base, 'credentials.json'), JSON.stringify({'store-1': {restaurantId: 'r', localId: '1', userId: 'u', token: 'private'}}));
  let warehouse = 1, fail = false;
  const calls = [];
  const app = createApp({uploadsRoot, sourceMode: 'synchronized', toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-07',
    toteatPurchaseReceiptReader: async () => ({restaurantId: 'r', localId: '1', range: {from: '2026-09-04', to: '2026-09-07'},
      products: [{id: 'p', custom_id: 'CCB001'}], warehouses: [{id: 'central', custom_id: 1}, {id: 'local', custom_id: 2}],
      operations: {purchases: [{id: 322985, document: '22978', receive_date: '2026-09-04', warehouse_receive_ref: warehouse === 1 ? 'central' : 'local',
        purchase_detail: [{product_ref: 'p', quantity: 3.4, measure_unit: 'KG', warehouse_ref: 'central'}]}]}}),
    toteatApiFetch: async url => {
    const route = url.pathname.split('/').at(-1); calls.push(route);
    assert.equal(route, 'accountingmovements', 'purchases must not depend on inventorystate');
    if (fail) return Response.json({ok: false}, {status: 403});
    return Response.json({ok: true, data: {purchases: [document('322985', 'CCB001', 3.4, warehouse)]}});
  }});
  const sync = app.locals.toteatSalesSync.purchases;
  sync.configure('store-1', {from: '2026-09-04', intervalMinutes: 60, enabled: false});
  await sync.synchronize('store-1');
  sync.reconcileSaved('store-1', {restaurantId: 'r', localId: '1', batches: batches(evidence())});
  let state = sync.get('store-1');
  assert.equal(state.documents[0].products[0].warehouse, 1);
  assert.equal(state.warnings[0].type, 'warehouse-discrepancy');
  const workbook = XLSX.readFile(sync.source('store-1', 'purchases')[0].filePath);
  const row = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])[0];
  assert.equal(row['API Bodega Toteat'], 1); assert.equal(row['API Bodega reportada compras'], 1);
  assert.equal(row['API Conciliación bodega'], 'discrepancy');
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [location, expected] of [['store-1', 0], ['main-warehouse', 1]]) {
    const response = await fetch(`${origin}/api/purchases?location=${location}&dateFrom=2026-09-04&dateTo=2026-09-07`);
    const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(payload.rows.length, expected);
    const records = await fetch(`${origin}/api/uploads/records?location=${location}&field=purchases&from=2026-09-04&to=2026-09-07`).then(response => response.json());
    assert.equal(records.total, expected);
  }
  const products = [{id: 'p', custom_id: 'CCB001', stock_enabled: true, stock_unit: 'KG', name: {translations: {default: 'Frutilla'}}}];
  const source = {restaurantId: 'r', localId: '1', range: {from: '2026-09-04', to: '2026-09-07'}, products,
    warehouses: [{id: 'central', custom_id: 1}, {id: 'local', custom_id: 2}], operations: {counts: [], transfers: [], transformations: []}};
  const ledger = require('../toteat-stock').buildLedger(source, products, {from: source.range.from, through: source.range.to, payments: []}, state);
  assert.deepEqual(ledger.movements.map(line => [line.document, line.warehouse, line.quantity]), [['322985', 'central', 3.4]]);
  const version = state.version;
  fail = true; await assert.rejects(sync.synchronize('store-1'));
  assert.equal(sync.get('store-1').version, version);
  fail = false; await sync.synchronize('store-1');
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse, 1);
  assert.equal(sync.get('store-1').warnings[0].type, 'warehouse-discrepancy');
  warehouse = 2; await sync.synchronize('store-1'); state = sync.get('store-1');
  assert.equal(state.documents[0].products[0].warehouse, 2, 'only accounting can update the destination');
  assert.equal(state.warnings.filter(w => w.type === 'warehouse-discrepancy').length, 0);
  assert.ok(calls.every(route => route === 'accountingmovements'));
  assert.throws(() => sync.reconcileSaved('store-1', {restaurantId: 'other', localId: '1', batches: batches(evidence())}), /no corresponde/);
  assert.equal(sync.get('store-1').version, state.version);
});

test('old reassignments are restored from raw accounting on read, including historical windows and XLSX', t => {
  const uploadsRoot = tempRoot(t), folder = path.join(uploadsRoot, '.integrations/toteat-api/purchases/store-1');
  const raw = document(), altered = structuredClone(raw);
  altered.products[0].warehouse = 2;
  altered.products[0].warehouse_reconciliation = {reportedWarehouse: 1, status: 'corrected', source: 'inventorystate'};
  fs.mkdirSync(path.join(folder, 'old'), {recursive: true});
  const old = {version: 'old', syncedAt: '2026-10-05T00:00:00Z', from: '2026-05-18', through: '2026-10-05',
    documents: [altered], batches: {'2026-08-31': [raw]}, inventoryBatches: {'2026-08-31': batches(evidence())[0]},
    owned: ['adele|standardinvoice|22978'], lineCount: 1, warehouseReconciliationVersion: 1,
    warnings: [{type: 'warehouse-corrected', message: 'old reassignment'}]};
  const original = JSON.stringify(old);
  fs.writeFileSync(path.join(folder, 'old/state.json'), original);
  fs.writeFileSync(path.join(folder, 'current.json'), JSON.stringify({version: 'old'}));
  const options = {uploadsRoot, activeLocation: () => ({type: 'store'}), credentials: () => ({'store-1': {localId: '1', restaurantId: 'r'}})};
  const sync = createPurchaseSync(options), state = sync.get('store-1');
  assert.notEqual(state.version, 'old');
  assert.equal(state.warehouseAuthority, 'accountingmovements');
  assert.equal(state.documents[0].products[0].warehouse, 1);
  assert.equal(state.warnings.filter(w => w.type === 'warehouse-corrected').length, 0);
  assert.equal(state.warnings[0].type, 'warehouse-discrepancy');
  assert.equal(fs.readFileSync(path.join(folder, 'old/state.json'), 'utf8'), original);
  assert.deepEqual(state.batches, old.batches);
  assert.equal(state.syncedAt, old.syncedAt);
  const book = XLSX.readFile(sync.source('store-1', 'purchases')[0].filePath);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]])[0]['API Bodega Toteat'], 1);
  assert.equal(sync.get('store-1').version, state.version);
  assert.equal(createPurchaseSync(options).get('store-1').version, state.version);
});

test('invalid inventory evidence cannot block a valid receipt; invalid accounting preserves the last version', async t => {
  const uploadsRoot = tempRoot(t);
  let docs = [document()];
  const sync = createPurchaseSync({uploadsRoot, activeLocation: () => ({type: 'store'}), credentials: () => ({'store-1': {localId: '1', restaurantId: 'r'}}),
    clock: () => '2026-09-07', request: async (credential, route) => {
      assert.equal(route, 'accountingmovements'); return {ok: true, data: {purchases: docs}};
    }});
  sync.configure('store-1', {from: '2026-09-04', intervalMinutes: 60, enabled: false});
  await sync.synchronize('store-1');
  sync.reconcileSaved('store-1', {restaurantId: 'r', localId: '1', batches: batches(evidence(), evidence())});
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse, 1);
  assert.equal(sync.get('store-1').warnings[0].type, 'warehouse-unverified');
  await sync.synchronize('store-1');
  const version = sync.get('store-1').version;
  docs = [document()]; docs[0].products = [];
  await assert.rejects(sync.synchronize('store-1'), /detalle/);
  assert.equal(sync.get('store-1').version, version);
});

test('failed restoration leaves the old pointer and accounting snapshots untouched', t => {
  const uploadsRoot = tempRoot(t), folder = path.join(uploadsRoot, '.integrations/toteat-api/purchases/store-1');
  fs.mkdirSync(path.join(folder, 'old'), {recursive: true});
  const invalid = document(); invalid.products = [];
  const old = JSON.stringify({version: 'old', documents: [document()], batches: {'2026-08-31': [invalid]},
    owned: [], warehouseReconciliationVersion: 1});
  fs.writeFileSync(path.join(folder, 'old/state.json'), old);
  const pointer = JSON.stringify({version: 'old'});
  fs.writeFileSync(path.join(folder, 'current.json'), pointer);
  const sync = createPurchaseSync({uploadsRoot, activeLocation: () => ({type: 'store'}), credentials: () => ({'store-1': {localId: '1'}})});
  assert.throws(() => sync.get('store-1'), /detalle/);
  assert.equal(fs.readFileSync(path.join(folder, 'current.json'), 'utf8'), pointer);
  assert.equal(fs.readFileSync(path.join(folder, 'old/state.json'), 'utf8'), old);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['current.json', 'old']);
});
