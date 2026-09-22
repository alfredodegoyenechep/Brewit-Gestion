const advance=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const definitions=[['purchase','buy-compras','Compras',1],['use','uso-consumo-estimado','Consumo ventas',-1],['transfer_local_in','trl-in-transferencia-local','Transferencia local entrada',1],['transfer_local_out','trl-out-transferencia-local','Transferencia local salida',-1],['transfer_warehouse_in','mov-in-transferencia-bodega','Transferencia bodega entrada',1],['transfer_warehouse_out','mov-out-transferencia-bodega','Transferencia bodega salida',-1],['transformed_in','trn-in-transformacion','Transformación entrada',1],['transformed_out','trn-out-transformacion','Transformación salida',-1]];
function boundaryPeriod(initial,final,range) {
 if(!valid(initial)||!valid(final)||initial>=final)throw Error('La fecha final debe ser posterior a la inicial.');
 if(initial<range.from||advance(final,-1)>range.to)throw Error('Actualiza las fuentes para cubrir todos los días del período seleccionado.');
 return {from:initial,to:advance(final,-1)};
}
function countBoundaryReport(state,location,initial,final,correction=()=>0) {
 const period=boundaryPeriod(initial,final,state.range);
 const warehouse=state.warehouses.find(w=>Number(w.custom_id)===(location.type==='warehouse'?1:2));
 if(!warehouse)throw Error('Bodega no disponible en las fuentes originales.');
 const series=new Map();for(const row of state.daily.filter(r=>r.warehouse===warehouse.id)){const key=`${row.code}|${row.unit}`;if(!series.has(key))series.set(key,[]);series.get(key).push(row);}
 const items=[],excluded=[];
 for(const rows of series.values()){
  rows.sort((a,b)=>a.date.localeCompare(b.date));const identity=rows[0];
  const anchor=rows.filter(r=>r.date<=initial&&r.physicalCount&&Number.isFinite(r.opening)).at(-1) || rows.find(r=>r.date<=initial&&r.initialRecord&&Number.isFinite(r.opening));
  if(!anchor){excluded.push({code:identity.code,name:identity.name,reason:'Sin toma física anterior o en la fecha inicial dentro de la cobertura.'});continue;}
  const byDate=new Map(rows.map(r=>[r.date,r]));let opening=anchor.opening,missing=false;
  const net=row=>definitions.reduce((n,[field,,,sign])=>n+sign*(row[field]||0),0);
  for(let date=anchor.date;date<initial;date=advance(date,1)){const row=byDate.get(date);if(!row){missing=true;break;}opening+=net(row);}
  if(missing){excluded.push({code:identity.code,reason:'Cobertura diaria incompleta para calcular el saldo inicial.'});continue;}
  const openingCorrection=anchor.date<initial?correction(identity.code,identity.unit,anchor.date,advance(initial,-1)):0;
  opening+=openingCorrection;
  const movements=Object.fromEntries(definitions.map(([,key])=>[key,0]));let balance=opening,lastReset=initial,resetBalance=opening,rawSinceReset=0,adjustments=0;
  for(let date=initial;date<final;date=advance(date,1)){
   const row=byDate.get(date);if(!row){missing=true;break;}
   if(date>initial&&row.physicalCount&&Number.isFinite(row.opening)){
    const theoretical=resetBalance+rawSinceReset+correction(identity.code,identity.unit,lastReset,advance(date,-1));
    adjustments+=row.opening-theoretical;resetBalance=row.opening;rawSinceReset=0;lastReset=date;
   }
   for(const[field,key]of definitions)movements[key]+=row[field]||0;
   rawSinceReset+=net(row);balance+=net(row);
  }
  if(missing){excluded.push({code:identity.code,reason:'Cobertura diaria incompleta dentro del período.'});continue;}
  movements['aju-tomas-intermedias']=adjustments;
  const end=byDate.get(final),physical=!!end?.physicalCount&&Number.isFinite(end.opening);
  items.push({code:identity.code,name:identity.name,unit:identity.unit,initialInventory:opening,initialSource:anchor.date===initial&&anchor.physicalCount?'physical':'theoretical',anchorDate:anchor.date,openingCorrection,movements,theoreticalFinal:balance+adjustments,finalInventory:physical?end.opening:null,finalIsPhysical:physical,difference:physical?end.opening-balance-adjustments:null});
 }
 if(!items.length)throw Error('No hay una toma anterior conocida para calcular los saldos iniciales. Amplía la sincronización de inventario.');
 return {dateFrom:period.from,dateTo:period.to,selection:{initialDate:initial,initialBasis:'initial',finalDate:final,finalBasis:'initial'},boundaryMode:true,movementDefinitions:[...definitions.map(([,key,label])=>({key,label})),{key:'aju-tomas-intermedias',label:'Ajuste por tomas intermedias'}],items,itemCount:items.length,excluded,physicalFinalItems:items.filter(r=>r.finalIsPhysical).length};
}
module.exports={countBoundaryReport,boundaryPeriod,advance};
