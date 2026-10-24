const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-settings-ui-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { page, base: `http://127.0.0.1:${server.address().port}` };
}
const editor = page => page.locator('#location-editor-list .location-row:visible');
async function config(page) { await page.locator('[data-view="config"]').click(); }
async function editFirst(page) { await page.locator('#active-locations-list .location-summary button').first().click(); }

test('Configuración: fichas, cambios pendientes, calendario, creación y papelera', { skip: !fs.existsSync(chrome) }, async t => {
  const { page, base } = await setup(t);
  const initial = await page.request.get(`${base}/api/config/locations`).then(r => r.json());
  const store = initial.active.find(item => item.type === 'store');
  const hours = { 1: { open: '07:30', close: '20:00' }, 2: { open: '08:00', close: '19:00' } };
  await page.request.patch(`${base}/api/config/locations/${store.id}`, { data: { name: store.name, address: store.address || '', operatingHours: hours, closedDates: ['2026-12-25'] } });
  await page.goto(base); await config(page);
  await page.locator('.location-summary').first().waitFor();
  assert.equal(await page.locator('#location-settings input:visible').count(), 0);
  await editFirst(page);
  const name = editor(page).getByLabel(`Nombre de ${store.name}`, { exact: true });
  await name.fill('Nombre sin guardar');
  await editor(page).getByLabel(/Apertura Lun–Vie/).fill('09:00');
  await page.getByRole('tab', { name: 'Empresa y preferencias' }).click();
  await page.getByRole('button', { name: 'Continuar editando' }).click();
  assert.equal(await name.inputValue(), 'Nombre sin guardar');
  await page.locator('[data-view="uploads"]').click();
  await page.getByRole('button', { name: 'Descartar cambios' }).click();
  assert.equal(await page.locator('#upload-overview').isVisible(), true);
  await config(page);
  assert.equal(await name.inputValue(), store.name);
  await editor(page).getByLabel(`Dirección de ${store.name}`).fill('Nueva dirección 123');
  await editor(page).getByRole('button', { name: /Guardar cambios/ }).click();
  await page.locator('#location-status.success').waitFor();
  const saved = await page.request.get(`${base}/api/config/locations`).then(r => r.json()).then(data => data.active.find(item => item.id === store.id));
  assert.deepEqual(saved.operatingHours, hours);
  assert.deepEqual(saved.closedDates, ['2026-12-25']);
  await page.getByRole('tab', { name: 'Empresa y preferencias' }).click();
  await page.locator('#company-name').fill('Brewit Prueba SPA');
  await page.locator('#company-export-decimal-system').selectOption('dot');
  await page.getByRole('button', { name: 'Guardar datos de Brewit' }).click();
  await page.locator('#company-profile-status.success').waitFor();
  const company = await page.request.get(`${base}/api/config/company`).then(r => r.json());
  assert.equal(company.name, 'Brewit Prueba SPA');
  assert.equal(company.exportDecimalSystem, 'dot');
  await page.getByRole('tab', { name: 'Locales y bodegas' }).click();
  await page.locator('#location-editor-back').click();
  await page.getByRole('button', { name: 'Nueva ubicación', exact: true }).click();
  await page.locator('#new-location-name').fill('Cafetería nueva');
  await page.getByRole('button', { name: 'Crear ubicación', exact: true }).click();
  await page.locator('#location-editor-title').filter({ hasText: 'Editar Cafetería nueva' }).waitFor();
  await editor(page).getByLabel('Fecha de apertura de Cafetería nueva').fill('2026-10-24');
  await editor(page).getByRole('button', { name: /Guardar cambios/ }).click();
  await page.waitForFunction(() => document.querySelector('#location-editor-list .location-row:not([hidden])')?.dataset.saving !== 'true');
  await page.locator('#location-editor-back').click();
  await page.getByRole('button', { name: 'Nueva ubicación', exact: true }).click();
  await page.locator('#new-location-name').fill('Bodega nueva');
  await page.locator('#new-location-type').selectOption('warehouse');
  await page.getByRole('button', { name: 'Crear ubicación', exact: true }).click();
  await page.locator('#location-editor-title').filter({ hasText: 'Editar Bodega nueva' }).waitFor();
  assert.equal(await editor(page).locator('.location-weekly-hours').count(), 0);
  await editor(page).getByRole('button', { name: 'Enviar a papelera' }).click();
  await page.locator('#continue-location-trash').click();
  await page.locator('#location-trash-confirmation-name').fill('Bodega nueva');
  await page.locator('#confirm-location-trash').click();
  await page.locator('#location-trash-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Ver papelera' }).click();
  await page.locator('#trashed-locations-list .location-row').filter({ hasText: 'Bodega nueva' }).getByRole('button', { name: 'Restaurar' }).click();
  await page.locator('#trashed-locations-list').filter({ hasText: 'La papelera está vacía' }).waitFor();
  const restored = await page.request.get(`${base}/api/config/locations`).then(r => r.json());
  assert.ok(restored.active.some(item => item.name === 'Bodega nueva'));
});

