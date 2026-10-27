const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../server');

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const writeBook = (filename, rows, sheet = 'Consumos') => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  XLSX.writeFile(book, filename);
};

async function fixture(t, { mixed = false, explicitUnits = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-direct-ingredients-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', enableLegacyTools: true, reportToday: '2026-09-04' });
  const masters = path.join(root, 'masters');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base'],
    ['LATTE', 'Latte', 99999, 'UN'],
    ['COFFEE', 'Café con leche', 99999, 'UN']
  ]), 'Prod');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base', 'Control de Stocks Activado'],
    ['LAC001', 'Leche', 1000, 'L', 1],
    ['LAC003', 'Leche vegetal avena', 2190, 'L', 1],
    ['LAC004', 'Leche vegetal almendra', 2500, 'L', 1]
  ]), 'Ingr');
  XLSX.writeFile(book, path.join(masters, 'catalog.xlsx'));
  const masterIndex = { 'master-catalog': { name: 'catalog.xlsx', validFrom: '2026-09-01' } };
  if (mixed) {
    writeBook(path.join(masters, 'recipes.xlsx'), [
      ['Id Producto', 'Id Ingrediente', 'Nombre Ingrediente*', 'Cantidad Ingrediente', 'Unidad Medida', 'Tasa Rendimiento'],
      ['LATTE', 'LAC003', 'Leche vegetal avena', 200, 'ml', 100],
      ['LATTE', 'LAC004', 'Leche vegetal almendra', 100, 'ml', 100],
      ['COFFEE', 'LAC001', 'Leche', 500, 'ml', 100]
    ], 'Recetas');
    masterIndex['master-recipes'] = { name: 'recipes.xlsx', validFrom: '2026-09-01' };
  }
  fs.writeFileSync(path.join(masters, 'masters.json'), JSON.stringify({ v1: masterIndex }));
  const directory = path.join(root, 'transactions', 'store-1');
  fs.mkdirSync(directory, { recursive: true });
  const index = { fields: {}, exclusions: {} };
  const quantities = {
    marketing: [['LAC003', 'Avena', 4.74, 0], ['LAC004', 'Almendra', 1, 1.25], ...(mixed ? [['LATTE', 'Latte', 2, 0]] : [])],
    employees: [['LAC003', 'Avena', '250ml', 0], ['LAC004', 'Almendra', 0, 0.5], ...(mixed ? [['COFFEE', 'Café con leche', 2, 0]] : [])],
    calibrations: [['LAC003', 'Avena', 0, 0.1], ['LAC004', 'Almendra', '100ml', 0]]
  };
  for (const [field, rows] of Object.entries(quantities)) {
    writeBook(path.join(directory, `${field}.xlsx`), explicitUnits ? [
      ['pl', 'np', 'unit', new Date('2026-09-01T12:00:00Z'), new Date('2026-09-02T12:00:00Z')],
      ['ID Producto **', 'Nombre Producto *', 'Unidad'],
      ['LAC003', 'Avena', 'UN', 4.74, 0], ['LAC004', 'Almendra', 'ml', 2250, 0]
    ] : [
      ['pl', 'np', new Date('2026-09-01T12:00:00Z'), new Date('2026-09-02T12:00:00Z')],
      ['ID Producto **', 'Nombre Producto *'], ...rows
    ]);
    index.fields[field] = { files: [{ id: field, name: `${field}.xlsx`, originalName: `${field}.xlsx`,
      confirmedRange: { from: '2026-09-01', to: '2026-09-02' } }] };
  }
  if (mixed) {
    fs.writeFileSync(path.join(directory, 'purchases.csv'), [
      'Fecha emisión\tTipo Documento\tDocumento\tProveedor/Para\tLin\tCod\tPRODUCTO\tQ.Rec\tUm.Rec\tCosto\tMonto neto\tMonto total',
      '2026-09-02\tFactura\t1\tProveedor\t1\tLAC003\tAvena\t1\tL\t2100\t2100\t2100',
      '2026-09-02\tFactura\t1\tProveedor\t2\tLAC004\tAlmendra\t1\tL\t2300\t2300\t2300',
      '2026-09-04\tFactura\t2\tProveedor\t1\tLAC003\tAvena\t1\tL\t9999\t9999\t9999'
    ].join('\n'));
    index.fields.purchases = { files: [{ id: 'purchases', name: 'purchases.csv', confirmedRange: { from: '2026-09-02', to: '2026-09-04' } }] };
  }
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(index));
  const daily = ['2026-09-01', '2026-09-02', '2026-09-03'].flatMap(date => ['LAC001', 'LAC003', 'LAC004'].map(code => ({
    date, code, name: code, unit: 'L', warehouse: 'oper', opening: date === '2026-09-03' ? 90 : 100,
    closing: 100, physicalCount: date !== '2026-09-02', use: 0
  })));
  app.locals.toteatStockSync.rebuild = () => ({ range: { from: '2026-09-01', to: '2026-09-03' }, daily,
    warehouses: [{ id: 'oper', custom_id: 2 }], sourceKind: 'native-documents',
    masterObservedAt: '2026-09-03T00:00:00Z', includedOrders: [], issues: [], assumptions: [] });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const processInventory = async (initialDate = '2026-09-01') => {
    const response = await fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: initialDate, finalInventoryDate: '2026-09-03' }) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  return { base, processInventory, daily };
}

