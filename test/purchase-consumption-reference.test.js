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
    if (location === 'store-2') assert.ok(projection.items.every(item => item.transferConfigured), 'all orderable ingredients receive a transfer definition');
    assert.equal(projection.items.some(item => excluded.includes(item.key)), false);
  }
});

test('projections include every catalog ingredient and permit manual orders without inventing stock or reference-driven needs', async t => {
  const { root, stocks, json, project, configure } = await setup(t);
  const file = path.join(root, 'masters', 'catalog.xlsx'), book = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Ingr, { header: 1 });
  rows.push(['E', 'Ingrediente nuevo', 1, 200, 'UN']);
  book.Sheets.Ingr = XLSX.utils.aoa_to_sheet(rows); XLSX.writeFile(book, file);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'E', internalUnit: 'UN', purchaseUnit: 'Caja', unitsPerPurchaseUnit: 10,
      transferUnit: 'Pack', unitsPerTransferUnit: 2 }] }) });
  for (const location of ['store-2', 'main-warehouse']) await json('/api/purchase-projections/policies', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location, items: [{ key: 'E', supplierKey: '111', managed: true, minDays: 7, maxDays: 14, unitsPerPackage: 3 }] })
  });
  // Only the reference store has movements for E. A missing local stock must
  // not be treated as zero to turn that reference consumption into an order.
  stocks['store-1'].daily.push(...stocks['store-1'].daily.filter(row => row.code === 'B')
    .map(row => ({ ...row, code: 'E', name: 'Ingrediente nuevo', unit: 'UN', use: 2 })));
  await configure();
  for (const [location, unit, conversion] of [['store-2', 'Pack', 2], ['main-warehouse', 'Caja', 10]]) {
    const projection = await project(location);
    assert.deepEqual(projection.items.map(item => item.key).sort(), ['A', 'B', 'C', 'D', 'E']);
    const item = projection.items.find(item => item.key === 'E');
    assert.equal(item.hasInventoryHistory, false);
    assert.equal(item.currentInventory, null);
    assert.equal(item.currentCoverageDays, null);
    assert.equal(item.needsPurchase, false);
    assert.equal(item.suggestedPurchaseUnits, null);
    assert.deepEqual([item.purchaseUnit, item.unitsPerPurchaseUnit], [unit, conversion]);
    assert.ok(projection.summary.catalogOnlyItemCount >= 1);
    if (location === 'store-2') {
      assert.ok(item.projectedAverageDailyConsumption > 0);
      const saved = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, supplierKey: '111', projectionId: projection.projectionId, useTransferUnits: true,
          items: [{ key: 'E', quantity: 6, unitCost: 400, purchaseUnit: 'Pack', unitsPerPurchaseUnit: 2, internalUnit: 'UN' }] }) });
      assert.deepEqual([saved.items[0].internalQuantity, saved.total], [12, 2400]);
    } else assert.equal(item.totalInventory, null);
  }
  // A synchronized ledger with no item rows still exposes the complete catalog.
  stocks['store-2'].daily = [];
  const empty = await project();
  assert.equal(empty.items.length, 5);
  assert.ok(empty.items.every(item => item.currentInventory === null && !item.needsPurchase));
});

test('UI lists a new ingredient, saves its supplier and creates a manual order without inventory history', { skip: !fs.existsSync(chrome) }, async t => {
  const { root, base, app, json } = await setup(t);
  const file = path.join(root, 'masters', 'catalog.xlsx'), book = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Ingr, { header: 1 });
  rows.push(['E', 'Ingrediente nuevo', 1, 200, 'UN']); book.Sheets.Ingr = XLSX.utils.aoa_to_sheet(rows); XLSX.writeFile(book, file);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'E', internalUnit: 'UN', purchaseUnit: 'Caja', unitsPerPurchaseUnit: 10,
      transferUnit: 'Pack', unitsPerTransferUnit: 2 }] }) });
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('dialog', dialog => dialog.accept());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('store-2');
  await page.locator('#refresh-purchase-projection').click();
  await page.waitForFunction(() => purchaseProjectionState !== null);
  const row = page.locator('#purchase-projection-body tr[data-key="E"]');
  assert.equal(await row.count(), 0, 'the needs-only filter still applies');
  await page.locator('#show-all-projection-ingredients').click();
  await row.waitFor();
  assert.match(await row.innerText(), /Ingrediente nuevo.*Sin inventario verificable/s);
  await row.locator('.projection-supplier-input').selectOption('111');
  await row.locator('.projection-managed-input').check();
  await row.locator('.projection-package-input').fill('3');
  assert.equal(await page.evaluate(() => purchaseProjectionState.items.find(item => item.key === 'E').needsPurchase), false);
  app.locals.toteatStockSync.current = () => { throw Error('Saving a new ingredient and its order must reuse the projection'); };
  await page.locator('#save-projection-policies').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('guardados correctamente'));
  await page.locator('#projection-supplier-filter').selectOption('111');
  await page.locator('#print-purchase-order').click();
  const editor = page.locator('#purchase-order-editor-body tr[data-key="E"]');
  assert.equal(await editor.locator('.purchase-order-select').isChecked(), false);
  assert.match(await editor.locator('.purchase-order-inventory').innerText(), /Sin datos/);
  for (const checkbox of await page.locator('#purchase-order-editor-body .purchase-order-select').all()) {
    if (await checkbox.isChecked()) await checkbox.uncheck();
  }
  await editor.locator('.purchase-order-select').check();
  assert.equal(await editor.locator('.purchase-order-quantity').inputValue(), '3');
  await editor.locator('.purchase-order-quantity').fill('6');
  await editor.locator('.purchase-order-cost').fill('400');
  await page.locator('#confirm-purchase-order').click();
  await page.waitForFunction(() => document.getElementById('purchase-order-editor-status').textContent.includes('guardada correctamente'));
  const list = await json('/api/purchase-orders?location=store-2');
  assert.equal(list.orders.length, 1);
  const saved = await json(`/api/purchase-orders/${list.orders[0].id}`);
  assert.deepEqual(saved.items.map(item => [item.key, item.purchaseUnit, item.internalQuantity]), [['E', 'Pack', 12]]);
  assert.equal(saved.total, 2400);
  assert.deepEqual(errors, []);
});

