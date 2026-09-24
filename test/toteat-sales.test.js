const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { salesRows, createSalesSync, localTimestamp, windows } = require('../toteat-sales');
const { createApp } = require('../server');
const line = (overrides = {}) => ({ id: 'B1', lineId: 'l1', lineReference: 0, quantity: 1, payed: 3430, discounts: -1470, taxes: 548, totalCost: 1200, netPrice: 4900, name: 'Café', hierarchyId: 'AB.01', ...overrides });
const payment = (overrides = {}) => ({ orderId: 'o1', paymentId: 'p1', dateOpen: '2026-09-21T12:00:00', dateClosed: '2026-09-21T12:03:00', total: 3430, discounts: -1470, taxes: 548, gratuity: 343, payed: 5000, change: 1227, fiscalId: 101, fiscalType: 'BE', comment: 'servir', products: [line()], paymentForms: [{ id: 1000, name: 'CASH', amount: 5000, tip: 343 }], ...overrides });

test('adapter preserves final sales, discounts, change, line identity and Chilean time', () => {
  const { sales, details } = salesRows([payment()]);
  assert.equal(sales[0]['Pago total'] + sales[0].Descuentos, 3430);
  assert.equal(sales[0]['Precio a Pagar'], 3430);
  assert.equal(sales[0]['Precio Base'], 4900);
  assert.equal(sales[0]['Total a pagar'], 4900);
  assert.equal(sales[0]['Total con propina'], 5243);
  assert.equal(sales[0]['Hora de creacion'], '09:00:00');
  assert.equal(details[0]['A Pagar'], 3430);
  assert.equal(details[0]['Medio 1000 · CASH'], 3773);
  assert.equal(details[0]['API Moneda'], 'CLP');
  assert.equal(details[0]['Comentario General'], 'servir');
  assert.equal(localTimestamp('2026-06-01T03:30:00Z').date, '2026-05-31');
});

test('repeated extras stay distinct and references preserve parent adjacency', () => {
  const p = payment({ total: 200, discounts: 0, products: [
    line({ id: 'BX1', lineId: 'x2', lineReference: 'b2', payed: 50, discounts: 0 }),
    line({ id: 'B2', lineId: 'b2', payed: 50, discounts: 0 }),
    line({ id: 'BX1', lineId: 'x1', lineReference: 'b1', payed: 50, discounts: 0 }),
    line({ id: 'B1', lineId: 'b1', payed: 50, discounts: 0 })
  ] });
  const r = salesRows([p]);
  assert.deepEqual(r.sales.map(x => x['API Line ID']), ['b2', 'x2', 'b1', 'x1']);
  assert.equal(new Set(r.sales.map(x => JSON.stringify(x))).size, 4);
});

test('credit notes reverse positive source lines exactly once without mutating API data', () => {
  const original = payment({ discounts: 0, total: 3430, products: [line({ discounts: 0 })] });
  const note = payment({ fiscalType: 'NC', paymentId: 'nc1', total: -3430, discounts: 0, taxes: -548, products: [line({ discounts: 0 })] });
  const rows = salesRows([original, note]);
  assert.equal(rows.sales[0]['Pago total'], 0);
  assert.equal(rows.sales.reduce((sum, r) => sum + r['Precio a Pagar'], 0), 0);
  assert.equal(rows.sales.reduce((sum, r) => sum + r.Cantidad, 0), 0);
  assert.equal(note.products[0].payed, 3430);
});

test('separate payments sum once per order and ambiguous shared lines are blocked', () => {
  const a = payment();
  const b = payment({ paymentId: 'p2', products: [line({ lineId: 'l2' })] });
  const rows = salesRows([a, b]);
  assert.equal(rows.orders, 1);
  assert.equal(rows.sales.filter(r => r['Pago total'] !== null).length, 1);
  assert.equal(rows.details[0]['API Total Orden'], 6860);
  assert.equal(rows.details[1]['A Pagar'], 3430);
  assert.throws(() => salesRows([a, payment({ paymentId: 'p2' })]), /línea se repite/);
  const missing = salesRows([payment({ products: [] })]);
  assert.equal(missing.sales[0]['Pago total'] + missing.sales[0].Descuentos, 3430);
  assert.equal(missing.sales[0]['ID Producto'], '');
  assert.equal(missing.sales[0].Cantidad, null);
  assert.equal(missing.details[0]['A Pagar'], 3430);
  assert.equal(missing.warnings.length, 1);
  assert.throws(() => salesRows([payment({ total: 9999 })]), /no concilia/);
});

function service(t, request) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  const options = { uploadsRoot, activeLocation: id => ['store-1', 'store-2'].includes(id) ? { id, type: 'store' } : null,
    credentials: () => ({ 'store-1': { localId: '1' }, 'store-2': { localId: '2' } }),
    request, clock: () => '2026-09-21' };
  const sync = createSalesSync(options);
  for (const id of ['store-1', 'store-2']) sync.configure(id, { from: '2026-09-14', enabled: true, intervalMinutes: 5 });
  return { sync, uploadsRoot, options };
}
test('synchronization publishes both files atomically, is idempotent, and preserves legacy history', async t => {
  let data = [payment()], fail = false;
  const { sync, uploadsRoot, options } = service(t, async (c, route) => {
    if (fail) throw new Error('Sin autorización');
    return { ok: true, data: route === 'shiftstatus' ? { status: 'closed', localNumber: c.localId } : data };
  });
  await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').paymentCount, 1);
  const legacyPath = path.join(uploadsRoot, 'transactions/store-1/old.xlsx');
  assert.deepEqual(sync.filterLegacy(legacyPath, [{ 'ID de orden': 'o1' }, { 'ID de orden': 'historic' }]), [{ 'ID de orden': 'historic' }]);
  for (const field of ['sales', 'payment-details']) {
    const file = sync.source('store-1', field)[0].filePath;
    assert.equal(XLSX.readFile(file).SheetNames.length, 1);
  }
  await sync.synchronize('store-1'); assert.equal(sync.status('store-1').paymentCount, 1);
  const version = sync.get('store-1').version;
  fail = true; await assert.rejects(sync.synchronize('store-1'));
  assert.equal(sync.get('store-1').version, version);
  fail = false; data = []; await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').state, 'connected-empty');
  assert.equal(sync.filterLegacy(legacyPath, [{ 'ID de orden': 'o1' }]).length, 0, 'cancelled payment must not reappear from a legacy file');
  const restarted = createSalesSync(options); assert.equal(restarted.status('store-1').state, 'connected-empty');
  await sync.synchronize('store-2'); assert.equal(sync.status('store-2').state, 'connected-empty');
});

