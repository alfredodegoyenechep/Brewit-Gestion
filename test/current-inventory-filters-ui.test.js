const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function inventoryPage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-current-filters-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  await page.waitForFunction(() => inventorySourceState !== null);
  return page;
}

test('current inventory combines physical and theoretical filters with search and valuation', { skip: !fs.existsSync(chrome) }, async t => {
  const page = await inventoryPage(t);
  const base = { unit: 'UN', unitCost: 100, costAvailable: true, hierarchyPath: ['Insumos'], costSource: 'master' };
  const data = { referenceDate: '2026-10-06', report: {
    date: '2026-10-06', balanceBasis: 'final', hierarchyCount: 1, itemCount: 5,
    totalValue: 200, itemsWithoutCost: ['M'], items: [
      { ...base, code: 'A', name: 'Café', quantity: 1.23456, physicalInventory: 0, valuation: 100 },
      { ...base, code: 'B', name: 'Otro insumo', quantity: 3, physicalInventory: 3, valuation: 300 },
      { ...base, code: 'N', name: 'Saldo negativo', quantity: -2, physicalInventory: -2, valuation: -200 },
      { ...base, code: 'Z', name: 'Saldo cero', quantity: 0, physicalInventory: null, valuation: 0 },
      { ...base, code: 'M', name: 'Sin costo', costAvailable: false, quantity: 5, physicalInventory: 0, valuation: null }
    ]
  } };
  await page.evaluate(data => renderCurrentInventoryReport(data), data);
  const codes = () => page.locator('#current-inventory-table tbody tr:not(:has(.inventory-empty-result)) td:nth-child(2)').allTextContents();
  const total = () => page.locator('#current-inventory-table tfoot td:last-child').innerText();
  const select = page.locator('#current-inventory-value-filter');
  const clear = page.locator('#clear-current-inventory-search');
  assert.equal(await total(), '$200');
  assert.equal(await page.locator('#current-inventory-missing-cost').isVisible(), true);
  for (const [criterion, expected] of [
    ['nonzero', ['A', 'B', 'N']], ['positive', ['A', 'B']], ['negative', ['N']], ['zero', ['Z']]
  ]) {
    await select.selectOption(criterion);
    assert.deepEqual((await codes()).sort(), expected);
    assert.equal(await page.locator('#current-inventory-missing-cost').isVisible(), false);
  }
  await clear.click();
  const physical = page.locator('#current-inventory-physical-filter');
  const theoretical = page.locator('#current-inventory-theoretical-filter');
  await physical.selectOption('zero');
  assert.deepEqual(await codes(), ['A']);
  assert.equal(await page.locator('#current-inventory-visible-count').innerText(), '1 valorizado(s) · 1 sin costo');
  await physical.selectOption('nonzero');
  assert.deepEqual((await codes()).sort(), ['B', 'N']);
  assert.equal(await total(), '$100');
  await physical.selectOption('all');
  await theoretical.selectOption('zero');
  assert.deepEqual(await codes(), ['Z']);
  await physical.selectOption('zero');
  assert.deepEqual(await codes(), []);
  await theoretical.selectOption('nonzero');
  assert.deepEqual(await codes(), ['A']);
  await select.selectOption('positive');
  await page.locator('#current-inventory-search').fill('cafe');
  assert.deepEqual(await codes(), ['A']);
  assert.equal(await total(), '$100');
  await page.locator('#current-inventory-decimals').selectOption('4');
  assert.equal(await page.locator('#current-inventory-table tbody td').nth(4).innerText(), '1,2346');
  await page.locator('#current-inventory-decimals').selectOption('1');
  assert.equal(await page.locator('#current-inventory-table tbody td').nth(4).innerText(), '1,2');
  await clear.click();
  assert.equal(await select.inputValue(), 'all');
  assert.equal(await physical.inputValue(), 'all');
  assert.equal(await theoretical.inputValue(), 'all');
  assert.equal(await page.locator('#current-inventory-search').inputValue(), '');
  assert.equal((await codes()).length, 4);
  assert.equal(await page.locator('#current-inventory-visible-count').innerText(), '4 valorizado(s) · 1 sin costo');
  await select.selectOption('negative');
  await theoretical.selectOption('zero');
  assert.deepEqual(await codes(), []);
  assert.equal(await total(), '$0');
  await page.evaluate(data => { document.getElementById('current-inventory-results').close(); renderCurrentInventoryReport(data); }, data);
  assert.equal((await codes()).length, 4);
  assert.equal(await select.inputValue(), 'all');
  for (const width of [1280, 720, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('.current-inventory-tools').evaluate(element => {
      const dialog = element.closest('dialog').getBoundingClientRect();
      return [...element.querySelectorAll('input, select, button')].every(control => {
        const rect = control.getBoundingClientRect();
        return rect.left >= dialog.left && rect.right <= dialog.right;
      });
    }), true, `Controls fit at ${width}px`);
  }
});

