const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const {applyPurchaseReceiptWarehouses} = require('../purchase-receipts');
const {createPurchaseSync} = require('../toteat-purchases');
const {createApp} = require('../server');
const credential = {restaurantId: 'r', localId: '1', userId: 'u', token: 'test-only'};
const document = () => ({movement_id: '354057', document_id: '360', document_type: 'DISPATCH_GUIDE', movement_class: 'PROVIDERS',
  local_id: 1, provider: 'CEFFRA', provider_id: '763646696', provider_ref: 'supplier', emission_date: '20260929', received_date: '20260929', total_amount: 291600,
  products: [{sku: 'PAC003', product: 'Vaso Caliente 12 oz', warehouse: 2, received_quantity: 3600, received_measurement: 'UN',
    invoice_quantity: 3600, invoice_measurement: 'UN', unit_price: 81, total_price: 291600}]});
const source = () => ({restaurantId: 'r', localId: '1', localRef: 'branch', capturedAt: '2026-10-06T15:00:00Z', range: {from: '2026-09-01', to: '2026-10-06'},
  products: [{id: 'p', custom_id: 'PAC003'}], warehouses: [{id: 'central', custom_id: 1}, {id: 'local', custom_id: 2}],
  operations: {purchases: [{id: 354057, document: '360', receive_date: '2026-09-29', supplier_ref: 'supplier', warehouse_receive_ref: 'central',
    purchase_detail: [{id: 1418595, product_ref: 'p', quantity: 3600, measure_unit: 'UN', warehouse_ref: 'local'}]}]}});
function root(t) {const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-receipts-'));t.after(() => fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('PAC003 receipt 354057 overrides its stale product warehouse without changing quantities, costs or raw responses', () => {
  const doc = document(), native = source(), before = structuredClone({doc,native});
  const assigned = applyPurchaseReceiptWarehouses([doc], native, credential);
  const line = assigned.documents[0].products[0];
  assert.equal(line.warehouse, 1);assert.equal(line.warehouse_assignment.reportedWarehouse, 2);
  assert.equal(line.warehouse_assignment.mode, 'receipt');
  const {warehouse, warehouse_assignment, ...values} = line;
  const {warehouse: originalWarehouse, ...originalValues} = doc.products[0];
  assert.deepEqual(values, originalValues);assert.equal(assigned.documents[0].total_amount, 291600);
  assert.deepEqual({doc,native}, before);assert.equal(assigned.warnings[0].type, 'warehouse-receipt-assigned');
});

test('per-product mode preserves different warehouses and matches reordered lines and negative credit quantities', () => {
  const doc = document(), native = source();native.operations.purchases[0].warehouse_receive_ref = '0';
  doc.products.push({...doc.products[0],sku:'PAC004',received_quantity:-10,invoice_quantity:-10});
  native.products.push({id:'p2',custom_id:'PAC004'});
  native.operations.purchases[0].purchase_detail.unshift({product_ref:'p2',quantity:-10,measure_unit:'UN',warehouse_ref:'central'});
  const result = applyPurchaseReceiptWarehouses([doc],native,credential);
  assert.deepEqual(result.documents[0].products.map(l=>l.warehouse),[2,1]);
  assert.deepEqual(result.documents[0].products.map(l=>l.received_quantity),[3600,-10]);
  assert.ok(result.documents[0].products.every(l=>l.warehouse_assignment.mode==='product'));
});

test('wrong branch, missing receipt, mismatched quantity, unknown header and ambiguous per-product destination reject assignment', () => {
  const changes = [s=>{s.localId='2';},s=>{s.operations.purchases=[];},s=>{s.operations.purchases[0].purchase_detail[0].quantity=3599;},
    s=>{s.operations.purchases[0].warehouse_receive_ref='unknown';},s=>{s.operations.purchases[0].document='999';}];
  for(const change of changes){const native=source();change(native);assert.throws(()=>applyPurchaseReceiptWarehouses([document()],native,credential));}
  const doc=document(),native=source();doc.products.push({...doc.products[0]});native.operations.purchases[0].warehouse_receive_ref=null;
  native.operations.purchases[0].purchase_detail.push({...native.operations.purchases[0].purchase_detail[0],warehouse_ref:'central'});
  assert.throws(()=>applyPurchaseReceiptWarehouses([doc],native,credential),/ambiguo/);
});

