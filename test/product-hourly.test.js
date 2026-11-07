const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { buildReport } = require('../product-hourly');
const { setup } = require('./helpers/product-xray-fixture');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('product hourly separates locations and blocks, groups formats and excludes extras', () => {
  const line = (code, name, quantity, productNetSales) => ({ code, name, quantity, productNetSales, categoryPath: ['Barra Cafe'] });
  const orders = [
    { locationId: 'a', date: '2026-10-01', dateTime: '2026-10-01T07:00:00', lines: [line('CL', 'Latte (CL)', 2, 2000), line('GR', 'Latte (GR)', 1, 1500), { ...line('E', 'Extra', 1, 500), isExtra: true }] },
    { locationId: 'a', date: '2026-10-01', dateTime: '2026-10-01T08:59:59', lines: [line('CL', 'Latte (CL)', 1, 1000)] },
    { locationId: 'a', date: '2026-10-01', dateTime: '2026-10-01T09:00:00', lines: [line('CL', 'Latte (CL)', 3, 3000)] },
    { locationId: 'b', date: '2026-10-01', dateTime: '2026-10-01T07:10:00', lines: [line('CL', 'Latte (CL)', 5, 5000)] },
    { locationId: 'a', date: '2026-10-02', dateTime: '2026-10-02T07:10:00', lines: [line('CL', 'Latte (CL)', 99, 99000)] }
  ];
  const report = buildReport({ orders, period: { from: '2026-10-01', to: '2026-10-01' }, scope: { label: 'Todas' }, locationIds: ['a', 'b'],
    locations: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], query: { bar: 'all', groupFormats: 'true' }, barFor: () => 'hot' });
  assert.equal(report.blocks.length, 8);
  assert.deepEqual(report.stores.map(store => store.name), ['A', 'B']);
  assert.equal(report.blocks[0].label, '07:00–09:00');
  assert.deepEqual(report.blocks[0].stores[0].products.map(({ name, units, netSales }) => ({ name, units, netSales })),
    [{ name: 'Latte', units: 4, netSales: 4500 }]);
  assert.equal(report.blocks[0].stores[1].products[0].units, 5);
  assert.equal(report.blocks[1].stores[0].products[0].units, 3);
  assert.equal(report.blocks[1].stores[1].products.length, 0);
});

test('product hourly API and UI generate a matrix and switch ranking without another request', { skip: !fs.existsSync(chrome) }, async t => {
  const s = await setup(t), browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const url = new URL('/api/sales/product-hourly', s.base);
  for (const [key, value] of s.query) url.searchParams.set(key, value);
  url.searchParams.set('groupFormats', 'true');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.stores.length, 1);
  assert.equal(report.blocks.length, 8);
  assert.ok(report.blocks[1].stores[0].products.some(item => item.name === 'Latte' && item.units === 5));

  const page = await browser.newPage({ viewport: { width: 1450, height: 900 } }), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/sales/product-hourly') requests.push(request.url()); });
  await page.goto(s.base);
  await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
  await page.getByRole('tab', { name: 'Producto horario', exact: true }).click();
  assert.equal(requests.length, 0);
  await page.locator('#product-hourly-location').selectOption('store-1');
  await page.locator('#product-hourly-period').selectOption('custom');
  await page.locator('#product-hourly-from').fill('2026-10-01');
  await page.locator('#product-hourly-to').fill('2026-10-07');
  await page.locator('#product-hourly-formats').check();
  await page.route('**/api/sales/product-hourly?*', route => {
    const display = structuredClone(report);
    display.blocks[0].stores[0].products = [
      { name: 'Más unidades', units: 100, netSales: 100 },
      { name: 'Más dinero', units: 1, netSales: 100000 },
      ...[1, 2, 3, 4].map(index => ({ name: `Otro ${index}`, units: 10 - index, netSales: 1000 * index }))
    ];
    return route.fulfill({ json: display });
  });
  await page.locator('#product-hourly-run').click();
  await page.locator('#product-hourly-status').filter({ hasText: 'Reporte generado' }).waitFor();
  assert.equal(requests.length, 1);
  assert.equal(await page.locator('#product-hourly-body tr').count(), 8);
  assert.equal(await page.locator('#product-hourly-head th').count(), 2);
  assert.match(await page.locator('#product-hourly-body tr').nth(1).innerText(), /Latte/);
  const firstCell = page.locator('#product-hourly-body tr').first().locator('td').first();
  assert.equal(await firstCell.locator('li').count(), 5);
  assert.match(await firstCell.locator('li').first().innerText(), /Más unidades/);
  await page.locator('#product-hourly-metric').selectOption('netSales');
  assert.equal(requests.length, 1);
  assert.match(await page.locator('#product-hourly-context').innerText(), /Ranking por venta neta/);
  assert.match(await firstCell.locator('li').first().innerText(), /Más dinero/);
  assert.deepEqual(errors, []);
});
