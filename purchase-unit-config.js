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
  if (!configuration?.purchaseUnit) return null;
  const quantity = configuration.internalUnit && internalUnit
    ? convertQuantity(configuration.unitsPerPurchaseUnit, configuration.internalUnit, internalUnit) : null;
  return { purchaseUnit: configuration.purchaseUnit,
    unitsPerPurchaseUnit: Number.isFinite(quantity) && quantity > 0 ? quantity : null };
}

function configuredPurchaseCost(latestPurchase, originalConversion, configured, fallbackCost, { transfer = false } = {}) {
  const price = latestPurchase?.effectiveUnitPrice || latestPurchase?.listedUnitPrice || 0;
  if (!transfer && latestPurchase && purchaseUnitLabel(latestPurchase.unit) === purchaseUnitLabel(configured.purchaseUnit)) return price;
  if (latestPurchase && originalConversion > 0 && configured.unitsPerPurchaseUnit > 0) {
    return price / originalConversion * configured.unitsPerPurchaseUnit;
  }
  return fallbackCost.source !== 'missing' && configured.unitsPerPurchaseUnit > 0
    ? fallbackCost.unitCost * configured.unitsPerPurchaseUnit : null;
}

function transferOrderItem(item, configuration, convertQuantity, policy = {}) {
  const transfer = configuredPurchaseUnits(configuration?.transfer, item.internalUnit, convertQuantity);
  if (!transfer) return { ...item, transferConfigured: false };
  const changed = purchaseUnitLabel(item.purchaseUnit) !== purchaseUnitLabel(transfer.purchaseUnit)
    || item.unitsPerPurchaseUnit !== transfer.unitsPerPurchaseUnit;
  if (!changed) return { ...item, transferConfigured: true };
  const oldConversion = item.unitsPerPurchaseUnit;
  const conversion = transfer.unitsPerPurchaseUnit;
  const ratio = oldConversion > 0 && conversion > 0 ? conversion / oldConversion : null;
  const multiple = supplyMultipleFromPolicy(policy, conversion, transfer.purchaseUnit);
  const quantity = value => value === 0 ? 0 : Number.isFinite(value) && ratio > 0
    ? purchaseUnitsForInternalQuantity(value * oldConversion, conversion, multiple) : null;
  const price = value => Number.isFinite(value) && ratio > 0 ? Math.round(value * ratio) : null;
  const result = { ...item, purchaseUnit: transfer.purchaseUnit, unitsPerPurchaseUnit: conversion,
    unitsPerPackage: multiple, unitsPerPackageBasis: 'purchase', transferConfigured: true, transferUnitChanged: true };
  for (const key of ['quantity', 'suggestedPurchaseUnits']) if (Object.hasOwn(item, key)) result[key] = quantity(item[key]);
  for (const key of ['unitCost', 'referenceUnitCost', 'estimatedPurchaseUnitCost']) if (Object.hasOwn(item, key)) result[key] = price(item[key]);
  if (Object.hasOwn(item, 'internalQuantity')) result.internalQuantity = result.quantity === null ? null : result.quantity * conversion;
  if (Object.hasOwn(item, 'total')) result.total = result.quantity === null || result.unitCost === null ? null : result.quantity * result.unitCost;
  return result;
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
  transferOrderItem, supplyMultipleFromPolicy, purchaseUnitsForInternalQuantity, isSupplyMultiple };
