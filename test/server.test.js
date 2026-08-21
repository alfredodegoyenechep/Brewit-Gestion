const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');

async function startTestServer(t, options = {}) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-test-'));
  options.beforeCreate?.(uploadsRoot);
  const { beforeCreate, ...appOptions } = options;
  const server = createApp({ uploadsRoot, ...appOptions }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function fileForm(entries, extra = {}) {
  const form = new FormData();
  for (const entry of entries) {
    form.append(entry.field, new Blob([entry.contents]), entry.filename);
  }
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

async function inspect(baseUrl, location, week, entries) {
  return fetch(`${baseUrl}/api/uploads/weekly/inspect?location=${location}&week=${week}`, {
    method: 'POST',
    body: fileForm(entries)
  });
}

async function confirm(baseUrl, manifest, range = manifest.detectedRange, confirmed = true) {
  return fetch(`${baseUrl}/api/uploads/weekly/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: manifest.token, dateFrom: range?.from, dateTo: range?.to, confirmed })
  });
}

async function inspectTransactions(baseUrl, location, entries) {
  return fetch(`${baseUrl}/api/uploads/transactions/inspect?location=${location}`, {
    method: 'POST',
    body: fileForm(entries)
  });
}

async function confirmTransactions(baseUrl, manifest, overlapAction = 'keep', range = manifest.detectedRange) {
  return fetch(`${baseUrl}/api/uploads/transactions/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: manifest.token, dateFrom: range.from, dateTo: range.to, confirmed: true, overlapAction })
  });
}

test('serves the app and exposes the three upload locations', async t => {
  const baseUrl = await startTestServer(t);
  const page = await fetch(`${baseUrl}/`);
  const excelLibrary = await fetch(`${baseUrl}/vendor/xlsx.full.min.js`);
  const locations = await fetch(`${baseUrl}/api/locations`).then(response => response.json());

  assert.equal(page.status, 200);
  assert.equal(excelLibrary.status, 200);
  assert.match(excelLibrary.headers.get('content-type'), /javascript/);
  assert.ok((await excelLibrary.arrayBuffer()).byteLength > 0);
  assert.match(await page.text(), /Cargar Archivos/);
  assert.deepEqual(Object.keys(locations), ['store-1', 'store-2', 'main-warehouse']);
  assert.deepEqual(locations['store-1'].fields, ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales', 'mercadopago']);
  assert.deepEqual(locations['main-warehouse'].fields, ['kardex']);
});

test('stores waste as its own weekly cafeteria file', async t => {
  const baseUrl = await startTestServer(t);
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-03', [{
    field: 'waste', contents: 'Fecha\tProducto\tCantidad\n2026-08-05\tLeche\t2', filename: 'merma.csv'
  }]).then(response => response.json());
  const saved = await confirm(baseUrl, inspection).then(response => response.json());
  assert.equal(saved.meta.files.waste.originalName, 'merma.csv');
  assert.equal((await fetch(`${baseUrl}${saved.meta.files.waste.url}`)).status, 200);
});

test('rejects invalid locations and week paths before staging files', async t => {
  const baseUrl = await startTestServer(t);
  const file = [{ field: 'sales', contents: 'Fecha\n2026-08-08', filename: 'sales.csv' }];
  const invalidLocation = await inspect(baseUrl, 'unknown', '2026-08-03', file);
  const invalidWeek = await inspect(baseUrl, 'store-1', '..%2Fescape', file);

  assert.equal(invalidLocation.status, 400);
  assert.equal(invalidWeek.status, 400);
});

test('rejects transaction and master files whose structure does not match the selected category', async t => {
  const baseUrl = await startTestServer(t);
  const purchaseContents = [
    ['Fecha emisión', 'Documento', 'Proveedor/Para', 'PRODUCTO', 'Cod', 'Q.Rec', 'Um.Rec', 'Costo'],
    ['2026-08-04', '100', 'Proveedor', 'Insumo', 'I1', 1, 'UN', 100]
  ].map(row => row.join('\t')).join('\n');
  const wrongTransaction = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'sales', contents: purchaseContents, filename: 'compras.xls'
  }]);
  assert.equal(wrongTransaction.status, 422);
  const transactionError = await wrongTransaction.json();
  assert.equal(transactionError.code, 'FILE_STRUCTURE_MISMATCH');
  assert.equal(transactionError.mismatch.expected, 'sales');
  assert.equal(transactionError.mismatch.detected, 'purchases');
  assert.match(transactionError.error, /Transacciones de venta.*Compras/i);

  const recipeContents = [
    ['Id Producto', 'Id Ingrediente', 'Cantidad Ingrediente', 'Unidad Medida'],
    ['P1', 'I1', 1, 'UN']
  ].map(row => row.join('\t')).join('\n');
  const wrongMaster = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{ field: 'master-suppliers', contents: recipeContents, filename: 'recetas.txt' }], {
      'master-suppliers-from': '2026-08-01'
    })
  });
  assert.equal(wrongMaster.status, 422);
  const masterError = await wrongMaster.json();
  assert.equal(masterError.code, 'FILE_STRUCTURE_MISMATCH');
  assert.equal(masterError.mismatch.expected, 'master-suppliers');
  assert.equal(masterError.mismatch.detected, 'master-recipes');
  assert.match(masterError.error, /Maestro Proveedores.*Maestro de recetas/i);
  assert.deepEqual(await fetch(`${baseUrl}/api/masters`).then(response => response.json()), {});
});

test('migrates legacy Sunday week folders to their Monday week key', async t => {
  const baseUrl = await startTestServer(t, {
    beforeCreate(uploadsRoot) {
      const legacy = path.join(uploadsRoot, 'weeks', '2026-08-09', 'store-1');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'sales.csv'), 'Fecha\n2026-08-09');
      fs.writeFileSync(path.join(legacy, 'meta.json'), JSON.stringify({
        week: '2026-08-09',
        location: 'store-1',
        confirmedRange: { from: '2026-08-04', to: '2026-08-09' },
        files: { sales: { name: 'sales.csv', originalName: 'sales.csv', url: '/uploads/weeks/2026-08-09/store-1/sales.csv' } }
      }));
    }
  });
  const migrated = await fetch(`${baseUrl}/api/weeks/2026-08-03?location=store-1`);
  assert.equal(migrated.status, 200);
  const metadata = await migrated.json();
  assert.equal(metadata.week, '2026-08-03');
  assert.equal((await fetch(`${baseUrl}${metadata.files.sales.url}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/weeks/2026-08-09?location=store-1`)).status, 400);
});

test('calculates yesterday, Monday-to-date, month-to-date, rankings, and eight-week average', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-14' });
  const rows = [
    ['ID de orden', 'Fecha de creacion', 'Pago total', 'Descuentos'],
    ['old-1', '2026-06-18', 119, 0], ['old-2', '2026-06-25', 119, 0],
    ['old-3', '2026-07-02', 119, 0], ['old-4', '2026-07-09', 119, 0],
    ['old-5', '2026-07-16', 119, 0], ['old-6', '2026-07-23', 119, 0],
    ['old-7', '2026-07-30', 119, 0], ['old-8', '2026-08-06', 119, 0],
    ['month-high', '2026-08-01', 1190, 0],
    ['monday', '2026-08-10', 119, 0], ['tuesday', '2026-08-11', 238, 0],
    ['wednesday', '2026-08-12', 357, 0], ['yesterday', '2026-08-13', 357, -119],
    ['today', '2026-08-14', 476, 0]
  ];
  const sales = rows.map(row => row.join('\t')).join('\n');
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-10', [{ field: 'sales', contents: sales, filename: 'sales.csv' }])
    .then(response => response.json());
  assert.equal((await confirm(baseUrl, inspection, { from: '2026-06-18', to: '2026-08-14' })).status, 200);

  const report = await fetch(`${baseUrl}/api/reports/weekly-sales`).then(response => response.json());
  assert.equal(report.basis, 'gross-plus-signed-discounts-divided-by-1.19');
  assert.equal(report.previousDay.date, '2026-08-13');
  assert.equal(report.previousDay.discounts, -119);
  assert.equal(Math.round(report.previousDay.netSales), 200);
  assert.equal(report.previousDay.generalRank.position, 3);
  assert.deepEqual(report.previousDay.sameWeekdayRank, { position: 1, total: 9 });
  assert.equal(Math.round(report.previousDay.sameWeekdayAverage), 100);
  assert.equal(Math.round(report.previousDay.comparisonToAveragePercent), 100);
  assert.equal(report.week.from, '2026-08-10');
  assert.equal(Math.round(report.week.netSales), 800);
  assert.equal(report.month.from, '2026-08-01');
  assert.equal(Math.round(report.month.netSales), 1900);
  assert.equal(report.statistics.months.length, 14);
  assert.deepEqual(report.statistics.months[0], {
    key: '2026-08', from: '2026-08-01', to: '2026-08-13', netSales: 1900
  });
  assert.equal(report.statistics.weeks.length, 14);
  assert.deepEqual(report.statistics.weeks[0], {
    from: '2026-08-10', to: '2026-08-13', netSales: 800
  });
  assert.equal(report.statistics.days.length, 14);
  assert.deepEqual(report.statistics.days.slice(0, 2), [
    { date: '2026-08-13', netSales: 200 },
    { date: '2026-08-12', netSales: 300 }
  ]);
  assert.equal(report.statistics.equivalentDays.length, 14);
  assert.deepEqual(report.statistics.equivalentDays.slice(0, 2), [
    { date: '2026-08-13', netSales: 200 },
    { date: '2026-08-06', netSales: 100 }
  ]);

  const includingToday = await fetch(`${baseUrl}/api/reports/weekly-sales?includeToday=true`).then(response => response.json());
  assert.equal(includingToday.includeToday, true);
  assert.equal(includingToday.cutoff, 'today');
  assert.equal(includingToday.previousDay.date, '2026-08-14');
  assert.equal(Math.round(includingToday.previousDay.netSales), 400);
  assert.equal(includingToday.week.to, '2026-08-14');
  assert.equal(Math.round(includingToday.week.netSales), 1200);
  assert.equal(includingToday.month.to, '2026-08-14');
  assert.equal(Math.round(includingToday.month.netSales), 2300);
  assert.equal(Math.round(includingToday.statistics.months[0].netSales), 2300);
  assert.equal(Math.round(includingToday.statistics.weeks[0].netSales), 1200);
  assert.deepEqual(includingToday.statistics.days[0], { date: '2026-08-14', netSales: 400 });
});

