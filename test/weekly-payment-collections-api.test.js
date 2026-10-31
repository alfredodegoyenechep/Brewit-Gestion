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
    'TRANSACTION_DATE\tSOURCE_ID\tTRANSACTION_TYPE\tTRANSACTION_AMOUNT\tFEE_AMOUNT\tREAL_AMOUNT',
    '2026-09-21T12:00:00-03:00\tcard\tSETTLEMENT\t1100\t20\t1080',
    '2026-09-28T12:00:00-03:00\tnext\tSETTLEMENT\t1200\t20\t1180'
  ].join('\n')]), 'settlements.csv');
  const inspectionResponse = await fetch(`${base}/api/uploads/transactions/inspect?location=store-1`, { method: 'POST', body: form });
  assert.equal(inspectionResponse.status, 200);
  const inspection = await inspectionResponse.json();
  const confirmed = await fetch(`${base}/api/uploads/transactions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inspection.token, dateFrom: inspection.detectedRange.from, dateTo: inspection.detectedRange.to, confirmed: true, categoryConfirmed: true, overlapAction: 'keep' }) });
  assert.equal(confirmed.status, 200);
  const response = await fetch(`${base}/api/weekly-results?includeInventory=false&includeCurrent=true&weeks=4`);
  assert.equal(response.status, 200);
  const report = await response.json();
  const branch = week => week.locations.find(location => location.locationId === 'store-1').values;
  const week = branch(report.weeks[1]);
  assert.ok(Math.abs(week.grossSalesAfterDiscounts.amount - 1190) < 1e-8);
  assert.equal(week.mercadoPagoTips.amount, 100);
  assert.equal(week.cashTips.amount, 10);
  assert.equal(week.tips.amount, 110);
  assert.equal(week.cashCollection.amount, 200);
  assert.equal(week.mercadoPagoFee.amount, 20);
  assert.equal(week.mercadoPagoCollection.amount, 1080);
  assert.ok(Math.abs(week.mercadoPagoTheoretical.amount - 1080) < 1e-8);
  assert.ok(Math.abs(week.mercadoPagoTheoreticalBeforeFee.amount - 1100) < 1e-8);
  assert.ok(Math.abs(week.collectionDifference.amount) < 1e-8);
  assert.equal(week.collectionDifference.complete, true);
  assert.ok(Math.abs(branch(report.weeks[0]).collectionDifference.amount - 100) < 1e-8);
  assert.ok(Math.abs(report.weeks.reduce((sum, period) => sum + branch(period).grossSalesAfterDiscounts.amount, 0) - 2190) < 1e-8);
  assert.equal(report.weeks.reduce((sum, period) => sum + branch(period).mercadoPagoCollection.amount, 0), 2260);
  const otherStore = report.weeks[1].locations.find(location => location.locationId === 'store-2').values;
  assert.equal(otherStore.cashCollection.amount, null);
  assert.equal(otherStore.collectionDifference.complete, false);
  const current = report.weeks[0].locations.find(location => location.locationId === 'store-1');
  const balanced = report.weeks[1].locations.find(location => location.locationId === 'store-1');
  assert.ok(current.detailReports.collectionDifference);
  assert.ok(balanced.detailReports.collectionDifference, 'balanced periods expose the same analysis');
  const balancedAnalysis = await fetch(`${base}/api/weekly-results/details/${balanced.detailReports.collectionDifference}`).then(r => r.json());
  assert.ok(Math.abs(balancedAnalysis.total) < 1e-8);
  assert.equal(balancedAnalysis.totals.reconciled, true);
  const dailyResponse = await fetch(`${base}/api/weekly-results/daily/stream?includeCurrent=true&weeks=4&date=2026-09-28&from=2026-09-21&location=store-1`);
  assert.equal(dailyResponse.status, 200);
  const dailyEvents = (await dailyResponse.text()).trim().split('\n').map(line => JSON.parse(line));
  const daily = dailyEvents.find(event => event.type === 'result').data;
  const day = daily.days.find(day => day.date === '2026-09-21');
  assert.ok(day.detailReports.collectionDifference);
  const dayAnalysis = await fetch(`${base}/api/weekly-results/details/${day.detailReports.collectionDifference}`).then(r => r.json());
  assert.deepEqual(dayAnalysis.period, { from: '2026-09-21', through: '2026-09-21' });
  assert.equal(dayAnalysis.total, day.values.collectionDifference.amount);
  assert.equal(dayAnalysis.totals.reconciled, true);
  assert.ok(dayAnalysis.rows.some(row => row.paymentId === 'card'));
  assert.ok(dayAnalysis.rows.every(row => row.paymentId !== 'next' && row.mpId !== 'next'));
  assert.ok(dayAnalysis.rows.every(row => (row.toteatTime || row.mpTime).startsWith('2026-09-21')));
  const analysisResponse = await fetch(`${base}/api/weekly-results/details/${current.detailReports.collectionDifference}`);
  const analysis = await analysisResponse.json();
  assert.equal(analysisResponse.status, 200);
  assert.equal(analysis.total, current.values.collectionDifference.amount);
  assert.equal(analysis.totals.reconciled, true);
  assert.equal(analysis.totals.exceptionTotal, 100);
  assert.equal(analysis.exceptions.reduce((sum, row) => sum + row.amount, 0), 100);
  assert.deepEqual(analysis.period, { from: '2026-09-28', through: '2026-09-28' });
  assert.ok(analysis.rows.some(row => row.mpId === 'next'));
  assert.ok(analysis.rows.some(row => row.paymentId === 'next'));
  // Opening the detail always returns the reviewed snapshot, even after sources change.
  app.locals.toteatSalesSync.get = () => { throw Error('The saved analysis must not reload payment sources'); };
  assert.deepEqual(await fetch(`${base}/api/weekly-results/details/${current.detailReports.collectionDifference}`).then(r => r.json()), analysis);
});
