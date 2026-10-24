const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { buildSalesProjection, applyClosures, applyReferenceDays } = require('../sales-projection');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const today = '2026-10-24';
const stores = [{ id: 'store-1', name: 'Café Norte', type: 'store', status: 'active' },
  { id: 'store-2', name: 'Café Sur', type: 'store', status: 'active' }];
const sale = (date, netSales, locationId = 'store-1') => ({ date, netSales, locationId });
const saturdays = [sale('2026-10-17', 150), sale('2026-10-17', -150), sale('2026-10-10', 100),
  sale('2026-10-03', 200), sale('2026-09-26', 300), sale('2026-09-19', 400), sale('2026-09-12', 99999),
  sale(today, 999999), sale('2026-11-07', 999999)];

test('uses a fixed window of equivalent dates, skips zeros within it and never feeds projections back into history', () => {
  const report = buildSalesProjection({ stores: [stores[0]], dailySales: saturdays, today });
  assert.deepEqual(report.baselines['store-1'][6].samples.slice(0, 4).map(item => item.date), ['2026-10-17', '2026-10-10', '2026-10-03', '2026-09-26']);
  assert.equal(report.baselines['store-1'][6].average, 200);
  assert.equal(report.baselines['store-1'][6].usedSamples.length, 3);
  assert.equal(report.months[0].days.find(day => day.date === today).includedForecast, 200);
  assert.equal(report.months[1].days.find(day => day.date === '2026-11-07').includedForecast, 200);
  assert.equal(report.months[0].realAccumulated, 300);
  assert.equal(report.months[0].projectedTotal, 700);
  assert.equal(report.months[1].realAccumulated, 0);
  assert.equal(report.months[1].projectedTotal, 800);
  assert.equal(report.months[0].missingDays, undefined);
  assert.equal(report.months[0].days.find(day => day.date === '2026-10-17').actualSales, 0);
});

test('averages available positive values, keeps past actuals, and excludes only the closed locations', () => {
  const second = saturdays.filter(day => day.date < today && day.netSales > 0).map(day => ({ ...day, netSales: 50, locationId: 'store-2' }));
  const report = buildSalesProjection({ stores, dailySales: [...saturdays, ...second], today });
  const closed = applyClosures(report, { locations: { 'store-1': ['2026-10-10', '2026-10-31'] } });
  const day = closed.months[0].days.find(day => day.date === '2026-10-31');
  assert.equal(day.forecast, 250);
  assert.equal(day.includedForecast, 50);
  assert.equal(day.excludedForecast, 200);
  assert.equal(day.closedAll, false);
  assert.equal(closed.months[0].realAccumulated, report.months[0].realAccumulated);
  assert.equal(closed.months[0].projectedTotal, report.months[0].projectedTotal - 200);
  const both = applyClosures(report, { locations: Object.fromEntries(stores.map(store => [store.id, ['2026-10-31']])) });
  assert.equal(both.months[0].days.find(day => day.date === '2026-10-31').includedForecast, 0);
  assert.equal(both.months[0].days.find(day => day.date === '2026-10-31').closedAll, true);
  assert.equal(applyClosures(both, { locations: {} }).months[0].projectedTotal, report.months[0].projectedTotal);
  const insufficient = buildSalesProjection({ stores: [stores[0]], dailySales: saturdays.slice(2, 5), today });
  assert.equal(insufficient.baselines['store-1'][6].average, 200);
  assert.equal(insufficient.months[0].days.find(day => day.date === today).complete, undefined);
});

test('switches between 2, 4, 6 and 8 calendar references without replacing zero dates with older positive sales', () => {
  const report = buildSalesProjection({ stores: [stores[0]], dailySales: [...saturdays, sale('2026-09-05', 800), sale('2026-08-29', -900)], today });
  const two = applyReferenceDays(report, 2);
  assert.equal(two.baselines['store-1'][6].average, 100);
  assert.equal(two.baselines['store-1'][6].usedSamples.length, 1);
  const six = applyReferenceDays(report, 6);
  const eight = applyReferenceDays(six, 8);
  assert.equal(six.baselines['store-1'][6].average, 100999 / 5);
  assert.equal(eight.baselines['store-1'][6].average, 101799 / 6);
  assert.equal(applyReferenceDays(eight, 4).months[0].projectedTotal, report.months[0].projectedTotal);
  assert.equal(eight.baselines['store-1'][0].average, 0);
  assert.equal(eight.months[0].days.find(day => day.date === '2026-10-25').includedForecast, 0);
  assert.throws(() => applyReferenceDays(report, 5), RangeError);
  const closed = applyClosures(report, { locations: { 'store-1': [today] } });
  assert.equal(applyReferenceDays(closed, 8).months[0].days.find(day => day.date === today).includedForecast, 0);
});

