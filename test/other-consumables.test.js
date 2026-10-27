const test=require('node:test'),assert=require('node:assert/strict');
const {CODES,separateOtherConsumables}=require('../other-consumables');
test('specified consumables move to their own report without changing the combined cost',()=>{
  const item=(code,totalCost)=>({code,totalCost,totalCostBeforeCompensations:totalCost,costAvailable:true,finalIsPhysical:true});
  const report={boundaryMode:true,items:[item('PAC014',-20),item('IAM003',-10),item('PAC013',-40),item('LAC001',-30)],excluded:[]};
  const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{amount:-100}}};
  const other=separateOtherConsumables(report,summary,true);
  assert.equal(CODES.size,29);assert.deepEqual(report.items.map(r=>r.code),['PAC013','LAC001']);
  assert.deepEqual(other.items.map(r=>r.code),['PAC014','IAM003']);
  assert.equal(summary.metrics.otherConsumables.amount,-30);
  assert.equal(summary.metrics.adjustedKardexTotalCost.amount,-70);
  assert.equal(summary.metrics.otherConsumables.percentOfNetSales,-3);
});
for (const boundaryMode of [true, false]) {
  test(`new packaging, juice labels and RINZA move with their costs (boundaryMode=${boundaryMode})`,()=>{
    const codes=['PAC026','PAC027','PAC028','PAC029','PAC030','PAC031','PAC023','JUG005','JUG006','JUG007','IAG005'];
    const item=code=>({code,totalCost:-10,totalCostBeforeCompensations:-10,costAvailable:true,finalIsPhysical:true});
    const report={boundaryMode,items:[item('LAC001'),...codes.map(item)],excluded:[]};
    const summary={netSales:1000,metrics:{adjustedKardexTotalCost:{available:true,amount:-120,kardexTotalCost:-120}}};
    const other=separateOtherConsumables(report,summary,true);
    assert.deepEqual(report.items.map(row=>row.code),['LAC001']);
    assert.deepEqual(other.items.map(row=>row.code),codes);
    assert.equal(report.itemCount,1);
    assert.equal(other.itemCount,11);
    assert.equal(other.physicalFinalItems,11);
    assert.equal(other.totalCost,-110);
    assert.equal(summary.metrics.otherConsumables.amount,-110);
    assert.equal(summary.metrics.otherConsumables.coveredItemCount,11);
    assert.equal(summary.metrics.adjustedKardexTotalCost.amount,-10);
    assert.equal(report.totalCost+other.totalCost,-120);
  });
}
test('unknown count and cost remain visible in Other Consumables without fabricated zero amounts',()=>{
  const report={boundaryMode:true,items:[{code:'6a062289438313ae8fee6459',totalCost:null,costAvailable:false,finalIsPhysical:false}],excluded:[]};
  const summary={netSales:100,metrics:{adjustedKardexTotalCost:{}}};
  const other=separateOtherConsumables(report,summary,true);
  assert.equal(other.items.length,1);assert.equal(report.items.length,0);
  assert.equal(summary.metrics.otherConsumables.amount,null);assert.equal(summary.metrics.otherConsumables.partial,true);
});
