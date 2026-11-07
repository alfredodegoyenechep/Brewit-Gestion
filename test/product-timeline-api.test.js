const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), XLSX = require('xlsx');
const { setup } = require('./helpers/product-xray-fixture');
const { buildReport } = require('../product-timeline');
const get = async (s, query, options = false) => {
  const response = await fetch(`${s.base}/api/sales/product-timeline${options ? '/options' : ''}?${query}`);
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
};
test('public-price margin uses net price and net cost, weighted by positive units across stores', () => {
  const orders = [
    { locationId: 'a', date: '2026-10-01', lines: [{ code: 'P0', name: 'Latte (CL)', quantity: 1, productNetSales: 500, categoryPath: ['Barra Cafe'] }] },
    { locationId: 'b', date: '2026-10-01', lines: [{ code: 'P0', name: 'Latte (CL)', quantity: 2, productNetSales: 1000, categoryPath: ['Barra Cafe'] }] }
  ];
  const input = { orders, period: { from: '2026-10-01', to: '2026-10-01' }, scope: { label: 'Todas' }, locationIds: ['a', 'b'],
    referenceFor: (_line, store) => ({ priceGross: 1190, costNet: store === 'a' ? 200 : 400 }) };
  const report = buildReport(input);
  assert.equal(report.series[0].netSales, 1500, 'Actual paid sales remain independent of the public-price reference');
  assert.equal(report.series[0].priceGrossMin, 1190);
  assert.equal(report.series[0].marginPercent, 66.67, '(3000 net list price - 1000 net cost) / 3000');
  assert.equal(report.totals.marginPercent, 66.67);
  const incomplete = buildReport({ ...input, referenceFor: (_line, store) => ({ priceGross: 1190, costNet: store === 'a' ? 200 : null }) });
  assert.equal(incomplete.series[0].marginPercent, null);
  assert.equal(incomplete.totals.marginPercent, null);
});
test('timeline estimates recipe margin with current master cost when an ingredient has no compatible purchase', async t => {
  const s = await setup(t);
  const purchaseFile = path.join(s.root, 'transactions/store-1/purchases.xlsx');
  const book = XLSX.readFile(purchaseFile);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Datos).filter(row => row.Cod !== 'CAF001');
  book.Sheets.Datos = XLSX.utils.json_to_sheet(rows); XLSX.writeFile(book, purchaseFile);
  const report = await get(s, s.query);
  const latte = report.series.find(row => row.codes.includes('P0'));
  assert.equal(latte.marginPercent, 80);
  assert.deepEqual(latte.referenceFallbacks, ['CAF001']);
  assert.ok(report.warnings.some(message => message.includes('CAF001')));
});
test('timeline uses the latest compatible purchase after converting its purchase unit', async t => {
  const s = await setup(t);
  const catalogFile = path.join(s.root, 'masters/catalog.xlsx'), catalog = XLSX.readFile(catalogFile);
  const ingredients = XLSX.utils.sheet_to_json(catalog.Sheets.Ingredientes);
  ingredients[0]['conv.1.umed'] = 'BOT';
  ingredients[0]['conv.1.umedb'] = 'g';
  ingredients[0]['conv.1.cnum'] = 100;
  ingredients[0]['conv.1.cden'] = 1;
  catalog.Sheets.Ingredientes = XLSX.utils.json_to_sheet(ingredients); XLSX.writeFile(catalog, catalogFile);
  const localFile = path.join(s.root, 'transactions/store-1/purchases.xlsx'), local = XLSX.readFile(localFile);
  const localRows = XLSX.utils.sheet_to_json(local.Sheets.Datos);
  localRows.find(row => row.Cod === 'CAF001').Costo = 20;
  localRows.find(row => row.Cod === 'CAF001')['Monto neto'] = 20;
  local.Sheets.Datos = XLSX.utils.json_to_sheet(localRows); XLSX.writeFile(local, localFile);
  const otherDir = path.join(s.root, 'transactions/store-2'); fs.mkdirSync(otherDir, { recursive: true });
  const other = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(other, XLSX.utils.json_to_sheet([{ 'Fecha emisión': '2026-10-01', Documento: '2', Lin: 1,
    Cod: 'CAF001', PRODUCTO: 'CAF001', 'Q.Fac': 1, 'Q.Rec': 1, 'Um.Fac': 'BOT', 'Um.Rec': 'BOT',
    Costo: 1000, 'Monto neto': 1000, 'Monto total': 1000 }]), 'Datos');
  XLSX.writeFile(other, path.join(otherDir, 'purchases.xlsx'));
  fs.writeFileSync(path.join(otherDir, 'index.json'), JSON.stringify({ fields: { purchases: { files: [{ id: 'p2', name: 'purchases.xlsx' }] } } }));
  const report = await get(s, s.query);
  const latte = report.series.find(row => row.codes.includes('P0'));
  assert.equal(latte.marginPercent, 80, '1000 per BOT / 100 g gives 10 per g, or 200 per latte');
  assert.deepEqual(latte.referenceFallbacks, []);
});
test('worker reads real sales and recipes, with cafeterias, lists, bar filters, formats and identical daily/weekly/monthly totals', async t => {
  const s = await setup(t), query = new URLSearchParams(s.query); query.set('dateTo', '2026-10-07');
  const options = await get(s, query, true);
  assert.equal(options.products.length, 6); assert.equal(options.groupedProducts.length, 4);
  assert.ok(options.ingredients.some(item => item.code === 'CAF001'));
  assert.ok(options.productHierarchies.some(item => item.label.includes('Café Caliente')));
  const report = await get(s, query); assert.equal(report.totals.netSales, 7000); assert.equal(report.totals.units, 7); assert.equal(report.periods.length, 7);
  assert.equal(report.series.find(row => row.label === 'Latte (CL)').priceGrossMin, 1190);
  assert.equal(report.series.find(row => row.label === 'Latte (CL)').marginPercent, 80);
  assert.equal(report.totals.marginPercent, 84.44);
  query.set('groupFormats', 'true');
  const grouped = await get(s, query);
  assert.deepEqual(grouped.series[0].codes, ['P0', 'P1']);
  assert.equal(grouped.series[0].priceGrossMin, 1190);
  assert.equal(grouped.series[0].priceGrossMax, 2380);
  assert.equal(grouped.series[0].marginPercent, 85.71);
  query.delete('groupFormats');
  for (const grain of ['weekly', 'monthly']) { query.set('grain', grain); const data = await get(s, query); assert.equal(data.totals.netSales, 7000); }
  query.set('mode', 'ingredients'); query.set('ingredients', '["CAF001"]'); query.set('groupFormats', 'true');
  const ingredient = await get(s, query); assert.equal(ingredient.series.length, 1); assert.equal(ingredient.totals.netSales, 5000); assert.equal(ingredient.totals.units, 5);
  query.set('bar', 'cold'); assert.equal((await get(s, query)).totals.netSales, 0);
  query.set('bar', 'all'); query.set('location', 'store-2'); assert.equal((await get(s, query)).series.length, 0);
  query.set('location', 'all'); assert.equal((await get(s, query)).totals.netSales, 5000);
  query.set('location', 'invalid'); assert.equal((await fetch(`${s.base}/api/sales/product-timeline?${query}`)).status, 400);
  query.set('location', 'all'); query.set('ingredients', 'not-json'); assert.equal((await fetch(`${s.base}/api/sales/product-timeline?${query}`)).status, 400);
});
test('ingredient hierarchy traverses subrecipes and multiple matching ingredients never duplicate sales', async t => {
  const s = await setup(t, { nestedCosts: true });
  const file = path.join(s.root, 'masters/catalog.xlsx'), book = XLSX.readFile(file), rows = XLSX.utils.sheet_to_json(book.Sheets.Ingredientes);
  for (const row of rows) if (row['ID Producto **'].startsWith('CAF')) row['Jerarquías de Ingredientes *'] = 'IC.010001';
  book.Sheets.Ingredientes = XLSX.utils.json_to_sheet(rows); XLSX.writeFile(book, file);
  fs.writeFileSync(path.join(s.root, 'masters/ingredients.txt'), 'ID Jerarquia\tNombre Jerarquía *\tID nodo padre\nIC.\tIngredientes\t\nIC.010\tCafé\tIC.\nIC.010001\tGranos\tIC.010\n');
  const indexPath = path.join(s.root, 'masters/masters.json'), index = JSON.parse(fs.readFileSync(indexPath));
  index.fixture['ingredient-hierarchy'] = { name: 'ingredients.txt', validFrom: '2026-01-01' }; fs.writeFileSync(indexPath, JSON.stringify(index));
  const opts = await get(s, s.query, true); assert.ok(opts.ingredientHierarchies.some(h => h.label === 'Café / Granos'));
  const query = new URLSearchParams(s.query); query.set('mode', 'ingredients'); query.set('ingredients', '["CAF002"]');
  const nested = await get(s, query); assert.deepEqual(nested.series.map(row => row.codes), [['P0']]); assert.equal(nested.totals.netSales, 3000);
  query.set('ingredients', '["CAF001","CAF002"]'); assert.equal((await get(s, query)).totals.netSales, 5000);
  query.set('mode', 'ingredient-hierarchy'); query.set('hierarchy', '["Café"]'); assert.equal((await get(s, query)).totals.netSales, 5000);
  query.set('mode', 'product-hierarchy'); query.set('hierarchy', '["Bolleria, Sandwich, Bebidas - Retail"]'); assert.equal((await get(s, query)).totals.netSales, 2000);
});
test('ingredient selections use recipes effective on each sale date and never a later recipe', async t => {
  const s = await setup(t), recipes = path.join(s.root, 'masters/recipes-new.xlsx');
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([
    { 'Id Producto': 'P0', 'Id Ingrediente': 'NEW', 'Cantidad Ingrediente': 1, 'Unidad Medida': 'g', 'Tasa Rendimiento': 100 }
  ]), 'Recetas'); XLSX.writeFile(book, recipes);
  const indexFile = path.join(s.root, 'masters/masters.json'), index = JSON.parse(fs.readFileSync(indexFile));
  index.new = { 'master-recipes': { name: 'recipes-new.xlsx', validFrom: '2026-10-04' } }; fs.writeFileSync(indexFile, JSON.stringify(index));
  const query = new URLSearchParams(s.query); query.set('mode', 'ingredients'); query.set('ingredients', '["NEW"]');
  const newer = await get(s, query); assert.equal(newer.totals.netSales, 2000); assert.equal(newer.totals.units, 2);
  query.set('ingredients', '["CAF001"]'); const original = await get(s, query); assert.equal(original.totals.netSales, 3000); assert.equal(original.totals.units, 3);
});
