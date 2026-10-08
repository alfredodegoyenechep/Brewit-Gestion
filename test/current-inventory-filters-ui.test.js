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

test('theoretical inventory Excel exports numeric balances and costs with the reference columns', { skip: !fs.existsSync(chrome) }, async t => {
  const page = await inventoryPage(t);
  const base = { unit: 'KG', unitCost: 25517.25, costAvailable: true,
    hierarchyPath: ['Ingredientes', 'Café'], costSource: 'master' };
  const data = { referenceDate: '2026-10-06', report: {
    date: '2026-10-06', balanceBasis: 'final', hierarchyCount: 2, itemCount: 3,
    totalValue: 893103.75, itemsWithoutCost: ['M'], items: [
      { ...base, code: '001.234', name: 'Café', quantity: 35, physicalInventory: null, valuation: 893103.75 },
      { ...base, code: 'Z', name: 'Otro', hierarchyPath: ['Extras'], quantity: 0, physicalInventory: 0, valuation: 0 },
      { ...base, code: 'M', name: 'Sin costo', costAvailable: false, quantity: 0.4, physicalInventory: null, valuation: null }
    ]
  } };
  const encoded = await page.evaluate(data => {
    renderCurrentInventoryReport(data);
    writeInventoryExcelFile = workbook => { window.exportedInventory = workbook; };
    exportInventoryReport('current-inventory-results');
    return btoa(Array.from(inventoryStyledExcelBytes(window.exportedInventory), value => String.fromCharCode(value)).join(''));
  }, data);
  const XLSX = require('xlsx');
  const book = XLSX.read(Buffer.from(encoded, 'base64'), { cellNF: true, cellStyles: true });
  assert.deepEqual(book.SheetNames, ['Inventario valorizado', 'Productos sin costo', 'Información']);
  const sheet = book.Sheets['Inventario valorizado'];
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0], [
    'Jerarquía', 'Código', 'Producto', 'Unidad', 'Inventario teórico', 'Inventario físico',
    'Costo unitario', 'Origen costo', 'Valorización'
  ]);
  assert.equal(sheet.A2.v, 'Extras');
  assert.equal(sheet.B3.t, 's');
  assert.equal(sheet.B3.v, '001.234');
  assert.equal(sheet.E3.t, 'n');
  assert.equal(sheet.E3.v, 35);
  assert.equal(sheet.E3.z, '#,##0.00');
  assert.equal(sheet.F2.v, 0);
  assert.equal(sheet.F3.v, 'Sin toma física');
  assert.equal(sheet.G3.v, 25517.25);
  assert.equal(sheet.G3.z, '#,##0');
  assert.equal(sheet.I3.v, 893103.75);
  assert.equal(sheet['!autofilter'].ref, 'A1:I3');
  assert.ok(sheet['!cols'][0].width > sheet['!cols'][3].width);
  assert.equal(book.Sheets['Productos sin costo'].G2.v, 'Sin costo');
  const zip = XLSX.CFB.read(Buffer.from(encoded, 'base64'), { type: 'buffer' });
  const xml = file => Buffer.from(XLSX.CFB.find(zip, '/' + file).content).toString('utf8');
  const styles = xml('xl/styles.xml');
  const worksheet = xml('xl/worksheets/sheet1.xml');
  const headerStyle = Number(worksheet.match(/<c\b[^>]*r="A1"[^>]*s="(\d+)"/)[1]);
  const valueStyle = Number(worksheet.match(/<c\b[^>]*r="E3"[^>]*s="(\d+)"/)[1]);
  const xfs = styles.match(/<cellXfs\b[^>]*>(.*?)<\/cellXfs>/s)[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>.*?<\/xf>/gs);
  const fonts = styles.match(/<fonts\b[^>]*>(.*?)<\/fonts>/s)[1].match(/<font>.*?<\/font>/gs);
  const headerFont = fonts[Number(xfs[headerStyle].match(/fontId="(\d+)"/)[1])];
  assert.match(headerFont, /<b\s*\/>/);
  assert.match(headerFont, /name val="Calibri"/);
  assert.match(headerFont, /sz val="11"/);
  assert.match(xfs[headerStyle], /horizontal="left"/);
  assert.match(xfs[valueStyle], /horizontal="right"/);
  assert.match(styles, /style="thin"/);
  assert.match(worksheet, /zoomScale="80"/);
  assert.match(worksheet, /ht="15"/);
  const filtered = await page.evaluate(() => {
    document.getElementById('current-inventory-search').value = '001.234';
    renderCurrentInventoryTables();
    exportInventoryReport('current-inventory-results');
    return XLSX.utils.sheet_to_json(window.exportedInventory.Sheets['Inventario valorizado'], { header: 1 });
  });
  assert.equal(filtered.length, 3);
  assert.equal(filtered[1][1], '001.234');
});

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
