const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults, value } = require('../weekly-results');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function validateDownloadedWorkbook(page, bytes) {
  const zip = XLSX.CFB.read(bytes, { type: 'buffer' });
  const xml = name => Buffer.from(XLSX.CFB.find(zip, '/' + name).content).toString();
  const structure = await page.evaluate(({ sheetXml, stylesXml }) => {
    const parser = new DOMParser();
    const sheet = parser.parseFromString(sheetXml, 'application/xml');
    const styles = parser.parseFromString(stylesXml, 'application/xml');
    if (sheet.querySelector('parsererror') || styles.querySelector('parsererror')) throw Error('Invalid workbook XML');
    return { children: [...sheet.documentElement.children].map(node => node.localName),
      pageSetupCount: sheet.getElementsByTagName('pageSetup').length,
      pageSetUpPrCount: sheet.getElementsByTagName('pageSetUpPr').length,
      tables: Object.fromEntries(['fonts', 'fills', 'borders', 'cellXfs'].map(name => {
        const table = styles.getElementsByTagName(name)[0];
        return [name, { declared: Number(table.getAttribute('count')), actual: table.children.length }];
      })),
      formats: [...styles.getElementsByTagName('cellXfs')[0].children].map(node => ({
        font: Number(node.getAttribute('fontId')), fill: Number(node.getAttribute('fillId')), border: Number(node.getAttribute('borderId'))
      })),
      cells: [...sheet.getElementsByTagName('c')].map(node => Number(node.getAttribute('s') || 0)) };
  }, { sheetXml: xml('xl/worksheets/sheet1.xml'), stylesXml: xml('xl/styles.xml') });
  // CT_Worksheet is an ordered sequence, including the optional print settings.
  // Microsoft Open XML SDK: data/schemas/schemas_openxmlformats_org_spreadsheetml_2006_main.json
  const order = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr',
    'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate',
    'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
    'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties',
    'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF',
    'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
  const positions = structure.children.map(name => { assert.ok(order.includes(name), name); return order.indexOf(name); });
  assert.deepEqual(positions, positions.toSorted((a, b) => a - b), `Invalid worksheet element order: ${structure.children.join(', ')}`);
  assert.equal(structure.pageSetupCount, 1);
  assert.equal(structure.pageSetUpPrCount, 1);
  for (const table of Object.values(structure.tables)) assert.equal(table.declared, table.actual);
  for (const format of structure.formats) {
    assert.ok(format.font < structure.tables.fonts.actual);
    assert.ok(format.fill < structure.tables.fills.actual);
    assert.ok(format.border < structure.tables.borders.actual);
  }
  assert.ok(structure.cells.every(style => style < structure.tables.cellXfs.actual));
}

