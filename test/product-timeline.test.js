const test = require('node:test'), assert = require('node:assert/strict');
const { periodFor, selection, buildReport, optionsFor, bucketsFor } = require('../product-timeline');
const path = ['Barra Cafe', 'Café Caliente'];
const line = (code, quantity, netSales, extra = {}) => ({ code, name: `Latte (${code === 'P0' ? 'CL' : 'GR'})`, categoryPath: path, quantity, netSales, ...extra });
const orders = [
  { locationId: 's1', date: '2026-09-30', lines: [line('P0', 1, 1000), line('P1', 2, 2000), line('EX', 100, 10000, { isExtra: true }), line('COMP', 99, 99000, { parentLineId: 'P0' })] },
  { locationId: 's1', date: '2026-10-02', lines: [line('P0', 3, 3000)] },
  { locationId: 's2', date: '2026-10-02', lines: [line('P0', 4, 4000)] },
  { locationId: 's1', date: '2026-10-05', lines: [line('P1', 5, 5000)] }
];
const input = { orders, period: { from: '2026-09-30', to: '2026-10-05' }, scope: { label: 'Test' }, locationIds: ['s1'],
  barFor: () => 'hot', ingredientsFor: () => [{ code: 'MILK', hierarchyPaths: [['Lácteos', 'Leches']] }, { code: 'COFFEE', hierarchyPaths: [['Café']] }] };
test('daily points fill missing dates and reconcile units and net sales without extras, components or other cafeterias', () => {
  const r = buildReport(input); assert.equal(r.periods.length, 6); assert.equal(r.totals.units, 11); assert.equal(r.totals.netSales, 11000);
  assert.equal(r.series.length, 2); assert.equal(r.periods[1].units, 0);
  assert.equal(r.periods.reduce((sum, row) => sum + row.netSales, 0), r.totals.netSales);
  assert.equal(r.series.reduce((sum, row) => sum + row.netSales, 0), r.totals.netSales);
  for (const series of r.series) assert.equal(series.points.reduce((sum, row) => sum + row.units, 0), series.units);
  assert.equal(buildReport({ ...input, locationIds: ['s1', 's2'] }).totals.units, 15);
  assert.equal(buildReport({ ...input, query: { bar: 'cold' } }).totals.units, 0);
});
test('weekly and monthly points use clipped calendar boundaries and preserve totals', () => {
  const weekly = buildReport({ ...input, query: { grain: 'weekly' } });
  assert.deepEqual(weekly.periods.map(p => [p.key, p.from, p.to, p.units]), [
    ['2026-09-28', '2026-09-30', '2026-10-04', 6], ['2026-10-05', '2026-10-05', '2026-10-05', 5]
  ]);
  const monthly = buildReport({ ...input, query: { grain: 'monthly' } });
  assert.deepEqual(monthly.periods.map(p => [p.key, p.units]), [['2026-09-01', 3], ['2026-10-01', 8]]);
  assert.equal(monthly.totals.netSales, weekly.totals.netSales);
});
test('ingredient union and hierarchy descendants select each sold product once, retaining its complete sale', () => {
  for (const query of [{ mode: 'ingredients', ingredients: '["MILK","COFFEE"]' },
    { mode: 'ingredient-hierarchy', hierarchy: '["Lácteos"]' }, { mode: 'product-hierarchy', hierarchy: '["Barra Cafe"]' }]) {
    const report = buildReport({ ...input, query }); assert.equal(report.totals.units, 11); assert.equal(report.totals.netSales, 11000);
  }
  assert.equal(buildReport({ ...input, query: { mode: 'ingredients', ingredients: '["UNKNOWN"]' } }).series.length, 0);
  assert.equal(buildReport({ ...input, query: { mode: 'products', products: '["P0"]' } }).totals.units, 4);
});
test('format grouping combines current and previous beverage sizes and keeps hot, iced and retail products separate', () => {
  const lines = [line('P0', 1, 100), line('P1', 2, 200), line('OLD', 1, 100, { name: 'Latte (M)' }),
    line('ICE', 1, 100, { name: 'Latte (CL)', categoryPath: ['Barra Cafe', 'Iced Coffee'] }),
    line('FOOD1', 1, 100, { name: 'Cookie (CL)', categoryPath: ['Retail'] }), line('FOOD2', 1, 100, { name: 'Cookie (GR)', categoryPath: ['Retail'] })];
  const report = buildReport({ ...input, orders: [{ locationId: 's1', date: '2026-10-02', lines }], barFor: l => l.code === 'ICE' ? 'cold' : l.code.startsWith('FOOD') ? 'other' : 'hot', query: { groupFormats: 'true' } });
  assert.equal(report.series.length, 4); assert.equal(report.series.find(s => s.codes.includes('P0')).units, 4);
  assert.deepEqual(report.series.find(s => s.codes.includes('P0')).codes, ['OLD', 'P0', 'P1']);
  const opts = optionsFor(lines.map(l => ({ ...l, bar: l.code.startsWith('FOOD') ? 'other' : 'hot' })), []);
  assert.ok(opts.groupedProducts.some(g => g.codes.length === 3)); assert.equal(opts.productHierarchies.length, 4);
});
test('missing sales remain unknown only in affected points, while signed refunds remain included', () => {
  const report = buildReport({ ...input, orders: [{ locationId: 's1', date: '2026-10-02', lines: [line('P0', 1, null), line('P1', -1, -100)] }] });
  assert.equal(report.totals.netSales, null); assert.equal(report.totals.units, 0);
  assert.equal(report.series.find(s => s.codes.includes('P1')).netSales, -100);
  assert.equal(report.periods[0].netSales, 0); assert.equal(report.periods[2].netSales, null);
  assert.ok(report.warnings.some(w => w.includes('sin importe')));
});
test('validates malformed selections, future or invalid dates, grain and chronological order', () => {
  for (const query of [{ mode: 'products' }, { mode: 'ingredients', ingredients: 'bad' }, { mode: 'ingredient-hierarchy' }, { grain: 'yearly' }, { bar: 'bad' }, { hierarchy: '[42]' }, { groupFormats: 'bad' }]) assert.throws(() => selection(query), { status: 400 });
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-10-05', '2026-10-01'], ['2026-11-01', '2026-11-05']]) assert.throws(() => periodFor({ period: 'custom', dateFrom: from, dateTo: to }, '2026-11-04'), { status: 400 });
  assert.deepEqual(periodFor({}, '2026-11-04'), { from: '2026-10-05', to: '2026-11-03', mode: 'last-30-days' });
  assert.equal(bucketsFor({ from: '2024-02-28', to: '2024-03-01' }, 'daily').buckets.length, 3);
});