test('legacy multiples migrate to supply units once, copy with their basis, and orders enforce the allowed supply multiple', async t => {
  const { root, json, project, base } = await setup(t);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [
      { code: 'A', internalUnit: 'L', purchaseUnit: 'Botella', unitsPerPurchaseUnit: 1.36 },
      { code: 'D', internalUnit: 'UN', purchaseUnit: 'Caja', unitsPerPurchaseUnit: 1000 }
    ] }) });
  const policyFile = path.join(root, 'config', 'purchase-projection-policies.json');
  fs.writeFileSync(policyFile, JSON.stringify({ locations: { 'store-2': { items: {
    A: { minDays: 7, maxDays: 14, unitsPerPackage: 1, supplierKey: '111', managed: true },
    D: { minDays: 7, maxDays: 14, unitsPerPackage: 1000, managed: true }
  } } } }));
  const before = fs.readFileSync(policyFile, 'utf8');
  const legacy = await project();
  for (const code of ['A', 'D']) {
    const item = legacy.items.find(item => item.code === code);
    assert.equal(item.unitsPerPackage, 1);
    assert.equal(item.unitsPerPackageBasis, 'purchase');
  }
  assert.equal(fs.readFileSync(policyFile, 'utf8'), before); // Reading converts without rewriting saved criteria.
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', items: legacy.items.map(item => ({ ...item, unitsPerPackage: item.code === 'A' ? 6 : item.unitsPerPackage })) }) });
  const saved = JSON.parse(fs.readFileSync(policyFile, 'utf8')).locations['store-2'].items;
  assert.equal(saved.D.unitsPerPackage, 1);
  assert.equal(saved.D.unitsPerPackageBasis, 'purchase');
  const projection = await project();
  const a = projection.items.find(item => item.code === 'A');
  assert.equal(a.unitsPerPackage, 6);
  assert.equal(a.suggestedPurchaseUnits, 36);
  assert.equal(a.suggestedInternalQuantity, 48.96);
  assert.equal(a.estimatedTotal, 36 * a.estimatedPurchaseUnitCost);
  assert.equal(projection.items.find(item => item.code === 'D').unitsPerPackage, 1);
  await json('/api/purchase-projections/policies/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', sourceLocation: 'store-2', confirmed: true }) });
  assert.equal((await project('store-1')).items.find(item => item.code === 'A').unitsPerPackage, 6);
  const create = quantity => fetch(base + '/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', items: [{ key: 'A', quantity, unitCost: a.estimatedPurchaseUnitCost }] }) });
  const invalid = await create(37);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /múltiplo de 6 Botella/);
  assert.equal((await json('/api/purchase-orders?location=store-2')).orders.length, 0);
  const order = await (await create(36)).json();
  assert.equal(order.items[0].quantity, 36);
  assert.equal(order.items[0].internalQuantity, 48.96);
  assert.equal(order.items[0].unitsPerPackageBasis, 'purchase');
  const invalidUpdate = await fetch(base + `/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ key: 'A', quantity: 37, unitCost: a.estimatedPurchaseUnitCost }] }) });
  assert.equal(invalidUpdate.status, 400);
  assert.equal((await json(`/api/purchase-orders/${order.id}`)).items[0].quantity, 36);
});

test('orders save and update the reviewed warehouse projection without recalculating cafeteria inventories', async t => {
  const { app, root, project, json, base } = await setup(t);
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'main-warehouse', items: [{ key: 'A', supplierKey: '111',
      minDays: 7, maxDays: 14, managed: true, unitsPerPackage: 3 }] }) });
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'A', internalUnit: 'L', purchaseUnit: 'Botella', unitsPerPurchaseUnit: 2 }] }) });
  const projection = await project('main-warehouse');
  assert.ok(projection.projectionId);
  let recalculations = 0;
  app.locals.toteatStockSync.current = () => { recalculations++; throw Error('Do not recalculate inventory while saving'); };
  const send = (payload, orderId) => fetch(base + '/api/purchase-orders' + (orderId ? '/' + orderId : ''), {
    method: orderId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'main-warehouse', supplierKey: '111', projectionId: projection.projectionId, ...payload })
  });
  const items = [{ key: 'A', quantity: 3, unitCost: 120, unitsPerPurchaseUnit: 999 }];
  assert.equal((await send({ items, projectionId: 'missing' })).status, 409);
  assert.equal((await send({ items, location: 'store-2' })).status, 409);
  assert.equal((await send({ items: [{ key: 'D', quantity: 3, unitCost: 120 }] })).status, 400);
  assert.equal((await send({ items: [{ key: 'A', quantity: 4, unitCost: 120 }] })).status, 400);
  const response = await send({ items });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.total, 360);
  assert.equal(saved.items[0].internalQuantity, 6);
  assert.equal(saved.items[0].unitsPerPurchaseUnit, 2);
  assert.equal((await json('/api/purchase-orders?location=main-warehouse')).orders[0].id, saved.id);
  const file = path.join(root, 'reports', 'purchase-orders', saved.id + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).items[0].internalQuantity, 6);
  const updatedResponse = await send({ items: [{ ...items[0], quantity: 6 }] }, saved.id);
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.items[0].internalQuantity, 12);
  assert.equal(updated.total, 720);
  assert.equal((await json('/api/purchase-orders/' + saved.id)).total, 720);
  assert.equal(JSON.parse(fs.readFileSync(file)).total, 720);
  // Reopening without a loaded projection can still edit saved lines directly.
  const updateWithoutProjection = items => fetch(base + '/api/purchase-orders/' + saved.id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  assert.equal((await updateWithoutProjection([{ key: 'A', quantity: 4, unitCost: 120 }])).status, 400);
  assert.equal((await updateWithoutProjection([{ key: 'D', quantity: 3, unitCost: 120 }])).status, 400);
  const directUpdate = await updateWithoutProjection([{ key: 'A', quantity: 9, unitCost: 120, unitsPerPurchaseUnit: 999 }]);
  assert.equal(directUpdate.status, 200);
  const directOrder = await directUpdate.json();
  assert.equal(directOrder.items[0].internalQuantity, 18);
  assert.equal(directOrder.total, 1080);
  const savedCriteria = await json('/api/purchase-projections/policies', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'main-warehouse', projectionId: projection.projectionId,
      items: [{ key: 'A', supplierKey: '111', minDays: 5, maxDays: 20, managed: true, unitsPerPackage: 6 }] })
  });
  assert.deepEqual(savedCriteria.clearedCostKeys, []);
  assert.equal((await send({ items: [{ key: 'A', quantity: 3, unitCost: 120 }] })).status, 400);
  const orderWithNewMultiple = await send({ items: [{ key: 'A', quantity: 6, unitCost: 120 }] });
  assert.equal(orderWithNewMultiple.status, 201);
  assert.equal((await orderWithNewMultiple.json()).items[0].unitsPerPackage, 6);
  assert.equal(recalculations, 0);
});

test('missing transfers are copied and persisted from supply units once, including newly encountered ingredients', async t => {
  const { root, app, json } = await setup(t);
  const file = path.join(root, 'config', 'purchase-unit-configuration.json');
  fs.writeFileSync(file, JSON.stringify({ items: {
    D: { purchaseUnit: 'Pack', unitsPerPurchaseUnit: 25, internalUnit: 'UN' },
    B: { purchaseUnit: 'Bidón', unitsPerPurchaseUnit: 3, internalUnit: 'L',
      transfer: { purchaseUnit: 'Botella', unitsPerPurchaseUnit: .5, internalUnit: 'L' } }
  } }));
  const masterFile = path.join(root, 'masters', 'catalog.xlsx'), originalMaster = fs.readFileSync(masterFile);
  const master = await json('/api/purchase-projections/ingredient-master');
  const item = master.items.find(item => item.code === 'D');
  assert.deepEqual([item.transferUnit, item.unitsPerTransferUnit, item.transferConfigured], ['Pack', 25, true]);
  let registry = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(registry.items.D.transfer, { purchaseUnit: 'Pack', unitsPerPurchaseUnit: 25, internalUnit: 'UN' });
  assert.deepEqual(registry.items.B.transfer, { purchaseUnit: 'Botella', unitsPerPurchaseUnit: .5, internalUnit: 'L' });
  const firstCopy = fs.readFileSync(file, 'utf8');
  await json('/api/purchase-projections/ingredient-master');
  assert.equal(fs.readFileSync(file, 'utf8'), firstCopy, 'reading an initialized master does not rewrite it');
  const save = items => json('/api/purchase-projections/ingredient-master', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  await save([{ code: 'D', internalUnit: 'UN', purchaseUnit: 'Pack', unitsPerPurchaseUnit: 50 }]);
  assert.equal(JSON.parse(fs.readFileSync(file)).items.D.transfer.unitsPerPurchaseUnit, 25, 'the copied transfer is independent');
  await save([{ code: 'D', internalUnit: 'UN', transferUnit: '', unitsPerTransferUnit: null }]);
  assert.equal(JSON.parse(fs.readFileSync(file)).items.D.transfer.unitsPerPurchaseUnit, 50, 'a missing transfer is filled again');
  assert.deepEqual(fs.readFileSync(masterFile), originalMaster);
  const book = XLSX.readFile(masterFile), rows = XLSX.utils.sheet_to_json(book.Sheets.Ingr, { header: 1 });
  rows.push(['E', 'Nuevo ingrediente', 1, 20, 'UN']); book.Sheets.Ingr = XLSX.utils.aoa_to_sheet(rows); XLSX.writeFile(book, masterFile);
  registry = JSON.parse(fs.readFileSync(file));
  registry.items.E = { purchaseUnit: 'Caja', unitsPerPurchaseUnit: 100, internalUnit: 'UN' };
  fs.writeFileSync(file, JSON.stringify(registry));
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', items: [{ key: 'E', supplierKey: '111', unitsPerPackage: 1, managed: false, minDays: 7, maxDays: 14 }] }) });
  app.locals.toteatStockSync.current = () => { throw Error('Replicating units must not process stock'); };
  const catalog = await json('/api/purchase-projections/supplier-items?location=store-2&supplier=111');
  const added = catalog.items.find(item => item.key === 'E');
  assert.deepEqual([added.purchaseUnit, added.unitsPerPurchaseUnit, added.transferConfigured], ['Caja', 100, true]);
  assert.equal(JSON.parse(fs.readFileSync(file)).items.E.transfer.unitsPerPurchaseUnit, 100);
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
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(item => ({ ...item, transferUnit: item.purchaseUnit, unitsPerTransferUnit: item.unitsPerPurchaseUnit })) })
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

test('warehouse buying and cafeteria transfer units have independent conversions, costs and saved orders', async t => {
  const { root, json, project } = await setup(t);
  const save = items => json('/api/purchase-projections/ingredient-master', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
  });
  await save([{ code: 'A', internalUnit: 'L', purchaseUnit: 'Bidón', unitsPerPurchaseUnit: 3,
    transferUnit: 'Botella', unitsPerTransferUnit: .75 }]);
  const master = (await json('/api/purchase-projections/ingredient-master')).items.find(item => item.code === 'A');
  assert.deepEqual([master.purchaseUnit, master.unitsPerPurchaseUnit, master.transferUnit, master.unitsPerTransferUnit],
    ['Bidón', 3, 'Botella', .75]);
  const savedOrders = [];
  for (const [id, unit, conversion, cost] of [
    ['main-warehouse', 'Bidón', 3, 300], ['store-2', 'Botella', .75, 75], ['store-1', 'Botella', 750, 75]
  ]) {
    const projection = await project(id), item = projection.items.find(item => item.key === 'A');
    assert.deepEqual([item.purchaseUnit, item.unitsPerPurchaseUnit, item.estimatedPurchaseUnitCost], [unit, conversion, cost]);
    if (item.needsPurchase) assert.equal(item.suggestedInternalQuantity, item.suggestedPurchaseUnits * conversion);
    const order = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: id, projectionId: projection.projectionId, supplierKey: item.supplierKey,
        items: [{ key: 'A', quantity: 2, unitCost: cost, purchaseUnit: 'INVALID', unitsPerPurchaseUnit: 999 }] }) });
    assert.deepEqual([order.items[0].purchaseUnit, order.items[0].internalQuantity, order.items[0].total],
      [unit, 2 * conversion, 2 * cost]);
    savedOrders.push(order);
  }
  // Updating or restoring one presentation leaves the other independent.
  await save([{ code: 'A', internalUnit: 'L', purchaseUnit: 'Pack', unitsPerPurchaseUnit: 6 }]);
  assert.equal((await project()).items.find(item => item.key === 'A').unitsPerPurchaseUnit, .75);
  await save([{ code: 'A', internalUnit: 'L', purchaseUnit: '', unitsPerPurchaseUnit: null }]);
  assert.equal((await project('main-warehouse')).items.find(item => item.key === 'A').unitsPerPurchaseUnit, 1);
  assert.equal((await project()).items.find(item => item.key === 'A').unitsPerPurchaseUnit, .75);
  await save([{ code: 'A', internalUnit: 'L', transferUnit: '', unitsPerTransferUnit: null }]);
  assert.equal((await project()).items.find(item => item.key === 'A').unitsPerPurchaseUnit, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config', 'purchase-unit-configuration.json'))).items.A.transfer,
    { purchaseUnit: 'L', unitsPerPurchaseUnit: 1, internalUnit: 'L' });
  for (const order of savedOrders) {
    assert.deepEqual((await json(`/api/purchase-orders/${order.id}`)).items, order.items);
    const edited = await json(`/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ key: 'A', quantity: 3, unitCost: order.items[0].unitCost }] }) });
    assert.equal(edited.items[0].purchaseUnit, order.location.type === 'store' ? 'L' : order.items[0].purchaseUnit);
    assert.equal(edited.items[0].internalQuantity, 3 * (order.location.type === 'store'
      ? order.items[0].internalUnit === 'ML' ? 1000 : 1 : order.items[0].unitsPerPurchaseUnit));
  }
});

