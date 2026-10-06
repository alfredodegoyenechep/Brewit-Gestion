const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');
test('weekly inventory matches original Kardex and only stores separate other consumables', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-parity-'));
  const app = createApp({ uploadsRoot: root, enableLegacyTools: true, sourceMode: 'legacy', reportToday: '2026-09-28' });
  const daily = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 31 + i)).toISOString().slice(0, 10);
    for (const warehouse of ['oper', 'central']) {
      for (const code of ['A', 'PAC014']) daily.push({ date, warehouse, code, name: code, unit: 'UN', opening: 100 - i, closing: 99 - i, physicalCount: true, use: 0 });
    }
  }
  app.locals.toteatStockSync.rebuild = () => ({ range: { from: '2026-08-31', to: '2026-09-29' },
    warehouses: [{ id: 'oper', custom_id: 2 }, { id: 'waste', custom_id: 3 }, { id: 'central', custom_id: 1 }, { id: 'central-waste', custom_id: 4 }], daily,
    masterObservedAt: '2026-09-28T00:00:00Z', sourceKind: 'native-documents', includedOrders: [], issues: [], assumptions: [] });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{
    'Fecha de creacion': '2026-09-01', 'Fecha de cierre': '2026-09-01', 'ID Producto': 'A', Nombre: 'A', Cantidad: 1, 'Precio a Pagar': 1190
  }]), 'Ventas');
  const salesFile = path.join(root, 'sales.xlsx'); XLSX.writeFile(book, salesFile);
  app.locals.toteatSalesSync.source = (id, field) => id === 'store-1' && field === 'sales'
    ? [{ filePath: salesFile, excludedRanges: [], record: { originalName: 'sales.xlsx' } }] : [];
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base', 'Jerarquías de Ingredientes *'], ['A', 'A', 1, 10, 'UN', 'IC.2'], ['PAC014', 'Consumible', 1, 20, 'UN', 'IC.2']
  ]), 'Ingr');
  const form = new FormData();
  form.append('master-catalog', new Blob([XLSX.write(catalog, { type: 'buffer', bookType: 'xlsx' })]), 'catalog.xlsx');
  form.append('master-catalog-from', '2026-08-01');
  const hierarchies = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(hierarchies, XLSX.utils.json_to_sheet([
    {'ID Jerarquia':'IC.1','ID Nodo **':'IC.1','Nombre Jerarquía *':'Raíz','ID nodo padre':''},
    {'ID Jerarquia':'IC.2','ID Nodo **':'IC.2','Nombre Jerarquía *':'Packaging','ID nodo padre':'IC.1'}
  ]), 'Jerarquías');
  form.append('ingredient-hierarchy', new Blob([XLSX.write(hierarchies, {type:'buffer',bookType:'xlsx'})]), 'hierarchies.xlsx');
  form.append('ingredient-hierarchy-from', '2026-08-01');
  const upload = await fetch(`${base}/upload/master`, { method: 'POST', body: form }); assert.equal(upload.status, 200, await upload.text());
  const response = await fetch(`${base}/api/financial-results/weekly?location=store-1`);
  const weekly = await response.json(); assert.equal(response.status, 200, JSON.stringify(weekly));
  for (const week of weekly.weeks) {
    const end = week.period.to < '2026-09-28' ? week.period.to : '2026-09-28';
    const finalDate = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
    const directResponse = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: week.period.from, finalInventoryDate: finalDate }) });
    const direct = await directResponse.json(); assert.equal(directResponse.status, 200, JSON.stringify(direct));
    assert.deepEqual(direct.report.items.map(item => item.code), ['A']);
    assert.deepEqual(direct.otherConsumables.items.map(item => item.code), ['PAC014']);
    for (const key of ['otherConsumables', 'adjustedKardexTotalCost']) {
      const metric = direct.executiveSummary.metrics[key];
      assert.equal(metric.available, true, key);
      assert.notEqual(metric.amount, 0, key);
      assert.equal(week.values[key].amount, key === 'adjustedKardexTotalCost' ? Math.round(metric.amount) : -Math.round(Math.abs(metric.amount)), `${week.period.from}: ${key}`);
    }
  }
  const centralResponse = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'main-warehouse', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: '2026-08-31', finalInventoryDate: '2026-09-07' }) });
  const central = await centralResponse.json();
  assert.equal(centralResponse.status, 200, JSON.stringify(central));
  assert.deepEqual(central.report.items.map(item => item.code).sort(), ['A', 'PAC014']);
  assert.equal(central.report.itemCount, 2);
  assert.deepEqual(central.report.items.map(item => item.hierarchyPath), [['Ingredientes','Packaging'],['Ingredientes','Packaging']]);
  assert.equal(central.otherConsumables, null);
  assert.equal(central.executiveSummary.metrics.otherConsumables, undefined);
  assert.equal(central.executiveSummary.salesFilesRead, 0);
  assert.equal(central.executiveSummary.metrics.adjustedKardexTotalCost.available, true, 'warehouse differences do not require sales files');
  assert.equal(central.executiveSummary.metrics.adjustedKardexTotalCost.amount, central.report.totalCost);
  assert.equal(central.executiveSummary.metrics.adjustedKardexTotalCost.percentOfNetSales, null);
  assert.equal(central.executiveSummary.metrics.adjustedKardexTotalCost.totalItemCount, 2);
  assert.equal(central.executiveSummary.metrics.adjustedKardexTotalCost.coveredItemCount, 2);
  assert.equal(central.report.totalCost, central.report.items.reduce((sum, item) => sum + item.totalCost, 0));
  const detailResponse = await fetch(`${base}/api/inventory/item-detail?${new URLSearchParams({ report: central.itemDetailReportId, code: 'PAC014', unit: 'UN' })}`);
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).code, 'PAC014');
  app.locals.toteatStockSync.current = () => app.locals.toteatStockSync.rebuild();
  const centralCount = daily.find(row => row.warehouse === 'central' && row.date === '2026-09-07' && row.code === 'PAC014');
  centralCount.opening = 0;
  centralCount.closing = 0;
  const countedResponse = await fetch(`${base}/api/inventory/current?location=main-warehouse&date=2026-09-07`);
  const counted = await countedResponse.json();
  assert.equal(countedResponse.status, 200, JSON.stringify(counted));
  assert.equal(counted.report.items.find(item => item.code === 'PAC014').physicalInventory, 0);
  assert.equal(counted.report.items.find(item => item.code === 'A').physicalInventory, 93);
  assert.equal(counted.report.items.find(item => item.code === 'PAC014').quantity, centralCount.closing);
  for (const row of daily.filter(row => row.warehouse === 'central' && row.date === '2026-09-08')) row.physicalCount = false;
  const uncountedResponse = await fetch(`${base}/api/inventory/current?location=main-warehouse&date=2026-09-08`);
  const uncounted = await uncountedResponse.json();
  assert.equal(uncountedResponse.status, 200, JSON.stringify(uncounted));
  assert.ok(uncounted.report.items.every(item => item.physicalInventory === null));
});
