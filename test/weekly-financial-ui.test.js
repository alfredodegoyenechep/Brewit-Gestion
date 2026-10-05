const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults } = require('../weekly-financial-results');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('weekly tab follows statement and uses selected filters with five weeks and a total', { skip: !fs.existsSync(chrome) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot, reportToday: '2026-09-28' }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(uploadsRoot, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.waitForFunction(() => !document.querySelector('#financial-results-filters button[type=submit]').disabled);
  await page.locator('#financial-results-period').selectOption('custom');
  await page.locator('#financial-results-from').fill('2026-09-01');
  await page.locator('#financial-results-to').fill('2026-09-28');
  await page.locator('#financial-results-location').selectOption('store-1');
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/financial-results/weekly/stream?')) requests++; });
  await page.getByRole('tab', { name: 'Resultados Semanales', exact: true }).click();
  assert.equal(requests, 0);
  assert.equal(await page.locator('#financial-weekly-month, #financial-weekly-mode').count(), 0);
  const request = page.waitForRequest(r => r.url().includes('/financial-results/weekly/stream?'));
  await page.getByRole('button', { name: 'Procesar vista', exact: true }).click();
  const url = new URL((await request).url());
  assert.equal(url.searchParams.get('location'), 'store-1');
  assert.equal(url.searchParams.has('month'), false);
  assert.equal(url.searchParams.has('weekMode'), false);
  await page.waitForFunction(() => document.getElementById('financial-weekly-status').textContent === 'Resultados semanales actualizados.');
  assert.equal(await page.locator('#financial-weekly-progress').getAttribute('value'), '100');
  assert.equal(await page.getByRole('button', { name: 'Procesar vista', exact: true }).isEnabled(), true);
  assert.match(await page.locator('.financial-weekly-table thead').innerText(), /4 oct/);
  assert.equal(await page.locator('.financial-weekly-table thead th').count(), 7);
  assert.equal(await page.locator('.financial-weekly-table tbody tr').count(), 17);
  assert.doesNotMatch(await page.locator('.financial-weekly-table').innerText(), /N\/D/);
  assert.doesNotMatch(await page.locator('.financial-weekly-table').innerText(), /parcial/);
  const percentages = await page.locator('.weekly-percent').allTextContents();
  assert.ok(percentages.every(value => /^-?[\d.]+,\d%$/.test(value)));
  assert.equal(await page.locator('.weekly-net-sales .weekly-percent').count(), 0);
  assert.doesNotMatch(await page.locator('.weekly-net-sales').innerText(), /%|·/);
  assert.equal(await page.locator('.weekly-gross-sales + .weekly-mercadopago').count(), 1);
  assert.match(await page.locator('.financial-weekly-table tbody tr:first-child th').innerText(), /Venta Bruta.*descuentos considerados/);
  assert.equal(await page.locator('.weekly-gross-sales .weekly-percent, .weekly-reconciliation .weekly-percent').count(), 0);
  assert.deepEqual(await page.locator('.weekly-collection-difference td').allTextContents(), Array(6).fill('Pendiente'));
  assert.equal(await page.locator('.weekly-mercadopago th').innerText(), 'Recaudación MercadoPago');
  assert.equal(await page.locator('.weekly-mercadopago .weekly-amount').count(), 6);
  assert.equal(await page.locator('.weekly-mercadopago .weekly-percent').count(), 0);
  const collectionSizes = await page.locator('.financial-weekly-table tbody').evaluate(body => [0, 1].map(index => {
    const sales = body.querySelector('.weekly-net-sales').cells[index];
    const collection = body.querySelector('.weekly-mercadopago').cells[index];
    return parseFloat(getComputedStyle(sales).fontSize) - parseFloat(getComputedStyle(collection).fontSize);
  }));
  assert.deepEqual(collectionSizes, [4, 4]);
  const percentSizes = await page.locator('.financial-weekly-table tbody').evaluate(body => [...body.querySelectorAll('.weekly-expense')].map(row => {
    const cell = row.cells[1];
    return parseFloat(getComputedStyle(cell.querySelector('.weekly-percent')).fontSize) - parseFloat(getComputedStyle(cell.querySelector('.weekly-amount')).fontSize);
  }));
  assert.equal(percentSizes[0], 2);
  assert.ok(percentSizes.slice(1).every(difference => difference === 3));
  const sizes = await page.locator('.financial-weekly-table tbody').evaluate(body => ['.weekly-net-sales', '.weekly-discounts'].map(selector => parseFloat(getComputedStyle(body.querySelector(selector).cells[1]).fontSize)));
  assert.equal(sizes[0] - sizes[1], 4);
  assert.match(await page.locator('.financial-weekly-table').innerText(), /Otros Consumibles/);
  assert.equal(await page.locator('#financial-results-workspace-panel-statement').isVisible(), false);
  const labels = await page.locator('#financial-results-workspace [role=tab]').allTextContents();
  assert.deepEqual(labels.slice(0, 2), ['Estado de resultados', 'Resultados Semanales']);

  // Exercise the renderer with a balanced week and a shortfall, and totals
  // that must remain pending if one week's sources are incomplete.
  const data = buildWeeklyResults({ today: '2026-09-28', location: 'store-1' }, query => ({
    scope: { label: 'La Concepción' }, warnings: [],
    revenue: { filesRead: 1, total: { netSales: 1000 }, discountsNet: 200 },
    statement: {
      mercadoPagoCollection: { amount: query.dateFrom === '2026-09-21' ? 1000 : 1090, available: true, complete: query.dateFrom !== '2026-08-31' },
      mercadoPagoTips: { amount: 100, available: true, complete: true },
      cashSales: { amount: 200, available: true, complete: true }
    }
  }));
  await page.route('**/api/financial-results/weekly/stream?*', route => route.fulfill({
    contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n'
  }));
  await page.getByRole('button', { name: 'Procesar vista', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.weekly-collection-difference .weekly-balanced'));
  const finalCells = page.locator('.weekly-collection-difference td');
  assert.equal(await finalCells.nth(1).innerText(), '$0');
  assert.equal(await finalCells.nth(1).getAttribute('class'), 'weekly-balanced');
  assert.equal(await finalCells.nth(3).innerText(), '$-90');
  assert.equal(await finalCells.nth(3).getAttribute('class'), 'weekly-difference');
  assert.equal(await finalCells.first().innerText(), '$0 · Pendiente');
  assert.equal(await finalCells.first().getAttribute('class'), 'weekly-unavailable');
  assert.equal(await finalCells.last().innerText(), '$-90 · Pendiente');
  assert.equal(await page.locator('.weekly-gross-sales td').first().innerText(), '$1.190');
});
