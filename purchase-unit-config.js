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

function supplyMultipleFromPolicy(policy, unitsPerPurchaseUnit, purchaseUnit) {
  if (policy.unitsPerPackage === null) return null;
  const multiple = Number(policy.unitsPerPackage);
  if (!Number.isFinite(multiple) || multiple <= 0) return 1;
  if (policy.unitsPerPackageBasis === 'purchase') return multiple;
  const conversion = Number(unitsPerPurchaseUnit);
  if (!Number.isFinite(conversion) || conversion <= 0) return null;
  const converted = multiple / conversion;
  const measured = /^(kg|kilo|kilogramo|g|gr|gramo|mg|l|lt|litro|ml)$/i.test(String(purchaseUnit || '').trim());
  // Legacy package sizes were in consumption units. Counted supplies remain whole.
  return measured ? Number(converted.toPrecision(12)) : Math.max(1, Math.ceil(converted - 1e-9));
}

function purchaseUnitsForInternalQuantity(quantity, unitsPerPurchaseUnit, minimumMultiple = 1) {
  const value = Number(quantity), conversion = Number(unitsPerPurchaseUnit), multiple = Number(minimumMultiple);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(conversion) || conversion <= 0
    || !Number.isFinite(multiple) || multiple <= 0) return null;
  return Number((Math.max(1, Math.ceil((value / conversion / multiple) - 1e-9)) * multiple).toPrecision(12));
}

function isSupplyMultiple(quantity, minimumMultiple) {
  const value = Number(quantity), multiple = Number(minimumMultiple);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(multiple) || multiple <= 0) return false;
  const ratio = value / multiple;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-8 && Math.round(ratio) >= 1;
}

module.exports = { PURCHASE_UNIT_OPTIONS, purchaseUnitLabel, configuredPurchaseUnits, configuredPurchaseCost,
  supplyMultipleFromPolicy, purchaseUnitsForInternalQuantity, isSupplyMultiple };