test('saved cafeteria order editing and stale supplier snapshots use current transfer units and reject an old unit basis', async t => {
  const { base, json, project } = await setup(t);
  const projection = await project();
  const order = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', projectionId: projection.projectionId,
      items: [{ key: 'A', quantity: 2, unitCost: 100 }] }) });
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'A', internalUnit: 'L', purchaseUnit: 'Bidón', unitsPerPurchaseUnit: 3,
      transferUnit: 'Botella', unitsPerTransferUnit: .25 }] }) });
  const opened = await json(`/api/purchase-orders/${order.id}`);
  assert.deepEqual(opened.items, order.items, 'opening keeps the stored order intact');
  assert.deepEqual([opened.editingItems[0].purchaseUnit, opened.editingItems[0].quantity, opened.editingItems[0].unitCost], ['Botella', 8, 25]);
  const catalog = await json(`/api/purchase-projections/supplier-items?location=store-2&supplier=111&projectionId=${projection.projectionId}`);
  assert.equal(catalog.items.find(item => item.key === 'A').purchaseUnit, 'Botella');
  const update = item => fetch(`${base}/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ useTransferUnits: true, items: [item] }) });
  const rejected = await update({ key: 'A', quantity: 2, unitCost: 100, purchaseUnit: 'L', unitsPerPurchaseUnit: 1, internalUnit: 'L' });
  assert.equal(rejected.status, 409);
  assert.deepEqual((await json(`/api/purchase-orders/${order.id}`)).items, order.items);
  const saved = await update({ key: 'A', quantity: 8, unitCost: 25, purchaseUnit: 'Botella', unitsPerPurchaseUnit: .25, internalUnit: 'L' });
  assert.equal(saved.status, 200);
  const data = await saved.json();
  assert.deepEqual([data.items[0].purchaseUnit, data.items[0].internalQuantity, data.total], ['Botella', 2, 200]);
});

test('transfer costs use the configured buying presentation when invoice packaging is absent from the catalog', async t => {
  const { root, json, project } = await setup(t);
  const file = path.join(root, 'purchases.xlsx'), book = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Compras, { header: 1 });
  rows[1][9] = 'Pack'; rows[1][10] = 2400; rows[1][11] = 2400; rows[1][13] = 2400;
  book.Sheets.Compras = XLSX.utils.aoa_to_sheet(rows); XLSX.writeFile(book, file);
  for (const transferUnit of ['Pack', 'Botella']) {
    await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ code: 'A', internalUnit: 'L', purchaseUnit: 'Pack', unitsPerPurchaseUnit: 12,
        transferUnit, unitsPerTransferUnit: 3 }] }) });
    const warehouse = (await project('main-warehouse')).items.find(item => item.key === 'A');
    const store = (await project()).items.find(item => item.key === 'A');
    assert.equal(warehouse.estimatedPurchaseUnitCost, 2400);
    assert.equal(store.estimatedPurchaseUnitCost, 600, `${transferUnit}: 2400 / 12 L × 3 L`);
    assert.equal(store.purchaseUnit, transferUnit);
  }
});

test('transfer equivalences reject invalid batches atomically and preserve the purchase presentation', async t => {
  const { root, base, json } = await setup(t);
  const url = '/api/purchase-projections/ingredient-master';
  await json(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'A', internalUnit: 'L', purchaseUnit: 'Bidón', unitsPerPurchaseUnit: 3 }] }) });
  const file = path.join(root, 'config', 'purchase-unit-configuration.json'), before = fs.readFileSync(file, 'utf8');
  const valid = { code: 'A', internalUnit: 'L', transferUnit: 'Botella', unitsPerTransferUnit: .75 };
  for (const patch of [{ transferUnit: 'Invalid' }, { unitsPerTransferUnit: 0 }, { unitsPerTransferUnit: -1 },
    { unitsPerTransferUnit: null }, { unitsPerTransferUnit: true }, { unitsPerTransferUnit: 'bad' }, { unitsPerTransferUnit: 1e10 }]) {
    const response = await fetch(base + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ ...valid, code: 'B' }, { ...valid, ...patch }] }) });
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('ingredient buying-unit configuration needs no stock and rejects invalid batches atomically', async t => {
  const { root, stocks, base, json } = await setup(t);
  stocks['store-1'] = null;
  stocks['store-2'] = null;
  assert.equal((await json('/api/purchase-projections/ingredient-master')).items.length, 4);
  const configurationFile = path.join(root, 'config', 'purchase-unit-configuration.json');
  const before = fs.readFileSync(configurationFile, 'utf8');
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
    assert.equal(fs.readFileSync(configurationFile, 'utf8'), before);
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
  assert.equal(item.rawSuggestedInternalQuantity, 73);
  assert.equal(item.suggestedInternalQuantity, 84);
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
    ['100,00 L', '50,00', '150,00', '0,00', '15,00', '10,0 días']);
  assert.equal(await page.locator('#projection-own-daily-header').isVisible(), false);
  assert.equal(await page.locator('#projection-locals-inventory-header').isVisible(), true);
  assert.equal(await row.locator('.projection-suggested-consumption').innerText(), '0 L');
  assert.equal(await row.locator('.projection-suggestion-coverage').innerText(), '10,0 días');
  assert.match(await row.locator('.projection-suggestion-coverage').getAttribute('title'), /Inventario Total.*Consumo Diario Locales/);
  assert.equal(await row.locator('td').count(), await page.locator('.purchase-projection-table th:visible').count());
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
  assert.ok(events.at(-1).data.projectionId);
  assert.notEqual(events.at(-1).data.projectionId, expected.projectionId);
  assert.deepEqual({ ...events.at(-1).data, projectionId: null }, { ...expected, projectionId: null });
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
  const { base, root, app, json } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  let projectionRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchase-projections') projectionRequests += 1; });
  // Reproduce a running server that predates the new asset route.
  await page.route('**/ingredient-master-export.js', route => route.fulfill({ status: 404, body: 'Cannot GET /ingredient-master-export.js' }));
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
  await row.locator('.ingredient-master-purchase-unit').selectOption('Botella');
  await row.locator('.ingredient-master-content').fill('0.75');
  await row.locator('.ingredient-master-transfer-unit').selectOption('Botella');
  await row.locator('.ingredient-master-transfer-content').fill('0.75');
  assert.match(await row.locator('.ingredient-master-equivalence').innerText(), /1 Botella = 0,75 L/);
  await search.fill('incompatible');
  assert.equal(await page.locator('#ingredient-purchase-master-body tr').count(), 1);
  await search.fill('A');
  assert.equal(await row.locator('.ingredient-master-content').inputValue(), '0.75');
  await search.fill('leche');
  for (const format of ['pdf', 'csv', 'xlsx']) {
    const ready = page.waitForEvent('download');
    await page.locator(`#ingredient-purchase-master-${format}`).click();
    const download = await ready;
    assert.equal(download.suggestedFilename(), `maestro-ingredientes.${format}`);
    const bytes = fs.readFileSync(await download.path());
    if (format === 'pdf') {
      assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    } else {
      const book = XLSX.read(format === 'csv' ? bytes.toString('utf8') : bytes,
        format === 'csv' ? { type: 'string', raw: true } : {});
      const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[1].slice(0, 4), ['A', 'Leche', 'L', 'Botella']);
      assert.equal(rows[1][4], format === 'csv' ? '0,75' : .75);
      assert.equal(rows[1][5], '1 Botella = 0,75 L');
    }
    assert.match(await page.locator('#ingredient-purchase-master-status').innerText(), /1 ingrediente exportado.*Incluye cambios sin guardar/);
  }
  await search.fill('no existe');
  for (const format of ['pdf', 'csv', 'xlsx']) assert.equal(await page.locator(`#ingredient-purchase-master-${format}`).isDisabled(), true);
  await search.fill('leche');
  await row.locator('.ingredient-master-content').fill('0');
  await page.locator('#ingredient-purchase-master-csv').click();
  assert.match(await page.locator('#ingredient-purchase-master-status').innerText(), /mayor que 0/);
  assert.equal(projectionRequests, 0);
  await page.locator('#close-ingredient-purchase-master').click();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config', 'purchase-unit-configuration.json'))).items.A.purchaseUnit, undefined);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'B', internalUnit: 'L', transferUnit: 'L', unitsPerTransferUnit: 1 }] }) });
  await open.click();
  await row.waitFor();
  assert.equal(await row.locator('.ingredient-master-purchase-unit').inputValue(), 'L');
  await row.locator('.ingredient-master-purchase-unit').selectOption('Botella');
  await row.locator('.ingredient-master-content').fill('0');
  await page.locator('#save-ingredient-purchase-master').click();
  assert.match(await page.locator('#ingredient-purchase-master-status').innerText(), /mayor que 0/);
  await row.locator('.ingredient-master-content').fill('0.75');
  await row.locator('.ingredient-master-transfer-unit').selectOption('Botella');
  await row.locator('.ingredient-master-transfer-content').fill('0.75');
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
  const projectionRow = page.locator('#purchase-projection-body tr[data-key="A"]');
  await projectionRow.locator('.projection-package-input').fill('6');
  const suggestionColumn = await page.locator('.purchase-projection-table th').evaluateAll(headers =>
    headers.filter(header => !header.hidden).findIndex(header => header.dataset.headerLines === 'Sugerencia de|Abastecimiento'));
  assert.equal(await projectionRow.locator('td').nth(suggestionColumn).innerText(), '60 Botella');
  assert.equal(await projectionRow.locator('.projection-suggested-consumption').innerText(), '45 L');
  assert.equal(await projectionRow.locator('.projection-suggestion-coverage').innerText(), '14,0 días');
  assert.equal(await page.locator('.purchase-projection-table th[data-header-lines="UDC|sugeridas"]').count(), 0);
  assert.equal(await projectionRow.locator('td').count(), await page.locator('.purchase-projection-table th:visible').count());
  await projectionRow.locator('.projection-package-input').fill('7');
  assert.equal(await projectionRow.locator('.projection-suggested-consumption').innerText(), '47,25 L');
  assert.equal(await projectionRow.locator('.projection-suggestion-coverage').innerText(), '14,8 días');
  await projectionRow.locator('.projection-package-input').fill('6');
  const inventoryBeforeSave = await page.evaluate(() => purchaseProjectionState.items.map(item => ({
    key: item.key, inventory: item.currentInventory, daily: item.averageDailyConsumption
  })));
  app.locals.toteatStockSync.current = () => { throw Error('Saving criteria must reuse the displayed inventory'); };
  await page.locator('#save-projection-policies').click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('Criterios de compra guardados correctamente'));
  assert.equal(projectionRequests, 1);
  assert.equal(await page.locator('#refresh-purchase-projection').innerText(), 'Actualizar');
  assert.equal(await page.locator('#purchase-projection-workspace').getAttribute('aria-busy'), 'false');
  assert.deepEqual(await page.evaluate(() => purchaseProjectionState.items.map(item => ({
    key: item.key, inventory: item.currentInventory, daily: item.averageDailyConsumption
  }))), inventoryBeforeSave);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config', 'purchase-projection-policies.json'))).locations['store-2'].items.A.unitsPerPackageBasis, 'purchase');
  await page.locator('#projection-supplier-filter').selectOption('111');
  await page.locator('#print-purchase-order').click();
  const editorRow = page.locator('#purchase-order-editor-body tr[data-key="A"]');
  const quantity = editorRow.locator('.purchase-order-quantity');
  assert.equal(await page.locator('.purchase-order-editor-table th:not([hidden])').nth(10).innerText(), 'Un. de Transferencia');
  assert.equal(await editorRow.locator('td').nth(11).innerText(), '0,75 L por Botella');
  assert.equal(await editorRow.locator('.purchase-order-quantity-unit').innerText(), 'Botella');
  assert.equal(await editorRow.locator('.purchase-order-consumption-quantity').innerText(), '45 L');
  assert.equal(await editorRow.locator('.purchase-order-daily-consumption').innerText(), '3 L/día');
  assert.equal(await editorRow.locator('.purchase-order-inventory').innerText(), '-3,00 L');
  assert.equal(await editorRow.locator('.purchase-order-inventory-locals').count(), 0);
  assert.equal(await editorRow.locator('.purchase-order-coverage-current').innerText(), '-1,0 días');
  assert.equal(await editorRow.locator('.purchase-order-coverage-after').innerText(), '14,0 días');
  assert.equal(await editorRow.locator('td').count(), await page.locator('.purchase-order-editor-table th:not([hidden])').count());
  await editorRow.locator('.purchase-order-select').uncheck();
  assert.equal(await editorRow.locator('.purchase-order-coverage-after').innerText(), '-1,0 días');
  assert.equal(await editorRow.locator('.purchase-order-coverage-low').count(), 1);
  await editorRow.locator('.purchase-order-select').check();
  assert.equal(await quantity.inputValue(), '60');
  assert.equal(await quantity.getAttribute('step'), '6');
  await quantity.fill('61');
  await page.locator('#confirm-purchase-order').click();
  assert.match(await page.locator('#purchase-order-editor-status').innerText(), /múltiplos de 6 Botella/);
  assert.equal(await page.locator('#print-saved-purchase-order').isDisabled(), true);
  await quantity.fill('66');
  assert.equal(await editorRow.locator('.purchase-order-consumption-quantity').innerText(), '49,5 L');
  assert.equal(await editorRow.locator('.purchase-order-coverage-after').innerText(), '15,5 días');
  assert.equal(await editorRow.locator('.purchase-order-coverage-high').count(), 1);
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let failSave = true;
  await page.route('**/api/purchase-orders', async route => {
    await saveGate;
    if (failSave) {
      failSave = false;
      return route.fulfill({ status: 500, json: { error: 'No se pudo guardar la orden de prueba.' } });
    }
    await route.continue();
  });
  app.locals.toteatStockSync.current = () => { throw Error('Saving must reuse the projection'); };
  await page.locator('#confirm-purchase-order').click();
  assert.equal(await page.locator('#confirm-purchase-order').isDisabled(), true);
  assert.equal(await page.locator('#purchase-order-editor-status').innerText(), 'Guardando orden…');
  releaseSave();
  await page.waitForFunction(() => !document.getElementById('confirm-purchase-order').disabled);
  assert.equal(await page.locator('#purchase-order-editor-status').innerText(), 'No se pudo guardar la orden de prueba.');
  assert.equal(await page.locator('#print-saved-purchase-order').isDisabled(), true);
  assert.equal((await json('/api/purchase-orders?location=store-2')).orders.length, 0);
  await page.locator('#confirm-purchase-order').click();
  await page.waitForFunction(() => !document.getElementById('print-saved-purchase-order').disabled);
  assert.equal(await quantity.inputValue(), '66');
  assert.match(await page.locator('#purchase-order-editor-title').innerText(), /Orden de compra OC-/);
  assert.match(await page.locator('#purchase-order-editor-status').innerText(), /guardada correctamente/);
  const orders = await json('/api/purchase-orders?location=store-2');
  assert.equal(orders.orders.length, 1);
  const savedOrder = await json('/api/purchase-orders/' + orders.orders[0].id);
  assert.equal(savedOrder.items[0].quantity, 66);
  assert.equal(savedOrder.items[0].internalQuantity, 49.5);
  assert.equal(await editorRow.locator('.purchase-order-consumption-quantity').innerText(), '49,5 L');
  assert.equal(await editorRow.locator('.purchase-order-coverage-after').innerText(), '15,5 días');
  await quantity.fill('72');
  assert.equal(await editorRow.locator('.purchase-order-consumption-quantity').innerText(), '54 L');
  await page.locator('#confirm-purchase-order').click();
  await page.waitForFunction(() => !document.getElementById('print-saved-purchase-order').disabled);
  assert.equal((await json('/api/purchase-orders/' + savedOrder.id)).items[0].internalQuantity, 54);
  await page.screenshot({ path: '/private/tmp/brewit-purchase-order-units.png' });
  assert.deepEqual(errors, []);
});

