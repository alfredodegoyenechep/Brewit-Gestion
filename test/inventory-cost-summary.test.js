const test = require('node:test');
const assert = require('node:assert/strict');
const {applyBoundaryCostSummary} = require('../inventory-cost-summary');
test('adjusted Kardex subtotal covers only physical, priced items and applies their credits once', () => {
  const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{}}};
  const report={items:[
    {code:'A',finalIsPhysical:true,costAvailable:true,totalCost:-120,totalCostBeforeCompensations:-100},
    {code:'B',finalIsPhysical:false,costAvailable:true,totalCost:null,totalCostBeforeCompensations:null},
    {code:'C',finalIsPhysical:true,costAvailable:false,totalCost:0,totalCostBeforeCompensations:0}
  ],excluded:[{code:'D'}]};
  applyBoundaryCostSummary(summary,report,true);
  const result=summary.metrics.adjustedKardexTotalCost;
  assert.equal(result.amount,-120);assert.equal(result.percentOfNetSales,-12);
  assert.equal(result.totalAdjustmentCost,20);assert.equal(result.partial,true);
  assert.equal(result.coveredItemCount,1);assert.deepEqual(result.missingPhysicalCodes,['B']);
  assert.deepEqual(result.missingCostCodes,['C']);assert.deepEqual(result.excludedOpeningCodes,['D']);
});
test('unknown adjustments or no verified physical item cannot become a zero difference', () => {
  for(const [items,available] of [[[],true],[[{code:'A',finalIsPhysical:true,costAvailable:true,totalCost:0,totalCostBeforeCompensations:0}],false]]) {
    const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{}}};
    applyBoundaryCostSummary(summary,{items},available);
    assert.equal(summary.metrics.adjustedKardexTotalCost.available,false);
    assert.equal(summary.metrics.adjustedKardexTotalCost.amount,null);
  }
});