test('compares matching elapsed dates and real closes, then compares next month against the current projected close', () => {
  const dailySales = [sale('2026-02-01', 100), sale('2026-02-28', 200), sale('2026-03-01', 450)];
  const report = buildSalesProjection({ stores: [stores[0]], dailySales, today: '2026-03-31' });
  const [current, next] = report.months;
  assert.equal(current.previousPeriodTo, '2026-02-28');
  assert.equal(current.previousPeriodSales, 300);
  assert.equal(current.realVariationPercent, 50);
  assert.equal(current.projectedComparisonValue, 300);
  assert.equal(current.projectedVariationPercent, 50);
  assert.equal(current.projectedComparisonIsForecast, false);
  assert.equal(next.projectedComparisonValue, current.projectedTotal);
  assert.equal(next.projectedComparisonIsForecast, true);
  assert.equal(next.realVariationPercent, null);
  const empty = buildSalesProjection({ stores: [stores[0]], dailySales: [], today });
  assert.equal(empty.months[0].projectedTotal, 0);
  assert.equal(empty.months[0].projectedVariationPercent, null);
  assert.equal(empty.months[0].realVariationPercent, null);
});

test('builds true month boundaries across New Year, leap February and Santiago clock changes', () => {
  for (const [date, keys, lengths] of [
    ['2026-12-31', ['2026-12', '2027-01'], [31, 31]],
    ['2028-02-01', ['2028-02', '2028-03'], [29, 31]],
    ['2026-09-06', ['2026-09', '2026-10'], [30, 31]]
  ]) {
    const report = buildSalesProjection({ stores: [], dailySales: [], today: date });
    assert.deepEqual(report.months.map(month => month.key), keys);
    assert.deepEqual(report.months.map(month => month.days.length), lengths);
    assert.equal(report.months[0].days.filter(day => day.date === date).length, 1);
  }
});