test('UI edits and exports independent transfer units, preserves drafts and applies each presentation to its location', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, json } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('store-2');
  await page.locator('#open-ingredient-purchase-master').click();
  const row = page.locator('#ingredient-purchase-master-body tr[data-code="A"]');
  await row.waitFor();
  assert.equal(await row.locator('.ingredient-master-transfer-unit').inputValue(), 'L');
  assert.equal(await row.locator('.ingredient-master-transfer-content').isEnabled(), true);
  await row.locator('.ingredient-master-purchase-unit').selectOption('Bidón');
  await row.locator('.ingredient-master-content').fill('3');
  assert.match(await row.locator('.ingredient-master-transfer-equivalence').innerText(), /1 L = 1 L/);
  await row.locator('.ingredient-master-transfer-unit').selectOption('');
  assert.equal(await row.locator('.ingredient-master-transfer-unit').inputValue(), 'Bidón');
  assert.equal(await row.locator('.ingredient-master-transfer-content').inputValue(), '3');
  await row.locator('.ingredient-master-transfer-unit').selectOption('Botella');
  await row.locator('.ingredient-master-transfer-content').fill('0.75');
  const search = page.locator('#ingredient-purchase-master-search');
  await search.fill('incompatible');
  await search.fill('leche');
  assert.equal(await row.locator('.ingredient-master-content').inputValue(), '3');
  assert.equal(await row.locator('.ingredient-master-transfer-content').inputValue(), '0.75');
  assert.match(await row.locator('.ingredient-master-transfer-equivalence').innerText(), /1 Botella = 0,75 L/);
  for (const format of ['pdf', 'csv', 'xlsx']) {
    const ready = page.waitForEvent('download');
    await page.locator(`#ingredient-purchase-master-${format}`).click();
    const bytes = fs.readFileSync(await (await ready).path());
    if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    else {
      const book = XLSX.read(format === 'csv' ? bytes.toString('utf8') : bytes,
        format === 'csv' ? { type: 'string', raw: true } : {});
      const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
      assert.match(rows[0][6], /Transferencia a Cafeterías/);
      assert.equal(rows[1][3], 'Bidón'); assert.equal(rows[1][4], format === 'csv' ? '3' : 3);
      assert.equal(rows[1][6], 'Botella'); assert.equal(rows[1][7], format === 'csv' ? '0,75' : .75);
    }
  }
  await row.locator('.ingredient-master-transfer-content').fill('0');
  await page.locator('#save-ingredient-purchase-master').click();
  assert.match(await page.locator('#ingredient-purchase-master-status').innerText(), /mayor que 0/);
  await row.locator('.ingredient-master-transfer-content').fill('0.75');
  await page.locator('#save-ingredient-purchase-master').click();
  await page.locator('#ingredient-purchase-master-dialog').waitFor({ state: 'hidden' });
  const master = (await json('/api/purchase-projections/ingredient-master')).items.find(item => item.code === 'A');
  assert.deepEqual([master.purchaseUnit, master.unitsPerPurchaseUnit, master.transferUnit, master.unitsPerTransferUnit],
    ['Bidón', 3, 'Botella', .75]);
  await page.locator('#projection-only-required').uncheck();
  const projectionRow = page.locator('#purchase-projection-body tr[data-key="A"]');
  for (const [location, expected] of [['store-2', ['L', 'Botella', '0,75 L']], ['main-warehouse', ['L', 'Bidón', '3 L']]]) {
    await page.locator('#projection-location-filter').selectOption(location);
    await page.locator('#refresh-purchase-projection').click();
    await page.waitForFunction(() => document.getElementById('purchase-projection-workspace').getAttribute('aria-busy') === 'false');
    assert.deepEqual((await projectionRow.locator('td').allTextContents()).slice(4, 7), expected);
  }
  assert.deepEqual(errors, []);
});

