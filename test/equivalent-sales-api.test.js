const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require('../server');
const { addDays } = require('../network-sales');

test('classic, grid and intraday share eight exact weekdays, the Santiago cutoff and scheduled zero-sale days', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-equivalent-sales-'));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', reportToday: '2026-10-14', reportCutoff: '10:30:00' });
  const config = path.join(root, 'config', 'locations.json');
  const stores = [{ id: 'store-1', name: 'La Concepción', type: 'store', status: 'active', operatingWeekdays: [1, 2, 3, 4, 5], openingDate: '2026-07-01' }];
  fs.writeFileSync(config, JSON.stringify({ locations: stores }));
  const rows = [['ID de orden', 'Fecha de creacion', 'Hora de creacion', 'Pago total', 'Descuentos']];
  const sale = (date, time, amount) => rows.push([`${date}-${time}`, date, time, amount * 1.19, 0]);
  sale('2026-08-12', '08:00:00', 10000); // Must not backfill the zero Wednesday.
  for (let week = 1; week <= 8; week++) {
    const date = addDays('2026-10-14', -week * 7);
    if (date !== '2026-09-09') { sale(date, '09:00:00', 100); sale(date, '18:00:00', 900); }
    const tuesday = addDays('2026-10-13', -week * 7);
    sale(tuesday, '09:00:00', 40); sale(tuesday, '18:00:00', 160);
  }
  sale('2026-10-13', '09:00:00', 100); sale('2026-10-13', '18:00:00', 300);
  sale('2026-10-14', '09:00:00', 50); sale('2026-10-14', '12:00:00', 1000);
  const file = path.join(root, 'sales.csv'); fs.writeFileSync(file, rows.map(row => row.join('\t')).join('\n'));
  app.locals.toteatSalesSync.source = () => [{ filePath: file, excludedRanges: [], record: { originalName: 'sales.csv', confirmedRange: { from: '2026-08-12', to: '2026-10-14' } } }];
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = url => fetch(`${base}${url}`).then(response => { assert.equal(response.status, 200); return response.json(); });
  const [classic, grid, yesterday] = await Promise.all([
    read('/api/reports/weekly-sales?location=store-1&includeToday=true'), read('/api/reports/network-sales'), read('/api/reports/weekly-sales?location=store-1')
  ]);
  const row = grid.rows[0];
  assert.equal(row.today.sales, 50);
  assert.equal(classic.previousDay.netSales, 50);
  assert.equal(classic.intraday.today.netSales, 50);
  assert.equal(classic.previousDay.sameWeekdayAverage, 87.5);
  assert.equal(row.today.equivalentDays.average, 87.5);
  assert.equal(classic.intraday.today.sameWeekdayAverage, 87.5);
  assert.equal(classic.previousDay.comparisonToAveragePercent, row.today.vsEquivalentDays);
  assert.equal(classic.intraday.today.comparisonToAveragePercent, row.today.vsEquivalentDays);
  assert.equal(classic.intraday.today.cutoffTime, grid.cutoff);
  assert.deepEqual(classic.previousDay.equivalentDays, row.today.equivalentDays);
  assert.equal(classic.previousDay.equivalentDays.samples.find(sample => sample.date === '2026-09-09').sales, 0);
  assert.equal(classic.previousDay.equivalentDays.dates.includes('2026-08-12'), false);
  assert.equal(yesterday.previousDay.sameWeekdayAverage, 200);
  assert.equal(yesterday.previousDay.netSales, 400);
  assert.equal(yesterday.previousDay.comparisonToAveragePercent, row.yesterday.vsEquivalentDays);
  assert.equal(yesterday.intraday.today.comparisonToAveragePercent, row.yesterday.vsEquivalentDays);
  assert.equal(yesterday.intraday.today.cutoffTime, '23:59:59');

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) {
    const browser = await require('playwright-core').chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(() => document.getElementById('report-weekday-average').textContent === '$88');
      assert.match(await page.locator('#report-average-comparison').innerText(), /8 días equivalentes: -42,9%/);
      assert.equal(await page.locator('#intraday-average-comparison').innerText(), '-42,9%');
      assert.match(await page.locator('#report-weekday-label').innerText(), /8 de 8 días · Corte 10:30/);
      assert.match(await page.locator('#report-weekday-label').getAttribute('title'), /09 sept 2026/);
      let reportReads = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports/weekly-sales') reportReads++; });
      const indicators = await page.locator('#intraday-indicators').innerText();
      assert.equal(await page.locator('#intraday-sales-body tr').count(), 7);
      await page.getByRole('button', { name: '1 hora', exact: true }).click();
      assert.equal(await page.locator('#intraday-sales-body tr').count(), 14);
      assert.deepEqual(await page.locator('#intraday-sales-body tr td:first-child').allTextContents().then(labels => labels.slice(-2)), ['19:00–20:00', '20:00–cierre']);
      assert.equal(await page.locator('#intraday-sales-body tr').first().locator('td').first().innerText(), '07:00–08:00');
      assert.equal(await page.locator('#intraday-sales-body tr').nth(1).locator('td').nth(1).innerText(), '$0');
      assert.equal(await page.locator('#intraday-sales-body tr').nth(2).locator('td').nth(1).innerText(), '$50');
      assert.equal(await page.locator('#intraday-sales-body tr').nth(2).locator('td').nth(2).innerText(), '$10.000');
      assert.equal(await page.locator('#intraday-indicators').innerText(), indicators);
      assert.equal(await page.getByRole('button', { name: '1 hora', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.locator('[data-report-chart="report-intraday"]').click();
      assert.equal(await page.locator('#report-chart-data-body tr').count(), 14);
      assert.match(await page.locator('#report-chart-subtitle').innerText(), /tramos de 1 hora/);
      await page.locator('#report-chart-close').click();
      await page.getByRole('button', { name: '2 horas', exact: true }).click();
      assert.equal(await page.locator('#intraday-sales-body tr').count(), 7);
      assert.equal(await page.locator('#intraday-sales-body tr').first().locator('td').first().innerText(), '07:00–09:00');
      assert.equal(await page.locator('#intraday-sales-body tr').nth(1).locator('td').nth(1).innerText(), '$50');
      assert.equal(reportReads, 0);
      await page.getByRole('button', { name: '1 hora', exact: true }).click();
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#intraday-sales-body tr').length === 14);
      assert.equal(await page.getByRole('button', { name: '1 hora', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '2 horas', exact: true }).click();
      await page.locator('[data-report-chart="report-summary-equivalent"]').click();
      assert.equal(await page.locator('#report-chart-data-body tr').count(), 8);
      assert.match(await page.locator('#report-chart-subtitle').innerText(), /Corte 10:30/);
      await page.locator('#report-chart-close').click();
      await page.locator('#report-view-filter').selectOption('grid');
      await page.waitForFunction(() => document.querySelector('#network-sales-rows td:nth-child(8)')?.textContent === '-42,9%');
      const headings = await page.locator('#network-sales-metric-headings th').allTextContents();
      assert.equal(headings.filter(label => label === 'Transacciones').length, 6);
      headings.forEach((label, index) => { if (label === 'Ticket con IVA') assert.equal(headings[index - 1], 'Transacciones'); });
      assert.equal(await page.locator('#network-sales-rows tr').first().locator('td').nth(3).innerText(), '1');
      assert.equal(await page.locator('#network-sales-rows tr').first().locator('td').nth(10).innerText(), '2');
      assert.equal(await page.locator('#network-sales-total td').nth(3).innerText(), '1');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }

  // Without an operating calendar, an unobserved date stays missing and does
  // not become zero or get replaced with an older equivalent weekday.
  stores[0].operatingWeekdays = []; fs.writeFileSync(config, JSON.stringify({ locations: stores }));
  const sparse = await read('/api/reports/weekly-sales?location=store-1&includeToday=true');
  const sparseGrid = await read('/api/reports/network-sales');
  assert.equal(sparse.previousDay.sameWeekdayAverage, null);
  assert.equal(sparse.previousDay.averageSampleSize, 7);
  assert.equal(sparse.previousDay.comparisonToAveragePercent, null);
  assert.equal(sparse.intraday.today.comparisonToAveragePercent, null);
  assert.equal(sparseGrid.rows[0].today.vsEquivalentDays, null);
  assert.deepEqual(sparse.previousDay.equivalentDays, sparseGrid.rows[0].today.equivalentDays);
  const noReference = [...rows.filter(row => row[1] !== '2026-10-14'), ['zero-replaced', '2026-09-09', '09:00:00', 119, 0]];
  fs.writeFileSync(file, noReference.map(row => row.join('\t')).join('\n'));
  const absent = await read('/api/reports/weekly-sales?location=store-1&includeToday=true');
  const absentGrid = await read('/api/reports/network-sales');
  assert.equal(absent.previousDay.sameWeekdayAverage, 100);
  assert.equal(absent.previousDay.equivalentDays.complete, true);
  assert.equal(absent.previousDay.equivalentDays.referenceAvailable, false);
  assert.equal(absent.previousDay.comparisonToAveragePercent, null);
  assert.equal(absent.intraday.today.comparisonToAveragePercent, null);
  assert.equal(absent.intraday.today.generalRank.position, null);
  assert.equal(absentGrid.rows[0].today.vsEquivalentDays, null);
});
