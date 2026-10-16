const PURCHASE_UNIT_OPTIONS = ['Botella', 'Bidón', 'Pack', 'Caja', 'Bolsa', 'Lata'];
const aliases = new Map([
  ['bot', 'Botella'], ['botella', 'Botella'], ['bid', 'Bidón'], ['bidon', 'Bidón'],
  ['pack', 'Pack'], ['pck', 'Pack'], ['caj', 'Caja'], ['caja', 'Caja'],
  ['bol', 'Bolsa'], ['bolsa', 'Bolsa'], ['lat', 'Lata'], ['lata', 'Lata']
]);
function purchaseUnitLabel(value) {
  const key = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return aliases.get(key) || String(value || '').trim();
}

function configuredPurchaseUnits(configuration, internalUnit, convertQuantity) {
  if (!configuration) return null;
  const quantity = configuration.internalUnit && internalUnit
    ? convertQuantity(configuration.unitsPerPurchaseUnit, configuration.internalUnit, internalUnit) : null;
  return { purchaseUnit: configuration.purchaseUnit,
    unitsPerPurchaseUnit: Number.isFinite(quantity) && quantity > 0 ? quantity : null };
}

function configuredPurchaseCost(latestPurchase, originalConversion, configured, fallbackCost) {
  const price = latestPurchase?.effectiveUnitPrice || latestPurchase?.listedUnitPrice || 0;
  if (latestPurchase && purchaseUnitLabel(latestPurchase.unit) === purchaseUnitLabel(configured.purchaseUnit)) return price;
  if (latestPurchase && originalConversion > 0 && configured.unitsPerPurchaseUnit > 0) {
    return price / originalConversion * configured.unitsPerPurchaseUnit;
  }
  return fallbackCost.source !== 'missing' && configured.unitsPerPurchaseUnit > 0
    ? fallbackCost.unitCost * configured.unitsPerPurchaseUnit : null;
}

module.exports = { PURCHASE_UNIT_OPTIONS, purchaseUnitLabel, configuredPurchaseUnits, configuredPurchaseCost };
