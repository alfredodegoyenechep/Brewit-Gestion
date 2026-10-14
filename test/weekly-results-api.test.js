const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');
const { advance } = require('../inventory-boundaries');

function workbook(file, rows, sheet = 'Datos') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  XLSX.writeFile(book, file);
}
async function fixture(t, sourceMode = 'legacy') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-results-'));
  const app = createApp({ uploadsRoot: root, sourceMode, enableLegacyTools: true, reportToday: '2026-10-13' });
  fs.writeFileSync(path.join(root, 'config', 'locations.json'), JSON.stringify({ locations: [
    { id: 'store-1', name: 'La Concepción', type: 'store', status: 'active' },
    { id: 'store-2', name: 'Lyon', type: 'store', status: 'active' },
    { id: 'store-3', name: 'Nueva cafetería', type: 'store', status: 'active' },
    { id: 'closed', name: 'Eliminada', type: 'store', status: 'trashed' },
    { id: 'main-warehouse', name: 'Casa Matriz', type: 'warehouse', status: 'active' }
  ] }));
  const masters = path.join(root, 'masters');
  workbook(path.join(masters, 'catalog.xlsx'), [
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'],
    ['A', 'Producto A', 1, 10, 'UN'], ['PAC014', 'Consumible', 1, 20, 'UN']
  ], 'Ingr');
  fs.writeFileSync(path.join(masters, 'masters.json'), JSON.stringify({ v1: {
    'master-catalog': { name: 'catalog.xlsx', originalName: 'catalog.xlsx', validFrom: '2026-09-01', source: 'toteat-shared-api' }
  } }));
  const range = { from: '2026-09-01', to: '2026-10-15' };
  const dates = [];
  for (let date = '2026-09-21'; date <= range.to; date = advance(date, 1)) dates.push(date);
  function consumption(id, field, factor) {
    const directory = path.join(root, 'transactions', id); fs.mkdirSync(directory, { recursive: true });
    const indexPath = path.join(directory, 'index.json');
    const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath)) : { fields: {}, exclusions: {} };
    const book = XLSX.utils.book_new();
    for (const month of ['09', '10']) {
      const selected = dates.filter(date => date.slice(5, 7) === month);
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['pl', 'np', 'ce', ...selected.map(date => new Date(`${date}T12:00:00Z`))],
        ['ID Producto **', 'Nombre Producto *', 'Costo'],
        ['A', 'Producto A', 999, ...selected.map(date => (date === '2026-10-04' || date === '2026-10-14' ? 100
          : date === '2026-10-12' ? 2 : date === '2026-10-13' ? 3 : 1) * factor)]
      ]), month);
    }
    XLSX.writeFile(book, path.join(directory, `${field}.xlsx`));
    index.fields[field] = { files: [{ id: field, name: `${field}.xlsx`, confirmedRange: { from: dates[0], to: dates.at(-1) } }] };
    if (field === 'marketing') {
      workbook(path.join(directory, 'replacement.xlsx'), [
        ['pl', 'np', 'ce', new Date('2026-10-06T12:00:00Z')], ['ID Producto **', 'Nombre Producto *', 'Costo'], ['A', 'Producto A', 999, 4]
      ]);
      index.fields[field].files.push({ id: 'replacement', name: 'replacement.xlsx', savedAt: '2026-10-13', confirmedRange: { from: '2026-10-06', to: '2026-10-06' } });
      index.exclusions.marketing = [{ from: '2026-10-06', to: '2026-10-06' }];
    }
    fs.writeFileSync(indexPath, JSON.stringify(index));
  }
  consumption('store-1', 'marketing', 1); consumption('store-1', 'employees', 3);
  // The other branch has dated consumption but no sales or payable source.
  consumption('store-3', 'marketing', 1);
  const transactionDirectory = path.join(root, 'transactions', 'store-1');
  workbook(path.join(transactionDirectory, 'waste.xlsx'), [
    ['Código', 'Nombre', 'Unidad', ...dates.flatMap(date => [date, '', '', ''])],
    ['', '', '', ...dates.flatMap(() => ['II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final'])],
    ['A', 'Producto A', 'UN', ...dates.flatMap(date => [0, 0, date === '2026-10-04' ? 100 : 1, 0])]
  ]);
  workbook(path.join(transactionDirectory, 'mp.xlsx'), [
    ['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'REAL_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'card', 'SETTLEMENT', 1100, 980],
    ['2026-10-05T12:00:00-03:00', 'card', 'SETTLEMENT', 1100, 980],
    ['2026-10-14T12:00:00-03:00', 'future', 'SETTLEMENT', 100000, 99000]
  ]);
  const indexPath = path.join(transactionDirectory, 'index.json'), index = JSON.parse(fs.readFileSync(indexPath));
  for (const [field, name] of [['waste', 'waste.xlsx'], ['mercadopago', 'mp.xlsx']]) index.fields[field] = { files: [{ id: field, name, confirmedRange: { from: dates[0], to: dates.at(-1) } }] };
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const salesFile = path.join(root, 'sales.xlsx');
  const salesHeader = ['ID de orden', 'Fecha de creacion', 'Pago total', 'Descuentos', 'ID Producto', 'Nombre', 'Cantidad', 'Precio a Pagar', 'Descuento'];
  const line = ['order', '2026-10-05', 2380, -1190, 'A', 'Producto A', 1, 595, -595];
  workbook(salesFile, [salesHeader, line, line, ['order', '2026-10-05', '', '', 'A', 'Producto A', 1, 595, -595],
    ['current', '2026-10-13', 119, 0, 'A', 'Producto A', 1, 119, 0],
    ['future', '2026-10-14', 119000, 0, 'A', 'Producto A', 1, 119000, 0]]);
  app.locals.toteatSalesSync.source = (id, field) => id === 'store-1' && field === 'sales'
    ? [{ filePath: salesFile, excludedRanges: [], record: { originalName: 'sales.xlsx', confirmedRange: range } }] : [];
  const payments = [
    { paymentId: 'card', dateClosed: '2026-10-05T12:00:00', change: 0, paymentForms: [{ id: 5008, amount: 1100, tip: 100 }] },
    { paymentId: 'cash', dateClosed: '2026-10-05T13:00:00', change: 300, paymentForms: [{ id: 1000, amount: 500, tip: 10 }] },
    { paymentId: 'future', dateClosed: '2026-10-14T12:00:00', change: 0, paymentForms: [{ id: 5008, amount: 100000, tip: 90000 }] }
  ];
  app.locals.toteatSalesSync.get = id => id === 'store-1' ? { from: range.from, through: range.to, payments: [...payments, payments[0]] } : null;
  const counts = { 'store-1': ['2026-10-04', '2026-10-11'], 'store-2': ['2026-09-01', '2026-10-07', '2026-10-10'], 'store-3': ['2026-10-11'] };
  function stock(id) {
    const daily = [];
    for (let date = range.from, day = 0; date <= range.to; date = advance(date, 1), day++) for (const code of ['A', 'PAC014']) {
      daily.push({ date, warehouse: 'oper', code, name: code, unit: 'UN', opening: 100 - day, closing: 99 - day,
        physicalCount: counts[id]?.includes(date), use: 0 });
      daily.push({ date, warehouse: 'waste', code, name: code, unit: 'UN', opening: 0, closing: 0, physicalCount: false,
        transfer_warehouse_in: code === 'A' ? (date === '2026-10-04' ? 100 : 1) : 0 });
    }
    return { range, daily, warehouses: [{ id: 'oper', custom_id: 2 }, { id: 'waste', custom_id: 3 }],
      masterObservedAt: '2026-10-13T00:00:00Z', sourceKind: 'native-documents', includedOrders: [], issues: [], assumptions: [] };
  }
  app.locals.toteatStockSync.rebuild = stock;
  app.locals.toteatStockSync.current = stock;
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, counts, base: `http://127.0.0.1:${server.address().port}` };
}
async function getReport(base, options = {}) {
  const response = await fetch(`${base}/api/weekly-results?${new URLSearchParams(options)}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function getDaily(base, query = {}) {
  const response = await fetch(`${base}/api/weekly-results/daily/stream?${new URLSearchParams({ from: '2026-10-05', date: '2026-10-13', location: 'store-1', ...query })}`);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-2).completed, 7);
  assert.equal(events.at(-1).type, 'result');
  return events.at(-1).data;
}

test('daily endpoint matches calendar weekly amounts, handles replacements and never processes inventory', async t => {
  const { base, app, root } = await fixture(t);
  workbook(path.join(root, 'transactions', 'store-1', 'mp.xlsx'), [
    ['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'FEE_AMOUNT', 'REAL_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'card', 'SETTLEMENT', 1100, 120, 980],
    ['2026-10-05T12:00:00-03:00', 'card', 'SETTLEMENT', 1100, 120, 980]
  ]);
  const weekly = (await getReport(base)).weeks[1].locations[0];
  let rebuilds = 0;
  app.locals.toteatStockSync.rebuild = () => { rebuilds++; throw Error('No daily inventory processing'); };
  const daily = await getDaily(base);
  assert.deepEqual(daily.days.map(day => day.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  for (const key of ['grossSales', 'discounts', 'grossSalesAfterDiscounts', 'netSales', 'margin', 'tips', 'cashTips', 'mercadoPagoTips', 'mercadoPagoFee', 'cashCollection', 'mercadoPagoCollection', 'mercadoPagoTheoretical', 'collectionDifference', 'marketing', 'employees', 'waste']) {
    assert.ok(daily.days.every(day => day.values[key].available), key);
    const sum = daily.days.reduce((total, day) => total + day.values[key].amount, 0);
    assert.ok(Math.abs(sum - weekly.values[key].amount) < 1e-8, key);
  }
  assert.equal(daily.days[0].values.netSales.percent, 100);
  assert.equal(daily.days[1].values.netSales.amount, 0);
  assert.equal(daily.days[1].values.netSales.percent, null);
  assert.equal(daily.days[1].values.marketing.amount, -40);
  for (const day of daily.days) for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
    assert.equal(day.values[key].status, 'weekly-only');
    assert.equal(day.values[key].amount, null);
  }
  const current = await getDaily(base, { from: '2026-10-12' });
  assert.equal(current.days[1].values.netSales.amount, 100);
  assert.equal(current.days[2].values.netSales.status, 'future');
  assert.equal(current.days[2].values.marketing.amount, null);
  const noSales = await getDaily(base, { location: 'store-3' });
  assert.equal(noSales.days[0].values.netSales.amount, null);
  assert.equal(noSales.days[0].values.marketing.amount, -10);
  assert.equal(rebuilds, 0);
});

test('daily endpoint rejects invalid periods, dates and non-cafeteria locations', async t => {
  const { base } = await fixture(t);
  for (const query of [{ from: '2026-10-06' }, { date: '2026-10-14' }, { date: 'invalid' }, { location: 'main-warehouse' }, { location: 'closed' }]) {
    const response = await fetch(`${base}/api/weekly-results/daily/stream?${new URLSearchParams({ from: '2026-10-05', location: 'store-1', ...query })}`);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
});

test('daily valuation uses the weekly closing cost even when the catalog changes during the week', async t => {
  const { base, root } = await fixture(t);
  workbook(path.join(root, 'masters', 'catalog-late.xlsx'), [
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'],
    ['A', 'Producto A', 1, 50, 'UN'], ['PAC014', 'Consumible', 1, 20, 'UN']
  ], 'Ingr');
  const indexPath = path.join(root, 'masters', 'masters.json'), index = JSON.parse(fs.readFileSync(indexPath));
  index.v2 = { 'master-catalog': { name: 'catalog-late.xlsx', originalName: 'catalog-late.xlsx', validFrom: '2026-10-10', source: 'toteat-shared-api' } };
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const weekly = (await getReport(base)).weeks[1].locations[0];
  const daily = await getDaily(base);
  assert.equal(daily.days[0].sources.margin.costCutoff, '2026-10-11');
  assert.equal(daily.days[0].values.margin.amount, 900);
  assert.equal(weekly.values.margin.amount, 900);
  assert.equal(daily.days[0].values.marketing.amount, -50);
  assert.equal(daily.days.reduce((sum, day) => sum + day.values.marketing.amount, 0), weekly.values.marketing.amount);
  const response = await fetch(`${base}/api/financial-results?location=store-1&dateFrom=2026-10-05&dateTo=2026-10-05`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revenue.total.contributionMargin, 980);
});

test('weekly API distinguishes calendar consumption from count intervals, matches Kardex and preserves old report', async t => {
  const { base } = await fixture(t);
  const data = await getReport(base);
  assert.deepEqual(data.locations.map(location => location.id), ['store-1', 'store-2', 'store-3']);
  assert.equal(data.weeks.length, 4);
  const week = data.weeks[1].locations[0], values = week.values;
  assert.equal(values.netSales.amount, 1000);
  assert.equal(values.discounts.amount, 1190);
  assert.equal(values.discounts.percent, 119);
  assert.equal(values.salesWithoutVat, undefined);
  assert.equal(values.grossSalesAfterDiscounts.amount, 1190);
  assert.equal(values.grossSales.amount, 2380);
  assert.equal(values.margin.amount, 980);
  assert.equal(values.tips.amount, 110);
  assert.equal(values.mercadoPagoTips.amount, 100);
  assert.equal(values.cashTips.amount, 10);
  assert.equal(values.cashCollection.amount, 200);
  assert.equal(values.mercadoPagoTheoretical.amount, null);
  assert.equal(values.mercadoPagoTheoretical.status, 'incomplete');
  assert.equal(values.mercadoPagoTheoretical.percent, null);
  assert.equal(values.mercadoPagoCollection.amount, 980);
  assert.equal(values.mercadoPagoFee.amount, null);
  assert.equal(values.collectionDifference.amount, null);
  assert.equal(values.collectionDifference.status, 'incomplete');
  assert.equal(values.collectionDifference.percent, null);
  assert.equal(values.grossSales.amount - values.discounts.amount, values.netSales.amount * 1.19);
  assert.equal(values.marketing.amount, -100);
  assert.equal(values.employees.amount, -210);
  assert.equal(values.waste.amount, -70);
  assert.equal(week.inventory.initialDate, '2026-10-04');
  assert.equal(week.inventory.finalDate, '2026-10-11');
  assert.deepEqual(week.inventory.movements, { from: '2026-10-04', to: '2026-10-10' });
  const directResponse = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: '2026-10-04', finalInventoryDate: '2026-10-11' }) });
  const direct = await directResponse.json(); assert.equal(directResponse.status, 200, JSON.stringify(direct));
  assert.equal(values.inventoryShortage.amount, direct.executiveSummary.metrics.adjustedKardexTotalCost.amount);
  assert.equal(values.otherConsumables.amount, -Math.abs(direct.executiveSummary.metrics.otherConsumables.amount));
  assert.equal(values.inventoryConsumptionTotal.amount, values.inventoryShortage.amount - 100 - 210 - 70 + values.otherConsumables.amount);
  assert.equal(values.inventoryConsumptionTotal.complete, true);
  assert.equal(data.weeks[1].locations[1].inventory.finalDate, '2026-10-10');
  assert.equal(data.weeks[1].locations[1].inventory.initialDate, '2026-10-07');
  const noOpening = data.weeks[1].locations[2];
  assert.equal(noOpening.values.inventoryShortage.status, 'no-opening-inventory');
  assert.equal(noOpening.values.marketing.amount, -100);
  assert.equal(noOpening.values.inventoryConsumptionTotal.status, 'incomplete');
  const current = data.weeks[0].locations[0];
  assert.equal(current.values.inventoryShortage.status, 'no-physical-count');
  assert.equal(current.values.otherConsumables.amount, null);
  assert.equal(current.values.marketing.amount, -50);
  assert.equal(current.values.netSales.amount, 100);
  assert.equal(current.values.tips.amount, 0);
  assert.equal(current.values.mercadoPagoCollection.amount, 0);
  assert.equal(current.values.inventoryConsumptionTotal.amount, null);
  assert.equal(data.weeks[2].locations[0].values.marketing.amount, -1060);
  assert.equal(data.weeks[2].locations[0].values.marketing.complete, true);
  assert.equal(data.weeks[0].locations[1].values.netSales.amount, null);
  assert.equal(data.weeks[0].locations[1].values.mercadoPagoTheoretical.status, 'incomplete');
  assert.equal(data.weeks[0].locations[1].values.netSales.percent, null);
  const stream = await fetch(`${base}/api/weekly-results/stream`).then(response => response.text());
  const events = stream.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).data, data);
  assert.equal(events.at(-2).completed, 12);
  const legacy = await fetch(`${base}/api/financial-results/weekly?location=store-1`).then(response => response.json());
  assert.equal(legacy.weeks.length, 5);
  assert.equal(legacy.total.netSales.amount, 1100);
  assert.equal(legacy.weeks.find(week => week.period.from === '2026-10-05').values.mercadoPagoCollection.amount, 1100);
  assert.equal(legacy.weeks.find(week => week.period.from === '2026-10-05').values.discounts.amount, 1000);
});

test('known partial costs and count coverage contribute to the displayed total without inventing missing amounts', async t => {
  const { base, root, app } = await fixture(t);
  const stock = app.locals.toteatStockSync.rebuild;
  let missingConsumableCounts = true;
  app.locals.toteatStockSync.rebuild = id => {
    const state = stock(id);
    if (missingConsumableCounts) state.daily.filter(row => row.code === 'PAC014').forEach(row => { row.physicalCount = false; });
    // A second main item without a count/cost must never silently become zero.
    state.daily.push(...state.daily.filter(row => row.code === 'A').map(row => ({ ...row, code: 'UNKNOWN', physicalCount: row.date === '2026-10-04' })));
    return state;
  };
  const data = await getReport(base), values = data.weeks[1].locations[0].values;
  assert.equal(values.inventoryShortage.status, 'partial');
  assert.equal(values.inventoryShortage.available, true);
  assert.equal(values.inventoryShortage.percentPartial, true);
  assert.equal(values.otherConsumables.status, 'no-data');
  assert.equal(values.inventoryConsumptionTotal.status, 'incomplete');
  assert.equal(values.inventoryConsumptionTotal.amount, null);
  assert.equal(values.inventoryConsumptionTotal.percent, null);
  missingConsumableCounts = false;
  const file = path.join(root, 'transactions', 'store-1', 'employees.xlsx');
  workbook(file, [
    ['pl', 'np', 'ce', ...Array.from({ length: 7 }, (_, index) => new Date(`${advance('2026-10-05', index)}T12:00:00Z`))],
    ['ID Producto **', 'Nombre Producto *', 'Costo'], ['A', 'Producto A', 999, 1, 1, 1, 1, 1, 1, 1],
    ['UNKNOWN', 'Sin costo', 999, 1, 1, 1, 1, 1, 1, 1]
  ]);
  const partial = (await getReport(base)).weeks[1].locations[0].values;
  assert.equal(partial.employees.amount, -70);
  assert.equal(partial.employees.status, 'partial');
  assert.equal(partial.inventoryConsumptionTotal.status, 'partial');
  assert.equal(partial.inventoryConsumptionTotal.amount, partial.inventoryShortage.amount + partial.waste.amount + partial.marketing.amount + partial.employees.amount + partial.otherConsumables.amount);
});

test('uploaded calendar consumption remains available with no stock sources and errors stay isolated by branch', async t => {
  const { base, app } = await fixture(t);
  app.locals.toteatStockSync.rebuild = () => { throw Error('Fuentes no disponibles'); };
  const data = await getReport(base);
  assert.equal(data.weeks[1].locations[0].values.marketing.amount, -100);
  assert.equal(data.weeks[1].locations[0].values.employees.amount, -210);
  assert.equal(data.weeks[1].locations[0].values.waste.amount, -70);
  assert.equal(data.weeks[1].locations[0].values.inventoryShortage.status, 'no-data');
  assert.equal(data.weeks[1].locations[2].values.marketing.amount, -100);
  assert.equal(data.weeks[1].locations[1].values.marketing.amount, null);
});

test('synchronized sources calculate calendar waste without requiring a physical count in the week', async t => {
  const { base, counts } = await fixture(t, 'synchronized');
  counts['store-1'] = [];
  const data = await getReport(base), values = data.weeks[1].locations[0].values;
  assert.equal(values.inventoryShortage.status, 'no-physical-count');
  assert.equal(values.waste.amount, -70);
  assert.equal(values.marketing.amount, -100);
  assert.equal(values.waste.complete, true);
  assert.equal(values.inventoryConsumptionTotal.amount, null);
});

test('line discounts are not subtracted twice, missing costs suppress margin, and verified empty sales retain zero', async t => {
  const { base, root } = await fixture(t);
  workbook(path.join(root, 'sales.xlsx'), [
    ['ID de orden', 'Fecha de creacion', 'ID Producto', 'Nombre', 'Cantidad', 'Precio a Pagar', 'Descuento'],
    ['line-only', '2026-10-05', 'A', 'Producto A', 1, 1190, -119],
    ['line-only', '2026-10-05', 'A', 'Producto A', 1, 1190, -119]
  ]);
  let data = await getReport(base), values = data.weeks[1].locations[0].values;
  assert.equal(values.netSales.amount, 1000);
  assert.equal(values.discounts.amount, 119);
  assert.ok(Math.abs(values.discounts.percent - 11.9) < 1e-9);
  assert.equal(values.grossSalesAfterDiscounts.amount, 1190);
  assert.equal(values.grossSales.amount, 1309);
  assert.equal(data.weeks[0].locations[0].values.netSales.amount, 0);
  assert.equal(data.weeks[0].locations[0].values.netSales.complete, true);
  assert.equal(data.weeks[0].locations[0].values.netSales.percent, null);
  workbook(path.join(root, 'sales.xlsx'), [
    ['ID de orden', 'Fecha de creacion', 'ID Producto', 'Nombre', 'Cantidad', 'Precio a Pagar'],
    ['no-cost', '2026-10-05', 'UNKNOWN', 'Sin costo', 1, 1190]
  ]);
  data = await getReport(base); values = data.weeks[1].locations[0].values;
  assert.equal(values.netSales.amount, 1000);
  assert.equal(values.margin.amount, null);
  assert.equal(values.margin.percent, null);
});

test('Mercado Pago requires REAL_AMOUNT and never substitutes gross amounts or derives it from fees', async t => {
  const { base, root } = await fixture(t);
  const file = path.join(root, 'transactions', 'store-1', 'mp.xlsx');
  workbook(file, [['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'FEE_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'card', 'SETTLEMENT', 1100, -100]]);
  const data = await getReport(base);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoCollection.amount, null);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.amount, null);
  assert.equal(data.weeks[0].locations[0].values.mercadoPagoCollection.amount, null);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoFee.amount, 100);
});

test('verified zero counts and zero consumption are complete results distinct from missing sources', async t => {
  const { base, root, app } = await fixture(t);
  const stock = app.locals.toteatStockSync.rebuild;
  app.locals.toteatStockSync.rebuild = id => {
    const state = stock(id);
    state.daily.forEach(row => { row.opening = 100; row.closing = 100; });
    return state;
  };
  const directory = path.join(root, 'transactions', 'store-1'), indexPath = path.join(directory, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath));
  index.fields.marketing.files = index.fields.marketing.files.slice(0, 1); delete index.exclusions.marketing;
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const dates = Array.from({ length: 8 }, (_, index) => advance('2026-10-04', index));
  for (const field of ['marketing', 'employees']) workbook(path.join(directory, `${field}.xlsx`), [
    ['pl', 'np', 'ce', ...dates.map(date => new Date(`${date}T12:00:00Z`))],
    ['ID Producto **', 'Nombre Producto *', 'Costo'], ['A', 'Producto A', 10, ...dates.map(() => 0)]
  ]);
  workbook(path.join(directory, 'waste.xlsx'), [
    ['Código', 'Nombre', 'Unidad', ...dates.flatMap(date => [date, '', '', ''])],
    ['', '', '', ...dates.flatMap(() => ['II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final'])],
    ['A', 'Producto A', 'UN', ...dates.flatMap(() => [0, 0, 0, 0])]
  ]);
  const values = (await getReport(base)).weeks[1].locations[0].values;
  for (const key of ['inventoryShortage', 'otherConsumables', 'marketing', 'employees', 'waste', 'inventoryConsumptionTotal']) {
    assert.equal(Math.abs(values[key].amount), 0, key);
    assert.equal(values[key].complete, true, key);
    assert.equal(Math.abs(values[key].percent), 0, key);
  }
});

test('Mercado Pago fees use charged amounts, calendar scope and deduplication, with explicit missing and partial coverage', async t => {
  const { base, root } = await fixture(t);
  const file = path.join(root, 'transactions', 'store-1', 'mp.xlsx');
  const rows = [
    ['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'FEE_AMOUNT', 'REAL_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'fee-1', 'SETTLEMENT', 500, -12, 488],
    ['2026-10-05T12:00:00-03:00', 'fee-1', 'SETTLEMENT', 500, -12, 488],
    ['2026-10-06T12:00:00-03:00', 'fee-2', 'SETTLEMENT', 500, 23, 477],
    ['2026-10-07T12:00:00-03:00', 'fee-zero', 'SETTLEMENT', 10, 0, 10],
    ['2026-10-08T12:00:00-03:00', 'payout', 'PAYOUT', 500, -999, 499],
    ['2026-10-14T12:00:00-03:00', 'future', 'SETTLEMENT', 500, -999, 401]
  ];
  workbook(file, rows);
  let data = await getReport(base), fee = data.weeks[1].locations[0].values.mercadoPagoFee;
  assert.equal(fee.amount, 35);
  assert.ok(Math.abs(fee.percent - 3.5) < 1e-9);
  assert.equal(fee.complete, true);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoCollection.amount, 975);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoTheoretical.amount, 1065);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoTheoretical.complete, true);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.amount, -90);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.percent, -9);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.complete, true);
  assert.equal(data.weeks[0].locations[0].values.mercadoPagoFee.amount, 0);
  assert.equal(data.weeks[0].locations[0].values.mercadoPagoFee.complete, true);
  assert.equal(data.weeks[1].locations[1].values.mercadoPagoFee.amount, null);
  assert.deepEqual(data.weeks[1].locations[0].sources.mercadoPagoFee.detectedFields, ['FEE_AMOUNT']);
  workbook(file, [...rows, ['2026-10-08T13:00:00-03:00', 'missing-fee', 'SETTLEMENT', 100, '', 100]]);
  data = await getReport(base); fee = data.weeks[1].locations[0].values.mercadoPagoFee;
  assert.equal(fee.amount, 35);
  assert.equal(fee.status, 'partial');
  assert.equal(fee.percentPartial, true);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoCollection.amount, 1075);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoTheoretical.amount, 1065);
  assert.equal(data.weeks[1].locations[0].values.mercadoPagoTheoretical.status, 'partial');
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.amount, 10);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.percent, 1);
  assert.equal(data.weeks[1].locations[0].values.collectionDifference.status, 'partial');
  const indexPath = path.join(root, 'transactions', 'store-1', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath));
  index.fields.mercadopago.files[0].confirmedRange.to = '2026-10-06';
  fs.writeFileSync(indexPath, JSON.stringify(index));
  workbook(file, rows);
  assert.equal((await getReport(base)).weeks[1].locations[0].values.mercadoPagoFee.status, 'partial');
});

test('REAL_AMOUNT preserves negative and zero amounts, isolates missing values and respects exclusions', async t => {
  const { base, root } = await fixture(t);
  const file = path.join(root, 'transactions', 'store-1', 'mp.xlsx');
  workbook(file, [
    ['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT', 'REAL_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'received', 'SETTLEMENT', 500, 488],
    ['2026-10-05T12:00:00-03:00', 'received', 'SETTLEMENT', 500, 488],
    ['2026-10-06T12:00:00-03:00', 'reversal', 'SETTLEMENT', -250, -200],
    ['2026-10-07T12:00:00-03:00', 'zero', 'SETTLEMENT', 100, 0],
    ['2026-10-08T12:00:00-03:00', 'missing', 'SETTLEMENT', 100, '']
  ]);
  let data = await getReport(base), values = data.weeks[1].locations[0].values;
  assert.equal(values.mercadoPagoCollection.amount, 288);
  assert.equal(values.mercadoPagoCollection.status, 'partial');
  assert.equal(values.mercadoPagoCollection.percent, null);
  assert.equal(values.collectionDifference.amount, null);
  assert.equal(values.collectionDifference.status, 'incomplete');
  assert.match(data.weeks[1].locations[0].sources.mercadoPago.name, /REAL_AMOUNT/);
  const indexPath = path.join(root, 'transactions', 'store-1', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath));
  index.exclusions.mercadopago = [{ from: '2026-10-06', to: '2026-10-06' }];
  fs.writeFileSync(indexPath, JSON.stringify(index));
  data = await getReport(base); values = data.weeks[1].locations[0].values;
  assert.equal(values.mercadoPagoCollection.amount, 488);
  workbook(file, [['TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'REAL_AMOUNT'],
    ['2026-10-05T12:00:00-03:00', 'zero', 'SETTLEMENT', 0]]);
  values = (await getReport(base)).weeks[1].locations[0].values;
  assert.equal(values.mercadoPagoCollection.amount, 0);
  assert.equal(values.mercadoPagoCollection.available, true);
});

test('options select 2/3/4 weeks, skip inventory processing and preserve calendar consumption', async t => {
  const { base, app } = await fixture(t);
  let rebuilds = 0;
  const stock = app.locals.toteatStockSync.rebuild;
  app.locals.toteatStockSync.rebuild = id => { rebuilds++; return stock(id); };
  for (const weeks of [2, 3, 4]) {
    const options = { weeks, includeInventory: false };
    const data = await getReport(base, options);
    assert.equal(data.weeks.length, weeks);
    assert.deepEqual(data.options, options);
    assert.equal(rebuilds, 0);
    const previous = data.weeks[1].locations[0];
    assert.equal(previous.values.waste.amount, -70);
    assert.equal(previous.values.marketing.amount, -100);
    assert.equal(previous.values.employees.amount, -210);
    for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
      assert.equal(previous.values[key].status, 'not-included');
      assert.equal(previous.values[key].amount, null);
      assert.equal(previous.values[key].percent, null);
    }
    const stream = await fetch(`${base}/api/weekly-results/stream?${new URLSearchParams(options)}`).then(response => response.text());
    const events = stream.trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.at(-1).data, data);
    assert.equal(events.at(-2).total, weeks * 3);
    assert.equal(events.at(-2).completed, weeks * 3);
    assert.equal(rebuilds, 0);
  }
  const defaults = await getReport(base);
  assert.deepEqual(defaults.options, { weeks: 4, includeInventory: true });
  assert.equal(rebuilds, 3);
  assert.equal(defaults.weeks[1].locations[0].inventory.initialDate, '2026-10-04');
});

test('invalid report options fail before calculations on both endpoints', async t => {
  const { base, app } = await fixture(t);
  let rebuilds = 0;
  app.locals.toteatStockSync.rebuild = () => { rebuilds++; throw Error('Must not calculate'); };
  for (const route of ['/api/weekly-results', '/api/weekly-results/stream']) for (const query of ['weeks=1', 'weeks=5', 'weeks=x', 'includeInventory=yes']) {
    const response = await fetch(`${base}${route}?${query}`);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(rebuilds, 0);
});
