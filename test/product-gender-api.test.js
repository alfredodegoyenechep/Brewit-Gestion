const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');
const { setup } = require('./helpers/recurrence-fixture');
const { genderOrders } = require('./helpers/product-gender-fixture');
test('gender API provides independent filters, grouped options, totals and hierarchy detail using explicit information', async t => {
  const s = await setup(t, false, genderOrders);
  const options = await fetch(`${s.base}/api/sales/product-gender/options?location=store-1`).then(r => r.json());
  assert.equal(options.products.length, 3); assert.equal(options.groupedProducts.length, 2);
  const query = new URLSearchParams({ location: 'store-1', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', groupFormats: 'true' });
  const response = await fetch(`${s.base}/api/sales/product-gender?${query}`); assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.totals.netSales, 6000); assert.equal(data.totals.units, 5);
  assert.deepEqual(Object.values(data.totals.genders).map(g => g.netSales), [3000, 1000, 2000]);
  assert.equal(data.hierarchyTree.children.find(row => row.label === 'Barra Cafe').children[0].products.length, 1);
  assert.ok(!JSON.stringify(data).includes('María')); assert.ok(!Object.hasOwn(data, 'identityAsOf'));
  query.set('groupBy', 'product'); query.set('products', '["C0","C1"]');
  const selected = await fetch(`${s.base}/api/sales/product-gender?${query}`).then(r => r.json());
  assert.equal(selected.rows.length, 1); assert.equal(selected.totals.netSales, 4000); assert.equal(selected.rows[0].genders.masculine.percent, 75);
  query.set('products', 'invalid'); assert.equal((await fetch(`${s.base}/api/sales/product-gender?${query}`)).status, 400);
});
test('the production reader and worker handle declared fields, conflicting data and missing information without MP', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-product-gender-'));
  const directory = path.join(root, 'transactions', 'store-1'); fs.mkdirSync(directory, { recursive: true });
  const save = (name, rows) => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Datos'); XLSX.writeFile(book, path.join(directory, name)); };
  save('sales.xlsx', [
    ['m', 2380, 2, 'Masculino'], ['f', 1190, 1, null], ['conflict', 595, 1, 'Masculino'], ['name-only', 357, 1, null]
  ].map(([id, amount, units, gender]) => ({ 'ID de orden': id, 'Fecha de creacion': '2026-10-03', 'Hora de creacion': '10:00:00', 'Pago total': id === 'f' ? 1428 : amount, Descuentos: 0,
    'ID Producto': id.toUpperCase(), Nombre: id, Cantidad: units, 'Precio a Pagar': amount, 'Género declarado': gender, 'Categorías de Productos/Platos': 'Bebidas' })).concat([
    { 'ID de orden': 'f', 'Fecha de creacion': '2026-10-03', 'Hora de creacion': '10:00:00', 'Pago total': 1428, Descuentos: 0,
      'ID Producto': 'EX', Nombre: 'Leche de avena', Cantidad: 1, 'Precio a Pagar': 238, 'BA.': 'BA.001' }
  ]));
  save('details.xlsx', [
    { Comanda: 'm', FechaCierre: '2026-10-03', Total: 2380 },
    { Comanda: 'f', FechaCierre: '2026-10-03', Total: 1428, 'Género': 'Femenino' },
    { Comanda: 'conflict', FechaCierre: '2026-10-03', Total: 595, 'Género': 'Femenino' },
    { Comanda: 'name-only', FechaCierre: '2026-10-03', Total: 357, 'Comentario General': 'María' }
  ]);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ fields: {
    sales: { files: [{ id: 's', name: 'sales.xlsx' }] }, 'payment-details': { files: [{ id: 'p', name: 'details.xlsx' }] }
  } }));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', reportToday: '2026-10-31', enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sales/product-gender?location=store-1&period=custom&dateFrom=2026-10-01&dateTo=2026-10-07&groupBy=product`);
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.totals.netSales, 4000); assert.equal(data.totals.units, 5); assert.equal(data.totals.extraUnits, 1);
  assert.deepEqual(Object.values(data.totals.genders).map(g => g.netSales), [2000, 1200, 800]);
  assert.equal(data.rows.find(r => r.label.startsWith('Leche de avena')).genders.feminine.netSales, 200);
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = await fetch(`${base}/api/sales/product-gender/options?location=store-1`).then(r => r.json());
  assert.ok(options.products.some(p => p.code === 'EX')); assert.ok(options.hierarchies.some(h => h.label === 'Extras y adicionales'));
  const recurrenceOptions = await fetch(`${base}/api/sales/product-recurrence/options?location=store-1`).then(r => r.json());
  assert.ok(!recurrenceOptions.products.some(p => p.code === 'EX'));
  const dashboard = await fetch(`${base}/api/sales/dashboard?location=store-1`).then(r => r.json());
  assert.equal(dashboard.sales.metrics.month.netSales, data.totals.netSales);
  assert.equal(data.rows.find(row => row.label.startsWith('conflict')).genders.unknown.percent, 100);
  assert.equal(data.rows.find(row => row.label.startsWith('name-only')).genders.unknown.percent, 100);
  assert.ok(!JSON.stringify(data).includes('María'));
});
