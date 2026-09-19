const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDemandPeriod, previousPeriod, comparableDatePairs, summarizeOrders,
  aggregateBaskets, orderMatches, buildDemandAnalysis
} = require('../demand-analysis');

const order = (id, locationId, date, netSales, discount = 0, cost = 0, costAvailable = true, codes = ['A']) => ({
  orderKey: id, locationId, date, time: '12:00', netSales, orderDiscount: discount,
  cost, costAvailable, mode: 'takeaway', channel: '', reversalSignals: [], paymentMatched: true,
  lines: codes.map(code => ({ code, name: code, categoryId: 'AB.001', categoryName: 'Barra', categoryPath: ['Barra'],
    isExtra: false, quantity: 1, netSales: netSales / codes.length,
    cost: cost / codes.length, costAvailable }))
});

test('mes y semana cruzan correctamente el primer día y el cambio de horario de Chile', () => {
  assert.deepEqual(resolveDemandPeriod({ mode: 'month', anchor: '2026-09-01' }, '2026-09-17'),
    { from: '2026-09-01', to: '2026-09-17', mode: 'month' });
  assert.deepEqual(resolveDemandPeriod({ mode: 'week', anchor: '2026-09-07' }, '2026-09-17'),
    { from: '2026-09-07', to: '2026-09-13', mode: 'week' });
  assert.deepEqual(previousPeriod({ from: '2026-09-01', to: '2026-09-17', mode: 'month' }),
    { from: '2026-08-01', to: '2026-08-31', label: 'Mes anterior, días operados equivalentes' });
  const store = { openingDate: '2026-08-01', operatingWeekdays: [0, 1, 2, 3, 4, 5, 6],
    operatingHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { open: '08:00', close: '20:00' }])),
    salesRanges: [{ from: '2026-08-01', to: '2026-09-30' }] };
  const pair = comparableDatePairs(store, { from: '2026-09-06', to: '2026-09-08' },
    { from: '2026-08-30', to: '2026-09-01' }, '2026-09-08', '13:00');
  assert.equal(pair.valid, true);
  assert.deepEqual(pair.currentDates, ['2026-09-06', '2026-09-07', '2026-09-08']);
  assert.equal(pair.cutoff, '13:00');
});

test('sin calendario o cobertura no se inventa un benchmark ni se interpreta ausencia como cero', () => {
  const period = { from: '2026-09-14', to: '2026-09-17' };
  const previous = { from: '2026-09-07', to: '2026-09-10' };
  assert.equal(comparableDatePairs({ salesRanges: [] }, period, previous, '2026-09-17').valid, false);
  assert.equal(comparableDatePairs({ openingDate: '2026-05-01', operatingWeekdays: [1, 2, 3, 4], salesRanges: [] },
    period, previous, '2026-09-17').valid, false);
});

test('red consolida desde montos y pedidos, no promedia márgenes ni tickets', () => {
  const stores = [
    { id: 'one', name: 'Uno', openingDate: null, salesRanges: [] },
    { id: 'two', name: 'Dos', openingDate: null, salesRanges: [] }
  ];
  const report = buildDemandAnalysis({ today: '2026-09-17', filters: { mode: 'day', anchor: '2026-09-17' }, stores,
    orders: [order('1', 'one', '2026-09-17', 100, -10, 20), order('2', 'two', '2026-09-17', 300, -30, 150)] });
  assert.equal(report.summary.netSales, 400);
  assert.equal(report.summary.marginPercent, 57.5);
  assert.equal(report.summary.averageTicketGross, 238);
  assert.equal(report.summary.discountPercent, 7.8);
  assert.equal(report.comparisons.available, false);
  assert.equal(report.locations.length, 2);
});

