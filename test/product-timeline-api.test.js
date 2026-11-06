const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), XLSX = require('xlsx');
const { setup } = require('./helpers/product-xray-fixture');
const get = async (s, query, options = false) => {
  const response = await fetch(`${s.base}/api/sales/product-timeline${options ? '/options' : ''}?${query}`);
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
};
test('worker reads real sales and recipes, with cafeterias, lists, bar filters, formats and identical daily/weekly/monthly totals', async t => {
  const s = await setup(t), query = new URLSearchParams(s.query); query.set('dateTo', '2026-10-07');
  const options = await get(s, query, true);
  assert.equal(options.products.length, 6); assert.equal(options.groupedProducts.length, 4);
  assert.ok(options.ingredients.some(item => item.code === 'CAF001'));
  assert.ok(options.productHierarchies.some(item => item.label.includes('Café Caliente')));
  const report = await get(s, query); assert.equal(report.totals.netSales, 7000); assert.equal(report.totals.units, 7); assert.equal(report.periods.length, 7);
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
