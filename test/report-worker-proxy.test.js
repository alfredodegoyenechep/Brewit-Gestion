const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createApp } = require('../server');

test('saved orders respond while financial results run in an isolated worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-worker-'));
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false,
    storageMaintenance: false, enableBackgroundCalculations: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await app.locals.mercadoPagoSync.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = performance.now();
  const report = fetch(`${base}/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-02`)
    .then(async response => { await response.arrayBuffer(); return { status: response.status, ms: performance.now() - start }; });
  const orders = await fetch(`${base}/api/purchase-orders?location=store-1`);
  const ordersMs = performance.now() - start;
  assert.equal(orders.status, 200);
  const result = await report;
  assert.equal(result.status, 200);
  assert.ok(ordersMs < result.ms, `Órdenes ${ordersMs.toFixed(1)} ms, resultados ${result.ms.toFixed(1)} ms`);
});

test('aborting a heavy request frees the worker slot for the next calculation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-abort-'));
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false,
    storageMaintenance: false, enableBackgroundCalculations: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await app.locals.mercadoPagoSync.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const aborted = fetch(`${base}/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-02`, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const result = await fetch(`${base}/api/ingredients?location=all&dateFrom=2026-10-01&dateTo=2026-10-02`);
  assert.notEqual(result.status, 503);
});