test('PDF and XLSX preview and download the calculated report with matching styles, repeated titles and numeric values', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-export-ui-'));
  const server = createApp({ uploadsRoot: root, reportToday: '2026-10-14' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Lyon' }, { id: 'store-3', name: 'Nueva sucursal' }];
  const data = buildWeeklyResults({ weeks: 4, includeCurrent: true, today: '2026-10-14', locations }, (location, period) => ({
    values: { netSales: value(location.id === 'store-2' ? 0 : 1000.25, 'partial'), margin: value(location.id === 'store-2' ? 0 : 700.25, 'complete'), grossSales: value(1300.25, 'complete'),
      discounts: value(110.25, 'complete'), tips: value(100, 'complete'), mercadoPagoFee: value(35, 'partial'),
      cashCollection: value(200, 'complete'), mercadoPagoCollection: value(900, 'complete'),
      centralWarehouseInbound: value(30, 'complete'), directSupplierInbound: value(50, 'complete'),
      inventoryShortage: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-50, 'partial'),
      finalInventory: value(1800, 'complete', { basis: period.from === '2026-10-12' ? 'theoretical' : 'physical',
        date: period.from === '2026-10-12' ? '2026-10-14' : '2026-10-11' }),
      otherConsumables: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-40, 'complete'),
      waste: value(-10, 'complete'), marketing: value(-20, 'complete'), employees: value(-30, 'complete') },
    inventory: { initialDate: '2026-10-04', finalDate: '2026-10-11' }, warnings: ['Cobertura parcial de ejemplo'],
    sources: { centralWarehouseInbound: { items: [{ code: 'SUB005', name: 'Café', quantity: 3, unit: 'KG', unitCost: 10, amount: 30, available: true, date: period.from, document: 'T1' }], costCutoff: period.through },
      directSupplierInbound: { items: [{ code: 'ING', name: 'Ingrediente', quantity: 5, unit: 'KG', unitCost: 10, amount: 50, available: true, date: period.from, document: 'P1' }], costCutoff: period.through } }
  }));
  let calculations = 0;
  await page.route('**/api/weekly-results/stream?*', route => {
    calculations++;
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.getByRole('tab', { name: 'Resultados Semanales / Mensuales', exact: true }).click();
  assert.equal(await page.locator('#weekly-results-pdf').isDisabled(), true);
  assert.equal(await page.locator('#weekly-results-xlsx').isDisabled(), true);
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent.startsWith('Resultados semanales con observaciones.'));
  await page.locator('#weekly-results-workspace').evaluate(workspace => {
    for (const [key, color] of Object.entries({ '--bg': '#211e1b', '--bg-soft': '#27231e', '--text': '#f7ebdc', '--text-muted': '#a69d8c', '--border': '#3d3b39' })) workspace.style.setProperty(key, color);
  });
  const popup = page.locator('#weekly-results-export');
  await page.locator('#weekly-results-xlsx').click();
  await page.waitForFunction(() => !document.getElementById('weekly-results-export-download').disabled || document.getElementById('weekly-results-export-status').classList.contains('error'));
  assert.equal(await page.locator('#weekly-results-export-download').isEnabled(), true, await page.locator('#weekly-results-export-status').innerText());
  assert.equal(await popup.isVisible(), true);
  assert.match(await popup.locator('h3').innerText(), /Previsualización XLSX/);
  assert.equal(await popup.locator('table tbody tr').count(), 27);
  assert.equal(await popup.locator('table button').count(), 0);
  assert.equal(await popup.locator('[data-metric="centralWarehouseInbound"] .weekly-results-amount').first().innerText(), '$30');
  assert.equal(await popup.locator('[data-metric="directSupplierInbound"] .weekly-results-amount').first().innerText(), '$50');
  assert.equal(await popup.locator('[data-metric="cogs"] .weekly-results-amount').first().innerText(), '$-300\nParcial');
  assert.equal(await popup.locator('[data-metric="variableCosts"] .weekly-results-amount').nth(3).innerText(), '$-450\nParcial');
  assert.equal(await popup.locator('[data-metric="otherVariableCosts"] .weekly-results-amount').nth(3).innerText(),
    await popup.locator('[data-metric="inventoryConsumptionTotal"] .weekly-results-amount').nth(3).innerText());
  assert.equal(await popup.locator('[data-metric="netSales"] .weekly-results-amount').first().innerText(), '$1.000\nParcial');
  assert.match(await popup.locator('[data-metric="inventoryShortage"] .weekly-results-amount').nth(3).innerText(), /04-10-2026 → 11-10-2026/);
  assert.equal(await popup.locator('[data-metric="finalInventory"] .weekly-results-amount').first().innerText(), '$1.800\nInventario teórico · 14-10-2026');
  assert.equal(await popup.locator('[data-metric="finalInventory"] .weekly-results-amount').nth(3).innerText(), '$1.800\nFísico · 11-10-2026');
  const xlsxDownloadPromise = page.waitForEvent('download');
  await page.locator('#weekly-results-export-download').click();
  const xlsxDownload = await xlsxDownloadPromise;
  assert.equal(xlsxDownload.suggestedFilename(), 'Resultados_Semanales_2026-10-14_4_semanas.xlsx');
  const bytes = fs.readFileSync(await xlsxDownload.path()), book = XLSX.read(bytes, { type: 'buffer', cellNF: true });
  await validateDownloadedWorkbook(page, bytes);
  const sheet = book.Sheets['Resultados Semanales'];
  assert.equal(sheet.B6.t, 'n'); assert.equal(sheet.B6.v, 1000.25);
  assert.equal(sheet.C6.t, 'n'); assert.equal(sheet.C6.v, 1);
  assert.equal(sheet.B7.v, 'Parcial');
  for (const [label, amount] of [['Entradas Insumos', 80], ['Bodega Central', 30], ['Proveedores Directos', 50]]) {
    const address = Object.keys(sheet).find(key => sheet[key]?.v === label);
    assert.ok(address, label);
    const row = XLSX.utils.decode_cell(address).r;
    assert.equal(sheet[XLSX.utils.encode_cell({ r: row, c: 1 })].v, amount);
  }
  for (const [label, amount] of [['Costos Variables', -450], ['COGs', -300], ['Otros Variables', -150]]) {
    const address = Object.keys(sheet).find(key => sheet[key]?.v === label);
    assert.ok(address, label);
    const row = XLSX.utils.decode_cell(address).r;
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: 7 })];
    assert.equal(cell.t, 'n');
    assert.equal(cell.v, amount);
  }
  assert.equal(sheet.D6.v, 0); assert.equal(sheet.E6.v, '—');
  assert.ok(Object.values(sheet).some(cell => cell?.v === 'Sin toma física'));
  const zip = XLSX.CFB.read(bytes, { type: 'buffer' });
  const xml = name => Buffer.from(XLSX.CFB.find(zip, '/' + name).content).toString();
  assert.match(xml('xl/worksheets/sheet1.xml'), /orientation="landscape"/);
  assert.match(xml('xl/worksheets/sheet1.xml'), /xSplit="1" ySplit="5"/);
  assert.match(xml('xl/workbook.xml'), /_xlnm.Print_Titles/);
  assert.match(xml('xl/workbook.xml'), /\$A:\$A/);
  assert.match(xml('xl/styles.xml'), /FF211E1B/);
  assert.match(xml('xl/styles.xml'), /FFA69D8C/);
  const formatting = await page.evaluate(({ sheetXml, stylesXml }) => {
    const parser = new DOMParser(), document = parser.parseFromString(sheetXml, 'application/xml'), styles = parser.parseFromString(stylesXml, 'application/xml');
    const cells = Array.from(document.getElementsByTagName('c'));
    const xfs = styles.getElementsByTagName('cellXfs')[0], fonts = styles.getElementsByTagName('fonts')[0], borders = styles.getElementsByTagName('borders')[0];
    const style = address => xfs.children[Number(cells.find(cell => cell.getAttribute('r') === address).getAttribute('s'))];
    const main = style('B6'), compact = style('B8');
    return { mainSize: Number(fonts.children[Number(main.getAttribute('fontId'))].getElementsByTagName('sz')[0].getAttribute('val')),
      compactSize: Number(fonts.children[Number(compact.getAttribute('fontId'))].getElementsByTagName('sz')[0].getAttribute('val')),
      compactColor: fonts.children[Number(compact.getAttribute('fontId'))].getElementsByTagName('color')[0].getAttribute('rgb'),
      compactBottom: borders.children[Number(compact.getAttribute('borderId'))].getElementsByTagName('bottom')[0].getAttribute('style') };
  }, { sheetXml: xml('xl/worksheets/sheet1.xml'), stylesXml: xml('xl/styles.xml') });
  assert.equal(formatting.mainSize - formatting.compactSize, 3);
  assert.equal(formatting.compactColor, 'FFA69D8C');
  assert.equal(formatting.compactBottom, null);
  await page.screenshot({ path: '/private/tmp/brewit-weekly-xlsx-preview.png' });
  await page.locator('#weekly-results-export-close').click();

  await page.locator('#weekly-results-pdf').click();
  await page.waitForFunction(() => !document.getElementById('weekly-results-export-download').disabled || document.getElementById('weekly-results-export-status').classList.contains('error'));
  assert.equal(await page.locator('#weekly-results-export-download').isEnabled(), true, await page.locator('#weekly-results-export-status').innerText());
  assert.equal(await popup.locator('iframe').count(), 1);
  const previewBytes = await popup.locator('iframe').evaluate(async frame => Array.from(new Uint8Array(await fetch(frame.src).then(response => response.arrayBuffer()))));
  assert.equal(Buffer.from(previewBytes).subarray(0, 4).toString(), '%PDF');
  const pdfDownloadPromise = page.waitForEvent('download');
  await page.locator('#weekly-results-export-download').click();
  const pdfDownload = await pdfDownloadPromise;
  assert.equal(pdfDownload.suggestedFilename(), 'Resultados_Semanales_2026-10-14_4_semanas.pdf');
  const pdfBytes = fs.readFileSync(await pdfDownload.path());
  assert.deepEqual(pdfBytes, Buffer.from(previewBytes));
  fs.writeFileSync('/private/tmp/brewit-weekly-export.pdf', pdfBytes);
  assert.ok((pdfBytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 3);
  assert.equal(calculations, 1);
  await page.keyboard.press('Escape');
  await page.locator('#weekly-results-weeks').selectOption('2');
  assert.equal(await page.locator('#weekly-results-pdf').isDisabled(), true);
  assert.equal(await page.locator('#weekly-results-xlsx').isDisabled(), true);
  assert.equal(await popup.isVisible(), false);
  await page.unroute('**/api/weekly-results/stream?*');
  const monthly = buildWeeklyResults({ today: data.date, locations, weeks: 2, period: 'month', includeCurrent: false },
    () => ({ values: { netSales: value(1000.25, 'complete') } }));
  await page.route('**/api/weekly-results/stream?*', route => {
    calculations++;
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data: monthly }) + '\n' });
  });
  await page.locator('#weekly-results-period').selectOption('month');
  await page.locator('#weekly-results-current').selectOption('false');
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados mensuales actualizados.');
  await page.locator('#weekly-results-xlsx').click();
  await page.waitForFunction(() => !document.getElementById('weekly-results-export-download').disabled);
  assert.match(await popup.locator('h3').innerText(), /Resultados Mensuales/);
  assert.match(await popup.locator('.weekly-results-export-context').innerText(), /2 meses.*Mes actual excluido.*30-09-2026/);
  const monthlyDownloadPromise = page.waitForEvent('download');
  await page.locator('#weekly-results-export-download').click();
  const monthlyDownload = await monthlyDownloadPromise;
  assert.equal(monthlyDownload.suggestedFilename(), 'Resultados_Mensuales_2026-10-14_2_meses_sin_actual.xlsx');
  const monthlyBytes = fs.readFileSync(await monthlyDownload.path());
  await validateDownloadedWorkbook(page, monthlyBytes);
  const monthlyBook = XLSX.read(monthlyBytes, { type: 'buffer' });
  assert.deepEqual(monthlyBook.SheetNames, ['Resultados Mensuales']);
  assert.equal(monthlyBook.Sheets['Resultados Mensuales'].B6.v, 1000.25);
  assert.match(monthlyBook.Sheets['Resultados Mensuales'].B3.v, /^Hace 1 mes.*01-09-2026.*30-09-2026/);
  assert.equal(calculations, 2);
  assert.deepEqual(errors, []);
});
