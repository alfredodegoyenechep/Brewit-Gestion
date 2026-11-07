const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core'), XLSX = require('xlsx');
const { setup } = require('./helpers/product-xray-fixture');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function open(page, s) {
  await page.goto(s.base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Productos en el tiempo', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('product-timeline-picker').disabled);
  await page.locator('#product-timeline-period').selectOption('custom');
  await page.locator('#product-timeline-from').fill('2026-10-01'); await page.locator('#product-timeline-to').fill('2026-10-07');
}
test('timeline UI preserves independent selections, groups sizes and uses the same points for table, chart and XLSX', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } }), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/sales/product-timeline') requests.push(new URL(request.url())); });
  await open(page, s); assert.equal(requests.length, 0);
  await page.locator('#product-timeline-mode').selectOption('products');
  await page.locator('#product-timeline-choices input[value="P0"]').check();
  await page.locator('#product-timeline-formats').check();
  assert.equal(await page.locator('#product-timeline-choices input:checked').count(), 1);
  await page.locator('#product-timeline-search').fill('P2');
  assert.equal(await page.locator('#product-timeline-choices input').count(), 1);
  assert.equal(await page.locator('#product-timeline-choices input').isChecked(), true);
  await page.locator('#product-timeline-run').click();
  await page.locator('#product-timeline-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].searchParams.get('products')).sort(), ['P0', 'P1', 'P2']);
  assert.equal(await page.locator('#product-timeline-table tbody tr').count(), 7);
  assert.equal(await page.locator('#product-timeline-table thead th').count(), 3);
  assert.match(await page.locator('#product-timeline-table tfoot tr').first().innerText(), /Total del período\s+5\s+5/);
  assert.deepEqual(await page.locator('#product-timeline-table tfoot tr').count(), 3);
  assert.match(await page.locator('#product-timeline-table tfoot tr').nth(1).innerText(), /% del total\s+100,0%\s+100,0%/);
  assert.match(await page.locator('#product-timeline-table tfoot tr').nth(2).innerText(), /% acumulado\s+100,0%\s+100,0%/);
  await page.locator('#product-timeline-presentation').selectOption('both');
  assert.equal(await page.locator('#product-timeline-chart svg').count(), 1);
  assert.equal(await page.locator('#product-timeline-chart circle').count(), 7);
  await page.locator('#product-timeline-metric').selectOption('netSales');
  assert.match(await page.locator('#product-timeline-table tfoot tr').first().innerText(), /5\.000/);
  assert.ok((await page.locator('#product-timeline-chart circle').all()).length === 7);
  assert.ok((await page.locator('#product-timeline-chart circle').nth(2).getAttribute('aria-label')).includes('3.000'));
  await page.locator('#product-timeline-workspace .product-timeline-series-picker summary').click();
  await page.locator('#product-timeline-series input').nth(1).check();
  assert.equal(await page.locator('#product-timeline-chart circle').count(), 14);
  assert.equal(requests.length, 1, 'presentation changes must never reload sales');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#product-timeline-export').click();
  const file = path.join(os.tmpdir(), `product-timeline-${Date.now()}.xlsx`); await (await downloadEvent).saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const book = XLSX.readFile(file), sales = XLSX.utils.sheet_to_json(book.Sheets['Venta neta'], { header: 1 }), units = XLSX.utils.sheet_to_json(book.Sheets.Unidades, { header: 1 });
  assert.equal(sales.at(-3).at(-1), 5000); assert.equal(units.at(-3).at(-1), 5);
  assert.equal(sales.at(-2).at(-1), 1); assert.equal(sales.at(-1).at(-1), 1);
  assert.equal(sales.slice(1, -3).reduce((sum, row) => sum + row.at(-1), 0), 5000);
  await page.getByRole('tab', { name: 'Productos y jerarquías', exact: true }).click();
  await page.getByRole('tab', { name: 'Productos en el tiempo', exact: true }).click();
  assert.equal(requests.length, 1); assert.equal(await page.locator('#product-timeline-from').inputValue(), '2026-10-01');
  await page.locator('#product-timeline-mode').selectOption('ingredients');
  await page.locator('#product-timeline-search').fill('cafe');
  await page.locator('#product-timeline-choices input[value="CAF001"]').check();
  await page.locator('#product-timeline-grain').selectOption('weekly');
  await page.locator('#product-timeline-run').click();
  await page.locator('#product-timeline-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(await page.locator('#product-timeline-table tbody tr').count(), 2);
  assert.match(await page.locator('#product-timeline-table tfoot tr').first().innerText(), /5\.000/);
  for (const width of [390, 768, 1700]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#product-timeline-workspace, #product-timeline-workspace *')]
      .filter(node => node.getBoundingClientRect().right > innerWidth && !node.closest('.product-timeline-table-wrap, .product-timeline-chart'))
      .map(node => `${node.tagName}#${node.id}.${node.className}: ${node.getBoundingClientRect().right}`));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `layout must fit width ${width}: ${overflow.join(', ')}`);
  }
  await page.locator('#product-timeline-workspace').screenshot({ path: '/private/tmp/brewit-product-timeline.png' });
  assert.deepEqual(errors, []);
});