test('does not compare a missing previous sales day as if it were a zero-sale day', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-14' });
  const sales = [
    ['ID de orden', 'Fecha de creacion', 'Pago total', 'Descuentos'],
    ['prior-thursday', '2026-08-06', 119, 0]
  ].map(row => row.join('\t')).join('\n');
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-03', [{ field: 'sales', contents: sales, filename: 'sales.csv' }])
    .then(response => response.json());
  assert.equal((await confirm(baseUrl, inspection)).status, 200);

  const report = await fetch(`${baseUrl}/api/reports/weekly-sales`).then(response => response.json());
  assert.equal(report.previousDay.netSales, 0);
  assert.equal(report.previousDay.generalRank.position, null);
  assert.equal(report.previousDay.sameWeekdayRank.position, null);
  assert.equal(report.previousDay.comparisonToAveragePercent, null);
});

test('filters the sales report by cafeteria and defaults to all cafeterias', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-14' });
  for (const [location, order, gross] of [['store-1', 'one', 119], ['store-2', 'two', 238]]) {
    const contents = [
      ['ID de orden', 'Fecha de creacion', 'Pago total', 'Descuentos'],
      [order, '2026-08-13', gross, 0]
    ].map(row => row.join('\t')).join('\n');
    const inspection = await inspect(baseUrl, location, '2026-08-10', [{ field: 'sales', contents, filename: `${location}.csv` }])
      .then(response => response.json());
    assert.equal((await confirm(baseUrl, inspection)).status, 200);
  }

  const all = await fetch(`${baseUrl}/api/reports/weekly-sales`).then(response => response.json());
  const first = await fetch(`${baseUrl}/api/reports/weekly-sales?location=store-1`).then(response => response.json());
  const second = await fetch(`${baseUrl}/api/reports/weekly-sales?location=store-2`).then(response => response.json());
  assert.equal(Math.round(all.previousDay.netSales), 300);
  assert.equal(all.scope.type, 'all');
  assert.equal(Math.round(first.previousDay.netSales), 100);
  assert.equal(first.scope.label, 'Tienda 1');
  assert.equal(Math.round(second.previousDay.netSales), 200);
  assert.equal((await fetch(`${baseUrl}/api/reports/weekly-sales?location=main-warehouse`)).status, 400);
});

test('organizes products by hierarchy and calculates rolling sales by cafeteria', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-14' });
  const catalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'pv', 'ce', 'st', 'jp'],
    ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', 'Activo', 'Jerarquías de Producto *'],
    ['P1', 'Café Uno', 3000, 900, 1, 'AB.010020'],
    ['P2', 'Café Dos', 4000, 1000, 0, 'AB.010020']
  ]), 'Prod');
  const masterResponse = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog',
      contents: XLSX.write(catalog, { type: 'buffer', bookType: 'xlsx' }),
      filename: 'catalogo.xlsx'
    }, {
      field: 'product-hierarchy',
      contents: [
        ['ID Jerarquia', 'ID Nodo **', 'Nombre Jerarquía Producto *', 'ID nodo padre', 'Visible a Clientes *', 'Fotos', 'Orden'],
        ['AB.', 0, 'Todos', '', 1, '', 1],
        ['AB.010', 10, 'Barra Café', 'AB.', 1, '', 1],
        ['AB.010020', 20, 'Café Caliente', 'AB.010', 1, '', 1]
      ].map(row => row.join('\t')).join('\n'),
      filename: 'jerarquia.txt'
    }], {
      'master-catalog-from': '2026-08-01',
      'product-hierarchy-from': '2026-08-01'
    })
  });
  assert.equal(masterResponse.status, 200);

  const storeRows = {
    'store-1': [
      ['o1', '2026-08-14', 'P1', 'Café Uno', 7],
      ['o2', '2026-08-06', 'P1', 'Café Uno', 8],
      ['o3', '2026-07-25', 'P1', 'Café Uno', 4],
      ['o4', '2026-06-19', 'P1', 'Café Uno', 100]
    ],
    'store-2': [
      ['o5', '2026-08-14', 'P1', 'Café Uno', 3],
      ['o6', '2026-08-14', 'P2', 'Café Dos', 2]
    ]
  };
  for (const [location, rows] of Object.entries(storeRows)) {
    const contents = [
      ['ID de orden', 'Fecha de creacion', 'ID Producto', 'Nombre', 'Cantidad'],
      ...rows
    ].map(row => row.join('\t')).join('\n');
    const inspection = await inspect(baseUrl, location, '2026-08-10', [{ field: 'sales', contents, filename: `${location}.csv` }])
      .then(response => response.json());
    assert.equal((await confirm(baseUrl, inspection)).status, 200);
  }

  const all = await fetch(`${baseUrl}/api/products?location=all`).then(response => response.json());
  assert.equal(all.productCount, 2);
  assert.deepEqual(all.hierarchies[0].path, ['Barra Café', 'Café Caliente']);
  const allP1 = all.hierarchies[0].products.find(product => product.code === 'P1');
  const allP2 = all.hierarchies[0].products.find(product => product.code === 'P2');
  assert.equal(allP1.unitsLast7Days, 10);
  assert.equal(allP1.averageWeeklyUnits8, 2.75);
  assert.equal(Math.round(allP1.unitsChangePercent * 10) / 10, 263.6);
  assert.equal(Math.round(allP1.netPrice * 100) / 100, 2521.01);
  assert.equal(Math.round(allP1.marginPercent * 10) / 10, 64.3);
  assert.equal(allP2.unitsLast7Days, 2);
  assert.equal(allP2.unitsChangePercent, 700);
  assert.equal(allP2.active, false);

  const first = await fetch(`${baseUrl}/api/products?location=store-1`).then(response => response.json());
  const firstP1 = first.hierarchies[0].products.find(product => product.code === 'P1');
  assert.equal(firstP1.unitsLast7Days, 7);
  assert.equal(firstP1.averageWeeklyUnits8, 2.375);
  assert.equal(Math.round(firstP1.unitsChangePercent * 10) / 10, 194.7);
  assert.equal((await fetch(`${baseUrl}/api/products?location=main-warehouse`)).status, 400);

  const savedResponse = await fetch(`${baseUrl}/api/products/reports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1' })
  });
  assert.equal(savedResponse.status, 201);
  const savedReport = await savedResponse.json();
  assert.equal(savedReport.id, '2026-08-14--store-1');
  assert.equal((await fetch(`${baseUrl}/api/products/reports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1' })
  })).status, 409);
  const savedList = await fetch(`${baseUrl}/api/products/reports?location=store-1`).then(response => response.json());
  assert.equal(savedList.reports.length, 1);

  const updatedCatalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(updatedCatalog, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'pv', 'ce', 'st', 'jp'],
    ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', 'Activo', 'Jerarquías de Producto *'],
    ['P1', 'Café Uno', 3300, 900, 1, 'AB.010020'],
    ['P2', 'Café Dos', 4000, 1000, 0, 'AB.010020']
  ]), 'Prod');
  const updateMaster = await fetch(`${baseUrl}/upload/master?replace=true`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog',
      contents: XLSX.write(updatedCatalog, { type: 'buffer', bookType: 'xlsx' }),
      filename: 'catalogo-actualizado.xlsx'
    }], { 'master-catalog-from': '2026-08-01' })
  });
  assert.equal(updateMaster.status, 200);
  const comparison = await fetch(`${baseUrl}/api/products/reports/compare?location=store-1&snapshot=${savedReport.id}`)
    .then(response => response.json());
  assert.equal(comparison.changeCount, 1);
  assert.deepEqual(comparison.counts, { added: 0, removed: 0, price: 1, cost: 0, margin: 1 });
  assert.equal(comparison.changes[0].code, 'P1');
  assert.equal(comparison.changes[0].before.price, 3000);
  assert.equal(comparison.changes[0].after.price, 3300);
});

