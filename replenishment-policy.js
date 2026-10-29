(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReplenishmentPolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Initial classification for existing installations. Explicit master settings win.
  const legacyConsumables = new Set([
    'PAC014','PAC015','PAC016','PAC017','PAC018','PAC019','PAC020','PAC021','PAC022',
    'PAC023','PAC026','PAC027','PAC028','PAC029','PAC030','PAC031',
    'JUG005','JUG006','JUG007','IAM001','IAM002','IAM003','IAG001','IAG002','IAG003','IAG004','IAG005',
    '6A062289438313AE8FEE6459','6A062287438313AE8FEE6455'
  ]);
  const labels = { recipe: 'Por Consumo Receta', inventory: 'Por inventario mínimo y máximo' };
  function modeFor(code, configuration) {
    return Object.hasOwn(labels, configuration?.replenishmentMode) ? configuration.replenishmentMode
      : legacyConsumables.has(String(code || '').trim().toUpperCase()) ? 'inventory' : 'recipe';
  }
  function quantity(value) {
    return ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  function validInventoryRange(min, max) {
    return min === null && max === null || Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min && max <= 1e9;
  }
  function metrics(item) {
    const byInventory = item.replenishmentMode === 'inventory';
    const min = byInventory ? quantity(item.minInventory) : item.averageDailyConsumption * item.minDays;
    const max = byInventory ? quantity(item.maxInventory) : item.averageDailyConsumption * item.maxDays;
    const configured = !byInventory || min !== null && max !== null && min >= 0 && max >= min;
    const known = Number.isFinite(item.currentInventory);
    const triggered = known && configured && item.currentInventory <= min && (byInventory || item.averageDailyConsumption > 0);
    const required = triggered ? Math.max(0, max - item.currentInventory)
      : !byInventory && known && !(item.averageDailyConsumption > 0) ? Math.max(0, -item.currentInventory) : 0;
    return { minimumStock: min, maximumStock: max, replenishmentConfigured: configured,
      ownNeedsPurchase: triggered && max > item.currentInventory,
      ownSuggestedInternalQuantity: triggered ? Math.max(0, max - item.currentInventory) : 0,
      rawSuggestedInternalQuantity: required, needsPurchase: required > 0 };
  }
  return { labels, legacyConsumables, modeFor, quantity, validInventoryRange, metrics };
});
