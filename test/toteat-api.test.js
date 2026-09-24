const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { chromium } = require('playwright-core');

async function setup(t, toteatApiFetch, uploadsRoot) {
  const root = uploadsRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-api-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot: root, toteatApiFetch }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (!uploadsRoot) fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, base, connect: values => fetch(`${base}/api/integrations/toteat/api/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values)
  }) };
}
const credentials = { location: 'store-1', restaurantId: '123', localId: '1', userId: '456', token: 'secret-test-token' };

test('connects with read-only menu request, persists private credentials and exposes only summary', async t => {
  const app = await setup(t, async (url, options) => {
    assert.equal(url.origin, 'https://api.toteat.com');
    assert.equal(url.pathname, '/mw/or/1.0/products');
    assert.equal(url.searchParams.get('xapitoken'), credentials.token);
    assert.equal(url.searchParams.get('xiu'), credentials.userId);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return Response.json({ ok: true, data: [{ id: 'COF001' }] });
  });
  const response = await app.connect(credentials);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const summary = await response.json();
  assert.equal(summary.productCount, 1);
  assert.equal(summary.configured, true);
  assert.equal(JSON.stringify(summary).includes(credentials.token), false);
  const file = path.join(app.root, '.integrations/toteat-api/credentials.json');
  assert.equal(JSON.parse(fs.readFileSync(file))['store-1'].token, credentials.token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const config = await fetch(`${app.base}/api/integrations/toteat/api/config?location=store-1`);
  assert.deepEqual(await config.json(), summary);
  assert.equal((await fetch(`${app.base}/uploads/.integrations/toteat-api/credentials.json`)).status, 404);
  assert.equal((await app.connect(credentials)).status, 429);
  const restarted = await setup(t, async url => {
    assert.equal(url.searchParams.get('xapitoken'), credentials.token);
    return Response.json({ ok: true, data: [] });
  }, app.root);
  assert.equal((await restarted.connect({ ...credentials, token: '' })).status, 200);
});

test('rejects invalid inputs without calling Toteat', async t => {
  const app = await setup(t, () => { throw new Error('Should not call'); });
  for (const values of [{ ...credentials, location: 'missing' }, { ...credentials, token: '' }, { ...credentials, userId: 'a b' }]) {
    assert.equal((await app.connect(values)).status, 400);
  }
  assert.equal(fs.existsSync(path.join(app.root, '.integrations/toteat-api/credentials.json')), false);
});

for (const [name, upstream] of [
  ['rejected permission', async () => Response.json({ error: credentials.token }, { status: 403 })],
  ['application failure', async () => Response.json({ ok: false, data: [], msg: credentials.token })],
  ['invalid menu', async () => Response.json({ ok: true, data: {} })],
  ['network error', async () => { throw new Error(credentials.token); }],
  ['rate limit', async () => new Response(credentials.token, { status: 429 })]
]) {
  test(`${name} never exposes secrets or overwrites saved credentials`, async t => {
    const app = await setup(t, upstream);
    const root = path.join(app.root, '.integrations/toteat-api');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'credentials.json');
    const previous = JSON.stringify({ 'store-1': { ...credentials, token: 'previous-token' } });
    fs.writeFileSync(file, previous);
    const response = await app.connect(credentials);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(credentials.token), false);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  });
}

test('connection form saves a verified connection and clears the token in the browser', async t => {
  const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(candidate => fs.existsSync(candidate));
  if (!executablePath) { t.skip('Chrome is unavailable'); return; }
  const app = await setup(t, async () => Response.json({ ok: true, data: [{ id: 'COF001' }] }));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.base);
  await page.locator('[data-view="config"]').click();
  await page.waitForFunction(() => document.querySelector('#toteat-api-form [name=token]').required);
  for (const key of ['restaurantId', 'localId', 'userId', 'token']) {
    await page.locator(`#toteat-api-form [name=${key}]`).fill(credentials[key]);
  }
  await page.getByRole('button', { name: 'Probar conexión y guardar' }).click();
  await page.waitForFunction(() => document.getElementById('toteat-api-status').textContent.includes('Acceso al menú verificado'));
  assert.equal(await page.locator('#toteat-api-form [name=token]').inputValue(), '');
  assert.equal(await page.locator('#toteat-api-form [name=token]').getAttribute('required'), null);
  await page.locator('#toteat-api-location').selectOption('store-2');
  await page.waitForFunction(() => document.getElementById('toteat-api-status').textContent.includes('Ingresa las credenciales'));
  assert.equal(await page.locator('#toteat-api-form [name=userId]').inputValue(), '');
});
