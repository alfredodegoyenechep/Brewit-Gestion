const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const { createMercadoPagoSync, santiagoClock } = require('../mercadopago-sync');
const { createMercadoPagoBrowser, reportPeriod } = require('../mercadopago-web');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const header = ['STORE_ID', 'SOURCE_ID', 'TRANSACTION_TYPE', 'TRANSACTION_DATE', 'TRANSACTION_AMOUNT'];
const row = (store, id, day, type = 'SETTLEMENT') => [store, id, type, `2026-10-${day}T10:00:00-03:00`, 1190];
const csv = rows => [header, ...rows].map(row => row.join(';')).join('\n');
const period = { from: '2026-10-12', to: '2026-10-15' };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-mp-sync-'));
  t.after(async () => {await require('../historical-control').get(root).idle();fs.rmSync(root, { recursive: true, force: true });});
  return root;
}
async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const jsonPost = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function seed(base, contents) {
  const form = new FormData(); form.append('mercadopago', new Blob([contents]), 'manual.csv');
  const manifest = await fetch(base + '/api/uploads/transactions/inspect', { method: 'POST', body: form }).then(r => r.json());
  const response = await fetch(base + '/api/uploads/transactions/confirm', jsonPost({ token: manifest.token, dateFrom: manifest.detectedRange.from, dateTo: manifest.detectedRange.to, confirmed: true }));
  assert.equal(response.status, 200);
}

test('period parsing uses the period cell, accepts Chilean month names and rejects impossible dates', () => {
  assert.deepEqual(reportPeriod('13/oct/2026 a\n13/oct/2026'), { from: '2026-10-13', to: '2026-10-13' });
  assert.deepEqual(reportPeriod('1/ago/2026 a 4/oct/2026'), { from: '2026-08-01', to: '2026-10-04' });
  assert.equal(reportPeriod('31/feb/2026 a 2/mar/2026'), null);
  assert.equal(reportPeriod('14/oct/2026'), null);
});

test('web updates include each store last day and deduplicate manual records, reordered columns and overlapping reports', async t => {
  const root = temporary(t), calls = [];
  const browser = { async download(request) {
    calls.push(request);
    const files = [csv([row('82010740', 'old', '11'), row('82010740', 'existing', '13'), row('82010740', 'late', '13'), row('81555097', 'lyon-late', '12'), row('81555097', 'lyon-new', '14'), row('99999', 'unknown', '14')]),
      csv([row('82010740', 'late', '13'), row('82010740', 'refund', '14', 'REFUND')])];
    // Different column order/extra optional column must not turn the same movement into a new record.
    files[1] = files[1].split('\n').map((line, i) => line.split(';').reverse().concat(i ? '0' : 'FEE_AMOUNT').join(';')).join('\n');
    return files.map((contents, index) => { const file = path.join(request.directory, `${index}.csv`); fs.writeFileSync(file, contents); return { path: file, period }; });
  } };
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, mercadoPagoBrowser: browser, mercadoPagoClock: () => new Date('2026-10-16T12:00:00Z') });
  t.after(() => app.locals.mercadoPagoSync.close());
  const base = await serve(t, app);
  await seed(base, csv([row('82010740', 'existing', '13'), row('81555097', 'lyon-existing', '12')]));
  await app.locals.mercadoPagoSync.synchronize();
  const state = app.locals.mercadoPagoSync.status();
  assert.equal(state.status, 'complete', state.message);
  assert.equal(calls[0].from, '2026-10-12');
  assert.equal(calls[0].to, '2026-10-16');
  assert.equal(state.result.newTransactions, 4);
  assert.equal(state.result.duplicateTransactions, 2);
  assert.equal(state.result.skippedCount, 1);
  for (const location of ['store-1', 'store-2']) {
    const files = await fetch(base + '/api/transactions?location=' + location).then(r => r.json());
    assert.equal(files.files.mercadopago.fileCount, 2);
    assert.equal(files.files.mercadopago.latest.overlapAction, 'keep');
    assert.deepEqual(files.files.mercadopago.latest.replacementEffects, []);
  }
  await app.locals.mercadoPagoSync.synchronize();
  assert.equal(app.locals.mercadoPagoSync.status().result.newTransactions, 0);
  assert.equal(calls[1].from, '2026-10-14');
  assert.equal(fs.readdirSync(path.join(root, '.integrations/mercadopago')).some(name => name.startsWith('download-')), false);
});

test('invalid later report leaves all stores unchanged and does not publish the earlier valid download', async t => {
  const root = temporary(t);
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, mercadoPagoClock: () => new Date('2026-10-16T12:00:00Z'), mercadoPagoBrowser: {
    async download({ directory }) {
      return [csv([row('82010740', 'new', '14')]), '<html>Login</html>'].map((content, index) => {
        const file = path.join(directory, index + '.csv'); fs.writeFileSync(file, content); return { path: file, period };
      });
    }
  } });
  const base = await serve(t, app);
  t.after(() => app.locals.mercadoPagoSync.close());
  await app.locals.mercadoPagoSync.synchronize();
  assert.equal(app.locals.mercadoPagoSync.status().status, 'error');
  for (const location of ['store-1', 'store-2']) {
    const files = await fetch(base + '/api/transactions?location=' + location).then(r => r.json());
    assert.equal(files.files.mercadopago.fileCount, 0);
  }
});

