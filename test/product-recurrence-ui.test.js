const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { setup } = require('./helpers/recurrence-fixture');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const orders = [
  { orderKey: 'coffee', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T10:00:00', paymentPaid: 20, netSales: 1000,
    lines: [{ code: 'P1', name: 'Café', quantity: 2, netSales: 1000, categoryPath: ['Barra Cafe', 'Calientes'] }] },
  { orderKey: 'retail', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T13:00:00', paymentPaid: 100, netSales: 2000,
    lines: [{ code: 'P2', name: 'Sandwich', quantity: 1, netSales: 2000, categoryPath: ['Retail', 'Sandwiches'] }] }
];
test('product recurrence UI: manual generation, product selection, hierarchy levels, export, independent tabs and mobile layout', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t, false, orders);
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } }), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { const url = new URL(req.url()); if (url.pathname === '/api/sales/product-recurrence') requests.push(url); });
  await page.goto(s.base); await page.waitForFunction(() => document.querySelector('#product-recurrence-location option[value="store-1"]'));
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  const tabs = await page.locator('#sales-workspace > .workspace-tabs > button').allTextContents();
  assert.deepEqual(tabs.slice(-4), ['Clientes recurrentes', 'Producto-Recurrencia', 'Producto-Género', 'X-ray producto']);
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('product-recurrence-hierarchy').options.length === 5);
  assert.equal(requests.length, 0);
  await page.locator('#product-recurrence-location').selectOption('store-1');
  await page.locator('#product-recurrence-period').selectOption('custom');
  await page.locator('#product-recurrence-from').fill('2026-10-01'); await page.locator('#product-recurrence-to').fill('2026-10-07');
  await page.locator('#product-recurrence-group').selectOption('product');
  await page.locator('#product-recurrence-products input[value="P1"]').check();
  await page.locator('#product-recurrence-search').fill('sand');
  assert.equal(await page.locator('#product-recurrence-products input').count(), 1);
  assert.match(await page.locator('#product-recurrence-selection-count').innerText(), /1 producto/);
  assert.equal(requests.length, 0);
  await page.locator('#product-recurrence-filters [type=submit]').click();
  await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0].searchParams.get('products'), '["P1"]');
  assert.equal(await page.locator('.product-recurrence-table tbody tr').count(), 1);
  assert.match(await page.locator('.product-recurrence-table tbody tr').innerText(), /Café.*1\.000.*100,0%/s);
  assert.match(await page.locator('#product-recurrence-context').innerText(), /Tienda 1.*01 oct 2026.*07 oct 2026/);
  await page.getByRole('tab', { name: 'Clientes recurrentes', exact: true }).click();
  assert.equal(await page.locator('#product-recurrence-workspace').isVisible(), false);
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click(); assert.equal(requests.length, 1);
  assert.equal(await page.locator('#product-recurrence-from').inputValue(), '2026-10-01');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#product-recurrence-export').click();
  const download = await downloadEvent, file = path.join(os.tmpdir(), `product-recurrence-${Date.now()}.xlsx`);
  await download.saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const book = XLSX.readFile(file), rows = XLSX.utils.sheet_to_json(book.Sheets['Producto-Recurrencia']);
  assert.equal(rows[0]['Venta neta'], 1000); assert.equal(rows[0]['1–15 días (%)'], 100);
  assert.ok(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets['Consulta y criterios'])).includes('product-recurrence-exclusive-v1'));
  await page.locator('#product-recurrence-group').selectOption('hierarchy');
  await page.locator('#product-recurrence-level').selectOption('2');
  await page.locator('#product-recurrence-hierarchy').selectOption('["Retail"]');
  assert.equal(requests.length, 1); assert.match(await page.locator('#product-recurrence-status').innerText(), /consulta anterior/);
  await page.locator('#product-recurrence-filters [type=submit]').click();
  await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.match(await page.locator('.product-recurrence-table tbody tr').innerText(), /Retail \/ Sandwiches.*2\.000/s);
  for (const width of [390, 768, 1700]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#product-recurrence-workspace, #product-recurrence-workspace *')]
      .filter(node => node.getBoundingClientRect().right > innerWidth && !node.closest('.recurrence-scroll'))
      .map(node => `${node.tagName}#${node.id}.${node.className}: ${node.getBoundingClientRect().right}`));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Layout at ${width}: ${overflow.join(', ')}`);
  }
  assert.deepEqual(errors, []);
});
test('cup grouping combines selected formats, and screen and XLSX percentages always display one decimal', { skip: !fs.existsSync(chrome) }, async t => {
  const fixture = [{ ...orders[0], lines: ['CL', 'GR', 'XTR'].map((size, index) => ({ code: `C${index}`, name: `Cappuccino (${size})`, categoryPath: ['Barra Cafe'], quantity: index + 1, netSales: (index + 1) * 1000 })) }];
  const s = await setup(t, false, fixture), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(s.base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click();
  await page.locator('#product-recurrence-period').selectOption('custom');
  await page.locator('#product-recurrence-from').fill('2026-10-01'); await page.locator('#product-recurrence-to').fill('2026-10-07');
  await page.locator('#product-recurrence-group').selectOption('product');
  await page.locator('#product-recurrence-products input[value="C0"]').check();
  assert.equal(await page.locator('#product-recurrence-products input').count(), 3);
  await page.locator('#product-recurrence-formats').check();
  const choice = page.locator('#product-recurrence-products input');
  assert.equal(await choice.count(), 1); assert.equal(await choice.isChecked(), true);
  assert.equal(await page.locator('#product-recurrence-products label').innerText(), 'Cappuccino (CL, GR, XTR)');
  assert.match(await page.locator('#product-recurrence-selection-count').innerText(), /^1 producto/);
  await page.locator('#product-recurrence-search').fill('C2');
  assert.equal(await choice.count(), 1);
  await choice.uncheck(); assert.equal(await page.locator('#product-recurrence-selection-count').innerText(), 'Todos los productos');
  await choice.check();
  await page.locator('#product-recurrence-search').fill('');
  const request = page.waitForRequest(req => new URL(req.url()).pathname === '/api/sales/product-recurrence');
  await page.locator('#product-recurrence-filters [type=submit]').click();
  const submitted = new URL((await request).url()).searchParams;
  assert.equal(submitted.get('groupFormats'), 'true');
  assert.deepEqual(JSON.parse(submitted.get('products')).sort(), ['C0', 'C1', 'C2']);
  await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  const row = page.locator('.product-recurrence-table tbody tr'); assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /Cappuccino · C0 \/ C1 \/ C2.*6\.000.*100,0%/s);
  const percentages = await page.locator('.product-recurrence-table td strong, .product-recurrence-kpis article:nth-child(n+3) > strong').allTextContents();
  assert.ok(percentages.length > 0); assert.ok(percentages.every(text => /^\d+,\d%$/.test(text)));
  const pending = page.waitForEvent('download'); await page.locator('#product-recurrence-export').click();
  const file = path.join(os.tmpdir(), `product-recurrence-formats-${Date.now()}.xlsx`); await (await pending).saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const book = XLSX.readFile(file, { cellNF: true }), sheet = book.Sheets['Producto-Recurrencia'];
  assert.equal(sheet.E2.v, 100); assert.equal(sheet.E2.z, '0.0"%"'); assert.equal(sheet.E2.w, '100.0%');
  assert.equal(sheet.G2.w, '0.0%');
  await page.locator('#product-recurrence-formats').uncheck();
  assert.equal(await page.locator('#product-recurrence-products input:checked').count(), 3);
  assert.match(await page.locator('#product-recurrence-selection-count').innerText(), /^3 producto/);
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(await page.locator('.product-recurrence-table tbody tr').count(), 3);
});
test('changing filters cancels slow product reports and failures remain retryable', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t, false, orders), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(s.base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click();
  await page.locator('#product-recurrence-period').selectOption('custom');
  await page.locator('#product-recurrence-from').fill('2026-10-01'); await page.locator('#product-recurrence-to').fill('2026-10-07');
  let release, arrived; const held = new Promise(resolve => release = resolve), started = new Promise(resolve => arrived = resolve);
  await page.route('**/api/sales/product-recurrence?*', async route => { arrived(); await held; await route.fulfill({ status: 503, json: { error: 'Respuesta antigua' } }).catch(() => {}); });
  await page.locator('#product-recurrence-filters [type=submit]').click(); await started;
  await page.locator('#product-recurrence-to').fill('2026-10-08'); await page.locator('#product-recurrence-from').focus(); release();
  assert.equal(await page.locator('#product-recurrence-filters [type=submit]').isEnabled(), true);
  await page.unroute('**/api/sales/product-recurrence?*');
  await page.route('**/api/sales/product-recurrence?*', route => route.fulfill({ status: 503, json: { error: 'Fuente no disponible' } }));
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Fuente no disponible' }).waitFor();
  assert.equal(await page.locator('#product-recurrence-filters [type=submit]').isEnabled(), true);
  await page.unroute('**/api/sales/product-recurrence?*');
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.ok(!(await page.locator('#product-recurrence-status').innerText()).includes('Respuesta antigua'));
});

test('every product recurrence column sorts both ways locally, keeps missing values last and exports the displayed order', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t, false, orders), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let requests = 0;
  await page.route('**/api/sales/product-recurrence?*', async route => {
    requests++; const response = await route.fetch(), data = await response.json();
    data.rows = [
      ['Álamo', 100, 11, [15, 10, 5, 0, 60, 10]],
      ['Café', 2000, 2, [10, 20, 0, 40, 25, 5]],
      ['Té', 300, 1, [30, 0, 10, 20, 40, 0]],
      ['Zeta', null, null, [null, null, null, null, null, null]]
    ].map(([label, netSales, units, values]) => ({ label, netSales, units,
      windows: Object.fromEntries([15, 30, 60, 90].map((days, i) => [days, { percent: values[i], netSales: 0 }])),
      withoutRecent: { percent: values[4], netSales: 0 }, unclassified: { percent: values[5], netSales: 0 } }));
    await route.fulfill({ json: data });
  });
  await page.goto(s.base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click();
  await page.locator('#product-recurrence-period').selectOption('custom');
  await page.locator('#product-recurrence-from').fill('2026-10-01'); await page.locator('#product-recurrence-to').fill('2026-10-07');
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  const cells = page.locator('.product-recurrence-table thead th'), names = () => page.locator('.product-recurrence-table tbody th').allTextContents();
  const footer = await page.locator('.product-recurrence-table tfoot').innerText();
  const expected = [
    ['Álamo', 'Café', 'Té', 'Zeta'], ['Álamo', 'Té', 'Café'], ['Té', 'Café', 'Álamo'],
    ['Café', 'Álamo', 'Té'], ['Té', 'Álamo', 'Café'], ['Café', 'Álamo', 'Té'],
    ['Álamo', 'Té', 'Café'], ['Café', 'Té', 'Álamo'], ['Té', 'Café', 'Álamo']
  ];
  for (let index = 0; index < expected.length; index++) {
    const cell = cells.nth(index), button = cell.getByRole('button');
    await button.click();
    if (await cell.getAttribute('aria-sort') !== 'ascending') { await button.focus(); await page.keyboard.press('Enter'); }
    assert.equal(await cell.getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(await names(), index === 0 ? expected[index] : [...expected[index], 'Zeta']);
    await button.click(); assert.equal(await cell.getAttribute('aria-sort'), 'descending');
    assert.deepEqual(await names(), index === 0 ? [...expected[index]].reverse() : [...expected[index]].reverse().concat('Zeta'));
  }
  assert.equal(requests, 1); assert.equal(await page.locator('.product-recurrence-table tfoot').innerText(), footer);
  const displayed = await names(), pending = page.waitForEvent('download'); await page.locator('#product-recurrence-export').click();
  const file = path.join(os.tmpdir(), `product-recurrence-sorted-${Date.now()}.xlsx`); await (await pending).saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const book = XLSX.readFile(file), exported = XLSX.utils.sheet_to_json(book.Sheets['Producto-Recurrencia']);
  assert.deepEqual(exported.slice(0, -1).map(row => row['Jerarquía / Producto']), displayed);
  assert.equal(exported.at(-1)['Jerarquía / Producto'], 'Total selección');
});

test('hierarchies open locally down to grouped products with branch totals, breadcrumbs, back navigation and scoped export', { skip: !fs.existsSync(chrome) }, async t => {
  const fixture = [{ ...orders[0], lines: [
    { code: 'CL', name: 'Cappuccino (CL)', categoryPath: ['Barra Cafe', 'Calientes', 'Café espresso'], quantity: 1, netSales: 1000 },
    { code: 'GR', name: 'Cappuccino (GR)', categoryPath: ['Barra Cafe', 'Calientes', 'Café espresso'], quantity: 2, netSales: 2000 },
    { code: 'DIRECT', name: 'Espresso', categoryPath: ['Barra Cafe'], quantity: 1, netSales: 500 },
    { code: 'ICED', name: 'Iced Coffee', categoryPath: ['Barra Cafe', 'Frías'], quantity: 1, netSales: 1500 }
  ] }, orders[1]];
  const s = await setup(t, false, fixture), browser = await chromium.launch({ executablePath: chrome, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/sales/product-recurrence') requests++; });
  await page.goto(s.base); await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Producto-Recurrencia', exact: true }).click();
  await page.locator('#product-recurrence-period').selectOption('custom');
  await page.locator('#product-recurrence-from').fill('2026-10-01'); await page.locator('#product-recurrence-to').fill('2026-10-07');
  await page.locator('#product-recurrence-formats').check();
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  const sale = () => page.locator('.product-recurrence-kpis article').first().locator('strong').innerText();
  assert.equal(await sale(), '$7.000');
  await page.getByRole('button', { name: 'Ver detalle de Barra Cafe', exact: true }).click();
  assert.equal(await sale(), '$5.000'); assert.equal(await page.locator('.product-recurrence-table tbody tr').count(), 3);
  assert.match(await page.locator('.product-recurrence-table tbody').innerText(), /Espresso/);
  await page.getByRole('button', { name: 'Ver detalle de Calientes', exact: true }).click();
  await page.getByRole('button', { name: 'Ver detalle de Café espresso', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal(await sale(), '$3.000');
  assert.equal(await page.locator('.product-recurrence-table tbody tr').count(), 1);
  assert.match(await page.locator('.product-recurrence-table tbody').innerText(), /Cappuccino · CL \/ GR.*3\.000.*100,0%/s);
  assert.equal(await page.locator('.product-recurrence-table tbody button').count(), 0);
  assert.match(await page.locator('#product-recurrence-context').innerText(), /Barra Cafe \/ Calientes \/ Café espresso/);
  const pending = page.waitForEvent('download'); await page.locator('#product-recurrence-export').click();
  const file = path.join(os.tmpdir(), `product-recurrence-branch-${Date.now()}.xlsx`); await (await pending).saveAs(file); t.after(() => fs.rmSync(file, { force: true }));
  const book = XLSX.readFile(file), exported = XLSX.utils.sheet_to_json(book.Sheets['Producto-Recurrencia']);
  assert.equal(exported.length, 2); assert.equal(exported[0]['Venta neta'], 3000); assert.equal(exported[1]['Jerarquía / Producto'], 'Total jerarquía');
  assert.ok(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets['Consulta y criterios'])).includes('Barra Cafe / Calientes / Café espresso'));
  await page.getByRole('button', { name: '← Volver', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Ver detalle de Café espresso', exact: true }).count(), 1);
  await page.getByRole('navigation', { name: 'Ruta de jerarquías' }).getByRole('button', { name: 'Barra Cafe', exact: true }).click();
  assert.equal(await sale(), '$5.000');
  await page.getByRole('button', { name: 'Vista inicial', exact: true }).click(); assert.equal(await sale(), '$7.000');
  assert.equal(await page.locator('.product-recurrence-table tbody tr').count(), 2); assert.equal(requests, 1);
  await page.getByRole('button', { name: 'Ver detalle de Barra Cafe', exact: true }).click();
  await page.locator('#product-recurrence-filters [type=submit]').click(); await page.locator('#product-recurrence-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(await sale(), '$7.000'); assert.equal(await page.locator('.product-recurrence-back').count(), 0);
});
