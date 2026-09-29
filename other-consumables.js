const CODES = new Set([
  'PAC014','PAC015','PAC016','PAC017','PAC018','PAC019','PAC020','PAC021','PAC022',
  'IAM001','IAM002','IAM003','IAG001','IAG002','IAG003','IAG004',
  '6a062289438313ae8fee6459','6a062287438313ae8fee6455'
]);
const isOther = code => CODES.has(String(code).trim());
function separateOtherConsumables(report, summary, adjustmentsAvailable) {
  const subset = selected => {
    const items = report.items.filter(item => isOther(item.code) === selected);
    const excluded = (report.excluded || []).filter(item => isOther(item.code) === selected);
    return {...report,items,excluded,itemCount:items.length,
      physicalFinalItems:items.filter(item=>item.finalIsPhysical).length,
      totalCostBeforeCompensations:items.every(item=>Number.isFinite(item.totalCostBeforeCompensations)&&item.costAvailable)?items.reduce((sum,item)=>sum+item.totalCostBeforeCompensations,0):null,
      itemsWithoutCost:items.filter(item=>!item.costAvailable).map(item=>item.code),
      totalCost:items.some(item=>item.totalCost==null||!item.costAvailable) ? null : items.reduce((sum,item)=>sum+item.totalCost,0)};
  };
  const main = subset(false), other = subset(true);
  const priced = other.items.filter(item => item.costAvailable && Number.isFinite(item.totalCost));
  const missing = other.items.filter(item => !item.costAvailable || !Number.isFinite(item.totalCost));
  const available = priced.length > 0 || (!other.items.length && !other.excluded.length);
  const amount = available ? priced.reduce((sum,item)=>sum+item.totalCost,0) : null;
  summary.metrics.otherConsumables = {amount,available,partial:!!(missing.length||other.excluded.length),
    percentOfNetSales:available&&summary.netSales?amount/summary.netSales*100:null,
    itemCount:other.itemCount,coveredItemCount:priced.length,missingCodes:missing.map(item=>item.code)};
  if (report.boundaryMode) {
    require('./inventory-cost-summary').applyBoundaryCostSummary(summary,main,adjustmentsAvailable);
  } else if (summary.metrics.adjustedKardexTotalCost.available && amount!==null) {
    const metric=summary.metrics.adjustedKardexTotalCost;
    metric.amount-=amount;metric.kardexTotalCost-=amount;
    metric.percentOfNetSales=summary.netSales?metric.amount/summary.netSales*100:null;
  }
  Object.assign(report,main);
  return other;
}
module.exports = {CODES,separateOtherConsumables};
