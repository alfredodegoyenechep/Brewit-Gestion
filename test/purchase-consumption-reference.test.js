const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { CURVES, monthlyAnniversary, referenceStatus, replenishmentConsumption } = require('../purchase-consumption-reference');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('growth curves follow opening anniversaries, including short months, leap years and late configuration', () => {
  assert.equal(monthlyAnniversary('2026-01-31', 1), '2026-02-28');
  assert.equal(monthlyAnniversary('2026-01-31', 2), '2026-03-31');
  assert.equal(monthlyAnniversary('2024-01-31', 1), '2024-02-29');
  assert.equal(monthlyAnniversary('2026-12-31', 2), '2027-02-28');
  for (const curve of CURVES) {
    const rule = { enabled: true, curveId: curve.id, sourceLocationId: 'stable' };
    assert.equal(referenceStatus(rule, '2026-01-31', '2026-01-30').status, 'pending');
    curve.percentages.forEach((percentage, month) => {
      const status = referenceStatus(rule, '2026-01-31', monthlyAnniversary('2026-01-31', month));
      assert.equal(status.percentage, percentage);
      assert.equal(status.month, month + 1);
      assert.equal(status.active, true);
    });
    const end = monthlyAnniversary('2026-01-31', curve.percentages.length);
    assert.equal(referenceStatus(rule, '2026-01-31', end).active, false);
    assert.equal(referenceStatus(rule, '2026-01-31', end).status, 'expired');
    assert.equal(referenceStatus({ ...rule, enabled: false }, '2026-01-31', '2026-02-28').status, 'disabled');
  }
  assert.equal(referenceStatus({ enabled: true, curveId: '25-50-75' }, '2026-01-15', '2026-03-20').percentage, 75);
});

test('compares daily consumption before expressing both alternatives over the same partial history', () => {
  const projectedWins = replenishmentConsumption(21, 7, 10, 50);
  assert.equal(projectedWins.ownAverageDailyConsumption, 3);
  assert.equal(projectedWins.projectedConsumption30, 35);
  assert.equal(projectedWins.usedConsumption30, 35);
  assert.equal(projectedWins.averageDailyConsumption, 5);
  const ownWins = replenishmentConsumption(49, 7, 10, 50);
  assert.equal(ownWins.usedConsumption30, 49);
  assert.equal(ownWins.averageDailyConsumption, 7);
  assert.equal(replenishmentConsumption(49, 7, null, 50).projectedConsumption30, null);
});

async function setup(t, { openingDate = '2026-09-20' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-consumption-reference-'));
  let today = '2026-09-26';
  const app = createApp({ uploadsRoot: root, sourceMode: 'synchronized', enableToteatSync: false,
    reportToday: () => today });
  const locationsFile = path.join(root, 'config', 'locations.json');
  const locations = JSON.parse(fs.readFileSync(locationsFile, 'utf8'));
  Object.assign(locations.locations.find(item => item.id === 'store-1'), { name: 'Estable', openingDate: '2025-01-01' });
  Object.assign(locations.locations.find(item => item.id === 'store-2'), { name: 'Nueva', openingDate });
  fs.writeFileSync(locationsFile, JSON.stringify(locations));
  const catalog = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(catalog, XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'],
    ['A', 'Leche', 1, 100, 'L'], ['B', 'Mayor consumo propio', 1, 100, 'L'],
    ['C', 'Unidad incompatible', 1, 100, 'KG'], ['D', 'Sin referencia', 1, 100, 'UN']
  ]), 'Ingr');
  XLSX.writeFile(catalog, path.join(root, 'masters', 'catalog.xlsx'));
  fs.writeFileSync(path.join(root, 'masters', 'masters.json'), JSON.stringify({ v1: {
    'master-catalog': { name: 'catalog.xlsx', validFrom: '2026-08-01', source: 'toteat-shared-api' }
  } }));
  const purchases = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(purchases, XLSX.utils.aoa_to_sheet([
    ['Fecha emisión', 'Tipo Documento', 'Documento', 'Proveedor/Para', 'Número identificador fiscal', 'Lin', 'Cod', 'PRODUCTO', 'Q.Rec', 'Um.Rec', 'Costo', 'Monto neto', 'Descuento', 'Monto total'],
    ['2026-09-20', 'Factura', '100', 'CODE SPA', '111', '1', 'A', 'Leche', 1, 'L', 100, 100, 0, 100],
    ['2026-09-20', 'Factura', '100', 'CODE SPA', '111', '2', 'B', 'Mayor consumo propio', 1, 'L', 100, 100, 0, 100]
  ]), 'Compras');
  const purchasesFile = path.join(root, 'purchases.xlsx');
  XLSX.writeFile(purchases, purchasesFile);
  app.locals.toteatSalesSync.purchases.source = (id, field) => id === 'store-2' && field === 'purchases'
    ? [{ filePath: purchasesFile, excludedRanges: [], record: {} }] : [];
  const stocks = {};
  for (const id of ['store-1', 'store-2', 'main-warehouse']) {
    const daily = [];
    for (let day = 0; day < 30; day++) {
      const date = new Date(Date.UTC(2026, 7, 28 + day)).toISOString().slice(0, 10);
      for (const code of id === 'store-1' ? ['A', 'B', 'C'] : ['A', 'B', 'C', 'D']) {
        const use = id === 'main-warehouse' ? 0 : id === 'store-1' ? (code === 'A' ? 10000 : 10)
          : date < openingDate ? 99 : code === 'A' ? 3 : code === 'B' ? 7 : 1;
        daily.push({ date, code, name: code, unit: id === 'store-1' && code === 'A' ? 'ML' : code === 'C' && id !== 'store-1' ? 'KG' : code === 'D' ? 'UN' : 'L',
          warehouse: id === 'main-warehouse' ? 'central' : 'local', opening: 0, physicalCount: true, use });
      }
    }
    stocks[id] = { sourceKind: 'native-documents', range: { from: '2026-08-28', to: '2026-09-26' },
      warehouses: [{ id: 'local', custom_id: 2 }, { id: 'central', custom_id: 1 }], daily,
      masterObservedAt: '2026-09-26T00:00:00Z', includedOrders: [], issues: [], assumptions: [] };
  }
  app.locals.toteatStockSync.current = id => stocks[id];
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (url, options) => {
    const response = await fetch(base + url, options);
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body));
    return body;
  };
  const configure = (values = {}) => json('/api/purchase-projections/consumption-reference', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', enabled: true, sourceLocationId: 'store-1', curveId: '50-75', ...values })
  });
  const project = (location = 'store-2', suffix = '') => json(`/api/purchase-projections?location=${location}${suffix}`);
  const policiesFile = path.join(root, 'config', 'purchase-projection-policies.json');
  return { root, app, stocks, base, json, configure, project, policiesFile, locationsFile, setToday: value => {
    today = value;
    for (const stock of Object.values(stocks).filter(Boolean)) {
      const last = stock.daily.filter(row => row.date === stock.range.to);
      while (stock.range.to < value) {
        const next = new Date(Date.parse(stock.range.to) + 86400000).toISOString().slice(0, 10);
        stock.daily.push(...last.map(row => ({ ...row, date: next })));
        stock.range.to = next;
      }
    }
  } };
}

