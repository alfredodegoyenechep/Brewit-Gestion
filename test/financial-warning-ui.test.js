const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('every warning opens an accessible evidence dialog and restores focus on Escape', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-warning-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot: root }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const financialRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/financial-results');
  await page.locator('[data-view="financial-results"]').click();
  await page.locator('#financial-results-filters button[type="submit"]').click();
  assert.equal(new URL((await financialRequest).url()).searchParams.has('costValuation'), false);
  await page.waitForFunction(() => document.querySelectorAll('#financial-warnings-list button').length > 0);
  assert.equal(await page.locator('#financial-cost-valuation').count(), 0);
  assert.match(await page.locator('#financial-statement-context').innerText(), /Costo al corte del reporte/);
  const buttons = page.locator('#financial-warnings-list button');
  const count = await buttons.count();
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    const text = await button.innerText();
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Datos que requieren revisión', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.financial-warning-message').innerText(), text);
    assert.match(await dialog.innerText(), /Qué revisar y corregir/);
    assert.ok(await dialog.locator('tbody tr').count() > 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.financial-warning-dialog'));
    assert.equal(await page.locator('.financial-warning-dialog').count(), 0);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
  }
  assert.deepEqual(errors, []);
});

test('late financial response cannot replace a newer period or its status', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-financial-race-'));
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const template = await fetch(`${base}/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-02`).then(response => response.json());
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); await app.locals.mercadoPagoSync.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(base);
  await page.locator('[data-view="financial-results"]').click();
  await page.evaluate(() => {
    const originalRequest = apiRequest;
    window.financialRaceRequests = [];
    apiRequest = (url, options) => url.startsWith('/api/financial-results?')
      ? new Promise((resolve, reject) => window.financialRaceRequests.push({ resolve, reject, url, options }))
      : originalRequest(url, options);
    const from = document.getElementById('financial-results-from');
    const period = document.getElementById('financial-results-period');
    period.value = 'custom'; period.dispatchEvent(new Event('change'));
    from.value = '2026-10-01'; from.dispatchEvent(new Event('change'));
    const old = loadFinancialResults();
    from.value = '2026-10-02'; from.dispatchEvent(new Event('change'));
    const recent = loadFinancialResults();
    window.financialRaceDone = Promise.allSettled([old, recent]);
  });
  assert.equal(await page.evaluate(() => window.financialRaceRequests.length), 2);
  await page.evaluate(data => window.financialRaceRequests[1].resolve({ ...data, scope: { ...data.scope, label: 'NUEVO' } }), template);
  await page.waitForFunction(() => financialResultsState?.scope?.label === 'NUEVO');
  await page.evaluate(() => window.financialRaceRequests[0].reject(new Error('ANTIGUO')));
  await page.evaluate(() => window.financialRaceDone);
  assert.equal(await page.evaluate(() => financialResultsState.scope.label), 'NUEVO');
  assert.equal(await page.locator('#financial-results-filters button[type="submit"]').isDisabled(), false);
  assert.doesNotMatch(await page.locator('#financial-results-status').innerText(), /ANTIGUO/);
});
