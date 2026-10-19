const { stable } = require('./historical-adapters');

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const labels = {
  cant:'Cantidad', quantity:'Cantidad', receivedquantity:'Cantidad recibida', orderedquantity:'Cantidad solicitada', requestquantity:'Cantidad solicitada',
  cantidad:'Cantidad', opening:'Inventario inicial', closing:'Inventario final', purchase:'Compras', use:'Consumo',
  costo:'Costo unitario', cost:'Costo unitario', unitcost:'Costo unitario', purchasecost:'Costo de compra',
  price:'Precio de venta', saleprice:'Precio de venta', unitprice:'Precio unitario', precio:'Precio de venta',
  amount:'Importe', total:'Total', totalcost:'Costo total', costtotal:'Costo total', netamount:'Importe neto', discount:'Descuento',
  discountvalue:'Descuento', totaltaxes:'Impuestos totales', invoicemeasurement:'Unidad de la factura',
  np:'Nombre', name:'Nombre', product:'Nombre', nombre:'Nombre', description:'Descripción', observation:'Observación',
  sku:'Código', code:'Código', customid:'Código', pl:'Código', plprov:'Código de origen', plrecep:'Código de destino',
  unitselect:'Unidad del movimiento', ub:'Unidad base', unit:'Unidad', stockunit:'Unidad de inventario',
  baseunit:'Unidad base', quantityunit:'Unidad de la cantidad', measurementunit:'Unidad', measureunit:'Unidad recibida', requestmeasureunit:'Unidad solicitada', receivedmeasurement:'Unidad recibida',
  types:'Tipo de artículo', type:'Tipo de artículo', warehouses:'Bodegas',
  w:'Bodega', warehouse:'Bodega', warehouseref:'Bodega de origen', warehousereceiveref:'Bodega de destino',
  status:'Estado', st:'Estado', active:'Activo', isactive:'Activo', tax:'Impuesto', taxrate:'Tasa de impuesto',
  date:'Fecha', registrationdate:'Fecha de operación', receiveddate:'Fecha de recepción', fre:'Fecha de recepción',
  fc:'Fecha de creación', fes:'Fecha de despacho', validfrom:'Vigente desde', supplier:'Proveedor', provider:'Proveedor',
  stockmanaged:'Control de inventario', recipe:'Receta', yieldrate:'Rendimiento', portionsperunit:'Porciones por unidad'
};
Object.assign(labels,{nombreproducto:'Nombre',nombreingrediente:'Nombre',idproducto:'Código',codigo:'Código',unidad:'Unidad',
  costounitario:'Costo unitario',costototal:'Costo total',precioventa:'Precio de venta',precioapagar:'Precio de venta',
  cantidadrecibida:'Cantidad recibida',cantidadcomprada:'Cantidad comprada'});
const quantities = new Set(['cant','quantity','receivedquantity','orderedquantity','requestquantity','cantidad','opening','closing','purchase','use']);
const money = new Set(['costo','cost','unitcost','purchasecost','price','saleprice','unitprice','precio','amount','total','totalcost','costtotal','netamount','discount','discountvalue','totaltaxes']);
for (const field of ['costounitario','costototal','precioventa','precioapagar']) money.add(field);
for (const field of ['cantidadrecibida','cantidadcomprada']) quantities.add(field);
const internal = new Set(['id','key','ip','iplocal','mid','versionid','lastversionid','sourceversion','updatedat','createdat','createdby','updatedby',
  'sel','selected','jp','jpprov','htr','tp','tilocal','cpp','fo','error','diff','dif','dn','npt','plt','pllocal','plfinal','wub','wublocal','nplocal','uinsert']);
