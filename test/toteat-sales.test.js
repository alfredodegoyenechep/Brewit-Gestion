const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('../record-workbooks');
const { salesRows, createSalesSync, localTimestamp, windows } = require('../toteat-sales');
const { createApp } = require('../server');
const line = (overrides = {}) => ({ id: 'B1', lineId: 'l1', lineReference: 0, quantity: 1, payed: 3430, discounts: -1470, taxes: 548, totalCost: 1200, netPrice: 4900, name: 'Café', hierarchyId: 'AB.01', ...overrides });
const payment = (overrides = {}) => ({ orderId: 'o1', paymentId: 'p1', dateOpen: '2026-09-21T12:00:00', dateClosed: '2026-09-21T12:03:00', total: 3430, discounts: -1470, taxes: 548, gratuity: 343, payed: 5000, change: 1227, fiscalId: 101, fiscalType: 'BE', comment: 'servir', products: [line()], paymentForms: [{ id: 1000, name: 'CASH', amount: 5000, tip: 343 }], ...overrides });

test('adapter preserves final sales, discounts, change, line identity and Chilean time', () => {
  const { sales, details } = salesRows([payment()]);
  assert.equal(sales[0]['Pago total'] + sales[0].Descuentos, 3430);
  assert.equal(sales[0]['Precio a Pagar'], 3430);
  assert.equal(sales[0]['Precio Base'], 4900);
  assert.equal(sales[0]['Total a pagar'], 4900);
  assert.equal(sales[0]['Total con propina'], 5243);
  assert.equal(sales[0]['Hora de creacion'], '09:00:00');
  assert.equal(details[0]['A Pagar'], 3430);
  assert.equal(details[0]['Medio 1000 · CASH'], 3773);
  assert.equal(details[0]['API Moneda'], 'CLP');
  assert.equal(details[0]['Comentario General'], 'servir');
  assert.equal(localTimestamp('2026-06-01T03:30:00Z').date, '2026-05-31');
});

test('repeated extras stay distinct and references preserve parent adjacency', () => {
  const p = payment({ total: 200, discounts: 0, products: [
    line({ id: 'BX1', lineId: 'x2', lineReference: 'b2', payed: 50, discounts: 0 }),
    line({ id: 'B2', lineId: 'b2', payed: 50, discounts: 0 }),
    line({ id: 'BX1', lineId: 'x1', lineReference: 'b1', payed: 50, discounts: 0 }),
    line({ id: 'B1', lineId: 'b1', payed: 50, discounts: 0 })
  ] });
  const r = salesRows([p]);
  assert.deepEqual(r.sales.map(x => x['API Line ID']), ['b2', 'x2', 'b1', 'x1']);
  assert.equal(new Set(r.sales.map(x => JSON.stringify(x))).size, 4);
});

test('credit notes reverse positive source lines exactly once without mutating API data', () => {
  const original = payment({ discounts: 0, total: 3430, products: [line({ discounts: 0 })] });
  const note = payment({ fiscalType: 'NC', paymentId: 'nc1', total: -3430, discounts: 0, taxes: -548, products: [line({ discounts: 0 })] });
  const rows = salesRows([original, note]);
  assert.equal(rows.sales[0]['Pago total'], 0);
  assert.equal(rows.sales.reduce((sum, r) => sum + r['Precio a Pagar'], 0), 0);
  assert.equal(rows.sales.reduce((sum, r) => sum + r.Cantidad, 0), 0);
  assert.equal(note.products[0].payed, 3430);
});

test('separate payments sum once per order and ambiguous shared lines are blocked', () => {
  const a = payment();
  const b = payment({ paymentId: 'p2', products: [line({ lineId: 'l2' })] });
  const rows = salesRows([a, b]);
  assert.equal(rows.orders, 1);
  assert.equal(rows.sales.filter(r => r['Pago total'] !== null).length, 1);
  assert.equal(rows.details[0]['API Total Orden'], 6860);
  assert.equal(rows.details[1]['A Pagar'], 3430);
  assert.throws(() => salesRows([a, payment({ paymentId: 'p2' })]), /línea se repite/);
  const missing = salesRows([payment({ products: [] })]);
  assert.equal(missing.sales[0]['Pago total'] + missing.sales[0].Descuentos, 3430);
  assert.equal(missing.sales[0]['ID Producto'], '');
  assert.equal(missing.sales[0].Cantidad, null);
  assert.equal(missing.details[0]['A Pagar'], 3430);
  assert.equal(missing.warnings.length, 1);
  assert.throws(() => salesRows([payment({ total: 9999 })]), /no concilia/);
});

