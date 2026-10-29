const { legacyConsumables: CODES, modeFor } = require('./replenishment-policy');
const isOther = (code, configurations = {}) => modeFor(code, configurations[String(code).trim().toUpperCase()]) === 'inventory';
function separateOtherConsumables(report, summary, adjustmentsAvailable, configurations = {}) {
  const subset = selected => {
    const items = report.items.filter(item => isOther(item.code, configurations) === selected);
    const excluded = (report.excluded || []).filter(item => isOther(item.code, configurations) === selected);
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
module.exports = {CODES,isOther,separateOtherConsumables};
