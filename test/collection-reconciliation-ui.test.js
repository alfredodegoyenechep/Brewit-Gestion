const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults, value } = require('../weekly-results');
const { buildCollectionReconciliation } = require('../collection-reconciliation');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('difference analysis opens on click regardless of amount, displays exceptions first, keeps snapshots and handles expired details', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-collection-analysis-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const location = { id: 'store-1', name: 'La Concepción', type: 'store' };
  const data = buildWeeklyResults({ today: '2026-10-31', locations: [location] }, (_, period) => ({
    values: { grossSales: value(1000, 'complete'), discounts: value(0, 'complete'), tips: value(0, 'complete'),
      cashCollection: value(0, 'complete'), mercadoPagoFee: value(20, 'complete'),
      mercadoPagoCollection: value(period.from === '2026-10-19' ? 1080 : 990, 'complete') },
    detailReports: { collectionDifference: period.from }
  }));
  const period = data.weeks[0].period;
  const analysis = { ...buildCollectionReconciliation({ sales: [{ orderKey: 'store-1:order:SALE', date: period.from, netSales: 1000 / 1.19 }],
    payments: [{ paymentId: 'PAY', orderId: 'SALE', dateTime: `${period.from}T12:00:00`, change: 0,
      forms: [{ id: 5008, amount: 1000, tip: 0, reference: '' }] }],
    settlements: [{ key: 'MP', sourceId: '<img src=x onerror=alert(1)>', dateTime: `${period.from}T14:00:00`, transactionAmount: 1100, fee: 20, collectedAmount: 1080 }],
    totals: { collectionDifference: 100, mercadoPagoCollection: 1080, mercadoPagoTheoretical: 980 } }), total: 100, partial: false };
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' }));
  let requests = 0, expired = false;
  await page.route('**/api/weekly-results/details/*', route => {
    requests++;
    return route.fulfill(expired ? { status: 410, json: { error: 'Detalle vencido. Actualiza el reporte.' } } : { json: analysis });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.getByRole('tab', { name: 'Resultados Semanales / Mensuales', exact: true }).click();
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.querySelector('#weekly-results-table [data-metric="collectionDifference"]'));
  const figures = page.locator('#weekly-results-table [data-metric="collectionDifference"] .weekly-results-amount');
  assert.equal(await figures.nth(0).locator('button').count(), 1);
  assert.equal(await figures.nth(1).locator('button').count(), 1, 'a $10 difference is actionable');
  const dialog = page.locator('#weekly-results-reconciliation');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(requests, 0);
  await figures.first().locator('button').click();
  await page.locator('#weekly-reconciliation-exceptions').waitFor();
  assert.match(await dialog.locator('.weekly-results-metric-total').innerText(), /\$100/);
  assert.equal(await dialog.locator('table').count(), 2);
  assert.equal(await dialog.locator('table').first().getAttribute('id'), 'weekly-reconciliation-exceptions');
  assert.match(await dialog.locator('table').first().locator('tfoot').innerText(), /\$100/);
  assert.equal(await dialog.locator('img').count(), 0);
  assert.match(await dialog.innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.ok(await dialog.locator('tr[data-status="toteat-only"]').count());
  assert.ok(await dialog.locator('tr[data-status="mp-only"]').count());
  await dialog.locator('table').first().getByRole('button', { name: 'Aporte a la diferencia', exact: true }).click();
  assert.match(await dialog.locator('table').first().locator('tbody tr').first().innerText(), /\$-1\.000/);
  await page.keyboard.press('Escape');
  await figures.first().locator('button').click();
  await page.locator('#weekly-reconciliation-exceptions').waitFor();
  assert.equal(requests, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(d => d.getBoundingClientRect().width <= innerWidth));
  await page.locator('#weekly-results-reconciliation-close').click();
  expired = true;
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.querySelector('#weekly-results-table [data-metric="collectionDifference"] button'));
  await figures.first().locator('button').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-reconciliation-status').textContent.includes('vencido'));
  assert.equal(await dialog.locator('table').count(), 0);
  assert.deepEqual(errors, []);
});