test('builds ingredient costs, recipe usage, suppliers, and cost variation for a selected period', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-15' });
  const catalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'pv', 'ce', 'ub'],
    ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', 'Medida Base'],
    ['P1', 'Producto Uno', 2000, 8, 'UN']
  ]), 'Prod');
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce', 'ub'],
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base'],
    ['I1', 'Ingrediente Uno', 4, 'kg']
  ]), 'Ingr');
  const masters = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog', contents: XLSX.write(catalog, { type: 'buffer', bookType: 'xlsx' }), filename: 'catalogo.xlsx'
    }, {
      field: 'master-recipes',
      contents: 'Id Producto\tNombre Producto*\tId Ingrediente\tNombre Ingrediente*\tCantidad Ingrediente\tUnidad Medida\tTasa Rendimiento\nP1\tProducto Uno\tI1\tIngrediente Uno\t0,5\tkg\t80',
      filename: 'recetas.txt'
    }, {
      field: 'master-suppliers', contents: 'Nombre*\tRUT/Fiscal ID*\nProveedor Uno\t111', filename: 'proveedores.txt'
    }], {
      'master-catalog-from': '2026-08-01', 'master-recipes-from': '2026-08-01', 'master-suppliers-from': '2026-08-01'
    })
  });
  assert.equal(masters.status, 200);
  const sales = 'ID de orden\tFecha de creacion\tPago total\tDescuentos\tID Producto\tNombre\tCantidad\tPrecio a Pagar\tDescuento\no1\t2026-08-10\t2000\t0\tP1\tProducto Uno\t4\t2000\t0';
  const purchases = [
    'Fecha emisión\tTipo Documento\tDocumento\tProveedor/Para\tNúmero identificador fiscal\tLin\tCod\tPRODUCTO\tQ.Rec\tUm.Rec\tCosto\tMonto neto\tDescuento\tMonto total',
    '2026-08-01\tFactura\t1\tProveedor Uno\t111\t1\tI1\tIngrediente Uno\t1\tkg\t5\t5\t0\t5',
    '2026-08-15\tFactura\t2\tProveedor Uno\t111\t1\tI1\tIngrediente Uno\t1\tkg\t6\t6\t0\t6'
  ].join('\n');
  const inspection = await inspectTransactions(baseUrl, 'store-1', [
    { field: 'sales', contents: sales, filename: 'ventas.csv' },
    { field: 'purchases', contents: purchases, filename: 'compras.csv' }
  ]).then(response => response.json());
  assert.ok(inspection.token, JSON.stringify(inspection));
  assert.equal((await confirmTransactions(baseUrl, inspection, 'keep', { from: '2026-08-01', to: '2026-08-15' })).status, 200);

  const response = await fetch(`${baseUrl}/api/ingredients?location=store-1&dateFrom=2026-08-01&dateTo=2026-08-15`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].supplier, 'Proveedor Uno');
  assert.equal(report.items[0].products.length, 1);
  assert.equal(report.items[0].products[0].yieldRate, 80);
  assert.equal(report.items[0].products[0].effectiveQuantity, 0.625);
  assert.equal(report.items[0].usageQuantity, 2.5);
  assert.equal(report.items[0].usageCost, 10);
  assert.equal(report.items[0].latestPurchaseCost, 6);
  assert.equal(Math.round(report.items[0].costChangePercent), 20);
  assert.equal(report.summary.totalUsageCost, 10);

  const warehouseKardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-10', '', '', '', '2026-08-11', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'USO - Consumo por Ventas', 'TRN-OUT - Transformaciones Salientes', 'IF - Inventario Final', 'II - Inventario Inicial', 'USO - Consumo por Ventas', 'TRN-OUT - Transformaciones Salientes', 'IF - Inventario Final'],
    ['I1', 'Ingrediente Uno', 'kg', 10, 2, 1, 7, 7, 0, 0, 7]
  ].map(row => row.join('\t')).join('\n');
  const warehouseInspection = await inspectTransactions(baseUrl, 'main-warehouse', [
    { field: 'kardex', contents: warehouseKardex, filename: 'kardex-bodega.csv' }
  ]).then(response => response.json());
  assert.ok(warehouseInspection.token, JSON.stringify(warehouseInspection));
  assert.equal((await confirmTransactions(baseUrl, warehouseInspection, 'keep', { from: '2026-08-10', to: '2026-08-10' })).status, 200);
  const warehouseResponse = await fetch(`${baseUrl}/api/ingredients?location=main-warehouse&dateFrom=2026-08-01&dateTo=2026-08-15`);
  const warehouse = await warehouseResponse.json();
  assert.equal(warehouseResponse.status, 200, JSON.stringify(warehouse));
  assert.equal(warehouse.scope.type, 'warehouse');
  assert.equal(warehouse.items[0].usageQuantity, 3);
  assert.equal(warehouse.items[0].usageCost, 12);
});

test('lists purchases by supplier and filters price history by cafeteria and dates', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-15' });
  const supplierMaster = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-suppliers',
      contents: 'Nombre*\tRUT/Fiscal ID*\nProveedor Uno\t111\nProveedor Dos\t222',
      filename: 'proveedores.txt'
    }], { 'master-suppliers-from': '2026-08-01' })
  });
  assert.equal(supplierMaster.status, 200);
  const catalogWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalogWorkbook, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce', 'ub', 'conv.0.umed', 'conv.0.umedb', 'conv.0.cnum', 'conv.0.cden', 'conv.1.umed', 'conv.1.umedb', 'conv.1.cnum', 'conv.1.cden'],
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base', 'Conversion - Unidad Medida a Definir', 'Conversion - Unidad Medida Base', 'Conversion - Numerador', 'Conversion - Denominador', 'Conversion - Unidad Medida a Definir', 'Conversion - Unidad Medida Base', 'Conversion - Numerador', 'Conversion - Denominador'],
    ['I1', 'Insumo Uno', 10, 'UN', 'UN', 'UN', 1, 1, 'CAJ', 'UN', 12, 1],
    ['I2', 'Insumo Dos', 500, 'kg', 'kg', 'kg', 1, 1, null, null, null, null]
  ]), 'Ingr');
  const catalogMaster = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog',
      contents: XLSX.write(catalogWorkbook, { type: 'buffer', bookType: 'xlsx' }),
      filename: 'catalogo.xlsx'
    }], { 'master-catalog-from': '2026-08-01' })
  });
  assert.equal(catalogMaster.status, 200);
  const headers = ['Fecha emisión', 'Tipo Documento', 'Documento', 'Proveedor/Para', 'Número identificador fiscal', 'Lin', 'Cod', 'PRODUCTO', 'Q.Rec', 'Um.Rec', 'Q.Fac', 'Um.Fac', 'Costo', 'Costo negociado', 'Monto neto', 'Descuento', 'Monto total'];
  const fixtures = {
    'store-1': [
      ['2026-08-04', 'Factura', '10', 'Alias Uno', '111', '1', 'I1', 'Insumo Uno', 1, 'CAJ', 1, 'CAJ', 100, 0, 100, 0, 100],
      ['2026-08-06', 'Factura', '11', 'Alias Uno', '111', '1', 'I1', 'Insumo Uno', 2, 'CAJ', 2, 'CAJ', 120, 0, 240, 0, 240],
      ['2026-08-06', 'Factura', '12', 'Proveedor Dos', '222', '1', 'I2', 'Insumo Dos', 1, 'KG', 1, 'KG', 500, 0, 500, 50, 450]
    ],
    'store-2': [
      ['2026-08-05', 'Factura', '20', 'Alias Uno', '111', '1', 'I1', 'Insumo Uno', 1, 'CAJ', 1, 'CAJ', 130, 0, 130, 0, 130]
    ]
  };
  for (const [location, rows] of Object.entries(fixtures)) {
    const contents = [headers, ...rows].map(row => row.join('\t')).join('\n');
    const inspection = await inspect(baseUrl, location, '2026-08-03', [{ field: 'purchases', contents, filename: `${location}-compras.xls` }])
      .then(response => response.json());
    assert.equal((await confirm(baseUrl, inspection)).status, 200);
  }

  const all = await fetch(`${baseUrl}/api/purchases?location=all&supplier=all`).then(response => response.json());
  assert.equal(all.rows.length, 4);
  assert.deepEqual(all.availablePeriod, { from: '2026-08-04', to: '2026-08-06' });
  assert.equal(all.suppliers[0].name, 'Proveedor Dos');
  assert.equal(all.suppliers[1].name, 'Proveedor Uno');
  assert.equal(all.summary.totalAmount, 920);
  const changed = all.rows.find(row => row.document === '11');
  assert.equal(changed.previousEffectiveUnitPrice, 100);
  assert.equal(Math.round(changed.priceChangePercent), 20);
  assert.equal(changed.purchaseUnit, 'CAJ');
  assert.equal(changed.unitsPerPurchaseUnit, 12);
  assert.equal(changed.baseUnit, 'UN');
  assert.equal(changed.baseUnitCost, 10);
  const kilograms = all.rows.find(row => row.document === '12');
  assert.equal(kilograms.purchaseUnit, 'KG');
  assert.equal(kilograms.unitsPerPurchaseUnit, 1);
  assert.equal(kilograms.baseUnit, 'kg');
  assert.equal(kilograms.baseUnitCost, 500);

  const filtered = await fetch(`${baseUrl}/api/purchases?location=store-1&supplier=111&dateFrom=2026-08-05&dateTo=2026-08-06`)
    .then(response => response.json());
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].document, '11');
  assert.equal(filtered.summary.totalAmount, 240);
  const productFiltered = await fetch(`${baseUrl}/api/purchases?location=store-1&supplier=all&product=Insumo%20Dos`)
    .then(response => response.json());
  assert.equal(productFiltered.rows.length, 1);
  assert.equal(productFiltered.rows[0].document, '12');

  const warehouseKardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '', '', '2026-08-05', '', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'Costo', 'IF - Inventario Final', 'II - Inventario Inicial', 'TRL-OUT - Transferencias Locales Salientes', 'TRN-OUT - Transformaciones Salientes', 'Costo', 'IF - Inventario Final'],
    ['I1', 'Insumo Uno', 'UN', 0, 3, 10, 3, 3, 3, 2, 10, 0]
  ].map(row => row.join('\t')).join('\n');
  const warehouseInspection = await inspect(baseUrl, 'main-warehouse', '2026-08-03', [{
    field: 'kardex', contents: warehouseKardex, filename: 'bodega-kardex.xls'
  }]).then(response => response.json());
  assert.equal((await confirm(baseUrl, warehouseInspection)).status, 200);
  const warehouse = await fetch(`${baseUrl}/api/purchases?location=main-warehouse&supplier=all&product=I1`)
    .then(response => response.json());
  assert.equal(warehouse.rows.length, 1);
  assert.equal(warehouse.scope.type, 'warehouse');
  assert.equal(warehouse.rows[0].locationId, 'main-warehouse');
  assert.equal(warehouse.rows[0].supplier, 'Ingresos BUY según Kardex');
  assert.equal(warehouse.rows[0].sourceType, 'kardex-buy');
  assert.equal(warehouse.rows[0].quantity, 3);
  assert.equal(warehouse.rows[0].listedUnitPrice, 10);
  assert.equal(warehouse.rows[0].totalAmount, 30);

  const projection = await fetch(`${baseUrl}/api/purchase-projections?location=main-warehouse`).then(response => response.json());
  assert.equal(projection.location.id, 'main-warehouse');
  assert.equal(projection.period.dataThrough, '2026-08-05');
  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].consumption30, 5);
  assert.equal(projection.items[0].currentInventory, 0);
  assert.equal(projection.items[0].minDays, 7);
  assert.equal(projection.items[0].maxDays, 14);
  assert.equal(projection.items[0].managed, false);
  assert.equal(projection.summary.managedItemCount, 0);
  assert.equal(projection.items[0].suggestedPurchaseUnits, 1);
  assert.equal(projection.items[0].purchaseUnit, 'CAJ');
  assert.equal(projection.items[0].unitsPerPurchaseUnit, 12);
  assert.equal(projection.items[0].supplier, 'Proveedor Uno');
  assert.equal(projection.items[0].supplierInferred, true);
  assert.equal(projection.summary.missingCostCount, 0);

  const savePolicy = await fetch(`${baseUrl}/api/purchase-projections/policies`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location: 'main-warehouse',
      items: [{ key: 'I1', minDays: 10, maxDays: 20, supplierKey: '222', managed: true }]
    })
  });
  assert.equal(savePolicy.status, 200);
  const configuredProjection = await fetch(`${baseUrl}/api/purchase-projections?location=main-warehouse`).then(response => response.json());
  assert.equal(configuredProjection.items[0].minDays, 10);
  assert.equal(configuredProjection.items[0].maxDays, 20);
  assert.equal(configuredProjection.items[0].managed, true);
  assert.equal(configuredProjection.summary.managedItemCount, 1);
  assert.equal(configuredProjection.summary.purchaseItemCount, 1);
  assert.equal(configuredProjection.items[0].supplier, 'Proveedor Dos');
  assert.equal(configuredProjection.items[0].supplierInferred, false);
  assert.equal(configuredProjection.items[0].supplierPurchaseReferenceMatched, false);
  const invalidPolicy = await fetch(`${baseUrl}/api/purchase-projections/policies`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'main-warehouse', items: [{ key: 'I1', minDays: 20, maxDays: 10 }] })
  });
  assert.equal(invalidPolicy.status, 400);
});

