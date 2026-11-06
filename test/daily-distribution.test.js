const test = require('node:test'), assert = require('node:assert/strict');
const { buildReport, DAYS } = require('../daily-distribution');
const line = (code, quantity, netSales) => ({ code, name: code === 'P1' ? 'Latte (CL)' : 'Latte (GR)', categoryPath: ['Barra Cafe'], quantity, netSales });
const order = (date, code, units, amount, locationId = 's1') => ({ date, locationId, netSales: amount, lines: [line(code, units, amount)] });
const orders = [order('2026-10-05', 'P1', 2, 200), order('2026-10-12', 'P2', 4, 400), order('2026-10-19', 'P1', 99, 0),
  order('2026-10-06', 'P1', 3, 300), order('2026-10-13', 'P1', 6, 600), order('2026-10-11', 'P1', 10, 0),
  order('2026-10-12', 'P1', 1, 100, 's2'), order('2026-10-19', 'P1', 7, 700, 's2')];
const input = { orders, period: { from: '2026-10-05', to: '2026-10-25' }, scope: { label: 'Uno' }, locationIds: ['s1'],
  barFor: () => 'hot', ingredientsFor: () => [{ code: 'MILK', hierarchyPaths: [['Lácteos']] }, { code: 'COFFEE', hierarchyPaths: [['Café']] }] };
test('weekday averages exclude dates with zero total sales and preserve filtered product zeros on open days', () => {
  const r = buildReport({ ...input, query: { mode: 'products', products: '["P1"]' } });
  assert.deepEqual(r.periods.map(row => row.label), DAYS);
  assert.equal(r.sample.observedDays, 4); assert.equal(r.sample.excludedDays, 17);
  const monday = r.periods[0], tuesday = r.periods[1], sunday = r.periods[6];
  assert.deepEqual([monday.observedDays, monday.excludedDays, monday.netSales, monday.units], [2, 1, 100, 1]);
  assert.deepEqual([tuesday.observedDays, tuesday.netSales, tuesday.units], [2, 450, 4.5]);
  assert.deepEqual([sunday.observedDays, sunday.netSales, sunday.units], [0, null, null]);
  assert.equal(r.totals.netSales, 275); assert.equal(r.totals.units, 2.75);
  assert.equal(r.totals.totalNetSales, 1100); assert.equal(r.totals.totalUnits, 11);
  assert.notEqual(r.totals.netSales, monday.netSales + tuesday.netSales);
  assert.equal(r.filters.grain, undefined);
});
test('all cafeterias sum the network by date without counting a shared date twice', () => {
  const r = buildReport({ ...input, locationIds: ['s1', 's2'] });
  assert.equal(r.sample.observedDays, 5); assert.equal(r.periods[0].observedDays, 3);
  assert.equal(r.periods[0].netSales, 466.67); assert.equal(r.totals.totalNetSales, 2300); assert.equal(r.totals.netSales, 460);
  assert.deepEqual(r.periods[0].dates, ['2026-10-05', '2026-10-12', '2026-10-19']);
});
test('ingredients, hierarchy, bar and grouped sizes reuse the same opening-date sample', () => {
  for (const query of [{ mode: 'ingredients', ingredients: '["MILK","COFFEE"]' }, { mode: 'ingredient-hierarchy', hierarchy: '["Lácteos"]' }, { mode: 'product-hierarchy', hierarchy: '["Barra Cafe"]' }]) {
    const r = buildReport({ ...input, query: { ...query, groupFormats: true } });
    assert.equal(r.series.length, 1); assert.equal(r.totals.totalNetSales, 1500); assert.equal(r.totals.netSales, 375);
    assert.equal(r.sample.observedDays, 4); assert.equal(r.periods[0].netSales, 300);
  }
  const cold = buildReport({ ...input, query: { bar: 'cold' } });
  assert.equal(cold.sample.observedDays, 4); assert.equal(cold.periods[0].netSales, 0); assert.equal(cold.periods[6].netSales, null);
});
test('unavailable daily amounts, missing selected amounts and an empty period remain distinguishable from zero', () => {
  const unknown = order('2026-10-05', 'P1', 1, null);
  const r = buildReport({ ...input, orders: [unknown] });
  assert.equal(r.sample.unknownDays, 1); assert.equal(r.sample.observedDays, 0); assert.equal(r.totals.netSales, null);
  assert.equal(r.sample.excludedDays, 20); assert.ok(r.warnings.some(text => text.includes('importe total incompleto')));
  const open = { ...unknown, netSales: 100 };
  const partial = buildReport({ ...input, orders: [open] });
  assert.equal(partial.sample.observedDays, 1); assert.equal(partial.periods[0].units, 1); assert.equal(partial.periods[0].netSales, null);
  assert.equal(buildReport({ ...input, orders: [] }).totals.units, null);
});
test('the denominator respects dates, cafeterias and the current-day cutoff, including signed adjustments', () => {
  const r = buildReport({ ...input, orders: [order('2026-10-04', 'P1', 1, 100), order('2026-10-05', 'P1', -1, -100),
    { ...order('2026-10-06', 'P1', 2, 200), dateTime: '2026-10-06T14:00:00' }, order('2026-10-06', 'P1', 1, 100, 'other')],
  query: { serverToday: '2026-10-06', serverCutoff: '12:00:00' } });
  assert.equal(r.sample.observedDays, 1); assert.equal(r.periods[0].netSales, -100); assert.equal(r.periods[1].netSales, null);
});
