const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults, buildDailyResultsWithProgress, currentWeeks, value } = require('../weekly-results');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('clicking inbound amounts opens the correct ingredient totals, movements, missing costs and daily/monthly scope', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-inbound-ui-'));
  const server = createApp({ uploadsRoot: root, reportToday: '2026-10-13' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Portal Lyon' }];
  const today = '2026-10-13';
  function source(location, period) {
    const item = (id, code, name, quantity, unit, cost) => ({ id, code, name, quantity, unit, unitCost: cost,
      document: id, date: period.from, amount: cost == null ? null : quantity * cost, available: cost != null });
    const central = location.id === 'store-2' ? [] : [
      item('T1', 'ING001', 'Ingrediente A', 2, 'KG', 10), item('T2', 'ING001', 'Ingrediente A', 3, 'KG', 10),
      item('T3', 'SUB005', 'Café', 1, 'KG', 30), item('T4', 'ING001', 'Ingrediente A', 500, 'G', .02),
      item('T5', 'MISSING', 'Ingrediente sin costo', .25, 'KG', null)
    ];
    const supplier = [item('P1', 'DIRECT', 'Compra directa', 2, 'UN', location.id === 'store-2' ? 50 : 25)];
    return { values: { netSales: value(1000, 'complete'),
      centralWarehouseInbound: value(location.id === 'store-2' ? 0 : 90, location.id === 'store-2' ? 'complete' : 'partial'),
      directSupplierInbound: value(supplier[0].amount, 'complete') }, sources: {
      centralWarehouseInbound: { items: central, costCutoff: period.valuationThrough || period.through, missingCostCodes: location.id === 'store-2' ? [] : ['MISSING'] },
      directSupplierInbound: { items: supplier, costCutoff: period.valuationThrough || period.through }
    } };
  }
  let requests = 0;
  await page.route('**/api/weekly-results/stream?*', route => {
    requests++;
    const options = Object.fromEntries(new URL(route.request().url()).searchParams);
    const data = buildWeeklyResults({ today, locations, ...options }, source);
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' });
  });
  await page.route('**/api/weekly-results/daily/stream?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    const period = currentWeeks(today).find(week => week.from === query.get('from'));
    const location = locations.find(location => location.id === query.get('location'));
    const data = await buildDailyResultsWithProgress({ today, period, location }, source, () => {});
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="weekly-results"]').click();
  await page.locator('#weekly-results-weeks').selectOption('2');
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  const popup = page.locator('#weekly-results-inbound');
  const central = page.locator('#weekly-results-table [data-metric="centralWarehouseInbound"] button').nth(2);
  await central.focus(); await page.keyboard.press('Enter');
  assert.equal(await popup.isVisible(), true);
  assert.ok(await popup.evaluate(dialog => Math.abs(dialog.getBoundingClientRect().left + dialog.getBoundingClientRect().width / 2 - innerWidth / 2) < 1));
  assert.equal(await popup.locator('h3').innerText(), 'Entradas Bodega Central');
  assert.match(await page.locator('#weekly-results-inbound-context').innerText(), /La Concepción · 05-10-2026 – 11-10-2026 · Costeo al 11-10-2026/);
  const summary = popup.locator('.weekly-results-inbound-summary');
  assert.equal(await summary.locator('tbody tr').count(), 4);
  const ingredient = summary.locator('tbody tr').filter({ hasText: 'ING001' });
  assert.equal(await ingredient.first().locator('td').nth(2).innerText(), '5');
  assert.equal(await ingredient.first().locator('td').nth(3).innerText(), 'KG');
  assert.equal(await ingredient.first().locator('td').last().innerText(), '$50');
  assert.equal(await ingredient.nth(1).locator('td').nth(2).innerText(), '500');
  assert.equal(await ingredient.nth(1).locator('td').nth(3).innerText(), 'G');
  assert.match(await summary.locator('tbody tr').filter({ hasText: 'SUB005' }).innerText(), /Café.*1.*KG.*\$30/);
  assert.match(await summary.locator('tbody tr').filter({ hasText: 'MISSING' }).innerText(), /Sin costo/);
  assert.equal(await summary.locator('tfoot td').innerText(), '$90');
  assert.match(await popup.innerText(), /Detalle parcial/);
  await popup.locator('summary').click();
  assert.equal(await popup.locator('.weekly-results-inbound-movements tbody tr').count(), 5);
  assert.equal(requests, 1);
  await page.screenshot({ path: '/private/tmp/brewit-inbound-popup.png' });
  await page.keyboard.press('Escape');
  assert.equal(await popup.isVisible(), false);
  assert.equal(await central.evaluate(button => button === document.activeElement), true);
  await page.locator('#weekly-results-table [data-metric="directSupplierInbound"] button').nth(2).click();
  assert.equal(await popup.locator('h3').innerText(), 'Entradas Proveedores Directos');
  assert.equal(await popup.locator('tfoot td').innerText(), '$50');
  assert.match(await popup.innerText(), /Compra directa/);
  assert.doesNotMatch(await popup.innerText(), /SUB005/);
  await page.locator('#weekly-results-inbound-close').click();
  await page.locator('#weekly-results-table [data-metric="centralWarehouseInbound"] button').nth(3).click();
  assert.match(await popup.innerText(), /No se registraron entradas/);
  assert.match(await popup.innerText(), /Total de entradas: \$0/);
  assert.match(await page.locator('#weekly-results-inbound-context').innerText(), /Portal Lyon/);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Detalle Diario de la semana del 05-10-2026', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('weekly-results-daily-status').textContent === 'Detalle diario actualizado.');
  await page.locator('#weekly-results-daily [data-metric="centralWarehouseInbound"] button').first().click();
  assert.match(await page.locator('#weekly-results-inbound-context').innerText(), /05-10-2026 – 05-10-2026 · Costeo al 11-10-2026/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#weekly-results-daily').isVisible(), true);
  await page.locator('#weekly-results-daily [data-metric="centralWarehouseInbound"] button').last().click();
  assert.match(await page.locator('#weekly-results-inbound-context').innerText(), /05-10-2026 – 11-10-2026/);
  await page.keyboard.press('Escape');
  await page.locator('#weekly-results-daily-close').click();

  await page.locator('#weekly-results-period').selectOption('month');
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados mensuales actualizados.');
  await page.locator('#weekly-results-table [data-metric="directSupplierInbound"] button').first().click();
  assert.match(await page.locator('#weekly-results-inbound-context').innerText(), /01-10-2026 – 13-10-2026/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await popup.evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth));
  assert.ok(await popup.locator('.weekly-results-inbound-table-wrap').first().evaluate(wrap => wrap.scrollWidth > wrap.clientWidth));
  await popup.screenshot({ path: '/private/tmp/brewit-inbound-popup-mobile.png' });
  await page.locator('[data-view="financial-results"]').evaluate(link => link.click());
  assert.equal(await popup.isVisible(), false);
  assert.deepEqual(errors, []);
});
