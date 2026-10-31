const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/recurrence-fixture');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');

const orders = [
  { orderKey: 'coffee', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T10:00:00', paymentPaid: 20, netSales: null,
    lines: [{ code: 'P1', name: 'Café', quantity: 2, productNetSales: 1000, netSales: 0, categoryPath: ['Barra Cafe', 'Calientes'] }] },
  { orderKey: 'retail', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T13:00:00', paymentPaid: 100, netSales: null,
    lines: [{ code: 'P2', name: 'Sandwich', quantity: 1, productNetSales: 2000, netSales: 0, categoryPath: ['Retail', 'Sandwiches'] }] }
];
test('product recurrence API loads options separately and reports total product sales even without verified order accounting', async t => {
  const s = await setup(t, false, orders);
  const options = await fetch(`${s.base}/api/sales/product-recurrence/options?location=store-1`).then(r => r.json());
  assert.equal(options.products.length, 2); assert.equal(options.hierarchies.length, 4); assert.equal(s.reads(), 1);
  const query = new URLSearchParams({ location: 'store-1', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', groupBy: 'product', products: '["P1"]' });
  const response = await fetch(`${s.base}/api/sales/product-recurrence?${query}`); assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.rows.length, 1); assert.equal(report.totals.netSales, 1000); assert.equal(report.totals.units, 2);
  assert.equal(report.totals.windows[15].netSales, 1000); assert.equal(report.totals.windows[15].percent, 100);
  assert.equal(report.identityDefinitionVersion, 'recurrence-dates-v2'); assert.equal(s.reads(), 2);
  assert.ok(!JSON.stringify(report).includes('123456'));
  query.delete('products'); const all = await fetch(`${s.base}/api/sales/product-recurrence?${query}`).then(r => r.json());
  assert.equal(all.totals.netSales, 3000); assert.equal(all.totals.windows[15].percent, 33.33); assert.equal(all.totals.unclassified.percent, 66.67);
  query.set('products', 'invalid'); assert.equal((await fetch(`${s.base}/api/sales/product-recurrence?${query}`)).status, 400);
  query.delete('products'); query.set('dateFrom', '2026-11-12'); assert.equal((await fetch(`${s.base}/api/sales/product-recurrence?${query}`)).status, 400);
});
test('the existing worker serves product options and generation without requiring a customer report first', async t => {
  const s = await setup(t, true);
  const options = await fetch(`${s.base}/api/sales/product-recurrence/options?location=store-1`).then(r => r.json());
  assert.deepEqual(options.products, []);
  const response = await fetch(`${s.base}/api/sales/product-recurrence?location=store-1&period=custom&dateFrom=2026-10-01&dateTo=2026-10-07`);
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.definitionVersion, 'product-recurrence-exclusive-v1'); assert.equal(data.totals.netSales, 0); assert.equal(data.status, 'no_data');
});
test('stored Toteat sales retain product net amounts and link through payment details in the production reader and worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-product-recurrence-source-'));
  const directory = path.join(root, 'transactions', 'store-1'); fs.mkdirSync(directory, { recursive: true });
  const save = (name, rows) => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Datos'); XLSX.writeFile(book, path.join(directory, name)); };
  save('sales.xlsx', [{ 'ID de orden': 'sale', 'Fecha de creacion': '2026-10-03', 'Hora de creacion': '10:00:00', 'Pago total': 2380, Descuentos: 0,
    'ID Producto': 'P1', Nombre: 'Café', Cantidad: 2, 'Precio a Pagar': 2380, 'Categorías de Productos/Platos': 'Bebidas' }]);
  save('details.xlsx', [{ Comanda: 'sale', FechaCierre: '2026-10-03', Total: 2380, Pagos: 2380, 'A Pagar': 2380 }]);
  save('mp.xlsx', ['2026-09-20', '2026-10-03'].map((date, index) => ({ SOURCE_ID: String(index), TRANSACTION_DATE: `${date}T10:00:00`,
    TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: index ? 2380 : 1, CARD_INITIAL_NUMBER: '123456', LAST_FOUR_DIGITS: '1111', STATUS: 'approved', REFUNDED_AMOUNT: 0 })));
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ fields: {
    sales: { files: [{ id: 's', name: 'sales.xlsx' }] }, 'payment-details': { files: [{ id: 'd', name: 'details.xlsx' }] }, mercadopago: { files: [{ id: 'm', name: 'mp.xlsx' }] }
  } }));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', reportToday: '2026-10-31', enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = await fetch(`${base}/api/sales/product-recurrence/options?location=store-1`).then(r => r.json());
  assert.deepEqual(options.products, [{ code: 'P1', name: 'Café' }]);
  const response = await fetch(`${base}/api/sales/product-recurrence?location=store-1&period=custom&dateFrom=2026-10-01&dateTo=2026-10-07`);
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.totals.netSales, 2000); assert.equal(data.totals.units, 2); assert.equal(data.totals.windows[15].percent, 100);
  assert.equal(data.rows[0].label, 'Bebidas'); assert.equal(data.linkage.linkedHigh, 1); assert.equal(data.status, 'partial');
});
