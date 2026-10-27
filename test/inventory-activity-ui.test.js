const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('both tables omit idle items through sorting and filtering, and reduced exports use the visible rows', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-activity-ui-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  await page.waitForFunction(() => inventorySourceState !== null);
  await page.evaluate(() => {
    const base = { unit: 'UN', costAvailable: true, unitCost: 100, initialInventory: 0, finalInventory: 0, theoreticalFinal: 0,
      adjustedTheoreticalFinal: 0, movements: {}, difference: 0, totalCost: 0 };
    const active = [
      { code: 'OPEN', initialInventory: 2 }, { code: 'CLOSE', finalInventory: 3 }, { code: 'NEGATIVE', initialInventory: -1 },
      { code: 'BUY', movements: { 'buy-compras': 3 } }, { code: 'SALES', movements: { 'uso-consumo-estimado': 3 } },
      { code: 'TRANSFER', movements: { 'mov-in-transferencia-bodega': 3, 'mov-out-transferencia-bodega': 3 } },
      { code: 'TRANSFORM', movements: { 'trn-in-transformacion': 2 } }, { code: 'ADJUST', movements: { 'aju-tomas-intermedias': 1 } },
      { code: 'CALIBRATE', calibrationConsumption: 1 }, { code: 'EMPLOYEE', employeeConsumption: -1 },
      { code: 'MARKETING', marketingConsumption: 1 }, { code: 'CREDIT', compensationQuantity: 1 },
      { code: 'CANCELLED_TOTAL', hasPeriodMovements: true }
    ];
    const idle = [{ code: 'IDLE_ZERO' }, { code: 'IDLE_MISSING', initialInventory: null, finalInventory: null, theoreticalFinal: null,
      adjustedTheoreticalFinal: null, costAvailable: false, difference: null, totalCost: null }];
    window.activityExpected = active.map(item => item.code).sort();
    window.activityFixture = { location: { name: 'Prueba' }, report: { boundaryMode: true,
      items: [...active, ...idle].map(item => ({ ...base, ...item, name: item.code })), itemCount: active.length + idle.length,
      movementDefinitions: [{ key: 'buy-compras', label: 'Compras' }], dateFrom: '2026-10-18', dateTo: '2026-10-24',
      selection: { initialBasis: 'initial', finalBasis: 'initial', initialDate: '2026-10-18', finalDate: '2026-10-25' } } };
    window.activityFixture.otherConsumables = { items: window.activityFixture.report.items, itemCount: window.activityFixture.report.itemCount };
    renderInventoryResults(window.activityFixture);
  });
  const expected = await page.evaluate(() => window.activityExpected);
  const codes = id => page.locator(`#${id} tbody .inventory-item-trigger`).allTextContents();
  for (const id of ['inventory-results-table', 'inventory-other-consumables-table']) {
    assert.deepEqual((await codes(id)).sort(), expected);
    const totals = await page.locator(`#${id} tfoot`).innerText();
    await page.locator(`#${id} thead button[title="Producto"]`).click();
    await page.locator(`#${id} thead button[title="Producto"]`).click();
    assert.deepEqual((await codes(id)).sort(), expected);
    assert.equal(await page.locator(`#${id} tfoot`).innerText(), totals);
  }
  assert.match(await page.locator('#inventory-kardex-visible-count').innerText(), /2 sin inventario ni movimientos ocultas/);
  assert.match(await page.locator('#inventory-other-consumables-summary').innerText(), /2 ítems sin inventario ni movimientos ocultos/);
  assert.deepEqual(await page.evaluate(() => reducedKardexReport().items.map(item => item.code).sort()), expected);
  await page.locator('#inventory-kardex-search').fill('IDLE');
  assert.deepEqual(await codes('inventory-results-table'), []);
  await page.locator('#clear-inventory-kardex-filters').click();
  assert.deepEqual((await codes('inventory-results-table')).sort(), expected);
  assert.equal(await page.evaluate(() => inventoryKardexTableState.report.items.length), expected.length + 2);
  await page.evaluate(() => {
    document.getElementById('inventory-report-results').close();
    const data = structuredClone(window.activityFixture);
    data.report.items = data.report.items.filter(item => item.code.startsWith('IDLE'));
    data.report.itemCount = 2;
    data.otherConsumables = { items: data.report.items, itemCount: 2 };
    renderInventoryResults(data);
  });
  assert.match(await page.locator('#inventory-results-table tbody').innerText(), /No hay ítems con inventario o movimientos/);
  assert.match(await page.locator('#inventory-other-consumables-table tbody').innerText(), /No hay consumibles con inventario o movimientos/);
  assert.deepEqual(await codes('inventory-other-consumables-table'), []);
});