test('past orders show the projection list before a delayed refresh and preserve it on failure', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, project, json } = await setup(t);
  const initial = await project('store-2');
  const create = () => json('/api/purchase-orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', projectionId: initial.projectionId,
      items: [{ key: 'A', quantity: 24, unitCost: 100 }] })
  });
  const order = await create(), hidden = await create();
  await json(`/api/purchase-orders/${hidden.id}/visibility`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: true })
  });
  const projection = await project('store-2');
  assert.equal(projection.purchaseOrders.savedOrders.length, 2);
  assert.equal(projection.purchaseOrders.savedOrders.find(item => item.id === hidden.id).hidden, true);
  assert.equal(projection.purchaseOrders.savedOrders[0].items, undefined);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  const waiting = [], arrived = [];
  let requests = 0;
  const nextRoute = () => arrived.length ? Promise.resolve(arrived.shift()) : new Promise(resolve => waiting.push(resolve));
  await page.route('**/api/purchase-orders?*', route => {
    requests++;
    if (waiting.length) waiting.shift()(route); else arrived.push(route);
  });
  await page.evaluate(projection => {
    purchaseProjectionState = projection;
    document.getElementById('projection-location-filter').value = projection.location.id;
    void openPastPurchaseOrders();
  }, projection);
  const firstRefresh = await nextRoute();
  const cards = page.locator('.past-purchase-order-card');
  assert.equal(await cards.count(), 1);
  assert.match(await cards.first().innerText(), new RegExp(order.orderNumber));
  assert.doesNotMatch(await page.locator('#past-purchase-orders-status').innerText(), /Cargando/);
  await page.locator('#show-hidden-purchase-orders').check();
  assert.equal(await cards.count(), 2);
  assert.equal(requests, 1);
  const latest = await json('/api/purchase-orders?location=store-2');
  latest.orders.find(item => item.id === order.id).total = 3333;
  await firstRefresh.fulfill({ json: latest });
  await page.locator('.past-purchase-order-card').filter({ hasText: '$3.333' }).waitFor();
  await page.locator('#close-past-purchase-orders').click();
  await page.locator('#past-purchase-orders').click();
  const failedRefresh = await nextRoute();
  assert.equal(await cards.count(), 2);
  await failedRefresh.fulfill({ status: 500, json: { error: 'Servidor ocupado' } });
  await page.waitForFunction(() => document.getElementById('past-purchase-orders-status').textContent.includes('última lista disponible'));
  assert.equal(await cards.count(), 2);
  // Mutations update the visible list before their background refresh returns.
  await page.locator(`[data-order-action="visibility"][data-order-id="${order.id}"]`).click();
  const hiddenRefresh = await nextRoute();
  assert.equal(await page.locator('.past-purchase-order-card.is-hidden').count(), 2);
  await hiddenRefresh.fulfill({ json: await json('/api/purchase-orders?location=store-2') });
  await page.locator(`[data-order-action="delete"][data-order-id="${hidden.id}"]`).click();
  const deletedRefresh = await nextRoute();
  assert.equal(await cards.count(), 1);
  await deletedRefresh.fulfill({ json: await json('/api/purchase-orders?location=store-2') });
  // An old response must not replace another location's list.
  await page.evaluate(() => { void openPastPurchaseOrders(); });
  const staleRefresh = await nextRoute();
  await page.evaluate(() => {
    purchaseProjectionState = { location: { id: 'store-1' }, purchaseOrders: { savedOrders: [] } };
    document.getElementById('projection-location-filter').value = 'store-1';
    void openPastPurchaseOrders();
  });
  const otherRefresh = await nextRoute();
  assert.equal(await cards.count(), 0);
  await otherRefresh.fulfill({ json: { orders: [] } });
  await staleRefresh.fulfill({ json: latest });
  assert.equal(await cards.count(), 0);
  assert.match(await page.locator('#past-purchase-orders-status').innerText(), /Aún no hay órdenes/);
});

