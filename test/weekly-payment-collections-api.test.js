const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../server');

test('weekly API reconciles synced TotEat payments and MercadoPago in the same local weeks', async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-weekly-payments-'));
  t.after(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
  const apiRoot = path.join(uploadsRoot, '.integrations', 'toteat-api');
  fs.mkdirSync(apiRoot, { recursive: true });
  fs.writeFileSync(path.join(apiRoot, 'credentials.json'), JSON.stringify({
    'store-1': { localId: '1', restaurantId: 'test', userId: 'test', token: 'fixture' }
  }));
  const payment = (id, date, total, discounts, gratuity, change, form) => ({
    orderId: id, paymentId: id, dateOpen: date, dateClosed: date,
    total, discounts, taxes: 0, gratuity, change, payed: form.amount, fiscalType: 'BE',
    products: [{ id: 'P1', lineId: id, quantity: 1, payed: total, discounts, taxes: 0 }],
    paymentForms: [form]
  });
  const payments = [
    payment('card', '2026-09-21T12:00:00', 1000, -200, 100, 0, { id: 5008, name: 'DEBIT_CARD', amount: 1100, tip: 100 }),
    payment('cash', '2026-09-21T13:00:00', 190, 0, 10, 300, { id: 1000, name: 'CASH', amount: 500, tip: 10 }),
    payment('next', '2026-09-28T12:00:00', 1000, 0, 100, 0, { id: 5008, name: 'CREDIT_CARD', amount: 1100, tip: 100 })
  ];
  const app = createApp({ enableLegacyTools: true, uploadsRoot, reportToday: '2026-09-28',
    toteatRequestSpacing: 0, toteatSyncClock: () => '2026-09-28',
    toteatApiFetch: async url => Response.json({ ok: true, data: url.pathname.endsWith('shiftstatus') ? { status: 'closed', localNumber: 1 } : payments })
  });
  app.locals.toteatSalesSync.configure('store-1', { from: '2026-08-31', enabled: false, intervalMinutes: 5 });
  await app.locals.toteatSalesSync.synchronize('store-1');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = new FormData();
  form.append('mercadopago', new Blob([[
    'TRANSACTION_DATE\tSOURCE_ID\tTRANSACTION_TYPE\tTRANSACTION_AMOUNT',
    '2026-09-21T12:00:00-03:00\tcard\tSETTLEMENT\t1100',
    '2026-09-28T12:00:00-03:00\tnext\tSETTLEMENT\t1200'
  ].join('\n')]), 'settlements.csv');
  const inspectionResponse = await fetch(`${base}/api/uploads/transactions/inspect?location=store-1`, { method: 'POST', body: form });
  assert.equal(inspectionResponse.status, 200);
  const inspection = await inspectionResponse.json();
  const confirmed = await fetch(`${base}/api/uploads/transactions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inspection.token, dateFrom: inspection.detectedRange.from, dateTo: inspection.detectedRange.to, confirmed: true, categoryConfirmed: true, overlapAction: 'keep' }) });
  assert.equal(confirmed.status, 200);
  const response = await fetch(`${base}/api/financial-results/weekly?location=store-1`);
  assert.equal(response.status, 200);
  const report = await response.json();
  const week = report.weeks[3].values;
  assert.equal(week.grossSales.amount, 1190);
  assert.equal(week.mercadoPagoTips.amount, 100);
  assert.equal(week.cashSales.amount, 190);
  assert.equal(week.mercadoPagoNet.amount, 1000);
  assert.equal(week.mercadoPagoDifference.amount, -190);
  assert.equal(week.collectedSales.amount, 1190);
  assert.equal(week.collectionDifference.amount, 0);
  assert.equal(week.collectionDifference.complete, true);
  assert.equal(report.weeks[4].values.collectionDifference.amount, 100);
  assert.equal(report.total.grossSales.amount, 2190);
  assert.equal(report.total.mercadoPagoCollection.amount, 2300);
  assert.equal(report.total.mercadoPagoCollection.available, true);
  assert.equal(report.total.mercadoPagoTips.amount, 200);
  assert.equal(report.total.cashSales.amount, 190);
  const otherStore = await fetch(`${base}/api/financial-results/weekly?location=store-2`).then(response => response.json());
  assert.equal(otherStore.total.cashSales.available, false);
  assert.equal(otherStore.total.collectionDifference.complete, false);
});
