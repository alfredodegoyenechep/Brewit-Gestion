const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');
test('weekly inventory matches original Kardex for each inclusive week without uploaded Kardex', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-parity-'));
  const app = createApp({ uploadsRoot: root, enableLegacyTools: true, sourceMode: 'legacy', reportToday: '2026-09-28' });
  const daily = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 31 + i)).toISOString().slice(0, 10);
    for (const code of ['A', 'PAC014']) daily.push({ date, warehouse: 'oper', code, name: code, unit: 'UN', opening: 100 - i, closing: 99 - i, physicalCount: true, use: 0 });
  }
  app.locals.toteatStockSync.rebuild = () => ({ range: { from: '2026-08-31', to: '2026-09-29' },
    warehouses: [{ id: 'oper', custom_id: 2 }, { id: 'waste', custom_id: 3 }], daily,
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
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'], ['A', 'A', 1, 10, 'UN'], ['PAC014', 'Consumible', 1, 20, 'UN']
  ]), 'Ingr');
  const form = new FormData();
  form.append('master-catalog', new Blob([XLSX.write(catalog, { type: 'buffer', bookType: 'xlsx' })]), 'catalog.xlsx');
  form.append('master-catalog-from', '2026-08-01');
  const upload = await fetch(`${base}/upload/master`, { method: 'POST', body: form }); assert.equal(upload.status, 200);
  const response = await fetch(`${base}/api/financial-results/weekly?location=store-1`);
  const weekly = await response.json(); assert.equal(response.status, 200, JSON.stringify(weekly));
  for (const week of weekly.weeks) {
    const end = week.period.to < '2026-09-28' ? week.period.to : '2026-09-28';
    const finalDate = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
    const directResponse = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: week.period.from, finalInventoryDate: finalDate }) });
    const direct = await directResponse.json(); assert.equal(directResponse.status, 200, JSON.stringify(direct));
    for (const key of ['otherConsumables', 'adjustedKardexTotalCost']) {
      const metric = direct.executiveSummary.metrics[key];
      assert.equal(metric.available, true, key);
      assert.notEqual(metric.amount, 0, key);
      assert.equal(week.values[key].amount, -Math.round(Math.abs(metric.amount)), `${week.period.from}: ${key}`);
    }
  }
});
