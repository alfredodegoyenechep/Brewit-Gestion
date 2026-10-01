const { convert } = require('./toteat-inventory');
const date = value => {
  const day=String(value||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Error('Fecha de transferencia entre locales inválida.');
  return day;
};
// Read the same GET resources as Toteat's multilocal screen. Never call its
// generamovimientoinventario endpoint: that would create upstream movements.
async function readLocalTransfers(page, restaurant, from, to) {
  const result=await page.evaluate(async ({restaurant,from,to})=>{
    const injector=window.angular.element(document.body).injector(),config=injector.get('configuracion').objeto;
    if(String(config.ir)!==String(restaurant.restaurantId)||String(config.il)!==String(restaurant.localId))return {error:'local'};
    const api=injector.get('RESTsolicitudes'),found=new Map();
    const get=async params=>{
      let timer;
      const response=await Promise.race([api.get(params).$promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),60000);})]).finally(()=>clearTimeout(timer));
      if(!response.ok || response.next || response.has_more)throw Error('incomplete');
      return response.data;
    };
    try {
      for(const xmod of [5911,5912]) {
        // Read by creation and reception date, plus pending requests. The same
        // request can appear in several lists; fetch its full detail just once.
        for(const extra of [{xcustom:1},{xcustom:1,fre:true},{}]) {
          const list=await get({idsol:0,xmod,days:10001,dateini:from,datefin:to,tsa:config.tz?.tsa||0,...extra});
          if(!Array.isArray(list))throw Error('incomplete');
          for(const row of list){if(row.key==null)throw Error('incomplete');if(!found.has(String(row.key)))found.set(String(row.key),{key:row.key,xmod});}
        }
      }
      const documents=[];
      for(const {key,xmod} of found.values()) {
        const document=await get({idsol:key,xmod});
        if(!document?.det || String(document.key)!==String(key))throw Error('incomplete');
        documents.push(document);
      }
      return {documents,dispatchOnSend:!!config.cf?.d?.[0]?.toutdes,discountRecipe:!!config.cf?.d?.[0]?.transfer_discount_recipe};
    } catch(error){return {error:[401,403].includes(error.status)?'auth':'read'};}
  },{restaurant,from,to});
  if(result.error){const error=Error('No se completó la lectura de transferencias entre locales.');if(result.error==='auth')error.code='TOTEAT_AUTH_REQUIRED';throw error;}
  return result;
}
function normalizeLocalTransfers(source, canonicalProducts) {
  const data=source.localTransfers;
  if(!data)return {documents:[],lines:[],issues:[{kind:'local-transfer-coverage',message:'Transferencias entre locales pendientes de sincronización; sus ceros no certifican ausencia de movimientos.'}]};
  if(!Array.isArray(data.documents))throw Error('Faltan los documentos de transferencias entre locales.');
  if(data.discountRecipe)throw Error('Las transferencias con descuento de recetas requieren conciliar sus componentes originales.');
  const products=new Map(canonicalProducts.map(p=>[p.custom_id,p])),warehouses=new Map(source.warehouses.map(w=>[Number(w.custom_id),w.id]));
  const documents=[],lines=[],issues=[],seen=new Set();
  for(const d of data.documents){
    if(d.key==null||seen.has(String(d.key)))throw Error('Transferencia entre locales sin identidad única.');seen.add(String(d.key));
    const party=role=>String(d.det?.[role]?.ir)===String(source.restaurantId)&&String(d.det?.[role]?.il)===String(source.localId);
    const outgoing=party('proveedor'),incoming=party('receptor');
    if(outgoing===incoming)throw Error('Transferencia entre locales ajena o con origen y destino iguales.');
    const status=Number(d.st);
    if(![0,1,10,11,20,30,-1,-2,-3].includes(status))throw Error('Estado de transferencia entre locales no reconocido.');
    // Only receipt or an explicit dispatch posting date establishes a movement.
    const dispatchDate=d.fes || ((d.doc||[]).some(id=>String(id).startsWith('MOVOUT')) ? d.det.fechas?.[2] : null);
    const active=incoming?status===30:status===30||(status===20&&!!dispatchDate);
    if(!active){issues.push({kind:'local-transfer-pending',document:String(d.key),message:'Transferencia pendiente o cancelada; no contabilizada.'});continue;}
    const movementDate=date(outgoing?(dispatchDate||d.fre):d.fre);
    if(movementDate<source.range.from||movementDate>source.range.to)continue;
    const phase=outgoing?2:3,detail=d.det.listas?.[phase];
    if(!Array.isArray(detail))throw Error('Transferencia entre locales sin detalle de despacho o recepción.');
    const key=`${source.restaurantId}:${source.localId}:local-transfers:${d.key}`;
    documents.push({key,id:d.key,kind:'transfers',transferKind:'local',status:'APPROVED',originalStatus:status,date:movementDate,createdAt:d.fc,approvedAt:d.det.fechas?.[phase]||null});
    detail.forEach((line,index)=>{
      if(typeof line.cant!=='number'||!Number.isFinite(line.cant)||line.cant<0)throw Error('Cantidad de transferencia entre locales inválida.');
      if(line.cant===0)return;
      const code=outgoing?line.plProv:line.plRecep;
      const p=products.get(code),warehouse=warehouses.get(Number(line.w));
      if(!code||!p||!warehouse)throw Error('Producto o bodega de transferencia entre locales no reconocido.');
      const unit=line.unit_select||line.ub,quantity=convert(line.cant,unit,p.stock_unit,p);
      lines.push({id:`${key}:${phase}:${index}`,document:key,source:'transfers',transferKind:'local',date:movementDate,status:'APPROVED',warehouse,code,name:p.name?.translations?.default||code,unit:p.stock_unit,quantity,exactQuantity:quantity,originalQuantity:line.cant,originalUnit:unit,column:outgoing?'transfer_local_out':'transfer_local_in',active:true,cost:line.costo??null});
    });
  }
  return {documents,lines,issues};
}
module.exports={readLocalTransfers,normalizeLocalTransfers};
