// Read-only comparison of previously captured Toteat masters; never publishes or modifies source masters.
// Run from the repository root: node scripts/audit-toteat-masters.js
const fs=require('fs'),path=require('path');const a=JSON.parse(fs.readFileSync('uploads/.integrations/toteat-api/master-audit/store-1.json')),b=JSON.parse(fs.readFileSync('uploads/.integrations/toteat-api/master-audit/store-2.json'));
const omit=new Set(['id','local','legacy_id','last_version_id','version_id','created_at','updated_at','created_by','updated_by','log_entries','multilocal_source','master_local','source_document']);
function context(s){const refs=new Map();for(const [type,items] of [['product',s.products],['warehouse',s.warehouses],['supplier',s.suppliers]])for(const p of items)refs.set(p.id,`${type}:${p.custom_id}`);for(const [kind,groups]of Object.entries(s.hierarchies))for(const g of groups)for(const row of g.listado)refs.set(row.at(-1),kind+':'+row[0]);return refs;}
function canonical(v,refs){if(Array.isArray(v))return v.map(x=>canonical(x,refs)).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>!omit.has(k)).map(k=>[k,canonical(v[k],refs)]));return refs.get(v)||v;}
function eq(a,b){if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=1e-8;if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>eq(v,b[i]));if(a&&b&&typeof a==='object'&&typeof b==='object'){const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];return keys.every(k=>eq(a[k],b[k]));}return a===b;}
function product(p,s){const n={...p};delete n.recipe;for(const k of ['modifier_prices','sub_brand_ids','unavailable_options','variant_prices'])n[k]=p[k]||[];for(const k of ['hierarchies','extras_hierarchies','ingredients_hierarchies','accounting_hierarchies'])n[k]=(p[k]||[]).map(h=>({code:h.custom_id,position:h.position}));n.warehouses=(p.warehouses||[]).map(w=>w.custom_id);n.stock_purchase_warehouse=p.stock_purchase_warehouse?.custom_id??null;n.photos=(p.photos||[]).map(p=>p.url);return canonical(n,context(s));}
function recipe(p,s){const r=p.recipe;if(!r?.ingredients?.length)return null;return canonical({...r,ingredients:r.ingredients.map(i=>{const n={...i,variant_overrides:i.variant_overrides||[]};delete n.name;return n})},context(s));}
function compare(itemsA,itemsB,key,project){const ma=new Map(itemsA.map(p=>[key(p),p])),mb=new Map(itemsB.map(p=>[key(p),p]));if(ma.size!==itemsA.length||mb.size!==itemsB.length)throw Error('Duplicate matching keys');const out={countA:ma.size,countB:mb.size,onlyA:[],onlyB:[],changed:[],equal:0};for(const[k,p]of ma){if(!mb.has(k)){out.onlyA.push(k);continue}const q=mb.get(k),pa=project(p,a),pb=project(q,b);if(eq(pa,pb)){out.equal++;continue}const fields=[...new Set([...Object.keys(pa||{}),...Object.keys(pb||{})])].filter(f=>!eq(pa?.[f],pb?.[f])).map(field=>({field,a:pa?.[field]??null,b:pb?.[field]??null}));out.changed.push({code:k,name:p.name?.translations?.default||p.name||p[2],fields});}for(const k of mb.keys())if(!ma.has(k))out.onlyB.push(k);return out;}
const result={capturedA:a.capturedAt,capturedB:b.capturedAt};result.catalog=compare(a.products,b.products,p=>p.custom_id,product);result.recipes=compare(a.products.filter(p=>p.recipe?.ingredients?.length),b.products.filter(p=>p.recipe?.ingredients?.length),p=>p.custom_id,recipe);result.hierarchies={};for(const kind of ['products','ingredients','extras'])result.hierarchies[kind]=compare(a.hierarchies[kind].flatMap(g=>g.listado),b.hierarchies[kind].flatMap(g=>g.listado),r=>r[0],(r,s)=>canonical(Object.fromEntries(r.slice(0,-1).map((v,i)=>[i,v])),context(s)));result.suppliers=compare(a.suppliers,b.suppliers,p=>String(p.custom_id),(p,s)=>canonical({...p,allowed_ingredients:p.allowed_ingredients||[]},context(s)));

