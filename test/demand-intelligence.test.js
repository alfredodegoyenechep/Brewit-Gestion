const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRecordedName } = require('../name-segmentation');
const { aggregatePriceSignals, aggregateNameSegments, aggregateRecurrence, parseTimeBands } = require('../demand-intelligence');

const order = (overrides = {}) => ({ orderKey: overrides.orderKey || 'o1', locationId: overrides.locationId || 's1',
  date: overrides.date || '2026-09-01', time: overrides.time || '10:00', hour: overrides.hour ?? 10,
  netSales: overrides.netSales ?? 5000, cost: overrides.cost ?? 2000, costAvailable: overrides.costAvailable ?? true,
  mode: overrides.mode || 'takeaway', instrumentKey: overrides.instrumentKey || null,
  nameGenderSegment: overrides.nameGenderSegment || 'indeterminate', lines: overrides.lines || [{ code: 'P1', name: 'Café', quantity: 1,
    netSales: 4201.68, baseGross: 5000, isExtra: false, categoryId: 'C1', categoryName: 'Bebidas' }] });

test('clasifica nombres de forma conservadora y conserva indeterminados', () => {
  assert.equal(classifyRecordedName('Barbara llevar').segment, 'feminine-associated');
  assert.equal(classifyRecordedName('Sebastian servir').segment, 'masculine-associated');
  assert.equal(classifyRecordedName('Cliente empresa SPA').segment, 'indeterminate');
  assert.equal(classifyRecordedName('').segment, 'unavailable');
});

test('usa intervalos de precio de 500 por defecto y permite modificarlos', () => {
  const defaults = aggregatePriceSignals([order()], {});
  assert.equal(defaults.bandSize, 500);
  assert.equal(defaults.productPriceBands[0].from, 5000);
  const custom = aggregatePriceSignals([order()], { priceBand: 1000 });
  assert.equal(custom.bandSize, 1000);
  assert.equal(custom.productPriceBands[0].from, 5000);
  assert.match(custom.limitations, /no demuestra una barrera/i);
});

test('recurrencia cuenta instrumentos y no los presenta como personas', () => {
  const orders = [order({ orderKey: 'a', date: '2026-09-01', instrumentKey: 'hash-1' }),
    order({ orderKey: 'b', date: '2026-09-08', instrumentKey: 'hash-1' }),
    order({ orderKey: 'c', date: '2026-09-08' })];
  const result = aggregateRecurrence(orders, orders, { from: '2026-09-01', to: '2026-09-30' }, { linkedPercent: 80 });
  assert.equal(result.identifiableInstruments, 1);
  assert.equal(result.returningInstruments, 1);
  assert.equal(result.groups.find(item => item.key === 'returning-instrument').orders, 2);
  assert.match(result.limitations, /no equivale a una persona/i);
});

test('segmentos explicitan cobertura y denominadores', () => {
  const result = aggregateNameSegments([order({ nameGenderSegment: 'feminine-associated' }), order({ orderKey: 'b' })]);
  assert.equal(result.classifiableOrders, 1);
  assert.equal(result.classifiedPercent, 50);
  assert.match(result.limitations, /no confirma identidad ni género/i);
  assert.deepEqual(parseTimeBands({ morningEnd: 10, middayEnd: 15, afternoonEnd: 19 }).map(item => item.from), [0, 10, 15, 19]);
});