test('builds cumulative intraday blocks with weekday, month, and historical reference days', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-14' });
  const rows = [
    ['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos'],
    ['today-before-seven', '2026-08-14', '06:30:00', 119, 0],
    ['today-first-limit', '2026-08-14', '08:59:59', 119, 0],
    ['today-next-block', '2026-08-14', '09:00:00', 119, 0],
    ['today-last-block', '2026-08-14', '19:00:00', 119, 0],
    ['same-weekday-morning', '2026-08-07', '08:00:00', 238, 0],
    ['same-weekday-noon', '2026-08-07', '12:00:00', 357, 0],
    ['month-morning', '2026-08-12', '08:00:00', 119, 0],
    ['month-afternoon', '2026-08-12', '16:00:00', 595, 0],
    ['historical-morning', '2026-07-01', '08:00:00', 357, 0],
    ['historical-evening', '2026-07-01', '20:00:00', 476, 0]
  ];
  const contents = rows.map(row => row.join('\t')).join('\n');
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-10', [{ field: 'sales', contents, filename: 'intraday.csv' }])
    .then(response => response.json());
  assert.equal((await confirm(baseUrl, inspection, { from: '2026-07-01', to: '2026-08-14' })).status, 200);

  const report = await fetch(`${baseUrl}/api/reports/weekly-sales?location=store-1`).then(response => response.json());
  assert.equal(report.intraday.today.date, '2026-08-14');
  assert.equal(report.intraday.today.cutoffTime, '19:00:00');
  assert.equal(Math.round(report.intraday.today.netSales), 400);
  assert.deepEqual(report.intraday.today.generalRank, { position: 3, total: 4 });
  assert.deepEqual(report.intraday.today.sameWeekdayRank, { position: 2, total: 2 });
  assert.equal(Math.round(report.intraday.today.sameWeekdayAverage), 500);
  assert.equal(Math.round(report.intraday.today.comparisonToAveragePercent), -20);
  assert.equal(report.intraday.today.averageSampleSize, 1);
  assert.equal(report.intraday.references.sameWeekday.date, '2026-08-07');
  assert.equal(report.intraday.references.month.date, '2026-08-12');
  assert.equal(report.intraday.references.historical.date, '2026-07-01');
  assert.equal(report.intraday.blocks.length, 7);
  assert.equal(report.intraday.blocks[0].label, '07:00–09:00');
  assert.equal(Math.round(report.intraday.blocks[0].today), 200);
  assert.equal(Math.round(report.intraday.blocks[1].today), 300);
  assert.equal(Math.round(report.intraday.blocks[2].sameWeekday), 500);
  assert.equal(report.intraday.blocks.at(-1).label, '19:00–cierre');
  assert.equal(Math.round(report.intraday.blocks.at(-1).today), 400);
  assert.equal(Math.round(report.intraday.blocks.at(-1).month), 600);
  assert.equal(Math.round(report.intraday.blocks.at(-1).historical), 700);
});

test('selects the most recent inventory source files for an active location', async t => {
  const baseUrl = await startTestServer(t);
  const structuredWaste = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '', '', '2026-08-05', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final'],
    ['P1', 'Producto con merma', 'UN', 0, 0, 2, 2, 2, 1, 3, 6],
    ['P2', 'Producto sin merma', 'UN', 0, 0, 0, 0, 0, 0, 0, 0]
  ].map(row => row.join('\t')).join('\n');
  const firstInspection = await inspect(baseUrl, 'store-1', '2026-08-03', [
    { field: 'kardex', contents: 'Fecha\n2026-08-04', filename: 'kardex-antiguo.csv' },
    { field: 'waste', contents: structuredWaste, filename: 'merma.csv' },
    { field: 'marketing', contents: 'Fecha\n2026-08-05', filename: 'marketing.csv' },
    { field: 'employees', contents: 'Fecha\n2026-08-06', filename: 'colaboradores.csv' }
  ]).then(response => response.json());
  assert.equal((await confirm(baseUrl, firstInspection, { from: '2026-08-04', to: '2026-08-06' })).status, 200);
  const structuredKardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-12', '', '', '2026-08-13', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'IF - Inventario Final'],
    ['P1', 'Producto', 'UN', 10, 2, 12, 12, 0, 12]
  ].map(row => row.join('\t')).join('\n');
  const latestInspection = await inspect(baseUrl, 'store-1', '2026-08-10', [
    { field: 'kardex', contents: structuredKardex, filename: 'kardex-nuevo.csv' }
  ]).then(response => response.json());
  assert.equal((await confirm(baseUrl, latestInspection)).status, 200);

  const inventory = await fetch(`${baseUrl}/api/inventory/sources?location=store-1`).then(response => response.json());
  assert.equal(inventory.ready, true);
  assert.equal(inventory.sources.length, 4);
  assert.deepEqual(inventory.sources.map(source => source.field), ['kardex', 'waste', 'marketing', 'employees']);
  assert.equal(inventory.sources.find(source => source.field === 'kardex').file.originalName, 'kardex-nuevo.csv');
  assert.equal(inventory.sources.find(source => source.field === 'kardex').file.dataThrough, '2026-08-13');
  assert.deepEqual(inventory.kardexPeriod, {
    dates: ['2026-08-12', '2026-08-13'],
    firstDate: '2026-08-12',
    penultimateDate: '2026-08-12',
    lastDate: '2026-08-13'
  });
  assert.equal(inventory.sources.find(source => source.field === 'waste').file.originalName, 'merma.csv');
  assert.equal(inventory.sources.find(source => source.field === 'marketing').file.originalName, 'marketing.csv');
  assert.equal(inventory.sources.find(source => source.field === 'employees').file.originalName, 'colaboradores.csv');
  const kardexPreviewUrl = inventory.sources.find(source => source.field === 'kardex').file.previewUrl;
  assert.equal((await fetch(`${baseUrl}${kardexPreviewUrl}`)).status, 200);
  const previewSeparator = kardexPreviewUrl.includes('?') ? '&' : '?';
  const filteredPreview = await fetch(`${baseUrl}${kardexPreviewUrl}${previewSeparator}dateFrom=2026-08-12&dateTo=2026-08-12`).then(response => response.json());
  assert.deepEqual(filteredPreview.selectedRange, { from: '2026-08-12', to: '2026-08-12' });
  assert.equal(filteredPreview.sheets[0].rows[0].length, 6);
  assert.equal(filteredPreview.sheets[0].rows[0][3], '2026-08-12');
  assert.equal(filteredPreview.sheets[0].rows[0].includes('2026-08-13'), false);

  const catalogWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalogWorkbook, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base'],
    ['P1', 'Producto con merma', 100, 'UN'],
    ['P2', 'Producto sin merma', 50, 'UN']
  ]), 'Productos');
  const catalogUpload = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog',
      contents: XLSX.write(catalogWorkbook, { type: 'buffer', bookType: 'xlsx' }),
      filename: 'catalogo.xlsx'
    }], { 'master-catalog-from': '2026-08-01' })
  });
  assert.equal(catalogUpload.status, 200);

  const wasteSummary = await fetch(`${baseUrl}/api/inventory/waste-summary?location=store-1&dateFrom=2026-08-04&dateTo=2026-08-05`).then(response => response.json());
  assert.equal(wasteSummary.report.itemCount, 1);
  assert.equal(wasteSummary.report.items[0].code, 'P1');
  assert.equal(wasteSummary.report.items[0].total, 6);
  assert.equal(wasteSummary.report.items[0].unitCost, 100);
  assert.equal(wasteSummary.report.items[0].totalCost, 600);
  assert.equal(wasteSummary.report.additionTotals['buy-compras'], 1);
  assert.equal(wasteSummary.report.additionTotals['mov-in-transferencias-entre-bodegas-entrantes'], 5);
  assert.equal(wasteSummary.report.totalAdditions, 6);
  assert.equal(wasteSummary.report.totalCost, 600);
  assert.deepEqual(wasteSummary.report.itemsWithoutCost, []);
  assert.equal(wasteSummary.report.additionDefinitions.length, 2);

  const warehouse = await fetch(`${baseUrl}/api/inventory/sources?location=main-warehouse`).then(response => response.json());
  assert.equal(warehouse.sources.find(source => source.field === 'waste').applicable, false);
  assert.equal(warehouse.sources.find(source => source.field === 'marketing').applicable, false);
  assert.equal(warehouse.sources.find(source => source.field === 'employees').applicable, false);
  assert.equal((await fetch(`${baseUrl}/api/inventory/sources?location=unknown`)).status, 400);
});

