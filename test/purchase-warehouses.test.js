const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const {reconcilePurchaseWarehouses} = require('../purchase-warehouses');
const {createApp} = require('../server');

const document = (id = '354057', sku = 'PAC003', quantity = 3600, warehouse = 2, received = '20260929') => ({
  movement_id: id, document_id: id === '354057' ? '360' : '871', document_type: 'DISPATCH_GUIDE', movement_class: 'PROVIDERS', local_id: 1,
  provider_id: '763646696', provider: 'CEFFRA', emission_date: '20260929', received_date: received, total_amount: quantity * 81,
  products: [{sku, product: sku, warehouse, invoice_quantity: quantity, received_quantity: quantity, invoice_measurement: 'UN', received_measurement: 'UN', unit_price: 81, total_price: quantity * 81}]
});
const evidence = (sku = 'PAC003', quantities = [3600, 0], date = '20260929', unit = 'UN') => ({sku, unit,
  warehouses: quantities.map((purchase, index) => ({warehouse_id: index + 1, inventory: [{date, purchase}]}))});
const batches = (...data) => [{from: '2026-09-29', to: '2026-09-30', capturedAt: '2026-10-06T00:00:00Z', data}];

test('354057 is received centrally while 356479 stays central; accounting responses and financial amounts remain intact', () => {
  const docs = [document(), document('356479', 'PAC002', 5100, 1, '20260930')], before = JSON.stringify(docs);
  const input = batches(evidence(), evidence('PAC002', [5100, 0], '20260930'));
  const result = reconcilePurchaseWarehouses(docs, input);
  assert.equal(JSON.stringify(docs), before);
  assert.deepEqual(result.documents.map(d => d.products[0].warehouse), [1, 1]);
  assert.deepEqual(result.documents.map(d => d.total_amount), docs.map(d => d.total_amount));
  assert.equal(result.documents[0].products[0].received_quantity, 3600);
  assert.equal(result.documents[0].products[0].warehouse_reconciliation.reportedWarehouse, 2);
  assert.equal(result.documents[1].products[0].warehouse_reconciliation.status, 'verified');
  assert.equal(result.corrections.length, 1);
  // Reconciliation is repeatable, including provenance and warning visibility.
  assert.deepEqual(reconcilePurchaseWarehouses(result.documents, input), result);
});

test('legitimate identical lines and multiple documents are all routed when one destination accounts for every unit', () => {
  const doc = document(); doc.products.push({...doc.products[0]});
  const result = reconcilePurchaseWarehouses([doc, document('other')], batches(evidence('PAC003', [10800, 0])));
  assert.equal(result.documents[0].products.length, 2);
  assert.equal(result.corrections.length, 3);
});

test('correct warehouse splits remain split; ambiguous splits and quantity discrepancies reject rather than guessing', () => {
  const docs = [document('a', 'PAC003', 100, 1), document('b', 'PAC003', 200, 2)];
  assert.equal(reconcilePurchaseWarehouses(docs, batches(evidence('PAC003', [100, 200]))).corrections.length, 0);
  for (const amounts of [[200, 100], [300, 1], [0, 0]]) {
    assert.throws(() => reconcilePurchaseWarehouses(docs, batches(evidence('PAC003', amounts))), /destino no es inequívoco/);
  }
});

test('negative receipts preserve their sign and offsetting positive/negative receipts cannot justify rerouting', () => {
  const result = reconcilePurchaseWarehouses([document('credit', 'PAC003', -10)], batches(evidence('PAC003', [-10, 0])));
  assert.equal(result.documents[0].products[0].warehouse, 1);
  assert.equal(result.documents[0].products[0].received_quantity, -10);
  assert.throws(() => reconcilePurchaseWarehouses([document('a', 'PAC003', 20), document('b', 'PAC003', -10)], batches(evidence('PAC003', [10, 0]))), /inequívoco/);
});