test('supplier catalog includes historical and assigned products without inventory and validates added order items', async t => {
  const { root, app, project, json, base } = await setup(t);
  const projection = await project();
  const order = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', projectionId: projection.projectionId,
      items: [{ key: 'A', quantity: 2, unitCost: 100 }] }) });
  // B was bought from this supplier but is currently assigned to another one.
  fs.writeFileSync(path.join(root, 'config', 'purchase-projection-policies.json'), JSON.stringify({ locations: {
    'store-2': { items: { B: { supplierKey: '222' }, D: { supplierKey: '111' } } }
  } }));
  let stockReads = 0;
  app.locals.toteatStockSync.current = () => { stockReads++; throw Error('Do not read inventory'); };
  const catalog = await json('/api/purchase-projections/supplier-items?location=store-2&supplier=111');
  assert.deepEqual(catalog.items.map(item => item.key).sort(), ['A', 'B', 'D']);
  assert.equal(catalog.items.find(item => item.key === 'B').estimatedPurchaseUnitCost, 100);
  assert.ok(catalog.items.every(item => item.currentInventory === null && item.averageDailyConsumption === null));
  const saved = await json(`/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectionId: catalog.projectionId, items: [{ key: 'A', quantity: 3, unitCost: 100 }, { key: 'B', quantity: 2, unitCost: 100 }] }) });
  assert.deepEqual(saved.items.map(item => [item.key, item.quantity]), [['A', 3], ['B', 2]]);
  const invalid = await fetch(`${base}/api/purchase-orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectionId: catalog.projectionId, items: [{ key: 'C', quantity: 1, unitCost: 1 }] }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await json(`/api/purchase-orders/${order.id}`)).items, saved.items);
  assert.equal(stockReads, 0);
});