test('consolidates Kardex movements and compares theoretical inventory with next-day physical inventory', async t => {
  const baseUrl = await startTestServer(t);
  const kardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '', '', '2026-08-05', '', '', '', '2026-08-06', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final'],
    ['P1', 'Producto Uno', 'UN', 10, 5, 3, 12, 12, 2, 4, 10, 9, 0, 0, 9],
    ['P2', 'Producto Dos', 'KG', 20, 4, 5, 19, 19, 1, 2, 18, 20, 0, 0, 20]
  ].map(row => row.join('\t')).join('\n');
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-03', [
    { field: 'kardex', contents: kardex, filename: 'kardex.csv' },
    { field: 'waste', contents: kardex, filename: 'merma.csv' }
  ]).then(response => response.json());
  assert.equal((await confirm(baseUrl, inspection)).status, 200);

  const sources = await fetch(`${baseUrl}/api/inventory/sources?location=store-1`).then(response => response.json());
  assert.equal(sources.kardexPeriod.firstDate, '2026-08-04');
  assert.equal(sources.kardexPeriod.penultimateDate, '2026-08-05');
  assert.equal(sources.kardexPeriod.lastDate, '2026-08-06');

  const processed = await fetch(`${baseUrl}/api/inventory/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', dateFrom: '2026-08-04', dateTo: '2026-08-05' })
  });
  assert.equal(processed.status, 200);
  const report = (await processed.json()).report;
  assert.equal(report.physicalInventoryDate, '2026-08-06');
  assert.equal(report.itemCount, 2);
  assert.deepEqual(report.movementDefinitions.map(item => item.label), ['BUY - Compras', 'USO - Consumo por Ventas']);
  assert.equal(report.items[0].initialInventory, 10);
  assert.equal(report.items[0].movements['buy-compras'], 7);
  assert.equal(report.items[0].movements['uso-consumo-por-ventas'], 7);
  assert.equal(report.items[0].theoreticalFinal, 10);
  assert.equal(report.items[0].physicalFinal, 9);
  assert.equal(report.items[0].difference, -1);
  assert.equal(report.items[1].physicalFinal, 20);

  const customProcessed = await fetch(`${baseUrl}/api/inventory/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      location: 'store-1',
      initialInventoryDate: '2026-08-04',
      initialInventoryBasis: 'final',
      finalInventoryDate: '2026-08-06',
      finalInventoryBasis: 'initial',
      movementDateFrom: '2026-08-04',
      movementDateTo: '2026-08-05'
    })
  });
  assert.equal(customProcessed.status, 200);
  const customPayload = await customProcessed.json();
  const customReport = customPayload.report;
  assert.deepEqual(customReport.selection, {
    initialDate: '2026-08-04',
    initialBasis: 'final',
    finalDate: '2026-08-06',
    finalBasis: 'initial'
  });
  assert.equal(customReport.items[0].initialInventory, 12);
  assert.equal(customReport.items[0].movements['buy-compras'], 7);
  assert.equal(customReport.items[0].movements['uso-consumo-por-ventas'], 7);
  assert.equal(customReport.items[0].theoreticalFinal, 12);
  assert.equal(customReport.items[0].finalInventory, 9);
  assert.equal(customReport.items[0].difference, -3);
  assert.equal(customPayload.waste.report.dateFrom, '2026-08-04');
  assert.equal(customPayload.waste.report.dateTo, '2026-08-05');
  assert.equal(customPayload.waste.report.items[0].total, 7);
  assert.equal((await fetch(`${baseUrl}/api/inventory/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', dateFrom: '2026-08-04', dateTo: '2026-08-06' })
  })).status, 400);
});

test('processes marketing and employee consumption into product and recipe ingredient summaries', async t => {
  const baseUrl = await startTestServer(t);
  const recipeRows = [
    ['Id Producto', 'Nombre Producto*', 'Id Ingrediente', 'Nombre Ingrediente*', 'Cantidad Ingrediente', 'Unidad Medida', 'Tasa Rendimiento'],
    ['P1', 'Producto Uno', 'I1', 'Ingrediente Uno', '0,5', 'kg', 80],
    ['P2', 'Producto Dos', 'I1', 'Ingrediente Uno', 1000, 'g', 100]
  ];
  const recipeUpload = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{ field: 'master-recipes', contents: recipeRows.map(row => row.join('\t')).join('\n'), filename: 'recetas.txt' }], {
      'master-recipes-from': '2026-08-01'
    })
  });
  assert.equal(recipeUpload.status, 200);
  const catalogWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalogWorkbook, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce', 'ub'],
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base'],
    ['P1', 'Producto Uno', 8, 'UN'],
    ['P2', 'Producto Dos', 16, 'UN']
  ]), 'Prod');
  XLSX.utils.book_append_sheet(catalogWorkbook, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce', 'ub'],
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base'],
    ['I1', 'Ingrediente Uno', 4, 'kg']
  ]), 'Ingr');
  const catalogUpload = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{
      field: 'master-catalog',
      contents: XLSX.write(catalogWorkbook, { type: 'buffer', bookType: 'xlsx' }),
      filename: 'catalogo.xlsx'
    }], { 'master-catalog-from': '2026-08-01' })
  });
  assert.equal(catalogUpload.status, 200);

  const consumptionWorkbook = (currentSheetName, currentRows) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['pl', 'np', 'pn', 'ce', '2026-06-01'],
      ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', null],
      ['P1', 'Producto Uno', 100, 10, 99]
    ]), 'Prod');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(currentRows), currentSheetName);
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  };
  const marketingRows = [
    ['pl', 'np', 'pn', 'ce', '2026-08-04', '2026-08-05'],
    ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', null, null],
    ['P1', 'Producto Uno', 100, 10, 1, 2],
    ['P2', 'Producto Dos', 200, 20, 0, 1]
  ];
  const employeeRows = [
    ['pl', 'np', 'pn', 'ce', '2026-08-04', '2026-08-05'],
    ['ID Producto **', 'Nombre Producto *', 'Precio Base', 'Costo', null, null],
    ['P1', 'Producto Uno', 100, 10, '2 (con modificación)', 0]
  ];
  const kardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '2026-08-05', '', '2026-08-06', ''],
    ['', '', '', 'II - Inventario Inicial', 'IF - Inventario Final', 'II - Inventario Inicial', 'IF - Inventario Final', 'II - Inventario Inicial', 'IF - Inventario Final'],
    ['I1', 'Ingrediente Uno', 'kg', 20, 19, 19, 17, 17, 17]
  ].map(row => row.join('\t')).join('\n');
  const inspection = await inspect(baseUrl, 'store-1', '2026-08-03', [
    { field: 'kardex', contents: kardex, filename: 'kardex.csv' },
    { field: 'marketing', contents: consumptionWorkbook('Productos Agosto', marketingRows), filename: 'marketing.xlsx' },
    { field: 'employees', contents: consumptionWorkbook('Bebidas Equipo Agosto', employeeRows), filename: 'colaboradores.xlsx' }
  ]).then(response => response.json());
  assert.equal((await confirm(baseUrl, inspection, { from: '2026-08-04', to: '2026-08-06' })).status, 200);

  const response = await fetch(`${baseUrl}/api/inventory/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', dateFrom: '2026-08-04', dateTo: '2026-08-05' })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.consumption.marketing.products.sheetName, 'Productos Agosto');
  assert.equal(data.consumption.marketing.products.products.length, 2);
  assert.equal(data.consumption.marketing.products.totalQuantity, 4);
  assert.equal(data.consumption.marketing.products.totalCost, 40);
  assert.deepEqual(data.consumption.marketing.products.productsWithoutMasterCost, []);
  assert.equal(data.consumption.marketing.ingredients.items[0].quantity, 2.875);
  assert.equal(data.consumption.marketing.ingredients.totalCost, 11.5);
  assert.equal(data.consumption.employees.products.sheetName, 'Bebidas Equipo Agosto');
  assert.equal(data.consumption.employees.products.totalQuantity, 2);
  assert.equal(data.consumption.employees.products.totalCost, 16);
  assert.equal(data.consumption.employees.ingredients.items[0].quantity, 1.25);
  assert.equal(data.consumption.employees.ingredients.totalCost, 5);
  assert.equal(data.report.items[0].employeeConsumption, 1.25);
  assert.equal(data.report.items[0].marketingConsumption, 2.875);
  assert.equal(data.report.items[0].baseTheoreticalFinal, 17);
  assert.equal(data.report.items[0].theoreticalFinal, 12.875);
  assert.equal(data.report.items[0].difference, 4.125);
  assert.equal('adjustedDifference' in data.report.items[0], false);
  assert.equal(data.report.items[0].unitCost, 4);
  assert.equal(data.report.items[0].totalCost, 16.5);
  assert.equal(data.report.totalCost, 16.5);

  const marketingSummaryResponse = await fetch(`${baseUrl}/api/inventory/consumption-summary?location=store-1&field=marketing&dateFrom=2026-08-04&dateTo=2026-08-05`);
  assert.equal(marketingSummaryResponse.status, 200);
  const marketingSummary = await marketingSummaryResponse.json();
  assert.equal(marketingSummary.summary.products.totalQuantity, 4);
  assert.equal(marketingSummary.summary.products.totalCost, 40);
  assert.equal(marketingSummary.summary.ingredients.totalCost, 11.5);
});

test('creates, renames, trashes, and restores locations with their weekly data', async t => {
  const baseUrl = await startTestServer(t);
  const createdResponse = await fetch(`${baseUrl}/api/config/locations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Brewit Norte', type: 'store' })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const renamedResponse = await fetch(`${baseUrl}/api/config/locations/${encodeURIComponent(created.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Brewit Norte Centro' })
  });
  assert.equal(renamedResponse.status, 200);

  const inspection = await inspect(baseUrl, created.id, '2026-08-03', [{
    field: 'sales', contents: 'Fecha\n2026-08-09', filename: 'norte-sales.csv'
  }]).then(response => response.json());
  const saved = await confirm(baseUrl, inspection).then(response => response.json());
  const fileUrl = saved.meta.files.sales.url;
  assert.equal(saved.meta.locationLabel, 'Brewit Norte Centro');
  assert.equal((await fetch(`${baseUrl}${fileUrl}`)).status, 200);

  const firstWarningOnly = await fetch(`${baseUrl}/api/config/locations/${encodeURIComponent(created.id)}/trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationStage: 1, confirmationText: 'Brewit Norte Centro' })
  });
  assert.equal(firstWarningOnly.status, 400);

  const trashResponse = await fetch(`${baseUrl}/api/config/locations/${encodeURIComponent(created.id)}/trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationStage: 2, confirmationText: 'Brewit Norte Centro' })
  });
  assert.equal(trashResponse.status, 200);
  assert.equal((await fetch(`${baseUrl}${fileUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/uploads/trash/locations/${created.id}/2026-08-03/meta.json`)).status, 404);

  const whileTrashed = await fetch(`${baseUrl}/api/config/locations`).then(response => response.json());
  assert.equal(whileTrashed.active.some(location => location.id === created.id), false);
  assert.equal(whileTrashed.trash.some(location => location.id === created.id), true);

  const restoreResponse = await fetch(`${baseUrl}/api/config/locations/${encodeURIComponent(created.id)}/restore`, { method: 'POST' });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await fetch(`${baseUrl}${fileUrl}`)).status, 200);
  const afterRestore = await fetch(`${baseUrl}/api/config/locations`).then(response => response.json());
  assert.equal(afterRestore.active.find(location => location.id === created.id).name, 'Brewit Norte Centro');
});