test('synchronized purchase projections exclude stock-managed products except the five allowed codes', async t => {
  const { root, app, stocks, project } = await setup(t);
  const exceptions = ['Sub005', 'B2860', 'B2850', 'B2840', 'B2830'];
  const excluded = ['B2820', 'B2810', 'B2800', 'B2790', 'B2780', 'B2770', 'P100', 'EX100', 'UNKNOWN'];
  const masterPath = path.join(root, 'masters', 'catalog.xlsx');
  const catalog = XLSX.readFile(masterPath);
  const sheet = codes => XLSX.utils.aoa_to_sheet([
    ['ID Producto **', 'Nombre Producto *', 'Activo', 'Costo', 'Medida Base'],
    ...codes.map(code => [code, code, 1, 100, 'UN'])
  ]);
  XLSX.utils.book_append_sheet(catalog, sheet([...exceptions.slice(1), ...excluded.slice(0, 7)]), 'Prod');
  XLSX.utils.book_append_sheet(catalog, sheet(['SUB005', 'EX100']), 'Extras');
  XLSX.writeFile(catalog, masterPath);
  app.locals.toteatMasterSync.sharedCurrent = () => ({ products: [...exceptions, ...excluded]
    .map(code => ({ code: code.toUpperCase(), stockManaged: true })) });
  for (const stock of Object.values(stocks)) {
    const template = stock.daily.filter(row => row.code === 'D');
    for (const code of [...exceptions, ...excluded]) {
      stock.daily.push(...template.map(row => ({ ...row, code, name: code, unit: 'UN' })));
    }
  }
  for (const location of ['store-2', 'main-warehouse']) {
    const projection = await project(location);
    assert.deepEqual(projection.items.map(item => item.key).sort(), ['A', 'B', 'C', 'D', ...exceptions.map(code => code.toUpperCase())].sort());
    assert.equal(projection.summary.itemCount, 9);
    assert.equal(projection.items.some(item => excluded.includes(item.key)), false);
  }
});

test('ingredient buying units convert quantities and prices without modifying real consumption or the original master', async t => {
  const { root, json, project, configure } = await setup(t);
  const masterPath = path.join(root, 'masters', 'catalog.xlsx');
  const originalMaster = fs.readFileSync(masterPath);
  const master = await json('/api/purchase-projections/ingredient-master');
  assert.deepEqual(master.purchaseUnitOptions, ['Botella', 'Bidón', 'Pack', 'Caja', 'Bolsa', 'Lata']);
  const ingredient = master.items.find(item => item.code === 'A');
  assert.equal(ingredient.internalUnit, 'L');
  assert.equal(ingredient.unitsPerPurchaseUnit, 1);
  await configure();
  const before = (await project()).items.find(item => item.key === 'A');
  const save = items => json('/api/purchase-projections/ingredient-master', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  await save([{ code: 'A', internalUnit: 'L', purchaseUnit: 'Botella', unitsPerPurchaseUnit: 0.75 }]);
  const a = (await project()).items.find(item => item.key === 'A');
  assert.equal(a.purchaseUnit, 'Botella');
  assert.equal(a.unitsPerPurchaseUnit, 0.75);
  assert.equal(a.suggestedPurchaseUnits, Math.ceil(a.suggestedInternalQuantity / 0.75));
  assert.equal(a.estimatedPurchaseUnitCost, 75);
  assert.equal(a.estimatedTotal, a.suggestedPurchaseUnits * 75);
  assert.deepEqual([a.currentInventory, a.consumption30, a.averageDailyConsumption],
    [before.currentInventory, before.consumption30, before.averageDailyConsumption]);
  const source = (await project('store-1')).items.find(item => item.key === 'A');
  assert.equal(source.internalUnit, 'ML');
  assert.equal(source.unitsPerPurchaseUnit, 750);
  const saved = (await json('/api/purchase-projections/ingredient-master')).items.find(item => item.code === 'A');
  assert.equal(saved.configured, true);
  assert.equal(saved.unitsPerPurchaseUnit, 0.75);
  assert.deepEqual(fs.readFileSync(masterPath), originalMaster);
  const order = await json('/api/purchase-orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: a.supplierKey,
      items: [{ key: 'A', quantity: 2, unitCost: 75 }] })
  });
  assert.equal(order.items[0].internalQuantity, 1.5);
  assert.equal(order.items[0].purchaseUnit, 'Botella');
  await save([{ code: 'A', internalUnit: 'L', purchaseUnit: '', unitsPerPurchaseUnit: null }]);
  assert.equal((await project()).items.find(item => item.key === 'A').unitsPerPurchaseUnit, 1);
  assert.equal((await json(`/api/purchase-orders/${order.id}`)).items[0].unitsPerPurchaseUnit, 0.75);
});

