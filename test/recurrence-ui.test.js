const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { setup } = require('./helpers/recurrence-fixture');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const order = { orderKey: 'order-1', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T10:00:00', time: '10:00',
  netSales: 16.81, ticketGross: 20, paymentPaid: 20, monetaryVerified: true, mode: 'takeaway',
  lines: [{ code: 'P1', name: 'Café', categoryId: 'coffee', categoryName: 'Café', netSales: 16.81, quantity: 1 },
    { code: 'EX1', name: 'Extra', isExtra: true, quantity: 5 }] };
test('recurrence UI: manual generation, independent cohorts, lazy purchases, exports, aliases and keyboard/mobile navigation', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t, false, [order]);
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', req => { const url = new URL(req.url()); if (url.pathname.startsWith('/api/sales/recurrence')) requests.push(url); });
  await page.goto(s.base); await page.waitForFunction(() => document.getElementById('financial-general-expenses-grid').childElementCount > 0);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Clientes recurrentes', exact: true }).click();
  assert.deepEqual(await page.locator('[data-recurrence-tab]').allTextContents(), ['Resumen', 'Retorno', 'Compras', 'Calidad de datos', 'Evolución 12 meses', 'Cruces entre cafeterías']);
  for (const tab of ['Retorno', 'Compras', 'Calidad de datos', 'Evolución 12 meses', 'Cruces entre cafeterías', 'Resumen']) await page.getByRole('tab', { name: tab, exact: true }).click();
  assert.equal(requests.length, 0); assert.equal(s.reads(), 0);
  await page.locator('#sales-customers-location').selectOption('store-1');
  await page.locator('#sales-customers-period').selectOption('custom'); await page.locator('#sales-customers-from').fill('2026-10-01'); await page.locator('#sales-customers-to').fill('2026-10-07');
  assert.equal(requests.length, 0);
  await page.locator('#sales-customers-filters [type=submit]').click(); await page.locator('#sales-customers-status').filter({ hasText: 'Reporte generado.' }).waitFor();
  assert.equal(requests.length, 1); assert.equal(s.reads(), 0);
  assert.equal(await page.locator('.recurrence-kpi').count(), 4); assert.equal(await page.locator('.recurrence-kpi > strong').first().innerText(), '3');
  assert.match(await page.locator('#sales-customers-context').innerText(), /Tienda 1.*01 oct 2026.*07 oct 2026/);
  await page.getByRole('tab', { name: 'Retorno', exact: true }).click();
  await page.locator('#recurrence-cohort-from').fill('2026-09-01'); await page.locator('#recurrence-cohort-to').fill('2026-09-30'); await page.locator('#recurrence-cohort-granularity').selectOption('month');
  assert.equal(requests.length, 1); await page.locator('#recurrence-return-run').click();
  await page.locator('#recurrence-return-status').filter({ hasText: 'Sección preparada' }).waitFor();
  assert.equal(requests.length, 2); assert.equal(requests.at(-1).searchParams.get('from'), '2026-09-01');
  assert.match(await page.locator('#recurrence-return-content').innerText(), /100,0%/);
  assert.equal(await page.locator('#sales-customers-from').inputValue(), '2026-10-01');
  await page.locator('#recurrence-common-base').check(); assert.equal(requests.length, 2); await page.locator('#recurrence-return-run').click();
  await page.waitForFunction(() => document.getElementById('recurrence-return-status').textContent.includes('Sección preparada'));
  await page.getByRole('tab', { name: 'Compras', exact: true }).click(); assert.equal(s.reads(), 0);
  await page.locator('#recurrence-purchases-run').click(); await page.locator('#recurrence-purchases-status').filter({ hasText: 'Sección preparada' }).waitFor();
  assert.equal(s.reads(), 1); assert.match(await page.locator('#recurrence-purchases-content').innerText(), /Pedidos de regreso.*Café/s);
  assert.equal(await page.locator('#recurrence-purchases-content .recurrence-subpanel').nth(1).locator('table').first().locator('tbody td').last().innerText(), '1');
  await page.getByRole('tab', { name: 'Calidad de datos', exact: true }).click(); await page.locator('#recurrence-quality-run').click();
  await page.locator('#recurrence-quality-status').filter({ hasText: 'Sección preparada' }).waitFor(); assert.equal(s.reads(), 1);
  assert.match(await page.locator('#recurrence-quality-content').innerText(), /Clasificables.*1/s);
  for (const [name, kind] of [['Evolución 12 meses', 'monthly'], ['Cruces entre cafeterías', 'network']]) {
    const countBefore = requests.length; await page.getByRole('tab', { name, exact: true }).click(); assert.equal(requests.length, countBefore);
    await page.locator(`#recurrence-${kind}-run`).click(); await page.locator(`#recurrence-${kind}-status`).filter({ hasText: 'Sección preparada' }).waitFor();
    assert.equal(requests.length, countBefore + 1); assert.equal(await page.locator(`#recurrence-${kind}-content svg`).count(), 1);
    assert.equal(await page.locator(`#recurrence-${kind}-content > .recurrence-scroll`).first().locator('tbody tr').count(), 12);
    await page.locator(`#recurrence-${kind}-content select`).first().selectOption('60'); assert.equal(requests.length, countBefore + 1);
    assert.match(await page.locator(`#recurrence-${kind}-content`).innerText(), /incluidos los pagos no identificables/);
  }
  await page.getByRole('tab', { name: 'Resumen', exact: true }).click(); await page.locator('.recurrence-kpi').first().getByRole('button', { name: 'Ver detalle' }).click();
  await page.locator('#recurrence-detail-dialog').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.getElementById('recurrence-detail-status').textContent.includes('6 registros'));
  assert.match(await page.locator('#recurrence-detail-content').innerText(), /MP-/); assert.ok(!(await page.locator('#recurrence-detail-content').innerText()).includes('123456'));
  await page.keyboard.press('Escape');
  const pending = page.waitForEvent('download'); await page.locator('#recurrence-export').click(); const download = await pending;
  const file = path.join(os.tmpdir(), `brewit-recurrence-${Date.now()}.xlsx`); await download.saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const workbook = XLSX.readFile(file); assert.ok(workbook.SheetNames.includes('Metadatos')); assert.ok(workbook.SheetNames.includes('Cohortes')); assert.ok(workbook.SheetNames.includes('Pedidos')); assert.ok(workbook.SheetNames.includes('Evolucion12Meses')); assert.ok(workbook.SheetNames.includes('CrucesRed12Meses')); assert.ok(workbook.SheetNames.includes('CrucesPorOrigen'));
  const exported = JSON.stringify(workbook.SheetNames.map(name => XLSX.utils.sheet_to_json(workbook.Sheets[name]))); assert.ok(exported.includes('recurrence-dates-v2')); assert.ok(!exported.includes('123456'));
  const before = requests.length; await page.locator('#recurrence-tab-summary').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#recurrence-tab-return').getAttribute('aria-selected'), 'true'); assert.equal(requests.length, before);
  for (const width of [390, 768, 1500]) { await page.setViewportSize({ width, height: 1100 }); for (const tab of ['Resumen', 'Retorno', 'Compras', 'Calidad de datos', 'Evolución 12 meses', 'Cruces entre cafeterías']) { await page.getByRole('tab', { name: tab, exact: true }).click(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${tab} at ${width}`); } }
  assert.deepEqual(errors, []);
});
test('recurrence UI: slow responses cannot replace a changed cafeteria and failed sections can be retried', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(s.base); await page.waitForFunction(() => document.getElementById('financial-general-expenses-grid').childElementCount > 0);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click(); await page.getByRole('tab', { name: 'Clientes recurrentes', exact: true }).click();
  await page.locator('#sales-customers-location').selectOption('store-1'); await page.locator('#sales-customers-filters [type=submit]').click(); await page.locator('#sales-customers-status').filter({ hasText: 'Reporte generado.' }).waitFor();
  const saved = await page.locator('#sales-customers-context').innerText();
  let arrived, release, finished; const started = new Promise(r => { arrived = r; }), held = new Promise(r => { release = r; }), done = new Promise(r => { finished = r; });
  await page.route('**/api/sales/recurrence?*', async route => { arrived(); await held; try { await route.fulfill({ status: 503, json: { error: 'Respuesta obsoleta' } }); } catch {} finally { finished(); } });
  await page.locator('#sales-customers-filters [type=submit]').click(); await started; await page.locator('#sales-customers-location').selectOption('store-2'); release(); await done;
  assert.equal(await page.locator('#sales-customers-context').innerText(), saved); assert.match(await page.locator('#sales-customers-status').innerText(), /Los filtros cambiaron/);
  assert.equal(await page.locator('#sales-customers-filters [type=submit]').isEnabled(), true); await page.unroute('**/api/sales/recurrence?*');
  await page.locator('#sales-customers-location').selectOption('store-1'); await page.locator('#sales-customers-filters [type=submit]').click(); await page.locator('#sales-customers-status').filter({ hasText: 'Reporte generado.' }).waitFor();
  await page.getByRole('tab', { name: 'Compras', exact: true }).click(); await page.route('**/api/sales/recurrence/*/purchases?*', route => route.fulfill({ status: 503, json: { error: 'Fuente temporalmente no disponible' } }));
  await page.locator('#recurrence-purchases-run').click(); await page.locator('#recurrence-purchases-status').filter({ hasText: 'Fuente temporalmente' }).waitFor(); assert.equal(await page.locator('#recurrence-purchases-run').isEnabled(), true);
  await page.unroute('**/api/sales/recurrence/*/purchases?*'); await page.locator('#recurrence-purchases-run').click(); await page.locator('#recurrence-purchases-status').filter({ hasText: 'Sección preparada' }).waitFor();
});