test('detects file dates and requires confirmation before weekly persistence', async t => {
  const baseUrl = await startTestServer(t);
  const response = await inspect(baseUrl, 'store-1', '2026-08-03', [{
    field: 'sales',
    contents: 'Fecha de creacion\tTotal\n2026-08-04\t1000\n2026-08-09\t2000',
    filename: 'ventas.csv'
  }]);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.deepEqual(manifest.detectedRange, { from: '2026-08-04', to: '2026-08-09' });

  const beforeConfirmation = await fetch(`${baseUrl}/api/weeks/2026-08-03?location=store-1`);
  assert.equal(beforeConfirmation.status, 404);
  assert.equal((await confirm(baseUrl, manifest, manifest.detectedRange, false)).status, 400);
  assert.equal((await confirm(baseUrl, manifest)).status, 200);

  const saved = await fetch(`${baseUrl}/api/weeks/2026-08-03?location=store-1`).then(response => response.json());
  assert.deepEqual(saved.confirmedRange, { from: '2026-08-04', to: '2026-08-09' });
  assert.equal(saved.files.sales.originalName, 'ventas.csv');
});

test('reads date ranges from XLSX workbook cells', async t => {
  const baseUrl = await startTestServer(t);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Código', '03-08-2026', '09-08-2026'],
    ['ABC', 4, 2]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Kardex');
  const contents = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const response = await inspect(baseUrl, 'main-warehouse', '2026-08-03', [{
    field: 'kardex', contents, filename: 'kardex.xlsx'
  }]);

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).detectedRange, { from: '2026-08-03', to: '2026-08-09' });
});

test('main warehouse rejects store-only transaction categories', async t => {
  const baseUrl = await startTestServer(t);
  const response = await inspect(baseUrl, 'main-warehouse', '2026-08-03', [{
    field: 'sales', contents: 'Fecha\n2026-08-09', filename: 'sales.csv'
  }]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not accept sales/);
});

test('merges confirmed categories and retains incremental sales files until deletion', async t => {
  const baseUrl = await startTestServer(t);
  const salesInspection = await inspect(baseUrl, 'store-2', '2026-08-03', [{
    field: 'sales', contents: 'Fecha\n2026-08-08', filename: 'sales.csv'
  }]).then(response => response.json());
  const firstSave = await confirm(baseUrl, salesInspection).then(response => response.json());
  const firstSales = firstSave.meta.files.sales;

  const purchaseInspection = await inspect(baseUrl, 'store-2', '2026-08-03', [{
    field: 'purchases', contents: 'Fecha emisión\n2026-08-07', filename: 'purchases.xls'
  }]).then(response => response.json());
  assert.equal((await confirm(baseUrl, purchaseInspection)).status, 200);
  let saved = await fetch(`${baseUrl}/api/weeks/2026-08-03?location=store-2`).then(response => response.json());
  assert.equal(saved.files.sales.originalName, 'sales.csv');
  assert.equal(saved.files.purchases.originalName, 'purchases.xls');

  const replacementInspection = await inspect(baseUrl, 'store-2', '2026-08-03', [{
    field: 'sales', contents: 'Fecha\n2026-08-09', filename: 'sales-new.csv'
  }]).then(response => response.json());
  const replacement = await confirm(baseUrl, replacementInspection).then(response => response.json());
  assert.equal((await fetch(`${baseUrl}${firstSales.url}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}${replacement.meta.files.sales.url}`)).status, 200);
  assert.equal(replacement.meta.files.sales.parts.length, 2);

  const preview = await fetch(`${baseUrl}/api/weeks/2026-08-03/store-2/sales/preview`);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).originalName, 'sales-new.csv');
  const deletion = await fetch(`${baseUrl}/api/weeks/2026-08-03/store-2/sales`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  assert.equal((await fetch(`${baseUrl}${firstSales.url}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${replacement.meta.files.sales.url}`)).status, 404);
  saved = await fetch(`${baseUrl}/api/weeks/2026-08-03?location=store-2`).then(response => response.json());
  assert.equal(Object.hasOwn(saved.files, 'sales'), false);
  assert.equal(saved.files.purchases.originalName, 'purchases.xls');
});

