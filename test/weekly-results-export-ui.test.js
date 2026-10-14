const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults, value } = require('../weekly-results');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('PDF and XLSX preview and download the calculated report with matching styles, repeated titles and numeric values', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-export-ui-'));
  const server = createApp({ uploadsRoot: root, reportToday: '2026-10-14' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Lyon' }, { id: 'store-3', name: 'Nueva sucursal' }];
  const data = buildWeeklyResults({ today: '2026-10-14', locations }, (location, period) => ({
    values: { netSales: value(location.id === 'store-2' ? 0 : 1000.25, 'partial'), grossSales: value(1300.25, 'complete'),
      discounts: value(110.25, 'complete'), tips: value(100, 'complete'), mercadoPagoFee: value(35, 'partial'),
      cashCollection: value(200, 'complete'), mercadoPagoCollection: value(900, 'complete'),
      inventoryShortage: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-50, 'partial'),
      otherConsumables: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-40, 'complete'),
      waste: value(-10, 'complete'), marketing: value(-20, 'complete'), employees: value(-30, 'complete') },
    inventory: { initialDate: '2026-10-04', finalDate: '2026-10-11' }, warnings: ['Cobertura parcial de ejemplo']
  }));
  let calculations = 0;
  await page.route('**/api/weekly-results/stream?*', route => {
    calculations++;
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="weekly-results"]').click();
  assert.equal(await page.locator('#weekly-results-pdf').isDisabled(), true);
  assert.equal(await page.locator('#weekly-results-xlsx').isDisabled(), true);
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  await page.locator('#weekly-results-workspace').evaluate(workspace => {
    for (const [key, color] of Object.entries({ '--bg': '#211e1b', '--bg-soft': '#27231e', '--text': '#f7ebdc', '--text-muted': '#a69d8c', '--border': '#3d3b39' })) workspace.style.setProperty(key, color);
  });
  const popup = page.locator('#weekly-results-export');
  await page.locator('#weekly-results-xlsx').click();
  await page.waitForFunction(() => !document.getElementById('weekly-results-export-download').disabled || document.getElementById('weekly-results-export-status').classList.contains('error'));
  assert.equal(await page.locator('#weekly-results-export-download').isEnabled(), true, await page.locator('#weekly-results-export-status').innerText());
  assert.equal(await popup.isVisible(), true);
  assert.match(await popup.locator('h3').innerText(), /Previsualización XLSX/);
  assert.equal(await popup.locator('table tbody tr').count(), 21);
  assert.equal(await popup.locator('table button').count(), 0);
  assert.equal(await popup.locator('[data-metric="netSales"] .weekly-results-amount').first().innerText(), '$1.000\nParcial');
  assert.match(await popup.locator('[data-metric="inventoryShortage"] .weekly-results-amount').nth(3).innerText(), /04-10-2026 → 11-10-2026/);
  const xlsxDownloadPromise = page.waitForEvent('download');
  await page.locator('#weekly-results-export-download').click();
  const xlsxDownload = await xlsxDownloadPromise;
  assert.equal(xlsxDownload.suggestedFilename(), 'Resultados_Semanales_2026-10-14_4_semanas.xlsx');
  const bytes = fs.readFileSync(await xlsxDownload.path()), book = XLSX.read(bytes, { type: 'buffer', cellNF: true });
  const sheet = book.Sheets['Resultados Semanales'];
  assert.equal(sheet.B6.t, 'n'); assert.equal(sheet.B6.v, 1000.25);
  assert.equal(sheet.C6.t, 'n'); assert.equal(sheet.C6.v, 1);
  assert.equal(sheet.B7.v, 'Parcial');
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
  assert.deepEqual(errors, []);
});
