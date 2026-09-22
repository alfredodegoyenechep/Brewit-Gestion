const test=require('node:test'),assert=require('node:assert/strict');
const {monthlyInventoryOverride:calc}=require('../inventory-monthly-override');
const record=(month,value)=>({locationId:'store-1',month,values:{inventoryDifference:value}});
test('manual monthly amount replaces, rather than adds to automatic inventory expense',()=>{
 const result=calc([record('2026-08',31000)],'store-1','2026-08-01','2026-08-15',()=>{throw Error('Must not calculate overridden month');});
 assert.equal(result.amount,15000);assert.equal(result.available,true);
});
test('zero is an explicit override and null retains automatic calculation',()=>{
 assert.equal(calc([record('2026-08',0)],'store-1','2026-08-01','2026-08-31',()=>{}).amount,0);
 assert.equal(calc([record('2026-08',null)],'store-1','2026-08-01','2026-08-31',()=>{}),null);
 assert.equal(calc([record('2026-08',100)],'store-2','2026-08-01','2026-08-31',()=>{}),null);
});
test('mixed months retain signed values and calculate automatic expense only for uncovered months',()=>{
 const calls=[];const result=calc([record('2026-08',-310)],'store-1','2026-08-30','2026-09-02',(from,to)=>{calls.push([from,to]);return {amount:100,available:true};});
 assert.deepEqual(calls,[['2026-09-01','2026-09-02']]);assert.equal(result.amount,80);assert.equal(result.available,true);
 const missing=calc([record('2026-08',-310)],'store-1','2026-08-30','2026-09-02',()=>({amount:0,available:false}));assert.equal(missing.available,false);
});