test('timeline participation and cumulative percentages follow the selected measure across products', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await open(page, s);
  await page.locator('#product-timeline-run').click();
  await page.locator('#product-timeline-status').filter({ hasText: 'Reporte generado' }).waitFor();
  const footer = page.locator('#product-timeline-table tfoot tr');
  const cells = row => footer.nth(row).locator('td').allTextContents();
  const parse = value => Number(value.replace('%', '').replace(',', '.'));
  const verify = async () => {
    const shares = (await cells(1)).map(parse), cumulative = (await cells(2)).map(parse);
    assert.ok(shares.length > 2);
    assert.equal(shares.at(-1), 100);
    assert.equal(cumulative.at(-1), 100);
    assert.ok(shares[0] > 0 && shares[0] < 100);
    for (let index = 0; index < cumulative.length - 1; index++) {
      assert.ok(Math.abs(cumulative[index] - shares.slice(0, index + 1).reduce((sum, part) => sum + part, 0)) <= .15);
    }
    assert.equal(cumulative.at(-2), 100);
    return shares;
  };
  const unitShares = await verify();
  await page.locator('#product-timeline-metric').selectOption('netSales');
  const salesShares = await verify();
  assert.notDeepEqual(salesShares, unitShares);
});
test('timeline UI cancels outdated results, validates selections and retries server errors', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); await open(page, s);
  await page.locator('#product-timeline-mode').selectOption('ingredients');
  await page.locator('#product-timeline-run').click();
  await page.locator('#product-timeline-status').filter({ hasText: 'Selecciona al menos un ingrediente' }).waitFor();
  assert.equal(await page.locator('#product-timeline-run').isEnabled(), true);
  await page.locator('#product-timeline-mode').selectOption('product-hierarchy');
  await page.locator('#product-timeline-hierarchy').selectOption('["Barra Cafe"]');
  let release, arrived; const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => arrived = resolve);
  await page.route('**/api/sales/product-timeline?*', async route => { arrived(); await gate; await route.fulfill({ status: 500, json: { error: 'Resultado anterior' } }).catch(() => {}); });
  await page.locator('#product-timeline-run').click(); await started;
  await page.locator('#product-timeline-grain').selectOption('monthly'); release();
  assert.equal(await page.locator('#product-timeline-run').isEnabled(), true);
  await page.unroute('**/api/sales/product-timeline?*');
  await page.route('**/api/sales/product-timeline?*', route => route.fulfill({ status: 503, json: { error: 'Prueba de reintento' } }));
  await page.locator('#product-timeline-run').click(); await page.locator('#product-timeline-status').filter({ hasText: 'Prueba de reintento' }).waitFor();
  assert.equal(await page.locator('#product-timeline-run').isEnabled(), true);
  await page.unroute('**/api/sales/product-timeline?*');
  await page.locator('#product-timeline-run').click(); await page.locator('#product-timeline-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(await page.locator('#product-timeline-table tbody tr').count(), 1);
  assert.match(await page.locator('#product-timeline-table tfoot tr').first().innerText(), /5/);
  assert.deepEqual(errors, []);
});