test('changed amount with the same MercadoPago identity is reported as a correction and preserves the prior published record', async t => {
  const root = temporary(t);
  const browser = { async download({ directory }) {
    const file = path.join(directory, 'corrected.csv');
    fs.writeFileSync(file, csv([[ '82010740', 'same', 'SETTLEMENT', '2026-10-13T10:00:00-03:00', 900 ]]));
    return [{ path: file, period }];
  } };
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, mercadoPagoBrowser: browser,
    mercadoPagoClock: () => new Date('2026-10-16T12:00:00Z') });
  t.after(() => app.locals.mercadoPagoSync.close());
  const base = await serve(t, app);
  await seed(base, csv([[ '82010740', 'same', 'SETTLEMENT', '2026-10-13T10:00:00-03:00', 1000 ]]));
  await app.locals.mercadoPagoSync.synchronize();
  const state = app.locals.mercadoPagoSync.status();
  assert.equal(state.result.conflictingTransactions, 1);
  assert.equal(state.result.duplicateTransactions, 0);
  assert.match(state.result.conflictEvidenceId, /^[0-9a-f-]{36}$/);
  assert.match(state.message, /correcciones pendientes/);
  const evidenceDirectory = path.join(root, '.integrations', 'mercadopago', 'conflicts', state.result.conflictEvidenceId);
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.conflictingTransactions, 1);
  assert.equal(manifest.downloadedReports.length, 1);
  assert.match(fs.readFileSync(path.join(evidenceDirectory, manifest.downloadedReports[0].filename), 'utf8'), /900/);
  const files = await fetch(base + '/api/transactions?location=store-1').then(response => response.json());
  assert.equal(files.files.mercadopago.fileCount, 1);
});

test('schedule is opt-in, persists, runs once at 08:00 Santiago, and recovers missed starts', async t => {
  const root = temporary(t), attempts = [];
  let now = new Date('2026-10-16T10:59:00Z');
  const options = { uploadsRoot: root, enableScheduler: false, clock: () => now, checkpoints: () => [{ storeId: '1', from: '2026-10-13' }], importReports: () => assert.fail('No reports to import'), browser: { async download(request) { attempts.push(request); return []; } } };
  let sync = createMercadoPagoSync(options);
  assert.deepEqual(santiagoClock(now), { today: '2026-10-16', hour: 7 });
  await sync.tick(); assert.equal(attempts.length, 0);
  sync.configure(true); await sync.tick(); assert.equal(attempts.length, 0);
  now = new Date('2026-10-16T11:00:00Z');
  await sync.tick(); await sync.tick(); assert.equal(attempts.length, 1);
  assert.equal(attempts[0].interactive, false);
  await sync.close(); sync = createMercadoPagoSync(options);
  await sync.tick(); assert.equal(attempts.length, 1); assert.equal(sync.status().enabled, true);
  now = new Date('2026-10-17T15:00:00Z'); await sync.tick(); assert.equal(attempts.length, 2);
  sync.configure(false); now = new Date('2026-10-18T15:00:00Z'); await sync.tick(); assert.equal(attempts.length, 2);
  assert.equal(santiagoClock(new Date('2026-07-01T12:00:00Z')).hour, 8);
  await sync.close();
});

test('auth pauses can resume without concurrent downloads or exposing browser errors', async t => {
  const root = temporary(t); let calls = 0, finish;
  const sync = createMercadoPagoSync({ uploadsRoot: root, enableScheduler: false, checkpoints: () => [{ from: '2026-10-13' }], importReports: () => {}, browser: {
    async download() {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Inicia sesión en MercadoPago.'), { code: 'MP_AUTH_REQUIRED' });
      await new Promise(resolve => { finish = resolve; }); return [];
    }
  } });
  await sync.synchronize(); assert.equal(sync.status().status, 'waiting-auth');
  const first = sync.synchronize(), second = sync.synchronize(); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2); finish(); await first;
  assert.equal(sync.status().status, 'complete'); await sync.close();
});

