const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const units = require('../purchase-unit-config');
const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
const helpers = script.slice(script.indexOf('function supplyMultipleFromPolicy('), script.indexOf('function filteredPurchaseProjectionItems('));
const recalculate = script.slice(script.indexOf('function recalculatePurchaseProjectionItem('), script.indexOf('function updateConsumptionReferenceButton('));
const client = new Function('ReplenishmentPolicy', `${helpers}\n${recalculate}\nreturn { supplyMultipleFromPolicy, purchaseUnitsForInternalQuantity, isSupplyMultiple, recalculatePurchaseProjectionItem, projectionSuggestionMetrics };`)(require('../replenishment-policy'));

test('transfer-only settings do not override buying units and costs scale even when both presentations share a label', () => {
  assert.equal(units.configuredPurchaseUnits({ transfer: { purchaseUnit: 'Pack', unitsPerPurchaseUnit: 6 } }, 'UN', () => 6), null);
  assert.equal(units.configuredPurchaseCost({ unit: 'Pack', effectiveUnitPrice: 1000 }, 1000,
    { purchaseUnit: 'Pack', unitsPerPurchaseUnit: 100 }, { source: 'missing' }, { transfer: true }), 100);
  assert.equal(units.configuredPurchaseCost({ unit: 'Pack', effectiveUnitPrice: 1000 }, 1000,
    { purchaseUnit: 'Pack', unitsPerPurchaseUnit: 100 }, { source: 'missing' }), 1000);
});

test('editing an old order converts physical quantities and unit costs to the current transfer presentation', () => {
  const item = { key: 'A', internalUnit: 'KG', purchaseUnit: 'Caja', unitsPerPurchaseUnit: 5,
    quantity: 2, unitCost: 10000, referenceUnitCost: 10000, internalQuantity: 10, total: 20000 };
  const changed = units.transferOrderItem(item, { transfer: { internalUnit: 'KG', purchaseUnit: 'Bolsa', unitsPerPurchaseUnit: .25 } }, n => n);
  assert.deepEqual([changed.purchaseUnit, changed.quantity, changed.unitCost, changed.internalQuantity, changed.total],
    ['Bolsa', 40, 500, 10, 20000]);
  assert.equal(changed.transferUnitChanged, true);
  assert.equal(item.purchaseUnit, 'Caja');
  assert.equal(units.transferOrderItem(item, {}, n => n).transferConfigured, false);
});

test('converts need to supply units before rounding to the allowed multiple, including decimal multiples', () => {
  for (const api of [units, client]) {
    assert.equal(api.purchaseUnitsForInternalQuantity(1.4, 1.36, 1), 2);
    assert.equal(api.purchaseUnitsForInternalQuantity(7 * 1.36, 1.36, 6), 12);
    assert.equal(api.purchaseUnitsForInternalQuantity(1001, 1000, 1), 2);
    assert.equal(api.purchaseUnitsForInternalQuantity(.7, 1, .5), 1);
    assert.equal(api.purchaseUnitsForInternalQuantity(.2, 1, .25), .25);
    assert.equal(api.purchaseUnitsForInternalQuantity(.1 + .2, 1, .1), .3);
    assert.equal(api.purchaseUnitsForInternalQuantity(1e-12, 1, 1), 1);
    for (const [need, conversion, multiple] of [[0, 1, 1], [1, null, 1], [1, 1, null], [1, Infinity, 1]]) {
      assert.equal(api.purchaseUnitsForInternalQuantity(need, conversion, multiple), null);
    }
  }
});

test('legacy consumption multiples convert once to supply multiples; measured supplies retain fractions', () => {
  for (const api of [units, client]) {
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 1000 }, 1000, 'Caja'), 1);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 6 }, 6, 'Pack'), 1);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 1 }, 1.36, 'Botella'), 1);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: .5 }, 1, 'KG'), .5);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 1 }, 1000, 'kg'), .001);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 6, unitsPerPackageBasis: 'purchase' }, 1000, 'Caja'), 6);
    assert.equal(api.supplyMultipleFromPolicy({}, 1000, 'Caja'), 1);
    assert.equal(api.supplyMultipleFromPolicy({ unitsPerPackage: 6 }, null, 'Pack'), null);
  }
});

