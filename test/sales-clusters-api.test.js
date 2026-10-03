const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { DEFAULT_DIMENSIONS } = require('../sales-clusters');
const { createClusterJobs } = require('../sales-clusters-jobs');
const { createClusterSourceLoader } = require('../sales-clusters-source');
const XLSX = require('xlsx');

async function serverFor(t) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-clusters-api-'));
  const app = createApp({ enableLegacyTools: true, uploadsRoot, reportToday: '2026-09-17' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { app.locals.salesClusterJobs.dispose(); await new Promise(r => server.close(r)); fs.rmSync(uploadsRoot, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, base, uploadsRoot };
}
async function importSales(base) {
  const rows = [['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos', 'ID Producto', 'Nombre', 'Cantidad', 'Precio Lista', 'Precio a Pagar', 'Descuento', 'Categorías de Productos/Platos', 'AB.']];
  for (let i = 0; i < 40; i++) {
    const group = i % 2, amount = group ? 4760 : 1190;
    rows.push([`cluster-${i}`, `2026-09-${String(1 + Math.floor(i / 2) % 10).padStart(2, '0')}`, group ? '18:00:00' : '09:00:00', amount, 0,
      group ? 'B' : 'A', group ? 'Almuerzo' : 'Café', 1, amount, amount, 0, group ? 'Comida' : 'Bebidas', group ? 'FOOD.1' : 'DRINK.1']);
  }
  // A whole order spanning two product lines remains one observation.
  rows.push(['cluster-0', '2026-09-01', '09:00:00', 1190, 0, 'EX', 'Acompañamiento', 1, 0, 0, 0, 'Bebidas', 'DRINK.1']);
  const form = new FormData(); form.append('sales', new Blob([rows.map(r => r.join('\t')).join('\n')]), 'ventas-clusters.csv');
  const inspect = await fetch(`${base}/api/uploads/transactions/inspect?location=store-1`, { method: 'POST', body: form }).then(r => r.json());
  const confirmed = await fetch(`${base}/api/uploads/transactions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inspect.token, dateFrom: inspect.detectedRange.from, dateTo: inspect.detectedRange.to, confirmed: true, categoryConfirmed: true, overlapAction: 'keep' }) });
  assert.equal(confirmed.status, 200);
}
async function waitJob(base, id) {
  for (let i = 0; i < 120; i++) {
    const job = await fetch(`${base}/api/sales-clusters/jobs/${id}`).then(r => r.json());
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('El trabajo no terminó a tiempo.');
}
const dims = Object.fromEntries(Object.entries(DEFAULT_DIMENSIONS).map(([k, d]) => [k, { ...d, enabled: ['products', 'hour', 'spend'].includes(k), ...(k === 'products' ? { level: 'product' } : {}) }]));

test('clusters recibe la estimación de nombres de Detalle Pagos sin exponer comentarios', async t => {
  const { base, uploadsRoot } = await serverFor(t); await importSales(base);
  const directory = path.join(uploadsRoot, 'transactions', 'store-1');
  const indexPath = path.join(directory, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const rows = Array.from({ length: 40 }, (_, i) => ({ Comanda: `cluster-${i}`,
    FechaCierre: `2026-09-${String(1 + Math.floor(i / 2) % 10).padStart(2, '0')}`,
    'Comentario General': i < 10 ? 'Camila' : i < 20 ? 'Pedro' : 'Cliente', Total: i % 2 ? 4760 : 1190 }));
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Pagos');
  XLSX.writeFile(workbook, path.join(directory, 'identity-test.xlsx'));
  index.fields['payment-details'] = { files: [{ id: 'identity-test', name: 'identity-test.xlsx',
    confirmedRange: { from: '2026-09-01', to: '2026-09-10' } }] };
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const options = await fetch(`${base}/api/sales-clusters/options?locations=store-1&mode=all`).then(r => r.json());
  const gender = options.coverage.find(d => d.key === 'gender');
  assert.equal(gender.known, 20); assert.equal(gender.coverage, 50); assert.equal(gender.available, true);
  assert.ok(!JSON.stringify(options).includes('Camila'));
  const config = { dimensions: { gender: { enabled: false, level: 'validated' } } };
  const validated = await fetch(`${base}/api/sales-clusters/options?${new URLSearchParams({ locations: 'store-1', mode: 'all', configuration: JSON.stringify(config) })}`).then(r => r.json());
  const validatedGender = validated.coverage.find(d => d.key === 'gender');
  assert.equal(validatedGender.known, 0); assert.equal(validatedGender.nameKnown, 20);
  assert.equal(validated.identityDiagnostics.recurrence.noPaymentData, 40);
});

test('recurrencia usa historia MercadoPago, identifica pagos sin tarjeta y explicita fechas sin fuente', async t => {
  const { base, uploadsRoot } = await serverFor(t);
  const directory = path.join(uploadsRoot, 'transactions', 'store-1'); fs.mkdirSync(directory, { recursive: true });
  const save = (name, rows) => {
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Datos');
    XLSX.writeFile(workbook, path.join(directory, name));
  };
  const sales = [1, 2, 3, 4].map((i) => ({ 'ID de orden': `o${i}`, 'Fecha de creacion': i === 4 ? '2026-09-11' : '2026-09-10',
    'Hora de creacion': `${String(8 + i).padStart(2, '0')}:00:00`, 'Pago total': 1190 * i,
    'ID Producto': 'A', Nombre: 'Café', Cantidad: 1, 'Precio a Pagar': 1190 * i }));
  const payments = [1, 2, 3].map(i => ({ SOURCE_ID: `p${i}`, TRANSACTION_TYPE: 'SETTLEMENT',
    TRANSACTION_DATE: `2026-09-10T${String(7 + i).padStart(2, '0')}:00:00-04:00`, TRANSACTION_AMOUNT: 1190 * i,
    CARD_INITIAL_NUMBER: '123456', LAST_FOUR_DIGITS: i === 3 ? null : '0123' }));
  save('sales.xlsx', sales); save('mp.xlsx', payments);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ fields: {
    sales: { files: [{ id: 's', name: 'sales.xlsx' }] }, mercadopago: { files: [{ id: 'm', name: 'mp.xlsx' }] }
  } }));
  const response = await fetch(`${base}/api/sales-clusters/options?locations=store-1&mode=all`).then(r => r.json());
  assert.equal(response.orders, 4);
  assert.equal(response.coverage.find(d => d.key === 'recurrence').known, 2);
  const diagnostic = response.identityDiagnostics.recurrence;
  assert.equal(diagnostic.classified, 2); assert.equal(diagnostic.missingInstrument, 1); assert.equal(diagnostic.noPaymentData, 1);
  assert.equal(diagnostic.paymentPeriods[0].to, '2026-09-10');
  assert.ok(!JSON.stringify(response).includes('123456'));
  const sourceApp = createApp({ uploadsRoot, reportToday: '2026-09-17', clusterSourceWorker: false, clusterCachePersistence: false });
  t.after(() => sourceApp.locals.salesClusterJobs.dispose());
  const source = sourceApp.locals.salesClusterSource({ locations: 'store-1', mode: 'all' });
  assert.deepEqual(source.input.orders.slice(0, 2).map(o => o.recurrenceTransactionGroup), ['single-observed-date', 'returning-instrument']);
  assert.deepEqual(source.input.orders.slice(0, 2).map(o => o.recurrenceGroup), ['single-observed-date', 'single-observed-date']);
});

test('API usa pedidos completos, parámetros 50 %, caché, paginación, comparación y límite de profundidad', async t => {
  const { base, uploadsRoot } = await serverFor(t); await importSales(base);
  const filters = { locations: 'store-1', mode: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-10' };
  const options = await fetch(`${base}/api/sales-clusters/options?${new URLSearchParams(filters)}`).then(r => r.json());
  assert.equal(options.orders, 40); assert.equal(options.parameters.dimensionCoverage, 50);
  assert.equal(options.coverage.find(d => d.key === 'gender').known, 0);
  const body = { filters, dimensions: dims, parameters: { minimumOrders: 20, minimumClusterOrders: 5 } };
  const submit = body => fetch(`${base}/api/sales-clusters/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const posted = await submit(body); assert.equal(posted.status, 202); const job = await posted.json();
  const cached = await submit(body).then(r => r.json()); assert.equal(cached.id, job.id); assert.equal(cached.cached, true);
  assert.equal((await waitJob(base, job.id)).status, 'completed');
  const result = await fetch(`${base}/api/sales-clusters/jobs/${job.id}/result`).then(r => r.json());
  assert.equal(result.summary.orders, 40); assert.equal(result.summary.netSales, 100000); assert.equal(result.stale, false);
  assert.equal(result.parameters.dimensionCoverage, 50); assert.equal(result.customParameters, true);
  assert.equal(result.clusters.reduce((s, c) => s + c.netSales, 0) + result.unassigned.netSales, 100000);
  const group = result.clusters.find(c => c.representative.time === '09:00');
  const page = await fetch(`${base}/api/sales-clusters/jobs/${job.id}/clusters/${group.id}/orders?page=1&limit=1`).then(r => r.json());
  assert.equal(page.orders.length, 1); assert.equal(page.total, group.orders);
  const all = await fetch(`${base}/api/sales-clusters/jobs/${job.id}/clusters/${group.id}/orders?limit=100`).then(r => r.json());
  assert.equal(all.orders.find(o => o.orderReference === 'cluster-0').lines.length, 2);
  const parentOptions = await fetch(`${base}/api/sales-clusters/options?parentJobId=${job.id}&parentClusterId=${group.id}`).then(r => r.json());
  assert.equal(parentOptions.orders, group.orders); assert.equal(parentOptions.parent.clusterId, group.id);
  assert.ok(!JSON.stringify(result).includes('paymentComment') && !JSON.stringify(all).includes('instrumentKey'));
  const changed = await submit({ ...body, parameters: { ...body.parameters, dimensionCoverage: 45 } }).then(r => r.json());
  assert.notEqual(changed.id, job.id); await fetch(`${base}/api/sales-clusters/jobs/${changed.id}`, { method: 'DELETE' });
  const comparison = await submit({ ...body, referenceJobId: job.id }).then(r => r.json());
  assert.equal((await waitJob(base, comparison.id)).status, 'completed');
  const compared = await fetch(`${base}/api/sales-clusters/jobs/${comparison.id}/result`).then(r => r.json());
  assert.equal(compared.validation.method, 'fixed-definitions');
  assert.ok(compared.comparison.clusters.every(c => c.changePoints === 0));
  const child = await submit({ ...body, parent: { jobId: job.id, clusterId: group.id } }).then(r => r.json());
  await waitJob(base, child.id);
  const childResult = await fetch(`${base}/api/sales-clusters/jobs/${child.id}/result`).then(r => r.json());
  assert.equal(childResult.depth, 2); assert.equal(childResult.summary.orders, group.orders);
  assert.equal(childResult.summary.rootTotals.orders, 40);
  const bad = await submit({ ...body, parameters: { dimensionCoverage: 101 } }); assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/sales-clusters/jobs/${job.id}/clusters/does-not-exist/orders`)).status, 404);
  // The snapshot stays readable even if its café is later removed from the active registry.
  const locationsPath = path.join(uploadsRoot, 'config', 'locations.json');
  const locations = JSON.parse(fs.readFileSync(locationsPath, 'utf8'));
  locations.locations.find(l => l.id === 'store-1').status = 'trashed'; fs.writeFileSync(locationsPath, JSON.stringify(locations));
  const oldResult = await fetch(`${base}/api/sales-clusters/jobs/${job.id}/result`).then(r => r.json());
  assert.equal(oldResult.stale, true); assert.equal(oldResult.summary.orders, 40);
});

test('API explica falta de datos y rechaza fechas futuras', async t => {
  const { base } = await serverFor(t);
  const badDate = await fetch(`${base}/api/sales-clusters/options?mode=custom&dateFrom=2026-09-01&dateTo=2027-01-01`);
  assert.equal(badDate.status, 400);
  const response = await fetch(`${base}/api/sales-clusters/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: { locations: 'all', mode: 'all' } }) });
  const job = await response.json(); assert.equal((await waitJob(base, job.id)).status, 'completed');
  const result = await fetch(`${base}/api/sales-clusters/jobs/${job.id}/result`).then(r => r.json());
  assert.equal(result.status, 'insufficient'); assert.equal(result.summary.orders, 0);
});

