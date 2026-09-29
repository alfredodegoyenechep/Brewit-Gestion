const test=require('node:test'),assert=require('node:assert/strict');
const {consumptionQuantities}=require('../consumption-quantities');
test('explicit milk units and decimal commas are preserved and normalized',()=>{
  assert.deepEqual(consumptionQuantities(['2 (con modificación)']),[{unit:'UN',quantity:2}]);
  assert.deepEqual(consumptionQuantities(['180ml','940 ML','CERRADO','FERIADO']),[{unit:'L',quantity:1.12}]);
  assert.deepEqual(consumptionQuantities(['1,8 g',.18],'kg'),[{unit:'kg',quantity:.1818}]);
});
test('undeclared quantities are never assumed to be kilograms or combined with volume',()=>{
  assert.deepEqual(consumptionQuantities([.33,'150ml']),[{unit:'UN',quantity:.33},{unit:'L',quantity:.15}]);
});
