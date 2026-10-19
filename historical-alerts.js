const { LABELS } = require('./historical-adapters');

const TYPES = { modified:'Registro modificado', deleted:'Registro eliminado', historicalAdded:'Alta histórica',
  incomplete:'Carga incompleta', pending:'Comparación pendiente', partial:'Comparación parcial' };
const HISTORICAL = ['modified','deleted','historicalAdded'];
const day = time => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date(time));
const timestamp = time => new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'short',timeStyle:'medium'}).format(new Date(time));
const matches = (source, query) => (!query.dataset || source.dataset === query.dataset)
  && (!query.origin || source.origin === query.origin) && (!query.location || source.location === query.location)
  && (!query.warehouse || source.warehouse === query.warehouse || source.warehouses?.includes(query.warehouse));

// Read the persisted comparisons; never infer changes from operational records or
// from antecedents imported at activation. Counters cover the entire selection,
// independently of the current page or alert-type filter.
function collect(history, query) {
  const summary = { modified:0, deleted:0, historicalAdded:0, review:0, executions:0,
    completeSources:0, baselineSources:0, partialSources:0, antecedents:0 };
  const alerts = [];
  const inPeriod = time => { const date=day(time); return date >= query.date && date <= query.dateTo; };
  const descriptors = run => {
    const sources=run.artifacts.flatMap(a=>a.datasets.map(s=>({...s,origin:a.origin || run.origin,location:s.location || run.location})));
    if(!sources.length)sources.push(...(run.datasets?.length?run.datasets:[null]).map(dataset=>({dataset,origin:run.origin,location:run.location})));
    return [...new Map(sources.map(s=>[JSON.stringify([s.dataset,s.origin,s.location,s.warehouse]),s])).values()];
  };
  const issue = (run, source, type, message, detectedAt) => {
    summary.review++;
    alerts.push({type,category:'review',runId:run.id,previousRunId:source.previousRunId || null,
      dataset:source.dataset,origin:source.origin,location:source.location,warehouse:source.warehouse,
      warehouses:source.warehouses || [],warehouseNames:source.warehouseNames || {},detectedAt,message,fields:[],id:null,operationDate:null});
  };
  for(const run of history.manifests()) {
    const sources=(run.summaries?.length?run.summaries:descriptors(run)).filter(s=>matches(s,query));
    if(!sources.length)continue;
    if(run.antecedent){if(inPeriod(run.savedAt))summary.antecedents++;continue;}
    const detectedAt=run.comparedAt || run.finishedAt || run.startedAt;
    if(!inPeriod(detectedAt))continue;
    summary.executions++;
    if(run.reception!=='complete') {
      for(const source of sources)issue(run,source,run.reception==='receiving'?'pending':'incomplete',run.error ||
        (run.reception==='receiving'?'Recepción en curso o pendiente de confirmación.':'La carga quedó incompleta. No se certifican eliminaciones ni se generan alertas históricas.'),detectedAt);
      continue;
    }
    if(run.comparison!=='done') {
      for(const source of sources)issue(run,source,'pending',run.comparisonError || 'El respaldo está guardado; la comparación todavía no está disponible.',detectedAt);
      continue;
    }
    let report;
    try {
      if(sources.some(s=>HISTORICAL.some(type=>s.summary?.[type]>0)))report=history.report(run.id);
      if(sources.some(s=>HISTORICAL.some(type=>s.summary?.[type]>0)) && !report)throw Error('Missing report');
    } catch {
      for(const source of sources)issue(run,source,'pending','No se pudo leer el reporte guardado. La comparación requiere revisión.',detectedAt);
      continue;
    }
    for(const source of sources) {
      if(source.status==='baseline')summary.baselineSources++;
      if(source.status==='complete')summary.completeSources++;
      if(source.status==='partial') {
        summary.partialSources++;
        issue(run,source,'partial',`Cobertura parcial${source.summary?.ambiguous?`; ${source.summary.ambiguous} identidades pendientes`:''}. Las modificaciones identificables siguen visibles; no se certifica la ausencia de cambios.`,detectedAt);
      }
    }
    for(const source of report?.sources || []) {
      if(!matches(source,query))continue;
      for(const change of source.changes) {
        if(!HISTORICAL.includes(change.type))continue;
        if(query.warehouse && change.warehouse!==query.warehouse && !change.warehouses?.includes(query.warehouse))continue;
        summary[change.type]++;
        alerts.push({...change,category:'historical',dataset:source.dataset,origin:source.origin,
          location:source.location,warehouse:change.warehouse || source.warehouse,warehouseNames:source.warehouseNames || {},sourceStatus:source.status});
      }
    }
  }
  alerts.sort((a,b)=>b.detectedAt.localeCompare(a.detectedAt) || a.runId.localeCompare(b.runId) || String(a.id || '').localeCompare(String(b.id || '')));
  let message;
  if(summary.modified+summary.deleted+summary.historicalAdded)message='Hay alteraciones históricas detectadas para auditar.';
  else if(summary.review)message='Sin alteraciones históricas confirmadas; hay cargas o comparaciones que requieren revisión.';
  else if(summary.baselineSources)message='Sin alertas históricas. Las primeras coberturas válidas establecen la línea base para comparaciones posteriores.';
  else if(summary.completeSources)message='Sin cambios históricos detectados';
  else if(summary.executions)message='No se recibieron conjuntos de datos comparables en este período.';
  else if(summary.antecedents)message='Solo hay antecedentes incorporados en este período. No generan alertas retroactivas; la primera recepción nueva válida establecerá la línea base.';
  else message='No hay cargas ni comparaciones para este período y filtros.';
  return {generatedAt:new Date().toISOString(),timeZone:'America/Santiago',filters:{date:query.date,dateTo:query.dateTo,
    dataset:query.dataset || null,origin:query.origin || null,location:query.location || null,warehouse:query.warehouse || null,type:query.type || null},
    summary,message,alerts:alerts.filter(a=>!query.type || (query.type==='review'?a.category==='review':a.type===query.type))};
}

