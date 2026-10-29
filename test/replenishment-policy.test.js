const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../replenishment-policy');

test('inventory min/max replenishment handles zero demand, threshold equality, negative and unknown balances', () => {
  const item = { replenishmentMode: 'inventory', minInventory: 5, maxInventory: 12, currentInventory: 5, averageDailyConsumption: 0 };
  for (const [stock, required] of [[5, 7], [6, 0], [-2, 14], [null, 0]]) {
    const result = policy.metrics({ ...item, currentInventory: stock });
    assert.equal(result.rawSuggestedInternalQuantity, required);
    assert.equal(result.needsPurchase, required > 0);
  }
  for (const limits of [{ minInventory: null }, { maxInventory: null }, { minInventory: -1 }, { maxInventory: 4 }]) {
    assert.equal(policy.metrics({ ...item, ...limits }).replenishmentConfigured, false);
    assert.equal(policy.metrics({ ...item, ...limits }).needsPurchase, false);
  }
  assert.equal(policy.modeFor('pac014'), 'inventory');
  assert.equal(policy.modeFor('PAC014', { replenishmentMode: 'recipe' }), 'recipe');
  assert.equal(policy.modeFor('NEW', { replenishmentMode: 'inventory' }), 'inventory');
});
