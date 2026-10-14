const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { chromium } = require('playwright-core');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-copy-policies-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'synchronized', enableToteatSync: false });
  const locationsFile = path.join(root, 'config', 'locations.json');
  const locations = JSON.parse(fs.readFileSync(locationsFile, 'utf8'));
  locations.locations.find(l => l.id === 'store-1').name = 'La Concepción';
  locations.locations.find(l => l.id === 'store-2').name = 'Portal Lyon';
  fs.writeFileSync(locationsFile, JSON.stringify(locations));
  const file = path.join(root, 'config', 'purchase-projection-policies.json');
  const initial = { locations: {
    'store-1': { items: {
      A: { supplierKey: 'supplier-a', unitsPerPackage: 12, minDays: 3, maxDays: 10, managed: false },
      B: { supplierKey: 'supplier-b', unitsPerPackage: 6, minDays: 5, maxDays: 15, managed: true }
    } },
    'store-2': { items: {
      A: { supplierKey: 'old', unitsPerPackage: 2, minDays: 1, maxDays: 2, managed: true },
      OLD: { supplierKey: 'old', unitsPerPackage: 9, minDays: 20, maxDays: 30, managed: true },
      UNUSED: { supplierKey: 'old', unitsPerPackage: 9, minDays: 20, maxDays: 30, managed: false }
    } },
    'main-warehouse': { items: { CENTRAL: { minDays: 1, maxDays: 2 } } }
  } };
  fs.writeFileSync(file, JSON.stringify(initial));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const copy = body => fetch(base + '/api/purchase-projections/policies/copy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { root, file, initial, base, read, copy };
}

