const { inventoryExclusion } = require('./inventory-exclusions');
// Adapt the independent ledger to the existing report contract without reading a control Kardex.
const metrics=[['opening','II - Inventario inicial'],['purchase','BUY - Compras'],['transfer_local_in','TRL-IN - Transferencia local entrada'],['transfer_warehouse_in','MOV-IN - Transferencia bodega entrada'],['transformed_in','TRN-IN - Transformación entrada'],['use','USO - Consumo estimado'],['transfer_local_out','TRL-OUT - Transferencia local salida'],['transfer_warehouse_out','MOV-OUT - Transferencia bodega salida'],['transformed_out','TRN-OUT - Transformación salida'],['adjustment','AJU - Ajustes por toma'],['closing','IF - Inventario final']];
const key=label=>label.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function originalReportData(state,location,selection,from,to,{waste=false,completeSeries=false}={}) {
  if(!state)throw Error('Actualiza primero las fuentes originales en Cargar archivos.');
  const dates=[from,to,selection?.initialDate,selection?.finalDate];
  if(dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))throw Error('Selecciona fechas válidas para los saldos y movimientos.');
  if(from>to||selection.initialDate>selection.finalDate||dates.some(d=>d<state.range.from||d>state.range.to))throw Error('Las fechas seleccionadas deben estar dentro del período sincronizado y en orden.');
  if(!['initial','final'].includes(selection.initialBasis)||!['initial','final'].includes(selection.finalBasis))throw Error('Selecciona el tipo de saldo inicial y final.');
  const warehouseCode=location.type==='warehouse'?(waste?4:1):(waste?3:2);
  const warehouse=state.warehouses.find(w=>Number(w.custom_id)===warehouseCode);
  if(!warehouse)throw Error('No se encontró la bodega correspondiente en las fuentes originales.');
  const daily=state.daily.filter(r=>r.warehouse===warehouse.id);
  const groups=[...new Set(daily.map(r=>r.date))].sort().map((date,index)=>({date,startColumn:3+index*metrics.length,metrics:metrics.map(([field,label],j)=>({field,label,normalized:label.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,''),column:3+index*metrics.length+j}))}));
  const byCode=new Map();for(const r of daily){const id=`${r.code}|${r.unit}`;if(!byCode.has(id))byCode.set(id,[]);byCode.get(id).push(r);}
  const excluded=[],products=[];let physicalFinalItems=0;
  for(const rows of byCode.values()){
    const exclusion=inventoryExclusion(rows[0].code);
    if(exclusion){excluded.push({code:rows[0].code,name:rows[0].name,reason:exclusion});continue;}
    const first=rows.find(r=>r.date===selection.initialDate),last=rows.find(r=>r.date===selection.finalDate);
    const initialField=selection.initialBasis==='initial'?'opening':'closing',finalField=selection.finalBasis==='initial'?'opening':'closing';
    if(!waste&&!completeSeries&&(!Number.isFinite(first?.[initialField])||!Number.isFinite(last?.[finalField]))){excluded.push({code:rows[0].code,name:rows[0].name,reason:'Saldo inicial o final desconocido; producto excluido del consolidado.'});continue;}
    if(last?.physicalCount&&selection.finalBasis==='initial')physicalFinalItems++;
    const row=[rows[0].code,rows[0].name,rows[0].unit];
    for(const group of groups){const item=rows.find(r=>r.date===group.date);for(const metric of group.metrics)row[metric.column]=metric.field==='adjustment'?(group.date>selection.initialDate?item?.adjustment??0:0):item?.[metric.field]??0;}
    products.push({code:row[0],name:row[1],unit:row[2],row});
  }
  if(!waste&&!completeSeries&&!products.length)throw Error('No hay productos con ambos saldos conocidos en esta bodega y período. Actualiza las tomas de inventario o selecciona otras fechas.');
  return {parsed:{sheetName:'Fuentes originales Toteat',groups,products,movementDefinitions:metrics.filter(([f])=>!['opening','closing'].includes(f)).map(([,label])=>({key:key(label),label}))},excluded,physicalFinalItems,warehouse};
}
module.exports={originalReportData};