test('validates supply quantities directly, with decimal arithmetic tolerance', () => {
  for (const api of [units, client]) {
    for (const [quantity, multiple] of [[6, 6], [12, 6], [.75, .25], [.1 + .2, .1]]) assert.equal(api.isSupplyMultiple(quantity, multiple), true);
    for (const [quantity, multiple] of [[7, 6], [.3, .25], [0, 1], [1, null], [-1, 1], [Infinity, 1]]) assert.equal(api.isSupplyMultiple(quantity, multiple), false);
  }
});

test('editing criteria recalculates supply quantities, their consumption equivalent and estimated cost together', () => {
  const item = { averageDailyConsumption: 1, currentInventory: 0, minDays: 7, maxDays: 10,
    unitsPerPurchaseUnit: 1.36, unitsPerPackage: 6, estimatedPurchaseUnitCost: 100 };
  client.recalculatePurchaseProjectionItem(item);
  assert.equal(item.rawSuggestedInternalQuantity, 10);
  assert.equal(item.suggestedPurchaseUnits, 12);
  assert.equal(item.suggestedInternalQuantity, 16.32);
  assert.equal(item.projectedInternalQuantity, 16.32);
  assert.equal(item.suggestedConsumptionQuantity, 16.32);
  assert.equal(item.coverageAfterSuggestionDays, 16.32);
  assert.equal(item.estimatedTotal, 1200);
  item.unitsPerPackage = 1;
  client.recalculatePurchaseProjectionItem(item);
  assert.equal(item.suggestedPurchaseUnits, 8);
  assert.equal(item.projectedInternalQuantity, 10.88);
  assert.equal(item.suggestedConsumptionQuantity, 10.88);
  assert.equal(item.coverageAfterSuggestionDays, 10.88);
  assert.equal(item.estimatedTotal, 800);
});

test('suggestion metrics use the actual supply conversion, include negative inventory and retain current coverage when no purchase is needed', () => {
  assert.deepEqual(client.projectionSuggestionMetrics({ needsPurchase: true, suggestedPurchaseUnits: 2,
    unitsPerPurchaseUnit: 12, currentInventory: -13, averageDailyConsumption: 3.55 }),
  { suggestedConsumptionQuantity: 24, coverageAfterSuggestionDays: 11 / 3.55 });
  assert.deepEqual(client.projectionSuggestionMetrics({ needsPurchase: false, suggestedPurchaseUnits: null,
    unitsPerPurchaseUnit: 12, currentInventory: 50, averageDailyConsumption: 5 }),
  { suggestedConsumptionQuantity: 0, coverageAfterSuggestionDays: 10 });
});

test('suggestion coverage uses the same consolidated basis as current warehouse coverage', () => {
  const item = { needsPurchase: true, suggestedPurchaseUnits: 6, unitsPerPurchaseUnit: 12,
    currentInventory: 100, averageDailyConsumption: 2, totalInventory: 150, localsDailyConsumption: 15 };
  assert.deepEqual(client.projectionSuggestionMetrics(item),
    { suggestedConsumptionQuantity: 72, coverageAfterSuggestionDays: 14.8 });
  assert.equal(client.projectionSuggestionMetrics({ ...item, totalInventory: null }).coverageAfterSuggestionDays, null);
  assert.equal(client.projectionSuggestionMetrics({ ...item, localsDailyConsumption: null }).coverageAfterSuggestionDays, null);
});

test('missing conversion and zero consumption do not produce invented suggestion quantities or coverage days', () => {
  const item = { needsPurchase: true, suggestedPurchaseUnits: 2, unitsPerPurchaseUnit: null,
    currentInventory: 10, averageDailyConsumption: 2 };
  assert.deepEqual(client.projectionSuggestionMetrics(item),
    { suggestedConsumptionQuantity: null, coverageAfterSuggestionDays: null });
  assert.deepEqual(client.projectionSuggestionMetrics({ ...item, unitsPerPurchaseUnit: .75, averageDailyConsumption: 0 }),
    { suggestedConsumptionQuantity: 1.5, coverageAfterSuggestionDays: null });
});
