// Synthetic source checks: no real credentials or provider requests.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const repo=path.resolve(__dirname,'../../..'),work=fs.readFileSync('/private/tmp/brewit-audit-current.txt','utf8').trim();
if(!work.startsWith('/private/tmp/brewit-audit-20261024-'))throw Error('Private audit root required');
for(const key of ['BREWIT_DATABASE_URL','BREWIT_TEST_DATABASE_URL','BREWIT_AUTH_KEY','BREWIT_REQUIRE_AUTH'])delete process.env[key];
const {createSalesSync}=require(path.join(repo,'toteat-sales'));
const {createPurchaseSync}=require(path.join(repo,'toteat-purchases'));
const history=require(path.join(repo,'historical-control'));
const XLSX=require(path.join(repo,'record-workbooks'));
const result={sales:[],purchases:[],mercadoPago:[],checks:[]};
const credentials=()=>({'store-1':{localId:'1',restaurantId:'r',userId:'u',token:'audit'},'store-2':{localId:'2',restaurantId:'r',userId:'u',token:'audit'}});
const activeLocation=id=>({id,type:'store'});
const compact=day=>day.replaceAll('-','');
const payment=(id,day='2026-10-23',amount=1190)=>({orderId:'o'+id,paymentId:'p'+id,dateOpen:day+'T12:00:00Z',dateClosed:day+'T12:03:00Z',total:amount,discounts:0,taxes:190,gratuity:0,payed:amount,change:0,fiscalId:id,fiscalType:'BE',products:[{id:'B1',lineId:'l'+id,lineReference:0,quantity:1,payed:amount,discounts:0,taxes:190,totalCost:500,netPrice:amount,name:'Producto sintético',hierarchyId:'AB.01'}],paymentForms:[{id:1000,name:'CASH',amount,tip:0}]});
async function main(){
  for(let repetition=0;repetition<5;repetition++){
    const uploadsRoot=fs.mkdtempSync(path.join(work,'synthetic-sales-'));let calls=[],fail=false,oldAmount=1190;
    const data=Array.from({length:2000},(_,i)=>payment(i+1));
    const sync=createSalesSync({uploadsRoot,activeLocation,credentials,clock:()=>'2026-10-24',request:async(c,route,params)=>{
      calls.push({local:c.localId,route,...params});if(fail)throw Error('Synthetic timeout');
      if(route==='shiftstatus')return {ok:true,data:{status:'closed',localNumber:c.localId}};
      assert.equal(route,'sales');
      const rows=c.localId==='1'?[payment('old','2026-05-19',oldAmount),...data]:[];
      return {ok:true,data:rows.filter(p=>compact(p.dateOpen.slice(0,10))>=params.ini&&compact(p.dateOpen.slice(0,10))<=params.end)};
    }});
    for(const id of ['store-1','store-2'])sync.configure(id,{from:'2026-05-18',enabled:false,intervalMinutes:5});
    for(const [caseName,options]of [['initial',{}],['unchanged',{}],['old-correction-incremental',{}],['old-correction-full',{full:true}]]){
      if(caseName==='old-correction-incremental')oldAmount=2380;
      calls=[];const previous=sync.get('store-1')?.version,start=performance.now();
      await sync.synchronize('store-1',options);
      const state=sync.get('store-1');result.sales.push({repetition,case:caseName,ms:performance.now()-start,calls:calls.length,salesCalls:calls.filter(c=>c.route==='sales').length,versionChanged:previous!==state.version,payments:state.payments.length,oldAmount:state.payments.find(p=>p.paymentId==='pold').total});
      if(caseName==='unchanged')assert.equal(state.version,previous);
      if(caseName==='old-correction-incremental')assert.equal(state.payments.find(p=>p.paymentId==='pold').total,1190);
      if(caseName==='old-correction-full')assert.equal(state.payments.find(p=>p.paymentId==='pold').total,2380);
      await history.get(uploadsRoot).idle();
    }
    const version=sync.get('store-1').version;fail=true;await assert.rejects(sync.synchronize('store-1'));assert.equal(sync.get('store-1').version,version);fail=false;
    await Promise.all([sync.synchronize('store-1'),sync.synchronize('store-2')]);assert.equal(sync.get('store-2').payments.length,0);
    result.checks.push({case:'failure-preserves-version-and-empty-second-store',repetition,pass:true});
    await history.get(uploadsRoot).idle();
  }
  for(let repetition=0;repetition<5;repetition++) {
    const uploadsRoot=fs.mkdtempSync(path.join(work,'synthetic-purchases-'));let calls=[],receiptRanges=[];
    const doc={movement_id:'m1',movement_class:'PROVIDERS',local_id:1,provider:'Proveedor sintético',provider_id:'761111523',document_id:'0012',document_type:'STANDARD_INVOICE',emission_date:'20260519',total_amount:1001,products:[{sku:'SAN01',product_id:99,product:'Producto',invoice_quantity:3,received_quantity:2,invoice_measurement:'KG',received_measurement:'KG',unit_price:333,total_price:1001,warehouse:2}]};
    const sync=createPurchaseSync({uploadsRoot,activeLocation,credentials,clock:()=>'2026-10-24',request:async(c,route,p)=>{calls.push({route,...p});return {ok:true,data:{purchases:doc.emission_date>=p.initial_date&&doc.emission_date<=p.final_date?[doc]:[]}};},receiptReader:async(c,range)=>{
      receiptRanges.push({from:range.from,to:range.to});return {restaurantId:'r',localId:'1',range,products:[{id:'p',custom_id:'SAN01'}],warehouses:[{id:'local',custom_id:2}],operations:{purchases:[{id:'m1',document:'0012',receive_date:'2026-05-19',warehouse_receive_ref:'local',purchase_detail:[{product_ref:'p',quantity:2,measure_unit:'KG',warehouse_ref:'local'}]}]}};
    }});
    sync.configure('store-1',{from:'2026-05-18',enabled:false,intervalMinutes:15});
    for(const caseName of ['initial','unchanged']){
      calls=[];receiptRanges=[];const previous=sync.get('store-1')?.version,start=performance.now();await sync.synchronize('store-1');
      result.purchases.push({repetition,case:caseName,ms:performance.now()-start,apiCalls:calls.length,receiptRanges,versionChanged:previous!==sync.get('store-1').version});
      await history.get(uploadsRoot).idle();
    }
  }
  const {createApp}=require(path.join(repo,'server'));
  for(let repetition=0;repetition<5;repetition++){
    const uploadsRoot=fs.mkdtempSync(path.join(work,'synthetic-mp-'));let amount=1000,downloads=0;
    const app=createApp({uploadsRoot,enableToteatSync:false,enableMercadoPagoSync:false,storageMaintenance:false,mercadoPagoClock:()=>new Date('2026-10-24T12:00:00Z'),mercadoPagoBrowser:{async download({directory}){
      downloads++;const target=path.join(directory,'report.csv');
      fs.writeFileSync(target,'STORE_ID;SOURCE_ID;TRANSACTION_TYPE;TRANSACTION_DATE;TRANSACTION_AMOUNT;REAL_AMOUNT;FEE_AMOUNT\n82010740;audit-correction;SETTLEMENT;2026-10-23T10:00:00-03:00;1190;'+amount+';190');
      return [{path:target,period:{from:'2026-10-23',to:'2026-10-23'}}];
    },async close(){}}});
    const service=app.locals.mercadoPagoSync;
    for(const caseName of ['initial','unchanged','same-id-correction']){
      if(caseName==='same-id-correction')amount=900;
      const start=performance.now();const state=await service.synchronize();
      assert.equal(state.status,'complete',state.message);
      result.mercadoPago.push({repetition,case:caseName,ms:performance.now()-start,downloads,result:state.result});
      await history.get(uploadsRoot).idle();
    }
    let amounts=[];
    function inspect(dir){if(!fs.existsSync(dir))return;for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,ent.name);if(ent.isDirectory())inspect(file);else if(ent.name.endsWith('.records.json')){
      const book=XLSX.readFile(file.slice(0,-'.records.json'.length));for(const sheet of Object.values(book.Sheets))for(const row of XLSX.utils.sheet_to_json(sheet))if(row.SOURCE_ID==='audit-correction')amounts.push(row.REAL_AMOUNT);
    }}}
    inspect(path.join(uploadsRoot,'transactions'));inspect(path.join(uploadsRoot,'weeks'));
    result.checks.push({case:'mp-correction-stored-amount',repetition,incoming:900,stored:amounts});
    assert.deepEqual(amounts,[1000]);await service.close();
  }
}
main().then(()=>{fs.writeFileSync(path.join(work,'synthetic-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({sales:result.sales.length,purchases:result.purchases.length,mercadoPago:result.mercadoPago.length,checks:result.checks}));}).catch(e=>{fs.writeFileSync(path.join(work,'synthetic-results.json'),JSON.stringify({...result,failure:e.stack},null,2));console.error(e);process.exitCode=1;});
