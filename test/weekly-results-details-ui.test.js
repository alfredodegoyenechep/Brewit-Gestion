const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const XLSX = require('xlsx');
const { createApp } = require('../server');
const { buildWeeklyResults, value } = require('../weekly-results');
const builder = require('../weekly-results-details');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('eight figures open accessible reports with reconciled totals, filtering, sorting, XLSX and cancellation', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-metric-details-ui-'));
  const server = createApp({ uploadsRoot: root, reportToday: '2026-10-16' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const items = [{ code: 'A', name: 'Café', quantity: 1, unit: 'UN', unitCost: 10, totalCost: 10, costSource: 'master' },
    { code: 'B', name: 'Té <script>bad()</script>', quantity: 2, unit: 'UN', unitCost: 10, totalCost: 20, costSource: 'master' }];
  const reports = {
    netSales: builder.sales([{ code: 'A', name: 'Café', quantity: 1, netSales: 100 }, { code: 'B', name: items[1].name, quantity: 2, netSales: 200 }]),
    tips: builder.tips([{ date: '2026-10-05', method: 'MercadoPago', payments: 2, amount: 20 }, { date: '2026-10-05', method: 'Efectivo', payments: 1, amount: 10 }]),
    inventoryShortage: builder.differences({ items: [{ code: 'A', name: 'Café', unit: 'UN', initialInventory: 100,
      adjustedTheoreticalFinal: 90, finalInventory: 85, finalIsPhysical: true, difference: -5, unitCost: 10, costAvailable: true, totalCost: -50 }] }),
    waste: builder.expense(items, { waste: true }), marketing: builder.expense(items), employees: builder.expense(items),
    otherConsumables: builder.differences({ items: [] }, { consumables: true }),
    finalInventory: builder.balances(items.map(item => ({ ...item, quantity: item.quantity * 10, costAvailable: true })))
  };
  const location = { id: 'store-1', name: 'La Concepción' }, period = { from: '2026-10-05', through: '2026-10-11' };
  const inventory = { initialDate: '2026-10-04', finalDate: '2026-10-11', movements: { from: '2026-10-04', to: '2026-10-10' } };
  const totals = Object.fromEntries(Object.entries(reports).map(([key, report]) => [key, report.rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)]));
  const data = buildWeeklyResults({ today: '2026-10-16', locations: [location] }, () => ({
    values: Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, value(total, key === 'marketing' ? 'partial' : 'complete',
      key === 'finalInventory' ? { basis: 'physical', date: '2026-10-11' } : {})])), inventory,
    detailReports: Object.fromEntries(Object.keys(reports).map(key => [key, key]))
  }));
  const labels = Object.fromEntries(data.metrics);
  for (const [key, report] of Object.entries(reports)) Object.assign(report, { key, title: labels[key], location, period, total: totals[key],
    partial: key === 'marketing', ...(['inventoryShortage', 'otherConsumables'].includes(key) ? { inventory } : {}),
    ...(key === 'finalInventory' ? { basis: 'physical', balanceDate: '2026-10-11' } : {}) });
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' }));
  let detailRequests = 0;
  await page.route('**/api/weekly-results/details/*', route => {
    detailRequests++;
    const key = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: reports[key] });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.getByRole('tab', { name: 'Resultados Semanales / Mensuales', exact: true }).click();
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.querySelector('.weekly-results-metric-button'));
  assert.equal(detailRequests, 0);
  const popup = page.locator('#weekly-results-metric-detail');
  for (const key of Object.keys(reports)) {
    await page.locator(`#weekly-results-table [data-metric="${key}"] .weekly-results-metric-button`).first().click();
    await page.waitForFunction(() => document.querySelector('#weekly-results-metric-detail table'));
    assert.equal(await popup.isVisible(), true);
    assert.ok(await popup.evaluate(dialog => dialog.getBoundingClientRect().width > 1000
      && Math.abs(dialog.getBoundingClientRect().left + dialog.getBoundingClientRect().width / 2 - innerWidth / 2) < 1));
    assert.equal(await popup.locator('h3').innerText(), labels[key]);
    assert.match(await popup.locator('#weekly-results-metric-context').innerText(), /La Concepción.*05-10-2026.*11-10-2026/);
    assert.match(await popup.locator('.weekly-results-metric-total').innerText(), new RegExp(String(totals[key])));
    if (key === 'otherConsumables') assert.match(await popup.locator('tbody').innerText(), /No se registraron movimientos/);
    if (key === 'inventoryShortage') assert.match(await popup.innerText(), /04-10-2026 → 11-10-2026/);
    if (key === 'finalInventory') assert.match(await popup.innerText(), /Inventario físico · 11-10-2026/);
    if (key === 'marketing') assert.match(await popup.innerText(), /Detalle parcial/);
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(), false);
    assert.equal(await page.locator(`#weekly-results-table [data-metric="${key}"] .weekly-results-metric-button`).first()
      .evaluate(button => button === document.activeElement), true);
  }
  assert.equal(detailRequests, 8);
  await page.locator('#weekly-results-table [data-metric="netSales"] button').first().click();
  await page.waitForFunction(() => document.querySelector('#weekly-results-metric-detail table'));
  assert.equal(detailRequests, 8); // Reopening a snapshot does not recalculate or refetch it.
  assert.equal(await popup.locator('tbody tr').first().locator('td').first().innerText(), 'B');
  await popup.getByRole('button', { name: 'Código', exact: true }).click();
  assert.equal(await popup.locator('tbody tr').first().locator('td').first().innerText(), 'A');
  await popup.locator('input[type="search"]').fill('cafe');
  assert.equal(await popup.locator('tbody tr').count(), 1);
  assert.match(await popup.locator('tfoot').innerText(), /Total de registros visibles.*\$100/s);
  const downloadReady = page.waitForEvent('download');
  await page.locator('#weekly-results-metric-xlsx').click();
  const download = await downloadReady;
  const book = XLSX.read(fs.readFileSync(await download.path()));
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Detalle, { header: 1 });
  assert.equal(rows[6][0], 'A'); assert.equal(rows[6][3], 100); assert.equal(rows.at(-1)[3], 100);
  await popup.locator('input[type="search"]').fill('not found');
  assert.match(await popup.locator('tbody').innerText(), /No hay registros que coincidan/);
  await popup.locator('input[type="search"]').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await popup.evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth));
  assert.ok(await popup.locator('.weekly-results-metric-table-wrap').evaluate(wrap => wrap.scrollWidth > wrap.clientWidth));
  await page.screenshot({ path: '/private/tmp/brewit-metric-detail-mobile.png' });
  await page.locator('#weekly-results-metric-close').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#weekly-results-xlsx').click();
  await page.waitForFunction(() => !document.getElementById('weekly-results-export-download').disabled);
  assert.equal(await page.locator('#weekly-results-export .weekly-results-metric-button').count(), 0);
  assert.equal(await page.locator('#weekly-results-export [data-metric="netSales"] .weekly-results-amount').first().innerText(), '$300');
  await page.locator('#weekly-results-export-close').click();
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.querySelector('.weekly-results-metric-button'));
  let release, intercept;
  const started = new Promise(resolve => { intercept = resolve; });
  await page.route('**/api/weekly-results/details/tips', async route => {
    intercept(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: reports.tips }).catch(() => {});
  });
  await page.locator('#weekly-results-table [data-metric="tips"] button').first().click(); await started;
  await page.keyboard.press('Escape');
  await page.locator('#weekly-results-table [data-metric="netSales"] button').first().click();
  await page.waitForFunction(() => document.querySelector('#weekly-results-metric-detail table'));
  release();
  assert.equal(await popup.locator('h3').innerText(), 'Venta neta');
  await page.keyboard.press('Escape');
  await page.route('**/api/weekly-results/details/finalInventory', route => route.fulfill({ status: 410,
    json: { error: 'Este detalle ya no está disponible. Actualiza el reporte y vuelve a abrir la cifra.' } }));
  await page.locator('#weekly-results-table [data-metric="finalInventory"] button').first().click();
  await page.waitForFunction(() => document.getElementById('weekly-results-metric-status').classList.contains('error'));
  assert.match(await popup.innerText(), /Actualiza el reporte/);
  assert.equal(await page.locator('#weekly-results-metric-xlsx').isDisabled(), true);
  assert.deepEqual(errors, []);
});
