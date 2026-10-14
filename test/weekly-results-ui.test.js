const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { buildWeeklyResults, buildDailyResultsWithProgress, currentWeeks, value } = require('../weekly-results');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('daily popup loads on demand, keeps weekly inventory totals, switches branches and cancels stale details', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-daily-results-ui-'));
  const server = createApp({ uploadsRoot: root, reportToday: '2026-10-13' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Lyon' }];
  const source = (location, days) => ({ values: {
    netSales: value((location.id === 'store-1' ? 1000 : 2000) * days, 'complete'),
    grossSales: value(1200 * days, 'complete'), discounts: value(100 * days, 'complete'),
    tips: value(100 * days, 'complete'), mercadoPagoFee: value(35 * days, 'complete'),
    cashCollection: value(200 * days, 'complete'), mercadoPagoCollection: value(900 * days, 'complete'),
    waste: value(-10 * days, 'complete'), marketing: value(-20 * days, 'complete'), employees: value(-30 * days, 'complete'),
    inventoryShortage: value(-50, 'complete'), otherConsumables: value(-280, 'complete')
  }, inventory: { initialDate: '2026-10-04', finalDate: '2026-10-11' } });
  const data = buildWeeklyResults({ today: '2026-10-13', locations }, (location, period) => source(location, period.from === '2026-10-12' ? 2 : 7));
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' }));
  let dailyRequests = 0, release, intercepted;
  const blocked = new Promise(resolve => { intercepted = resolve; });
  await page.route('**/api/weekly-results/daily/stream?*', async route => {
    const url = new URL(route.request().url()); dailyRequests++;
    assert.equal(url.searchParams.get('date'), '2026-10-13');
    if (dailyRequests === 2) { intercepted(); await new Promise(resolve => { release = resolve; }); }
    const location = locations.find(item => item.id === url.searchParams.get('location'));
    const period = currentWeeks(data.date).find(item => item.from === url.searchParams.get('from'));
    const detail = await buildDailyResultsWithProgress({ today: data.date, period, location }, cafe => source(cafe, 1), () => {});
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data: detail }) + '\n' }).catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="weekly-results"]').click();
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  assert.equal(dailyRequests, 0);
  assert.equal(await page.locator('.weekly-results-daily-button').count(), 4);
  const button = page.getByRole('button', { name: 'Detalle Diario de la semana del 05-10-2026', exact: true });
  await button.click();
  await page.waitForFunction(() => document.getElementById('weekly-results-daily-status').textContent === 'Detalle diario actualizado.');
  const popup = page.locator('#weekly-results-daily');
  assert.equal(await popup.isVisible(), true);
  assert.equal(dailyRequests, 1);
  assert.equal(await popup.locator('thead tr').first().locator('th').count(), 9);
  assert.match(await popup.locator('thead tr').first().innerText(), /lunes · 05-10-2026.*domingo · 11-10-2026.*Total semana/s);
  const net = popup.locator('[data-metric="netSales"] .weekly-results-amount');
  assert.equal(await net.first().innerText(), '$1.000');
  assert.equal(await net.last().innerText(), '$7.000');
  for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
    const amounts = await popup.locator(`[data-metric="${key}"] .weekly-results-amount`).allTextContents();
    assert.equal(amounts.length, 8);
    assert.ok(amounts.slice(0, 7).every(text => text === 'Solo total semanal'));
    assert.match(amounts[7], /\$/);
  }
  assert.equal(await popup.locator('[data-metric="otherConsumables"] .weekly-results-amount').last().innerText(), '$-280');
  assert.equal(await popup.locator('[data-metric="inventoryConsumptionTotal"] .weekly-results-amount').last().innerText(), '$-750');
  assert.equal(await popup.locator('[data-metric="inventoryConsumptionTotal"] .weekly-results-percent').last().innerText(), '-10,7%');
  assert.equal(await popup.locator('[data-metric="employees"] + tr').getAttribute('data-metric'), 'otherConsumables');
  assert.equal(await popup.locator('[data-metric="otherConsumables"] + tr').getAttribute('data-metric'), 'inventoryConsumptionTotal');
  await page.keyboard.press('Escape');
  assert.equal(await popup.isVisible(), false);
  await button.click();
  assert.equal(dailyRequests, 1);
  await page.locator('#weekly-results-daily-location').selectOption('store-2'); await blocked;
  await page.locator('#weekly-results-daily-location').selectOption('store-1');
  release();
  await page.waitForFunction(() => document.getElementById('weekly-results-daily').getAttribute('aria-busy') === 'false');
  assert.equal(await net.first().innerText(), '$1.000');
  await page.locator('#weekly-results-daily-location').selectOption('store-2');
  await page.waitForFunction(() => document.querySelector('#weekly-results-daily [data-metric="netSales"] .weekly-results-amount')?.textContent === '$2.000');
  assert.equal(await net.last().innerText(), '$14.000');
  await page.locator('#weekly-results-daily-close').click();
  await page.getByRole('button', { name: 'Detalle Diario de la semana del 12-10-2026', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('weekly-results-daily-status').textContent === 'Detalle diario actualizado.');
  assert.equal(await net.nth(2).innerText(), 'Sin transcurrir');
  assert.equal(await net.last().innerText(), '$2.000');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await popup.evaluate(dialog => dialog.getBoundingClientRect().width <= innerWidth));
  assert.equal(await popup.locator('.weekly-results-table-wrap').evaluate(wrap => wrap.scrollWidth > wrap.clientWidth), true);
  await page.screenshot({ path: '/private/tmp/brewit-daily-results.png' });
  await page.locator('[data-view="financial-results"]').evaluate(link => link.click());
  assert.equal(await popup.isVisible(), false);
});

