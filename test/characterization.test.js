const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-characterization-'));
  const app = createApp({ uploadsRoot: root, enableLegacyTools: true, reportToday: '2026-10-24', enableToteatSync: false, enableMercadoPagoSync: false });
  const header = 'ID de orden\tFecha de creacion\tHora de creacion\tPago total\tDescuentos\tID Producto\tNombre\tCantidad\tPrecio a Pagar\tDescuento\tAB.\tCategorías de Productos/Platos';
  const storeRows = {
    'store-1': [['cl', 'P1', 'Latte (CL)', 2], ['gr', 'P2', 'Latte (GR)']],
    'store-2': [['xtr', 'P3', 'Frappé (XTR)'], ['plain', 'P4', 'Espresso (Exp)']]
  };
  const sources = {};
  for (const [id, products] of Object.entries(storeRows)) {
    const file = path.join(root, `${id}-sales.csv`);
    fs.writeFileSync(file, [header, ...products.map(([order, code, name, quantity = 1]) => [order, '2026-10-24', '10:00:00', 1190, 0, code, name, quantity, 1190, 0, 'AB.1', 'Café'].join('\t'))].join('\n'));
    sources[id] = { filePath: file, excludedRanges: [], record: { originalName: `${id}.csv`, confirmedRange: { from: '2026-10-24', to: '2026-10-24' } } };
  }
  app.locals.toteatSalesSync.source = (id, field) => field === 'sales' && sources[id] ? [sources[id]] : [];
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); await app.locals.mercadoPagoSync.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.address().port}` };
}

test('caracterización: formatos, alcance por local y progreso conservan el mismo reporte', async t => {
  const { base } = await setup(t);
  const get = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
  const options = await get('/api/demand-analysis/options');
  assert.deepEqual(options.sizes, ['CL', 'GR', 'XTR']);
  assert.equal(options.capabilities.size, true);
  const all = await get('/api/demand-analysis?locations=all&mode=month');
  assert.equal(all.summary.orders, 4);
  assert.equal(all.period.to, '2026-10-24', 'reference date defaults to the server date');
  const cl = await get('/api/demand-analysis?locations=store-1&mode=month&size=CL');
  assert.equal(cl.summary.orders, 1);
  assert.equal(cl.time.daily[0].units, 2);
  assert.deepEqual(cl.portfolio.products.map(p => p.code || p.key), ['P1']);
  assert.equal((await get('/api/demand-analysis?locations=store-2&mode=month&size=CL')).summary.orders, 0);
  assert.deepEqual((await get('/api/demand-analysis/options?locations=store-2')).sizes, ['XTR']);
  const response = await fetch(base + '/api/demand-analysis?locations=store-1&mode=month&size=CL&progress=1');
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.type === 'progress').map(e => e.completed), [1, 2, 3]);
  assert.equal(events.at(-1).type, 'result');
  assert.deepEqual(events.at(-1).data.summary, cl.summary);
  const failed = await fetch(base + '/api/demand-analysis?locations=not-a-store&progress=1').then(r => r.text());
  assert.match(failed, /"type":"error"/);
});

test('caracterización: filtros simplificados, avance visible y errores recuperables', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t);
  const report = await fetch(base + '/api/demand-analysis?locations=store-1&mode=month&size=CL').then(r => r.json());
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('link', { name: 'Caracterización de la Venta', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('demand-status').textContent === 'Análisis actualizado.');
  assert.equal(await page.getByRole('heading', { name: 'Caracterización de la Venta', exact: true }).count(), 1);
  assert.deepEqual(await page.locator('#demand-location option').allTextContents(), ['Todas las cafeterías', 'Tienda 1', 'Tienda 2']);
  assert.equal(await page.locator('#demand-anchor, #demand-channel, #demand-recurrence, #demand-morning-end, #demand-midday-end, #demand-afternoon-end').count(), 0);
  await page.locator('#demand-location').selectOption('store-1'); await page.locator('#demand-size').selectOption('CL');
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (url, options) => {
      if (!String(url).startsWith('/api/demand-analysis?')) return original(url, options);
      window.characterizationQuery = String(url);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.characterizationStream = controller;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'progress', completed: 2, total: 5, message: 'Paso 3 de 5 · Vinculando pedidos…' }) + '\n'));
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
    };
  });
  await page.locator('#demand-filters [type=submit]').click();
  await page.waitForFunction(() => document.getElementById('demand-progress-bar').value === 2);
  assert.equal(await page.locator('#demand-progress').isVisible(), true);
  assert.equal(await page.locator('#demand-filters').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#demand-location').isDisabled(), true);
  const query = new URL(await page.evaluate(() => window.characterizationQuery), base).searchParams;
  assert.equal(query.get('locations'), 'store-1'); assert.equal(query.get('size'), 'CL');
  for (const key of ['anchor', 'channel', 'recurrence', 'morningEnd', 'middayEnd', 'afternoonEnd']) assert.equal(query.has(key), false);
  await page.evaluate(report => { window.characterizationStream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'result', data: report }) + '\n')); window.characterizationStream.close(); }, report);
  await page.waitForFunction(() => document.getElementById('demand-status').textContent === 'Análisis actualizado.');
  assert.equal(await page.locator('#demand-progress').isVisible(), false);
  assert.equal(await page.locator('#demand-location').inputValue(), 'store-1');
  assert.equal(await page.locator('#demand-size').inputValue(), 'CL');
  assert.match(await page.locator('#demand-context').innerText(), /1 pedidos observados/);
  await page.locator('#demand-analysis-workspace-tab-exploration').click();
  await page.getByRole('button', { name: 'Horarios y evolución', exact: true }).click();
  assert.equal(await page.locator('#demand-time-metric').inputValue(), 'units');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '2');
  await page.locator('#demand-time-metric').selectOption('orders');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '1');
  await page.locator('#demand-time-metric').selectOption('units');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '2');
  await page.locator('#demand-time-aggregation').selectOption('average');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '2,0');
  assert.equal(await page.locator('.demand-heatmap-percentage .demand-heat-day-total').innerText(), '100,0%');
  assert.equal(await page.locator('.demand-heatmap-total strong').innerText(), 'Prom. diario');
  assert.equal(await page.locator('.demand-heatmap-hours .demand-heat-day-total').innerText(), 'Promedio del día');
  await page.locator('#demand-time-metric').selectOption('orders');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '1,0');
  await page.locator('#demand-time-aggregation').selectOption('total');
  assert.equal(await page.locator('.demand-heatmap-total .demand-heat-day-total').innerText(), '1');
  await page.locator('#demand-period').selectOption('custom');
  assert.equal(await page.locator('#demand-from').isVisible(), true);
  await page.locator('#demand-filters [type=submit]').click();
  await page.waitForFunction(() => document.getElementById('demand-progress-bar').value === 2);
  await page.evaluate(() => { window.characterizationStream.enqueue(new TextEncoder().encode('{"type":"error","error":"No se pudo leer la fuente."}\n')); window.characterizationStream.close(); });
  await page.waitForFunction(() => document.getElementById('demand-status').textContent.includes('No se pudo leer la fuente.'));
  assert.equal(await page.locator('#demand-filters [type=submit]').isEnabled(), true);
  assert.equal(await page.locator('#demand-progress').isVisible(), false);
  await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '1.3'));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#demand-filters').screenshot({ path: `/tmp/brewit-characterization-${width}.png` });
    assert.deepEqual(await page.locator('#demand-filters').evaluate(el => [...el.querySelectorAll('input,select,button')].filter(e => e.checkVisibility() && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.id)), []);
  }
  assert.deepEqual(errors, []);
});