test('receipt dates and converted quantities are used; missing or incompatible evidence blocks routing', () => {
  const doc = document('weight', 'COFFEE', 3400, 2, '20260930'); doc.products[0].received_measurement = 'G';
  const result = reconcilePurchaseWarehouses([doc], batches(evidence('COFFEE', [3.4, 0], '20260930', 'KG')));
  assert.equal(result.documents[0].products[0].warehouse, 1);
  assert.equal(result.documents[0].products[0].received_quantity, 3400);
  assert.throws(() => reconcilePurchaseWarehouses([doc], batches()), /falta el registro/);
  doc.products[0].received_measurement = 'BAG';
  assert.throws(() => reconcilePurchaseWarehouses([doc], batches(evidence('COFFEE', [3.4, 0], '20260930', 'KG'))), /conversión comprobada/);
  const products = [{code: 'COFFEE', conversions: [{conversion_unit: 'BAG', base_unit: 'KG', numerator: .001, denominator: 1}]}];
  assert.equal(reconcilePurchaseWarehouses([doc], batches(evidence('COFFEE', [3.4, 0], '20260930', 'KG')), products).corrections.length, 1);
});

test('invalid or duplicate daily evidence fails; missing non-stock items remain financial lines', () => {
  assert.throws(() => reconcilePurchaseWarehouses([document()], batches(evidence(), evidence())), /duplicada/);
  assert.throws(() => reconcilePurchaseWarehouses([document()], batches(evidence('PAC003', [NaN, 0]))), /inválida/);
  const result = reconcilePurchaseWarehouses([document()], batches(), [{code: 'PAC003', stockManaged: false}]);
  assert.equal(result.documents[0].total_amount, 291600);
  assert.equal(result.warnings[0].type, 'warehouse-not-applicable');
});

test('approximate bottle conversion factors tolerate the final stock decimal but never a missing bottle or cup', () => {
  const doc = document('syrup', 'SSR018', 12); doc.products[0].received_measurement = 'BOT';
  const master = [{code: 'SSR018', conversions: [{conversion_unit: 'BOT', base_unit: 'L', numerator: 1, denominator: 1.33333}]}];
  const result = reconcilePurchaseWarehouses([doc], batches(evidence('SSR018', [9, 0], '20260929', 'L')), master);
  assert.equal(result.documents[0].products[0].warehouse, 1);
  assert.equal(result.documents[0].products[0].received_quantity, 12);
  assert.throws(() => reconcilePurchaseWarehouses([doc], batches(evidence('SSR018', [8.25, 0], '20260929', 'L')), master), /inequívoco/);
  assert.throws(() => reconcilePurchaseWarehouses([document()], batches(evidence('PAC003', [3599.9999, 0]))), /inequívoco/);
});