test('ingredient buying-unit configuration needs no stock and rejects invalid batches atomically', async t => {
  const { root, stocks, base, json } = await setup(t);
  stocks['store-1'] = null;
  stocks['store-2'] = null;
  assert.equal((await json('/api/purchase-projections/ingredient-master')).items.length, 4);
  const valid = { code: 'A', internalUnit: 'L', purchaseUnit: 'Botella', unitsPerPurchaseUnit: 0.75 };
  for (const [patch, status] of [
    [{ code: 'missing' }, 400], [{ internalUnit: 'ML' }, 409], [{ purchaseUnit: 'Invalid' }, 400],
    [{ unitsPerPurchaseUnit: 0 }, 400], [{ unitsPerPurchaseUnit: -1 }, 400], [{ unitsPerPurchaseUnit: 'invalid' }, 400]
  ]) {
    const response = await fetch(base + '/api/purchase-projections/ingredient-master', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ ...valid, code: 'B' }, { ...valid, ...patch }] })
    });
    assert.equal(response.status, status);
    assert.equal(fs.existsSync(path.join(root, 'config', 'purchase-unit-configuration.json')), false);
  }
});

test('reference API persists and validates settings without requiring inventory or resetting item policies', async t => {
  const { base, stocks, configure, json, policiesFile } = await setup(t);
  stocks['store-1'] = null;
  stocks['store-2'] = null;
  const configured = await configure();
  assert.equal(configured.reference.active, true);
  assert.equal(configured.reference.percentage, 50);
  assert.equal(configured.reference.endsAt, '2026-11-20');
  assert.deepEqual(configured.sources.map(item => item.id), ['store-1']);
  for (const values of [{ location: 'main-warehouse' }, { sourceLocationId: 'store-2' },
    { sourceLocationId: 'main-warehouse' }, { sourceLocationId: 'missing' }, { curveId: 'invalid' }, { enabled: 'true' }]) {
    const response = await fetch(base + '/api/purchase-projections/consumption-reference', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: 'store-2', enabled: true, sourceLocationId: 'store-1', curveId: '50-75', ...values })
    });
    assert.equal(response.status, 400);
  }
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', items: [{ key: 'A', minDays: 3, maxDays: 10, managed: true }] }) });
  assert.equal(JSON.parse(fs.readFileSync(policiesFile, 'utf8')).locations['store-2'].consumptionReference.enabled, true);
  await configure({ enabled: false });
  const saved = JSON.parse(fs.readFileSync(policiesFile, 'utf8')).locations['store-2'];
  assert.equal(saved.items.A.minDays, 3);
  assert.equal(saved.consumptionReference.enabled, false);
  assert.equal(saved.consumptionReference.sourceLocationId, 'store-1');
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', items: [{ key: 'B', minDays: 5, maxDays: 15, managed: true }] }) });
  await json('/api/purchase-projections/policies/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', sourceLocation: 'store-1', confirmed: true }) });
  const copied = JSON.parse(fs.readFileSync(policiesFile, 'utf8')).locations['store-2'];
  assert.deepEqual(copied.consumptionReference, saved.consumptionReference);
  assert.equal(copied.items.B.minDays, 5);
});

