const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { splitByStore } = require('../mercadopago-stores');

const header = ['STORE_ID', 'TRANSACTION_DATE', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_AMOUNT'];
const row = (store, id, amount = 1190, date = '2026-08-05') => [store, `${date}T10:00:00-04:00`, id, 'SETTLEMENT', amount];
const rows = [header, row(82010740, 'concepcion'), row('81555097', 'lyon', 2380)];
const locations = [
  { id: 'store-1', name: 'La Concepción', type: 'store', status: 'active', mercadoPagoStoreId: '82010740' },
  { id: 'store-2', name: 'Portal Lyon', type: 'store', status: 'active', mercadoPagoStoreId: '81555097' }
];

async function startServer(t, existingLocations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-mp-stores-'));
  if (existingLocations) {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'locations.json'), JSON.stringify({ locations: existingLocations }));
  }
  const app = createApp({ uploadsRoot: root, enableToteatSync: false });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

function inspect(base, data = rows, location = '', excel = false) {
  const form = new FormData();
  let contents = data.map(row => row.join('\t')).join('\n');
  if (excel) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), 'MercadoPago');
    contents = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }
  form.append('mercadopago', new Blob([contents]), excel ? 'todos.xlsx' : 'todos.csv');
  return fetch(`${base}/api/uploads/transactions/inspect${location ? `?location=${location}` : ''}`, { method: 'POST', body: form });
}

function confirm(base, manifest, overlapAction = 'keep', excludedAcknowledged = true) {
  return fetch(`${base}/api/uploads/transactions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: manifest.token, dateFrom: manifest.detectedRange.from, dateTo: manifest.detectedRange.to, confirmed: true, overlapAction, excludedAcknowledged }) });
}

test('STORE_ID splits identifiers across sheets and counts unmatched or missing codes separately', () => {
  const result = splitByStore([{ name: 'Uno', rows }, { name: 'Dos', rows: [header, row("'82010740", 'otro')] }], locations);
  assert.deepEqual(result.groups.map(group => [group.location.id, group.rowCount]), [['store-1', 2], ['store-2', 1]]);
  const unmatched = splitByStore([{ name: 'MP', rows: [header, row('unknown', 'bad'), row('', 'missing')] }], locations);
  assert.equal(unmatched.groups.length, 0);
  assert.equal(unmatched.summary.associatedCount, 0);
  assert.equal(unmatched.summary.unassociatedCount, 2);
  assert.deepEqual(unmatched.summary.unassociated, [{ storeId: 'unknown', rowCount: 1 }, { storeId: '', rowCount: 1 }]);
  assert.throws(() => splitByStore([{ name: 'MP', rows: [['Fecha'], ['2026-08-05']] }], locations), /no contiene la columna STORE_ID/);
  assert.throws(() => splitByStore([{ name: 'MP', rows }], locations.map(location => ({ ...location, mercadoPagoStoreId: '82010740' }))), /más de una cafetería/);
});

test('STORE_ID defaults migrate existing locations and edits persist without changing TotEat configuration', async t => {
  const existing = locations.map(({ mercadoPagoStoreId, ...location }) => ({ ...location, toteatRestaurantId: 'restaurant', toteatLocalId: location.id }));
  const { base, root } = await startServer(t, existing);
  const config = await fetch(`${base}/api/config/locations`).then(response => response.json());
  assert.deepEqual(config.active.map(location => location.mercadoPagoStoreId), ['82010740', '81555097']);
  const save = (location, storeId) => fetch(`${base}/api/config/locations/${location}/mercadopago`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId }) });
  assert.equal((await save('store-2', '82010740')).status, 400);
  assert.equal((await save('store-2', 'ABC')).status, 400);
  const saved = await save('store-2', '12345678').then(response => response.json());
  assert.equal(saved.mercadoPagoStoreId, '12345678');
  assert.equal(saved.toteatRestaurantId, 'restaurant');
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'config', 'locations.json')));
  assert.equal(registry.locations[1].mercadoPagoStoreId, '12345678');
  const general = await fetch(`${base}/api/config/locations/store-2`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Portal Lyon', mercadoPagoStoreId: '82010740' }) });
  assert.equal(general.status, 400);
  const newStore = await fetch(`${base}/api/config/locations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nuevo local', type: 'store', mercadoPagoStoreId: '12345678' }) });
  assert.equal(newStore.status, 400);
});