test('Kardex filters the displayed compensated theoretical balance and excludes unknown physical counts', { skip: !fs.existsSync(chrome) }, async t => {
  const page = await inventoryPage(t);
  await page.evaluate(() => {
    const base = { name: 'Insumo', unit: 'UN', unitCost: 100, costAvailable: true, initialInventory: 0, movements: {} };
    const items = [
      { ...base, code: 'A', finalInventory: 0, theoreticalFinal: 0, adjustedTheoreticalFinal: 5, difference: -5, totalCost: -500 },
      { ...base, code: 'B', finalInventory: 4, theoreticalFinal: 4, adjustedTheoreticalFinal: 0, difference: 4, totalCost: 400 },
      { ...base, code: 'C', finalInventory: null, theoreticalFinal: 0, adjustedTheoreticalFinal: 0, difference: null, totalCost: null },
      { ...base, code: 'D', finalInventory: 0, theoreticalFinal: 0, adjustedTheoreticalFinal: 0, difference: 0, totalCost: 0 },
      { ...base, code: 'E', finalInventory: -2, theoreticalFinal: -1, adjustedTheoreticalFinal: -1, difference: -1, totalCost: -100 }
    ];
    renderInventoryResults({ location: { id: 'main-warehouse', name: 'Bodega principal' }, consumption: {}, report: {
      items, itemCount: items.length, boundaryMode: true, movementDefinitions: [], dateFrom: '2026-09-01', dateTo: '2026-09-29',
      selection: { initialBasis: 'initial', finalBasis: 'initial', initialDate: '2026-09-01', finalDate: '2026-09-30' }
    } });
  });
  const codes = () => page.locator('#inventory-results-table tbody .inventory-item-trigger').allTextContents();
  const physical = page.locator('#inventory-kardex-physical-filter');
  const theoretical = page.locator('#inventory-kardex-theoretical-filter');
  await physical.selectOption('zero');
  assert.deepEqual(await codes(), ['A', 'D']);
  await physical.selectOption('nonzero');
  assert.deepEqual(await codes(), ['B', 'E']);
  await physical.selectOption('all');
  await theoretical.selectOption('zero');
  assert.deepEqual(await codes(), ['B', 'C', 'D']);
  await physical.selectOption('zero');
  assert.deepEqual(await codes(), ['D']);
  await theoretical.selectOption('nonzero');
  assert.deepEqual(await codes(), ['A']);
  await physical.selectOption('nonzero');
  assert.deepEqual(await codes(), ['E']);
  await page.locator('#clear-inventory-kardex-filters').click();
  assert.equal(await physical.inputValue(), 'all');
  assert.equal(await theoretical.inputValue(), 'all');
  assert.equal((await codes()).length, 5);
  await page.locator('#inventory-kardex-search').fill('B');
  await theoretical.selectOption('zero');
  assert.deepEqual(await codes(), ['B']);
});
