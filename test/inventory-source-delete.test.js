const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fields = ['marketing', 'employees', 'calibrations'];

async function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-consumption-delete-'));
  for (const location of ['store-1', 'store-2']) {
    for (const week of ['2026-08-03', '2026-08-10']) {
      const dir = path.join(root, 'weeks', week, location);
      fs.mkdirSync(dir, { recursive: true });
      const files = {};
      for (const field of fields) {
        const name = `${field}.csv`;
        fs.writeFileSync(path.join(dir, name), `Fecha\n${week}`);
        files[field] = { name, originalName: name, savedAt: `${week}T12:00:00Z`, confirmedRange: { from: week, to: week } };
      }
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ files }));
    }
    const dir = path.join(root, 'transactions', location);
    fs.mkdirSync(dir, { recursive: true });
    const index = { location, fields: {}, exclusions: {} };
    for (const field of [...fields, 'mercadopago']) {
      index.fields[field] = { files: [1, 2].map(number => {
        const name = `${field}-${number}.csv`;
        fs.writeFileSync(path.join(dir, name), 'Fecha\n2026-08-17');
        return { id: `${field}-${number}`, name, originalName: name, savedAt: `2026-08-17T12:00:0${number}Z`, confirmedRange: { from: '2026-08-17', to: '2026-08-17' } };
      }) };
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  }
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return { root, base: `http://127.0.0.1:${server.address().port}` };
}

test('deleting a consumption concept requires confirmation and removes all uploads only for that location and concept', async t => {
  const { base, root } = await startServer(t);
  for (const field of fields) {
    const url = `${base}/api/transactions/store-1/${field}/remove`;
    const remove = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const body of [
      { action: 'all' },
      { action: 'all', confirmed: false, confirmationText: 'ELIMINAR' },
      { action: 'all', confirmed: true, confirmationText: 'NO' }
    ]) assert.equal((await remove(body)).status, 400);
    const before = await fetch(`${base}/api/transactions?location=store-1`).then(response => response.json());
    assert.equal(before.files[field].fileCount, 4);
    const response = await remove({ action: 'all', confirmed: true, confirmationText: 'ELIMINAR' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, action: 'all', deletedCount: 4, remainingCount: 0 });
    const after = await fetch(`${base}/api/transactions?location=store-1`).then(response => response.json());
    assert.equal(after.files[field].fileCount, 0);
    assert.equal(after.files.mercadopago.fileCount, 2);
    for (const other of fields.slice(fields.indexOf(field) + 1)) assert.equal(after.files[other].fileCount, 4);
    const otherLocation = await fetch(`${base}/api/transactions?location=store-2`).then(response => response.json());
    assert.equal(otherLocation.files[field].fileCount, 4);
    const sources = await fetch(`${base}/api/inventory/sources?location=store-1`).then(response => response.json());
    assert.equal(sources.sources.find(source => source.field === field).available, false);
    assert.equal((await fetch(`${base}/api/inventory/consumption-summary?location=store-1&field=${field}`)).status, 404);
    assert.equal(fs.existsSync(path.join(root, 'transactions', 'store-1', `${field}-1.csv`)), false);
    assert.equal(fs.existsSync(path.join(root, 'transactions', 'store-1', `${field}-2.csv`)), false);
    for (const week of ['2026-08-03', '2026-08-10']) assert.equal(fs.existsSync(path.join(root, 'weeks', week, 'store-1', `${field}.csv`)), false);
  }
});

test('inventory buttons warn, cancel, handle errors and delete the selected concept for the inventory location', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await startServer(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  const list = page.locator('#inventory-source-list');
  await list.getByRole('button', { name: /Eliminar todos los datos de/ }).first().waitFor();
  assert.equal(await list.getByRole('button', { name: /Eliminar todos los datos de/ }).count(), 3);
  await page.locator('#inventory-location-select').selectOption('store-2');
  await page.waitForFunction(() => inventorySourceState?.location.id === 'store-2');
  const locationName = await page.locator('#inventory-location-select option:checked').innerText();
  assert.equal(await page.locator('#location-select').inputValue(), 'store-1');
  const labels = ['Consumo de marketing', 'Consumo de colaboradores', 'Calibraciones y bebidas desechadas'];
  const dialog = page.locator('#transaction-delete-dialog');
  for (const [index, label] of labels.entries()) {
    const trigger = list.getByRole('button', { name: `Eliminar todos los datos de ${label}`, exact: true });
    await trigger.click();
    await dialog.waitFor({ state: 'visible' });
    assert.match(await dialog.innerText(), /Se eliminarán TODOS los datos/);
    assert.ok((await dialog.innerText()).includes(`para ${locationName},`));
    assert.match(await dialog.innerText(), /incluidos todos los archivos cargados y su historial/);
    assert.match(await dialog.innerText(), /no se puede deshacer/);
    assert.equal(await dialog.locator('.transaction-delete-options').isVisible(), false);
    assert.equal(await dialog.getByRole('button', { name: 'Eliminar todos los datos', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(await trigger.isVisible(), true);
    await trigger.click();
    await dialog.locator('#transaction-delete-confirmation').fill('NO');
    assert.equal(await dialog.locator('#confirm-transaction-delete').isDisabled(), true);
    await dialog.locator('#transaction-delete-confirmation').fill('ELIMINAR');
    if (index === 0) {
      await page.route('**/api/transactions/store-2/marketing/remove', route => route.fulfill({ status: 500, json: { error: 'Error de prueba al eliminar.' } }), { times: 1 });
      await dialog.locator('#confirm-transaction-delete').click();
      await dialog.getByText('Error de prueba al eliminar.', { exact: true }).waitFor();
      assert.equal(await dialog.locator('#confirm-transaction-delete').isEnabled(), true);
    }
    const deleted = page.waitForResponse(response => response.url().endsWith(`/api/transactions/store-2/${fields[index]}/remove`) && response.ok());
    await dialog.locator('#confirm-transaction-delete').click();
    assert.deepEqual((await deleted).request().postDataJSON(), { action: 'all', confirmed: true, confirmationText: 'ELIMINAR' });
    await trigger.waitFor({ state: 'detached' });
    await page.getByText(`Se eliminó toda la información de ${label}.`, { exact: true }).waitFor();
    const card = list.locator('article').filter({ has: page.getByText(label, { exact: true }) });
    assert.match(await card.innerText(), /Falta cargar/);
    assert.equal(await card.getByRole('link', { name: 'Descargar' }).count(), 0);
    const untouched = await fetch(`${base}/api/transactions?location=store-1`).then(response => response.json());
    assert.equal(untouched.files[fields[index]].fileCount, 4);
  }
  await page.locator('#inventory-location-select').selectOption('store-1');
  await list.getByRole('button', { name: /Eliminar todos los datos de/ }).first().waitFor();
  for (const width of [1440, 720, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await list.locator('.inventory-source-actions').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth + 1));
    assert.equal(overflow, false, `actions fit at ${width}px`);
  }
  // The shared dialog must restore its original choices when opened from uploads.
  await page.evaluate(async () => {
    const data = await apiRequest('/api/transactions?location=store-1');
    openTransactionDeleteDialog('marketing', data.files.marketing);
  });
  assert.equal(await dialog.locator('.transaction-delete-options').isVisible(), true);
  assert.equal(await dialog.locator('input[value="last"]').isChecked(), true);
  assert.equal(await dialog.locator('#transaction-delete-confirmation').inputValue(), '');
  assert.equal(await dialog.locator('#confirm-transaction-delete').isDisabled(), true);
});