test('a single MercadoPago export assigns each row, deduplicates per location and replaces only the affected store', async t => {
  const { base } = await startServer(t);
  const inspected = await inspect(base, rows, '', true);
  assert.equal(inspected.status, 200);
  const manifest = await inspected.json();
  assert.equal(manifest.location, 'all');
  assert.deepEqual(manifest.assignments.map(item => [item.location, item.storeId, item.rowCount]), [['store-1', '82010740', 1], ['store-2', '81555097', 1]]);
  const first = await confirm(base, manifest);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).imports.mercadopago.newTransactions, 2);
  const files = async location => (await fetch(`${base}/api/transactions?location=${location}`).then(response => response.json())).files.mercadopago;
  for (const [location, code, transaction] of [['store-1', '82010740', 'concepcion'], ['store-2', '81555097', 'lyon']]) {
    const stored = await files(location);
    assert.equal(stored.latest.storeId, code);
    assert.equal(stored.latest.transactionCount, 1);
    const workbook = XLSX.read(await fetch(base + stored.latest.url).then(response => response.arrayBuffer()));
    const storedRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    assert.deepEqual(storedRows.map(item => String(item.STORE_ID)), [code]);
    assert.deepEqual(storedRows.map(item => item.SOURCE_ID), [transaction]);
  }
  // Even an upload initiated for one local follows STORE_ID for both cafeterias.
  const again = await inspect(base, rows, 'store-2').then(response => response.json());
  assert.equal(again.hasOverlap, true);
  const repeated = await confirm(base, again).then(response => response.json());
  assert.equal(repeated.imports.mercadopago.newTransactions, 0);
  assert.equal(repeated.imports.mercadopago.duplicateTransactions, 2);
  assert.equal((await files('store-1')).fileCount, 1);
  assert.equal((await files('store-2')).fileCount, 1);
  const replacement = await inspect(base, [header, row(82010740, 'corrected', 3570)]).then(response => response.json());
  assert.equal((await confirm(base, replacement, 'replace')).status, 200);
  assert.equal((await files('store-1')).fileCount, 2);
  assert.equal((await files('store-2')).fileCount, 1);
  assert.equal((await files('store-2')).latest.replacementEffects.length, 0);
  assert.equal((await files('store-1')).latest.replacementEffects.length, 1);
});

test('missing STORE_ID column and changed configuration stop shared imports without saving records', async t => {
  const { base } = await startServer(t);
  const localUpload = new FormData();
  localUpload.append('marketing', new Blob(['Fecha\n2026-08-05']), 'marketing.csv');
  assert.equal((await fetch(`${base}/api/uploads/transactions/inspect`, { method: 'POST', body: localUpload })).status, 400);
  for (const data of [[header.slice(1), rows[1].slice(1)]]) {
    const response = await inspect(base, data);
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /STORE_ID/);
  }
  const manifest = await inspect(base).then(response => response.json());
  await fetch(`${base}/api/config/locations/store-2/mercadopago`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: '12345678' }) });
  assert.equal((await confirm(base, manifest)).status, 409);
  for (const location of ['store-1', 'store-2']) {
    const files = await fetch(`${base}/api/transactions?location=${location}`).then(response => response.json());
    assert.equal(files.files.mercadopago.fileCount, 0);
  }
});

test('mixed files summarize every row and omit unassociated rows only after explicit confirmation', async t => {
  const { base } = await startServer(t);
  const data = [...rows, row(81318717, 'test-1', 250), row(81318717, 'test-2', 200), row('', 'missing')];
  const response = await inspect(base, data);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.deepEqual(manifest.mercadoPagoSummary, {
    originalName: 'todos.csv', totalRows: 5, associatedCount: 2, unassociatedCount: 3,
    stores: [{ location: 'store-1', name: 'Tienda 1', storeId: '82010740', rowCount: 1 }, { location: 'store-2', name: 'Tienda 2', storeId: '81555097', rowCount: 1 }],
    unassociated: [{ storeId: '81318717', rowCount: 2 }, { storeId: '', rowCount: 1 }]
  });
  assert.equal((await confirm(base, manifest, 'keep', false)).status, 400);
  for (const location of ['store-1', 'store-2']) {
    const before = await fetch(`${base}/api/transactions?location=${location}`).then(response => response.json());
    assert.equal(before.files.mercadopago.fileCount, 0);
  }
  const saved = await confirm(base, manifest).then(response => response.json());
  assert.equal(saved.skippedCount, 3);
  assert.equal(saved.imports.mercadopago.newTransactions, 2);
  for (const location of ['store-1', 'store-2']) {
    const after = await fetch(`${base}/api/transactions?location=${location}`).then(response => response.json());
    const workbook = XLSX.read(await fetch(base + after.files.mercadopago.latest.url).then(response => response.arrayBuffer()));
    const records = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    assert.equal(records.length, 1);
    assert.ok(records.every(record => ['82010740', '81555097'].includes(record.STORE_ID)));
  }
});