test('activation requires the store opening date', async t => {
  const { base } = await setup(t, { openingDate: '' });
  const response = await fetch(base + '/api/purchase-projections/consumption-reference', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', enabled: true, sourceLocationId: 'store-1', curveId: '50-75' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /fecha de apertura/);
});

test('native replenishment uses comparable daily units and partial history without changing real movements', async t => {
  const { project, configure, stocks, policiesFile, locationsFile, setToday } = await setup(t);
  const before = await project();
  const rawStock = JSON.stringify(stocks);
  await configure();
  const projection = await project();
  const a = projection.items.find(item => item.key === 'A');
  const b = projection.items.find(item => item.key === 'B');
  assert.equal(a.consumptionDays, 7);
  assert.equal(a.consumptionFrom, '2026-09-20');
  assert.equal(a.consumption30, 21);
  assert.equal(a.ownAverageDailyConsumption, 3);
  assert.equal(a.projectedAverageDailyConsumption, 5);
  assert.equal(a.projectedConsumption30, 35);
  assert.equal(a.usedConsumption30, 35);
  assert.equal(a.averageDailyConsumption, 5);
  assert.equal(a.minimumStock, 35);
  assert.equal(a.maximumStock, 70);
  assert.equal(a.suggestedInternalQuantity, 70 - a.currentInventory);
  assert.equal(a.currentCoverageDays, a.currentInventory / 5);
  assert.equal(b.averageDailyConsumption, 7);
  assert.equal(b.usedConsumption30, 49);
  for (const key of ['C', 'D']) {
    const item = projection.items.find(item => item.key === key);
    assert.equal(item.projectedConsumption30, null);
    assert.equal(item.averageDailyConsumption, 1);
    assert.ok(item.referenceIssue);
  }
  assert.ok(projection.warnings.some(warning => /2 ingredientes sin referencia comparable/.test(warning)));
  assert.deepEqual(projection.items.map(item => [item.key, item.currentInventory, item.consumption30]),
    before.items.map(item => [item.key, item.currentInventory, item.consumption30]));
  assert.equal(JSON.stringify(stocks), rawStock);
  // An origin's own reference never cascades into the new store's real baseline.
  const registry = JSON.parse(fs.readFileSync(policiesFile, 'utf8'));
  const locations = JSON.parse(fs.readFileSync(locationsFile, 'utf8'));
  locations.locations.find(item => item.id === 'store-1').openingDate = '2026-09-20';
  fs.writeFileSync(locationsFile, JSON.stringify(locations));
  registry.locations['store-1'] = { items: {}, consumptionReference: { enabled: true, sourceLocationId: 'store-2', curveId: '50-75' } };
  fs.writeFileSync(policiesFile, JSON.stringify(registry));
  assert.equal((await project()).items.find(item => item.key === 'A').averageDailyConsumption, 5);
  setToday('2026-10-20');
  assert.equal((await project()).consumptionReference.percentage, 75);
  setToday('2026-11-20');
  const expired = await project();
  assert.equal(expired.consumptionReference.active, false);
  assert.equal(expired.consumptionReference.status, 'expired');
  assert.equal(expired.items.find(item => item.key === 'A').averageDailyConsumption, 3);
  setToday('2026-09-26');
  await configure({ enabled: false });
  assert.equal((await project()).items.find(item => item.key === 'A').averageDailyConsumption, 3);
});

test('unavailable reference inventory raises a visible error rather than silently underestimating replenishment', async t => {
  const { configure, base, stocks } = await setup(t);
  await configure();
  stocks['store-1'] = null;
  const response = await fetch(base + '/api/purchase-projections?location=store-2');
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /consumo de referencia de Estable/);
});

