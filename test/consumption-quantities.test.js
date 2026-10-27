const test=require('node:test'),assert=require('node:assert/strict');
const {consumptionQuantities,withEmployeeMilkSubstitutions}=require('../consumption-quantities');
test('explicit milk units and decimal commas are preserved and normalized',()=>{
  assert.deepEqual(consumptionQuantities(['2 (con modificación)']),[{unit:'UN',quantity:2}]);
  assert.deepEqual(consumptionQuantities(['180ml','940 ML','CERRADO','FERIADO']),[{unit:'L',quantity:1.12}]);
  assert.deepEqual(consumptionQuantities(['1,8 g',.18],'kg'),[{unit:'kg',quantity:.1818}]);
});
test('vegetable milk quantities use liters for missing units and UN while preserving explicit volume scales',()=>{
  for (const code of ['LAC003', 'LAC004']) {
    assert.deepEqual(consumptionQuantities([4.74, '0,26 UN', '250ml', '1 litro'], 'UN', code), [{unit:'L',quantity:6.25}]);
  }
  assert.deepEqual(consumptionQuantities([2, '1 UN'], 'UN', 'OTHER'), [{unit:'UN',quantity:3}]);
});
test('employee milk substitution reversals preserve signed quantities and dates and are idempotent',()=>{
  const report={products:[
    {code:'LAC003',unit:'L',quantity:2,dailyQuantities:[{date:'2026-09-01',quantity:2}]},
    {code:'LAC004',unit:'L',quantity:-0.5,dailyQuantities:[{date:'2026-09-02',quantity:-0.5}]}
  ],totalQuantity:1.5,totalCost:0};
  const result=withEmployeeMilkSubstitutions(report);
  assert.equal(result.products.at(-1).quantity,-1.5);
  assert.deepEqual(result.products.at(-1).dailyQuantities.map(row=>[row.date,row.quantity]),[['2026-09-01',-2],['2026-09-02',0.5]]);
  assert.equal(withEmployeeMilkSubstitutions(result),result);
  assert.equal(report.products.length,2);
});
test('undeclared quantities are never assumed to be kilograms or combined with volume',()=>{
  assert.deepEqual(consumptionQuantities([.33,'150ml']),[{unit:'UN',quantity:.33},{unit:'L',quantity:.15}]);
});