function csv(report, {locations={}}={}) {
  const cell = value => {
    let text=value == null?'':typeof value==='object'?JSON.stringify(value):String(value);
    // Source fields must remain literal text when opened in a spreadsheet.
    if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  const rows=[['Reporte de alertas de Control histórico'],['Generado (Chile)',timestamp(report.generatedAt)],
    ['Detectado desde',report.filters.date,'Hasta',report.filters.dateTo],['Filtros',report.filters],
    ['Resumen',report.message],['Modificados',report.summary.modified,'Eliminados',report.summary.deleted,'Agregados históricos',report.summary.historicalAdded,'Revisiones pendientes',report.summary.review],
    [],['Tipo','Detectado (Chile)','Fecha operación','Fecha operación anterior','Conjunto','Origen','Sucursal / bodega','Sucursal / bodega (ID)','Bodegas',
      'Identificador','Campo','Valor anterior','Valor nuevo','Versión anterior','Versión nueva','Observación']];
  for(const alert of report.alerts)for(const field of alert.fields.length?alert.fields:[null])rows.push([
    TYPES[alert.type],timestamp(alert.detectedAt),alert.operationDate,alert.previousDate,LABELS[alert.dataset] || alert.dataset,
    alert.origin,locations[alert.location] || alert.location,alert.location,alert.warehouses?.length?alert.warehouses.map(id=>alert.warehouseNames?.[id]?`${alert.warehouseNames[id]} (${id})`:id).join(', '):alert.warehouse,alert.id,field?.field,
    field?(field.beforePresent?(field.before===null?'null':field.before):'Campo ausente'):null,field?(field.afterPresent?(field.after===null?'null':field.after):'Campo ausente'):null,
    alert.previousRunId,alert.runId,alert.message || (alert.sourceStatus==='partial'?'Hallazgo en una comparación parcial':'')]);
  return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n';
}
module.exports={collect,csv,TYPES};