for (const mixed of [false, true]) {
  test(`ingredient consumption uses milk units and costs in Kardex and movements exactly once (mixed recipe=${mixed})`, async t => {
    const { base, processInventory } = await fixture(t, { mixed });
    const data = await processInventory();
    assert.deepEqual(data.report.items.map(item => item.code), ['LAC001', 'LAC003', 'LAC004']);
    const costs = mixed ? [2100, 2300] : [2190, 2500];
    const marketing = [4.74 + (mixed ? 0.4 : 0), 2.25 + (mixed ? 0.2 : 0)];
    for (const [i, item] of data.report.items.filter(item => item.code !== 'LAC001').entries()) {
      assert.equal(item.unit, 'L');
      assert.equal(item.unitCost, costs[i]);
      assert.equal(item.costSource, mixed ? 'purchase' : 'master');
      const employee = i === 0 ? 0.25 : 0.5;
      closeTo(item.marketingConsumption, marketing[i]);
      closeTo(item.employeeConsumption, employee);
      closeTo(item.calibrationConsumption, 0.1);
      closeTo(item.adjustedTheoreticalFinal, 100 - marketing[i] - employee - 0.1);
      closeTo(item.totalCost, (90 - item.adjustedTheoreticalFinal) * costs[i]);
      const detailResponse = await fetch(`${base}/api/inventory/item-detail?${new URLSearchParams({ report: data.itemDetailReportId, code: item.code, unit: item.unit })}`);
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      closeTo(detail.consumptionMovements.reduce((sum, row) => sum + row.quantity, 0), marketing[i] + employee + 0.1);
    }
    const entry = data.consumption.marketing;
    assert.deepEqual(entry.products.productsWithoutMasterCost, []);
    assert.deepEqual(entry.ingredients.productsWithoutRecipe, []);
    assert.equal(entry.ingredients.stockedProducts.length, 0, 'stock-managed ingredients remain ingredients');
    closeTo(entry.products.totalCost, marketing[0] * costs[0] + marketing[1] * costs[1]);
    closeTo(entry.ingredients.totalCost, entry.products.totalCost);
    const milk = data.report.items.find(item => item.code === 'LAC001');
    const employeeMilk = (mixed ? 1 : 0) - 0.75;
    closeTo(milk.employeeConsumption, employeeMilk);
    closeTo(milk.adjustedTheoreticalFinal, 100 - employeeMilk);
    const employees = data.consumption.employees;
    const reversal = employees.products.products.find(item => item.isMilkSubstitutionReversal);
    assert.equal(reversal.code, 'LAC001');
    closeTo(reversal.quantity, -0.75);
    closeTo(reversal.totalCost, -750);
    closeTo(employees.products.totalCost, (mixed ? 1000 : 0) + 0.25 * costs[0] + 0.5 * costs[1] - 750);
    closeTo(employees.ingredients.totalCost, employees.products.totalCost);
    assert.ok(!data.consumption.marketing.products.products.some(item => item.isMilkSubstitutionReversal));
    assert.ok(!data.consumption.calibrations.products.products.some(item => item.isMilkSubstitutionReversal));
    const milkDetail = await fetch(`${base}/api/inventory/item-detail?${new URLSearchParams({ report: data.itemDetailReportId, code: 'LAC001', unit: 'L' })}`).then(response => response.json());
    closeTo(milkDetail.consumptionMovements.reduce((sum, row) => sum + row.effect, 0), -employeeMilk);
    const reversals = milkDetail.consumptionMovements.filter(row => /Reversa LAC001/.test(row.source));
    assert.equal(reversals.length, 2);
    closeTo(reversals.reduce((sum, row) => sum + row.effect, 0), 0.75);
    const summaryResponse = await fetch(`${base}/api/inventory/consumption-summary?location=store-1&field=marketing&dateFrom=2026-09-01&dateTo=2026-09-02`);
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200, JSON.stringify(summary));
    closeTo(summary.summary.products.totalCost, entry.products.totalCost);
    closeTo(summary.summary.ingredients.totalCost, entry.ingredients.totalCost);
    const recordsResponse = await fetch(`${base}/api/uploads/records?location=store-1&field=marketing&from=2026-09-01&to=2026-09-02`);
    assert.equal(recordsResponse.status, 200);
    const records = await recordsResponse.json();
    assert.ok(records.rows.filter(row => ['LAC003', 'LAC004'].includes(row.Código)).every(row => row.Unidad === 'L'));
    const later = await processInventory('2026-09-02');
    closeTo(later.report.items.find(item => item.code === 'LAC003').initialInventory, 100 - marketing[0] - 0.25);
    closeTo(later.report.items.find(item => item.code === 'LAC004').initialInventory, 100 - (mixed ? 1.2 : 1) - 0.1);
    closeTo(later.report.items.find(item => item.code === 'LAC001').initialInventory, 100 - (mixed ? 1 : 0) + 0.25);
    closeTo(later.report.items.find(item => item.code === 'LAC001').employeeConsumption, -0.5);
  });
}

