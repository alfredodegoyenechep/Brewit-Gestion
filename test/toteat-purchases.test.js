const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { purchaseRows, createPurchaseSync, legacyKey, documentKey } = require('../toteat-purchases');
const { createApp } = require('../server');
const purchase = (overrides = {}) => ({ movement_id: 'm1', movement_class: 'PROVIDERS', local_id: 1, provider: 'Proveedor', provider_id: '761111523', document_id: '0012', document_type: 'STANDARD_INVOICE', emission_date: '20260907', total_amount: 1001,
  products: [{ sku: 'SAN01', product_id: 99, product: 'Queso', invoice_quantity: 3, received_quantity: 2, invoice_measurement: 'KG', received_measurement: 'KG', unit_price: 333, total_price: 1001, warehouse: 2 }], ...overrides });

test('purchases preserve SKU, independent quantities, line total and rounding without inventing fields', () => {
  const p = purchase(), r = purchaseRows([p], '1');
  assert.equal(r.rows[0].Cod, 'SAN01'); assert.equal(r.rows[0]['Monto total'], 1001);
  assert.equal(r.rows[0]['Q.Fac'], 3); assert.equal(r.rows[0]['Q.Rec'], 2);
  assert.equal(r.rows[0]['Monto neto'], null); assert.equal(r.rows[0]['Costo negociado'], null);
  assert.equal(r.rows[0]['API Costo efectivo unitario'], 1001 / 3);
  assert.equal(r.rows[0].Documento, '0012');
  const note = purchase({ movement_id: 'nc1', document_type: 'CREDIT_NOTE', total_amount: -1001, products: [{ ...p.products[0], invoice_quantity: -3, received_quantity: -3, total_price: -1001 }] });
  assert.equal(purchaseRows([p, note], '1').rows.reduce((s, r) => s + r['Monto total'], 0), 0);
  assert.equal(purchaseRows([purchase({ total_amount: 1000 })], '1').warnings[0].difference, 1);
  assert.throws(() => purchaseRows([p], '2'), /otro local/);
  assert.throws(() => purchaseRows([purchase({ products: [] })], '1'), /detalle/);
  const missing = purchaseRows([purchase({ products: [{ ...p.products[0], sku: null, product: null }] })], '1');
  assert.equal(missing.rows[0]['Monto total'], 1001); assert.equal(missing.rows[0].Cod, '');
  assert.equal(missing.warnings[0].type, 'missing-product');
  assert.equal(legacyKey({ 'Tax ID number': '76.111.152-3', 'Document Type': 'Normal Invoice', Document: '00012' }), documentKey('761111523', 'STANDARD_INVOICE', '12'));
  for (const [label, type] of [['Sin Documento', 'WITHOUT_DOCUMENT'], ['Factura Exenta', 'EXEMPT_INVOICE']])
    assert.equal(legacyKey({ RUT: '761111523', 'Tipo Documento': label, Documento: '0012' }), documentKey('761111523', type, '12'));
});

test('purchase snapshots replace documents and preserve the last valid version on failure', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-purchases-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  let documents = [purchase(), { movement_id: 'cash1', movement_class: 'CASH_FLOW', total_amount: 4800 }], fail = false;
  const options = { uploadsRoot, activeLocation: id => ({ id, type: 'store' }), credentials: () => ({ 'store-1': { localId: '1' }, 'store-2': { localId: '2' } }), clock: () => '2026-09-21', request: async (c, route, params) => {
    assert.equal(route, 'accountingmovements'); assert.equal(params.include_sales, 'false');
    if (fail) throw new Error('No autorizado');
    return { ok: true, data: { purchases: c.localId === '2' ? [] : documents } };
  } };
  const s = createPurchaseSync(options);
  for (const id of ['store-1', 'store-2']) s.configure(id, { from: '2026-09-07', intervalMinutes: 15, enabled: false });
  await s.synchronize('store-1'); const version = s.get('store-1').version;
  assert.equal(s.status('store-1').excludedCashMovements, 1);
  assert.equal(s.get('store-1').documents.length, 1);
  fail = true; await assert.rejects(s.synchronize('store-1')); assert.equal(s.get('store-1').version, version);
  fail = false; await s.synchronize('store-1'); assert.equal(s.status('store-1').documentCount, 1);
  const legacy = { 'Número identificador fiscal': '761111523', 'Tipo Documento': 'Factura Normal', Documento: '12' };
  const file = path.join(uploadsRoot, 'transactions/store-1/old.xls');
  assert.equal(s.filterLegacy(file, [legacy]).length, 0);
  documents = []; await s.synchronize('store-1');
  assert.equal(s.filterLegacy(file, [legacy]).length, 0, 'removed documents do not reappear from old files');
  assert.equal(new createPurchaseSync(options).status('store-1').state, 'connected-empty');
  await s.synchronize('store-2'); assert.equal(s.status('store-2').state, 'connected-empty');
});

test('purchase reports use the API source once and expose a preview and protected export', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-purchase-api-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(uploadsRoot, '.integrations/toteat-api'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '.integrations/toteat-api/credentials.json'), JSON.stringify({ 'store-1': { localId: '1', restaurantId: 'r', userId: 'u', token: 'secret' } }));
  const app = createApp({ uploadsRoot, toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-21', toteatApiFetch: async () => Response.json({ ok: true, data: { purchases: [purchase()] } }) });
  const dir = path.join(uploadsRoot, 'transactions/store-1'); fs.mkdirSync(dir, { recursive: true });
  const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.json_to_sheet([{ 'Fecha emisión': '2026-09-07', 'Número identificador fiscal': '761111523', 'Tipo Documento': 'Factura Normal', Documento: '12', Cod: 'SAN01', Lin: 1, 'Q.Fac': 3, 'Monto total': 99999 }]), 'Compras'); XLSX.writeFile(w, path.join(dir, 'old.xlsx'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ fields: { purchases: { files: [{ id: 'old', name: 'old.xlsx' }] } } }));
  const s = app.locals.toteatSalesSync.purchases; s.configure('store-1', { from: '2026-09-07', intervalMinutes: 15, enabled: false }); await s.synchronize('store-1');
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = await (await fetch(base + '/api/transactions?location=store-1')).json();
  assert.equal(files.files.purchases.latest.origin, 'toteat-api');
  assert.equal((await fetch(base + files.files.purchases.latest.previewUrl)).status, 200);
  assert.equal((await fetch(base + files.files.purchases.latest.url)).status, 200);
  const r = await (await fetch(base + '/api/purchases?location=store-1&dateFrom=2026-09-07&dateTo=2026-09-21')).json();
  assert(!r.error, JSON.stringify(r)); assert(!JSON.stringify(r).includes('99999'));
  assert.equal(r.summary.totalAmount, 1001); assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].discount, null); assert.equal(r.rows[0].netAmount, null);
  assert.equal((await fetch(base + '/api/transactions/store-1/purchases?source=toteat-api:store-1:purchases', { method: 'DELETE' })).status, 409);
});