test('synchronization corrects purchases views, XLSX and the inventory ledger, refreshes raw receipts, and preserves the last version on failure', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-purchase-warehouses-'));
  t.after(() => fs.rmSync(uploadsRoot, {recursive: true, force: true}));
  const base = path.join(uploadsRoot, '.integrations/toteat-api'); fs.mkdirSync(base, {recursive: true});
  fs.writeFileSync(path.join(base, 'credentials.json'), JSON.stringify({'store-1': {restaurantId: 'r', localId: '1', userId: 'u', token: 'private'}}));
  let amount = 3600, fail = false, local = false;
  const calls = [];
  const app = createApp({uploadsRoot, sourceMode: 'synchronized', toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-30', toteatApiFetch: async url => {
    const route = url.pathname.split('/').at(-1); calls.push(route);
    if (route === 'accountingmovements') return Response.json({ok: true, data: {purchases: [document(), document('356479', 'PAC002', 5100, 1, '20260930')]}});
    assert.equal(route, 'inventorystate');
    if (fail) return Response.json({ok: false}, {status: 403});
    return Response.json({ok: true, data: [evidence('PAC003', local ? [0, amount] : [amount, 0]), evidence('PAC002', [5100, 0], '20260930')]});
  }});
  const sync = app.locals.toteatSalesSync.purchases;
  sync.configure('store-1', {from: '2026-09-29', intervalMinutes: 60, enabled: false});
  await sync.synchronize('store-1');
  let state = sync.get('store-1');
  assert.equal(state.documents[0].products[0].warehouse, 1);
  assert.equal(Object.values(state.batches)[0][0].products[0].warehouse, 2);
  const workbook = XLSX.readFile(sync.source('store-1', 'purchases')[0].filePath);
  const row = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])[0];
  assert.equal(row['API Bodega Toteat'], 1); assert.equal(row['API Bodega reportada compras'], 2);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [location, expected] of [['store-1', 0], ['main-warehouse', 2]]) {
    const response = await fetch(`${origin}/api/purchases?location=${location}&dateFrom=2026-09-29&dateTo=2026-09-30`);
    const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(payload.rows.length, expected);
    const records = await fetch(`${origin}/api/uploads/records?location=${location}&field=purchases&from=2026-09-29&to=2026-09-30`).then(response => response.json());
    assert.equal(records.total, expected);
  }
  const products = [{id: 'p', custom_id: 'PAC003', stock_enabled: true, stock_unit: 'UN', name: {translations: {default: 'Vaso'}}},
    {id: 'q', custom_id: 'PAC002', stock_enabled: true, stock_unit: 'UN', name: {translations: {default: 'Vaso 8'}}}];
  const source = {restaurantId: 'r', localId: '1', range: {from: '2026-09-29', to: '2026-09-30'}, products, warehouses: [{id: 'central', custom_id: 1}, {id: 'local', custom_id: 2}], operations: {counts: [], transfers: [], transformations: []}};
  const ledger = require('../toteat-stock').buildLedger(source, products, {from: source.range.from, through: source.range.to, payments: []}, state);
  assert.deepEqual(ledger.movements.filter(line => line.source === 'purchases').map(line => [line.document, line.warehouse, line.quantity]), [['354057', 'central', 3600], ['356479', 'central', 5100]]);
  const version = state.version;
  amount = 3599; await assert.rejects(sync.synchronize('store-1'), /conciliar la bodega/);
  assert.equal(sync.get('store-1').version, version);
  amount = 3600; fail = true; await assert.rejects(sync.synchronize('store-1'));
  assert.equal(sync.get('store-1').version, version);
  fail = false; await sync.synchronize('store-1'); state = sync.get('store-1');
  assert.equal(state.documents[0].products[0].warehouse, 1);
  assert.equal(state.warnings.filter(warning => warning.type === 'warehouse-corrected').length, 1);
  assert.equal(calls.filter(route => route === 'inventorystate').length, 4);
  local = true; await sync.synchronize('store-1');
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse, 2, 'a changed receipt must replace the earlier reconciliation');
  assert.equal(sync.get('store-1').warnings.filter(warning => warning.type === 'warehouse-corrected').length, 0);
  const snapshot = sync.get('store-1').version;
  assert.throws(() => sync.reconcileSaved('store-1', {restaurantId: 'other', localId: '1', batches: batches(evidence())}), /no corresponde/);
  assert.equal(sync.get('store-1').version, snapshot);
  sync.reconcileSaved('store-1', {restaurantId: 'r', localId: '1', batches: batches(evidence(), evidence('PAC002', [5100, 0], '20260930'))});
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse, 1);
});

test('unchanged older windows reuse evidence, while full synchronization revalidates the receipt', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-purchase-warehouse-cache-'));
  t.after(() => fs.rmSync(uploadsRoot, {recursive: true, force: true}));
  const doc = {...document('old', 'PAC003', 100, 2, '20260525'), emission_date: '20260525'};
  let inventoryCalls = 0;
  const sync = require('../toteat-purchases').createPurchaseSync({uploadsRoot, activeLocation: () => ({type: 'store'}),
    credentials: () => ({'store-1': {localId: '1', restaurantId: 'r'}}), clock: () => '2026-10-05', request: async (credential, route, params) => {
      if (route === 'accountingmovements') return {ok: true, data: {purchases: params.initial_date <= '20260525' && params.final_date >= '20260525' ? [doc] : []}};
      assert.equal(route, 'inventorystate'); inventoryCalls++;
      assert(Date.parse(params.final_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) - Date.parse(params.initial_date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) <= 7 * 86400000);
      return {ok: true, data: [evidence('PAC003', [100, 0], '20260525')]};
    }});
  sync.configure('store-1', {from: '2026-05-18', intervalMinutes: 60, enabled: false});
  await sync.synchronize('store-1'); assert.equal(inventoryCalls, 1);
  await sync.synchronize('store-1'); assert.equal(inventoryCalls, 1);
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse, 1);
  await sync.synchronize('store-1', {full: true}); assert.equal(inventoryCalls, 2);
});