test('browser downloads overlapping CSV reports across pages and uses period instead of creation date', { skip: !fs.existsSync(chrome) }, async t => {
  const root = temporary(t), app = require('express')();
  app.get('/reports', (req, res) => res.send(`<table><thead><tr><th>Fecha de creación</th><th>Período de fechas</th><th>Formato</th></tr></thead><tbody>
    ${req.query.page === '2' ? '<tr><td>15/oct/2026</td><td>1/oct/2026 a 11/oct/2026</td><td><a href="/csv/old">.csv</a></td></tr><tr><td>13/oct/2026</td><td>5/oct/2026 a 12/oct/2026</td><td><a href="/csv/second">.csv</a></td></tr>' : '<tr><td>14/oct/2026</td><td>13/oct/2026 a 13/oct/2026</td><td><a href="/csv/first">.csv</a></td></tr>'}
    </tbody></table>${req.query.page ? '' : '<a href="/reports?page=2">Siguiente</a>'}`));
  const downloaded = [];
  app.get('/csv/:id', (req, res) => { downloaded.push(req.params.id); res.attachment(req.params.id + '.csv').send(csv([row('82010740', req.params.id, '13')])); });
  const base = await serve(t, app);
  const browser = createMercadoPagoBrowser(path.join(root, 'profile'), { executablePath: chrome, reportUrl: base + '/reports' });
  t.after(() => browser.close());
  const reports = await browser.download({ from: '2026-10-12', to: '2026-10-16', directory: root, interactive: false });
  assert.deepEqual(downloaded, ['first', 'second']);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].period, { from: '2026-10-05', to: '2026-10-12' });
  assert.match(fs.readFileSync(reports[0].path, 'utf8'), /first/);
});

test('browser preserves the login window and resumes authenticated CSV download', { skip: !fs.existsSync(chrome) }, async t => {
  const root = temporary(t), app = require('express')();
  app.get('/reports', (req, res) => req.headers.cookie?.includes('signed=yes')
    ? res.send('<table><thead><tr><th>Período de fechas</th></tr></thead><tbody><tr><td>13/oct/2026 a 13/oct/2026</td><td><a href="/file">.csv</a></td></tr></tbody></table>') : res.redirect('/login'));
  app.get('/login', (req, res) => res.send('<input type="password"><button onclick="document.cookie=\'signed=yes; path=/\'; location.href=\'/reports\'">Ingresar</button>'));
  app.get('/file', (req, res) => res.attachment('report.csv').send(csv([row('82010740', 'new', '13')])));
  const base = await serve(t, app), contexts = [];
  const browser = createMercadoPagoBrowser(path.join(root, 'profile'), { executablePath: chrome, reportUrl: base + '/reports', chromium: {
    async launchPersistentContext(root, options) { const context = await chromium.launchPersistentContext(root, { ...options, headless: true }); contexts.push(context); return context; }
  } });
  t.after(() => browser.close());
  const request = { from: '2026-10-13', to: '2026-10-16', directory: root, interactive: true };
  await assert.rejects(browser.download(request), error => error.code === 'MP_AUTH_REQUIRED');
  assert.equal(contexts[0].pages()[0].isClosed(), false);
  await contexts[0].pages()[0].locator('input').fill('unfinished');
  await assert.rejects(browser.download(request), error => error.code === 'MP_AUTH_REQUIRED');
  assert.equal(await contexts[0].pages()[0].locator('input').inputValue(), 'unfinished');
  await contexts[0].pages()[0].getByRole('button', { name: 'Ingresar' }).click();
  await contexts[0].pages()[0].waitForURL(base + '/reports');
  assert.equal((await browser.download(request)).length, 1);
  assert.equal(contexts.length, 1);
});

test('UI separates manual and web imports, offers authentication continuation, and saves the daily preference', { skip: !fs.existsSync(chrome) }, async t => {
  const root = temporary(t); let calls = 0;
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, mercadoPagoBrowser: {
    async download() {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Inicia sesión en MercadoPago en la ventana del navegador del servidor y pulsa «Ya inicié sesión, continuar».'), { code: 'MP_AUTH_REQUIRED' });
      return [];
    }
  } });
  t.after(() => app.locals.mercadoPagoSync.close());
  const base = await serve(t, app), browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('link', { name: 'Datos y sincronización', exact: true }).click();
  const manual = page.locator('#upload-mercadopago-shared'), web = page.locator('#sync-mercadopago-web');
  await web.waitFor({ state: 'visible' });
  const bounds = await Promise.all([manual.boundingBox(), web.boundingBox()]);
  assert.ok(bounds[1].x > bounds[0].x + bounds[0].width);
  assert.equal(await page.locator('#mercadopago-daily').isChecked(), false);
  await page.locator('#mercadopago-daily').check();
  await page.waitForFunction(() => !document.getElementById('mercadopago-daily').disabled);
  assert.equal((await fetch(base + '/api/integrations/mercadopago').then(r => r.json())).enabled, true);
  await web.click();
  const resume = page.locator('#resume-mercadopago-web');
  await resume.waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await page.locator('#mercadopago-web-status').innerText(), /Inicia sesión/);
  await resume.click();
  await page.locator('#mercadopago-web-status').filter({ hasText: 'No hay reportes CSV disponibles' }).waitFor({ timeout: 10000 });
  assert.equal(calls, 2);
  assert.equal(await resume.isVisible(), false);
  assert.deepEqual(errors, []);
  await web.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(os.tmpdir(), 'brewit-mercadopago-web.png'), fullPage: false });
});