test('stores only new sales transactions and reports the latest transaction date and time', async t => {
  const baseUrl = await startTestServer(t);
  const header = ['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos', 'Producto'];
  const firstRows = [
    header,
    ['order-1', '2026-08-08', '13:20:00', 119, 0, 'Café'],
    ['order-1', '2026-08-08', '13:20:00', 119, 0, 'Extra'],
    ['order-2', '2026-08-08', '14:05:30', 238, 0, 'Té']
  ];
  const firstInspection = await inspect(baseUrl, 'store-1', '2026-08-03', [{
    field: 'sales', contents: firstRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-1.csv'
  }]).then(response => response.json());
  const first = await confirm(baseUrl, firstInspection).then(response => response.json());
  assert.equal(first.salesImport.newTransactions, 2);
  assert.equal(first.salesImport.newRows, 3);

  const secondRows = [
    header,
    ['order-1', '2026-08-08', '13:20:00', 119, 0, 'Café'],
    ['order-1', '2026-08-08', '13:20:00', 119, 0, 'Extra'],
    ['order-2', '2026-08-08', '14:05:30', 238, 0, 'Té'],
    ['order-3', '2026-08-09', '09:45:12', 357, 0, 'Chocolate'],
    ['order-3', '2026-08-09', '09:45:12', 357, 0, 'Extra']
  ];
  const secondInspection = await inspect(baseUrl, 'store-1', '2026-08-03', [{
    field: 'sales', contents: secondRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-2.csv'
  }]).then(response => response.json());
  const second = await confirm(baseUrl, secondInspection).then(response => response.json());
  assert.deepEqual(second.salesImport, {
    uploadedRows: 5,
    newRows: 2,
    newTransactions: 1,
    duplicateTransactions: 2,
    latestTransactionAt: '2026-08-09T09:45:12'
  });

  const newestPart = second.meta.files.sales.parts.at(-1);
  const storedWorkbook = XLSX.read(await fetch(`${baseUrl}${newestPart.url}`).then(response => response.arrayBuffer()), { type: 'array' });
  const storedRows = XLSX.utils.sheet_to_json(storedWorkbook.Sheets[storedWorkbook.SheetNames[0]], { defval: null });
  assert.deepEqual([...new Set(storedRows.map(row => row['ID de orden']))], ['order-3']);

  const latest = await fetch(`${baseUrl}/api/sales/latest?location=store-1`).then(response => response.json());
  assert.equal(latest.latestTransactionAt, '2026-08-09T09:45:12');
  assert.equal(latest.transactionCount, 3);

  const duplicateInspection = await inspect(baseUrl, 'store-1', '2026-08-10', [{
    field: 'sales', contents: secondRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-repetidas.csv'
  }]).then(response => response.json());
  const duplicate = await confirm(baseUrl, duplicateInspection).then(response => response.json());
  assert.equal(duplicate.salesImport.newTransactions, 0);
  assert.equal(duplicate.meta.files.sales, undefined);
});

