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
module.exports = { applyBoundaryCostSummary };
