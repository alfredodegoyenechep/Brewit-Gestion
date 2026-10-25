const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('los tres niveles horarios envían su alcance y muestran e imprimen sus propios detalles', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-hourly-levels-ui-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', enableLegacyTools: true, reportToday: '2026-10-25', enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => {
    await browser.close(); await app.locals.mercadoPagoSync.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos', 'ID Producto', 'Nombre', 'Cantidad', 'Precio a Pagar', 'Descuento', 'Categorías de Productos/Platos']];
  for (let day = 20; day <= 24; day++) {
    for (const [code, name, hierarchy, quantity] of [['P1', 'Café', 'Bebidas', 2], ['P2', 'Matcha', 'Bebidas', 1], ['P3', 'Sándwich', 'Comida', 3]]) {
      rows.push([`${code}-${day}`, `2026-10-${day}`, '08:30:00', 119 * quantity, 0, code, name, quantity, 119 * quantity, 0, hierarchy]);
    }
  }
  const form = new FormData();
  form.append('sales', new Blob([rows.map(row => row.join('\t')).join('\n')]), 'ventas-niveles.csv');
  const manifest = await fetch(`${base}/api/uploads/transactions/inspect?location=store-1`, { method: 'POST', body: form }).then(r => r.json());
  assert.ok(manifest.detectedRange, JSON.stringify(manifest));
  const confirmation = await fetch(`${base}/api/uploads/transactions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: manifest.token, dateFrom: manifest.detectedRange.from, dateTo: manifest.detectedRange.to, confirmed: true, categoryConfirmed: true, overlapAction: 'keep' }) });
  assert.equal(confirmation.status, 200);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/sales/hourly-analysis') requests.push(Object.fromEntries(url.searchParams));
  });
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('financial-general-expenses-grid').childElementCount > 0);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Franjas horarias', exact: true }).click();
  await page.locator('#hourly-demand-location').selectOption('store-1');
  await page.locator('#hourly-demand-mode').selectOption('custom');
  await page.locator('#hourly-demand-from').fill('2026-10-20');
  await page.locator('#hourly-demand-to').fill('2026-10-24');
  const expected = { general: [], hierarchy: ['hierarchy'], product: ['hierarchy', 'product'] };
  for (const level of ['general', 'hierarchy', 'product', 'general']) {
    await page.locator('#generate-hourly-analysis').click();
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/hourly-analysis'),
      page.locator(`#hourly-analysis-options-dialog button[data-hourly-analysis-level="${level}"]`).click()
    ]);
    const report = await response.json();
    await page.waitForFunction(level => document.getElementById('hourly-analysis-report').dataset.analysisLevel === level, level);
    assert.equal(report.analysisLevel, level);
    assert.equal(requests.at(-1).analysisLevel, level);
    assert.equal(requests.at(-1).location, 'store-1');
    assert.equal(requests.at(-1).dateFrom, '2026-10-20');
    assert.equal(requests.at(-1).dateTo, '2026-10-24');
    assert.equal(report.sampleSize, 5);
    if (requests.length === 1) {
      const cv = page.locator('#hourly-analysis-metrics .cv-help-trigger').first();
      await cv.click();
      const help = page.getByRole('dialog', { name: '¿Qué significa CV?', exact: true });
      assert.equal(await help.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await help.isVisible(), false);
      assert.equal(await cv.evaluate(button => button === document.activeElement), true);
      assert.equal(await page.locator('#hourly-analysis-dialog').evaluate(dialog => dialog.open), true);
      await cv.press('Enter');
      await help.getByRole('button', { name: 'Entendido', exact: true }).click();
      assert.equal(await help.isVisible(), false);
    }
    assert.deepEqual(await page.locator('.hourly-analysis-breakdown').evaluateAll(sections => sections.map(section => section.dataset.analysisLevel)), expected[level]);
    if (level !== 'general') {
      assert.equal(await page.locator('[data-breakdown-level="hierarchy"] tbody tr').count(), 2);
      await page.locator('#hourly-analysis-navigation').getByRole('button', { name: 'Jerarquías (2)', exact: true }).click();
      assert.ok(await page.locator('#hourly-analysis-dialog').evaluate(dialog => dialog.scrollTop) > 0);
    }
    if (level === 'product') {
      assert.equal(await page.locator('[data-breakdown-level="product"] tbody tr').count(), 3);
      await page.locator('#hourly-analysis-navigation').getByRole('button', { name: 'Productos (3)', exact: true }).click();
      assert.ok(await page.locator('#hourly-analysis-detail-product').evaluate(section => {
        const top = section.getBoundingClientRect().top;
        const dialog = section.closest('dialog').getBoundingClientRect();
        return top >= dialog.top && top < dialog.bottom;
      }));
    }
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.body.classList.add('printing-hourly-analysis'));
    assert.equal(await page.locator('#hourly-analysis-report').isVisible(), true);
    assert.equal(await page.locator('#hourly-analysis-navigation').isVisible(), false);
    for (const detail of expected[level]) assert.equal(await page.locator(`#hourly-analysis-detail-${detail}`).isVisible(), true);
    await page.evaluate(() => document.body.classList.remove('printing-hourly-analysis'));
    await page.emulateMedia({ media: 'screen' });
    await page.locator('#close-hourly-analysis').click();
  }
  for (const [aggregation, units, heading] of [['total', 30, 'Unidades totales'], ['average', 6, 'Unidades promedio']]) {
    await page.locator('#hourly-demand-aggregation').selectOption(aggregation);
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/hourly-demand'),
      page.locator('#refresh-hourly-demand').click()
    ]);
    const report = await response.json();
    assert.equal(report.totals.quantity, units);
    await page.waitForFunction(heading => document.getElementById('hourly-demand-units-heading').textContent === heading, heading);
    await page.locator('#generate-hourly-analysis').click();
    await page.locator('#hourly-analysis-options-dialog button[data-hourly-analysis-level="product"]').click();
    await page.waitForFunction(heading => document.querySelector('#hourly-analysis-metrics article span').textContent === heading, heading);
    assert.match(await page.locator('#hourly-analysis-metrics article').first().innerText(), new RegExp(`${units},0 unidades`));
    assert.equal(await page.locator('[data-breakdown-level="product"] th').nth(3).textContent(), heading);
    await page.locator('#close-hourly-analysis').click();
  }
  await page.locator('#hourly-demand-mode').selectOption('date');
  assert.equal(await page.locator('#hourly-demand-from').isVisible(), false);
  assert.equal(await page.locator('#hourly-demand-to').isVisible(), true);
  assert.deepEqual(await page.locator('#hourly-demand-occurrences option').evaluateAll(options => options.map(option => option.value)), ['1', '2', '4', '8', '26', '52']);
  await page.locator('#hourly-demand-occurrences').selectOption('8');
  const [weeklyResponse] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/hourly-demand'),
    page.locator('#refresh-hourly-demand').click()
  ]);
  const weekly = await weeklyResponse.json();
  assert.equal(weekly.requestedDates.length, 8);
  assert.equal(weekly.sampleSize, 1);
  assert.equal(weekly.selectedDates[0], '2026-10-24');
  await page.locator('#hourly-demand-report-context').filter({ hasText: '8 fecha(s)' }).waitFor();
  assert.equal(new URL(weeklyResponse.url()).searchParams.get('dateFrom'), null);
  await page.screenshot({ path: '/private/tmp/brewit-hourly-weekdays-selector.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.main-content')).marginLeft === '0px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A pending or failed query must not display or print the preceding report.
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/sales/hourly-analysis?*', async route => {
    arrived(); await held;
    await route.fulfill({ status: 500, json: { error: 'No se pudo generar el análisis de productos.' } });
  });
  await page.locator('#generate-hourly-analysis').click();
  await page.locator('#hourly-analysis-options-dialog button[data-hourly-analysis-level="product"]').click();
  await started;
  assert.equal(await page.locator('#hourly-analysis-content').isVisible(), false);
  assert.equal(await page.locator('#print-hourly-analysis').isDisabled(), true);
  assert.match(await page.locator('#hourly-analysis-title').innerText(), /jerarquías y productos/);
  assert.equal(await page.locator('#hourly-analysis-dialog').evaluate(dialog => dialog.scrollTop), 0);
  release();
  await page.locator('#hourly-analysis-status').filter({ hasText: 'No se pudo generar' }).waitFor();
  assert.equal(await page.locator('#hourly-analysis-content').isVisible(), false);
  assert.equal(await page.locator('#print-hourly-analysis').isDisabled(), true);
  assert.deepEqual(errors, []);
});
