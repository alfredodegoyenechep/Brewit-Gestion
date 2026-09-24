const {convert}=require('./domain');
// A read-only baseline. No inferred recipe, unit or stock policy is published.
function baseline(source) {
  if (!source) return { available:false, issues:[{type:'missing-source',message:'No hay una captura sincronizada de maestros.'}], items:[] };
  const seen=new Set(),issues=[],items=[];
  for(const p of source.products || []){
    const itemIssues=[];
    if(!p.code || seen.has(p.code))itemIssues.push('Código ausente o duplicado');
    seen.add(p.code);
    if(p.stockManaged == null)itemIssues.push('Política de stock desconocida');
    if(!p.stockUnit)itemIssues.push('Falta unidad de inventario');
    for(const c of p.conversions || [])if(!(c.numerator>0 && c.denominator>0))itemIssues.push(`Conversión inválida: ${c.conversion_unit}`);
    if(p.recipe?.ingredients?.some(l=>l.variant_overrides?.length))itemIssues.push('Variantes requieren configuración explícita');
    if(p.recipe?.ingredients?.some(l=>!(l.yield_rate>0)))itemIssues.push('Rendimiento de ingrediente inválido');
    if(p.stockManaged && p.recipe?.ingredients?.length && !p.recipe.manufacturing_use_only)itemIssues.push('Confirmar preparado almacenado o receta al vender');
    const proposedPolicy=p.stockManaged?(p.recipe?.ingredients?.length?'prepared':'stock'):(p.recipe?.ingredients?.length?'recipe':'service');
    items.push({code:p.code,name:p.name,active:p.active,baseUnit:p.stockUnit,proposedPolicy,issues:itemIssues,sourceId:p.id});
    issues.push(...itemIssues.map(message=>({code:p.code,type:'master-review',message})));
  }
  for(const p of source.products || [])for(const line of p.recipe?.ingredients || [])if(!seen.has(line.custom_id))issues.push({code:p.code,type:'missing-ingredient',message:`Ingrediente ${line.custom_id} ausente`});
  const byCode=new Map((source.products || []).map(p=>[p.code,p]));
  for(const p of source.products || []){
    const recipe=p.recipe;if(!recipe?.ingredients?.length)continue;
    if(!(recipe.quantity>0 && recipe.portions_per_unit>0) || !recipe.quantity_unit)issues.push({code:p.code,type:'recipe-yield',message:'Cantidad, unidad de producción o porciones inválidas.'});
    for(const line of recipe.ingredients){
      if(!(line.quantity>0))issues.push({code:p.code,type:'recipe-quantity',message:`Cantidad no positiva de ${line.custom_id}; revisar receta.`});
      const ingredient=byCode.get(line.custom_id);if(!ingredient)continue;
      try{convert({code:ingredient.code,baseUnit:String(ingredient.stockUnit||'').toUpperCase(),conversions:(ingredient.conversions||[]).filter(c=>String(c.base_unit).toUpperCase()===String(ingredient.stockUnit).toUpperCase()).map(c=>({unit:String(c.conversion_unit).toUpperCase(),numerator:c.numerator,denominator:c.denominator}))},'1',String(line.quantity_unit||'').toUpperCase());}
      catch{issues.push({code:p.code,type:'recipe-unit',message:`Revisar conversión de ${line.custom_id}: ${line.quantity_unit || 'sin unidad'} a ${ingredient.stockUnit || 'sin unidad base'}.`});}
    }
  }
  const visiting=new Set(),visited=new Set();
  function visit(code,trail=[]){
    if(visiting.has(code)){issues.push({code,type:'recipe-cycle',message:`Receta circular: ${[...trail,code].join(' → ')}`});return;}
    if(visited.has(code))return;visiting.add(code);
    for(const line of byCode.get(code)?.recipe?.ingredients || [])if(byCode.has(line.custom_id))visit(line.custom_id,[...trail,code]);
    visiting.delete(code);visited.add(code);
  }
  for(const code of byCode.keys())visit(code);
  for(const item of items)item.issues=[...new Set(issues.filter(i=>i.code===item.code).map(i=>i.message))];
  return {available:true,observedAt:source.observedAt,source:source.source,items,suppliers:source.suppliers || [],warehouses:source.warehouses || [],issues,
    cutover:{ready:false,mode:'preparation',required:['Mapear y aprobar maestros/recetas propios','Toma física y valorización de apertura','Certificar ventas, extras y sustituciones','Migrar los reportes','Dos semanas de ensayo sin incidencias críticas','Cierre mensual y restauración ensayados']}};
}
module.exports={baseline};
