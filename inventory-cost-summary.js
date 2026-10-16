// A missing physical count or purchase cost excludes that item, never the
// verified remainder and never turns an unknown difference into zero.
function applyBoundaryCostSummary(summary, report, adjustmentsAvailable) {
  const included = report.items.filter(item => item.finalIsPhysical && item.costAvailable
    && Number.isFinite(item.totalCost) && Number.isFinite(item.totalCostBeforeCompensations));
  const missingPhysicalCodes = report.items.filter(item => !item.finalIsPhysical).map(item => item.code);
  const missingCostCodes = report.items.filter(item => !item.costAvailable).map(item => item.code);
  const excludedOpeningCodes = (report.excluded || []).map(item => item.code);
  const available = adjustmentsAvailable && included.length > 0;
  const amount = available ? included.reduce((sum, item) => sum + item.totalCost, 0) : null;
  const baseline = included.reduce((sum, item) => sum + item.totalCostBeforeCompensations, 0);
  Object.assign(summary.metrics.adjustedKardexTotalCost, {
    available, amount,
    percentOfNetSales: available && summary.netSales ? amount / summary.netSales * 100 : null,
    partial: !!(missingPhysicalCodes.length || missingCostCodes.length || excludedOpeningCodes.length),
    coveredItemCount: included.length, totalItemCount: report.items.length,
    missingPhysicalCodes, missingCostCodes, excludedOpeningCodes,
    kardexTotalCost: baseline, totalAdjustmentCost: available ? baseline - amount : null
  });
}

function inventoryValue(items, quantity, netSales, excluded = []) {
  const known = items.filter(item => item.costAvailable && Number.isFinite(item.unitCost) && Number.isFinite(quantity(item)));
  const missingCostCodes = items.filter(item => !item.costAvailable || !Number.isFinite(item.unitCost)).map(item => item.code);
  const missingBalanceCodes = items.filter(item => !Number.isFinite(quantity(item))).map(item => item.code);
  const available = known.length > 0 || (!items.length && !excluded.length);
  const amount = available ? known.reduce((sum, item) => sum + quantity(item) * item.unitCost, 0) : null;
  return { amount, available, percentOfNetSales: available && netSales ? amount / netSales * 100 : null,
    partial: !!(missingCostCodes.length || missingBalanceCodes.length || excluded.length),
    coveredItemCount: known.length, totalItemCount: items.length, missingCostCodes, missingBalanceCodes,
    excludedCodes: excluded.map(item => item.code) };
}

// Recompute AFTER compensation and consumables separation, from exactly the
// same rows and quantities used by the two grids. Missing rows do not hide
// counted, priced stock; they make its subtotal partial.
function applyInventoryValueSummary(summary, report, otherConsumables = null) {
  const values = part => {
    const items = part?.items || [], excluded = part?.excluded || [];
    return {
      theoretical: inventoryValue(items, item => part.boundaryMode ? item.adjustedTheoreticalFinal : item.theoreticalFinal, summary.netSales, excluded),
      physical: inventoryValue(items, item => part.selection ? item.finalInventory : item.physicalFinal, summary.netSales, excluded)
    };
  };
  const kardex = values(report), consumables = otherConsumables ? values(otherConsumables) : null;
  summary.metrics.theoreticalFinalInventoryValue = kardex.theoretical;
  summary.metrics.physicalInventoryValue = kardex.physical;
  summary.inventoryBalances = { kardex, consumables };
  if (report.boundaryMode) {
    const covered = report.items.filter(item => item.finalIsPhysical && item.costAvailable
      && Number.isFinite(item.totalCost) && Number.isFinite(item.totalCostBeforeCompensations));
    Object.assign(summary.metrics.adjustedKardexTotalCost, {
      theoreticalFinalInventoryValue: inventoryValue(covered, item => item.theoreticalFinal, summary.netSales).amount,
      adjustedTheoreticalFinalInventoryValue: inventoryValue(covered, item => item.adjustedTheoreticalFinal, summary.netSales).amount,
      physicalInventoryValue: inventoryValue(covered, item => item.finalInventory, summary.netSales).amount
    });
  }
}

module.exports = { applyBoundaryCostSummary, inventoryValue, applyInventoryValueSummary };