const name = p => p?.name?.translations?.default || p?.name || '';
const missingLines = [];
const unexpectedLines = [];
const legacyMismatches = [];
const lineKey = i => JSON.stringify([i.custom_id, i.quantity, i.quantity_unit.toUpperCase(), i.yield_rate, i.is_visible]);
for (const source of [a, b]) {
  for (const p of source.products) {
    const legacy = source.items.find(i => i.pl === p.custom_id)?.det.rc?.dg || [];
    const original = (p.recipe?.ingredients || []).map(lineKey).sort();
    const adapted = legacy.map(i => JSON.stringify([i.ii, i.qi, i.ui.toUpperCase(), i.tr, i.vi])).sort();
    if (!eq(original, adapted)) legacyMismatches.push({ local: source.localId, code: p.custom_id });
  }
}
for (const p of a.products) {
  const q = b.products.find(q => q.custom_id === p.custom_id);
  if (!q) continue;
  const remaining = [...(q.recipe?.ingredients || [])];
  for (const line of p.recipe?.ingredients || []) {
    const index = remaining.findIndex(i => lineKey(i) === lineKey(line));
    if (index >= 0) remaining.splice(index, 1);
    else missingLines.push({
      'Código receta': p.custom_id, 'Nombre receta': name(p),
      'Situación Lyon': q.recipe?.ingredients?.length ? 'Receta incompleta' : 'Receta vacía',
      'Código componente': line.custom_id, 'Componente': line.name,
      'Cantidad La Concepción': line.quantity, 'Unidad': line.quantity_unit,
      'Rendimiento %': line.yield_rate, 'Cantidad base receta': p.recipe.quantity,
      'Porciones por unidad': p.recipe.portions_per_unit,
    });
  }
  for (const line of remaining) unexpectedLines.push({ recipe: p.custom_id, ...line });
}
result.recipeDetail = {
  linesA: a.products.reduce((n,p) => n+(p.recipe?.ingredients?.length||0),0),
  linesB: b.products.reduce((n,p) => n+(p.recipe?.ingredients?.length||0),0),
  missingLines, unexpectedLines, legacyMismatches,
};
const output = path.resolve('uploads/reports/masters/audit-2026-09-21');
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'comparison.json'), JSON.stringify(result,null,2));
const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();
function sheet(title, rows) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Resultado: 'Sin diferencias' }]);
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!cols'] = Object.keys(rows[0]||{}).map(k=>({wch:Math.min(65,Math.max(18,k.length+3))}));
  XLSX.utils.book_append_sheet(wb,ws,title);
}
const categories = [['Productos / ingredientes / extras',result.catalog],['Jerarquía productos',result.hierarchies.products],['Jerarquía ingredientes',result.hierarchies.ingredients],['Jerarquía extras',result.hierarchies.extras],['Recetas con componentes',result.recipes],['Proveedores',result.suppliers]];
sheet('Resumen',categories.map(([category,r])=>({Maestro:category,'La Concepción':r.countA,Lyon:r.countB,Iguales:r.equal,'Con diferencias':r.changed.length,'Solo La Concepción':r.onlyA.length,'Solo Lyon':r.onlyB.length})));
const display = v => typeof v === 'object' ? JSON.stringify(v) : v;
function differences(r) {return r.changed.flatMap(p=>p.fields.map(f=>({Código:p.code,Nombre:p.name,Campo:f.field,'La Concepción':display(f.a),Lyon:display(f.b)})));}
sheet('Diferencias catálogo',differences(result.catalog));
sheet('Componentes faltantes',missingLines);
sheet('Recetas vacías',result.recipes.onlyA.map(code=>({Código:code,Nombre:name(a.products.find(p=>p.custom_id===code))})));
sheet('Costos recetas',differences(result.recipes).filter(row=>row.Campo==='cost'));
sheet('Estado de cada receta',a.products.filter(p=>p.recipe?.ingredients?.length).map(p=>{
  const q=b.products.find(q=>q.custom_id===p.custom_id), change=result.recipes.changed.find(r=>r.code===p.custom_id);
  return {Código:p.custom_id,Nombre:name(p),'Líneas La Concepción':p.recipe.ingredients.length,'Líneas Lyon':q.recipe?.ingredients?.length||0,Estado:result.recipes.onlyA.includes(p.custom_id)?'Vacía en Lyon':change?change.fields.map(f=>f.field).join(', '):'Igual'};
}));
sheet('Proveedores',differences(result.suppliers));
sheet('Jerarquías',Object.entries(a.hierarchies).flatMap(([kind,groups])=>groups.flatMap(g=>g.listado.map(r=>({Tipo:kind,Código:r[0],'Fila funcional (sin ID interno)':JSON.stringify(r.slice(0,-1)),Resultado:result.hierarchies[kind].changed.some(p=>p.code===r[0])?'Diferente':'Igual'})))));
sheet('Método',[
  {Concepto:'Captura La Concepción UTC',Detalle:a.capturedAt},
  {Concepto:'Captura Lyon UTC',Detalle:b.capturedAt},
  {Concepto:'Origen',Detalle:'Lectura autenticada de servicios internos de Toteat y maestro de su aplicación. Sin escrituras ni publicación en Brewit.'},
  {Concepto:'Identificación',Detalle:'Código de artículo, receta, proveedor o nodo. Referencias internas resueltas por código; bodegas comparadas por función/código dentro de cada local.'},
  {Concepto:'Exclusiones',Detalle:'IDs internos, fechas, usuarios, versiones y procedencia; orden de listas sin significado; valores ausentes equivalentes a listas vacías.'},
  {Concepto:'Precisión',Detalle:'Tolerancia absoluta 0,00000001 para representación numérica. No se aplica tolerancia de 5% a recetas actuales.'},
  {Concepto:'Comprobación adicional',Detalle:`Componentes, cantidades, unidades, rendimiento y visibilidad coinciden entre fuente original y adaptador del maestro en ambos locales. Discrepancias: ${legacyMismatches.length}.`},
  {Concepto:'Líneas',Detalle:`La Concepción: ${result.recipeDetail.linesA}; Lyon: ${result.recipeDetail.linesB}; faltantes: ${missingLines.length}; adicionales: ${unexpectedLines.length}.`},
]);
const workbook=path.join(output,'Auditoria_Maestros_Concepcion_Lyon.xlsx');
XLSX.writeFile(wb,workbook);
const reopened=XLSX.readFile(workbook);
if (XLSX.utils.sheet_to_json(reopened.Sheets['Componentes faltantes']).length !== missingLines.length) throw Error('Workbook verification failed');
console.log(JSON.stringify({output,categories:categories.map(([name,r])=>({name,totalA:r.countA,totalB:r.countB,equal:r.equal,changed:r.changed.length,onlyA:r.onlyA})),recipeCompositionChanges:result.recipes.changed.filter(p=>p.fields.some(f=>f.field==='ingredients')).length,missingLines:missingLines.length,affectedRecipes:new Set(missingLines.map(r=>r['Código receta'])).size,unexpectedLines:unexpectedLines.length,legacyMismatches:legacyMismatches.length},null,2));