test('Configuración: guardar no sincroniza, contexto independiente y respuestas tardías', { skip: !fs.existsSync(chrome) }, async t => {
  const { page, base } = await setup(t);
  await page.clock.install();
  const writes = [];
  const states = ['store-1', 'store-2'].map((location, index) => ({ location, name: `Cafetería ${index + 1}`, configured: true, from: `2026-0${index + 8}-01`, manualOnly: true, enabled: false, warnings: [], detailWarnings: [] }));
  let delayFirst = false, releaseFirst;
  await page.route('**/api/integrations/toteat/api/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      return route.fulfill({ json: {} });
    }
    if (url.pathname.endsWith('/config')) {
      const id = url.searchParams.get('location');
      if (delayFirst && id === 'store-1') { delayFirst = false; await new Promise(resolve => { releaseFirst = resolve; }); }
      return route.fulfill({ json: { configured: true, restaurantId: '123', localId: id === 'store-1' ? '1' : '2', userId: id, verifiedAt: '2026-10-24T12:00:00Z' } });
    }
    return route.fulfill({ json: { locations: states, schedule: { enabled: false, intervalMinutes: 5 } } });
  });
  await page.goto(base); await config(page);
  await page.getByRole('tab', { name: 'Integraciones' }).click();
  await page.waitForFunction(() => document.querySelector('#toteat-api-form [name=userId]').value === 'store-1');
  await page.locator('#toteat-api-location').selectOption('store-2');
  await page.waitForFunction(() => document.querySelector('#toteat-api-form [name=userId]').value === 'store-2');
  const from = page.locator('#toteat-sales-settings [name=from]');
  await from.fill('2026-09-05');
  const polled = page.waitForResponse(response => response.url().endsWith('/sales/status'));
  await page.clock.fastForward(10000); await polled;
  assert.equal(await from.inputValue(), '2026-09-05');
  await page.locator('#toteat-api-location').selectOption('store-1');
  await page.getByRole('button', { name: 'Continuar editando' }).click();
  assert.equal(await page.locator('#toteat-api-location').inputValue(), 'store-2');
  await page.getByRole('button', { name: 'Guardar configuración de ventas' }).click();
  await page.locator('#settings-sales-status').filter({ hasText: 'Configuración guardada' }).waitFor();
  await page.getByRole('button', { name: 'Guardar configuración de compras' }).click();
  await page.locator('#settings-purchases-status').filter({ hasText: 'Configuración guardada' }).waitFor();
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.path.endsWith('/settings') && write.body.location === 'store-2' && write.body.enabled === false));
  await page.getByRole('button', { name: 'Ir a sincronizar ventas' }).click();
  await page.locator('#upload-source-list [data-location="store-2"][data-source="sales"]').getByRole('button', {name:'Ver detalle de carga'}).click();
  assert.equal(await page.locator('#source-sync-location').inputValue(), 'store-2');
  await page.locator('[data-toteat-sales-sync="selected"]').click();
  await page.locator('#source-sync-status').filter({ hasText: 'Solicitud de ventas enviada' }).waitFor();
  assert.equal(writes.at(-1).body.location, 'store-2');
  await page.locator('#source-sync-location').selectOption('store-1');
  await page.locator('#source-sync-kind').selectOption('purchases');
  await page.locator('[data-toteat-purchases-sync="selected"]').click();
  await page.locator('#source-sync-status').filter({ hasText: 'Solicitud de compras enviada' }).waitFor();
  assert.equal(writes.at(-1).body.location, 'store-1');
  assert.equal(await page.evaluate(() => window.brewitSettings.context.location), 'store-2');
  await page.getByText('Opciones avanzadas de compras', { exact: true }).click();
  await page.locator('[data-toteat-purchases-sync="history"]').click();
  await page.waitForResponse(response => response.url().endsWith('/purchases/status'));
  assert.equal(writes.at(-1).body.full, true);
  await page.locator('#source-sync-close').click();
  await config(page);
  delayFirst = true;
  await page.locator('#toteat-api-location').selectOption('store-1');
  await page.waitForFunction(() => document.getElementById('toteat-api-status').textContent.includes('Consultando'));
  await page.locator('#toteat-api-location').selectOption('store-2');
  await page.waitForFunction(() => document.querySelector('#toteat-api-form [name=userId]').value === 'store-2');
  releaseFirst();
  await page.waitForResponse(response => response.url().includes('/config?location=store-1'));
  assert.equal(await page.locator('#toteat-api-form [name=userId]').inputValue(), 'store-2');
});

