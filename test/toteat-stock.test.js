const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeOperations,buildLedger,createStockSync}=require('../toteat-stock');
const products=[{id:'coffee',custom_id:'C',types:['INGREDIENT'],stock_enabled:true,stock_unit:'KG',name:{translations:{default:'Café'}}},{id:'sandwich',custom_id:'S',types:['PRODUCT'],stock_enabled:true,stock_unit:'UN',recipe:{quantity:1,portions_per_unit:1,ingredients:[{custom_id:'C',quantity:100,quantity_unit:'G',yield_rate:100}]}}];
const source=()=>({restaurantId:'r',localId:'1',localRef:'l1',capturedAt:'2026-09-22T01:00:00Z',range:{from:'2026-08-23',to:'2026-08-24'},products,warehouses:[{id:'w1',custom_id:1},{id:'w2',custom_id:2},{id:'w3',custom_id:3}],operations:{counts:[{id:1,status:'APPROVED',registration_date:'2026-08-23 00:00:00',warehouse_ref:'w2',take_inventory_products:[{id:1,product_ref:'coffee',quantity:1,measure_unit_ref:'KG'},{id:2,product_ref:'sandwich',quantity:0,measure_unit_ref:'UN'}]}],transfers:[],transformations:[]}});
const empty={from:'2026-08-23',through:'2026-08-24',documents:[],payments:[]};
test('a master unit change keeps original records and excludes only the unconvertible product',()=>{
 const s=source(),canonical=products.map(p=>p.custom_id==='C'?{...p,stock_unit:'BOT',conversions:[]}:p);
 const before=JSON.stringify(s),ledger=buildLedger(s,canonical,empty,empty);
 assert.equal(JSON.stringify(s),before);assert.ok(ledger.issues.some(i=>i.kind==='unit-conversion'&&i.code==='C'));
 assert.equal(ledger.operationLines.find(l=>l.code==='C').originalQuantity,1);
 assert.equal(ledger.operationLines.find(l=>l.code==='C').unit,'KG');assert.equal(ledger.operationLines.find(l=>l.code==='C').active,false);
 assert.equal(ledger.daily.some(r=>r.code==='C'),false);assert.equal(ledger.daily.find(r=>r.code==='S').opening,0);
 assert.deepEqual(ledger.excluded.map(i=>i.code),['C']);
 const report=require('../inventory-boundaries').countBoundaryReport({...ledger,warehouses:s.warehouses},{type:'store'},'2026-08-23','2026-08-25');
 assert.deepEqual(report.excluded.map(i=>i.code),['C']);assert.deepEqual(report.items.map(i=>i.code),['S']);
 canonical[0].conversions=[{conversion_unit:'KG',base_unit:'BOT',numerator:1,denominator:2}];
 const resolved=buildLedger(s,canonical,empty,empty);assert.equal(resolved.excluded.length,0);assert.equal(resolved.daily.find(r=>r.code==='C').opening,.5);
});
test('a failed dependency rebuild preserves the last version and status remains readable until recovery',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-rebuild-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let master={observedAt:'v1',products:products.map(p=>({...p,code:p.custom_id,stockManaged:p.stock_enabled,stockUnit:p.stock_unit,name:p.custom_id}))};
 const sync=createStockSync({uploadsRoot:root,activeLocation:()=>({type:'store'}),credentials:()=>({'store-1':{restaurantId:'r',localId:'1'}}),masters:()=>master});
 sync.publish('store-1',source());const original=sync.current('store-1'),pointer=path.join(root,'.integrations/toteat-api/stock/store-1/current.json'),version=fs.readFileSync(pointer,'utf8');
 master=null;
 for(let i=0;i<3;i++){assert.match(sync.status('store-1').error,/Se conserva/);assert.deepEqual(sync.current('store-1').daily,original.daily);}
 assert.equal(fs.readFileSync(pointer,'utf8'),version);
 master={observedAt:'v2',products:products.map(p=>({...p,code:p.custom_id,stockManaged:p.stock_enabled,stockUnit:p.stock_unit,name:p.custom_id}))};
 assert.equal(sync.status('store-1').error,null);assert.equal(sync.current('store-1').masterObservedAt,'v2');
});
test('corrected purchase warehouse replaces old local receipts automatically without reading Toteat Kardex',t=>{
 const uploadsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-independent-'));t.after(()=>fs.rmSync(uploadsRoot,{recursive:true,force:true}));
 const base=path.join(uploadsRoot,'.integrations/toteat-api/purchases/store-1');
 const purchase=(version,warehouse)=>{fs.mkdirSync(path.join(base,version),{recursive:true});fs.writeFileSync(path.join(base,version,'state.json'),JSON.stringify({...empty,version,documents:[{movement_id:'22978',received_date:'20260823',products:[{sku:'C',warehouse,received_quantity:3.4,received_measurement:'KG'}]}]}));fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({version}));};
 const sync=createStockSync({uploadsRoot,activeLocation:()=>({type:'store'}),credentials:()=>({'store-1':{restaurantId:'r',localId:'1'}}),masters:()=>({observedAt:'now',products:products.map(p=>({...p,code:p.custom_id,stockManaged:p.stock_enabled,stockUnit:p.stock_unit,name:p.custom_id}))}),reader:()=>{throw Error('No remote read required');}});
 purchase('v1',2);sync.publish('store-1',source());assert.equal(sync.current('store-1').daily.find(r=>r.code==='C'&&r.warehouse==='w2').purchase,3.4);
 purchase('v2',1);const updated=sync.current('store-1');assert.equal(updated.sourceKind,'native-documents');assert.equal(updated.daily.find(r=>r.code==='C'&&r.warehouse==='w2').purchase,0);assert.equal(updated.daily.find(r=>r.code==='C'&&r.warehouse==='w1').purchase,3.4);assert.equal(updated.dependencies.purchases,'v2');assert.deepEqual(sync.current('store-1').daily,updated.daily);
});
test('stock sales consume finished units; transformation consumes original ingredient lines exactly once',()=>{
 const s=source();s.operations.transformations=[{id:2,status:'APPROVED',local_ref:'l1',registration_date:'2026-08-23',product_ref:'sandwich',quantity_produce:3,measure_unit:'UN',target_warehouse_ref:'w2',transformation_details:[{id:3,product_ref:'coffee',warehouse_ref:'w2',quantity:250,measure_unit:'G'}]}];
 const sales={...empty,payments:[{orderId:1,dateClosed:'2026-08-23T15:00:00',products:[{id:'S',lineId:1,quantity:1}]}]};const r=buildLedger(s,products,sales,empty),d=r.daily.filter(r=>r.date==='2026-08-23');assert.equal(d.find(r=>r.code==='C').closing,.75);assert.equal(d.find(r=>r.code==='S').closing,2);assert.equal(d.find(r=>r.code==='C').use,0);
});
test('transfers balance, preserve identical legitimate lines and pending counts never change stock',()=>{
 const s=source();s.operations.transfers=[{id:7,status:'APPROVED',registration_date:'2026-08-23',warehouse_ref:'w2',warehouse_receive_ref:'w3',take_inventory_products:[{id:10,product_ref:'coffee',quantity:.1,measure_unit_ref:'KG'},{id:11,product_ref:'coffee',quantity:.1,measure_unit_ref:'KG'}]}];s.operations.counts.push({id:8,status:'CREATED',registration_date:'2026-08-24',warehouse_ref:'w2',take_inventory_products:[{id:12,product_ref:'coffee',quantity:10,measure_unit_ref:'KG'}]});const r=buildLedger(s,products,empty,empty);assert.equal(r.operationLines.filter(l=>l.source==='transfers').length,4);assert.equal(r.daily.find(r=>r.code==='C'&&r.warehouse==='w2'&&r.date==='2026-08-24').closing,.8);assert.equal(r.daily.find(r=>r.warehouse==='w3').closing,null);
});
test('physical count resets balance once and exposes discrepancy; negative received quantities reduce stock',()=>{
 const s=source();s.operations.counts.push({id:8,status:'APPROVED',registration_date:'2026-08-24',warehouse_ref:'w2',take_inventory_products:[{id:12,product_ref:'coffee',quantity:.5,measure_unit_ref:'KG'}]});const purchases={...empty,documents:[{movement_id:'p1',received_date:'20260823',products:[{sku:'C',warehouse:2,received_quantity:-.1,received_measurement:'KG'}]}]};const r=buildLedger(s,products,empty,purchases);const row=r.daily.find(r=>r.code==='C'&&r.date==='2026-08-24');assert.equal(row.opening,.5);assert.equal(row.closing,.5);assert.equal(row.adjustment,-.4);
});
test('ambiguous sales and unknown references are visible, not fabricated',()=>{
 const s=source();s.operations.counts[0].take_inventory_products.push({id:3,product_ref:'retired',quantity:1,measure_unit_ref:'UN'});const sales={...empty,payments:[{orderId:1,dateClosed:'2026-08-23T15:00:00',products:[{id:'S',lineId:1,lineReference:2,quantity:1}]}]};const r=buildLedger(s,products,sales,empty);assert.ok(r.issues.some(i=>i.kind==='missing-master'));assert.ok(r.issues.some(i=>i.kind==='sale-excluded'));assert.equal(r.daily.find(r=>r.code==='S').use,0);assert.equal(r.mode,'independent');
});
test('duplicate documents, wrong local and unknown warehouses fail closed',()=>{
 let s=source();s.operations.counts.push(s.operations.counts[0]);assert.throws(()=>normalizeOperations(s,products),/identidad/);s=source();s.operations.counts[0].warehouse_ref='foreign';assert.throws(()=>normalizeOperations(s,products),/Bodega/);s=source();s.operations.counts[0].local_ref='other';assert.throws(()=>normalizeOperations(s,products),/otro local/);
});
test('atomic version replacement is idempotent, preserves previous generation on failed source',async t=>{
 const uploadsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-stock-'));t.after(()=>fs.rmSync(uploadsRoot,{recursive:true,force:true}));const masters=()=>({observedAt:'now',products:products.map(p=>({...p,code:p.custom_id,stockManaged:p.stock_enabled,stockUnit:p.stock_unit,name:p.custom_id}))});const sync=createStockSync({uploadsRoot,activeLocation:id=>id==='store-1'?{type:'store'}:null,credentials:()=>({'store-1':{restaurantId:'r',localId:'1'}}),masters,reader:async()=>{throw Error('offline');}});sync.publish('store-1',source());const first=sync.current('store-1');sync.publish('store-1',source());assert.deepEqual(sync.current('store-1').daily,first.daily);await assert.rejects(sync.synchronize('store-1',source().range));assert.deepEqual(sync.current('store-1').daily,first.daily);assert.ok(sync.status('store-1').error);assert.throws(()=>sync.publish('store-1',{...source(),localId:'2'}),/no corresponde/);assert.throws(()=>sync.status('../secret'),/activo/);
});
test('transformation ledger preserves full precision while posting each input at three decimals',()=>{
 const s=source();s.operations.transformations=[{id:2,status:'APPROVED',registration_date:'2026-08-23',product_ref:'sandwich',quantity_produce:3,measure_unit:'UN',target_warehouse_ref:'w2',transformation_details:[{id:3,product_ref:'coffee',warehouse_ref:'w2',quantity:.1123456,measure_unit:'KG'},{id:4,product_ref:'coffee',warehouse_ref:'w2',quantity:.1123456,measure_unit:'KG'}]}];const r=buildLedger(s,products,empty,empty);assert.equal(r.daily.find(r=>r.code==='C').transformed_out,.224);assert.equal(r.operationLines.find(l=>l.column==='transformed_out').exactQuantity,.1123456);
});
test('extra sales include base and replacement once, leaving compensation to the report',()=>{
 const s=source();const p=[...products,{id:'drink',custom_id:'D',stock_enabled:false,stock_unit:'UN',types:['PRODUCT'],recipe:{quantity:1,portions_per_unit:1,ingredients:[{custom_id:'C',quantity:200,quantity_unit:'G',yield_rate:100}]}},{id:'extra',custom_id:'X',stock_enabled:false,stock_unit:'UN',types:['EXTRA'],recipe:{quantity:1,portions_per_unit:1,ingredients:[{custom_id:'C',quantity:50,quantity_unit:'G',yield_rate:100}]}}];
 const sales={...empty,payments:[{orderId:1,dateClosed:'2026-08-23T15:00:00',products:[{id:'D',lineId:1,quantity:2},{id:'X',lineId:2,lineReference:1,quantity:1}]}]};const r=buildLedger(s,p,sales,empty);assert.equal(r.daily.find(r=>r.code==='C').use,.45);assert.deepEqual(r.includedOrders,['1']);assert.equal(r.issues.filter(i=>i.kind==='sale-excluded').length,0);assert.equal(r.salesConsumptionPolicy,'base-plus-extras-before-compensation-v1');
});