test('saved order without a projection can load all supplier items, retry failures and save additions without stock recalculation', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, app, project, json } = await setup(t);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['A', 'B'].map(code => ({ code, internalUnit: 'L', transferUnit: 'L', unitsPerTransferUnit: 1 })) }) });
  const projection = await project();
  const order = await json('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', projectionId: projection.projectionId,
      items: [{ key: 'A', quantity: 24, unitCost: 100 }] }) });
  let stockReads = 0;
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  app.locals.toteatStockSync.current = () => { stockReads++; throw Error('Do not read inventory'); };
  await page.evaluate(orderId => openSavedPurchaseOrder(orderId), order.id);
  const row = page.locator('#purchase-order-editor-body tr[data-key="A"]');
  await row.locator('.purchase-order-quantity').fill('25');
  const showAll = page.locator('#purchase-order-show-all-supplier-items');
  assert.equal(await showAll.isEnabled(), true);
  let attempts = 0;
  await page.route('**/api/purchase-projections/supplier-items?*', route => ++attempts === 1
    ? route.fulfill({ status: 500, json: { error: 'Reintenta la consulta del proveedor.' } }) : route.continue());
  await showAll.check();
  await page.waitForFunction(() => document.getElementById('purchase-order-editor-status').textContent.includes('Reintenta'));
  assert.equal(await showAll.isEnabled(), true);
  assert.equal(await row.locator('.purchase-order-quantity').inputValue(), '25');
  await showAll.check();
  const additional = page.locator('#purchase-order-editor-body tr[data-key="B"]');
  await additional.waitFor();
  assert.equal(await additional.locator('.purchase-order-select').isChecked(), false);
  assert.equal(await row.locator('.purchase-order-quantity').inputValue(), '25');
  assert.equal((await json(`/api/purchase-orders/${order.id}`)).items.length, 1);
  await additional.locator('.purchase-order-select').check();
  await additional.locator('.purchase-order-quantity').fill('2');
  await page.locator('#confirm-purchase-order').click();
  await page.waitForFunction(() => document.getElementById('purchase-order-editor-status').textContent.includes('guardada correctamente'));
  const saved = await json(`/api/purchase-orders/${order.id}`);
  assert.deepEqual(saved.items.map(item => [item.key, item.quantity]), [['A', 25], ['B', 2]]);
  assert.equal(stockReads, 0);
});

test('saved order editor reuses the displayed projection and opens and saves without inventory recalculation', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, app, project, json } = await setup(t);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['A', 'B'].map(code => ({ code, internalUnit: 'L', transferUnit: 'L', unitsPerTransferUnit: 1 })) }) });
  const projection = await project('store-2');
  const order = await json('/api/purchase-orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', supplierKey: '111', projectionId: projection.projectionId,
      items: [{ key: 'A', quantity: 24, unitCost: 100 }] })
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  let projectionRequests = 0, recalculations = 0;
  await page.locator('[data-view="purchase-projection"]').click();
  await page.route('**/api/purchase-projections?*', route => {
    projectionRequests++;
    return route.fulfill({ status: 500, json: { error: 'Opening an order must not request a projection' } });
  });
  app.locals.toteatStockSync.current = () => { recalculations++; throw Error('Do not recalculate when reopening an order'); };
  await page.evaluate(projection => {
    purchaseProjectionState = projection;
    document.getElementById('projection-location-filter').value = projection.location.id;
    openPastPurchaseOrders();
  }, projection);
  await page.locator(`[data-order-action="edit"][data-order-id="${order.id}"]`).click();
  const editor = page.locator('#purchase-order-editor-dialog');
  await editor.waitFor();
  const row = page.locator('#purchase-order-editor-body tr[data-key="A"]');
  assert.equal(await row.locator('.purchase-order-quantity').inputValue(), '24');
  assert.equal(await row.locator('.purchase-order-coverage-after').innerText(), '7,0 días');
  await page.locator('#purchase-order-show-all-supplier-items').check();
  const additional = page.locator('#purchase-order-editor-body tr[data-key="B"]');
  await additional.locator('.purchase-order-select').check();
  await additional.locator('.purchase-order-quantity').fill('2');
  const saveRequest = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname.endsWith(order.id));
  await page.locator('#confirm-purchase-order').click();
  assert.ok((await saveRequest).postDataJSON().projectionId);
  await page.waitForFunction(() => document.getElementById('purchase-order-editor-status').textContent.includes('guardada correctamente'));
  assert.deepEqual((await json('/api/purchase-orders/' + order.id)).items.map(item => item.key), ['A', 'B']);
  assert.equal(await page.evaluate(orderId => pastPurchaseOrdersCache.get('store-2').find(item => item.id === orderId).itemCount, order.id), 2);
  for (const available of [null, { ...projection, location: { id: 'store-1' } }]) {
    await page.locator('#close-purchase-order-editor').click();
    await page.evaluate(({ orderId, available }) => {
      purchaseProjectionState = available;
      return openSavedPurchaseOrder(orderId);
    }, { orderId: order.id, available });
    await editor.waitFor();
    assert.equal(await row.locator('.purchase-order-inventory').innerText(), 'Sin datos');
    assert.equal(await page.locator('#purchase-order-show-all-supplier-items').isEnabled(), true);
    await row.locator('.purchase-order-quantity').fill(available ? '26' : '25');
    await page.locator('#confirm-purchase-order').click();
    await page.waitForFunction(() => document.getElementById('purchase-order-editor-status').textContent.includes('guardada correctamente'));
    assert.equal((await json('/api/purchase-orders/' + order.id)).items[0].quantity, available ? 26 : 25);
  }
  assert.equal(projectionRequests, 0);
  assert.equal(recalculations, 0);
  assert.deepEqual(errors, []);
});

test('purchase order coverage uses consolidated warehouse demand and handles unavailable metrics', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  let projectionRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/purchase-projections') projectionRequests++; });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.evaluate(() => {
    purchaseOrderEditorState = {
      supplier: { name: 'Proveedor' }, location: { name: 'Bodega' },
      items: [editablePurchaseOrderSupplierItem({ key: 'A', name: 'Leche', internalUnit: 'L', purchaseUnit: 'Botella',
        currentInventory: 2, localsInventory: 18, totalInventory: 20, averageDailyConsumption: 1, localsDailyConsumption: 4,
        localsInventorySubtotal: 18, localsInventoryComplete: true, currentCoverageDays: 5,
        locals: [{ locationId: 'store-1', locationName: 'Cafetería', sourceInventory: 18, sourceUnit: 'L',
          inventory: 18, inventoryIncluded: true, inventoryDate: '2026-09-26' }],
        minDays: 7, maxDays: 14, unitsPerPurchaseUnit: 2, unitsPerPackage: 1, unitsPerPackageBasis: 'purchase',
        quantity: 6, unitCost: 100, suggestedPurchaseUnits: 6
      }, { selected: true, editorDefaultVisible: true })]
    };
    renderPurchaseOrderEditor();
    document.getElementById('purchase-order-editor-dialog').showModal();
  });
  const row = page.locator('#purchase-order-editor-body tr[data-key="A"]');
  const coverage = row.locator('.purchase-order-coverage-after');
  assert.equal(await row.locator('.purchase-order-daily-consumption').innerText(), '4 L/día');
  assert.equal(await row.locator('.purchase-order-inventory').innerText(), '2,00 L');
  assert.equal(await row.locator('.purchase-order-inventory-locals').innerText(), '18,00');
  assert.equal(await row.locator('.purchase-order-inventory-total').innerText(), '20,00');
  assert.equal(await row.locator('td').count(), await page.locator('.purchase-order-editor-table th:not([hidden])').count());
  assert.equal(await page.locator('.purchase-order-editor-table tfoot td').first().getAttribute('colspan'), '18');
  await row.locator('.purchase-order-inventory-locals button').click();
  await page.locator('#projection-local-detail-dialog').waitFor();
  assert.match(await page.locator('#projection-local-detail-body').innerText(), /Cafetería.*18,00/);
  assert.match(await page.locator('#projection-local-detail-calculation').innerText(), /2,00 \(Bodega\).*18,00.*20,00/);
  await page.locator('#close-projection-local-detail').click();
  assert.equal(await row.locator('.purchase-order-coverage-current').innerText(), '5,0 días');
  assert.equal(await row.locator('.purchase-order-min-days').innerText(), '7 días');
  assert.equal(await row.locator('.purchase-order-max-days').innerText(), '14 días');
  assert.equal(await coverage.innerText(), '8,0 días');
  assert.match(await coverage.getAttribute('title'), /Dentro del rango/);
  for (const [change, expected] of [
    [{ localsDailyConsumption: 0 }, 'Sin consumo'],
    [{ localsDailyConsumption: null }, 'Sin datos'],
    [{ localsDailyConsumption: 4, unitsPerPurchaseUnit: null }, 'Sin conversión'],
    [{ selected: false }, '5,0 días'],
    [{ selected: true, unitsPerPurchaseUnit: 2, totalInventory: null }, 'Sin datos'],
    [{ totalInventory: -8 }, '1,0 días']
  ]) {
    await page.evaluate(change => {
      Object.assign(purchaseOrderEditorState.items[0], change);
      renderPurchaseOrderEditor();
    }, change);
    assert.equal(await coverage.innerText(), expected);
  }
  await page.evaluate(() => {
    purchaseOrderEditorState = editableSavedPurchaseOrder({
      id: 'old', updatedAt: '2026-09-26', supplier: { name: 'Proveedor' }, location: { name: 'Local' },
      items: [{ key: 'A', name: 'Leche', quantity: 6, unitCost: 100, unitsPerPurchaseUnit: 2 }]
    });
    renderPurchaseOrderEditor();
  });
  assert.equal(await coverage.innerText(), 'Sin datos');
  assert.equal(await row.locator('.purchase-order-coverage-current').innerText(), 'Sin datos');
  assert.equal(await row.locator('.purchase-order-min-days').innerText(), 'Sin datos');
  assert.equal(await page.locator('#purchase-order-locals-inventory-header').isVisible(), false);
  assert.equal(await page.locator('.purchase-order-editor-table tfoot td').first().getAttribute('colspan'), '16');
  assert.equal(projectionRequests, 0);
});