test('margen falta si un pedido no tiene costo completo y el lift corrige popularidad', () => {
  const orders = [order('1', 'one', '2026-09-01', 100, 0, 20, true, ['A', 'B']),
    order('2', 'one', '2026-09-01', 100, 0, 0, false, ['A']),
    order('3', 'one', '2026-09-01', 100, 0, 20, true, ['B'])];
  assert.equal(summarizeOrders(orders).marginPercent, null);
  assert.equal(summarizeOrders(orders).costCoveredOrders, 2);
  const baskets = aggregateBaskets(Array.from({ length: 40 }, (_, index) =>
    order(String(index), 'one', '2026-09-01', 10, 0, 2, true,
      index < 20 ? ['A', 'B'] : index < 30 ? ['A'] : ['B'])));
  assert.equal(baskets.pairs[0].orders, 20);
  assert.equal(baskets.pairs[0].lift, 0.89);
});

test('filtros de producto, categoría, modalidad y canal se aplican a pedidos', () => {
  const sample = order('1', 'one', '2026-09-01', 100);
  sample.channel = 'POS'; sample.lines[0].size = 'Grande';
  assert.equal(orderMatches(sample, { product: 'A', category: 'AB.', modeOfService: 'takeaway', channel: 'POS', size: 'Grande' }), true);
  assert.equal(orderMatches(sample, { product: 'B' }), false);
  assert.equal(orderMatches(sample, { channel: 'Web' }), false);
});

test('día en curso compara el mismo horario y un benchmark de cero no divide por cero', () => {
  const store = { id: 'one', name: 'Uno', openingDate: '2026-09-01', operatingWeekdays: [4],
    operatingHours: { 4: { open: '08:00', close: '20:00' } },
    salesRanges: [{ from: '2026-09-01', to: '2026-09-17' }] };
  const currentEarly = order('1', 'one', '2026-09-17', 150);
  const currentLate = { ...order('2', 'one', '2026-09-17', 300), time: '18:00' };
  const priorEarly = order('3', 'one', '2026-09-10', 100);
  const priorLate = { ...order('4', 'one', '2026-09-10', 500), time: '18:00' };
  const report = buildDemandAnalysis({ today: '2026-09-17', cutoff: '13:00',
    filters: { mode: 'day', anchor: '2026-09-17' }, stores: [store],
    orders: [currentEarly, currentLate, priorEarly, priorLate] });
  assert.equal(report.summary.netSales, 450);
  assert.equal(report.comparisons.netSalesChangePercent, 50);
  assert.equal(report.comparisons.currentOrders, 1);
  assert.equal(report.comparisons.previousOrders, 1);
  const zeroBenchmark = buildDemandAnalysis({ today: '2026-09-17', cutoff: '13:00',
    filters: { mode: 'day', anchor: '2026-09-17' }, stores: [store], orders: [currentEarly] });
  assert.equal(zeroBenchmark.comparisons.available, true);
  assert.equal(zeroBenchmark.comparisons.netSalesChangePercent, null);
});

test('estacionalidad solo se habilita con dos años completos del mismo local', () => {
  const store = { id: 'one', name: 'Uno', openingDate: '2024-01-01',
    operatingWeekdays: [0, 1, 2, 3, 4, 5, 6],
    operatingHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { open: '08:00', close: '20:00' }])),
    salesRanges: [{ from: '2024-01-01', to: '2025-12-31' }] };
  const orders = [2024, 2025].flatMap(year => Array.from({ length: 12 }, (_, index) =>
    order(`${year}-${index}`, 'one', `${year}-${String(index + 1).padStart(2, '0')}-15`, index === 0 ? 200 : 100)));
  const complete = buildDemandAnalysis({ today: '2026-01-17', filters: { mode: 'all' }, stores: [store], orders });
  assert.equal(complete.annualSeasonality.available, true);
  assert.equal(complete.advanced.find(item => item.key === 'seasonality').status, 'exploratory');
  assert.ok(complete.annualSeasonality.months[0].indexPercent > complete.annualSeasonality.months[1].indexPercent);
  const incomplete = buildDemandAnalysis({ today: '2026-01-17', filters: { mode: 'all' },
    stores: [{ ...store, salesRanges: [{ from: '2024-01-01', to: '2025-11-30' }] }], orders });
  assert.equal(incomplete.annualSeasonality.available, false);
});