test('LAC003 and LAC004 use liters even when the consumption row declares UN, while milliliters retain their conversion', async t => {
  const { processInventory } = await fixture(t, { explicitUnits: true });
  const data = await processInventory();
  const entry = data.consumption.marketing;
  assert.equal(entry.products.products.find(item => item.code === 'LAC003').unit, 'L');
  assert.equal(entry.products.products.find(item => item.code === 'LAC003').costSource, 'master');
  assert.deepEqual(entry.products.productsWithoutMasterCost, []);
  closeTo(entry.products.products.find(item => item.code === 'LAC004').quantity, 2.25);
  closeTo(data.report.items.find(item => item.code === 'LAC003').marketingConsumption, 4.74);
  closeTo(data.report.items.find(item => item.code === 'LAC004').marketingConsumption, 2.25);
  closeTo(data.report.items.find(item => item.code === 'LAC001').employeeConsumption, -6.99);
});

test('employee milk reversals reconcile intermediate physical counts without applying the credit twice', async t => {
  const { processInventory, daily } = await fixture(t);
  const count = daily.find(row => row.code === 'LAC001' && row.date === '2026-09-02');
  count.physicalCount = true;
  count.opening = 99;
  const data = await processInventory();
  const milk = data.report.items.find(item => item.code === 'LAC001');
  closeTo(milk.movements['aju-tomas-intermedias'], -1.25);
  closeTo(milk.adjustedTheoreticalFinal, 99.5);
  closeTo(milk.employeeConsumption, -0.75);
});
