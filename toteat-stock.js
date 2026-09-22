// Independent inventory ledger: source documents + purchases + sales, never Kardex balances.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const { atomicJson, localTimestamp } = require('./toteat-sales');
const { convert, recipeConsumption } = require('./toteat-inventory');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const day = value => {
  const s = String(value || '').slice(0,10).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10) !== s) throw Error('Fecha de inventario inválida.');
  return s;
};
const number = n => { if (typeof n !== 'number' || !Number.isFinite(n)) throw Error('Cantidad inválida en una fuente de inventario.'); return n; };
const fields = ['purchase','use','transfer_local_in','transfer_local_out','transfer_warehouse_in','transfer_warehouse_out','transformed_in','transformed_out'];
function normalizeOperations(source, canonicalProducts) {
  const products = new Map(source.products.map(p=>[p.id,p]));
  const canonical = new Map(canonicalProducts.map(p=>[p.custom_id,p]));
  const warehouses = new Set(source.warehouses.map(w=>w.id));
  const documents=[], lines=[], issues=[];
  const add = (doc, line, warehouse, quantity, unit, column, suffix='') => {
    if (!warehouses.has(warehouse)) throw Error('Bodega de otra sucursal o desconocida en el documento.');
    const original = products.get(line.product_ref), p = canonical.get(original?.custom_id);
    const code = original?.custom_id || line.product_ref;
    let amount = number(quantity), normalizedUnit = unit;
    if (p) { amount=convert(amount,unit,p.stock_unit,p); normalizedUnit=p.stock_unit; }
    else issues.push({kind:'missing-master',document:doc.key,code,message:'Referencia histórica ausente del maestro compartido; se conserva unidad original.'});
    // Toteat posts each transformation input to three stock-unit decimals.
    // Verified independently against all 90 rounding differences in the August pilot.
    const posted = column === 'transformed_out' ? Math.round((amount + Number.EPSILON) * 1000) / 1000 : amount;
    lines.push({id:`${doc.key}:${line.id ?? suffix}:${suffix}`,document:doc.key,source:doc.kind,date:doc.date,status:doc.status,
      warehouse,code,name:p?.name?.translations?.default||original?.name?.translations?.default||code,
      unit:normalizedUnit,quantity:posted,exactQuantity:amount,originalQuantity:quantity,originalUnit:unit,column,
      active:doc.status==='APPROVED',cost:line.cost??null});
  };
  for (const kind of ['counts','transfers','transformations']) {
    if (!Array.isArray(source.operations?.[kind])) throw Error('Falta una tabla de operaciones.');
    const seen = new Set();
    for (const d of source.operations[kind]) {
      if (d.id==null || seen.has(String(d.id))) throw Error('Documento de inventario sin identidad única.');
      seen.add(String(d.id));
      if (d.local_ref && d.local_ref !== source.localRef) throw Error('Documento de otro local.');
      const doc={key:`${source.restaurantId}:${source.localId}:${kind}:${d.id}`,id:d.id,kind,status:d.status,date:day(d.registration_date),createdAt:d.created_at,approvedAt:d.approved_at||null,observation:d.observation||d.comments||''};
      documents.push(doc);
      if (!['APPROVED','CREATED','REVERSED','CANCELLED','CANCELED','REJECTED'].includes(d.status)) issues.push({kind:'unknown-status',document:doc.key,message:`Estado no contabilizado: ${d.status}`});
      const detail=kind==='transformations'?d.transformation_details:d.take_inventory_products;
      if (!Array.isArray(detail)) throw Error('Documento sin detalle completo.');
      if (kind==='transformations') {
        add(doc,{product_ref:d.product_ref},d.target_warehouse_ref,d.quantity_produce,d.measure_unit,'transformed_in','output');
        for (const [i,l] of detail.entries()) add(doc,l,l.warehouse_ref,l.quantity,l.measure_unit,'transformed_out',String(i));
      } else for (const [i,l] of detail.entries()) {
        add(doc,l,d.warehouse_ref,l.quantity,l.measure_unit_ref,kind==='counts'?'count':'transfer_warehouse_out',String(i));
        if(kind==='transfers') add(doc,l,d.warehouse_receive_ref,l.quantity,l.measure_unit_ref,'transfer_warehouse_in',`${i}-in`);
      }
    }
  }
  return {documents,lines,issues};
}
function buildLedger(source, canonicalProducts, sales, purchases) {
  const data=normalizeOperations(source,canonicalProducts), issues=[...data.issues], lines=data.lines.filter(l=>l.active);
  const byCode=new Map(canonicalProducts.map(p=>[p.custom_id,p]));
  const warehouseByCode=new Map(source.warehouses.map(w=>[String(w.custom_id),w.id]));
  const from=source.range.from,to=source.range.to,inRange=d=>d>=from&&d<=to;
  for(const [kind,state]of [['sales',sales],['purchases',purchases]]) if(!state||state.from>from||state.through<to) issues.push({kind:'coverage',source:kind,message:`La cobertura de ${kind==='sales'?'ventas':'compras'} no cubre todo el período.`});
  const add=(item)=>{const p=byCode.get(item.code);if(!p)throw Error(`Falta maestro de ${item.code}.`);if(!item.warehouse)throw Error('Falta bodega de movimiento.');lines.push({...item,name:p.name?.translations?.default||item.code,quantity:convert(number(item.quantity),item.unit,p.stock_unit,p),unit:p.stock_unit,active:true});};
  for(const p of purchases?.documents||[]) {
    const received=p.received_date||p.recieived_date;
    if(!received){issues.push({kind:'purchase-date',document:p.movement_id,message:'Compra sin fecha de recepción; excluida.'});continue;}
    const date=day(received);if(!inRange(date))continue;
    for(const [i,l]of p.products.entries())try{add({id:`purchase:${p.movement_id}:${i}`,document:String(p.movement_id),source:'purchases',date,code:l.sku,warehouse:warehouseByCode.get(String(l.warehouse)),quantity:l.received_quantity,unit:l.received_measurement,column:'purchase'});}catch(e){issues.push({kind:'purchase-line',document:p.movement_id,message:e.message});}
  }
  // Work per order, not per payment, and retain ambiguities instead of doubling split bills.
  const orders=new Map(),includedOrders=[];
  for(const payment of sales?.payments||[]){const date=localTimestamp(payment.dateClosed).date;if(!inRange(date))continue;const key=String(payment.orderId);const group=orders.get(key)||[];group.push(payment);orders.set(key,group);}
  for(const [order,group]of orders){
    const saleLines=group.flatMap(p=>p.products||[]),seen=new Set();
    let reason=null;
    if(group.some(p=>p.fiscalType==='NC'||p.referencedPayment))reason='Devolución: falta confirmar su efecto físico.';
    for (const l of saleLines.filter(l=>l.lineReference)) {
      const parent=saleLines.find(p=>String(p.lineId)===String(l.lineReference));
      if(!parent || parent===l || parent.lineReference) reason='Extra sin producto padre inequívoco; revisar referencia de línea.';
    }
    for(const l of saleLines){if(!l.lineId||seen.has(String(l.lineId)))reason='Identidad de línea ausente o repetida entre pagos.';seen.add(String(l.lineId));}
    if(reason){issues.push({kind:'sale-excluded',document:order,message:reason});continue;}
    const staged=[];
    try{for(const l of saleLines)for(const [i,item]of recipeConsumption(canonicalProducts,l.id,number(l.quantity)).entries())staged.push({id:`sale:${order}:${l.lineId}:${i}`,document:order,source:'sales',date:localTimestamp(group[0].dateClosed).date,code:item.code,warehouse:warehouseByCode.get('2'),quantity:item.quantity,unit:item.unit,column:'use',estimated:true});for(const item of staged)add(item);includedOrders.push(order);}
    catch(e){issues.push({kind:'sale-excluded',document:order,message:e.message});}
  }
  const groups=new Map();
  for(const line of lines.filter(l=>inRange(l.date))){const key=`${line.warehouse}|${line.code}|${line.unit}`;const group=groups.get(key)||[];group.push(line);groups.set(key,group);}
  const daily=[];
  for(const group of groups.values()){
    let balance=null;const identity=group[0];
    for(let date=from;date<=to;date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10)){
      const today=group.filter(l=>l.date===date),counts=today.filter(l=>l.column==='count');
      const row={code:identity.code,name:identity.name,warehouse:identity.warehouse,date,unit:identity.unit,opening:balance,adjustment:null,physicalCount:false,...Object.fromEntries(fields.map(k=>[k,0]))};
      if(counts.length>1){issues.push({kind:'ambiguous-count',code:row.code,date,message:'Más de una toma aprobada por día; no se infiere su orden.'});balance=null;row.opening=null;}
      else if(counts.length){row.physicalCount=true;row.adjustment=balance===null?null:counts[0].quantity-balance;row.opening=counts[0].quantity;balance=row.opening;}
      for(const l of today)if(fields.includes(l.column))row[l.column]+=l.quantity;
      const net=row.purchase+row.transfer_local_in+row.transfer_warehouse_in+row.transformed_in-row.use-row.transfer_local_out-row.transfer_warehouse_out-row.transformed_out;
      row.closing=balance===null?null:balance+net;row.calculatedClosing=row.closing;
      row.costLastInbound=null;row.estimated=true;balance=row.closing;daily.push(row);
    }
  }
  const missingOpenings=daily.filter(r=>r.date===from&&r.opening===null).length;
  if(missingOpenings)issues.push({kind:'opening',message:`${missingOpenings} combinaciones de producto/bodega sin inventario inicial conocido; saldo no calculado hasta la primera toma.`});
  return {documents:data.documents,operationLines:data.lines,movements:lines.filter(l=>inRange(l.date)),daily,issues,
    salesConsumptionPolicy:'base-plus-extras-before-compensation-v1',includedOrders,mode:'draft',assumptions:['Recetas compartidas de La Concepción observadas actualmente; consumo de ventas estimado, sin historia de recetas.', 'Consumo base incluye producto y extras; las sustituciones y envases se compensan una sola vez en el informe consolidado.', 'Ventas asignadas a bodega operativa código 2; confirmar configuración para nuevos locales.', 'Tomas aplicadas al inicio de su fecha operativa; documentos conservan fecha de registro y aprobación.', 'Compras por cantidad y fecha recibidas; las fechas sin hora se concilian por día.', 'Consumo de transformación redondeado por línea a tres decimales de stock, verificado en el piloto; se conserva también la cantidad exacta original.', 'Transferencias entre locales y reversos de consumo no están certificados por estas tres fuentes. No se infieren movimientos faltantes.', 'Esta vista calcula cantidades. La valoración a costo última compra aún no se calcula ni se sustituye por costo estándar.'],
    range:source.range,sourceCapturedAt:source.capturedAt};
}
function createStockSync({uploadsRoot,activeLocation,credentials,reader,masters}){
  const root=path.join(uploadsRoot,'.integrations/toteat-api/stock'),jobs=new Map(),errors=new Map();
  function locationKey(id){const actual=id==='main-warehouse'?'store-1':id;if(activeLocation(actual)?.type!=='store')throw Error('Selecciona un local activo.');return actual;}
  const current=id=>{const key=locationKey(id),pointer=read(path.join(root,key,'current.json'));return pointer?read(path.join(root,key,pointer.version,'state.json')):null;};
  const dependency=(kind,id)=>{const base=path.join(uploadsRoot,'.integrations/toteat-api',kind,id),pointer=read(path.join(base,'current.json'));return pointer?read(path.join(base,pointer.version,'state.json')):null;};
  function status(id){const key=locationKey(id),state=current(key);return {location:key,running:jobs.has(key),error:errors.get(key)||null,range:state?.range||null,updatedAt:state?.sourceCapturedAt||null,counts:state?Object.fromEntries(['counts','transfers','transformations'].map(kind=>[kind,{documents:state.documents.filter(d=>d.kind===kind).length,approved:state.documents.filter(d=>d.kind===kind&&d.status==='APPROVED').length,lines:state.operationLines.filter(l=>l.source===kind).length}])):null};}
  function publish(id,source){const key=locationKey(id),config=credentials()[key];if(!config||source.restaurantId!==config.restaurantId||source.localId!==config.localId)throw Error('La fuente no corresponde al local.');
    const master=masters();if(!master)throw Error('Actualiza primero los maestros compartidos de La Concepción.');
    const products=master.products.map(p=>({...p,custom_id:p.code,stock_enabled:p.stockManaged,stock_unit:p.stockUnit,name:{translations:{default:p.name}}}));
    const sales=dependency('sales',key),purchases=dependency('purchases',key),state=buildLedger(source,products,sales,purchases);
    Object.assign(state,{location:key,warehouses:source.warehouses,masterObservedAt:master.observedAt,dependencies:{sales:sales?.version||null,purchases:purchases?.version||null}});
    const version=crypto.randomUUID(),directory=path.join(root,key,version);fs.mkdirSync(directory,{recursive:true,mode:0o700});
    atomicJson(path.join(directory,'original.json'),source);atomicJson(path.join(directory,'state.json'),state);
    // Separate durable local tables, all committed by one pointer.
    for(const kind of ['counts','transfers','transformations'])atomicJson(path.join(directory,`${kind}.json`),{documents:state.documents.filter(d=>d.kind===kind),lines:state.operationLines.filter(l=>l.source===kind)});
    atomicJson(path.join(root,key,'current.json'),{version});return status(key);
  }
  function synchronize(id,range){const key=locationKey(id);if(jobs.has(key))throw Error('Ya hay una actualización en curso.');const from=day(range.from),to=day(range.to);if(from>to||Date.parse(to)-Date.parse(from)>366*86400000)throw Error('Selecciona un período de hasta un año.');const c=credentials()[key];if(!c)throw Error('Configura la conexión Toteat de este local.');errors.delete(key);const job=Promise.resolve().then(async()=>{try{const source=await reader({restaurantId:c.restaurantId,localId:c.localId},{from,to,includeOperations:true});return publish(key,source);}catch(e){errors.set(key,'No se pudo completar la actualización. Revisa la sesión de Toteat y los maestros; se conserva la versión anterior.');throw e;}finally{jobs.delete(key);}});jobs.set(key,job);return job;}
  function view(id) {
    const state=current(id); if(!state)return null;
    const wh=id==='main-warehouse'?new Set(state.warehouses.filter(w=>[1,4].includes(w.custom_id)).map(w=>w.id)):null;
    const operationLines=state.operationLines.filter(r=>!wh||wh.has(r.warehouse));
    const documentKeys=new Set(operationLines.map(l=>l.document));
    return {...state,warehouses:state.warehouses.filter(w=>!wh||wh.has(w.id)),
      documents:state.documents.filter(d=>!wh||documentKeys.has(d.key)),
      daily:state.daily.filter(r=>!wh||wh.has(r.warehouse)),
      movements:state.movements.filter(r=>!wh||wh.has(r.warehouse)),operationLines};
  }
  function workbook(state,comparison) {
    const wb=XLSX.utils.book_new(),warehouses=new Map(state.warehouses.map(w=>[w.id,w.name]));
    const labels={code:'Código',name:'Producto',warehouse:'Bodega',date:'Fecha',unit:'Unidad',opening:'Inventario inicial',closing:'Inventario final',calculatedClosing:'Final calculado',adjustment:'Ajuste por toma',physicalCount:'Toma física',purchase:'Compras',use:'Consumo estimado',transfer_warehouse_in:'Transferencia bodega entrada',transfer_warehouse_out:'Transferencia bodega salida',transfer_local_in:'Transferencia local entrada',transfer_local_out:'Transferencia local salida',transformed_in:'Transformación entrada',transformed_out:'Transformación salida',costLastInbound:'Costo última compra',quantity:'Cantidad contabilizada',exactQuantity:'Cantidad exacta convertida',originalQuantity:'Cantidad original',originalUnit:'Unidad original',document:'Documento',status:'Estado',source:'Fuente',column:'Tipo movimiento',estimated:'Provisional',active:'Afecta inventario',cost:'Costo original',message:'Descripción',field:'Campo',calculated:'Calculado',fileValue:'Valor archivo',delta:'Diferencia',file:'Archivo',reason:'Motivo',createdAt:'Registrado',approvedAt:'Aprobado',observation:'Observación'};
    const sheets={'Kardex propio':state.daily,'Movimientos':state.movements,'Tomas inventario':state.operationLines.filter(r=>r.source==='counts'),'Transformaciones':state.operationLines.filter(r=>r.source==='transformations'),'Transferencias':state.operationLines.filter(r=>r.source==='transfers'),'Documentos':state.documents,'Pendientes':state.issues,'Diferencias archivo':comparison?.differences||[],'Cobertura archivo':comparison?.missing||[],'Criterios':[{message:`Borrador de cantidades. Período ${state.range.from} a ${state.range.to}. Captura ${state.sourceCapturedAt}.`},...state.assumptions.map(message=>({message}))]};
    for(const [name,rows]of Object.entries(sheets)) {
      const translated=rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[labels[key]||key,key==='warehouse'?warehouses.get(value)||value:value])));
      const sheet=XLSX.utils.json_to_sheet(translated);
      if(sheet['!ref'])sheet['!autofilter']={ref:sheet['!ref']};
      sheet['!cols']=Object.keys(translated[0]||{}).map(key=>({wch:Math.max(18,Math.min(42,key.length+3))}));
      XLSX.utils.book_append_sheet(wb,sheet,name);
    }
    return XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true});
  }
  return {status,current,view,publish,synchronize,workbook,rebuild(id) { const key=locationKey(id),pointer=read(path.join(root,key,'current.json'));if(!pointer)throw Error('Actualiza primero las fuentes originales.');publish(key,read(path.join(root,key,pointer.version,'original.json')));return current(key); }};
}
module.exports={normalizeOperations,buildLedger,createStockSync};