function service(t, request) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-'));
  t.after(async () => {await require('../historical-control').get(uploadsRoot).idle();fs.rmSync(uploadsRoot, { recursive: true, force: true });});
  const options = { uploadsRoot, activeLocation: id => ['store-1', 'store-2'].includes(id) ? { id, type: 'store' } : null,
    credentials: () => ({ 'store-1': { localId: '1' }, 'store-2': { localId: '2' } }),
    request, clock: () => '2026-09-21' };
  const sync = createSalesSync(options);
  for (const id of ['store-1', 'store-2']) sync.configure(id, { from: '2026-09-14', enabled: true, intervalMinutes: 5 });
  return { sync, uploadsRoot, options };
}
test('manual historical review reloads complete sales windows and records coverage', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-review-'));
  t.after(async () => { await require('../historical-control').get(uploadsRoot).idle(); fs.rmSync(uploadsRoot,{recursive:true,force:true}); });
  const calls=[];
  const sync=createSalesSync({uploadsRoot,activeLocation:id=>id==='store-1'?{id,type:'store'}:null,
    credentials:()=>({'store-1':{localId:'1'}}),clock:()=> '2026-10-20',
    request:async (config,route,params)=>{if(route==='sales')calls.push(params.ini);return {ok:true,data:route==='shiftstatus'?{status:'closed',localNumber:'1'}:[]};}});
  sync.configure('store-1',{from:'2026-09-01',enabled:false,intervalMinutes:5});
  await sync.synchronize('store-1',{full:true});calls.length=0;
  await sync.synchronize('store-1',{reviewRange:{from:'2026-09-10',to:'2026-09-11'}});
  assert.deepEqual(calls,['20260901']);
  assert.deepEqual(sync.status('store-1').lastHistoricalReview.from,'2026-09-10');
});
test('recent sales refresh checks only the current window, retains closed-window data and records coverage', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-recent-'));
  t.after(async () => { await require('../historical-control').get(uploadsRoot).idle(); fs.rmSync(uploadsRoot,{recursive:true,force:true}); });
  const calls=[];
  let fail=false, oldTotal=3430;
  const oldPayment=()=>payment({orderId:'old-order',paymentId:'old-payment',dateOpen:'2026-09-16T12:00:00',dateClosed:'2026-09-16T12:03:00',
    total:oldTotal,discounts:0,payed:oldTotal,change:0,gratuity:0,products:[line({lineId:'old-line',payed:oldTotal,discounts:0})],
    paymentForms:[{id:1000,name:'CASH',amount:oldTotal,tip:0}]});
  const currentPayment=payment({orderId:'current-order',paymentId:'current-payment',dateOpen:'2026-10-20T12:00:00',dateClosed:'2026-10-20T12:03:00',
    products:[line({lineId:'current-line'})]});
  const sync=createSalesSync({uploadsRoot,activeLocation:id=>id==='store-1'?{id,type:'store'}:null,
    credentials:()=>({'store-1':{localId:'1'}}),clock:()=> '2026-10-20',
    request:async (config,route,params,onDiagnostic)=>{
      onDiagnostic?.({queueWaitMs:10,networkMs:2,bodyMs:1,requestMs:3,responseBytes:100,status:200,rows:route==='sales'?1:null});
      if(route==='shiftstatus')return {ok:true,data:{status:'closed',localNumber:'1'}};
      calls.push(params.ini);
      if(fail)throw Error('Fuente incompleta');
      return {ok:true,data:params.ini==='20260916'?[oldPayment()]:params.ini==='20261016'?[currentPayment]:[]};
    }});
  sync.configure('store-1',{from:'2026-09-01',enabled:false,intervalMinutes:5});
  await sync.synchronize('store-1',{recentOnly:true});
  assert.deepEqual(calls,['20260901','20260916','20261001','20261016'],'first load still fills missing windows');
  assert.equal(sync.status('store-1').lastCheck.scope,'recent');
  calls.length=0;
  await sync.synchronize('store-1',{recentOnly:true});
  assert.deepEqual(calls,['20261016']);
  assert.deepEqual(sync.status('store-1').lastCheck.windows,[{from:'2026-10-16',to:'2026-10-20'}]);
  assert.equal(sync.status('store-1').lastCheck.requestCount,2);
  assert.equal(sync.status('store-1').completedWindows,4);
  assert.equal(sync.status('store-1').paymentCount,2);
  oldTotal=4000;
  await sync.synchronize('store-1',{recentOnly:true});
  assert.equal(sync.get('store-1').payments.find(p=>p.paymentId==='old-payment').total,3430,'quick refresh preserves the last verified closed window');
  const settingsFile=path.join(uploadsRoot,'.integrations/toteat-api/sales/settings.json');
  const previous=JSON.parse(fs.readFileSync(settingsFile))['store-1'].lastCheck;
  assert.deepEqual(previous.calls.map(call=>call.route),['shiftstatus','sales']);
  assert.equal(previous.calls[1].queueWaitMs,10);
  calls.length=0;
  await sync.synchronize('store-1',{reviewRange:{from:'2026-09-16',to:'2026-09-16'}});
  assert.deepEqual(calls,['20260916']);
  assert.equal(sync.get('store-1').payments.find(p=>p.paymentId==='old-payment').total,4000,'historical review publishes the corrected payment');
  assert.equal(sync.status('store-1').lastCheck.scope,'period');
  fail=true;
  const checked=sync.status('store-1').lastCheck;
  await assert.rejects(sync.synchronize('store-1',{recentOnly:true}),/Fuente incompleta/);
  assert.deepEqual(sync.status('store-1').lastCheck,checked,'a failed refresh cannot advance checked coverage');
});
test('recent update publishes changed product detail and payments together and retains both on failure', async t => {
  let current = payment();
  const { sync } = service(t, async (credential, route) => ({ ok: true,
    data: route === 'shiftstatus' ? { status: 'closed', localNumber: credential.localId } : [current] }));
  const rows = field => {
    const source = sync.source('store-1', field)[0];
    const book = XLSX.readFile(source.filePath);
    return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
  };
  await sync.synchronize('store-1', { recentOnly: true });
  const firstVersion = sync.get('store-1').version;
  assert.equal(rows('sales').length, 1);
  current = payment({ total: 4000, discounts: 0, gratuity: 0, payed: 4000, change: 0,
    products: [line({ id: 'B1', lineId: 'l1', payed: 2000, discounts: 0 }), line({ id: 'B2', lineId: 'l2', payed: 2000, discounts: 0 })],
    paymentForms: [{ id: 1000, name: 'CASH', amount: 4000, tip: 0 }] });
  await sync.synchronize('store-1', { recentOnly: true });
  const published = sync.get('store-1').version;
  assert.notEqual(published, firstVersion);
  assert.deepEqual(rows('sales').map(row => row['ID Producto']), ['B1', 'B2']);
  assert.equal(rows('sales').reduce((sum, row) => sum + row['Precio a Pagar'], 0), 4000);
  assert.equal(rows('payment-details').length, 1);
  assert.equal(rows('payment-details')[0]['A Pagar'], 4000);
  const sales = sync.source('store-1', 'sales')[0], details = sync.source('store-1', 'payment-details')[0];
  assert.equal(sales.destination, details.destination);
  assert.equal(sales.record.savedAt, details.record.savedAt);
  current = { ...current, total: 5000 };
  await assert.rejects(sync.synchronize('store-1', { recentOnly: true }), /no concilia/);
  assert.equal(sync.get('store-1').version, published);
  assert.equal(rows('sales').length, 2);
  assert.equal(rows('payment-details')[0]['A Pagar'], 4000);
});

