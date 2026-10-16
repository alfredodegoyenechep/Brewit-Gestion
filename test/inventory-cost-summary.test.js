const test = require('node:test');
const assert = require('node:assert/strict');
const {applyBoundaryCostSummary, applyInventoryValueSummary, inventoryValue} = require('../inventory-cost-summary');
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

test('closing values are recomputed after consumables separation, keeping partial physical counts available', () => {
  const report = { boundaryMode: true, selection: {}, excluded: [{code:'OUTSIDE'}], items: [
    {code:'A',costAvailable:true,unitCost:10,finalIsPhysical:true,finalInventory:100,theoreticalFinal:80,
      adjustedTheoreticalFinal:90,totalCostBeforeCompensations:200,totalCost:100},
    {code:'B',costAvailable:true,unitCost:10,finalIsPhysical:false,finalInventory:null,theoreticalFinal:30,
      adjustedTheoreticalFinal:30,totalCostBeforeCompensations:null,totalCost:null},
    {code:'C',costAvailable:false,unitCost:0,finalIsPhysical:true,finalInventory:5,theoreticalFinal:4,
      adjustedTheoreticalFinal:4,totalCostBeforeCompensations:0,totalCost:0}
  ] };
  const other = { boundaryMode:true,selection:{},excluded:[],items:[
    {code:'PAC014',costAvailable:true,unitCost:20,finalIsPhysical:true,finalInventory:5,theoreticalFinal:6,
      adjustedTheoreticalFinal:6,totalCostBeforeCompensations:-20,totalCost:-20}
  ] };
  const summary = {netSales:1000,metrics:{adjustedKardexTotalCost:{},physicalInventoryValue:{available:false},
    theoreticalFinalInventoryValue:{amount:1320}}};
  applyBoundaryCostSummary(summary,report,true);
  applyInventoryValueSummary(summary,report,other);
  assert.equal(summary.metrics.theoreticalFinalInventoryValue.amount,1200);
  assert.equal(summary.metrics.physicalInventoryValue.amount,1000);
  assert.equal(summary.metrics.physicalInventoryValue.available,true);
  assert.equal(summary.metrics.physicalInventoryValue.partial,true);
  assert.equal(summary.metrics.physicalInventoryValue.coveredItemCount,1);
  assert.equal(summary.inventoryBalances.consumables.physical.amount,100);
  assert.equal(summary.inventoryBalances.consumables.theoretical.amount,120);
  const adjusted = summary.metrics.adjustedKardexTotalCost;
  assert.equal(adjusted.theoreticalFinalInventoryValue,800);
  assert.equal(adjusted.adjustedTheoreticalFinalInventoryValue,900);
  assert.equal(adjusted.physicalInventoryValue-adjusted.adjustedTheoreticalFinalInventoryValue,adjusted.amount);
});

test('physical stock distinguishes counted zero, no counts and an actually empty scope', () => {
  const metric = items => inventoryValue(items,item=>item.finalInventory,1000);
  assert.equal(metric([{code:'A',costAvailable:true,unitCost:10,finalInventory:0}]).available,true);
  assert.equal(metric([{code:'A',costAvailable:true,unitCost:10,finalInventory:0}]).amount,0);
  assert.equal(metric([{code:'A',costAvailable:true,unitCost:10,finalInventory:null}]).amount,null);
  assert.equal(metric([{code:'A',costAvailable:false,unitCost:0,finalInventory:10}]).available,false);
  assert.equal(metric([]).amount,0);
});
test('unknown adjustments or no verified physical item cannot become a zero difference', () => {
  for(const [items,available] of [[[],true],[[{code:'A',finalIsPhysical:true,costAvailable:true,totalCost:0,totalCostBeforeCompensations:0}],false]]) {
    const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{}}};
    applyBoundaryCostSummary(summary,{items},available);
    assert.equal(summary.metrics.adjustedKardexTotalCost.available,false);
    assert.equal(summary.metrics.adjustedKardexTotalCost.amount,null);
  }
});
