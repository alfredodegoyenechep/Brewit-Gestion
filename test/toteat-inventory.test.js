const test = require('node:test');
const assert = require('node:assert/strict');
const { recipeConsumption, reconcileInventory, compareRecipeQuantity } = require('../toteat-inventory');

const ingredient = { custom_id: 'FLOUR', id: 'flour', stock_enabled: true, stock_unit: 'KG' };
const sandwich = { custom_id: 'SANDWICH', id: 'sandwich', stock_enabled: true, stock_unit: 'UN', recipe: {
  quantity: 2, quantity_unit: 'UN', portions_per_unit: 1, manufacturing_use_only: true,
  ingredients: [{ custom_id: 'FLOUR', quantity: 100, quantity_unit: 'G', yield_rate: 80 }]
} };
test('sale consumes finished stock, production alone consumes ingredients with yield and batch size', () => {
  assert.deepEqual(recipeConsumption([ingredient, sandwich], 'SANDWICH', 4), [{ code: 'SANDWICH', unit: 'UN', quantity: 4 }]);
  assert.deepEqual(recipeConsumption([ingredient, sandwich], 'SANDWICH', 4, { transformation: true }), [{ code: 'FLOUR', unit: 'KG', quantity: 0.25 }]);
});
test('nonstock recipe stops at a stocked subrecipe and does not consume it twice', () => {
  const platter = { custom_id: 'PLATTER', stock_enabled: false, recipe: { quantity: 1, quantity_unit: 'UN', portions_per_unit: 1,
    ingredients: [{ custom_id: 'SANDWICH', quantity: 2, quantity_unit: 'UN', yield_rate: 100 }] } };
  assert.deepEqual(recipeConsumption([ingredient, sandwich, platter], 'PLATTER', 3), [{ code: 'SANDWICH', unit: 'UN', quantity: 6 }]);
});
test('unknown stock flags, recipe cycles and invalid conversions fail explicitly', () => {
  assert.throws(() => recipeConsumption([{ ...sandwich, stock_enabled: null }], 'SANDWICH', 1), /desconocido/);
  assert.throws(() => recipeConsumption([ingredient], 'FLOUR', 1, { unit: 'UN' }), /Conversión/);
  const cyclic = { ...sandwich, stock_enabled: false, recipe: { ...sandwich.recipe, ingredients: [{ custom_id: 'SANDWICH', quantity: 1, quantity_unit: 'UN', yield_rate: 100 }] } };
  assert.throws(() => recipeConsumption([cyclic], 'SANDWICH', 1), /circular/);
});
test('recipe change tolerance is directional and never masks excess or a zero denominator', () => {
  assert.equal(compareRecipeQuantity(95, 100).status, 'within-recipe-change-range');
  assert.equal(compareRecipeQuantity(105, 100).status, 'review');
  assert.equal(compareRecipeQuantity(94, 100).status, 'review');
  assert.equal(compareRecipeQuantity(1, 0).status, 'unexplained');
});
function fixture() {
  const row = (quantity, total, type, direction, at) => ({ product_ref: 'sandwich', warehouse_ref: 'local', quantity,
    quantity_total: total, type_move_id: type, move_id: direction, registration_date: at, measure_unit_ref: 'UN', description: 'test' });
  return { range: { from: '2026-08-23', to: '2026-08-30' }, products: [sandwich], partitions: [{ product: 'sandwich', warehouse: 'local', rows: [
    row(10, 10, 1, 3, '2026-08-23 10:00:00'), row(2, 8, 3, 2, '2026-08-24 12:00:00'),
    row(2, 6, 3, 2, '2026-08-24 12:00:00'), row(-1, 5, 2, 1, '2026-08-24 13:00:00'), row(4, 4, 1, 3, '2026-08-30 10:00:00')
  ] }], daily: [{ product_ref: 'sandwich', unit: 'UN', warehouses: [{ warehouse_ref: 'local', inventory: [
    { date: '20260823', initial_inventory: 10, final_inventory: 10, is_taken: true },
    { date: '20260824', initial_inventory: 10, final_inventory: 5, purchase: -1, use: 4 },
    { date: '20260830', initial_inventory: 4, final_inventory: 4, is_taken: true }
  ].map(r => ({ purchase: 0, use: 0, transfer_local_in: 0, transfer_local_out: 0, transfer_warehouse_in: 0, transfer_warehouse_out: 0, transformed_in: 0, transformed_out: 0, ...r })) }] }] };
}
test('ledger preserves repeated equal movements, negative credit notes and physical resets', () => {
  const result = reconcileInventory(fixture());
  assert.equal(result.nativeReconciliationPassed, true);
  assert.equal(result.rowCount, 5);
  assert.equal(result.daily[1].use, 4);
  assert.equal(result.daily[1].purchase, -1);
  assert.equal(result.closures[0].expected, 5);
  assert.equal(result.closures[0].counted, 4);
  assert.equal(result.closures[0].countDifference, -1);
  assert.deepEqual(reconcileInventory(fixture()), result); // Replacing a snapshot is idempotent.
});
test('native reconciliation rejects small ledger differences even inside 5%', () => {
  const source = fixture(); source.partitions[0].rows[1].quantity_total = 8.01;
  const result = reconcileInventory(source);
  assert.equal(result.nativeReconciliationPassed, false);
  assert.equal(result.transitions.length, 2);
});
test('unknown movement types are retained and block certification', () => {
  const source = fixture(); source.partitions[0].rows[1].type_move_id = 99;
  assert.equal(reconcileInventory(source).unknown.length, 1);
  assert.equal(reconcileInventory(source).nativeReconciliationPassed, false);
});