test('caché conserva resultados tras reiniciar y se separa por propietario', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-cluster-cache-'));
  const storageRoot = path.join(temp, 'cache'); let jobs = createClusterJobs({ storageRoot });
  t.after(() => { jobs.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const input = { sourceFingerprint: 'source', config: {}, orders: [], period: { from: '2026-09-01', to: '2026-09-02' } };
  const posted = jobs.submit(input, 'owner');
  for (let attempt = 0; attempt < 100 && jobs.get(posted.id, 'owner').status !== 'completed'; attempt++) await new Promise(r => setTimeout(r, 10));
  assert.equal(jobs.result(posted.id, 'owner').output.result.status, 'insufficient');
  jobs.dispose(); jobs = createClusterJobs({ storageRoot });
  assert.equal(jobs.result(posted.id, 'owner').output.result.summary.orders, 0);
  assert.equal(jobs.submit(input, 'owner').id, posted.id);
  assert.throws(() => jobs.result(posted.id, 'another-owner'), e => e.status === 404);
});

test('cola limitada, cancelación, aislamiento y caducidad sin bloquear el servidor', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-cluster-workers-')), workerPath = path.join(temp, 'slow.cjs');
  fs.writeFileSync(workerPath, "const {parentPort}=require('node:worker_threads'); setTimeout(()=>parentPort.postMessage({type:'complete',output:{result:{message:'Terminado'},orders:[],membership:[]}}),1000);");
  const jobs = createClusterJobs({ workerPath, ttlMs: 20 });
  t.after(() => { jobs.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const make = seed => ({ seed, sourceFingerprint: 'source', config: {}, orders: [], period: { from: '2026-09-01', to: '2026-09-02' } });
  const one = jobs.submit(make(1), 'one'), two = jobs.submit(make(2), 'one'), three = jobs.submit(make(3), 'one');
  assert.equal(one.status, 'running'); assert.equal(two.status, 'queued'); assert.equal(three.status, 'queued');
  assert.throws(() => jobs.submit(make(4), 'one'), e => e.status === 429);
  assert.throws(() => jobs.get(one.id, 'two'), e => e.status === 404);
  jobs.cancel(three.id, 'one'); jobs.cancel(one.id, 'one');
  assert.equal(jobs.get(two.id, 'one').status, 'running');
  jobs.cancel(two.id, 'one');
  await new Promise(r => setTimeout(r, 30));
  assert.throws(() => jobs.get(two.id, 'one'), e => e.status === 404);
});

test('preparación de fuentes mantiene libre el hilo HTTP durante una lectura intensiva', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-cluster-source-')), workerPath = path.join(temp, 'source.cjs');
  fs.writeFileSync(workerPath, "const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{const until=Date.now()+200;while(Date.now()<until){}parentPort.postMessage({id:m.id,source:{ready:true}});});");
  const loader = createClusterSourceLoader({ workerPath, uploadsRoot: temp, today: () => '2026-09-17' });
  t.after(() => { loader.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const reading = loader.load({ locations: 'all' });
  const start = Date.now(); await new Promise(r => setTimeout(r, 25));
  assert.ok(Date.now() - start < 150, 'La lectura no debe bloquear el event loop.');
  assert.deepEqual(await reading, { ready: true });
});
