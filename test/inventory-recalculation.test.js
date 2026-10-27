const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function serverFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-recalculation-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'synchronized', enableToteatSync: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}

test('opening criteria only reads the saved inventory; confirming rebuilds stale stock locally and rejects failed rebuilds', async t => {
  const { app, base } = await serverFixture(t);
  const state = { sourceKind: 'native-documents', range: { from: '2026-10-18', to: '2026-10-25' },
    masterObservedAt: '2026-10-26T00:00:00Z', sourceCapturedAt: '2026-10-26T00:00:00Z',
    warehouses: [{ id: 'oper', custom_id: 2 }], includedOrders: [], issues: [], assumptions: [],
    daily: Array.from({ length: 8 }, (_, i) => ({ warehouse: 'oper', date: `2026-10-${18 + i}`, code: 'LAC001', name: 'Leche', unit: 'L',
      opening: i === 0 ? 100 : 80, closing: 80, physicalCount: i === 0 || i === 7, use: 0 })) };
  let saved = state, stale = true, fail = false, rebuilds = 0;
  app.locals.toteatStockSync.current = () => stale ? { ...saved, stale: true, rebuildError: 'Pendiente de recálculo' } : saved;
  app.locals.toteatStockSync.synchronize = () => { throw Error('No debe descargar datos de Toteat'); };
  app.locals.toteatStockSync.rebuild = () => {
    rebuilds++;
    if (fail) throw Error('No se pudo recalcular; se conserva el inventario anterior.');
    stale = false;
    saved = { ...state, daily: state.daily.map((row, i) => i === 0 ? { ...row, opening: 120 } : row) };
    return saved;
  };
  const calendar = () => fetch(`${base}/api/inventory/calendar?location=store-1&source=originals`).then(response => response.json());
  assert.equal((await calendar()).requiresRebuild, true);
  assert.equal(rebuilds, 0);
  const process = () => fetch(`${base}/api/inventory/process`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'store-1', source: 'originals', criteriaMode: 'count-boundaries', initialInventoryDate: '2026-10-18', finalInventoryDate: '2026-10-25' }) });
  const response = await process();
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.report.items[0].initialInventory, 120);
  assert.equal(rebuilds, 1);
  assert.equal((await calendar()).requiresRebuild, false);
  assert.equal((await process()).status, 200);
  assert.equal(rebuilds, 1, 'a current stock version is reused');
  stale = true;
  fail = true;
  const previous = saved;
  const failed = await process();
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /se conserva el inventario anterior/);
  assert.equal(saved, previous);
  assert.equal((await calendar()).requiresRebuild, true);
});

test('criteria explain local recalculation and offer the action without changing selected dates or downloading sources', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await serverFixture(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 950 } });
  const downloads = [];
  page.on('request', request => { if (/\/api\/integrations\/.*\/sync(?:\?|$)/.test(request.url())) downloads.push(request.url()); });
  let stale = true, requests = 0;
  await page.route('**/api/inventory/calendar?**', route => route.fulfill({ json: {
    from: '2026-10-01', to: '2026-10-27', countDates: ['2026-10-18', '2026-10-25'], requiresRebuild: stale
  } }));
  await page.route('**/api/inventory/process', route => {
    requests++;
    const body = route.request().postDataJSON();
    assert.equal(body.initialInventoryDate, '2026-10-18');
    assert.equal(body.finalInventoryDate, '2026-10-25');
    return requests === 1
      ? route.fulfill({ status: 400, json: { error: 'No se pudo recalcular con los datos guardados. Reintenta.' } })
      : route.fulfill({ json: { report: { itemCount: 1 } } });
  });
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  await page.waitForFunction(() => inventorySourceState !== null);
  await page.evaluate(() => { renderInventoryResults = data => { window.processedInventory = data; }; });
  await page.locator('#process-original-inventory-report').click();
  const dialog = page.locator('#inventory-process-dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /datos ya guardados/);
  assert.doesNotMatch(await dialog.innerText(), /Actualizar inventario/);
  await page.locator('#inventory-initial-date').fill('2026-10-18');
  await page.locator('#inventory-final-date').fill('2026-10-25');
  const confirm = dialog.getByRole('button', { name: 'Recalcular y procesar', exact: true });
  await confirm.click();
  await page.waitForFunction(() => document.getElementById('inventory-process-dialog-status').textContent.includes('Reintenta'));
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await page.locator('#inventory-initial-date').inputValue(), '2026-10-18');
  assert.equal(await page.locator('#inventory-final-date').inputValue(), '2026-10-25');
  await confirm.click();
  await page.waitForFunction(() => window.processedInventory?.report.itemCount === 1);
  assert.equal(await dialog.isVisible(), false);
  assert.equal(requests, 2);
  assert.deepEqual(downloads, []);
  stale = false;
  await page.locator('#process-original-inventory-report').click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Confirmar y procesar', exact: true }).count(), 1);
  assert.equal(await page.locator('#inventory-process-dialog-status').innerText(), '');
});
