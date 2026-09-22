// History is keyed by the unit in which the price is expressed, never by packaging.
function applyPurchasePriceHistory(rows, normalizeUnit) {
  const history = new Map();
  for (const row of rows) {
    const converted = Number.isFinite(row.baseUnitCost) && row.baseUnitCost > 0;
    row.comparisonUnitCost = converted ? row.baseUnitCost : row.effectiveUnitPrice;
    row.comparisonUnit = converted ? row.baseUnit : row.purchaseUnit || row.unit;
    const key = [row.locationId, row.supplierKey, row.code || row.product, normalizeUnit(row.comparisonUnit || '')].join('|');
    const valid = row.quantity > 0 && row.comparisonUnitCost > 0 && !/cr[eé]dito|credit[_ ]note/i.test(row.documentType || '');
    row.previousComparisonUnitCost = valid ? history.get(key) ?? null : null;
    row.unitCostChangePercent = row.previousComparisonUnitCost > 0
      ? (row.comparisonUnitCost / row.previousComparisonUnitCost - 1) * 100 : null;
    row.previousEffectiveUnitPrice = row.previousComparisonUnitCost;
    row.priceChangePercent = row.unitCostChangePercent;
    if (valid) history.set(key, row.comparisonUnitCost);
  }
  return rows;
}
module.exports = { applyPurchasePriceHistory };