test('independent weekly screen waits for Actualizar, groups dynamic stores, exposes dates and keeps legacy tabs', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-results-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot: root, reportToday: '2026-10-13' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const labels = await page.locator('.nav-group').first().locator('.nav-text').allTextContents();
  assert.deepEqual(labels.slice(-2), ['Resultados Financieros', 'Resultados Semanales']);
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/weekly-results/stream') requests++; });
  await page.locator('[data-view="weekly-results"]').click();
  assert.equal(requests, 0);
  assert.equal(await page.locator('#weekly-results-table table').count(), 0);
  assert.equal(await page.locator('#weekly-results-weeks').inputValue(), '4');
  assert.equal(await page.locator('#weekly-results-inventory').inputValue(), 'true');
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/weekly-results/stream');
  await page.locator('#weekly-results-refresh').click();
  const url = new URL((await request).url());
  assert.equal(url.searchParams.get('weeks'), '4');
  assert.equal(url.searchParams.get('includeInventory'), 'true');
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  assert.equal(await page.locator('#weekly-results-workspace').isVisible(), true);
  assert.equal(await page.locator('.weekly-results-table tbody tr').count(), 21);
  assert.equal(await page.locator('.weekly-results-table thead tr').count(), 3);
  assert.equal(await page.locator('.weekly-results-table thead tr').first().locator('th').count(), 5);
  assert.equal(await page.locator('.weekly-results-table tbody tr').first().locator('td').count(), 16);
  assert.equal(await page.locator('#weekly-results-progress').getAttribute('value'), '100');
  assert.ok((await page.locator('[data-metric="netSales"] .weekly-results-percent').allTextContents()).every(text => text === '—'));
  assert.ok((await page.locator('[data-metric="expenseIncome"] .weekly-results-amount').allTextContents()).every(text => text === 'Pendiente'));
  assert.ok((await page.locator('[data-metric="inventoryConsumptionTotal"] .weekly-results-amount').allTextContents()).every(text => text === 'Incompleto'));
  assert.match(await page.locator('.weekly-results-table thead tr').first().innerText(), /12-10-2026.*18-10-2026/);

  const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Lyon' }, { id: 'store-3', name: 'Nueva sucursal' }];
  const data = buildWeeklyResults({ today: '2026-10-13', locations }, (location, period) => ({
    values: { netSales: value(location.id === 'store-2' ? 0 : 1000, 'complete'), tips: value(100, 'complete'),
      grossSales: value(1200, 'complete'), discounts: value(100, 'complete'),
      mercadoPagoTips: value(80, 'complete'), cashTips: value(20, 'complete'),
      mercadoPagoFee: value(35, 'complete'),
      cashCollection: value(200, 'complete'), mercadoPagoCollection: value(900, 'complete'),
      inventoryShortage: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-50, 'partial'),
      waste: value(-10, 'complete'), marketing: value(-20, 'complete'), employees: value(-30, 'complete'),
      otherConsumables: period.from === '2026-10-12' ? value(null, 'no-physical-count') : value(-40, 'complete') },
    inventory: { status: 'partial', initialDate: '2026-10-04', finalDate: '2026-10-11', movements: { from: '2026-10-04', to: '2026-10-10' } },
    sources: { marketing: { dates: ['2026-10-05', '2026-10-11'], costCutoff: '2026-10-11', files: [{ name: 'marketing.xlsx' }] } },
    warnings: ['Costo parcial de inventario']
  }));
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson',
    body: JSON.stringify({ type: 'progress', completed: 12, total: 12 }) + '\n' + JSON.stringify({ type: 'result', data }) + '\n' }));
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.weekly-results-table thead')?.textContent.includes('Nueva sucursal'));
  assert.equal(await page.locator('.weekly-results-table tbody tr').first().locator('td').count(), 24);
  const net = page.locator('[data-metric="netSales"] .weekly-results-percent');
  assert.equal(await net.first().innerText(), '100,0%');
  assert.equal(await net.nth(1).innerText(), '—');
  assert.equal(await page.locator('[data-metric="inventoryShortage"] .weekly-results-amount').first().innerText(), 'Sin toma física');
  assert.match(await page.locator('[data-metric="inventoryShortage"] .weekly-results-amount').nth(3).innerText(), /\$-50\s+04-10-2026 → 11-10-2026/);
  assert.doesNotMatch(await page.locator('[data-metric="inventoryShortage"]').innerText(), /Parcial/);
  assert.match(await page.locator('[data-metric="inventoryConsumptionTotal"] .weekly-results-amount').nth(3).innerText(), /\$-150/);
  assert.equal(await page.locator('[data-metric="inventoryConsumptionTotal"] th').innerText(), 'Total inventario faltante, merma, marketing, consumo personal y otros gastos / consumibles');
  assert.equal(await page.locator('[data-metric="employees"] + tr').getAttribute('data-metric'), 'otherConsumables');
  assert.equal(await page.locator('[data-metric="otherConsumables"] + tr').getAttribute('data-metric'), 'inventoryConsumptionTotal');
  assert.equal(await page.locator('[data-metric="mercadoPagoTips"] .weekly-results-amount').first().innerText(), '$80');
  assert.equal(await page.locator('[data-metric="cashTips"] .weekly-results-amount').first().innerText(), '$20');
  assert.deepEqual(await page.locator('[data-metric="tips"], [data-metric="tips"] + tr, [data-metric="tips"] + tr + tr').evaluateAll(rows => rows.map(row => row.dataset.metric)), ['tips', 'mercadoPagoTips', 'cashTips']);
  assert.deepEqual(await page.locator('[data-metric="netSales"], [data-metric="netSales"] + tr, [data-metric="netSales"] + tr + tr').evaluateAll(rows => rows.map(row => row.dataset.metric)), ['netSales', 'margin', 'tips']);
  assert.equal(await page.locator('[data-metric="cashTips"] + tr').getAttribute('data-metric'), 'mercadoPagoFee');
  assert.equal(await page.locator('[data-metric="mercadoPagoFee"] th').innerText(), 'Comision Mercadopago');
  assert.equal(await page.locator('[data-metric="mercadoPagoFee"] .weekly-results-amount').first().innerText(), '$35');
  assert.equal(await page.locator('[data-metric="mercadoPagoFee"] .weekly-results-percent').first().innerText(), '3,5%');
  assert.equal(await page.locator('[data-metric="mercadoPagoTheoretical"] th').innerText(), 'MP Teorico');
  assert.equal(await page.locator('[data-metric="mercadoPagoTheoretical"] .weekly-results-amount').first().innerText(), '$965');
  assert.deepEqual(await page.locator('[data-metric="cashCollection"], [data-metric="cashCollection"] + tr, [data-metric="cashCollection"] + tr + tr').evaluateAll(rows => rows.map(row => row.dataset.metric)), ['cashCollection', 'mercadoPagoTheoretical', 'mercadoPagoCollection']);
  assert.equal(await page.locator('[data-metric="salesWithoutVat"]').count(), 0);
  assert.equal(await page.locator('[data-metric="discounts"] + tr').getAttribute('data-metric'), 'grossSalesAfterDiscounts');
  assert.equal(await page.locator('[data-metric="grossSalesAfterDiscounts"] th').innerText(), 'Venta Bruta post Dsctos');
  assert.equal(await page.locator('[data-metric="grossSalesAfterDiscounts"] .weekly-results-amount').first().innerText(), '$1.100');
  for (const key of ['grossSales', 'grossSalesAfterDiscounts', 'mercadoPagoTheoretical', 'mercadoPagoCollection', 'mercadoPagoTips', 'cashTips']) {
    assert.ok((await page.locator(`[data-metric="${key}"] .weekly-results-percent`).allTextContents()).every(text => text === ''));
  }
  const sizes = await page.locator('.weekly-results-table tbody').evaluate(body => {
    const size = selector => parseFloat(getComputedStyle(body.querySelector(selector)).fontSize);
    return [size('[data-metric="tips"] th') - size('[data-metric="mercadoPagoTips"] th'),
      size('[data-metric="tips"] td') - size('[data-metric="cashTips"] td')];
  });
  assert.deepEqual(sizes, [3, 3]);
  assert.equal(await page.locator('[data-metric="collectionDifference"] .weekly-results-amount').first().innerText(), '$-65');
  assert.equal(await page.locator('[data-metric="collectionDifference"] .weekly-results-percent').first().innerText(), '-6,5%');
  assert.match(await page.locator('.weekly-results-note').innerText(), /Control de diferencias = Mercado Pago − MP Teorico/);
  await page.getByRole('button', { name: 'Revisar fechas y fuentes de La Concepción, semana del 05-10-2026' }).click();
  assert.equal(await page.locator('#weekly-results-detail').isVisible(), true);
  const detail = await page.locator('#weekly-results-detail-body').innerText();
  assert.match(detail, /Toma inicial: 04-10-2026 · Toma final: 11-10-2026/);
  assert.match(detail, /Movimientos: 04-10-2026 – 10-10-2026/);
  assert.match(detail, /Datos calendario: 05-10-2026 – 11-10-2026/);
  assert.match(detail, /marketing.xlsx/);
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

  const sticky = await page.locator('.weekly-results-table-wrap').evaluate(wrap => {
    const label = wrap.querySelector('tbody th'), before = label.getBoundingClientRect().left;
    wrap.scrollLeft = 650; wrap.scrollTop = 180;
    return { before, after: label.getBoundingClientRect().left, position: getComputedStyle(label).position,
      horizontal: wrap.scrollWidth > wrap.clientWidth };
  });
  assert.equal(sticky.position, 'sticky'); assert.equal(sticky.before, sticky.after); assert.equal(sticky.horizontal, true);
  await page.locator('[data-view="financial-results"]').click();
  assert.equal(await page.getByRole('tab', { name: 'Resultados Semanales', exact: true }).isVisible(), true);
  await page.getByRole('tab', { name: 'Resultados Semanales', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Procesar vista', exact: true }).isVisible(), true);
  const requestsBeforeReturn = requests;
  await page.locator('[data-view="weekly-results"]').click();
  assert.equal(requests, requestsBeforeReturn);
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.main-content')).marginLeft === '0px');
  await page.locator('#weekly-results-table').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.weekly-results-table-wrap').evaluate(wrap => wrap.scrollWidth > wrap.clientWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);

  // An interrupted stream can be retried; a replaced request cannot render late.
  await page.unroute('**/api/weekly-results/stream?*');
  await page.route('**/api/weekly-results/stream?*', route => route.fulfill({ contentType: 'application/x-ndjson', body: '{"type":"progress","completed":1,"total":12}\n' }));
  await page.evaluate(() => { window.loadCafeWeeklyResults(); });
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent.includes('Se interrumpió'));
  assert.equal(await page.locator('#weekly-results-refresh').isEnabled(), true);
  await page.unroute('**/api/weekly-results/stream?*');
  let release, intercepted;
  const blocked = new Promise(resolve => { intercepted = resolve; });
  let count = 0;
  await page.route('**/api/weekly-results/stream?*', async route => {
    const request = ++count;
    if (request === 1) { intercepted(); await new Promise(resolve => { release = resolve; }); }
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data: request === 1 ? { ...data, locations: [] } : data }) + '\n' }).catch(() => {});
  });
  await page.evaluate(() => { window.loadCafeWeeklyResults(); }); await blocked;
  await page.evaluate(() => { window.loadCafeWeeklyResults(); });
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  release();
  assert.equal(await page.locator('.weekly-results-table tbody tr').count(), 21);

  // Changing an option aborts the in-flight result and leaves manual generation pending.
  await page.unroute('**/api/weekly-results/stream?*');
  let releaseChanged, interceptedChanged, finishedChanged;
  const changedStarted = new Promise(resolve => { interceptedChanged = resolve; });
  const changedFinished = new Promise(resolve => { finishedChanged = resolve; });
  await page.route('**/api/weekly-results/stream?*', async route => {
    interceptedChanged();
    await new Promise(resolve => { releaseChanged = resolve; });
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', data }) + '\n' }).catch(() => {});
    finishedChanged();
  });
  await page.evaluate(() => { window.loadCafeWeeklyResults(); }); await changedStarted;
  const requestsAtChange = requests;
  await page.locator('#weekly-results-weeks').selectOption('2');
  assert.equal(await page.locator('#weekly-results-refresh').isEnabled(), true);
  assert.equal(await page.locator('#weekly-results-progress').isVisible(), false);
  releaseChanged(); await changedFinished;
  assert.equal(requests, requestsAtChange);
  assert.equal(await page.locator('.weekly-results-table').count(), 0);
  assert.match(await page.locator('#weekly-results-status').innerText(), /Pulsa Actualizar/);
});