async function setup(t, { variedHistory = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-sales-projection-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', enableToteatSync: false, reportToday: today });
  fs.writeFileSync(path.join(root, 'config', 'locations.json'), JSON.stringify({ locations: stores }));
  for (const [index, store] of stores.entries()) {
    const rows = [['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos']];
    for (let time = Date.parse('2026-08-01T12:00:00Z'); time < Date.parse(`${today}T12:00:00Z`); time += 86400000) {
      const date = new Date(time).toISOString().slice(0, 10);
      let gross = (index + 1) * 1190;
      if (variedHistory && new Date(time).getUTCDay() === 0) gross = 0;
      if (variedHistory && index === 0 && date === '2026-09-12') gross = 5950;
      rows.push([`${store.id}-${date}`, date, '12:00:00', gross, 0]);
    }
    rows.push([...rows.at(-1)]); // Repeated rows must not inflate the real sale.
    rows.push([`${store.id}-today`, today, '09:00:00', 119000000, 0]);
    rows.push([`${store.id}-future`, '2026-11-07', '09:00:00', 119000000, 0]);
    fs.writeFileSync(path.join(root, `${store.id}.csv`), rows.map(row => row.join('\t')).join('\n'));
  }
  app.locals.toteatSalesSync.source = id => [{ filePath: path.join(root, `${id}.csv`), excludedRanges: [], record: {} }];
  app.locals.toteatStockSync.current = () => { throw Error('Sales projections must not calculate inventory'); };
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async url => { const response = await fetch(base + url); assert.equal(response.status, 200); return response.json(); };
  const save = body => fetch(base + '/api/reports/sales-projection/closures', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { root, app, base, read, save };
}

test('API shares real net sales with the monthly report, validates closures and persists them independently by location', async t => {
  const { root, base, read, save } = await setup(t);
  const report = await read('/api/reports/sales-projection?location=all');
  assert.equal(report.months[0].realAccumulated, 69000);
  assert.equal(report.months[0].projectedTotal, 93000);
  assert.equal(report.referenceDays, 4);
  assert.equal(report.months[0].realVariationPercent, 0);
  assert.ok(Math.abs(report.months[0].projectedVariationPercent - 100 / 30) < 1e-10);
  assert.equal(report.months[1].projectedComparisonValue, 93000);
  assert.ok(Math.abs(report.months[1].projectedVariationPercent - (-3000 / 93000 * 100)) < 1e-10);
  assert.equal(report.months[1].realVariationPercent, null);
  assert.equal(report.months[1].projectedTotal, 90000);
  const weekly = await read('/api/reports/weekly-sales?location=all&includeToday=false');
  assert.equal(weekly.month.netSales, report.months[0].realAccumulated);
  assert.equal(weekly.salesProjection.months[0].projectedTotal, 93000);
  assert.equal((await read('/api/reports/sales-projection?location=store-1')).months[0].projectedTotal, 31000);
  assert.equal((await save({ locationIds: ['store-1'], date: '2026-10-31', closed: true })).status, 200);
  const closedReport = await read('/api/reports/sales-projection?location=all');
  assert.equal(closedReport.months[0].projectedTotal, 92000);
  assert.equal(closedReport.months[1].projectedComparisonValue, 92000);
  for (const days of [2, 6, 8]) assert.equal((await read(`/api/reports/sales-projection?location=all&referenceDays=${days}`)).referenceDays, days);
  assert.equal((await fetch(`${base}/api/reports/sales-projection?referenceDays=5`)).status, 400);
  for (const body of [
    { locationIds: ['store-2'], date: '2026-10-23', closed: true },
    { locationIds: ['store-1', 'unknown'], date: '2026-10-31', closed: true },
    { locationIds: ['store-1'], date: '2027-02-30', closed: true },
    { locationIds: ['store-1'], date: '2026-10-31', closed: 'false' }
  ]) assert.equal((await save(body)).status, 400);
  const file = path.join(root, 'config', 'sales-projection-closures.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).locations, { 'store-1': ['2026-10-31'] });
  assert.equal((await save({ locationIds: stores.map(store => store.id), date: '2026-11-01', closed: true })).status, 200);
  const freshApp = createApp({ uploadsRoot: root, sourceMode: 'legacy', enableToteatSync: false, reportToday: today });
  const freshServer = freshApp.listen(0, '127.0.0.1'); await new Promise(resolve => freshServer.once('listening', resolve));
  try {
    const saved = await (await fetch(`http://127.0.0.1:${freshServer.address().port}/api/reports/sales-projection/closures`)).json();
    assert.deepEqual(saved.locations['store-1'], ['2026-10-31', '2026-11-01']);
    assert.deepEqual(saved.locations['store-2'], ['2026-11-01']);
  } finally { freshServer.closeAllConnections(); await new Promise(resolve => freshServer.close(resolve)); }
  assert.equal((await save({ locationIds: ['store-1'], date: '2026-10-31', closed: false })).status, 200);
  assert.deepEqual((await read('/api/reports/sales-projection/closures')).locations['store-1'], ['2026-11-01']);
});

test('UI shows two calendars, real and projected monthly totals, and restores saved closures without rereading sales', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => typeof window.BrewitSalesProjection === 'object' && Object.keys(locationRegistry).length > 0);
  await page.evaluate(() => loadWeeklySalesReport());
  let projectionReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports/sales-projection') projectionReads++; });
  await page.locator('#open-sales-projection').click();
  await page.waitForFunction(() => !document.getElementById('sales-projection-edit-closures').disabled);
  assert.equal(await page.locator('.sales-projection-calendar').count(), 2);
  assert.deepEqual(await page.locator('.sales-projection-total-value').allTextContents(), ['$69.000', '$93.000', '$0', '$90.000']);
  assert.deepEqual(await page.locator('.sales-projection-variation').allTextContents(), ['0,0%', '+3,3%', '—', '-3,2%']);
  for (const days of ['2', '6', '8']) {
    await page.locator('#sales-projection-reference-days').selectOption(days);
    assert.match(await page.locator('#sales-projection-method').innerText(), new RegExp(`últimas ${days} fechas`));
  }
  assert.doesNotMatch(await page.locator('#sales-projection-results').innerText(), /parcial|Sin 4 referencias/i);
  assert.equal(await page.locator('[data-date="2026-10-23"] .sales-projection-real').count(), 1);
  assert.equal(await page.locator('[data-date="2026-10-23"] button').count(), 0);
  assert.equal(await page.locator(`[data-date="${today}"] .sales-projection-day-value`).innerText(), '$3.000');
  const [left, right] = await page.locator('.sales-projection-calendar').evaluateAll(tables => tables.map(table => ({ x: table.getBoundingClientRect().left, y: table.getBoundingClientRect().top })));
  assert.ok(right.x > left.x); assert.ok(Math.abs(left.y - right.y) < 1);
  await page.locator('#sales-projection-edit-closures').click();
  await page.locator(`button[data-projection-date="${today}"]`).click();
  await page.waitForFunction(() => document.getElementById('sales-projection-status').textContent.includes('Cierre guardado'));
  assert.equal(await page.locator(`[data-date="${today}"] .is-closed`).count(), 1);
  assert.equal(await page.locator('.sales-projection-total-value').nth(1).innerText(), '$90.000');
  assert.equal(await page.locator('[data-variation="projected"]').nth(1).innerText(), '0,0%');
  await page.locator('#sales-projection-closure-location').selectOption('store-1');
  await page.locator('button[data-projection-date="2026-11-01"]').click();
  await page.waitForFunction(() => document.getElementById('sales-projection-status').textContent.includes('Cierre guardado'));
  assert.equal(await page.locator('[data-date="2026-11-01"] .sales-projection-day-value').innerText(), '$2.000');
  assert.equal(await page.locator('[data-date="2026-11-01"] s').innerText(), 'Cierre: $1.000');
  assert.equal(await page.locator('.sales-projection-total-value').nth(3).innerText(), '$89.000');
  await page.locator('#close-sales-projection').click();
  await page.locator('#open-sales-projection').click();
  await page.waitForFunction(() => !document.getElementById('sales-projection-edit-closures').disabled);
  assert.equal(await page.locator(`[data-date="${today}"] .is-closed`).count(), 1);
  assert.equal(projectionReads, 0);
  await page.screenshot({ path: '/private/tmp/brewit-sales-projection.png' });
  await page.reload();
  await page.waitForFunction(() => typeof window.BrewitSalesProjection === 'object' && Object.keys(locationRegistry).length > 0);
  await page.locator('#open-sales-projection').click();
  await page.waitForFunction(() => !document.getElementById('sales-projection-edit-closures').disabled);
  assert.equal(await page.locator('#sales-projection-reference-days').inputValue(), '8');
  assert.equal(await page.locator(`[data-date="${today}"] .is-closed`).count(), 1);
  await page.locator('#sales-projection-edit-closures').click();
  await page.locator('#sales-projection-closure-location').selectOption('all');
  await page.locator(`button[data-projection-date="${today}"]`).click();
  await page.waitForFunction(() => document.getElementById('sales-projection-status').textContent.includes('Cierre quitado'));
  assert.equal(await page.locator('.sales-projection-total-value').nth(1).innerText(), '$93.000');
  await page.setViewportSize({ width: 800, height: 1000 });
  const positions = await page.locator('.sales-projection-calendar').evaluateAll(tables => tables.map(table => table.getBoundingClientRect().top));
  assert.ok(positions[1] > positions[0]);
  assert.deepEqual(errors, []);
});

test('UI changes the forecast from cached history when selecting 6 or 8 days and displays zero-sale Sundays as $0', { skip: !fs.existsSync(chrome) }, async t => {
  const { base } = await setup(t, { variedHistory: true });
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof window.BrewitSalesProjection === 'object' && Object.keys(locationRegistry).length > 0);
  await page.evaluate(() => loadWeeklySalesReport());
  let salesReads = 0;
  page.on('request', request => { if (/\/api\/reports\/(weekly-sales|sales-projection)$/.test(new URL(request.url()).pathname)) salesReads++; });
  await page.locator('#open-sales-projection').click();
  await page.waitForFunction(() => !document.getElementById('sales-projection-reference-days').disabled);
  assert.equal(await page.locator(`[data-date="${today}"] .sales-projection-day-value`).innerText(), '$3.000');
  assert.equal(await page.locator('[data-date="2026-10-25"] .sales-projection-day-value').innerText(), '$0');
  await page.locator('#sales-projection-reference-days').selectOption('6');
  assert.equal(await page.locator(`[data-date="${today}"] .sales-projection-day-value`).innerText(), '$3.667');
  assert.equal(await page.locator('.sales-projection-total-value').nth(1).innerText(), '$82.333');
  await page.locator('#sales-projection-reference-days').selectOption('8');
  assert.equal(await page.locator(`[data-date="${today}"] .sales-projection-day-value`).innerText(), '$3.500');
  assert.equal(await page.locator('.sales-projection-total-value').nth(1).innerText(), '$82.000');
  await page.locator('#sales-projection-reference-days').selectOption('4');
  assert.equal(await page.locator('.sales-projection-total-value').nth(1).innerText(), '$81.000');
  assert.equal(salesReads, 0);
  assert.doesNotMatch(await page.locator('#sales-projection-results').innerText(), /parcial|Sin 4 referencias/i);
});