test('one shared sales schedule controls every store, preserves manual mode and survives restarts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-09-21T12:00:00Z') });
  const calls = [];
  const { sync, options } = service(t, async (credential, route) => {
    calls.push([credential.localId, route]);
    return { ok: true, data: route === 'shiftstatus' ? { status: 'closed', localNumber: credential.localId } : [] };
  });
  t.after(() => sync.stop());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const starts = id => calls.filter(([localId, route]) => localId === id && route === 'shiftstatus').length;
  sync.configure('store-1', { from: '2026-09-14', enabled: false, intervalMinutes: 5 });
  assert.equal(sync.status('store-2').enabled, false);
  sync.start();
  t.mock.timers.tick(60 * 60000); await settle();
  assert.deepEqual(calls, []);
  sync.configure('store-2', { from: '2026-09-14', enabled: true, intervalMinutes: 15 });
  assert.deepEqual(sync.schedule(), { enabled: true, intervalMinutes: 15 });
  assert.equal(sync.status('store-1').intervalMinutes, 15);
  t.mock.timers.tick(30000); await settle();
  assert.equal(starts('1'), 1); assert.equal(starts('2'), 1);
  t.mock.timers.tick(14.5 * 60000); await settle();
  assert.equal(starts('1'), 1); assert.equal(starts('2'), 1);
  t.mock.timers.tick(.5 * 60000); await settle();
  assert.equal(starts('1'), 2); assert.equal(starts('2'), 2);
  sync.configure('store-1', { from: '2026-09-14', enabled: true, intervalMinutes: 5 });
  assert.equal(sync.status('store-2').intervalMinutes, 5);
  t.mock.timers.tick(4.5 * 60000); await settle();
  assert.equal(starts('1'), 2); assert.equal(starts('2'), 2);
  t.mock.timers.tick(.5 * 60000); await settle();
  assert.equal(starts('1'), 3); assert.equal(starts('2'), 3);
  sync.configure('store-2', { from: '2026-09-14', enabled: false, intervalMinutes: 5 });
  sync.stop();
  const restarted = createSalesSync(options); t.after(() => restarted.stop());
  restarted.start();
  t.mock.timers.tick(60 * 60000); await settle();
  assert.equal(starts('1'), 3); assert.equal(starts('2'), 3);
  await restarted.synchronize('store-1');
  assert.equal(starts('1'), 4);
  assert.equal(restarted.status('store-1').enabled, false);
  assert.equal(restarted.status('store-2').enabled, false);
  t.mock.timers.tick(60 * 60000); await settle();
  assert.equal(starts('1'), 4); assert.equal(starts('2'), 3);
});