const unitNames = { UN:'unidad', KG:'kg', G:'g', GR:'g', L:'L', LT:'L', ML:'ml', BOT:'botella', PAC:'paquete', BOLSA:'bolsa' };
const stages = ['Solicitud', 'Confirmación', 'Despacho', 'Recepción'];
const number = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits:6 }).format(value);
const currency = value => '$' + new Intl.NumberFormat('es-CL', { maximumFractionDigits:2 }).format(value);
const unit = value => unitNames[String(value ?? '').toUpperCase()] || String(value ?? '').toLowerCase();
const textName = value => typeof value === 'string' ? value : value?.translations?.default || value?.default || null;
function first(row, keys) {
  const fields=new Map(Object.entries(row || {}).map(([key,value])=>[normalize(key),value]));
  for (const key of keys) { const value=fields.get(normalize(key));if(value != null && value !== '')return value; }
}
function identity(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return first(row, ['lineId','line_id','id','key','sku','code','custom_id','pl','plProv','product_ref','ingredient_ref','ID Producto','Código']);
}
function presentation(change, { before, after, catalog = [], warehouseLabels = {} } = {}) {
  const products = new Map();
  for (const item of catalog) for (const key of [item.id, item.code, item.custom_id, item.sku]) if (key != null) products.set(String(key), item);
  const rows = [], notices = [], unresolved = [];
  let administrative = 0;
  const context = (old, current, parent = {}) => {
    const row = current || old;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return parent;
    const ref = first(row, ['code','sku','custom_id','pl','plProv','product_ref','ingredient_ref','Código','ID Producto']);
    const product = products.get(String(ref)) || products.get(String(row.id));
    const code = first(row, ['code','sku','custom_id','pl','plProv','Código','ID Producto']) ?? product?.code ?? product?.custom_id;
    const itemName = textName(first(row, ['name','np','product','Nombre','Nombre Producto','Nombre Ingrediente'])) || product?.name;
    return { ...parent, ...(code != null ? { code:String(code) } : {}), ...(itemName ? { itemName:textName(itemName) } : {}),
      unit:first(row,['unit_select','unit','quantity_unit','stock_unit','stockUnit','ub','Unidad','received_measurement','measure_unit']) ?? parent.unit };
  };
  const root = context(before, after, { itemName: change.dataset?.startsWith('master-') ? 'Artículo' : 'Documento', code:'' });
  const format = (value, field, ctx, present = true) => {
    if (!present || value === undefined) return 'Sin registro';
    if (value === null || value === '') return 'Sin informar';
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (money.has(field) && typeof value === 'number') return currency(value);
    if (quantities.has(field) && typeof value === 'number') return `${number(value)}${ctx.unit ? ' ' + unit(ctx.unit) : ''}`;
    if (field.includes('unit') || ['unidad','ub','receivedmeasurement','invoicemeasurement'].includes(field)) return unit(value);
    if (['warehouse','w','warehouseref','warehousereceiveref'].includes(field)) return warehouseLabels[value] || `Bodega ${value}`;
    if (['status','st'].includes(field)) return ({APPROVED:'Aprobado',CREATED:'Creado',CANCELLED:'Cancelado',CANCELED:'Cancelado',REVERSED:'Reversado',ACTIVE:'Activo',INACTIVE:'Inactivo',0:'Borrador',10:'Solicitado',20:'Despachado',30:'Recibido'})[value] || String(value);
    if (typeof value === 'number') return number(value);
    if (Array.isArray(value)) return value.map(v => field === 'warehouses' ? warehouseLabels[v] || `Bodega ${v}`
      : ({PRODUCT:'Producto',INGREDIENT:'Ingrediente',EXTRA:'Extra'})[v] || (typeof v === 'object' ? textName(v) || 'Dato actualizado' : String(v))).join(', ') || 'Sin elementos';
    if (typeof value === 'object') return textName(value) || 'Dato actualizado';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('-');
    return String(value);
  };
  const add = (field, old, current, ctx, oldCtx = ctx, newCtx = ctx, type) => {
    const key = normalize(field.split('.').at(-1).replace(/\[.*?\]/g, ''));
    if (internal.has(key)) { administrative++; return; }
    if (stable(old) === stable(current)) return;
    const comparable = (quantities.has(key) || money.has(key) || ['taxrate','yieldrate','portionsperunit'].includes(key)) && typeof old === 'number' && typeof current === 'number'
      && (!quantities.has(key) || unit(oldCtx.unit) === unit(newCtx.unit));
    const delta = comparable ? current - old : null;
    rows.push({ itemName:ctx.itemName || 'Artículo', code:ctx.code || '', stage:ctx.stage || 'Registro',
      field:labels[key] || 'Otro dato del artículo',
      before:format(old,key,oldCtx), after:format(current,key,newCtx),
      difference:delta == null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${money.has(key) ? currency(Math.abs(delta)) : number(Math.abs(delta))}${quantities.has(key) && ctx.unit ? ' ' + unit(ctx.unit) : ''}`,
      type:type || (old === undefined ? 'added' : current === undefined ? 'deleted' : 'modified') });
  };
  const conversionText = list => (list || []).map(c => `${number(c.cden ?? c.denominator ?? 1)} ${unit(c.umed ?? c.conversion_unit)} = ${number(c.cnum ?? c.numerator ?? 1)} ${unit(c.umedb ?? c.base_unit)}`).sort().join('; ') || 'Sin equivalencias';
  const visit = (old, current, path = '', parent = root) => {
    if (stable(old) === stable(current)) return;
    const ctx = context(old, current, parent);
    if (old && typeof old === 'object' && !Array.isArray(old)) ctx.beforeUnit=context(old,old,parent).unit;
    if (current && typeof current === 'object' && !Array.isArray(current)) ctx.afterUnit=context(current,current,parent).unit;
    const oldCtx={...ctx,unit:ctx.beforeUnit ?? ctx.unit},newCtx={...ctx,unit:ctx.afterUnit ?? ctx.unit};
    if (path === 'det.listas' && (Array.isArray(old) || Array.isArray(current))) {
      for (let i=0;i<Math.max(old?.length || 0,current?.length || 0);i++) visit(old?.[i] || [],current?.[i] || [],`etapa${i}`,{...ctx,stage:stages[i] || 'Transferencia'});
      return;
    }
    if (['conv','conversions'].includes(path.split('.').at(-1))) {
      const previous=conversionText(old), next=conversionText(current);
      if (previous === next) notices.push({itemName:ctx.itemName,code:ctx.code,stage:ctx.stage || 'Registro',message:'Mismas equivalencias de unidades; solo cambió el orden.'});
      else rows.push({itemName:ctx.itemName,code:ctx.code || '',stage:ctx.stage || 'Registro',field:'Equivalencias de unidades',before:previous,after:next,difference:'—',type:'modified'});
      return;
    }
    if ((Array.isArray(old) || old === undefined) && (Array.isArray(current) || current === undefined)) {
      const previous=old || [], next=current || [];
      if ([...previous,...next].every(v => v && typeof v === 'object' && !Array.isArray(v) && identity(v) != null)) {
        const keys = values => values.map(v=>String(identity(v)));
        if (new Set(keys(previous)).size !== previous.length || new Set(keys(next)).size !== next.length) {
          unresolved.push('Hay artículos repetidos sin una identificación única. Consulta el respaldo para confirmar qué línea cambió.'); return;
        }
        const oldMap=new Map(previous.map(v=>[String(identity(v)),v])),newMap=new Map(next.map(v=>[String(identity(v)),v]));
        let changed=false;
        for (const id of new Set([...oldMap.keys(),...newMap.keys()])) {
          const a=oldMap.get(id),b=newMap.get(id); if(stable(a)!==stable(b)) changed=true;
          if (!a || !b) {
            const item=context(a,b,ctx), record=a || b;
            rows.push({itemName:item.itemName || 'Artículo',code:item.code || '',stage:item.stage || 'Registro',field:a?'Artículo eliminado':'Artículo agregado',
              before:a?format(first(record,['cant','quantity','Cantidad']) ?? textName(record.name) ?? 'Registrado','quantity',item):'Sin registro',
              after:b?format(first(record,['cant','quantity','Cantidad']) ?? textName(record.name) ?? 'Registrado','quantity',item):'Sin registro',difference:'—',type:a?'deleted':'added'});
            for (const [key,v] of Object.entries(record)) if(money.has(normalize(key))) add(key,a?v:undefined,b?v:undefined,item,item,item);
          } else visit(a,b,path,ctx);
        }
        if (!changed) notices.push({itemName:ctx.itemName,code:ctx.code,stage:ctx.stage || 'Registro',message:'Los mismos artículos aparecen en otro orden.'});
        return;
      }
      if ([...previous,...next].every(v=>typeof v !== 'object' || v === null)) { add(path,old,current,ctx); return; }
      unresolved.push('Cambió un detalle con varias líneas que no se pueden relacionar con seguridad. Consulta el respaldo para revisar los artículos.'); return;
    }
    if ((old == null || typeof old === 'object' && !Array.isArray(old)) && (current == null || typeof current === 'object' && !Array.isArray(current))
      && (old && typeof old === 'object' || current && typeof current === 'object')) {
      for (const key of new Set([...Object.keys(old || {}),...Object.keys(current || {})])) {
        if (internal.has(normalize(key))) { if(stable(old?.[key])!==stable(current?.[key]))administrative++;continue; }
        if (key === 'name' && (textName(old?.[key]) || textName(current?.[key]))) add(key,textName(old?.[key]) ?? undefined,textName(current?.[key]) ?? undefined,ctx);
        else visit(old?.[key],current?.[key],path?`${path}.${key}`:key,ctx);
      }
      return;
    }
    add(path,old,current,ctx,oldCtx,newCtx);
  };
  if (before !== undefined || after !== undefined) visit(before,after);
  else for (const field of change.fields || []) visit(field.beforePresent === false ? undefined : field.before,
    field.afterPresent === false ? undefined : field.after,field.field);
  const uniqueItems=new Set(rows.map(row=>row.code || row.itemName));
  return { itemName:root.itemName, code:root.code, rows, notices:[...new Map(notices.map(n=>[`${n.code}:${n.message}`,n])).values()],
    itemCount:uniqueItems.size, administrativeCount:administrative, warnings:[...new Set(unresolved)],
    summary:rows.length ? `${uniqueItems.size} ${uniqueItems.size===1?'artículo o registro afectado':'artículos o registros afectados'} · ${rows.length} ${rows.length===1?'cambio':'cambios'}`
      : unresolved.length ? 'El detalle requiere revisión.' : notices.length ? 'Solo cambió el orden de la información. Se mantienen los valores registrados.'
        : 'Se actualizó información administrativa del registro.' };
}

// Build a human-readable view from saved versions, including comparisons that
// predate this UI. Values always come from the evidence; catalog names are labels.
function presenter(history, { catalog = () => [] } = {}) {
  const snapshots=new Map(), catalogs=new Map();
  const snapshot = id => {
    if (!id) return {};
    if (!snapshots.has(id)) {
      try { snapshots.set(id,JSON.parse(require('node:zlib').gunzipSync(require('node:fs').readFileSync(require('node:path').join(history.directory(id),'state.json.gz'))))); }
      catch { snapshots.set(id,{}); }
    }
    return snapshots.get(id);
  };
  return change => {
    if (!change.fields?.length) return change;
    const sources=history.load(change.runId)?.summaries || [];
    const source=sources.find(s=>s.key===change.sourceKey) || sources.find(s=>s.dataset===change.dataset && s.location===change.location && (!change.origin || s.origin===change.origin));
    const before=snapshot(change.previousRunId)[source?.key]?.records?.[change.id]?.fields;
    const after=snapshot(change.runId)[source?.key]?.records?.[change.id]?.fields;
    if (!catalogs.has(change.location)) { try { catalogs.set(change.location,catalog(change.location) || []); } catch { catalogs.set(change.location,[]); } }
    return {...change,presentation:presentation(change,{before:['historicalAdded','masterAdded'].includes(change.type)?undefined:before,
      after:change.type==='deleted'?undefined:after,catalog:catalogs.get(change.location),warehouseLabels:source?.warehouseNames || change.warehouseNames || {}})};
  };
}
module.exports = { presentation, presenter };