test('stores transactions without a week and confirms whether overlapping dates are kept or replaced', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-06' });
  const header = ['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos'];
  const firstRows = [header, ['order-1', '2026-08-04', '10:00:00', 119, 0]];
  const firstInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'sales', contents: firstRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-iniciales.csv'
  }]).then(response => response.json());
  assert.equal(firstInspection.hasOverlap, false);
  assert.equal((await confirmTransactions(baseUrl, firstInspection)).status, 200);

  const keepRows = [
    header,
    ['order-1', '2026-08-04', '10:00:00', 119, 0],
    ['order-2', '2026-08-05', '11:00:00', 238, 0]
  ];
  const keepInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'sales', contents: keepRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-acumuladas.csv'
  }]).then(response => response.json());
  assert.equal(keepInspection.hasOverlap, true);
  assert.deepEqual(keepInspection.files[0].overlapRange, { from: '2026-08-04', to: '2026-08-04' });
  const kept = await confirmTransactions(baseUrl, keepInspection, 'keep').then(response => response.json());
  assert.equal(kept.imports.sales.newTransactions, 1);
  assert.equal(kept.imports.sales.duplicateTransactions, 1);

  const replacementRows = [header, ['order-1-revised', '2026-08-04', '10:00:00', 238, 0]];
  const replaceInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'sales', contents: replacementRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-corregidas.csv'
  }]).then(response => response.json());
  assert.equal(replaceInspection.hasOverlap, true);
  assert.equal((await confirmTransactions(baseUrl, replaceInspection, 'replace')).status, 200);

  const report = await fetch(`${baseUrl}/api/reports/weekly-sales?location=store-1`).then(response => response.json());
  assert.equal(report.month.netSales, 400);
  const latest = await fetch(`${baseUrl}/api/sales/latest?location=store-1`).then(response => response.json());
  assert.equal(latest.transactionCount, 2);
  const stored = await fetch(`${baseUrl}/api/transactions?location=store-1`).then(response => response.json());
  assert.equal(stored.files.sales.fileCount, 3);
  assert.equal(stored.files.sales.uploads.length, 3);
  assert.equal(stored.files.sales.uploads[0].originalName, 'ventas-corregidas.csv');
  assert.deepEqual(stored.files.sales.dataRange, { from: '2026-08-04', to: '2026-08-05' });

  const unconfirmedRemoval = await fetch(`${baseUrl}/api/transactions/store-1/sales/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'last', confirmed: true, confirmationText: 'NO' })
  });
  assert.equal(unconfirmedRemoval.status, 400);
  const reverted = await fetch(`${baseUrl}/api/transactions/store-1/sales/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'last', confirmed: true, confirmationText: 'ELIMINAR' })
  }).then(response => response.json());
  assert.equal(reverted.deletedCount, 1);
  assert.equal(reverted.remainingCount, 2);
  const restoredReport = await fetch(`${baseUrl}/api/reports/weekly-sales?location=store-1`).then(response => response.json());
  assert.equal(restoredReport.month.netSales, 300);
  const removedAll = await fetch(`${baseUrl}/api/transactions/store-1/sales/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'all', confirmed: true, confirmationText: 'ELIMINAR' })
  }).then(response => response.json());
  assert.equal(removedAll.deletedCount, 2);
  assert.equal(removedAll.remainingCount, 0);
  const empty = await fetch(`${baseUrl}/api/transactions?location=store-1`).then(response => response.json());
  assert.equal(empty.files.sales.fileCount, 0);
});

test('accepts MercadoPago files without a structural reference and avoids duplicate rows', async t => {
  const baseUrl = await startTestServer(t);
  const header = ['Fecha operación', 'Referencia MP', 'Monto acreditado'];
  const firstRows = [
    header,
    ['2026-08-04', 'mp-1', 1000],
    ['2026-08-05', 'mp-2', 2000]
  ];
  const firstInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'mercadopago', contents: firstRows.map(row => row.join('\t')).join('\n'), filename: 'mercadopago-original.csv'
  }]).then(response => response.json());
  assert.equal(firstInspection.files[0].structure.ok, true);
  assert.equal(firstInspection.files[0].structure.permissive, true);
  assert.match(firstInspection.files[0].structure.reason, /sin validación estructural/i);
  const firstImport = await confirmTransactions(baseUrl, firstInspection).then(response => response.json());
  assert.equal(firstImport.imports.mercadopago.newTransactions, 2);

  const nextRows = [
    header,
    ['2026-08-05', 'mp-2', 2000],
    ['2026-08-06', 'mp-3', 3000]
  ];
  const nextInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'mercadopago', contents: nextRows.map(row => row.join('\t')).join('\n'), filename: 'mercadopago-acumulado.csv'
  }]).then(response => response.json());
  assert.equal(nextInspection.hasOverlap, true);
  const nextImport = await confirmTransactions(baseUrl, nextInspection, 'keep').then(response => response.json());
  assert.equal(nextImport.imports.mercadopago.newTransactions, 1);
  assert.equal(nextImport.imports.mercadopago.duplicateTransactions, 1);

  const stored = await fetch(`${baseUrl}/api/transactions?location=store-1`).then(response => response.json());
  assert.equal(stored.files.mercadopago.fileCount, 2);
  assert.deepEqual(stored.files.mercadopago.dataRange, { from: '2026-08-04', to: '2026-08-06' });
  const preview = await fetch(`${baseUrl}${stored.files.mercadopago.latest.previewUrl}`).then(response => response.json());
  assert.equal(preview.sheets[0].rows.length, 2);
  assert.match(preview.sheets[0].rows[1].join(' '), /mp-3/);

  const replacementRows = [header, ['2026-08-06', 'mp-3-corregida', 3500]];
  const replacementInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'mercadopago', contents: replacementRows.map(row => row.join('\t')).join('\n'), filename: 'mercadopago-corregido.csv'
  }]).then(response => response.json());
  assert.deepEqual(replacementInspection.files[0].overlapRange, { from: '2026-08-06', to: '2026-08-06' });
  const replacement = await confirmTransactions(baseUrl, replacementInspection, 'replace').then(response => response.json());
  assert.equal(replacement.imports.mercadopago.newTransactions, 1);
  const afterReplacement = await fetch(`${baseUrl}/api/transactions?location=store-1`).then(response => response.json());
  assert.equal(afterReplacement.files.mercadopago.latest.replacementEffects.length, 1);
  assert.deepEqual(afterReplacement.files.mercadopago.latest.replacementEffects[0].range, { from: '2026-08-06', to: '2026-08-06' });
});

test('builds the sales dashboard and identifies recurring MercadoPago customers by card key', async t => {
  const baseUrl = await startTestServer(t, { reportToday: '2026-08-15' });
  const salesHeader = ['ID de orden', 'Fecha de creacion', 'Pago total', 'Descuentos', 'ID Producto', 'Nombre', 'Cantidad', 'Precio a Pagar', 'Descuento', 'Costo', 'AB.', 'Categorías de Productos/Platos'];
  const salesRows = [
    salesHeader,
    ['order-prior', '2026-08-08', 119, 0, 'B1', 'Café', 1, 119, 0, 20, 'AB.1', 'Bebidas'],
    ['order-yesterday', '2026-08-14', 238, 0, 'B1', 'Café', 1, 238, 0, 50, 'AB.1', 'Bebidas'],
    ['order-today', '2026-08-15', 357, 0, 'B1', 'Café', 2, 357, 0, 100, 'AB.1', 'Bebidas']
  ];
  const salesInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'sales', contents: salesRows.map(row => row.join('\t')).join('\n'), filename: 'ventas-dashboard.csv'
  }]).then(response => response.json());
  assert.equal((await confirmTransactions(baseUrl, salesInspection)).status, 200);

  const mpHeader = ['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'CARD_INITIAL_NUMBER', 'LAST_FOUR_DIGITS'];
  const mpRows = [
    mpHeader,
    ['2026-08-01T10:00:00.000-04:00', 'mp-0', 'SETTLEMENT', 100, 12345678, 42],
    ['2026-08-08T10:00:00.000-04:00', 'mp-1', 'SETTLEMENT', 200, 12345678, 42],
    ['2026-08-15T10:00:00.000-04:00', 'mp-2', 'SETTLEMENT', 300, 12345678, 42],
    ['2026-08-15T11:00:00.000-04:00', 'mp-3', 'SETTLEMENT', 400, 87654321, 7]
  ];
  const mpInspection = await inspectTransactions(baseUrl, 'store-1', [{
    field: 'mercadopago', contents: mpRows.map(row => row.join('\t')).join('\n'), filename: 'mercadopago-dashboard.csv'
  }]).then(response => response.json());
  assert.equal((await confirmTransactions(baseUrl, mpInspection, 'keep', { from: '2026-08-01', to: '2026-08-15' })).status, 200);

  const dashboardResponse = await fetch(`${baseUrl}/api/sales/dashboard?location=store-1`);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.sales.metrics.day.netSales, 300);
  assert.equal(dashboard.sales.metrics.day.previous.netSales, 100);
  assert.equal(Math.round(dashboard.sales.metrics.day.changePercent), 200);
  assert.equal(dashboard.sales.locations[0].month, 600);
  assert.equal(dashboard.sales.productInsights.day.topProducts[0].quantity, 2);
  assert.equal(dashboard.sales.productInsights.day.hierarchies[0].name, 'Bebidas');
  assert.equal(dashboard.sales.productInsights.day.hierarchyTree.children[0].name, 'Bebidas');
  assert.equal(dashboard.sales.productInsights.day.hierarchyTree.children[0].products[0].name, 'Café');
  assert.equal(dashboard.sales.productInsights.day.hierarchyTree.children[0].products[0].quantity, 2);
  assert.equal(dashboard.sales.productInsights.day.hierarchyTree.children[0].products[0].totalCost, 100);
  assert.equal(Math.round(dashboard.sales.productInsights.day.hierarchyTree.children[0].products[0].contributionMarginPercent * 10) / 10, 66.7);
  assert.equal(dashboard.sales.productInsights.day.hierarchyTree.children[0].totalCost, 100);
  assert.equal(Math.round(dashboard.sales.productInsights.day.hierarchyTree.children[0].contributionMarginPercent * 10) / 10, 66.7);
  assert.equal(dashboard.mercadoPago.metrics.day.transactions, 2);
  assert.equal(dashboard.mercadoPago.metrics.day.sales, 700);
  assert.equal(dashboard.mercadoPago.metrics.day.recurringTransactions, 1);
  assert.equal(dashboard.mercadoPago.metrics.day.recurringSales, 300);
  assert.equal(dashboard.mercadoPago.metrics.day.recurringTransactionPercent, 50);
  assert.equal(dashboard.mercadoPago.customers.identified, 2);
  assert.equal(dashboard.mercadoPago.customers.recurrent, 1);
  assert.equal(dashboard.mercadoPago.customers.frequency.moreThanEvery15Days, 1);
  assert.equal(dashboard.mercadoPago.history.months.length, 6);
  assert.equal(dashboard.mercadoPago.history.weeks.length, 8);
  const currentMonth = dashboard.mercadoPago.history.months.at(-1);
  assert.deepEqual({ from: currentMonth.from, to: currentMonth.to }, { from: '2026-08-01', to: '2026-08-15' });
  assert.equal(currentMonth.totalSales, 1000);
  assert.equal(currentMonth.recurringSales, 500);
  assert.equal(currentMonth.recurringSalesPercent, 50);
  assert.equal(currentMonth.identifiedCards, 2);
  assert.equal(currentMonth.recurrentCustomers, 1);
  assert.equal(currentMonth.frequency.moreThanEvery15Days, 1);
  const currentWeek = dashboard.mercadoPago.history.weeks.at(-1);
  assert.deepEqual({ from: currentWeek.from, to: currentWeek.to }, { from: '2026-08-10', to: '2026-08-15' });
  assert.equal(currentWeek.totalSales, 700);
  assert.equal(currentWeek.recurringSales, 300);
  assert.equal(Math.round(currentWeek.recurringSalesPercent * 10) / 10, 42.9);
});

test('warns on duplicate master start dates and replaces only after confirmation', async t => {
  const baseUrl = await startTestServer(t);
  const oldCatalog = 'ID Producto **\tNombre Producto *\tCosto\nP1\tProducto anterior\t100';
  const newCatalog = 'ID Producto **\tNombre Producto *\tCosto\nP1\tProducto nuevo\t120';
  const first = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{ field: 'master-catalog', contents: oldCatalog, filename: 'catalog-old.xlsx' }], {
      'master-catalog-from': '2026-08-09'
    })
  });
  assert.equal(first.status, 200);
  const oldRecord = (await first.json()).saved['master-catalog'];

  const duplicateForm = () => fileForm([{
    field: 'master-catalog', contents: newCatalog, filename: 'catalog-new.xlsx'
  }], { 'master-catalog-from': '2026-08-09' });
  const conflict = await fetch(`${baseUrl}/upload/master`, { method: 'POST', body: duplicateForm() });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.code, 'MASTER_DATE_CONFLICT');
  assert.equal(conflictBody.conflicts[0].existingOriginalName, 'catalog-old.xlsx');
  assert.equal((await fetch(`${baseUrl}${oldRecord.url}`)).status, 200);

  const replacement = await fetch(`${baseUrl}/upload/master?replace=true`, { method: 'POST', body: duplicateForm() });
  assert.equal(replacement.status, 200);
  const newRecord = (await replacement.json()).saved['master-catalog'];
  assert.equal((await fetch(`${baseUrl}${oldRecord.url}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${newRecord.url}`)).status, 200);

  const versions = await fetch(`${baseUrl}/api/masters`).then(result => result.json());
  const catalogs = Object.values(versions).flatMap(group => group['master-catalog'] ? [group['master-catalog']] : []);
  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].originalName, 'catalog-new.xlsx');

  const replacementVersion = Object.entries(versions).find(([, group]) => group['master-catalog'])?.[0];
  const preview = await fetch(`${baseUrl}/api/masters/${encodeURIComponent(replacementVersion)}/master-catalog/preview`);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.originalName, 'catalog-new.xlsx');
  assert.equal(previewBody.sheets[0].rows[0][0], 'ID Producto **');

  const deletion = await fetch(`${baseUrl}/api/masters/${encodeURIComponent(replacementVersion)}/master-catalog`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  assert.equal((await fetch(`${baseUrl}${newRecord.url}`)).status, 404);
  assert.deepEqual(await fetch(`${baseUrl}/api/masters`).then(result => result.json()), {});

  const supplier = await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{ field: 'master-suppliers', contents: 'Nombre*\tRUT/Fiscal ID*\nProveedor\t111', filename: 'suppliers.xlsx' }], {
      'master-suppliers-from': '2026-08-09'
    })
  });
  assert.equal(supplier.status, 200);
  assert.equal((await supplier.json()).saved['master-suppliers'].originalName, 'suppliers.xlsx');
});

test('limits spreadsheet previews to 200 rows and 300 columns', async t => {
  const baseUrl = await startTestServer(t);
  const workbook = XLSX.utils.book_new();
  const matrix = Array.from({ length: 205 }, (_, row) =>
    Array.from({ length: 305 }, (_, column) => `R${row + 1}C${column + 1}`));
  matrix[0][0] = 'pl';
  matrix[0][1] = 'np';
  matrix[0][2] = 'ce';
  matrix[1][0] = 'ID Producto **';
  matrix[1][1] = 'Nombre Producto *';
  matrix[1][2] = 'Costo';
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'Amplia');
  const contents = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await fetch(`${baseUrl}/upload/master`, {
    method: 'POST',
    body: fileForm([{ field: 'master-catalog', contents, filename: 'amplia.xlsx' }], {
      'master-catalog-from': '2026-08-14'
    })
  });
  const versions = await fetch(`${baseUrl}/api/masters`).then(response => response.json());
  const version = Object.keys(versions)[0];
  const preview = await fetch(`${baseUrl}/api/masters/${encodeURIComponent(version)}/master-catalog/preview`)
    .then(response => response.json());
  assert.equal(preview.sheets[0].rows.length, 200);
  assert.equal(preview.sheets[0].rows[0].length, 300);
  assert.equal(preview.sheets[0].rows[0].at(-1), 'R1C300');
  assert.equal(preview.sheets[0].totalRows, 205);
  assert.equal(preview.sheets[0].truncated, true);
});