test('conflicting legacy frequencies migrate to shared manual mode while retaining each historical range', t => {
  const { uploadsRoot, options } = service(t, async () => { throw Error('Must not contact Toteat'); });
  const file = path.join(uploadsRoot, '.integrations/toteat-api/sales/settings.json');
  const saved = {
    'store-1': { from: '2026-05-18', enabled: false, intervalMinutes: 5, lastAttempt: '2026-09-21T12:00:00Z' },
    'store-2': { from: '2026-09-01', enabled: true, intervalMinutes: 15, lastFullSuccess: '2026-09-20T12:00:00Z' }
  };
  fs.writeFileSync(file, JSON.stringify(saved));
  const migrated = createSalesSync(options);
  assert.deepEqual(migrated.schedule(), { enabled: false, intervalMinutes: 5 });
  for (const id of ['store-1', 'store-2']) {
    assert.equal(migrated.status(id).enabled, false);
    assert.equal(migrated.status(id).from, saved[id].from);
  }
  const actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(actual['store-1'].lastAttempt, saved['store-1'].lastAttempt);
  assert.equal(actual['store-2'].lastFullSuccess, saved['store-2'].lastFullSuccess);
  const restarted = createSalesSync(options);
  assert.deepEqual(restarted.schedule(), migrated.schedule());
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), actual);
});

test('a frequency change during synchronization stays shared after the running job finishes', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const { sync } = service(t, async (credential, route) => {
    if (route === 'shiftstatus') await hold;
    return { ok: true, data: route === 'shiftstatus' ? { status: 'closed', localNumber: credential.localId } : [] };
  });
  const pending = sync.synchronize('store-1');
  sync.configure('store-1', { from: '2026-09-14', enabled: false, intervalMinutes: 5 });
  assert.equal(sync.status('store-2').enabled, false);
  release(); await pending;
  assert.deepEqual(sync.schedule(), { enabled: false, intervalMinutes: 5 });
  assert.equal(sync.status('store-1').enabled, false);
});

