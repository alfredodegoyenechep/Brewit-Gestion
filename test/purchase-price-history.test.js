const test=require('node:test'),assert=require('node:assert/strict');
const {applyPurchasePriceHistory}=require('../purchase-price-history');
const row=(unit,cost,factor,quantity=1)=>({locationId:'store-1',supplierKey:'bidfood',code:'BOL008',unit,purchaseUnit:unit,baseUnit:'UN',baseUnitCost:factor?cost/factor:null,effectiveUnitPrice:cost,quantity});
test('box of 36 and 36 individual cookies compare as per-unit costs across purchase presentations',()=>{
 const rows=[row('CAJ',38960,36),row('UN',1082.5,1,36)];applyPurchasePriceHistory(rows,s=>s.toUpperCase());
 assert.equal(rows[1].previousComparisonUnitCost,38960/36);assert.ok(Math.abs(rows[1].unitCostChangePercent-0.02566735112936)<1e-9);assert.equal(rows[1].comparisonUnit,'UN');
});
test('an intervening box replaces an older unit price; unknown packaging does not compare against base units',()=>{
 const rows=[row('UN',38000,1),row('CAJ',38960,36),row('PK',40000,null),row('UN',1082.5,1,36)];applyPurchasePriceHistory(rows,s=>s.toUpperCase());assert.equal(rows[2].previousComparisonUnitCost,null);assert.equal(rows[3].previousComparisonUnitCost,38960/36);
});
test('credit notes and zero quantities do not replace comparable purchase reference',()=>{
 const rows=[row('CAJ',38960,36),{...row('UN',5,1),documentType:'Nota de Crédito'},row('UN',9,1,0),row('UN',1082.5,1,36)];applyPurchasePriceHistory(rows,s=>s.toUpperCase());assert.equal(rows[3].previousComparisonUnitCost,38960/36);assert.equal(rows[1].unitCostChangePercent,null);
});
