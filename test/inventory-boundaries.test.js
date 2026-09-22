const test=require('node:test');
const assert=require('node:assert/strict');
const {countBoundaryReport,boundaryPeriod}=require('../inventory-boundaries');
const location={type:'store'};
function fixture(){return {range:{from:'2026-08-23',to:'2026-08-30'},warehouses:[{id:'local',custom_id:2}],daily:Array.from({length:8},(_,i)=>({warehouse:'local',date:`2026-08-${23+i}`,code:'LAC001',name:'Leche',unit:'L',opening:i===0?100:80,physicalCount:i===0||i===7,purchase:2,use:5}))};}
// Daily net correction: avoided milk/syrup/packaging minus marketing/employees.
const correction=(code,unit,from,to)=>((Date.parse(to)-Date.parse(from))/86400000+1)*(2-1-.5);
test('count boundaries include initial day and exclude final day',()=>{
 const r=countBoundaryReport(fixture(),location,'2026-08-23','2026-08-30',correction);
 assert.equal(r.dateTo,'2026-08-29');assert.equal(r.items[0].initialInventory,100);assert.equal(r.items[0].movements['uso-consumo-estimado'],35);assert.equal(r.items[0].finalInventory,80);
});
test('theoretical opening carries all corrections and matches an earlier report closing',()=>{
 const a=countBoundaryReport(fixture(),location,'2026-08-23','2026-08-25',correction).items[0];
 const b=countBoundaryReport(fixture(),location,'2026-08-25','2026-08-30',correction).items[0];
 assert.equal(b.initialInventory,95);assert.equal(b.initialInventory,a.theoreticalFinal+correction('LAC001','L','2026-08-23','2026-08-24'));
 assert.equal(b.initialSource,'theoretical');assert.equal(b.anchorDate,'2026-08-23');assert.equal(a.finalInventory,null);assert.equal(a.difference,null);
});
test('intermediate physical counts reset corrected balances exactly once',()=>{
 const s=fixture();s.daily[3].physicalCount=true;s.daily[3].opening=90;
 const a=countBoundaryReport(s,location,'2026-08-23','2026-08-30',correction).items[0];
 assert.equal(a.movements['aju-tomas-intermedias'],-2.5);
 assert.equal(a.theoreticalFinal+correction('LAC001','L','2026-08-23','2026-08-29'),80);
 const b=countBoundaryReport(s,location,'2026-08-27','2026-08-30',correction).items[0];assert.equal(b.anchorDate,'2026-08-26');assert.equal(b.initialInventory,87.5);
});
test('partial takes do not invent openings or physical closings for other products',()=>{
 const s=fixture();s.daily.push(...s.daily.map(r=>({...r,code:'UNKNOWN',physicalCount:false,opening:null})));
 const r=countBoundaryReport(s,location,'2026-08-25','2026-08-29');assert.equal(r.items.length,1);assert.equal(r.excluded[0].code,'UNKNOWN');assert.equal(r.physicalFinalItems,0);
});
test('coverage gaps and invalid dates fail; next day closing is theoretical',()=>{
 assert.throws(()=>boundaryPeriod('2026-08-25','2026-08-25',fixture().range));assert.throws(()=>boundaryPeriod('2026-02-30','2026-08-25',fixture().range));
 const s=fixture();s.daily.splice(1,1);assert.throws(()=>countBoundaryReport(s,location,'2026-08-25','2026-08-30'),/toma anterior/);
 const r=countBoundaryReport(fixture(),location,'2026-08-30','2026-08-31');assert.equal(r.items[0].initialSource,'physical');assert.equal(r.items[0].finalInventory,null);
});
test('HTTP derives movement dates, exposes take dates, and keeps unknown physical values unavailable',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-boundaries-'));
 const app=require('../server').createApp({uploadsRoot:root,enableToteatSync:false});
 const state={...fixture(),masterObservedAt:'2026-09-22T03:00:00Z',includedOrders:[],issues:[],assumptions:[],sourceCapturedAt:'2026-09-22T03:00:00Z'};
 app.locals.toteatStockSync.rebuild=()=>state;app.locals.toteatStockSync.current=()=>state;
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}`;
 const calendar=await fetch(url+'/api/inventory/calendar?location=store-1&source=originals').then(r=>r.json());assert.deepEqual(calendar.countDates,['2026-08-23','2026-08-30']);
 const res=await fetch(url+'/api/inventory/process',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'store-1',source:'originals',criteriaMode:'count-boundaries',initialInventoryDate:'2026-08-25',finalInventoryDate:'2026-08-29',movementDateFrom:'2026-01-01',movementDateTo:'2026-12-31'})});
 const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));assert.equal(data.report.dateFrom,'2026-08-25');assert.equal(data.report.dateTo,'2026-08-28');assert.equal(data.report.items[0].initialInventory,94);assert.equal(data.report.items[0].finalInventory,null);assert.equal(data.report.items[0].totalCost,null);assert.equal(data.executiveSummary.metrics.physicalInventoryValue.available,false);assert.equal(data.executiveSummary.metrics.adjustedKardexTotalCost.available,false);
});
test('excludes only the four requested internal codes and preserves source records',()=>{
 const s=fixture();
 const codes=['6a43d03f8d79da0be6d748ee','6a0622b9cb89ca1b523aca41','6a0622b9cb89ca1b523aca42','6a0622b9cb89ca1b523aca43'];
 const original=[...s.daily];
 for(const code of [...codes,'6a0622b9cb89ca1b523aca44'])s.daily.push(...original.map(r=>({...r,code,name:code})));
 const snapshot=JSON.stringify(s);
 const r=countBoundaryReport(s,location,'2026-08-23','2026-08-30');
 assert.equal(r.itemCount,2);assert.equal(r.physicalFinalItems,2);
 assert.deepEqual(r.excluded.map(i=>i.code).sort(),codes.sort());
 assert.ok(r.excluded.every(i=>/Código interno/.test(i.reason)));
 assert.equal(JSON.stringify(s),snapshot);
});
