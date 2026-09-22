// Public inventory aggregates. Never reconstruct API quantities from current recipes.
const advance=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const fields=['purchase','use','transfer_local_in','transfer_local_out','transfer_warehouse_in','transfer_warehouse_out','transformed_in','transformed_out'];
const net=r=>r.purchase+r.transfer_local_in+r.transfer_warehouse_in+r.transformed_in-r.use-r.transfer_local_out-r.transfer_warehouse_out-r.transformed_out;
const {inventoryExclusion}=require('./inventory-exclusions');
async function readPublicInventory(request,config,{from,to},warehouses=[]) {
 const batches=[];
 // Small complete windows respect the same shared request queue as sales/purchases.
 for(let start=from;start<=to;start=advance(start,8)) {
  const end=advance(start,7)<to?advance(start,7):to;
  const payload=await request(config,'inventorystate',{initial_date:start.replaceAll('-',''),final_date:end.replaceAll('-','')});
  if(payload.ok!==true||!Array.isArray(payload.data))throw Error('Respuesta de inventario incompleta.');
  batches.push({from:start,to:end,data:payload.data});
 }
 return {kind:'public-inventory',restaurantId:config.restaurantId,localId:config.localId,range:{from,to},capturedAt:new Date().toISOString(),warehouses,batches};
}
function buildPublicInventory(source) {
 const issues=[],daily=[],series=new Map(),warehouses=new Map((source.warehouses||[]).map(w=>[String(w.custom_id),w]));
 const reported=new Set();
 for(const batch of source.batches)for(const product of batch.data) {
  if(!product.sku||!product.product_id||inventoryExclusion(product.sku)) {issues.push({kind:'excluded-identity',message:'Registro sin identidad de inventario utilizable; conservado en la respuesta original.'});continue;}
  if(!product.unit||!Array.isArray(product.warehouses))throw Error('Producto de API sin unidad o bodegas.');
  for(const wh of product.warehouses) {
   if(wh.warehouse_id==null||!Array.isArray(wh.inventory))throw Error('Bodega de API sin detalle diario.');
   const code=String(wh.warehouse_id);reported.add(code);
   if(!warehouses.has(code))warehouses.set(code,{id:`api:${source.localId}:${code}`,custom_id:Number(code),name:`Bodega ${code} · local ${source.localId}`});
   const warehouse=warehouses.get(code),key=`${warehouse.id}|${product.sku}|${product.unit}`;
   if(!series.has(key))series.set(key,new Map());const rows=series.get(key);
   for(const r of wh.inventory) {
    const date=String(r.date).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date<batch.from||date>batch.to)throw Error('Fecha fuera de la ventana solicitada.');
    if(rows.has(date))throw Error('Fila diaria duplicada en la API.');
    for(const f of [...fields,'initial_inventory','final_inventory','cost_last_inbound','day_net_movement'])if(typeof r[f]!=='number'||!Number.isFinite(r[f]))throw Error('Valor de inventario inválido en la API.');
    if(typeof r.is_taken!=='boolean')throw Error('Marca de toma física inválida.');
    if(Math.abs(net(r)-r.day_net_movement)>1e-6)throw Error('Los movimientos de API no explican el movimiento neto. Se conserva la versión anterior.');
    if(Math.abs(r.initial_inventory+net(r)-r.final_inventory)>1e-6)issues.push({kind:'api-balance-discrepancy',code:String(product.sku),warehouse:warehouse.id,date,reported:r.final_inventory,calculated:r.initial_inventory+net(r),delta:r.final_inventory-r.initial_inventory-net(r),message:'El saldo final informado por API difiere del inicial más movimientos. Se conservan ambos valores sin inventar un ajuste.'});
    const row={code:String(product.sku),name:product.product||String(product.sku),unit:product.unit,warehouse:warehouse.id,date,opening:r.initial_inventory,closing:r.final_inventory,calculatedClosing:r.initial_inventory+net(r),physicalCount:r.is_taken,costLastInbound:r.cost_last_inbound,estimated:false,adjustment:null,...Object.fromEntries(fields.map(f=>[f,r[f]]))};
    rows.set(date,row);
   }
  }
 }
 for(const rows of series.values()) {
  const actual=[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));let previous=null;
  for(let i=0;i<actual.length;i++) {
   const row=actual[i];
   if(previous) {
    const gap=advance(previous.date,1)<row.date;
    const continuous=Math.abs(previous.closing-row.opening)<=1e-6;
    // A missing day is carried only when both observed endpoints agree.
    if(gap&&(continuous||row.physicalCount))for(let date=advance(previous.date,1);date<row.date;date=advance(date,1))daily.push({...previous,date,opening:previous.closing,closing:previous.closing,calculatedClosing:previous.closing,physicalCount:false,initialRecord:false,adjustment:0,carriedForward:true,...Object.fromEntries(fields.map(f=>[f,0]))});
    if(gap&&!continuous&&!row.physicalCount)issues.push({kind:'coverage',code:row.code,date:row.date,message:'Días omitidos con cambio de saldo; no se inventan movimientos ni saldos intermedios.'});
    if(!continuous&&!row.physicalCount)issues.push({kind:'balance-discontinuity',code:row.code,date:row.date,message:'Cambio de apertura sin marca de toma; requiere conciliación.'});
    row.adjustment=row.physicalCount?row.opening-previous.closing:0;
   }
   row.initialRecord=i===0;daily.push(row);previous=row;
  }
  // A successful complete window has no reported movements on omitted trailing days.
  if(previous)for(let date=advance(previous.date,1);date<=source.range.to;date=advance(date,1))daily.push({...previous,date,opening:previous.closing,closing:previous.closing,calculatedClosing:previous.closing,physicalCount:false,initialRecord:false,adjustment:0,carriedForward:true,...Object.fromEntries(fields.map(f=>[f,0]))});
 }
 for(const [code,w]of warehouses)if(!reported.has(code))issues.push({kind:'warehouse-not-returned',warehouse:w.id,message:`${w.name}: sin filas devueltas por la API en el período; no equivale a inventario cero.`});
 return {mode:'api',sourceKind:'public-inventory',range:source.range,sourceCapturedAt:source.capturedAt,warehouses:[...warehouses.values()],daily:daily.sort((a,b)=>a.date.localeCompare(b.date)),documents:[],operationLines:[],movements:daily.flatMap(r=>fields.filter(f=>r[f]!==0).map(f=>({code:r.code,name:r.name,unit:r.unit,warehouse:r.warehouse,date:r.date,column:f,quantity:r[f],source:'public-inventory',active:true}))),issues,salesConsumptionPolicy:'toteat-api-before-brewit-compensation',assumptions:['Cantidades y costo de última compra recibidos de la API pública Toteat; se conservan los ceros y signos originales.','Datos agregados por producto, bodega y día; no son documentos individuales de inventario.','Días sin movimientos informados arrastran el último saldo: entre extremos iguales, antes de una nueva toma y al cierre de la consulta completa. Cambios sin toma dejan una incidencia de cobertura. No se infieren tomas físicas.','Las compensaciones y consumos internos de Brewit se aplican una sola vez en el informe.']};
}
function publicInventoryCostResolver(state,warehouseCode,cutoff,convertQuantity,{positiveOnly=false}={}) {
 const warehouse=state.warehouses.find(w=>Number(w.custom_id)===warehouseCode),latest=new Map();
 for(const row of state.daily)if(row.warehouse===warehouse?.id&&row.date<=cutoff&&(!positiveOnly||row.costLastInbound>0)&&(!latest.has(row.code)||latest.get(row.code).date<row.date))latest.set(row.code,row);
 return {dateTo:cutoff,resolve(code,unit) {const row=latest.get(String(code));const factor=row?convertQuantity(1,unit||row.unit,row.unit):null;
  if(!row||factor==null||!Number.isFinite(row.costLastInbound))return {unitCost:0,source:'missing',sourceDate:null};
  return {unitCost:row.costLastInbound*factor,source:'toteat-api',sourceDate:row.date};
 }};
}
module.exports={readPublicInventory,buildPublicInventory,publicInventoryCostResolver};
