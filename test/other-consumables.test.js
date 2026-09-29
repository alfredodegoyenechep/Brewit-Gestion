const test=require('node:test'),assert=require('node:assert/strict');
const {CODES,separateOtherConsumables}=require('../other-consumables');
test('specified consumables move to their own report without changing the combined cost',()=>{
  const item=(code,totalCost)=>({code,totalCost,totalCostBeforeCompensations:totalCost,costAvailable:true,finalIsPhysical:true});
  const report={boundaryMode:true,items:[item('PAC014',-20),item('IAM003',-10),item('PAC013',-40),item('LAC001',-30)],excluded:[]};
  const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{amount:-100}}};
  const other=separateOtherConsumables(report,summary,true);
  assert.equal(CODES.size,18);assert.deepEqual(report.items.map(r=>r.code),['PAC013','LAC001']);
  assert.deepEqual(other.items.map(r=>r.code),['PAC014','IAM003']);
  assert.equal(summary.metrics.otherConsumables.amount,-30);
  assert.equal(summary.metrics.adjustedKardexTotalCost.amount,-70);
  assert.equal(summary.metrics.otherConsumables.percentOfNetSales,-3);
});
test('unknown count and cost remain visible in Other Consumables without fabricated zero amounts',()=>{
  const report={boundaryMode:true,items:[{code:'6a062289438313ae8fee6459',totalCost:null,costAvailable:false,finalIsPhysical:false}],excluded:[]};
  const summary={netSales:100,metrics:{adjustedKardexTotalCost:{}}};
  const other=separateOtherConsumables(report,summary,true);
  assert.equal(other.items.length,1);assert.equal(report.items.length,0);
  assert.equal(summary.metrics.otherConsumables.amount,null);assert.equal(summary.metrics.otherConsumables.partial,true);
});