test('warning timestamps are recovered from historical payments in Chilean time', async t => {
  const { sync, options } = service(t, async (c, route) => ({ ok: true, data: route === 'shiftstatus'
    ? { status: 'closed', localNumber: c.localId }
    : [payment({ products: [], dateClosed: '2026-06-01T03:30:00Z' }), payment({ paymentId: 'p2', products: [], dateClosed: '2026-09-21T12:03:00' })] }));
  await sync.synchronize('store-1');
  assert.equal(sync.get('store-1').warnings[0].closedAt, undefined);
  const restarted = createSalesSync(options);
  assert.deepEqual(restarted.status('store-1').detailWarnings.map(w => w.closedAt), [
    { date: '2026-05-31', time: '23:30:00' }, { date: '2026-09-21', time: '09:03:00' }
  ]);
});

test('refresh includes an old open shift and windows stay at most 15 days', async t => {
  const queries = [];
  const { options } = service(t, async (c, route, params) => {
    if (route === 'shiftstatus') return { ok: true, data: { status: 'open', date: '2026-05-19T12:00:00Z', localNumber: c.localId } };
    queries.push(params); return { ok: true, data: [] };
  });
  const sync = createSalesSync(options); sync.configure('store-1', { from: '2026-05-18', enabled: true, intervalMinutes: 5 });
  await sync.synchronize('store-1'); queries.length = 0;
  await sync.synchronize('store-1');
  assert(queries.some(q => q.ini === '20260518'));
  assert(queries.length >= 3);
  queries.length = 0;
  await sync.synchronize('store-1', { full: true });
  assert.equal(queries.length, windows('2026-05-18', '2026-09-21').length);
  for (const w of windows('2026-05-18', '2026-09-21')) assert.equal((Date.parse(w.to)-Date.parse(w.from))/86400000, 14);
});

test('all report readers use API data without double counting an old upload', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-sync-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(uploadsRoot, '.integrations/toteat-api'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '.integrations/toteat-api/credentials.json'), JSON.stringify({ 'store-1': { localId: '1', restaurantId: 'r', userId: 'u', token: 'secret' } }));
  const app = createApp({ enableLegacyTools: true, uploadsRoot, toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-21', toteatApiFetch: async url => Response.json({ ok: true, data: url.pathname.endsWith('shiftstatus') ? { status: 'closed', localNumber: 1 } : [payment()] }) });
  const dir = path.join(uploadsRoot, 'transactions/store-1'); fs.mkdirSync(dir, { recursive: true });
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 'ID de orden': 'o1', 'Fecha de creacion': '2026-09-21', 'Pago total': 99999, 'ID Producto': 'B1', Cantidad: 1, 'Precio a Pagar': 99999 }]), 'Ventas');
  XLSX.writeFile(workbook, path.join(dir, 'old.xlsx'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ fields: { sales: { files: [{ id: 'old', name: 'old.xlsx' }] } } }));
  app.locals.toteatSalesSync.configure('store-1', { from: '2026-09-14', enabled: false, intervalMinutes: 5 });
  await app.locals.toteatSalesSync.synchronize('store-1');
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transactions = await (await fetch(`${base}/api/transactions?location=store-1`)).json();
  assert.equal(transactions.files.sales.latest.origin, 'toteat-api');
  assert.equal(transactions.files['payment-details'].latest.origin, 'toteat-api');
  const report = await (await fetch(`${base}/api/reports/weekly-sales?location=store-1&includeToday=true`)).json();
  assert.equal(report.warnings.length, 0);
  assert(!JSON.stringify(report).includes('99999'));
  assert.equal((await fetch(base + transactions.files.sales.latest.previewUrl)).status, 200);
});

test('warning resolutions persist across synchronization and restart and stay scoped to the store', async t => {
  const { sync, options } = service(t, async (c, route) => ({ ok: true, data: route === 'shiftstatus'
    ? { status: 'closed', localNumber: c.localId } : [payment({ products: [] })] }));
  await sync.synchronize('store-1'); await sync.synchronize('store-2');
  assert.throws(() => sync.resolveWarning('store-1', 'missing', true), /No se encontró/);
  assert.throws(() => sync.resolveWarning('store-1', 'p1', 'true'), /inválido/);
  sync.resolveWarning('store-1', 'p1', true);
  await sync.synchronize('store-1');
  const restarted = createSalesSync(options);
  assert.equal(restarted.status('store-1').detailWarnings[0].resolved, true);
  assert.equal(restarted.status('store-2').detailWarnings[0].resolved, false);
  assert.equal(restarted.status('store-1').detailWarnings[0].total, 3430);
  restarted.resolveWarning('store-1', 'p1', false);
  assert.equal(sync.status('store-1').detailWarnings[0].resolved, false);
});