test('sync, exports, reports and ledger use reception; future updates recheck and failures preserve last published version', async t => {
  const uploadsRoot=root(t),base=path.join(uploadsRoot,'.integrations/toteat-api');fs.mkdirSync(base,{recursive:true});
  fs.writeFileSync(path.join(base,'credentials.json'),JSON.stringify({'store-1':credential}));
  let native=source(),failed=false,reads=0;
  const app=createApp({uploadsRoot,sourceMode:'synchronized',toteatRequestSpacing:0,toteatSyncClock:()=> '2026-10-06',
    toteatApiFetch:async()=>Response.json({ok:true,data:{purchases:[document()]}}),
    toteatPurchaseReceiptReader:async(c,options)=>{assert.deepEqual(c,{restaurantId:'r',localId:'1'},'Brewit location names must not be used to select differently named Toteat restaurants');assert.equal(options.includePurchases,true);reads++;if(failed)throw Error('Recepciones no disponibles');return structuredClone(native);}});
  const sync=app.locals.toteatSalesSync.purchases;sync.configure('store-1',{from:'2026-09-29',enabled:false,intervalMinutes:60});
  await sync.synchronize('store-1');let state=sync.get('store-1');
  assert.equal(state.warehouseAuthority,'purchases-reception');assert.equal(state.documents[0].products[0].warehouse,1);
  assert.equal(Object.values(state.batches)[0][0].products[0].warehouse,2);
  const workbook=XLSX.readFile(sync.source('store-1','purchases')[0].filePath),row=XLSX.utils.sheet_to_json(workbook.Sheets['Compras API'])[0];
  assert.equal(row['API Bodega Toteat'],1);assert.equal(row['API Bodega reportada compras'],2);assert.equal(row['API Origen bodega'],'Bodega de recepción');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const [location,count] of [['main-warehouse',1],['store-1',0]]){
    const response=await fetch(`${origin}/api/purchases?location=${location}&dateFrom=2026-09-29&dateTo=2026-10-06`);const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.rows.length,count);
  }
  const products=[{id:'p',custom_id:'PAC003',stock_unit:'UN',stock_enabled:true}];
  const ledger=require('../toteat-stock').buildLedger({...source(),operations:{counts:[],transfers:[],transformations:[]}},products,{from:'2026-09-01',through:'2026-10-06',payments:[]},state);
  assert.deepEqual(ledger.movements.map(l=>[l.warehouse,l.quantity]),[['central',3600]]);
  const version=state.version;failed=true;await assert.rejects(sync.synchronize('store-1'),/Recepciones/);assert.equal(sync.get('store-1').version,version);
  failed=false;native.operations.purchases=[];await assert.rejects(sync.synchronize('store-1'),/Falta la recepción/);assert.equal(sync.get('store-1').version,version);
  native=source();await sync.synchronize('store-1');assert.equal(sync.get('store-1').documents[0].products[0].warehouse,1);
  native.operations.purchases[0].warehouse_receive_ref='0';await sync.synchronize('store-1');assert.equal(sync.get('store-1').documents[0].products[0].warehouse,2);
  assert.equal(reads,5);
  native=source();
  const refresh=await fetch(`${origin}/api/uploads/refresh-source`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'store-1',key:'purchases'})});
  assert.equal(refresh.status,202,JSON.stringify(await refresh.json()));
  let job;
  for(let attempt=0;attempt<50;attempt++){
    job=(await fetch(`${origin}/api/uploads/overview`).then(r=>r.json())).job;
    if(!job.running)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(job.running,false);assert.equal(job.summary.complete,1,JSON.stringify(job));
  assert.equal(sync.get('store-1').documents[0].products[0].warehouse,1,'Cargar Archivos must honor the receipt header');
  assert.equal(reads,6);
});

test('saved history is rebuilt from originals, is durable after restart, and comparison cannot undo reception assignment', async t => {
  const uploadsRoot=root(t);const sync=createPurchaseSync({uploadsRoot,activeLocation:()=>({type:'store'}),credentials:()=>({'store-1':credential}),clock:()=> '2026-10-06',request:async()=>({data:{purchases:[document()]}})});
  sync.configure('store-1',{from:'2026-09-29',enabled:false,intervalMinutes:60});await sync.synchronize('store-1');const old=sync.get('store-1');
  assert.equal(old.documents[0].products[0].warehouse,2);
  let assigned=sync.reconcileReceiptSource('store-1',source());assert.equal(assigned.documents[0].products[0].warehouse,1);assert.deepEqual(assigned.batches,old.batches);
  const inventory={from:'2026-09-29',to:'2026-09-29',data:[{sku:'PAC003',unit:'UN',warehouses:[{warehouse_id:2,inventory:[{date:'20260929',purchase:3600}]}]}]};
  assigned=sync.reconcileSaved('store-1',{restaurantId:'r',localId:'1',batches:[inventory]});assert.equal(assigned.documents[0].products[0].warehouse,1);
  const version=assigned.version;assert.throws(()=>sync.reconcileReceiptSource('store-1',{...source(),localId:'2'}),/no corresponde/);assert.equal(sync.get('store-1').version,version);
  const restored=createPurchaseSync({uploadsRoot,activeLocation:()=>({type:'store'}),credentials:()=>({'store-1':credential})}).get('store-1');assert.equal(restored.version,version);assert.equal(restored.documents[0].products[0].warehouse,1);
  await assert.rejects(sync.synchronize('store-1'), /verificación de recepciones/);
  assert.equal(sync.get('store-1').version,version, 'a synchronizer without reception verification must never downgrade verified history');
});
