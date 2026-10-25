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
  await page.waitForFunction(() => !document.getElementById('refresh-sales-dashboard').disabled);
  assert.deepEqual(await page.locator('#sales-workspace [role="tab"]').allTextContents(), [
    'Participación', 'Modalidad de consumo', 'Jerarquías y margen',
    'Productos y jerarquías', 'Franjas horarias', 'Clientes recurrentes'
  ]);
  assert.equal(await page.getByRole('tab', { name: 'Participación', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#sales-dashboard-metrics, .sales-location-panel').count(), 0);
  assert.equal(await page.locator('#sales-margin-filters').isVisible(), true);
  await page.locator('#sales-dashboard-location').selectOption('store-2');
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
  assert.match(await page.locator('#financial-hierarchy-list').innerText(), /Café Caliente.*Por barra.*Por ingrediente principal/s);
  assert.equal(await page.locator('#sales-margin-filters').isVisible(), true);
  assert.equal(queries.length, 1);
  await page.getByRole('tab', { name: 'Productos y jerarquías', exact: true }).click();
  assert.equal(await page.locator('#sales-margin-controls').isVisible(), false);
  await page.getByRole('link', { name: 'Resultados Financieros', exact: true }).click();
  assert.deepEqual(await page.locator('#financial-results-workspace [role="tab"]').allTextContents(), [
    'Estado de resultados', 'Gastos generales', 'Revisión de costos'
  ]);
  await page.locator('#financial-results-filters button[type="submit"]').click();
  await page.locator('#financial-results-status').filter({ hasText: '10 línea(s)' }).waitFor();
  assert.equal(queries.length, 2);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Participación', exact: true }).click();
  assert.match(await page.locator('#sales-margin-context').innerText(), /Portal Lyon/);
  await page.locator('#sales-dashboard-location').selectOption('all');
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
  await page.locator('#sales-margin-from').fill('2026-10-25');
  await page.getByRole('button', { name: 'Generar reportes', exact: true }).click();
  await page.locator('#sales-margin-status').filter({ hasText: 'Selecciona un período válido.' }).waitFor();
  assert.equal(queries.length, 3);
  assert.deepEqual(errors, []);
});