test('a failure preparing the second store leaves neither store with a partial import', async t => {
  const { base, root } = await startServer(t);
  const manifest = await inspect(base).then(response => response.json());
  fs.rmSync(path.join(root, '.staging', manifest.token, manifest.files[1].filename));
  assert.equal((await confirm(base, manifest)).status, 500);
  for (const location of ['store-1', 'store-2']) {
    const files = await fetch(`${base}/api/transactions?location=${location}`).then(response => response.json());
    assert.equal(files.files.mercadopago.fileCount, 0);
    assert.equal(fs.readdirSync(path.join(root, 'transactions', location)).filter(name => name.endsWith('.xlsx')).length, 0);
  }
});

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('shared MercadoPago upload needs no selected location or date checkbox and offers keep or replace for overlaps', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await startServer(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  page.on('request', request => {
    if (request.url().includes('/api/uploads/transactions/inspect')) requests.push(new URL(request.url()));
  });
  await page.goto(base);
  await page.getByRole('link', { name: 'Datos y sincronización', exact: true }).click();
  await page.locator('[data-upload-field="marketing"]').first().waitFor();
  await page.locator('#location-select').evaluate(select => select.replaceChildren());
  for (const [index, action] of ['keep', 'keep', 'replace'].entries()) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Cargar archivo único de MercadoPago' }).click();
    const data = [...(index === 2 ? [header, row(82010740, 'concepcion', 3570), row(81555097, 'lyon', 4760)] : rows), row(81318717, 'test-1', 250), row(81318717, 'test-2', 200), row('', 'missing')];
    await (await chooser).setFiles({ name: 'mercadopago.csv', mimeType: 'text/csv', buffer: Buffer.from(data.map(row => row.join('\t')).join('\n')) });
    const dialog = page.locator('#date-confirmation');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(requests.at(-1).search, '');
    assert.equal(await dialog.locator('#date-confirmation-row').isVisible(), false);
    assert.equal(await dialog.locator('.confirmation-dates').isVisible(), false);
    assert.equal(await dialog.locator('#dates-confirmed').isChecked(), false);
    assert.match(await dialog.innerText(), /STORE_ID 82010740/);
    assert.match(await dialog.innerText(), /STORE_ID 81555097/);
    const summary = dialog.locator('#mercadopago-upload-summary');
    assert.deepEqual(await summary.locator('tbody td').allTextContents(), ['Tienda 1', '82010740', '1', 'Tienda 2', '81555097', '1', 'Sin asociación', '81318717', '2', 'Sin asociación', 'Sin STORE_ID', '1']);
    assert.match(await summary.innerText(), /3 registro\(s\) sin cafetería asociada no serán procesados/);
    assert.equal(await dialog.locator('#replace-transactions-btn').isVisible(), index > 0);
    if (index > 0) assert.equal(await dialog.locator('#keep-transactions-btn').innerText(), 'Mantener existentes y agregar nuevos');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/uploads/transactions/confirm'));
    await dialog.locator(action === 'replace' ? '#replace-transactions-btn' : '#keep-transactions-btn').click();
    const response = await saved;
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.imports.mercadopago.newTransactions, index === 1 ? 0 : 2);
    assert.equal(result.skippedCount, 3);
    assert.equal(response.request().postDataJSON().excludedAcknowledged, true);
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => transactionUploadContext === null);
  }
  assert.equal(requests.length, 3);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Cargar archivo único de MercadoPago' }).click();
  await (await chooser).setFiles({ name: 'solo-pruebas.csv', mimeType: 'text/csv', buffer: Buffer.from([header, row(81318717, 'only-test')].map(row => row.join('\t')).join('\n')) });
  const dialog = page.locator('#date-confirmation');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#keep-transactions-btn').isDisabled(), true);
  assert.equal(await dialog.locator('#replace-transactions-btn').isDisabled(), true);
  assert.match(await dialog.innerText(), /No hay registros asociados a nuestras cafeterías para cargar/);
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
});

test('configuration shows and saves the MercadoPago STORE_ID for each selected cafeteria', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await startServer(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.locator('[data-view="config"]').click();
  const input = page.locator('#mercadopago-store-form input');
  await page.waitForFunction(() => document.querySelector('#mercadopago-store-form input').value === '82010740');
  await page.locator('#toteat-api-location').selectOption('store-2');
  assert.equal(await input.inputValue(), '81555097');
  await input.fill('87654321');
  await page.getByRole('button', { name: 'Guardar STORE_ID de MercadoPago' }).click();
  await page.locator('#mercadopago-store-status').filter({ hasText: 'guardado' }).waitFor();
  await page.reload();
  await page.locator('[data-view="config"]').click();
  await page.locator('#toteat-api-location option[value="store-2"]').waitFor({ state: 'attached' });
  await page.locator('#toteat-api-location').selectOption('store-2');
  assert.equal(await input.inputValue(), '87654321');
});