test('options change without fetching; Actualizar applies 2/3 weeks and excluded inventory', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-options-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot: root, reportToday: '2026-10-13' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/weekly-results/stream') requests++; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="weekly-results"]').click();
  assert.equal(requests, 0);
  assert.deepEqual(await page.locator('#weekly-results-weeks option').evaluateAll(options => options.map(option => option.value)), ['2', '3', '4']);
  await page.locator('#weekly-results-weeks').selectOption('2');
  await page.locator('#weekly-results-inventory').selectOption('false');
  assert.equal(requests, 0);
  assert.match(await page.locator('#weekly-results-status').innerText(), /Pulsa Actualizar/);
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/weekly-results/stream');
  await page.locator('#weekly-results-refresh').click();
  const url = new URL((await request).url());
  assert.equal(url.searchParams.get('weeks'), '2');
  assert.equal(url.searchParams.get('includeInventory'), 'false');
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  assert.equal(requests, 1);
  assert.equal(await page.locator('.weekly-results-table thead tr').first().locator('th').count(), 3);
  assert.equal(await page.locator('.weekly-results-table tbody tr').first().locator('td').count(), 8);
  for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
    assert.ok((await page.locator(`[data-metric="${key}"] .weekly-results-amount`).allTextContents()).every(value => value === 'No incluido'));
    assert.ok((await page.locator(`[data-metric="${key}"] .weekly-results-percent`).allTextContents()).every(value => value === '—'));
  }
  assert.match(await page.locator('#weekly-results-context').innerText(), /2 semanas · Inventario no incluido/);
  await page.locator('#weekly-results-weeks').selectOption('3');
  await page.locator('#weekly-results-inventory').selectOption('true');
  assert.equal(requests, 1);
  assert.equal(await page.locator('.weekly-results-table').count(), 0);
  await page.locator('#weekly-results-refresh').click();
  await page.waitForFunction(() => document.getElementById('weekly-results-status').textContent === 'Resultados semanales actualizados.');
  assert.equal(requests, 2);
  assert.equal(await page.locator('.weekly-results-table thead tr').first().locator('th').count(), 4);
  assert.equal(await page.locator('.weekly-results-table tbody tr').first().locator('td').count(), 12);
});