test('copies saved criteria by code without inventory, replacing destination criteria and administration flags', async t => {
  const { base, read, initial, copy } = await setup(t);
  const sources = await fetch(base + '/api/purchase-projections/policies/sources?location=store-2').then(r => r.json());
  assert.deepEqual(sources.sources.map(s => [s.id, s.itemCount]), [['store-1', 2]]);
  const response = await copy({ location: 'store-2', sourceLocation: 'store-1', confirmed: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.copied, 2);
  assert.equal(result.location.id, 'store-2');
  const registry = read();
  assert.deepEqual(registry.locations['store-1'], initial.locations['store-1']);
  assert.deepEqual(registry.locations['main-warehouse'], initial.locations['main-warehouse']);
  const items = registry.locations['store-2'].items;
  const { updatedAt, ...a } = items.A;
  assert.ok(Number.isFinite(Date.parse(updatedAt)));
  assert.deepEqual(a, { supplierKey: 'supplier-a', unitsPerPackage: 12, minDays: 3, maxDays: 10, managed: false });
  assert.equal(items.B.managed, true);
  assert.equal(items.OLD, undefined);
  assert.equal(items.UNUSED, undefined);
  // The copied criteria can seed another opening, including administration flags.
  const again = await copy({ location: 'store-1', sourceLocation: 'store-2', confirmed: true });
  assert.equal(again.status, 200);
  assert.equal(read().locations['store-1'].items.A.managed, false);
  assert.equal(read().locations['store-1'].items.B.managed, true);
});

test('rejects unconfirmed replacement, invalid origins, empty or invalid source criteria without changing saved data', async t => {
  const { root, file, base, read, initial, copy } = await setup(t);
  for (const body of [
    { location: 'store-2', sourceLocation: 'store-1' },
    { location: 'store-2', sourceLocation: 'store-1', confirmed: false },
    { location: 'store-2', sourceLocation: 'store-2', confirmed: true },
    { location: 'store-2', sourceLocation: 'main-warehouse', confirmed: true },
    { location: 'missing', sourceLocation: 'store-1', confirmed: true }
  ]) {
    assert.equal((await copy(body)).status, 400);
    assert.deepEqual(read(), initial);
  }
  const empty = structuredClone(initial);
  empty.locations['store-1'].items = {};
  fs.writeFileSync(file, JSON.stringify(empty));
  assert.equal((await copy({ location: 'store-2', sourceLocation: 'store-1', confirmed: true })).status, 400);
  assert.deepEqual(read(), empty);
  const invalid = structuredClone(initial);
  invalid.locations['store-1'].items.B.maxDays = 1;
  fs.writeFileSync(file, JSON.stringify(invalid));
  assert.equal((await copy({ location: 'store-2', sourceLocation: 'store-1', confirmed: true })).status, 400);
  assert.deepEqual(read(), invalid);
  const locationsFile = path.join(root, 'config', 'locations.json');
  const locations = JSON.parse(fs.readFileSync(locationsFile, 'utf8'));
  locations.locations.find(l => l.id === 'store-1').status = 'archived';
  fs.writeFileSync(locationsFile, JSON.stringify(locations));
  assert.equal((await copy({ location: 'store-2', sourceLocation: 'store-1', confirmed: true })).status, 400);
  const sources = await fetch(base + '/api/purchase-projections/policies/sources?location=store-2').then(r => r.json());
  assert.deepEqual(sources.sources, []);
});

test('UI requires an origin and confirmation, leaves data intact on cancellation, and copies to a location without inventory', { skip: !fs.existsSync(chrome) }, async t => {
  const { base, read, initial } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.locator('[data-view="purchase-projection"]').click();
  await page.locator('#projection-location-filter').selectOption('store-2');
  await page.waitForFunction(() => !document.getElementById('refresh-purchase-projection').disabled);
  const open = page.locator('#open-copy-projection-policies');
  const dialog = page.locator('#copy-projection-policies-dialog');
  const source = page.locator('#copy-projection-policies-source');
  const replace = page.locator('#confirm-copy-projection-policies');
  await open.click();
  await page.waitForFunction(() => !document.getElementById('copy-projection-policies-source').disabled);
  assert.equal(await replace.isDisabled(), true);
  assert.match(await dialog.innerText(), /reemplazarán los proveedores/);
  assert.match(await dialog.innerText(), /campo Administrar/);
  assert.match(await dialog.innerText(), /Portal Lyon/);
  assert.deepEqual(await source.locator('option').evaluateAll(options => options.map(o => o.value)), ['', 'store-1']);
  await source.selectOption('store-1');
  await page.locator('#cancel-copy-projection-policies').click();
  assert.deepEqual(read(), initial);
  await open.click();
  await page.waitForFunction(() => !document.getElementById('copy-projection-policies-source').disabled);
  await source.selectOption('store-1');
  let confirmation;
  page.once('dialog', async d => { confirmation = d.message(); await d.dismiss(); });
  await replace.click();
  assert.match(confirmation, /La Concepci[oó]n/);
  assert.match(confirmation, /Portal Lyon/);
  assert.match(confirmation, /reemplazarán.*proveedores/);
  assert.match(confirmation, /campo Administrar/);
  assert.match(confirmation, /cambios sin guardar/);
  assert.deepEqual(read(), initial);
  assert.equal(await dialog.isVisible(), true);
  page.once('dialog', d => d.accept());
  await replace.click();
  await page.waitForFunction(() => document.getElementById('purchase-projection-status').textContent.includes('2 criterios cargados'));
  assert.equal(await dialog.isVisible(), false);
  assert.equal(read().locations['store-2'].items.A.unitsPerPackage, 12);
  assert.deepEqual(read().locations['store-1'], initial.locations['store-1']);

  // Once stock is available, a confirmed copy also refreshes the displayed fields
  // and discards the draft criteria warned about in the confirmation.
  await page.route('**/api/purchase-projections?*', route => {
    const policy = read().locations['store-2'].items.A;
    return route.fulfill({ json: {
      location: { id: 'store-2', name: 'Portal Lyon' },
      period: { from: '2026-09-15', to: '2026-10-14', dataThrough: '2026-10-14' },
      consumptionCriteria: 'Consumo de ventas', warnings: [],
      suppliers: [{ key: 'supplier-a', name: 'Proveedor A' }, { key: 'unassigned', name: 'Sin proveedor' }],
      purchaseOrders: { selectedOrderCount: 0 }, summary: { itemCount: 1 },
      items: [{ key: 'A', code: 'A', name: 'Producto A', ...policy,
        supplier: 'Proveedor A', internalUnit: 'UN', purchaseUnit: 'UN', needsPurchase: true,
        consumption30: 30, averageDailyConsumption: 1, currentInventory: 0, currentCoverageDays: 0,
        suggestedInternalQuantity: 10, conversionAvailable: true, unitsPerPurchaseUnit: 1,
        suggestedPurchaseUnits: 12, estimatedPurchaseUnitCost: 100, estimatedTotal: 1200 }]
    } });
  });
  await page.locator('#refresh-purchase-projection').click();
  await page.locator('#projection-only-required').uncheck();
  const row = page.locator('#purchase-projection-body tr[data-key="A"]');
  await row.locator('.projection-min-input').fill('99');
  await row.locator('.projection-managed-input').check();
  await open.click();
  await page.waitForFunction(() => !document.getElementById('copy-projection-policies-source').disabled);
  await source.selectOption('store-1');
  page.once('dialog', d => d.accept());
  await replace.click();
  await page.waitForFunction(() => !document.getElementById('copy-projection-policies-dialog').open
    && document.querySelector('#purchase-projection-body tr[data-key="A"] .projection-min-input')?.value === '3');
  assert.equal(await row.locator('.projection-max-input').inputValue(), '10');
  assert.equal(await row.locator('.projection-package-input').inputValue(), '12');
  assert.equal(await row.locator('.projection-supplier-input').inputValue(), 'supplier-a');
  assert.equal(await row.locator('.projection-managed-input').isChecked(), false);
  assert.deepEqual(errors, []);
});