test('independent counts rebuild the ledger and close the next day without extending movement coverage',t=>{
 const uploadsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-count-dependency-'));t.after(()=>fs.rmSync(uploadsRoot,{recursive:true,force:true}));
 const config={uploadsRoot,activeLocation:()=>({type:'store'}),credentials:()=>({'store-1':{restaurantId:'r',localId:'1'}})};
 const sync=createStockSync({...config,masters:()=>({observedAt:'now',products:products.map(p=>({...p,code:p.custom_id,stockManaged:p.stock_enabled,stockUnit:p.stock_unit,name:p.custom_id}))})});
 const original=source();original.capturedAt='2026-09-21T00:00:00Z';sync.publish('store-1',original);
 const counts=require('../toteat-counts').createCountSync(config);
 const fresh=source();fresh.range.to='2026-08-25';fresh.operations.counts.push({...fresh.operations.counts[0],id:2,registration_date:'2026-08-25',take_inventory_products:[{id:3,product_ref:'coffee',quantity:0,measure_unit_ref:'KG'}]});
 counts.publish('store-1',fresh);
 let state=sync.current('store-1');assert.equal(state.range.to,'2026-08-24');assert.equal(state.daily.find(r=>r.date==='2026-08-25'&&r.code==='C').physicalCount,true);
 const report=()=>require('../inventory-boundaries').countBoundaryReport(sync.current('store-1'),{type:'store'},'2026-08-23','2026-08-25');
 assert.equal(report().items.find(i=>i.code==='C').finalInventory,0);assert.equal(report().items.find(i=>i.code==='S').finalInventory,null);
 const version=state.dependencies.counts;assert.ok(version);assert.equal(sync.current('store-1').dependencies.counts,version);
 assert.throws(()=>require('../inventory-boundaries').countBoundaryReport(state,{type:'store'},'2026-08-23','2026-08-26'),/cubrir/);
 fresh.operations.counts[1].status='CANCELLED';counts.publish('store-1',fresh);
 assert.equal(report().items.find(i=>i.code==='C').finalInventory,null);
 fresh.operations.counts.pop();counts.publish('store-1',fresh);assert.equal(report().items.find(i=>i.code==='C').finalInventory,null);
});