test('issued cafeteria orders no longer adjust warehouse purchase suggestions', async t => {
  const { configure, project, json } = await setup(t);
  await configure();
  const item = (await project()).items.find(item => item.key === 'A');
  const initial = await project('main-warehouse');
  assert.equal(initial.branchOrders, undefined);
  assert.equal(initial.items.find(item => item.key === 'A').branchOrderInternalQuantity, undefined);
  const order = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', items: [{ key: 'A', quantity: 20, unitCost: 100 }] }) });
  assert.equal(order.items[0].suggestedPurchaseUnits, item.suggestedPurchaseUnits);
  await json(`/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ key: 'A', quantity: 100, unitCost: 100 }] }) });
  const updated = await project('main-warehouse');
  assert.deepEqual(updated.items, initial.items);
});

test('store order quantities still round up to purchase units without OC Suc consolidation', async t => {
  const { root, configure, project } = await setup(t);
  const file = path.join(root, 'masters', 'catalog.xlsx');
  const catalog = XLSX.readFile(file);
  catalog.Sheets.Ingr = XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce', 'ub', 'conv.0.umed', 'conv.0.umedb', 'conv.0.cnum', 'conv.0.cden'],
    ['ID Producto **', 'Nombre Producto *', 'Costo', 'Medida Base', 'Conversion - Unidad Medida a Definir', 'Conversion - Unidad Medida Base', 'Conversion - Numerador', 'Conversion - Denominador'],
    ['A', 'Leche', 100, 'L', 'CAJ', 'L', 12, 1]
  ]);
  XLSX.writeFile(catalog, file);
  const purchasesFile = path.join(root, 'purchases.xlsx');
  const purchases = XLSX.readFile(purchasesFile);
  purchases.Sheets.Compras = XLSX.utils.aoa_to_sheet([
    ['Fecha emisión', 'Tipo Documento', 'Documento', 'Proveedor/Para', 'Número identificador fiscal', 'Lin', 'Cod', 'PRODUCTO', 'Q.Rec', 'Um.Rec', 'Costo', 'Monto neto', 'Descuento', 'Monto total'],
    ['2026-09-20', 'Factura', '100', 'CODE SPA', '111', '1', 'A', 'Leche', 1, 'CAJ', 1200, 1200, 0, 1200]
  ]);
  XLSX.writeFile(purchases, purchasesFile);
  await configure();
  fs.writeFileSync(path.join(root, 'config', 'purchase-projection-policies.json'), JSON.stringify({ locations: {
    'store-2': { items: { A: { managed: true, supplierKey: '111' } },
      consumptionReference: { enabled: true, sourceLocationId: 'store-1', curveId: '50-75' } }
  } }));
  const item = (await project()).items.find(item => item.key === 'A');
  assert.equal(item.suggestedInternalQuantity, 73);
  assert.equal(item.suggestedPurchaseUnits, 7);
  assert.equal(item.projectedInternalQuantity, 84);
  assert.equal((await project('main-warehouse')).items.find(item => item.key === 'A').branchOrderInternalQuantity, undefined);
});

function setConsolidationInventories(stocks) {
  for (const [id, opening] of [['store-1', 30000], ['store-2', 33], ['main-warehouse', 100]]) {
    for (const row of stocks[id].daily.filter(row => row.code === 'A')) row.opening = opening;
  }
}

async function manageConsolidationItems(json) {
  for (const location of ['store-1', 'store-2']) {
    await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, items: ['A', 'B', 'C', 'D'].map(key => ({ key, managed: true, minDays: 7, maxDays: 14 })) }) });
  }
}

test('warehouse coverage consolidates all active stores including reference demand, regardless of selected orders', async t => {
  const { app, stocks, configure, project, setToday, json } = await setup(t);
  setConsolidationInventories(stocks);
  await manageConsolidationItems(json);
  await configure();
  const reads = new Map();
  app.locals.toteatStockSync.current = id => { reads.set(id, (reads.get(id) || 0) + 1); return stocks[id]; };
  const projection = await project('main-warehouse', '&branches=');
  assert.equal(reads.get('store-1'), 1);
  assert.equal(reads.get('store-2'), 1);
  const a = projection.items.find(item => item.key === 'A');
  assert.equal(projection.localsConsolidation.available, true);
  assert.equal(a.currentInventory, 100);
  assert.equal(a.localsInventory, 50);
  assert.equal(a.totalInventory, 150);
  assert.equal(a.localsDailyConsumption, 15);
  assert.equal(a.currentCoverageDays, 10);
  assert.equal(a.locals.length, 2);
  assert.equal(a.locals.find(local => local.locationId === 'store-1').sourceUnit, 'ML');
  assert.equal(a.locals.find(local => local.locationId === 'store-2').dailyConsumption, 5);
  const c = projection.items.find(item => item.key === 'C');
  assert.equal(c.localsInventory, -1);
  assert.equal(c.currentCoverageDays, -1);
  assert.ok(c.locals.find(local => local.locationId === 'store-1').inventoryIssue);
  await configure({ enabled: false });
  assert.equal((await project('main-warehouse')).items.find(item => item.key === 'A').localsDailyConsumption, 13);
  await configure();
  setToday('2026-11-20');
  assert.equal((await project('main-warehouse')).items.find(item => item.key === 'A').localsDailyConsumption, 13);
  const store = await project('store-2');
  assert.equal(store.localsConsolidation.available, false);
  assert.equal(store.items.find(item => item.key === 'A').currentCoverageDays, 10);
});

test('warehouse details retain a store inventory when its consumption reference is unavailable', async t => {
  const { stocks, configure, project, json } = await setup(t);
  setConsolidationInventories(stocks);
  await manageConsolidationItems(json);
  await configure();
  stocks['store-1'] = null;
  const a = (await project('main-warehouse')).items.find(item => item.key === 'A');
  assert.equal(a.localsInventory, 30);
  assert.equal(a.totalInventory, 130);
  assert.equal(a.localsInventorySubtotal, 30);
  assert.equal(a.localsDailyConsumption, 0);
  assert.equal(a.currentCoverageDays, null);
  const local = a.locals.find(local => local.locationId === 'store-2');
  assert.equal(local.inventory, 30);
  assert.equal(local.dailyConsumption, 0);
  assert.match(local.consumptionIssue, /consumo de referencia/);
});

test('warehouse columns show consolidated values and open inventory and consumption details without reloading', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, stocks, configure, json } = await setup(t);
  setConsolidationInventories(stocks);
  await manageConsolidationItems(json);
  await configure();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  let requests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchase-projections') requests += 1; });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('main-warehouse');
  assert.equal(requests, 0);
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('Consumo considerado'));
  await page.locator('#projection-only-required').uncheck();
  const row = page.locator('#purchase-projection-body tr[data-key="A"]');
  assert.deepEqual((await row.locator('td').allTextContents()).slice(8, 14),
    ['100,00', '50,00', '150,00', '0,00', '15,00', '10,0 días']);
  assert.equal(await page.locator('#projection-own-daily-header').isVisible(), false);
  assert.equal(await page.locator('#projection-locals-inventory-header').isVisible(), true);
  assert.equal(await page.locator('#projection-branch-orders-header, #open-projection-branch-orders, #projection-branch-orders-dialog').count(), 0);
  const dialog = page.locator('#projection-local-detail-dialog');
  await row.getByRole('button', { name: 'Ver detalle de Inventario Locales de A', exact: true }).click();
  assert.equal(await dialog.isVisible(), true);
  const stable = page.locator('#projection-local-detail-body tr[data-location-id="store-1"]');
  assert.deepEqual((await stable.locator('td').allTextContents()).slice(0, 4), ['Estable', '20.000,00', 'ML', '20,00']);
  assert.match(await page.locator('#projection-local-detail-calculation').innerText(), /150,00 L.*15,00 L\/día.*10,0 días/);
  await page.locator('#close-projection-local-detail').click();
  await row.getByRole('button', { name: 'Ver detalle de Consumo Diario Locales de A', exact: true }).click();
  const newer = page.locator('#projection-local-detail-body tr[data-location-id="store-2"]');
  assert.deepEqual((await newer.locator('td').allTextContents()).slice(0, 4), ['Nueva', '3,00', '5,00', '5,00']);
  assert.match(await newer.innerText(), /Estable × 50%/);
  assert.deepEqual((await newer.locator('td').allTextContents()).slice(4, 6), ['Sí', '5,00']);
  assert.match(await page.locator('#projection-local-detail-calculation').innerText(), /15,00 L\/día/);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(requests, 1);
  const missing = page.locator('#purchase-projection-body tr[data-key="D"]');
  await missing.getByRole('button', { name: 'Ver detalle de Inventario Locales de D', exact: true }).click();
  const missingLocal = page.locator('#projection-local-detail-body tr[data-location-id="store-1"]');
  assert.deepEqual((await missingLocal.locator('td').allTextContents()).slice(1, 4), ['0,00', 'UN', '0,00']);
  assert.match(await missingLocal.innerText(), /Se considera 0/);
  assert.doesNotMatch(await page.locator('#projection-local-detail-calculation').innerText(), /subtotal|no disponible/);
  await page.keyboard.press('Escape');
  // Sorting uses the displayed network value, not a store's own mean.
  await page.locator('#projection-locals-daily-header').click();
  assert.equal(await page.locator('#projection-locals-daily-header').getAttribute('aria-sort'), 'descending');
  assert.equal(await page.locator('#purchase-projection-body tr[data-key]').first().getAttribute('data-key'), 'B');
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', items: [{ key: 'A', managed: false, minDays: 7, maxDays: 14 }] }) });
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => !document.getElementById('refresh-purchase-projection').disabled);
  await row.getByRole('button', { name: 'Ver detalle de Consumo Diario Locales de A', exact: true }).click();
  assert.deepEqual((await stable.locator('td').allTextContents()).slice(3, 6), ['10,00', 'No', '0,00']);
  assert.match(await stable.innerText(), /No administrado/);
  assert.match(await page.locator('#projection-local-detail-calculation').innerText(), /150,00 L.*5,00 L\/día.*30,0 días/);
  await page.keyboard.press('Escape');
  assert.equal(requests, 2);
  await page.locator('#projection-location-filter').selectOption('store-2');
  assert.equal(await page.locator('#projection-own-daily-header').isVisible(), true);
  assert.equal(await page.locator('#projection-locals-inventory-header').isVisible(), false);
  assert.equal(requests, 2);
  assert.deepEqual(errors, []);
});

test('projection streams real calculation stages and the same result as a JSON request', async t => {
  const { base, configure, project, json, stocks } = await setup(t);
  setConsolidationInventories(stocks);
  await manageConsolidationItems(json);
  await configure();
  const expected = await project('main-warehouse');
  const response = await fetch(base + '/api/purchase-projections?location=main-warehouse&progress=1');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'progress');
  assert.match(events[0].message, /Leyendo inventario/);
  assert.ok(events.some(event => /Calculando sugerencias/.test(event.message) && event.completed === event.total));
  assert.ok(events.some(event => event.unit === 'cafeterías' && event.completed === 2 && event.total === 2));
  assert.ok(events.some(event => /Consolidando inventario/.test(event.message)));
  assert.equal(events.at(-1).type, 'result');
  assert.deepEqual(events.at(-1).data, expected);
  const invalid = await fetch(base + '/api/purchase-projections?location=missing&progress=1');
  assert.equal(invalid.status, 400);
  stocks['main-warehouse'] = null;
  const failed = await fetch(base + '/api/purchase-projections?location=main-warehouse&progress=1');
  const failureEvents = (await failed.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(failureEvents.at(-1).type, 'error');
  assert.equal(failureEvents.some(event => event.type === 'result'), false);
});

test('UI displays live progress before results, handles errors and cancels when changing location', { skip: !fs.existsSync(chrome), timeout: 20000 }, async t => {
  const { app, base, project } = await setup(t);
  const data = await project('main-warehouse');
  let output, closed;
  app.get('/test-projection-progress', (req, res) => {
    output = res;
    closed = new Promise(resolve => res.once('close', resolve));
    res.set('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ type: 'progress', message: 'Leyendo inventario de Bodega Principal' }) + '\n');
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/purchase-projections?*', route => {
    assert.equal(new URL(route.request().url()).searchParams.get('progress'), '1');
    return route.continue({ url: base + '/test-projection-progress' });
  });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('main-warehouse');
  const refresh = page.locator('#refresh-purchase-projection');
  const progress = page.locator('#purchase-projection-progress');
  const stage = page.locator('#purchase-projection-progress-stage');
  const bar = page.locator('#purchase-projection-progress-bar');
  assert.equal(await progress.isVisible(), false);
  await refresh.click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-progress-stage').textContent.includes('Leyendo inventario'));
  assert.equal(await progress.isVisible(), true);
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await page.locator('#purchase-projection-workspace').getAttribute('aria-busy'), 'true');
  assert.equal(await bar.getAttribute('value'), null);
  assert.equal(await page.locator('#purchase-projection-body tr').count(), 0);
  await page.waitForFunction(() => !document.getElementById('purchase-projection-progress-elapsed').textContent.startsWith('0 s'));
  output.write(JSON.stringify({ type: 'progress', message: 'Nueva procesada', completed: 1, total: 2, unit: 'cafeterías' }) + '\n');
  await page.waitForFunction(() => document.getElementById('purchase-projection-progress-bar').value === 50);
  assert.match(await stage.innerText(), /1 de 2 cafeterías/);
  const bytes = Buffer.from(JSON.stringify({ type: 'result', data }));
  const accent = bytes.indexOf(Buffer.from('ó'));
  const split = accent >= 0 ? accent + 1 : Math.floor(bytes.length / 2);
  output.write(bytes.subarray(0, split));
  await new Promise(resolve => setImmediate(resolve));
  output.end(bytes.subarray(split));
  await page.waitForFunction(() => !document.getElementById('refresh-purchase-projection').disabled);
  assert.match(await stage.innerText(), /Carga completada/);
  assert.equal(await bar.getAttribute('value'), '100');
  assert.equal(await page.locator('#purchase-projection-workspace').getAttribute('aria-busy'), 'false');
  await refresh.click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-progress-stage').textContent.includes('Leyendo inventario'));
  output.end(JSON.stringify({ type: 'error', error: 'No se pudo leer el inventario de prueba.' }) + '\n');
  await page.waitForFunction(() => !document.getElementById('refresh-purchase-projection').disabled);
  assert.match(await page.locator('#purchase-projection-status').innerText(), /No se pudo leer el inventario de prueba/);
  assert.equal(await progress.isVisible(), false);
  await refresh.click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-progress-stage').textContent.includes('Leyendo inventario'));
  output.end();
  await page.waitForFunction(() => !document.getElementById('refresh-purchase-projection').disabled);
  assert.match(await page.locator('#purchase-projection-status').innerText(), /La carga se interrumpió/);
  await refresh.click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-progress-stage').textContent.includes('Leyendo inventario'));
  await page.locator('#projection-location-filter').selectOption('store-2');
  await closed;
  assert.equal(await progress.isVisible(), false);
  assert.equal(await refresh.isDisabled(), false);
  assert.match(await page.locator('#purchase-projection-status').innerText(), /Presiona Actualizar/);
  assert.deepEqual(errors, []);
});

test('projection headers and first four columns stay fixed when scrolling and resizing', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('main-warehouse');
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('Consumo considerado'));
  await page.locator('#projection-only-required').uncheck();
  await page.evaluate(() => {
    const base = purchaseProjectionState.items.find(item => item.key === 'A');
    purchaseProjectionState.items = Array.from({ length: 60 }, (_, index) => ({ ...base,
      key: `A-${index}`, code: `A-${index}`, name: `Ingrediente para verificar desplazamiento ${index}` }));
    renderPurchaseProjection();
  });
  const wrap = page.locator('.purchase-projection-table-wrap');
  await wrap.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const waitForOffsets = () => page.waitForFunction(() => {
    const table = document.querySelector('.purchase-projection-table');
    const headers = [...table.tHead.rows[0].cells];
    const expected = headers.slice(0, 3).reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0);
    return Math.abs(parseFloat(table.style.getPropertyValue('--projection-sticky-left-4')) - expected) < 1;
  });
  await waitForOffsets();
  const snapshot = () => wrap.evaluate(element => {
    const headers = [...element.querySelectorAll('thead th')].slice(0, 5);
    const cells = [...element.querySelector('tbody tr[data-key]').cells].slice(0, 5);
    const rect = cell => ({ left: cell.getBoundingClientRect().left, right: cell.getBoundingClientRect().right,
      top: cell.getBoundingClientRect().top, position: getComputedStyle(cell).position });
    return { headers: headers.map(rect), cells: cells.map(rect),
      horizontal: element.scrollWidth > element.clientWidth, vertical: element.scrollHeight > element.clientHeight };
  });
  const before = await snapshot();
  assert.equal(before.horizontal, true);
  assert.equal(before.vertical, true);
  await wrap.evaluate(element => { element.scrollLeft = 350; element.scrollTop = 220; });
  const after = await snapshot();
  for (let index = 0; index < 4; index++) {
    assert.equal(after.headers[index].position, 'sticky');
    assert.equal(after.cells[index].position, 'sticky');
    assert.ok(Math.abs(after.headers[index].top - before.headers[index].top) < 1);
    assert.ok(Math.abs(after.headers[index].left - before.headers[index].left) < 1);
    assert.ok(Math.abs(after.cells[index].left - before.cells[index].left) < 1);
    assert.ok(Math.abs(after.headers[index].left - after.cells[index].left) < 1);
    if (index > 0) assert.ok(Math.abs(after.cells[index].left - after.cells[index - 1].right) < 1);
  }
  assert.ok(Math.abs(after.headers[4].top - before.headers[4].top) < 1);
  assert.ok(Math.abs(after.cells[4].left - (before.cells[4].left - 350)) < 1);
  assert.ok(Math.abs(after.cells[0].top - (before.cells[0].top - 220)) < 1);
  assert.equal(await wrap.evaluate(element => {
    const header = element.querySelectorAll('thead th')[3];
    const rect = header.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('th') === header;
  }), true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '1.2'));
  await waitForOffsets();
  const resized = await snapshot();
  for (let index = 0; index < 4; index++) {
    assert.ok(Math.abs(resized.headers[index].left - resized.cells[index].left) < 1);
    if (index > 0) assert.ok(Math.abs(resized.cells[index].left - resized.cells[index - 1].right) < 1);
  }
  await page.locator('.purchase-projection-table th[data-sort-key="code"]').click();
  assert.equal(await page.locator('.purchase-projection-table th[data-sort-key="code"]').getAttribute('aria-sort'), 'ascending');
  assert.deepEqual(errors, []);
});

test('UI ingredient master preserves drafts through search and only refreshes projection when requested', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, root } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  let projectionRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchase-projections') projectionRequests += 1; });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('store-2');
  const open = page.locator('#open-ingredient-purchase-master');
  const dialog = page.locator('#ingredient-purchase-master-dialog');
  const row = page.locator('#ingredient-purchase-master-body tr[data-code="A"]');
  const search = page.locator('#ingredient-purchase-master-search');
  await open.click();
  await row.waitFor();
  assert.equal(await row.locator('td').nth(2).innerText(), 'L');
  assert.equal(await row.locator('td').nth(2).locator('input,select').count(), 0);
  for (const label of ['Botella', 'Bidón', 'Pack', 'Caja', 'Bolsa', 'Lata']) {
    assert.ok((await row.locator('select option').allTextContents()).includes(label));
  }
  await row.locator('select').selectOption('Botella');
  await row.locator('input').fill('0.75');
  assert.match(await row.locator('.ingredient-master-equivalence').innerText(), /1 Botella = 0,75 L/);
  await search.fill('incompatible');
  assert.equal(await page.locator('#ingredient-purchase-master-body tr').count(), 1);
  await search.fill('A');
  assert.equal(await row.locator('input').inputValue(), '0.75');
  await page.locator('#close-ingredient-purchase-master').click();
  assert.equal(fs.existsSync(path.join(root, 'config', 'purchase-unit-configuration.json')), false);
  await open.click();
  await row.waitFor();
  assert.equal(await row.locator('select').inputValue(), 'L');
  await row.locator('select').selectOption('Botella');
  await row.locator('input').fill('0');
  await page.locator('#save-ingredient-purchase-master').click();
  assert.match(await page.locator('#ingredient-purchase-master-status').innerText(), /mayor que 0/);
  await row.locator('input').fill('0.75');
  await page.locator('#save-ingredient-purchase-master').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(projectionRequests, 0);
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('Consumo considerado'));
  assert.equal(projectionRequests, 1);
  const cells = await page.locator('#purchase-projection-body tr[data-key="A"] td').allTextContents();
  assert.deepEqual(cells.slice(4, 7), ['L', 'Botella', '0,75 L']);
  const keys = await page.locator('.purchase-projection-table th').evaluateAll(headers => headers.slice(4, 7).map(header => header.dataset.sortKey));
  assert.deepEqual(keys, ['internalUnit', 'purchaseUnit', 'unitsPerPurchaseUnit']);
  assert.deepEqual(errors, []);
});

test('UI saves reference configuration without loading projection, then shows comparable consumption on refresh', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  let projectionRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchase-projections') projectionRequests += 1; });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('store-2');
  const open = page.locator('#configure-consumption-reference');
  await open.click();
  await page.waitForFunction(() => !document.getElementById('consumption-reference-enabled').disabled);
  assert.match(await page.locator('#consumption-reference-opening').innerText(), /20.*sept.*2026/);
  await page.locator('#consumption-reference-enabled').check();
  assert.equal(await page.locator('#save-consumption-reference').isDisabled(), true);
  await page.locator('#consumption-reference-source').selectOption('store-1');
  await page.locator('#consumption-reference-curve').selectOption('50-75');
  assert.match(await page.locator('#consumption-reference-stage').innerText(), /50%/);
  assert.match(await page.locator('#consumption-reference-end').innerText(), /20.*nov.*2026/);
  await page.locator('#save-consumption-reference').click();
  await page.locator('#consumption-reference-dialog').waitFor({ state: 'hidden' });
  assert.equal(projectionRequests, 0);
  assert.equal(await page.locator('#purchase-projection-body tr').count(), 0);
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('Consumo considerado'));
  assert.equal(projectionRequests, 1);
  assert.match(await page.locator('#purchase-projection-reference').innerText(), /Estable.*50%.*20.*nov/);
  const row = page.locator('#purchase-projection-body tr[data-key="A"]');
  const cells = await row.locator('td').allTextContents();
  assert.deepEqual(cells.slice(9, 13), ['21,00', '3,00', '5,00', '5,00']);
  assert.equal(await page.locator('#projection-reference-daily-header').isVisible(), true);
  const headers = await page.locator('.purchase-projection-table th:visible').allTextContents();
  assert.deepEqual(headers.slice(10, 13).map(text => text.replace(/\s+/g, ' ').trim()),
    ['Promediodiario', 'Prom DiarioSustitutivo', 'Promedio Diarioutilizado para Reposición']);
  assert.equal(headers.some(text => /proyectados del período|utilizados para reposición/.test(text)), false);
  const ownWins = await page.locator('#purchase-projection-body tr[data-key="B"] td').allTextContents();
  assert.deepEqual(ownWins.slice(9, 13), ['49,00', '7,00', '5,00', '7,00']);
  // Tentative orders consume the same server projection and its effective daily demand.
  const tentative = await page.evaluate(() => {
    const item = purchaseProjectionState.items.find(item => item.key === 'A');
    item.managed = true;
    return tentativeGroupsForProjection(purchaseProjectionState)[0].buyingItems.find(item => item.key === 'A');
  });
  assert.equal(tentative.averageDailyConsumption, 5);
  assert.equal(tentative.quantity, 73);
  await open.click();
  await page.waitForFunction(() => !document.getElementById('consumption-reference-enabled').disabled);
  assert.equal(await page.locator('#consumption-reference-enabled').isChecked(), true);
  await page.locator('#consumption-reference-enabled').uncheck();
  await page.locator('#save-consumption-reference').click();
  await page.locator('#consumption-reference-dialog').waitFor({ state: 'hidden' });
  assert.equal(projectionRequests, 1);
  assert.equal(await page.locator('#projection-reference-daily-header').isVisible(), false);
  await page.locator('#projection-location-filter').selectOption('main-warehouse');
  assert.equal(await open.isDisabled(), true);
  assert.deepEqual(errors, []);
});
