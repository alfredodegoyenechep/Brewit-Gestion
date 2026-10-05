const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');

test('weekly consumption survives incomplete inventory coverage across monthly sheets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-consumption-'));
  const dir = path.join(root, 'transactions', 'store-1');
  fs.mkdirSync(dir, { recursive: true });
  const index = { location: 'store-1', fields: {}, exclusions: {} };
  for (const [field, factor] of [['marketing', 1], ['employees', 3]]) {
    const book = XLSX.utils.book_new();
    for (const [month, dates, quantities] of [
      ['Septiembre', ['2026-09-28', '2026-09-29', '2026-09-30'], [2, 3, 5]],
      ['Octubre', ['2026-10-01', '2026-10-04'], [7, 6]]
    ]) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['pl', 'np', 'ce', ...dates.map(date => new Date(`${date}T12:00:00Z`))],
        ['ID Producto **', 'Nombre Producto *', 'Costo'],
        ['A', 'Producto A', 999, ...quantities.map(quantity => quantity * factor)]
      ]), month);
    }
    const name = `${field}.xlsx`;
    XLSX.writeFile(book, path.join(dir, name));
    index.fields[field] = { files: [{ id: field, name, originalName: name, savedAt: '2026-10-05T00:00:00Z',
      detectedRange: { from: '2026-09-28', to: '2026-10-04' }, confirmedRange: { from: '2026-09-28', to: '2026-10-04' } }] };
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  const app = createApp({ uploadsRoot: root, enableLegacyTools: true, sourceMode: 'legacy', reportToday: '2026-10-05' });
  // Inventory ends in September, while consumption includes the October dates.
  app.locals.toteatStockSync.rebuild = () => ({ range: { from: '2026-09-01', to: '2026-09-30' },
    warehouses: [{ id: 'oper', custom_id: 2 }, { id: 'waste', custom_id: 3 }],
    daily: Array.from({ length: 30 }, (_, day) => ({ date: `2026-09-${String(day + 1).padStart(2, '0')}`,
      warehouse: 'oper', code: 'A', name: 'Producto A', unit: 'UN', opening: 100, closing: 100, physicalCount: true })),
    masterObservedAt: '2026-10-05T00:00:00Z', sourceKind: 'native-documents', includedOrders: [], issues: [], assumptions: [] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'], ['A', 'Producto A', 1, 10, 'UN']
  ]), 'Ingr');
  const form = new FormData();
  form.append('master-catalog', new Blob([XLSX.write(catalog, { type: 'buffer', bookType: 'xlsx' })]), 'catalog.xlsx');
  form.append('master-catalog-from', '2026-09-01');
  assert.equal((await fetch(`${base}/upload/master`, { method: 'POST', body: form })).status, 200);
  const request = `${base}/api/financial-results/weekly?location=store-1`;
  const response = await fetch(request);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  const week = data.weeks.find(week => week.period.from === '2026-09-28');
  assert.equal(week.values.marketingConsumption.amount, -230);
  assert.equal(week.values.marketingConsumption.complete, true);
  assert.equal(week.values.employeeConsumption.amount, -690);
  assert.equal(week.values.employeeConsumption.complete, true);
  assert.equal(week.values.adjustedKardexTotalCost.complete, false);
  assert.equal(week.values.calibrationConsumption.complete, false);
  assert.match(data.warnings.join('\n'), /2026-09-28 al 2026-10-04.*cubrir todos los días/);
  assert.equal(data.total.marketingConsumption.amount, -230);
  assert.equal(data.total.employeeConsumption.amount, -690);
  const streamed = await fetch(request.replace('/weekly?', '/weekly/stream?')).then(response => response.text());
  assert.deepEqual(JSON.parse(streamed.trim().split('\n').at(-1)).data, data);
  // Direct Kardex processing still requires complete inventory sources.
  const direct = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries',
      initialInventoryDate: '2026-09-28', finalInventoryDate: '2026-10-05' }) });
  assert.equal(direct.status, 400);
});
