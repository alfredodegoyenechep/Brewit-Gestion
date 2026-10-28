const test = require('node:test');
const assert = require('node:assert/strict');
const { consolidateLocalTotals } = require('../purchase-local-totals');

const convert = (quantity, from, to) => from === to ? quantity
  : from === 'ML' && to === 'L' ? quantity / 1000 : null;
const item = { key: 'A', internalUnit: 'L', currentInventory: 100 };
function source(id, inventory, daily, unit = 'L', extra = {}) {
  return { location: { id, name: id },
    projection: { period: { dataThrough: '2026-10-16' }, consumptionReference: extra.reference },
    itemsByKey: new Map([['A', { internalUnit: unit, currentInventory: inventory, managed: true,
      ownAverageDailyConsumption: daily, projectedAverageDailyConsumption: null,
      averageDailyConsumption: daily, consumptionFrom: '2026-09-17', consumptionDays: 30,
      ...extra.item }]]), ...extra };
}

test('local totals convert each quantity and use effective daily replenishment demand', () => {
  const sources = [source('stable', 20000, 10000, 'ML'),
    source('new', 30, 3, 'L', { reference: { active: true, source: { name: 'stable' }, percentage: 50 },
      item: { projectedAverageDailyConsumption: 5, averageDailyConsumption: 5, consumptionDays: 7 } })];
  const result = consolidateLocalTotals(item, sources, 'warehouse', convert);
  assert.equal(result.localsInventory, 50);
  assert.equal(result.totalInventory, 150);
  assert.equal(result.localsDailyConsumption, 15);
  assert.equal(result.currentCoverageDays, 10);
  assert.equal(result.locals[0].sourceInventory, 20000);
  assert.equal(result.locals[0].inventory, 20);
  assert.equal(result.locals[1].ownDailyConsumption, 3);
  assert.equal(result.locals[1].dailyConsumption, 5);
  assert.equal(result.locals[1].reference.percentage, 50);
  assert.equal(result.locals[1].consumptionDays, 7);
});

test('a catalog-only warehouse ingredient keeps its own and total inventory unknown', () => {
  const result = consolidateLocalTotals({ ...item, currentInventory: null, hasInventoryHistory: false },
    [source('store', 30, 3)], 'warehouse', convert);
  assert.equal(result.localsInventory, 30);
  assert.equal(result.totalInventory, null);
  assert.equal(result.currentCoverageDays, null);
  assert.match(result.coverageUnavailableReason, /Sin inventario verificable/);
});

test('a selected store is counted once in inventory and still contributes its daily consumption once', () => {
  const result = consolidateLocalTotals({ ...item, currentInventory: 20 },
    [source('selected', 20, 10), source('other', 30, 5)], 'selected', convert);
  assert.equal(result.localsInventory, 30);
  assert.equal(result.totalInventory, 50);
  assert.equal(result.localsDailyConsumption, 15);
  assert.equal(result.locals[0].inventoryIncluded, false);
});

test('only locally managed items contribute consumption while all store inventories remain included', () => {
  const sources = [source('not-managed', 20, 100, 'L', { item: { managed: false, averageDailyConsumption: 200 } }),
    source('managed', 30, 3, 'L', { item: { projectedAverageDailyConsumption: 5, averageDailyConsumption: 5 } })];
  const result = consolidateLocalTotals(item, sources, 'warehouse', convert);
  assert.equal(result.totalInventory, 150);
  assert.equal(result.localsDailyConsumption, 5);
  assert.equal(result.currentCoverageDays, 30);
  assert.equal(result.locals[0].managed, false);
  assert.equal(result.locals[0].dailyConsumption, 0);
  assert.equal(result.locals[0].replenishmentDailyConsumption, 200);
  assert.match(result.locals[0].consumptionIssue, /No administrado/);
  const noneManaged = consolidateLocalTotals(item, [sources[0]], 'warehouse', convert);
  assert.equal(noneManaged.localsDailyConsumption, 0);
  assert.equal(noneManaged.currentCoverageDays, null);
});

test('missing inventory or incompatible units contribute zero to totals and coverage', () => {
  for (const badSource of [source('unknown-unit', 30, 3, 'KG'),
    { location: { id: 'missing', name: 'Missing' }, itemsByKey: new Map(), error: 'Sin fuentes de inventario.' }]) {
    const result = consolidateLocalTotals(item, [source('known', 20, 10), badSource], 'warehouse', convert);
    assert.equal(result.localsInventory, 20);
    assert.equal(result.localsInventorySubtotal, 20);
    assert.equal(result.totalInventory, 120);
    assert.equal(result.localsDailyConsumption, 10);
    assert.equal(result.localsDailyConsumptionSubtotal, 10);
    assert.equal(result.currentCoverageDays, 12);
    assert.equal(result.locals[1].inventory, 0);
    assert.equal(result.locals[1].dailyConsumption, 0);
    assert.match(result.locals[1].inventoryIssue, /Se considera 0/);
    assert.ok(result.locals[1].inventoryIssue);
    assert.ok(result.locals[1].consumptionIssue);
  }
});

test('a failed reference preserves known local stock and contributes zero demand', () => {
  const result = consolidateLocalTotals(item,
    [source('known', 20, 10), source('new', 30, 3, 'L', { consumptionError: 'Referencia no disponible.' })], 'warehouse', convert);
  assert.equal(result.totalInventory, 150);
  assert.equal(result.localsInventoryComplete, true);
  assert.equal(result.localsDailyConsumption, 10);
  assert.equal(result.localsConsumptionComplete, true);
  assert.equal(result.locals[1].inventory, 30);
  assert.equal(result.locals[1].dailyConsumption, 0);
  assert.equal(result.currentCoverageDays, 15);
});

test('negative inventory and verified zero consumption retain their meaning', () => {
  const negative = consolidateLocalTotals(item, [source('negative', -120, 2)], 'warehouse', convert);
  assert.equal(negative.totalInventory, -20);
  assert.equal(negative.currentCoverageDays, -10);
  const zero = consolidateLocalTotals(item, [source('zero', 0, 0)], 'warehouse', convert);
  assert.equal(zero.localsDailyConsumption, 0);
  assert.equal(zero.totalInventory, 100);
  assert.equal(zero.currentCoverageDays, null);
  assert.match(zero.coverageUnavailableReason, /Sin consumo/);
});
