const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { setup } = require('./helpers/product-xray-fixture');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const [prefix, title] of [['product-timeline', 'Productos en el tiempo'], ['daily-distribution', 'Distribución diaria']]) {
  const endpoint = `/api/sales/${prefix}`;
  async function open(page, s) {
    await page.goto(s.base); await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
    await page.getByRole('tab', { name: title, exact: true }).click();
    await page.waitForFunction(prefix => !document.getElementById(`${prefix}-picker`).disabled, prefix);
    await page.locator(`#${prefix}-mode`).selectOption('products');
    await page.locator(`#${prefix}-choices input[value="P0"]`).check();
  }
  test(`${title}: one final action waits for automatic options, preserves choices and ignores outdated responses`, { skip: !fs.existsSync(chrome) }, async t => {
    const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }), errors = [], reports = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === endpoint) reports.push(new URL(request.url())); });
    await open(page, s);
    const root = page.locator(`#${prefix}-workspace`), run = page.locator(`#${prefix}-run`);
    assert.equal(await root.getByRole('button', { name: 'Actualizar opciones del período' }).count(), 0);
    assert.equal(await root.locator('button[type=submit]').count(), 1);
    assert.equal(await run.evaluate((button, prefix) => Boolean(document.getElementById(`${prefix}-picker`).compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING), prefix), true);
    assert.equal(await run.evaluate((button, prefix) => button.getBoundingClientRect().top >= document.getElementById(`${prefix}-picker`).getBoundingClientRect().bottom, prefix), true);
    const query = new URLSearchParams({ location: 'all', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-08' });
    const options = await fetch(`${s.base}${endpoint}/options?${query}`).then(response => response.json());
    const latest = { ...options, products: options.products.filter(product => ['P0', 'P1'].includes(product.code)) };
    const oldStarted = deferred(), releaseOld = deferred(), oldFinished = deferred(), pendingStarted = deferred(), releasePending = deferred();
    await page.route(`**${endpoint}/options?*`, async route => {
      const to = new URL(route.request().url()).searchParams.get('dateTo');
      if (to === '2026-10-07') { oldStarted.resolve(); await releaseOld.promise; await route.fulfill({ json: { ...options, products: options.products.filter(product => product.code === 'BAK') } }).catch(() => {}); oldFinished.resolve(); return; }
      if (to === '2026-10-09') { pendingStarted.resolve(); await releasePending.promise; }
      await route.fulfill({ json: latest });
    });
    await page.locator(`#${prefix}-search`).fill('Latte');
    await page.locator(`#${prefix}-period`).selectOption('custom');
    await page.locator(`#${prefix}-from`).fill('2026-10-01'); await page.locator(`#${prefix}-to`).fill('2026-10-07');
    await oldStarted.promise;
    assert.equal(await page.locator(`#${prefix}-picker`).evaluate(picker => picker.disabled), true);
    await page.locator(`#${prefix}-to`).fill('2026-10-08');
    await page.waitForFunction(prefix => !document.getElementById(`${prefix}-picker`).disabled, prefix);
    assert.equal(await page.locator(`#${prefix}-choices input[value="P0"]`).isChecked(), true);
    assert.equal(await page.locator(`#${prefix}-search`).inputValue(), 'Latte');
    releaseOld.resolve(); await oldFinished.promise;
    assert.equal(await page.locator(`#${prefix}-choices input[value="BAK"]`).count(), 0);
    assert.equal(await page.locator(`#${prefix}-choices input[value="P2"]`).count(), 0);
    assert.equal(reports.length, 0, 'automatic options must not generate reports');
    await page.locator(`#${prefix}-to`).fill('2026-10-09'); await pendingStarted.promise;
    await run.click(); assert.equal(await run.isDisabled(), true); assert.equal(reports.length, 0);
    releasePending.resolve();
    await page.locator(`#${prefix}-status`).filter({ hasText: 'Reporte generado' }).waitFor();
    assert.equal(reports.length, 1); assert.equal(reports[0].searchParams.get('dateTo'), '2026-10-09');
    assert.deepEqual(JSON.parse(reports[0].searchParams.get('products')), ['P0']);
    await root.screenshot({ path: `/private/tmp/brewit-single-report-action-${prefix}.png` });
    assert.deepEqual(errors, []);
  });
  test(`${title}: the same Generate button retries an automatic list failure and validates temporary date ranges`, { skip: !fs.existsSync(chrome) }, async t => {
    const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
    const page = await browser.newPage(); await open(page, s);
    let attempts = 0, reports = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === endpoint) reports++; });
    await page.route(`**${endpoint}/options?*`, route => ++attempts === 1
      ? route.fulfill({ status: 503, json: { error: 'Listas temporalmente no disponibles.' } }) : route.continue());
    await page.locator(`#${prefix}-period`).selectOption('custom');
    await page.locator(`#${prefix}-from`).fill('2026-10-01'); await page.locator(`#${prefix}-to`).fill('2026-10-07');
    await page.locator(`#${prefix}-options-status`).filter({ hasText: 'Listas temporalmente no disponibles' }).waitFor();
    assert.equal(await page.locator(`#${prefix}-run`).isEnabled(), true); assert.equal(reports, 0);
    await page.locator(`#${prefix}-run`).click();
    await page.locator(`#${prefix}-status`).filter({ hasText: 'Reporte generado' }).waitFor();
    assert.equal(attempts, 2); assert.equal(reports, 1);
    await page.locator(`#${prefix}-from`).fill('2026-10-15');
    await page.locator(`#${prefix}-options-status`).filter({ hasText: 'Completa un rango' }).waitFor();
    assert.equal(attempts, 2, 'an incomplete date edit must not request invalid options');
    await page.locator(`#${prefix}-to`).fill('2026-10-16');
    await page.waitForFunction(prefix => !document.getElementById(`${prefix}-picker`).disabled, prefix);
    assert.equal(attempts, 3); assert.equal(reports, 1);
    assert.equal(await page.locator(`#${prefix}-choices input[value="P0"]`).isChecked(), true);
  });
}
