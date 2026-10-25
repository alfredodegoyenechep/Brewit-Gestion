const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('participación y margen se consultan desde estadísticas y conservan su alcance al generar resultados financieros', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-margin-ui-'));
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => {
    await browser.close();
    await app.locals.mercadoPagoSync.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = await page.request.get(`${base}/api/financial-results?location=store-2&dateFrom=2026-10-01&dateTo=2026-10-24`).then(response => response.json());
  const metric = { label: 'Barra Caliente', netSales: 100000, salesSharePercent: 100, marginPercent: 70, contributionMargin: 70000 };
  const queries = [];
  await page.route('**/api/financial-results?*', route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    queries.push(query);
    return route.fulfill({ json: { ...data,
      scope: { label: query.location === 'store-2' ? 'Portal Lyon' : 'Todas las cafeterías' },
      period: { from: query.dateFrom, to: query.dateTo },
      revenue: { ...data.revenue, lineCount: 10, bars: [metric], ingredients: [{ ...metric, label: 'Café' }],
        hierarchies: [{ ...metric, label: 'Café Caliente', bars: [metric], ingredients: [{ ...metric, label: 'Café' }] }] }
    } });
  });
  await page.goto(base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  assert.equal(await page.locator('#refresh-sales-dashboard, #sales-dashboard-location, [data-toteat-sales-sync="dashboard"]').count(), 0);
  assert.deepEqual(await page.locator('#sales-workspace [role="tab"]').allTextContents(), [
    'Participación', 'Modalidad de consumo', 'Jerarquías y margen',
    'Productos y jerarquías', 'Franjas horarias', 'Clientes recurrentes'
  ]);
  assert.equal(await page.getByRole('tab', { name: 'Participación', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#sales-dashboard-metrics, .sales-location-panel').count(), 0);
  assert.equal(await page.locator('#sales-margin-filters').isVisible(), true);
  await page.locator('#sales-margin-location').selectOption('store-2');
  await page.locator('#sales-margin-period').selectOption('custom');
  await page.locator('#sales-margin-from').fill('2026-10-01');
  await page.locator('#sales-margin-to').fill('2026-10-24');
  await page.getByRole('button', { name: 'Generar reportes', exact: true }).click();
  await page.locator('#sales-margin-status').filter({ hasText: '10 línea(s)' }).waitFor();
  assert.deepEqual(queries, [{ location: 'store-2', dateFrom: '2026-10-01', dateTo: '2026-10-24' }]);
  assert.match(await page.locator('#sales-margin-context').innerText(), /Portal Lyon.*01 oct 2026.*24 oct 2026/);
  assert.match(await page.locator('#financial-bars-body').innerText(), /Barra Caliente.*100\.000.*70\.000/s);
  await page.getByRole('button', { name: 'Ver gráfico: Ventas y margen por línea', exact: true }).click();
  assert.equal(await page.locator('#report-chart-dialog').isVisible(), true);
  await page.locator('#report-chart-close').click();
  await page.getByRole('tab', { name: 'Jerarquías y margen', exact: true }).click();
  assert.equal(await page.locator('#sales-margin-filters').isVisible(), false);
  await page.locator('#sales-hierarchy-margin-period').selectOption('custom');
  await page.locator('#sales-hierarchy-margin-from').fill('2026-10-02');
  await page.locator('#sales-hierarchy-margin-to').fill('2026-10-23');
  await page.getByRole('button', { name: 'Generar reportes', exact: true }).click();
  await page.locator('#sales-hierarchy-margin-status').filter({ hasText: '10 línea(s)' }).waitFor();
  assert.match(await page.locator('#financial-hierarchy-list').innerText(), /Café Caliente.*Por barra.*Por ingrediente principal/s);
  assert.equal(queries.length, 2);
  assert.match(await page.locator('#sales-hierarchy-margin-context').innerText(), /Todas las cafeterías.*02 oct 2026.*23 oct 2026/);
  assert.match(await page.locator('#sales-margin-context').innerText(), /Portal Lyon.*01 oct 2026.*24 oct 2026/);
  await page.getByRole('tab', { name: 'Productos y jerarquías', exact: true }).click();
  assert.equal(await page.locator('#sales-margin-controls').isVisible(), false);
  await page.getByRole('link', { name: 'Resultados Financieros', exact: true }).click();
  assert.deepEqual(await page.locator('#financial-results-workspace [role="tab"]').allTextContents(), [
    'Estado de resultados', 'Gastos generales', 'Revisión de costos'
  ]);
  await page.locator('#financial-results-filters button[type="submit"]').click();
  await page.locator('#financial-results-status').filter({ hasText: '10 línea(s)' }).waitFor();
  assert.equal(queries.length, 3);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Participación', exact: true }).click();
  assert.match(await page.locator('#sales-margin-context').innerText(), /Portal Lyon/);
  await page.locator('#sales-margin-location').selectOption('all');
  assert.match(await page.locator('#sales-margin-status').innerText(), /Los filtros cambiaron/);
  assert.match(await page.locator('#sales-margin-context').innerText(), /Portal Lyon/);
  await page.getByRole('button', { name: 'Generar reportes', exact: true }).click();
  await page.locator('#sales-margin-status').filter({ hasText: 'Todas las cafeterías' }).waitFor();
  assert.equal(queries.at(-1).location, 'all');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.main-content')).marginLeft === '0px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('tab', { name: 'Jerarquías y margen', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#sales-hierarchy-margin-from').fill('2026-10-25');
  await page.getByRole('button', { name: 'Generar reportes', exact: true }).click();
  await page.locator('#sales-hierarchy-margin-status').filter({ hasText: 'Selecciona un período válido' }).waitFor();
  assert.equal(queries.length, 4);
  assert.deepEqual(errors, []);
});

test('cada reporte conserva sus filtros y consulta solo al generar, con fechas explícitas en franjas e historial fijo en recurrencia', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-filters-ui-'));
  const app = createApp({ uploadsRoot: root, reportToday: '2026-10-25', enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => {
    await browser.close(); await app.locals.mercadoPagoSync.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], queries = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (['/api/sales/dashboard', '/api/sales/hourly-demand', '/api/sales/hourly-analysis', '/api/financial-results'].includes(url.pathname)) {
      queries.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  assert.equal(queries.length, 0);
  for (const [tab, prefix, location, queryPrefix] of [
    ['Modalidad de consumo', 'sales-service-mode', 'store-1', 'service'],
    ['Productos y jerarquías', 'sales-insight', 'store-2', 'insight']
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    const form = page.locator(`#${prefix}-filters`);
    assert.deepEqual(await form.locator('label').allTextContents().then(labels => labels.slice(0, 4).map(label => label.trim().split('\n')[0])),
      ['Cafetería', 'Período', 'Desde', 'Hasta']);
    await page.locator(`#${prefix}-location`).selectOption(location);
    await page.locator(`#${prefix}-period`).selectOption('custom');
    await page.locator(`#${prefix}-from`).fill('2026-10-01');
    await page.locator(`#${prefix}-to`).fill('2026-10-24');
    if (prefix === 'sales-insight') {
      await page.locator('#sales-insight-bar').selectOption('hot');
      await page.locator('#sales-insight-formats').check();
    }
    const count = queries.length;
    await form.getByRole('button', { name: /Generar reporte/ }).click();
    await page.waitForFunction(prefix => document.querySelector(`#${prefix}-context`).textContent.includes('24 oct 2026'), prefix);
    assert.equal(queries.length, count + 1);
    assert.deepEqual(queries.at(-1), { path: '/api/sales/dashboard', params: {
      location, [`${queryPrefix}DateFrom`]: '2026-10-01', [`${queryPrefix}DateTo`]: '2026-10-24'
    } });
  }
  await page.getByRole('tab', { name: 'Clientes recurrentes', exact: true }).click();
  assert.equal(await page.locator('#sales-customers-period, #sales-customers-from, #sales-customers-to').count(), 0);
  assert.equal(await page.locator('#sales-customers-filters label').count(), 1);
  const beforeCustomers = queries.length;
  await page.locator('#sales-customers-location').selectOption('store-1');
  assert.equal(queries.length, beforeCustomers);
  await page.locator('#sales-customers-filters button[type="submit"]').click();
  await page.locator('#sales-customers-status').filter({ hasText: 'Reporte generado.' }).waitFor();
  assert.deepEqual(queries.at(-1), { path: '/api/sales/dashboard', params: { location: 'store-1' } });
  assert.match(await page.locator('#sales-customers-context').innerText(), /Tienda 1.*Últimos 6 meses y últimas 8 semanas.*25 oct 2026/);
  assert.deepEqual(await page.locator('#mercadopago-period-body th').allTextContents(), ['Hoy', 'Semana', 'Mes']);
  assert.equal(await page.locator('#mercadopago-month-history tr').count(), 6);
  assert.equal(await page.locator('#mercadopago-week-history tr').count(), 8);
  await page.getByRole('tab', { name: 'Modalidad de consumo', exact: true }).click();
  assert.equal(await page.locator('#sales-service-mode-location').inputValue(), 'store-1');
  assert.match(await page.locator('#sales-service-mode-context').innerText(), /Tienda 1/);
  const savedContext = await page.locator('#sales-service-mode-context').innerText();
  const staleReport = await page.evaluate(() => structuredClone(salesServiceModeState));
  staleReport.scope.label = 'Respuesta obsoleta';
  let release, arrived, finished;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  await page.route('**/api/sales/dashboard?*', async route => {
    arrived(); await held;
    try { await route.fulfill({ json: staleReport }); } catch {}
    finally { finished(); }
  });
  await page.locator('#sales-service-mode-filters button[type="submit"]').click();
  await started;
  await page.locator('#sales-service-mode-location').selectOption('all');
  assert.equal(await page.locator('#sales-service-mode-filters button[type="submit"]').isEnabled(), true);
  release(); await completed;
  await page.unroute('**/api/sales/dashboard?*');
  assert.equal(await page.locator('#sales-service-mode-context').innerText(), savedContext);
  assert.match(await page.locator('#sales-service-mode-status').innerText(), /Los filtros cambiaron/);
  await page.locator('#sales-service-mode-location').selectOption('store-1');
  await page.getByRole('tab', { name: 'Productos y jerarquías', exact: true }).click();
  assert.equal(await page.locator('#sales-insight-location').inputValue(), 'store-2');
  assert.equal(await page.locator('#sales-insight-bar').inputValue(), 'hot');
  assert.equal(await page.locator('#sales-insight-formats').isChecked(), true);
  await page.screenshot({ path: '/private/tmp/brewit-report-filters-products.png', fullPage: true });
  const before = queries.length;
  await page.getByRole('tab', { name: 'Franjas horarias', exact: true }).click();
  assert.equal(await page.locator('#hourly-demand-date, #hourly-demand-days').count(), 0);
  await page.locator('#hourly-demand-location').selectOption('store-2');
  await page.locator('#hourly-demand-mode').selectOption('custom');
  await page.locator('#hourly-demand-from').fill('2026-10-02');
  await page.locator('#hourly-demand-to').fill('2026-10-23');
  assert.equal(queries.length, before);
  await page.locator('#refresh-hourly-demand').click();
  await page.locator('#hourly-demand-report-context').filter({ hasText: 'Tienda 2' }).waitFor();
  assert.deepEqual(queries.at(-1), { path: '/api/sales/hourly-demand', params: {
    location: 'store-2', mode: 'custom', dateFrom: '2026-10-02', dateTo: '2026-10-23', aggregation: 'average', interval: '2'
  } });
  await page.locator('#generate-hourly-analysis').click();
  await page.locator('[data-hourly-analysis-level="general"]').click();
  await page.locator('#hourly-analysis-status').filter({ hasText: 'No hay ventas suficientes' }).waitFor();
  assert.equal(queries.at(-1).params.dateFrom, '2026-10-02');
  assert.equal(queries.at(-1).params.dateTo, '2026-10-23');
  await page.locator('#close-hourly-analysis').click();
  await page.screenshot({ path: '/private/tmp/brewit-report-filters-hourly.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['Participación', 'Modalidad de consumo', 'Jerarquías y margen', 'Productos y jerarquías', 'Franjas horarias', 'Clientes recurrentes']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, tab);
  }
  assert.deepEqual(errors, []);
});