test('synchronization publishes both files atomically, is idempotent, and preserves legacy history', async t => {
  let data = [payment()], fail = false;
  const { sync, uploadsRoot, options } = service(t, async (c, route) => {
    if (fail) throw new Error('Sin autorización');
    return { ok: true, data: route === 'shiftstatus' ? { status: 'closed', localNumber: c.localId } : data };
  });
  await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').paymentCount, 1);
  const legacyPath = path.join(uploadsRoot, 'transactions/store-1/old.xlsx');
  assert.deepEqual(sync.filterLegacy(legacyPath, [{ 'ID de orden': 'o1' }, { 'ID de orden': 'historic' }]), [{ 'ID de orden': 'historic' }]);
  for (const field of ['sales', 'payment-details']) {
    const file = sync.source('store-1', field)[0].filePath;
    assert.equal(XLSX.readFile(file).SheetNames.length, 1);
  }
  await sync.synchronize('store-1'); assert.equal(sync.status('store-1').paymentCount, 1);
  const version = sync.get('store-1').version;
  fail = true; await assert.rejects(sync.synchronize('store-1'));
  assert.equal(sync.get('store-1').version, version);
  fail = false; data = []; await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').state, 'connected-empty');
  assert.equal(sync.filterLegacy(legacyPath, [{ 'ID de orden': 'o1' }]).length, 0, 'cancelled payment must not reappear from a legacy file');
  const restarted = createSalesSync(options); assert.equal(restarted.status('store-1').state, 'connected-empty');
  await sync.synchronize('store-2'); assert.equal(sync.status('store-2').state, 'connected-empty');
});

test('warning timestamps are recovered from historical payments in Chilean time', async t => {
  const { sync, options } = service(t, async (c, route) => ({ ok: true, data: route === 'shiftstatus'
    ? { status: 'closed', localNumber: c.localId }
    : [payment({ products: [], dateClosed: '2026-06-01T03:30:00Z' }), payment({ paymentId: 'p2', products: [], dateClosed: '2026-09-21T12:03:00' })] }));
  await sync.synchronize('store-1');
  assert.equal(sync.get('store-1').warnings[0].closedAt, undefined);
  const restarted = createSalesSync(options);
  assert.deepEqual(restarted.status('store-1').detailWarnings.map(w => w.closedAt), [
    { date: '2026-05-31', time: '23:30:00' }, { date: '2026-09-21', time: '09:03:00' }
  ]);
});

test('refresh includes an old open shift and windows stay at most 15 days', async t => {
  const queries = [];
  const { options } = service(t, async (c, route, params) => {
    if (route === 'shiftstatus') return { ok: true, data: { status: 'open', date: '2026-05-19T12:00:00Z', localNumber: c.localId } };
    queries.push(params); return { ok: true, data: [] };
  });
  const sync = createSalesSync(options); sync.configure('store-1', { from: '2026-05-18', enabled: true, intervalMinutes: 5 });
  await sync.synchronize('store-1'); queries.length = 0;
  await sync.synchronize('store-1',{recentOnly:true});
  assert(queries.some(q => q.ini === '20260518'));
  assert(queries.some(q => q.ini === windows('2026-05-18','2026-09-21').at(-1).from.replaceAll('-','')));
  queries.length = 0;
  await sync.synchronize('store-1', { full: true });
  assert.equal(queries.length, windows('2026-05-18', '2026-09-21').length);
  for (const w of windows('2026-05-18', '2026-09-21')) assert.equal((Date.parse(w.to)-Date.parse(w.from))/86400000, 14);
});

test('all report readers use API data without double counting an old upload', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-sync-'));
  t.after(async () => {await require('../historical-control').get(uploadsRoot).idle();fs.rmSync(uploadsRoot, { recursive: true, force: true });});
  fs.mkdirSync(path.join(uploadsRoot, '.integrations/toteat-api'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '.integrations/toteat-api/credentials.json'), JSON.stringify({ 'store-1': { localId: '1', restaurantId: 'r', userId: 'u', token: 'secret' } }));
  const app = createApp({ enableLegacyTools: true, uploadsRoot, toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-21', toteatApiFetch: async url => Response.json({ ok: true, data: url.pathname.endsWith('shiftstatus') ? { status: 'closed', localNumber: 1 } : [payment()] }) });
  const dir = path.join(uploadsRoot, 'transactions/store-1'); fs.mkdirSync(dir, { recursive: true });
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 'ID de orden': 'o1', 'Fecha de creacion': '2026-09-21', 'Pago total': 99999, 'ID Producto': 'B1', Cantidad: 1, 'Precio a Pagar': 99999 }]), 'Ventas');
  XLSX.writeFile(workbook, path.join(dir, 'old.xlsx'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ fields: { sales: { files: [{ id: 'old', name: 'old.xlsx' }] } } }));
  app.locals.toteatSalesSync.configure('store-1', { from: '2026-09-14', enabled: false, intervalMinutes: 5 });
  await app.locals.toteatSalesSync.synchronize('store-1');
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transactions = await (await fetch(`${base}/api/transactions?location=store-1`)).json();
  assert.equal(transactions.files.sales.latest.origin, 'toteat-api');
  assert.equal(transactions.files['payment-details'].latest.origin, 'toteat-api');
  const report = await (await fetch(`${base}/api/reports/weekly-sales?location=store-1&includeToday=true`)).json();
  assert.equal(report.warnings.length, 0);
  assert(!JSON.stringify(report).includes('99999'));
  assert.equal((await fetch(base + transactions.files.sales.latest.previewUrl)).status, 200);
});