test('Configuración: teclado y presentación a 390, 768 y 1440 px con letra al 130 %', { skip: !fs.existsSync(chrome) }, async t => {
  const { page, base } = await setup(t);
  await page.goto(base); await config(page);
  await page.getByRole('tab', { name: 'Locales y bodegas' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Empresa y preferencias' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab', { name: 'Integraciones' }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '1.3'));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#location-settings').screenshot({ path: `/tmp/brewit-settings-${width}.png`, animations: 'disabled' });
    await editFirst(page);
    for (const target of ['#location-editor-view', '#settings-company', '#settings-integrations']) {
      if (target === '#settings-company') await page.getByRole('tab', { name: 'Empresa y preferencias' }).click();
      if (target === '#settings-integrations') await page.getByRole('tab', { name: 'Integraciones' }).click();
      if (width === 1440 || width === 390) await page.locator(target).screenshot({ path: `/tmp/brewit-${target.slice(1)}-${width}.png`, animations: 'disabled' });
      const overflow = await page.locator(target).evaluate(element => [...element.querySelectorAll('input, select, button')].filter(control => {
        const r = control.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1);
      }).map(control => control.outerHTML));
      assert.deepEqual(overflow, [], `${width}px: ${target}`);
    }
    await page.getByRole('tab', { name: 'Locales y bodegas' }).click();
    await page.locator('#location-editor-back').click();
  }
});

test('Configuración carga sin una ruta nueva en un servidor que ya estaba iniciado', { skip: !fs.existsSync(chrome) }, async t => {
  const { page, base } = await setup(t);
  const missingModuleRequests = [];
  await page.route('**/settings-workspace.js', route => {
    missingModuleRequests.push(route.request().url());
    return route.fulfill({ status: 404, contentType: 'text/html', body: 'Cannot GET /settings-workspace.js' });
  });
  await page.goto(base);
  await config(page);
  await page.locator('#active-locations-list .location-summary').first().waitFor();
  assert.equal(await page.locator('#active-locations-list .location-summary').count(), 3);
  await page.getByRole('tab', { name: 'Empresa y preferencias' }).click();
  assert.equal(await page.locator('#company-profile-form').isVisible(), true);
  await page.getByRole('tab', { name: 'Integraciones' }).click();
  await page.locator('#toteat-api-location option').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#toteat-api-location option').count(), 2);
  await page.getByRole('tab', { name: 'Locales y bodegas' }).click();
  await editFirst(page);
  assert.equal(await editor(page).getByRole('button', { name: /Guardar cambios/ }).isVisible(), true);
  assert.deepEqual(missingModuleRequests, [], 'la interfaz debe cargar desde script.js, que el servidor anterior ya sirve');
});