test('balanced weekly and daily controls open analysis, and daily links scope transactions to their selected day', { skip: !fs.existsSync(chrome) }, async t => {
  const { buildDailyResultsWithProgress } = require('../weekly-results');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-daily-collection-analysis-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const location = { id: 'store-1', name: 'La Concepción', type: 'store' }, reports = new Map();
  const cell = (period, kind) => {
    const difference = kind === 'daily' && period.from === '2026-10-28' ? 11 : kind === 'daily' && period.from === '2026-10-29' ? -10 : 0;
    const id = `${kind}:${period.from}`;
    reports.set(id, { ...buildCollectionReconciliation({
      sales: [{ orderKey: 'store-1:order:SALE', date: period.from, netSales: 1000 / 1.19 }],
      payments: [{ paymentId: id, orderId: 'SALE', dateTime: `${period.from}T12:00:00`, change: 0,
        forms: [{ id: 5008, amount: 1000, tip: 0, reference: '' }] }],
      settlements: [{ key: id, sourceId: id, dateTime: `${period.from}T12:00:00`, transactionAmount: 1000 + difference,
        collectedAmount: 980 + difference, fee: 20 }],
      totals: { collectionDifference: difference, mercadoPagoCollection: 980 + difference, mercadoPagoTheoretical: 980 }
    }), total: difference, period, location, partial: false });
    return { values: { grossSales: value(1000, 'complete'), discounts: value(0, 'complete'), tips: value(0, 'complete'),
      cashCollection: value(0, 'complete'), mercadoPagoFee: value(20, 'complete'), mercadoPagoCollection: value(980 + difference, 'complete') },
      detailReports: { collectionDifference: id } };
  };
  const data = buildWeeklyResults({ today: '2026-10-31', locations: [location], includeCurrent: true }, (_, period) => cell(period, 'weekly'));
  const daily = await buildDailyResultsWithProgress({ today: data.date, period: data.weeks[0].period, location }, (_, period) => cell(period, 'daily'), () => {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' }));
  await page.route('**/api/weekly-results/daily/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data: daily }) + '\n' }));
  const requested = [];
  await page.route('**/api/weekly-results/details/*', route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)); requested.push(id);
    return route.fulfill({ json: reports.get(id) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.getByRole('tab', { name: 'Resultados Semanales / Mensuales', exact: true }).click();
  await page.locator('#weekly-results-refresh').click();
  const weeklyButton = page.locator('#weekly-results-table [data-metric="collectionDifference"] button').first();
  await weeklyButton.waitFor(); await weeklyButton.click();
  const popup = page.locator('#weekly-results-reconciliation');
  await page.locator('#weekly-reconciliation-transactions').waitFor();
  assert.match(await popup.locator('.weekly-results-metric-total').innerText(), /\$0/);
  await page.keyboard.press('Escape');
  await page.locator('.weekly-results-daily-button').first().click();
  await page.waitForFunction(() => document.getElementById('weekly-results-daily-status').textContent === 'Detalle diario actualizado.');
  const figures = page.locator('#weekly-results-daily [data-metric="collectionDifference"] .weekly-results-amount');
  for (const index of [0, 1, 2, 3, 4, 5]) assert.equal(await figures.nth(index).locator('button').count(), 1);
  assert.equal(await figures.nth(6).locator('button').count(), 0, 'future dates do not fabricate an analysis');
  for (const [index, day, amount] of [[0, '2026-10-26', 0], [2, '2026-10-28', 11], [3, '2026-10-29', -10]]) {
    await figures.nth(index).locator('button').click();
    await page.locator('#weekly-reconciliation-transactions').waitFor();
    assert.match(await popup.locator('.weekly-results-metric-total').innerText(), new RegExp('\\$' + String(amount)));
    const date = day.split('-').reverse().join('-');
    assert.ok((await popup.locator('#weekly-results-reconciliation-context').innerText()).includes(`${date} – ${date}`));
    const content = await popup.locator('#weekly-reconciliation-transactions tbody').innerText();
    assert.ok(content.includes(day));
    assert.ok(!content.includes('2026-10-27'), 'adjacent dates never leak into the selected-day report');
    assert.equal(requested.at(-1), `daily:${day}`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#weekly-results-daily').isVisible(), true);
  }
  await figures.last().locator('button').click();
  await page.locator('#weekly-reconciliation-transactions').waitFor();
  assert.match(await popup.locator('#weekly-results-reconciliation-context').innerText(), /26-10-2026 – 31-10-2026/);
  assert.deepEqual(errors, []);
});