test('warning resolutions persist across synchronization and restart and stay scoped to the store', async t => {
  const { sync, options } = service(t, async (c, route) => ({ ok: true, data: route === 'shiftstatus'
    ? { status: 'closed', localNumber: c.localId } : [payment({ products: [] })] }));
  await sync.synchronize('store-1'); await sync.synchronize('store-2');
  assert.throws(() => sync.resolveWarning('store-1', 'missing', true), /No se encontró/);
  assert.throws(() => sync.resolveWarning('store-1', 'p1', 'true'), /inválido/);
  sync.resolveWarning('store-1', 'p1', true);
  await sync.synchronize('store-1');
  const restarted = createSalesSync(options);
  assert.equal(restarted.status('store-1').detailWarnings[0].resolved, true);
  assert.equal(restarted.status('store-2').detailWarnings[0].resolved, false);
  assert.equal(restarted.status('store-1').detailWarnings[0].total, 3430);
  restarted.resolveWarning('store-1', 'p1', false);
  assert.equal(sync.status('store-1').detailWarnings[0].resolved, false);
});

test('confirmed cancellations exclude money and products while preserving raw payment evidence', () => {
  const cancelled = payment({ paymentId: 'cancelled', total: 4800, products: [] });
  const active = payment({ paymentId: 'active', total: 4100, discounts: 0, products: [line({ payed: 4100 })] });
  const source = [cancelled, active];
  const rows = salesRows(source, { paymentClassifications: { cancelled: { cancelled: true } } });
  assert.equal(rows.sales[0]['Pago total'], 4100);
  assert.equal(rows.sales.length, 1);
  assert.equal(rows.details[0]['A Pagar'], 4800);
  assert.equal(rows.details[0]['Estado del pago'], 'Anulado');
  assert.equal(rows.details[0]['API Incluir en ventas'], false);
  assert.equal(rows.warnings[0].cancelled, true);
  assert.equal(source[0].total, 4800);
  assert.equal(salesRows([payment({ orderStatus: 'CANCELLED' })]).sales.length, 0);
  assert.equal(salesRows([payment({ cancelled: true })]).sales.length, 0);
  assert.equal(salesRows([cancelled]).sales[0]['Pago total'] + cancelled.discounts, 4800, 'missing products alone do not prove cancellation');
});

test('cancelled order with a credit note offsets the original exactly once', () => {
  const original = payment({ orderStatus: 'CANCELLED', total: 3430, discounts: 0 });
  const credit = payment({ orderStatus: 'CANCELLED', fiscalType: 'NC', paymentId: 'nc', total: -3430, discounts: 0 });
  const rows = salesRows([original, credit]);
  assert.equal(rows.sales[0]['Pago total'], 0);
  assert.equal(rows.sales.reduce((s, r) => s + r['Precio a Pagar'], 0), 0);
  assert.equal(rows.details.length, 2);
});