test('tentative orders explain confirmation blockers and add unmanaged and catalog-only supplier products', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, root, app, json, project } = await setup(t);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['A', 'B'].map(code => ({ code, internalUnit: 'L', transferUnit: 'L', unitsPerTransferUnit: 1 })) }) });
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', items: [{ key: 'A', supplierKey: '111', managed: true,
      minDays: 7, maxDays: 14, unitsPerPackage: 2 }] }) });
  const projection = await project();
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.evaluate(projection => {
    openTentativePurchaseOrders();
    const groups = tentativeGroupsForProjection(projection);
    groups[0].buyingItems[0].quantity = 0;
    tentativePurchaseOrdersState = { locations: [{ ...projection.location, projectionId: projection.projectionId, period: projection.period, groups }] };
    populateTentativeLocationFilter(projection.location.id); renderTentativePurchaseOrderReview();
  }, projection);
  const confirm = page.locator('#confirm-tentative-purchase-order');
  const validation = page.locator('#tentative-order-validation');
  const row = key => page.locator(`#tentative-orders-buying-body tr[data-key="${key}"]`);
  assert.equal(await confirm.isDisabled(), true);
  assert.match(await validation.innerText(), /A · A:.*cantidad mayor que 0/);
  await row('A').locator('.tentative-order-quantity').fill('1');
  assert.match(await validation.innerText(), /múltiplos de 2 L/);
  assert.equal(await row('A').locator('.tentative-order-quantity').getAttribute('aria-invalid'), 'true');
  await row('A').locator('.tentative-order-quantity').fill('2');
  assert.equal(await confirm.isEnabled(), true);
  assert.equal(await validation.isVisible(), false);
  await page.locator('[data-tentative-add="B"]').click();
  assert.equal(await row('B').locator('.tentative-order-select').isChecked(), true);
  assert.equal(await row('B').locator('.tentative-order-quantity').inputValue(), '1');
  await row('B').locator('.tentative-order-cost').fill('');
  assert.match(await validation.innerText(), /B · B:.*costo válido/);
  await row('B').locator('.tentative-order-cost').fill('100');
  await row('B').locator('.tentative-order-quantity').fill('0');
  assert.equal(await confirm.isDisabled(), true);
  await row('B').locator('.tentative-order-select').uncheck();
  assert.equal(await confirm.isEnabled(), true);
  await row('B').locator('.tentative-order-select').check();
  await row('B').locator('.tentative-order-quantity').fill('1');
  await page.evaluate(() => { currentTentativeOrderGroup().buyingItems[0].transferConfigured = false; renderTentativePurchaseOrderReview(); });
  assert.match(await validation.innerText(), /Unidad de Transferencia a Cafeterías/);
  await page.evaluate(() => { currentTentativeOrderGroup().buyingItems[0].transferConfigured = true; renderTentativePurchaseOrderReview(); });
  // An item absent from the inventory projection can still be ordered from its supplier.
  const masterFile = path.join(root, 'masters', 'catalog.xlsx'), book = XLSX.readFile(masterFile);
  const catalogRows = XLSX.utils.sheet_to_json(book.Sheets.Ingr, { header: 1 });
  catalogRows.push(['E', 'Extra de proveedor', 1, 200, 'UN']);
  book.Sheets.Ingr = XLSX.utils.aoa_to_sheet(catalogRows); XLSX.writeFile(book, masterFile);
  await json('/api/purchase-projections/ingredient-master', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ code: 'E', internalUnit: 'UN', transferUnit: 'UN', unitsPerTransferUnit: 1 }] }) });
  await json('/api/purchase-projections/policies', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-2', items: [{ key: 'E', supplierKey: '111', managed: false,
      minDays: 7, maxDays: 14, unitsPerPackage: 1 }] }) });
  let stockReads = 0;
  app.locals.toteatStockSync.current = () => { stockReads++; throw Error('Do not recalculate inventory to add products or confirm'); };
  let loads = 0;
  await page.route('**/api/purchase-projections/supplier-items?*', route => ++loads === 1
    ? route.fulfill({ status: 500, json: { error: 'Reintenta la consulta de productos.' } }) : route.continue());
  await row('A').locator('.tentative-order-quantity').fill('4');
  const load = page.locator('#load-tentative-supplier-items');
  await load.click();
  await page.waitForFunction(() => document.getElementById('tentative-supplier-items-status').textContent.includes('Reintenta'));
  assert.equal(await row('A').locator('.tentative-order-quantity').inputValue(), '4');
  await load.click();
  await page.locator('[data-tentative-add="E"]').waitFor();
  const ids = await page.evaluate(() => ({ location: tentativePurchaseOrdersState.locations[0].projectionId, group: currentTentativeOrderGroup().projectionId }));
  assert.equal(ids.location, projection.projectionId);
  assert.ok(ids.group && ids.group !== ids.location);
  await page.locator('[data-tentative-add="E"]').click();
  assert.equal(await row('E').locator('.tentative-order-quantity').inputValue(), '1');
  assert.equal(await confirm.isEnabled(), true);
  let saves = 0;
  await page.route('**/api/purchase-orders', route => ++saves === 1
    ? route.fulfill({ status: 500, json: { error: 'Reintenta guardar la orden.' } }) : route.continue());
  await confirm.click();
  await page.waitForFunction(() => document.getElementById('tentative-purchase-orders-status').textContent.includes('Reintenta guardar'));
  assert.equal(await confirm.isEnabled(), true);
  assert.equal(await row('A').locator('.tentative-order-quantity').inputValue(), '4');
  await confirm.click();
  await page.waitForFunction(() => document.getElementById('tentative-purchase-orders-status').textContent.includes('confirmada y guardada'));
  const orders = await json('/api/purchase-orders?location=store-2');
  assert.equal(orders.orders.length, 1);
  const saved = await json(`/api/purchase-orders/${orders.orders[0].id}`);
  assert.deepEqual(saved.items.map(item => [item.key, item.quantity]), [['A', 4], ['B', 1], ['E', 1]]);
  assert.equal(saved.total, 700);
  assert.equal(saved.filters.onlyManaged, false);
  assert.equal(saved.filters.onlyRequired, false);
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await page.locator('#print-confirmed-tentative-order').isVisible(), true);
  assert.equal(stockReads, 0);
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
