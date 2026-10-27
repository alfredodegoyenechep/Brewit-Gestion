const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { markPeriodMovementActivity } = require('../inventory-period-activity');
const { countBoundaryReport } = require('../inventory-boundaries');
const script = fs.readFileSync(require.resolve('../script.js'), 'utf8');
const hasActivity = new Function(`${script.slice(script.indexOf('function inventoryItemHasActivity('), script.indexOf('function sortInventoryItems('))}; return inventoryItemHasActivity;`)();
const empty = { code: 'A', unit: 'L', initialInventory: 0, finalInventory: 0, theoreticalFinal: 0, adjustedTheoreticalFinal: 0, movements: {} };
const report = items => ({ dateFrom: '2026-10-18', dateTo: '2026-10-24', items });
const context = { location: { type: 'store' } };

test('visibility ignores costs and hides missing or zero balances only when every quantity is inactive', () => {
  assert.equal(hasActivity({ ...empty, unitCost: 5000, costAvailable: true }), false);
  assert.equal(hasActivity({ code: 'A', initialInventory: null, finalInventory: undefined, costAvailable: false }), false);
  assert.equal(hasActivity({ ...empty, initialInventory: '0', finalInventory: null }), false);
  for (const key of ['initialInventory', 'finalInventory', 'physicalFinal', 'theoreticalFinal', 'adjustedTheoreticalFinal',
    'calibrationConsumption', 'employeeConsumption', 'marketingConsumption', 'compensationQuantity']) {
    for (const value of [0.001, -0.001]) assert.equal(hasActivity({ ...empty, [key]: value }), true, key);
  }
  for (const key of ['buy-compras', 'uso-consumo-estimado', 'trl-in-transferencia-local', 'trl-out-transferencia-local',
    'mov-in-transferencia-bodega', 'mov-out-transferencia-bodega', 'trn-in-transformacion', 'trn-out-transformacion', 'aju-tomas-intermedias']) {
    assert.equal(hasActivity({ ...empty, movements: { [key]: -2 } }), true, key);
  }
});

test('a purchase and its reversal remain reviewable even when both daily and period totals are zero', () => {
  const items = [{ ...empty }, { ...empty, code: 'OUTSIDE' }, { ...empty, code: 'PENDING' }];
  const line = { code: 'A', unit: 'L', warehouse: 'oper', date: '2026-10-18', column: 'purchase', active: true, quantity: 5 };
  markPeriodMovementActivity(report(items), { ...context, stock: { warehouses: [{ id: 'oper', custom_id: 2 }],
    operationLines: [line, { ...line, quantity: -5 }, { ...line, code: 'OUTSIDE', date: '2026-10-25' },
      { ...line, code: 'PENDING', active: false }, { ...line, code: 'PENDING', column: 'count' }, { ...line, code: 'PENDING', warehouse: 'other' }],
    daily: [{ ...line, purchase: 0 }] } });
  assert.equal(hasActivity(items[0]), true);
  assert.equal(hasActivity(items[1]), false);
  assert.equal(hasActivity(items[2]), false);
});

test('daily movement totals and internal consumption reversals retain zero-net rows, respecting dates and units', () => {
  const items = [{ ...empty }, { ...empty, code: 'INTERNAL' }, { ...empty, code: 'OTHER_UNIT' }];
  markPeriodMovementActivity(report(items), { ...context,
    stock: { warehouses: [{ id: 'oper', custom_id: 2 }], daily: [
      { code: 'A', unit: 'L', warehouse: 'oper', date: '2026-10-18', transfer_local_in: 4 },
      { code: 'A', unit: 'L', warehouse: 'oper', date: '2026-10-19', transfer_local_in: -4 }
    ] },
    consumption: { employees: { available: true, products: { products: [
      { code: 'INTERNAL', unit: 'L', quantity: 0, dailyQuantities: [{ date: '2026-10-18', quantity: -1 }, { date: '2026-10-19', quantity: 1 }] },
      { code: 'OTHER_UNIT', unit: 'UN', quantity: 1, dailyQuantities: [{ date: '2026-10-18', quantity: 1 }] }
    ] } } }
  });
  assert.equal(hasActivity(items[0]), true);
  assert.equal(hasActivity(items[1]), true);
  assert.equal(hasActivity(items[2]), false);
});

test('legacy daily movements retain activity without confusing cost or stock columns with movements', () => {
  const items = [{ ...empty }, { ...empty, code: 'STOCK_ONLY' }];
  const groups = [{ date: '2026-10-18', metrics: [{ normalized: 'buy - compras', column: 1 }, { normalized: 'costo', column: 2 }] },
    { date: '2026-10-19', metrics: [{ normalized: 'buy - compras', column: 3 }, { normalized: 'ii - inventario inicial', column: 4 }] }];
  markPeriodMovementActivity(report(items), { ...context, parsed: { groups, products: [
    { code: 'A', unit: 'L', row: [null, 3, 1000, -3, 0] },
    { code: 'STOCK_ONLY', unit: 'L', row: [null, 0, 1000, 0, 100] }
  ] } });
  assert.equal(hasActivity(items[0]), true);
  assert.equal(hasActivity(items[1]), false);
});

test('opposite intermediate physical-count adjustments retain activity even when their period sum is zero', () => {
  const state = { range: { from: '2026-10-18', to: '2026-10-21' }, warehouses: [{ id: 'oper', custom_id: 2 }],
    daily: [0, 2, 0, 0].map((opening, i) => ({ code: 'A', name: 'A', unit: 'L', warehouse: 'oper', date: `2026-10-${18 + i}`, opening, physicalCount: true })) };
  const item = countBoundaryReport(state, context.location, '2026-10-18', '2026-10-21').items[0];
  assert.equal(item.movements['aju-tomas-intermedias'], 0);
  assert.equal(item.initialInventory, 0);
  assert.equal(item.finalInventory, 0);
  assert.equal(hasActivity(item), true);
});