test('sync verifies missing-product order states, retains known cancellations on API failure and supports persistent confirmation', async t => {
  let denied = false;
  const { sync, options } = service(t, async (c, route, params) => {
    if (route === 'shiftstatus') return { ok: true, data: { status: 'closed', localNumber: c.localId } };
    if (route === 'orderstatus') {
      if (denied) throw new Error('Not Authorized');
      return { ok: true, data: { orderId: params.ic, orderStatus: 'CANCELLED' } };
    }
    return { ok: true, data: [payment({ products: [] })] };
  });
  await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').detailWarnings[0].cancelled, true);
  assert.equal(sync.status('store-1').orderCount, 0);
  assert.equal(XLSX.utils.sheet_to_json(XLSX.readFile(sync.source('store-1', 'sales')[0].filePath).Sheets['Ventas API']).length, 0);
  denied = true;
  await sync.synchronize('store-1');
  assert.equal(sync.status('store-1').detailWarnings[0].cancelled, true);
  await sync.synchronize('store-2');
  assert.match(sync.status('store-2').cancellationCheckError, /No se pudieron verificar/);
  assert.equal(sync.status('store-2').detailWarnings[0].cancelled, false);
  assert.throws(() => sync.classifyPayment('store-2', 'missing', true), /No se encontró/);
  assert.throws(() => sync.classifyPayment('store-2', 'p1', 'true'), /inválida/);
  sync.classifyPayment('store-2', 'p1', true);
  assert.equal(sync.status('store-2').detailWarnings[0].cancelled, true);
  const detailFile = sync.source('store-2', 'payment-details')[0].filePath;
  const details = XLSX.utils.sheet_to_json(XLSX.readFile(detailFile).Sheets['Detalle Pagos API']);
  assert.equal(details[0]['A Pagar'], 3430);
  assert.equal(sync.filterLegacy(detailFile, details).length, 0);
  await sync.synchronize('store-2');
  const restarted = createSalesSync(options);
  assert.equal(restarted.status('store-2').detailWarnings[0].cancelled, true);
  assert.equal(restarted.status('store-1').detailWarnings[0].cancelled, true);
  restarted.classifyPayment('store-2', 'p1', false);
  assert.equal(restarted.status('store-2').orderCount, 1);
  assert.equal(restarted.status('store-1').orderCount, 0);
});

test('a linked credit note on another order retains the original to avoid reversing twice', () => {
  const original = payment({ orderStatus: 'CANCELLED', total: 3430, discounts: 0 });
  const credit = payment({ orderId: 'credit-order', fiscalType: 'NC', paymentId: 'nc', total: -3430, discounts: 0, referencedPayment: { id: 'p1' } });
  const rows = salesRows([original, credit]);
  assert.equal(rows.sales.filter(r => r['Pago total'] !== null).reduce((s, r) => s + r['Pago total'], 0), 0);
});

test('confirmation corrects daily and network reports immediately and survives resync', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-cancel-report-'));
  t.after(async () => {await require('../historical-control').get(uploadsRoot).idle();fs.rmSync(uploadsRoot, { recursive: true, force: true });});
  fs.mkdirSync(path.join(uploadsRoot, '.integrations/toteat-api'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '.integrations/toteat-api/credentials.json'), JSON.stringify({ 'store-2': { localId: '2', restaurantId: 'r', userId: 'u', token: 'secret' } }));
  const payments = [10600, 5900, 4100, 4100, 4100, 3900, 4800].map((total, i) => payment({
    orderId: `order-${i}`, paymentId: `pay-${i}`, total, discounts: 0,
    dateOpen: '2026-10-08T11:00:00', dateClosed: '2026-10-08T11:05:00',
    products: i === 6 ? [] : [line({ payed: total, discounts: 0 })]
  }));
  const app = createApp({ uploadsRoot, enableToteatSync: false, reportToday: '2026-10-08', toteatRequestSpacing: 0,
    toteatSyncClock: () => '2026-10-08', toteatApiFetch: async url => Response.json(url.pathname.endsWith('orderstatus')
      ? { ok: false } : { ok: true, data: url.pathname.endsWith('shiftstatus') ? { status: 'closed', localNumber: 2 } : payments }) });
  app.locals.toteatSalesSync.configure('store-2', { from: '2026-10-08', enabled: false });
  await app.locals.toteatSalesSync.synchronize('store-2');
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const network = async () => (await (await fetch(`${base}/api/reports/network-sales`)).json()).rows.find(r => r.id === 'store-2').today;
  assert.equal(Math.round((await network()).sales), 31513);
  const classify = cancelled => fetch(`${base}/api/integrations/toteat/api/sales/payment-classification`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'store-2', paymentId: 'pay-6', cancelled })
  });
  assert.equal((await classify(true)).status, 200);
  assert.equal(Math.round((await network()).sales), 27479);
  assert.equal((await network()).transactions, 6);
  const weekly = await (await fetch(`${base}/api/reports/weekly-sales?location=store-2&includeToday=true`)).json();
  assert.equal(Math.round(weekly.previousDay.netSales), 27479);
  assert.equal(weekly.previousDay.grossSales, 32700);
  await app.locals.toteatSalesSync.synchronize('store-2');
  assert.equal(Math.round((await network()).sales), 27479);
  assert.equal((await classify(false)).status, 200);
  assert.equal(Math.round((await network()).sales), 31513);
});
