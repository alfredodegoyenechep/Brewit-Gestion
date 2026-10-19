(() => {
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
  const states = { receiving:'Recibiendo / pendiente de confirmación', complete:'Completa', incomplete:'Incompleta', pending:'Pendiente', done:'Comparada',
    'not-applicable':'No corresponde', published:'Publicada', 'not-published':'Sin publicar', antecedent:'Antecedente', partial:'Comparación parcial', baseline:'Línea base' };
  const types = { modified:'Modificado', deleted:'Eliminado', historicalAdded:'Agregado histórico', masterAdded:'Alta de maestro', ambiguous:'Identidad pendiente' };
  const originNames = {manual:'Archivo manual','toteat-public-api':'API pública Toteat','toteat-authenticated-web':'Servicios web Toteat','toteat-web-file':'Archivo web Toteat','mercadopago-web':'Reportes web MercadoPago',legacy:'Antecedentes anteriores'};
  const time = value => value ? new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'short',timeStyle:'medium'}).format(new Date(value)) : '—';
  const bytes = n => { const units=['KB','MB','GB']; n/=1000; let i=0; while(n>=1000 && i<units.length-1){n/=1000;i++;} return `${new Intl.NumberFormat('es-CL',{maximumFractionDigits:n<0.01?3:2}).format(n)} ${units[i]}`; };
  const valueText = (v, present=true) => !present ? 'Campo ausente' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v,null,2) : String(v);
  let options, locations = {}, tab='changes', offset=0, detailOffset=0, detailId, requestId=0, timer;
  async function api(url) {
    const response=await fetch(url);
    if(!response.ok)throw Error((await response.json().catch(()=>({}))).error || (response.status===404 ? 'El servidor no tiene disponible esta consulta de Control histórico. Reinicia el servidor y vuelve a cargar la página.' : 'No se pudo consultar el control histórico.'));
    return response.json();
  }
  const name = dataset => options?.datasets[dataset] || dataset;
  const locationName = id => locations[id] || ({shared:'Compartido',all:'Todas las ubicaciones','*':'Todas las bodegas'}[id]) || id;
  const warehouseName = id => options?.warehouseLabels?.[id] || id;
  const link = (text, href) => { const a=node('a',text,'icon-button'); a.href=href; return a; };
  function table(headers, rows) {
    const wrap=node('div',null,'historical-table-wrap'), table=node('table',null,'inventory-results-table');
    const head=node('thead'), tr=node('tr');headers.forEach(h=>tr.append(node('th',h)));head.append(tr);table.append(head);
    const body=node('tbody'); for(const cells of rows){const row=node('tr'); for(const cell of cells){const td=node('td');td.append(cell instanceof Node?cell:document.createTextNode(String(cell??'—')));row.append(td);}body.append(row);}table.append(body);wrap.append(table);return wrap;
  }
  function sourceStatus(source) {
    const historical=source.summary.modified+source.summary.deleted+source.summary.historicalAdded;
    if(source.status==='complete' && !historical)return 'Sin cambios históricos detectados';
    return states[source.status] || source.status;
  }
  function query() {
    const q=new URLSearchParams({offset:String(offset),limit:'30'});
    for(const [field,id] of [['date','historical-date'],['dataset','historical-dataset'],['origin','historical-origin'],['location','historical-location'],['warehouse','historical-warehouse-filter']])if(el(id).value)q.set(field,el(id).value);
    return q;
  }
  async function refresh() {
    const current=++requestId; clearTimeout(timer);el('historical-status').textContent='Consultando respaldos…';
    try {
      if(tab==='storage') {
        const result=await api('/api/historical-control/storage?'+new URLSearchParams({date:el('historical-date').value || options.today}));
        if(current!==requestId)return;renderStorage(result);el('historical-pagination').hidden=true;
      } else {
        const result=await api('/api/historical-control/runs?'+query());
        if(current!==requestId)return;renderRuns(result.runs);
        el('historical-page').textContent=result.total?`${offset+1}–${offset+result.runs.length} de ${result.total} cargas`:'0 cargas';
        el('historical-prev').disabled=offset===0;el('historical-next').disabled=offset+30>=result.total;el('historical-pagination').hidden=!result.total;
        if(result.runs.some(r=>r.comparison==='pending' || r.reception==='receiving'))timer=setTimeout(()=>{if(!el('historical-workspace').hidden)refresh();},5000);
      }
      el('historical-status').textContent='';
    } catch(error) { if(current===requestId)el('historical-status').textContent=error.message; }
  }
  function renderRuns(runs) {
    const target=el('historical-content');target.replaceChildren();
    if(!runs.length){target.append(node('p','No hay cargas registradas para estos filtros.','historical-empty'));return;}
    for(const run of runs){
      const card=node('article',null,'historical-run');
      const heading=node('div',null,'historical-run-heading');heading.append(node('h3',`${time(run.startedAt)} · ${originNames[run.origin] || run.origin}`),node('span',run.antecedent?'Antecedente':`${states[run.reception]} · ${states[run.comparison]}`,'historical-badge'));card.append(heading);
      card.append(node('p',`${locationName(run.location)} · Versión ${run.id}`,'panel-description'));
      if(run.upstream)card.append(node('p',`Origen: restaurante ${run.upstream.restaurantId || '—'} · local ${run.upstream.localId || '—'}`,'panel-description'));
      if(run.error || run.comparisonError)card.append(node('p',run.error || run.comparisonError,'historical-notice'));
      if(run.antecedent)card.append(node('p',`Recibido originalmente: ${time(run.originalReceivedAt)}. Incorporado: ${time(run.savedAt)}. No genera alertas retroactivas.`,'panel-description'));
      const summaries=(run.summaries || []).filter(s=>(!el('historical-dataset').value || s.dataset===el('historical-dataset').value) && (!el('historical-location').value || s.location===el('historical-location').value));
      if(tab==='changes'){
        if(summaries.length)card.append(table(['Conjunto / ámbito','Modificados','Eliminados','Agregados históricos','Crecimiento normal','Altas maestros','Estado'],summaries.map(s=>[
          `${name(s.dataset)} · ${locationName(s.location)} · ${locationName(s.warehouse)}`,s.summary.modified,s.summary.deleted,s.summary.historicalAdded,s.summary.growth,s.summary.masterAdded,sourceStatus(s)
        ])));
        else card.append(node('p',run.antecedent?'Antecedente disponible para consulta.':run.reception==='incomplete'?'Carga incompleta: no se generan alertas históricas.':run.comparison==='done'?'No se recibieron archivos o conjuntos de datos para comparar.':'Comparación pendiente.','panel-description'));
      }
      if(tab==='backups')card.append(table(['Archivo original','Conjunto / ámbito','Período','Registros','Guardado','Tamaño comprimido','Acción'],run.artifacts.map(a=>[
        `${a.name}${({'reconstruction':' · Reconstrucción; original no disponible','partial':' · Archivo recibido incompleto','incomplete':' · Antecedente incompleto; original no recuperable'}[a.evidence]) || ''}`,
        a.datasets.map(d=>`${name(d.dataset)} · ${originNames[a.origin || run.origin] || a.origin || run.origin} · ${locationName(d.location || run.location)}${d.warehouse && d.warehouse!=='*'?' · '+d.warehouse:''}`).join(', ') || 'Antecedente',
        a.datasets.map(d=>`${d.range?`Período: ${d.range.from} → ${d.range.to}`:d.master?`Maestro${d.validFrom?' · Vigente desde '+d.validFrom:''}`:'Cobertura no confirmada'}${d.receivedRange?' · Recibido: '+d.receivedRange.from+' → '+d.receivedRange.to:''}`).join(', ') || 'No disponible',
        a.datasets.map(d=>`${name(d.dataset)}: ${d.recordCount??'Pendiente'}`).join(', ') || 'No disponible',time(a.savedAt),bytes(a.bytes),
        link('Descargar',`/api/historical-control/runs/${run.id}/files/${a.id}/download`)
      ])));
      const actions=node('div',null,'historical-actions');
      if(run.comparison==='done'){
        const button=node('button','Ver detalle de comparación','icon-button');button.type='button';button.addEventListener('click',()=>openDetails(run));actions.append(button,link('Descargar reporte',`/api/historical-control/runs/${run.id}/report`));
      }
      card.append(actions);target.append(card);
    }
  }
  function renderStorage(data) {
    const target=el('historical-content');target.replaceChildren();
    const kpis=node('div',null,'historical-kpis');
    for(const [label,value] of [['Archivos guardados',data.fileCount],['Agregado ese día',bytes(data.dailyBytes)],['Acumulado a la fecha',bytes(data.totalBytes)],['Uso actual',bytes(data.currentBytes)],['Promedio diario',bytes(data.averageDailyBytes)],['Estimación mensual',bytes(data.estimatedMonthlyBytes)]]){
      const card=node('div',null,'historical-kpi');card.append(node('span',label),node('strong',value));kpis.append(card);
    }target.append(kpis,node('p',`Promedio del ${data.averagePeriod.from} al ${data.averagePeriod.to}: ${data.averagePeriod.days} días calendario, incluidos días sin cargas. ${data.formula}. Unidades decimales. Se cuentan originales comprimidos, reportes, estados y metadatos; cada archivo físico una sola vez.`,'panel-description'));
    if(data.files.length)target.append(table(['Archivo físico','Tipo','Guardado','Espacio utilizado'],data.files.map(f=>[f.name,({'original':'Original comprimido','metadata':'Metadatos','report':'Reporte','comparison-state':'Estado de comparación','unregistered-evidence':'Archivo pendiente de identificar'}[f.kind] || f.kind),time(f.savedAt),bytes(f.bytes)])));
    else target.append(node('p','No se guardaron archivos ese día.','historical-empty'));
  }
  async function openDetails(run) {
    detailId=run.id;detailOffset=0;el('historical-detail-title').textContent=`Comparación · ${time(run.startedAt)}`;
    el('historical-detail').showModal();await loadDetails();
  }
  async function loadDetails() {
    const target=el('historical-detail-content');target.replaceChildren(node('p','Consultando cambios…'));
    try {
      const q=query();q.set('offset',String(detailOffset));q.set('limit','30');
      const data=await api(`/api/historical-control/runs/${detailId}/changes?`+q);target.replaceChildren();
      for(const source of data.sources || [])target.append(node('p',`${name(source.dataset)} · ${locationName(source.location)} · ${sourceStatus(source)}. Versiones: ${source.previousRunId || 'Sin versión anterior'} → ${detailId}.`,'panel-description'));
      for(const change of data.changes){
        const block=node('article',null,'historical-change');
        block.append(node('h4',`${types[change.type]} · ${name(change.dataset)} · ${change.id || 'Sin identificador'}`));
        block.append(node('p',change.type==='ambiguous'?change.reason:`Detectado el ${time(change.detectedAt)}; operación del ${change.operationDate || 'fecha no disponible'}${change.previousDate && change.previousDate!==change.operationDate?' (antes: '+change.previousDate+')':''}. ${locationName(change.location)} · Bodega: ${change.warehouses?.length?change.warehouses.map(warehouseName).join(', '):change.warehouse || 'No informada'}.`));
        if(change.previousRunId)block.append(node('p',`Versión anterior: ${change.previousRunId} → ${change.runId}`,'panel-description'));
        if(change.fields?.length)block.append(table(['Campo','Valor anterior','Valor nuevo'],change.fields.map(f=>[f.field,node('pre',valueText(f.before,f.beforePresent)),node('pre',valueText(f.after,f.afterPresent))])));
        target.append(block);
      }
      if(!data.total)target.append(node('p','No hay registros afectados en esta comparación.'));
      el('historical-detail-page').textContent=`${data.total ? detailOffset+1 : 0}–${Math.min(detailOffset+30,data.total)} de ${data.total}`;
      el('historical-detail-prev').disabled=detailOffset===0;el('historical-detail-next').disabled=detailOffset+30>=data.total;
    }catch(error){target.replaceChildren(node('p',error.message));}
  }
  window.openHistoricalControl = async () => {
    if(!options){
      el('historical-status').textContent='Consultando respaldos…';
      try {
        const [data,registry]=await Promise.all([api('/api/historical-control/options'),api('/api/config/locations')]);options=data;
        locations=Object.fromEntries([...(registry.active || []),...(registry.trash || [])].map(l=>[l.id,l.name]));
        el('historical-date').value=data.today;
        for(const [id,items] of [['historical-dataset',Object.entries(data.datasets)],['historical-origin',data.origins.map(o=>[o,originNames[o] || o])],['historical-location',data.locations.map(l=>[l,locationName(l)])],['historical-warehouse-filter',data.warehouses.map(w=>[w,warehouseName(w)])]])for(const [value,label] of items){const option=node('option',label);option.value=value;el(id).append(option);}
      }catch(error){el('historical-status').textContent=error.message;return;}
    }
    await refresh();
  };
  for(const id of ['historical-date','historical-dataset','historical-origin','historical-location','historical-warehouse-filter'])el(id).addEventListener('change',()=>{offset=0;refresh();});
  el('historical-refresh').addEventListener('click',()=>window.openHistoricalControl());
  for(const button of document.querySelectorAll('[data-historical-tab]'))button.addEventListener('click',()=>{
    tab=button.dataset.historicalTab;offset=0;for(const b of document.querySelectorAll('[data-historical-tab]'))b.setAttribute('aria-selected',String(b===button));
    for(const id of ['historical-dataset','historical-origin','historical-location','historical-warehouse-filter'])el(id).disabled=tab==='storage';refresh();
  });
  el('historical-prev').addEventListener('click',()=>{offset=Math.max(0,offset-30);refresh();});el('historical-next').addEventListener('click',()=>{offset+=30;refresh();});
  el('historical-detail-close').addEventListener('click',()=>el('historical-detail').close());
  el('historical-detail-prev').addEventListener('click',()=>{detailOffset=Math.max(0,detailOffset-30);loadDetails();});el('historical-detail-next').addEventListener('click',()=>{detailOffset+=30;loadDetails();});
})();
