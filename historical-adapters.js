const XLSX = require('xlsx');
const crypto = require('node:crypto');
const LABELS = {
  sales: 'Ventas', 'payment-details': 'Detalle de pagos', mercadopago: 'MercadoPago', purchases: 'Compras',
  receipts: 'Recepciones de compras', kardex: 'Kardex', counts: 'Tomas de inventario', transfers: 'Transferencias entre bodegas',
  'local-transfers': 'Transferencias entre locales', transformations: 'Transformaciones', waste: 'Mermas',
  marketing: 'Consumos de marketing', employees: 'Consumo personal / colaboradores', calibrations: 'Calibraciones',
  'master-catalog': 'Productos, ingredientes y extras', 'master-recipes': 'Recetas', 'master-suppliers': 'Proveedores',
  'product-hierarchy': 'Jerarquía de productos', 'ingredient-hierarchy': 'Jerarquía de ingredientes',
  'extras-hierarchy': 'Jerarquía de extras', warehouses: 'Maestro de bodegas'
};
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const arrayKey = row => row && typeof row === 'object' && !Array.isArray(row)
  ? row.lineId ?? row.id ?? row.key ?? row.custom_id ?? value(row,['Id Ingrediente','ID Producto','SKU','Cod','Código']) : null;
const canonical = v => Array.isArray(v) ? (() => {
  const values = v.map(canonical), keys = values.map(arrayKey);
  return keys.every(k => k != null) && new Set(keys.map(String)).size === keys.length
    ? values.sort((a, b) => String(arrayKey(a)).localeCompare(String(arrayKey(b)))) : values;
})() : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const stable = v => JSON.stringify(canonical(v));
const hash = v => crypto.createHash('sha256').update(stable(v)).digest('hex');
function value(row, names) {
  const fields = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const name of names) { const v = fields.get(norm(name)); if (v !== '' && v != null) return v; }
  return null;
}
function date(v, english = false) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; }
  const s = String(v ?? '');
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const valid = d => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d ? d : null;
  if (m) return valid(m[0]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return valid(`${m[1]}-${m[2]}-${m[3]}`);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (!m) return null;
  return valid(`${m[3]}-${String(english ? m[1] : m[2]).padStart(2, '0')}-${String(english ? m[2] : m[1]).padStart(2, '0')}`);
}
function operationDate(row) {
  if (row.dateClosed || row.TRANSACTION_DATE) {
    const v = row.dateClosed || row.TRANSACTION_DATE;
    const instant = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(v) ? v : `${v}Z`);
    if (Number.isFinite(instant.getTime())) return new Intl.DateTimeFormat('sv-SE', { timeZone:'America/Santiago' }).format(instant);
  }
  return date(value(row, ['dateClosed', 'registration_date', 'date', 'Fecha de cierre', 'FechaCierre', 'DateClosing',
    'TRANSACTION_DATE', 'Fecha documento', 'Fecha de documento', 'Fecha Emision', 'emission_date', 'document_date', 'receive_date', 'received_date', 'fecha', 'fre', 'fc', 'created_at']),
  Object.keys(row).some(k => ['dateclosing', 'closingdate'].includes(norm(k))));
}
function warehouseRefs(row) {
  const found = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, v] of Object.entries(value)) {
      if (/^(warehouse|warehouse_ref|warehouse_receive_ref|bodega|w)$/i.test(key) && v != null && v !== '' && v !== 0) {
        const id = typeof v === 'object' ? v.id ?? v.custom_id : v;
        if (id != null) found.add(String(id));
      }
      if (typeof v === 'object') visit(v);
    }
  };
  visit(row); return [...found];
}
function identity(row, dataset, master) {
  const line = value(row, ['API Line ID', 'lineId']);
  if (line != null) return { id: stable([value(row,['paymentId','ID de Pago','Pago','orderId','ID de orden']),line]), group:false };
  const id = value(row, ['paymentId', 'movement_id', 'id', 'key']);
  if (id != null) return { id: String(id), group: false };
  if (dataset === 'mercadopago') {
    const source = value(row, ['SOURCE_ID']), type = value(row, ['TRANSACTION_TYPE']);
    if (source != null && type != null) return { id: stable([source, type, value(row, ['TRANSACTION_DATE'])]), group: false };
  }
  if (master) {
    const code = value(row, ['custom_id', 'Codigo', 'Código de producto', 'ID Producto', 'ID Nodo', 'Hierarchy ID', 'SKU', 'pl', 'RUT', 'RUT/Fiscal ID', 'Código proveedor']);
    if (code != null) return { id: String(code), group: ['master-recipes','master-suppliers'].includes(dataset) };
  }
  if (dataset === 'payment-details') { const payment=value(row,['ID de Pago','Pago']);if(payment!=null)return {id:String(payment),group:true}; }
  const document = value(row, ['ID de orden', 'orderId', 'Comanda', 'Ticket', 'Documento', 'Nro documento', 'Numero de documento', 'Folio', 'document_number', 'ID movimiento']);
  if (document != null) return { id: stable([value(row, ['RUT proveedor', 'Número identificador fiscal', 'supplier_id', 'Proveedor/Para']), value(row, ['Tipo documento', 'document_type']), String(document)]), group: true };
  if (['kardex','waste','marketing','employees','calibrations'].includes(dataset)) {
    const code=value(row,['Código','ID Producto','SKU','Cod']), day=operationDate(row);
    if(code!=null && day)return {id:stable([String(code),day,value(row,['Unidad','Unit']),value(row,['Bodega','warehouse'])]),group:false};
  }
  return null;
}
function rowsFromFile(bytes, name, descriptor) {
  const book = XLSX.read(bytes, { type: 'buffer', cellDates: true, raw: true, codepage: Buffer.from(bytes.toString('utf8')).equals(bytes) ? 65001 : 1252 });
  return book.SheetNames.flatMap(sheet => {
    if (descriptor.dataset === 'master-suppliers' && ['listas','lists'].includes(norm(sheet))) return [];
    const matrix = XLSX.utils.sheet_to_json(book.Sheets[sheet], { header: 1, defval: null });
    const dailyHeader = descriptor.master ? -1 : matrix.findIndex(row => ['codigo','idproducto','sku','cod'].includes(norm(row[0])) && row.slice(2).some(v => date(v)));
    if (dailyHeader >= 0) {
      const top = matrix[dailyHeader], metrics = matrix[dailyHeader + 1] || [], days = []; let current;
      const firstDate=top.findIndex((v,i)=>i>=2 && date(v)), hasMetrics=!metrics[0] && metrics.slice(firstDate).some(v=>typeof v==='string' && v!=='');
      const unitIndex=top.findIndex((v,i)=>i<firstDate && ['unidad','unit','um'].includes(norm(v)));
      top.forEach((v, i) => { if (i >= firstDate) { current = date(v) || current; days[i] = current; } });
      return matrix.slice(dailyHeader + (hasMetrics?2:1)).filter(row => row[0] != null && row[0] !== '').flatMap(row => {
        return [...new Set(days.filter(Boolean))].map(day => ({
          __key:stable([row[0],unitIndex<0?null:row[unitIndex],day]), Código:row[0], Nombre:row[1], Unidad:unitIndex<0?null:row[unitIndex], Fecha:day,
          ...Object.fromEntries(top.flatMap((_, i) => days[i] === day ? [[hasMetrics?String(metrics[i] || `Columna ${i+1}`):'Valor',row[i] ?? null]] : []))
        }));
      });
    }
    // Exports often have a title before the real header.
    const headerIndex = matrix.findIndex(row => row.filter(v => v != null).length >= 2 && row.some(v => /fecha|date|codigo|sku|sourceid|iddeorden|idproducto|idnodo|hierarchyid|rut|documento|comanda|ticket/.test(norm(v))));
    if (headerIndex < 0) { if (matrix.length) throw Error('Encabezados no reconocidos: comparación pendiente.'); return []; }
    const seen = new Map();
    const headers = matrix[headerIndex].map((v, i) => { const label=String(v ?? `Columna ${i + 1}`), n=(seen.get(label)||0)+1;seen.set(label,n);return n===1?label:`${label} [${n}]`; });
    return matrix.slice(headerIndex + 1).filter(row => row.some(v => v != null && v !== '')).map(row => ({
      ...Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null])), __sheet: sheet
    }));
  });
}
function select(body, selector) {
  let selected = body;
  for (const key of (selector || '').split('.').filter(Boolean)) selected = selected?.[key];
  return Array.isArray(selected) ? selected : selected && typeof selected === 'object' ? [selected] : [];
}
function extract(bytes, artifact, descriptor) {
  let rows = artifact.format === 'file' ? rowsFromFile(bytes, artifact.name, descriptor) : select(JSON.parse(bytes), descriptor.selector);
  if (artifact.format === 'file' && descriptor.dataset === 'master-suppliers') rows=rows.filter(r=>value(r,['Nombre','RUT/Fiscal ID'])!=null);
  if (descriptor.storeId) rows = rows.filter(r => String(value(r, ['STORE_ID']) ?? '').replace(/^0+/, '') === String(descriptor.storeId).replace(/^0+/, ''));
  if (descriptor.hierarchy || descriptor.dataset.endsWith('-hierarchy')) rows = rows.flatMap(r => Array.isArray(r.listado) ? r.listado : [r])
    .map(r => Array.isArray(r) ? { id:r[0], values:r } : r);
  if (descriptor.dataset === 'purchases') rows = rows.filter(r => !r.movement_class || r.movement_class === 'PROVIDERS');
  if (descriptor.dataset === 'master-recipes' && artifact.format !== 'file') rows = rows.filter(r => r.recipe != null).map(r => ({ id:r.id, custom_id:r.custom_id, recipe:r.recipe }));
  const groups = new Map(), ambiguous = [];
  for (const original of rows) {
    const { __sheet, __key, ...fields } = original;
    const key = __key ? {id:__key,group:false} : identity(fields, descriptor.dataset, descriptor.master);
    if (!key) { ambiguous.push({ reason: 'Sin identificador estable', date: operationDate(fields), fields }); continue; }
    const id = key.id;
    const list = groups.get(id) || []; list.push({ fields, group: key.group }); groups.set(id, list);
  }
  const records = [];
  for (const [id, list] of groups) {
    if (list.length > 1 && !list.every(r => r.group)) { ambiguous.push({ id, reason: 'Identificador repetido', count: list.length }); continue; }
    const fields = list.every(r => r.group) ? { rows: list.map(r => r.fields).sort((a, b) => stable(a).localeCompare(stable(b))) } : list[0].fields;
    const original = list[0].fields;
    const warehouses = [...new Set(list.flatMap(r => warehouseRefs(r.fields)))];
    records.push({ id, date: operationDate(original), warehouse: warehouses.join(', ') || null, warehouses, fields });
    if (!descriptor.master && !records.at(-1).date) ambiguous.push({ recordId:id, reason:'Fecha de operación no reconocida', fields });
  }
  return { records, ambiguous, count: rows.length };
}
function differences(before, after, prefix = '') {
  if (stable(before) === stable(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const all=[...before,...after];
    if (all.length && all.every(r=>arrayKey(r)!=null) && new Set(before.map(r=>String(arrayKey(r)))).size===before.length && new Set(after.map(r=>String(arrayKey(r)))).size===after.length) {
      const old=new Map(before.map(r=>[String(arrayKey(r)),r])),current=new Map(after.map(r=>[String(arrayKey(r)),r]));
      return [...new Set([...old.keys(),...current.keys()])].sort().flatMap(id=>differences(old.get(id),current.get(id),`${prefix}[${id}]`));
    }
    if (before.length===1 && after.length===1) return differences(before[0],after[0],`${prefix}[0]`);
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(k => differences(Object.hasOwn(before,k)?before[k]:undefined, Object.hasOwn(after,k)?after[k]:undefined, prefix ? `${prefix}.${k}` : k));
  }
  return [{ field: prefix || 'registro', before: before === undefined ? null : before, after: after === undefined ? null : after,
    beforePresent: before !== undefined, afterPresent: after !== undefined }];
}
module.exports = { LABELS, canonical, stable, hash, value, date, operationDate, extract, differences };
