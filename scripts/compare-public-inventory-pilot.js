// Offline analysis: never publishes sources or changes credentials.
const fs=require('fs'),path=require('path'),XLSX=require('xlsx');
const {compareFiles}=require('./toteat-inventory-pilot');
const root=path.resolve(__dirname,'../uploads'),dir=path.join(root,'reports/inventory/public-api-pilot-2026-08-23_2026-08-30');
const payload=JSON.parse(fs.readFileSync(path.join(dir,'response.json')));
if(payload.ok!==true||!Array.isArray(payload.data))throw Error('La API no entregó inventario válido.');
const stockRoot=path.join(root,'.integrations/toteat-api/stock/store-1'),version=process.argv[2]||JSON.parse(fs.readFileSync(path.join(stockRoot,'current.json'))).version,state=JSON.parse(fs.readFileSync(path.join(stockRoot,version,'state.json')));
const fields={initial_inventory:'opening',final_inventory:'closing',purchase:'purchase',use:'use',transfer_local_in:'transfer_local_in',transfer_local_out:'transfer_local_out',transfer_warehouse_in:'transfer_warehouse_in',transfer_warehouse_out:'transfer_warehouse_out',transformed_in:'transformed_in',transformed_out:'transformed_out',cost_last_inbound:'costLastInbound'};
const unidentified=payload.data.filter(p=>!p.sku||!p.product_id),daily=[],identities=new Set(),duplicates=[],invalid=[],math=[],byWarehouse={},keys=new Set();
for(const product of payload.data.filter(p=>p.sku&&p.product_id))for(const wh of product.warehouses){
 const warehouse=state.warehouses.find(w=>Number(w.custom_id)===Number(wh.warehouse_id));if(!warehouse)throw Error('Bodega no mapeada');
 byWarehouse[wh.warehouse_id]??={name:warehouse.name,products:0,days:0,takes:0};byWarehouse[wh.warehouse_id].products++;
 for(const row of wh.inventory){
  Object.keys(row).forEach(k=>keys.add(k));const date=String(row.date).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');const key=`${product.sku}|${warehouse.id}|${date}`;
  if(identities.has(key))duplicates.push(key);identities.add(key);
  const item={code:product.sku,name:product.product,unit:product.unit,warehouse:warehouse.id,date,physicalCount:row.is_taken};
  for(const [api,local]of Object.entries(fields)){item[local]=row[api];if(!Number.isFinite(row[api]))invalid.push({key,field:api});}
  const net=row.purchase+row.transfer_local_in+row.transfer_warehouse_in+row.transformed_in-row.use-row.transfer_local_out-row.transfer_warehouse_out-row.transformed_out;
  for(const [check,delta]of [['closing',row.final_inventory-row.initial_inventory-net],['net',row.day_net_movement-net]])if(Math.abs(delta)>1e-6)math.push({code:product.sku,warehouse:wh.warehouse_id,date,check,delta});
  daily.push(item);byWarehouse[wh.warehouse_id].days++;if(row.is_taken)byWarehouse[wh.warehouse_id].takes++;
 }
}
const index=new Map(state.daily.map(r=>[`${r.code}|${r.warehouse}|${r.date}`,r])),stats={},diff=[],missing=[];
for(const row of daily){const base=index.get(`${row.code}|${row.warehouse}|${row.date}`);if(!base){missing.push({code:row.code,warehouse:row.warehouse,date:row.date,reason:'Sin fila local'});continue;}if(String(base.unit).toUpperCase()!==String(row.unit).toUpperCase()){missing.push({code:row.code,date:row.date,reason:'Unidad distinta',api:row.unit,local:base.unit});continue;}
 for(const field of [...Object.values(fields),'physicalCount']){stats[field]??={compared:0,different:0,unknown:0};if(base[field]==null||row[field]==null){stats[field].unknown++;continue;}stats[field].compared++;const delta=field==='physicalCount'?Number(row[field])-Number(base[field]):row[field]-base[field];if(Math.abs(delta)>1e-6){stats[field].different++;diff.push({code:row.code,warehouse:row.warehouse,date:row.date,field,api:row[field],local:base[field],delta});}}
}
const source={warehouses:state.warehouses,range:{from:'2026-08-23',to:'2026-08-30'}};const files=compareFiles(root,source,{daily});
const missingApi=state.daily.filter(r=>r.date>='2026-08-23'&&r.date<='2026-08-30'&&!identities.has(`${r.code}|${r.warehouse}|${r.date}`));
const result={products:payload.data.length,identifiedProducts:payload.data.length-unidentified.length,unidentifiedProducts:unidentified.length,unidentifiedRows:unidentified.reduce((n,p)=>n+p.warehouses.reduce((m,w)=>m+w.inventory.length,0),0),rows:daily.length,fields:[...keys],byWarehouse,duplicates,invalid,math,localSnapshot:version,stats,missingLocal:missing,missingApiRows:missingApi.length,fileComparison:{byField:files.differences.reduce((a,r)=>(a[r.field]=(a[r.field]||0)+1,a),{}),compared:files.comparedCells,differences:files.differences.length,missing:files.missing.length,files:files.files},differences:diff};
fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(result,null,2));
const book=XLSX.utils.book_new();for(const [name,rows]of [['API',daily],['Sin identidad',unidentified.flatMap((p,i)=>p.warehouses.flatMap(w=>w.inventory.map(r=>({record:i,warehouse:w.warehouse_id,unit:p.unit,...r}))))],['Comparación local',diff],['Sin contraparte local',missing],['Sin fila API',missingApi],['Diferencias archivos',files.differences],['Sin comparación archivos',files.missing],['Control aritmético',math]])XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),name);XLSX.writeFile(book,path.join(dir,'Comparacion_API_Inventario.xlsx'));
console.log(JSON.stringify({...result,differences:diff.slice(0,2),missingLocal:missing.slice(0,2)},null,2));
