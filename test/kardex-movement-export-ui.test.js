const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('Kardex exports download real files, ignore table filters and retain two decimals in both user formats', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-movement-export-'));
  const app = createApp({ enableLegacyTools: true, uploadsRoot: root, enableToteatSync: false });
  const stock = {
    range: { from: '2026-09-01', to: '2026-09-03' }, sourceKind: 'public-inventory',
    masterObservedAt: '2026-09-04T00:00:00Z', sourceCapturedAt: '2026-09-04T00:00:00Z', issues: [], assumptions: [], includedOrders: [],
    warehouses: [{ id: 'local', custom_id: 2 }],
    daily: ['A', 'B', 'C', 'EMPTY'].flatMap(code => [1, 2, 3].map(day => ({
      code, name: code === 'A' ? 'Café' : code === 'B' ? 'Solo entradas' : '001234', unit: 'KG', warehouse: 'local', date: `2026-09-0${day}`,
      opening: code === 'EMPTY' || code === 'B' && day === 3 ? 0 : 1000, closing: code === 'EMPTY' ? 0 : 1000, physicalCount: day === 1 || day === 3 && code !== 'C',
      purchase: ['A', 'B'].includes(code) && day === 1 ? 20 : 0, use: code === 'A' && day < 3 ? 3.25 : 0
    })))
  };
  app.locals.toteatStockSync.rebuild = () => stock;
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  await page.waitForFunction(() => inventorySourceState !== null);
  const processed = await page.evaluate(async () => {
    const data = await apiRequest('/api/inventory/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: '2026-09-01', finalInventoryDate: '2026-09-03'
    }) });
    renderInventoryResults(data);
    return data.itemDetailReportId;
  });
  assert.ok(processed);
  await page.locator('#inventory-kardex-search').fill('001234');
  await page.locator('#inventory-kardex-decimals').selectOption('4');
  assert.equal(await page.locator('#inventory-results-table tbody tr').count(), 2);
  for (const system of ['comma', 'dot']) {
    await page.evaluate(system => { exportDecimalSystem = system; }, system);
    const pending = page.waitForEvent('download');
    await page.locator('#inventory-kardex-daily-xlsx').click();
    const download = await pending;
    const book = XLSX.readFile(await download.path(), { cellNF: true });
    assert.match(download.suggestedFilename(), /kardex-diario.*2026-09-01-2026-09-02.*\.xlsx$/);
    const sheet = book.Sheets['Kardex diario'];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.slice(1).map(row => row[1]), ['001234', 'Café', 'Solo entradas']);
    assert.equal(sheet.B2.t, 's');
    assert.equal(sheet.B2.v, '001234');
    assert.equal(sheet.C3.t, 'n');
    assert.equal(sheet.C3.z, '#,##0.00');
    assert.equal(XLSX.SSF.format(sheet.C3.z, sheet.C3.v), '1,000.00');
    assert.deepEqual(rows[0].slice(2, 7), ['Inventario inicial', 'Inventario final teórico', 'Inventario final físico', 'Total entradas', 'Total salidas']);
    assert.deepEqual(rows[2].slice(2), [1000, 1013.5, 1000, 20, 6.5, 20, 0, 3.25, 3.25]);
    assert.equal(sheet.E2, undefined);
    assert.equal(sheet.E3.z, '#,##0.00');
    assert.equal(sheet.E4.t, 'n');
    assert.equal(sheet.E4.v, 0);
    assert.equal(XLSX.SSF.format(sheet.E4.z, sheet.E4.v), '0.00');
    for (const name of book.SheetNames) {
      for (const cell of Object.values(book.Sheets[name])) {
        if (cell?.t === 'n') {
          assert.equal(cell.z, '#,##0.00');
          assert.match(XLSX.SSF.format(cell.z, cell.v), /\d\.\d{2}$/);
        }
      }
    }
    assert.equal(book.SheetNames[1], 'Contexto');
    const zip = XLSX.CFB.read(fs.readFileSync(await download.path()), { type: 'buffer' });
    const xml = name => Buffer.from(XLSX.CFB.find(zip, '/' + name).content).toString();
    const worksheet = xml('xl/worksheets/sheet1.xml'), styles = xml('xl/styles.xml');
    const xfs = styles.match(/<cellXfs\b[^>]*>(.*?)<\/cellXfs>/s)[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>.*?<\/xf>/gs);
    const fonts = styles.match(/<fonts\b[^>]*>(.*?)<\/fonts>/s)[1].match(/<font>.*?<\/font>/gs);
    const format = address => xfs[Number(worksheet.match(new RegExp(`<c\\b[^>]*r="${address}"[^>]*s="(\\d+)"`))[1])];
    const font = address => fonts[Number(format(address).match(/fontId="(\d+)"/)[1])];
    assert.match(styles, /FFD9D9D9/);
    assert.match(font('A1'), /<b\s*\/>/);
    assert.match(font('B4'), /<b\s*\/>/);
    assert.doesNotMatch(font('C4'), /<b\s*\/>/);
    assert.match(format('C4'), /horizontal="right"/);
    assert.match(worksheet, /<pane[^>]*topLeftCell="C2"[^>]*state="frozen"/);
  }
  const pending = page.waitForEvent('download');
  await page.locator('#inventory-kardex-movements-pdf').click();
  const pdf = await pending;
  assert.match(pdf.suggestedFilename(), /kardex-movimientos-por-producto.*\.pdf$/);
  const pdfBytes = fs.readFileSync(await pdf.path());
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdfBytes.includes(Buffer.from('Solo entradas')), false);
  assert.equal(await page.locator('#inventory-kardex-movements-pdf').isEnabled(), true);
  // Empty PDF scope and expired snapshots produce a visible error and restore the controls.
  await page.route('**/api/inventory/movement-report?**', route => route.fulfill({ json: { items: [] } }));
  await page.locator('#inventory-kardex-movements-pdf').click();
  await page.waitForFunction(() => document.getElementById('inventory-kardex-export-status').textContent.includes('No hay productos'));
  await page.unroute('**/api/inventory/movement-report?**');
  await page.evaluate(() => { inventoryKardexTableState.detailReportId = 'expired'; });
  await page.locator('#inventory-kardex-daily-xlsx').click();
  await page.waitForFunction(() => document.getElementById('inventory-kardex-export-status').textContent.includes('venció'));
  assert.equal(await page.locator('#inventory-kardex-daily-xlsx').isEnabled(), true);
});
