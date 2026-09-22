const {countBoundaryReport,advance}=require('./inventory-boundaries');
// Same count resets and corrections as the consolidated inventory report.
function projectionInventory(state,location,today,correction=()=>0,periodFrom=advance(today,-29)) {
 const requestedFrom=periodFrom,requestedDays=Math.round((Date.parse(today)-Date.parse(periodFrom))/86400000)+1,through=state.range.to<today?state.range.to:today;
 const from=state.range.from>requestedFrom?state.range.from:requestedFrom;
 const base={source:'toteat-api',from,to:through,requestedFrom,days:Math.max(0,Math.round((Date.parse(through)-Date.parse(from))/86400000)+1),items:[],excluded:[],warnings:[]};
 if(from>through){base.warnings.push('La fuente no cubre el período solicitado.');return base;}
 if(base.days<requestedDays)base.warnings.push(`Cobertura parcial: promedio calculado sobre ${base.days} días sincronizados, no sobre ${requestedDays}.`);
 if(through<today)base.warnings.push(`Inventario disponible hasta ${through}; actualiza las fuentes para incluir movimientos posteriores.`);
 const warehouse=state.warehouses.find(w=>Number(w.custom_id)===(location.type==='warehouse'?1:2));
 const rows=state.daily.filter(r=>r.warehouse===warehouse?.id&&r.date<=through);
 if(!rows.length){base.warnings.push('Sin registros de inventario para esta bodega; no se supone inventario cero ni se generan necesidades.');return base;}
 const groups=new Map();for(const row of rows){const key=row.code+'|'+row.unit;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 const report={items:[],excluded:[]};
 for(const group of groups.values()) {
  const identity=group[0],anchors=group.filter(r=>(r.physicalCount||r.initialRecord)&&Number.isFinite(r.opening)).sort((a,b)=>a.date.localeCompare(b.date));
  const earliest=anchors[0]?.date;
  if(!earliest){report.excluded.push({code:identity.code,reason:'Sin apertura conocida.'});continue;}
  let itemFrom=earliest>from?earliest:from,result;
  const calculate=start=>countBoundaryReport({...state,daily:group},location,start,advance(through,1),correction);
  try{result=calculate(itemFrom);}catch(e){
   if(!/No hay una toma anterior/.test(e.message))throw e;
   itemFrom=anchors.at(-1).date;
   try{result=calculate(itemFrom);}catch{report.excluded.push({code:identity.code,reason:'Sin cobertura continua desde una apertura conocida.'});continue;}
  }
  report.excluded.push(...result.excluded);
  report.items.push(...result.items.map(i=>({...i,consumptionFrom:itemFrom,consumptionDays:Math.round((Date.parse(through)-Date.parse(itemFrom))/86400000)+1})));
 }
 const outgoing=['uso-consumo-estimado','trl-out-transferencia-local','mov-out-transferencia-bodega','trn-out-transformacion'];
 base.items=report.items.map(item=>{
  const adjustment=correction(item.code,item.unit,item.consumptionFrom,through);
  const rawOutgoing=outgoing.reduce((sum,key)=>sum+(item.movements[key]||0),0);
  return {...item,currentInventory:item.theoreticalFinal+adjustment,consumption30:Math.max(0,rawOutgoing-adjustment),rawOutgoing,netCorrections:adjustment,
   salesConsumption:item.movements['uso-consumo-estimado']||0,transformationOut:item.movements['trn-out-transformacion']||0,transferOut:(item.movements['trl-out-transferencia-local']||0)+(item.movements['mov-out-transferencia-bodega']||0)};
 });
 const partial=base.items.filter(i=>i.consumptionDays<requestedDays).length;
 if(partial)base.warnings.push(`${partial} productos tienen historial parcial: su promedio utiliza solo los días continuos disponibles desde una apertura conocida.`);
 base.excluded=report.excluded;
 if(base.excluded.length)base.warnings.push(`${base.excluded.length} productos excluidos por identidad o cobertura insuficiente; no se consideran saldo cero.`);
 return base;
}
module.exports={projectionInventory};
