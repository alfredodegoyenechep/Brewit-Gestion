const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('el resumen abre el detalle de carga y permite revisar pagos sin productos', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const states = [
    { location: 'store-1', name: 'La Concepción', configured: true, lastSuccess: '2026-09-23T13:19:37Z', from: '2026-09-01', through: '2026-09-23', orderCount: 20, paymentCount: 21, completedWindows: 2, enabled: true, intervalMinutes: 5, detailWarnings: [{ orderId: '<orden>', paymentId: 'p-12', total: 4500, reason: 'Sin productos asociados.' }] },
    { location: 'store-2', name: 'Portal Lyon', configured: true, running: true, progress: 'Consultando 1 de 2', orderCount: 0, paymentCount: 0 }
  ];
  states[0].detailWarnings[0].closedAt = { date: '2026-09-23', time: '10:19:37' };
  await page.route('http://brewit.test/**', async route => {
    const url = route.request().url();
    let body;
    if (url.endsWith('/api/config/locations')) body = { active: states.map(s => ({ id: s.location, name: s.name, type: 'store' })) };
    else if (url.includes('/sales/status')) body = { locations: states };
    else if (url.includes('/sales/warning-resolution')) {
      const update = route.request().postDataJSON();
      states.find(s => s.location === update.location).detailWarnings.find(w => w.paymentId === update.paymentId).resolved = update.resolved;
      body = update;
    }
    else if (url.includes('/api/config?')) body = { configured: false };
    else return route.fulfill({ contentType: 'text/html', body: '<form id="toteat-api-form"><select id="toteat-api-location"></select><input name="token"><input name="restaurantId"><input name="localId"><input name="userId"></form><p id="toteat-api-status"></p><button id="toteat-api-refresh"></button><form id="toteat-sales-settings"><input name="from"><input name="frequency"><button type="submit"></button></form><div data-toteat-sales-status></div>' });
    return route.fulfill({ json: body });
  });
  await page.goto('http://brewit.test/');
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../toteat-api-view.js'), 'utf8') });
  const trigger = page.getByRole('button', { name: /La Concepción:.*Ver detalle/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /2026-09-01 → 2026-09-23/);
  assert.match(await dialog.innerText(), /incluidos en los totales/);
  assert.deepEqual(await dialog.locator('tbody td').allTextContents(), ['<orden>', 'p-12', '23-09-2026', '10:19:37', '$4.500', 'Sin productos asociados.', '']);
  await dialog.getByRole('checkbox', { name: 'Resuelto: pago p-12' }).check();
  await page.getByText('No quedan pagos sin resolver.', { exact: false }).waitFor();
  await dialog.getByLabel('Filtrar pagos por resolución').selectOption('all');
  assert.equal(await dialog.getByRole('checkbox').isChecked(), true);
  await dialog.getByRole('checkbox').uncheck();
  await page.waitForFunction(() => document.querySelector('.sales-load-content')?.textContent.includes('1 no resueltos · 0 resueltos'));
  await dialog.getByLabel('Filtrar pagos por resolución').selectOption('unresolved');
  assert.equal(await dialog.locator('tbody tr').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  await page.getByRole('button', { name: /Portal Lyon:.*Ver detalle/ }).click();
  assert.match(await dialog.innerText(), /Consultando 1 de 2/);
  assert.match(await dialog.innerText(), /después de la primera carga exitosa/);
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  assert.equal(await dialog.isVisible(), false);
});

test('finding evidence exposes nested source fields safely and closes with Escape', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<button id="open">Ver antecedentes</button>');
  const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
  await page.addScriptTag({ content: script.slice(script.indexOf('function openFindingEvidence('), script.indexOf('function renderFindingsView(')) });
  await page.evaluate(() => document.getElementById('open').addEventListener('click', () => openFindingEvidence({ number: 42, evidence: [
    { 'ID de Pago': '1781214555443344', 'Fecha de cierre': '2026-06-10', 'Hora de cierre': '08:01:04', Folio: null, Cantidad: -1, 'Documento original API': { document_type: 'CREDIT_NOTE', observation: '<img src=x onerror=alert(1)>' } },
    { Documento: 'NC-42', 'Q.Rec': -2 }
  ] })));
  await page.getByRole('button', { name: 'Ver antecedentes' }).click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.innerText(), /1781214555443344/);
  assert.match(await dialog.innerText(), /08:01:04/);
  assert.match(await dialog.innerText(), /CREDIT_NOTE/);
  assert.match(await dialog.innerText(), /No informado por la fuente/);
  assert.equal(await dialog.locator('img').count(), 0);
  await dialog.locator('summary').nth(1).click();
  assert.match(await dialog.innerText(), /Q.Rec/);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
});
