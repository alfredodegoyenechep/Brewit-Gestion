(() => {
  const el = id => document.getElementById(id);
  const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
  const states = { receiving:'Recibiendo / pendiente de confirmación', complete:'Completa', incomplete:'Incompleta', pending:'Pendiente', done:'Comparada',
    'not-applicable':'No corresponde', published:'Publicada', 'not-published':'Sin publicar', antecedent:'Antecedente', partial:'Comparación parcial', baseline:'Línea base' };
  const types = { modified:'Modificado', deleted:'Eliminado', historicalAdded:'Agregado histórico', masterAdded:'Alta de maestro', ambiguous:'Identidad pendiente',incomplete:'Carga incompleta',pending:'Comparación pendiente',partial:'Comparación parcial' };
  const originNames = {manual:'Archivo manual','toteat-public-api':'API pública Toteat','toteat-authenticated-web':'Servicios web Toteat','toteat-web-file':'Archivo web Toteat','mercadopago-web':'Reportes web MercadoPago',legacy:'Antecedentes anteriores'};
  const time = value => value ? new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'short',timeStyle:'medium'}).format(new Date(value)) : '—';
  const bytes = n => { const units=['KB','MB','GB']; n/=1000; let i=0; while(n>=1000 && i<units.length-1){n/=1000;i++;} return `${new Intl.NumberFormat('es-CL',{maximumFractionDigits:n<0.01?3:2}).format(n)} ${units[i]}`; };
  let options, locations = {}, tab='alerts', offset=0, detailOffset=0, detailId, requestId=0, timer;
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
  function changeContent(change) {
    const section=node('section',null,'historical-readable-change'), model=change.presentation;
    if (!model) {
      section.append(node('p','El detalle de los artículos no está disponible. Consulta la carga y sus respaldos para revisar este cambio.','historical-notice'));
      return section;
    }
    section.append(node('p',model.summary,'historical-change-summary'));
    for (const warning of model.warnings) section.append(node('p',warning,'historical-notice'));
    for (const notice of model.notices) {
      const message=node('p',null,'historical-change-notice');
      message.append(node('strong',[notice.itemName,notice.code].filter(Boolean).join(' · ')),document.createTextNode(' · '+notice.message));section.append(message);
    }
    if (model.rows.length) {
      const controls=node('div',null,'historical-change-controls'),label=node('label','Buscar artículo, código o dato modificado');
      const search=node('input');search.type='search';search.placeholder='Ej.: salsa chocolate, SSR008, costo';label.append(search);
      const count=node('span',null,'panel-description'),results=node('div');controls.append(label,count);section.append(controls,results);
      const draw=()=>{
        const normalized=v=>String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const query=normalized(search.value),rows=model.rows.filter(row=>!query || [row.itemName,row.code,row.stage,row.field,row.before,row.after].some(v=>normalized(v).includes(query)));
        count.textContent=`${rows.length} de ${model.rows.length} cambios`;
        if(!rows.length){results.replaceChildren(node('p','No hay cambios que coincidan con la búsqueda.','historical-empty'));return;}
        const content=table(['Artículo / ingrediente','Etapa','Qué cambió','Valor anterior','Valor nuevo','Diferencia'],rows.map(row=>{
          const item=node('div',null,'historical-change-item');item.append(node('strong',row.itemName));
          if(row.code)item.append(node('span',row.code,'historical-item-code'));
          const field=node('span',row.field,`historical-field-${row.type}`);
          return [item,row.stage,field,node('span',row.before,'historical-previous-value'),node('strong',row.after,'historical-current-value'),row.difference];
        }));content.classList.add('historical-readable-table');results.replaceChildren(content);
      };
      search.addEventListener('input',draw);draw();
      section.append(node('p','Los valores corresponden a las versiones comparadas. La diferencia se muestra cuando ambos valores son numéricos y usan la misma unidad.','panel-description'));
    }
    if(model.administrativeCount && model.rows.length)section.append(node('p','También se actualizó información administrativa del registro.','panel-description'));
    return section;
  }
  function sourceStatus(source) {
    const historical=source.summary.modified+source.summary.deleted+source.summary.historicalAdded;
    if(source.status==='complete' && !historical)return 'Sin cambios históricos detectados';
    return states[source.status] || source.status;
  }
  function query() {
    const q=new URLSearchParams({offset:String(offset),limit:'30'});
    for(const [field,id] of [['date','historical-date'],['dataset','historical-dataset'],['origin','historical-origin'],['location','historical-location'],['warehouse','historical-warehouse-filter']])if(el(id).value)q.set(field,el(id).value);
    if(tab==='alerts'){
      if(el('historical-date-to').value)q.set('dateTo',el('historical-date-to').value);
      if(el('historical-alert-type').value)q.set('type',el('historical-alert-type').value);
    }
    return q;
  }
  async function refresh() {
    const current=++requestId; clearTimeout(timer);el('historical-status').textContent='Consultando respaldos…';
    try {
      if(tab==='alerts') {
        const result=await api('/api/historical-control/alerts?'+query());
        if(current!==requestId)return;renderAlerts(result);
        el('historical-page').textContent=result.total?`${offset+1}–${offset+result.alerts.length} de ${result.total} alertas`:'0 alertas';
        el('historical-prev').disabled=offset===0;el('historical-next').disabled=offset+30>=result.total;el('historical-pagination').hidden=!result.total;
      } else if(tab==='storage') {
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
  function renderAlerts(data) {
    const target=el('historical-content');target.replaceChildren();
    const summary=data.summary,kpis=node('div',null,'historical-kpis');
    for(const [label,key] of [['Registros modificados','modified'],['Registros eliminados','deleted'],['Agregados históricos','historicalAdded'],['Requieren revisión','review']]){
      const card=node('div',null,'historical-kpi');card.append(node('span',label),node('strong',summary[key]));kpis.append(card);
    }
    const toolbar=node('div',null,'historical-actions'),q=query();q.delete('offset');q.delete('limit');q.set('format','csv');
    toolbar.append(link('Descargar reporte CSV','/api/historical-control/alerts?'+q));
    target.append(kpis,node('p',data.message,summary.review+summary.modified+summary.deleted+summary.historicalAdded?'historical-notice':'historical-empty'),
      node('p',`${summary.executions} cargas evaluadas · ${summary.completeSources} comparaciones completas · ${summary.baselineSources} líneas base · ${summary.partialSources} comparaciones parciales · ${summary.antecedents} antecedentes incorporados. Los contadores abarcan el período y ámbito seleccionados, antes del filtro por tipo. Las altas de maestros y el crecimiento normal se consultan en «Cambios del día».`,'panel-description'),toolbar);
    if(!data.alerts.length){
      if(summary.modified+summary.deleted+summary.historicalAdded+summary.review)target.append(node('p','No hay alertas del tipo seleccionado.','historical-empty'));
      return;
    }
    const alertsTable=table(['Alerta','Detección / operación','Conjunto / ámbito','Documento / artículo','Detalle'],data.alerts.map(alert=>{
      const detail=node('div');
      detail.append(node('p',`Detectado el ${time(alert.detectedAt)}; operación del ${alert.operationDate || 'fecha no disponible'}${alert.previousDate && alert.previousDate!==alert.operationDate?' (antes: '+alert.previousDate+')':''}. ${name(alert.dataset) || 'Carga'} · ${locationName(alert.location)}.`));
      if(alert.message)detail.append(node('p',alert.message));
      if(alert.sourceStatus==='partial')detail.append(node('p','Hallazgo identificado en una comparación parcial.','historical-notice'));
      if(alert.fields.length)detail.append(changeContent(alert));
      const version=node('button','Consultar carga y respaldos','icon-button');version.type='button';version.addEventListener('click',async()=>{
        version.disabled=true;
        try{
          const run=await api('/api/historical-control/runs/'+alert.runId),files=node('div',null,'historical-actions');
          files.append(node('p',`Carga recibida: ${time(run.startedAt)} · ${states[run.reception]} · ${states[run.publication] || run.publication}`));
          for(const artifact of run.artifacts)files.append(link('Descargar '+artifact.name,`/api/historical-control/runs/${run.id}/files/${artifact.id}/download`));
          if(run.comparison==='done'){const compare=node('button','Ver comparación','icon-button');compare.type='button';compare.addEventListener('click',()=>openDetails(run));files.append(compare);}
          detail.append(files);version.remove();
        }catch(error){el('historical-status').textContent=error.message;version.disabled=false;}
      });detail.append(version);
      const inspect=node('button','Ver detalle de alerta','icon-button');inspect.type='button';inspect.addEventListener('click',()=>{
        el('historical-detail-title').textContent=`${types[alert.type]} · ${name(alert.dataset) || 'Carga'}${alert.id?' · Documento '+alert.id:''}`;
        el('historical-detail-content').replaceChildren(detail);el('historical-detail-pagination').hidden=true;el('historical-detail').showModal();
      });
      return [node('span',types[alert.type],alert.category==='historical'?'historical-alert-badge':'historical-badge'),
        `Detectado el ${time(alert.detectedAt)}; operación del ${alert.operationDate || 'fecha no disponible'}${alert.previousDate && alert.previousDate!==alert.operationDate?' (antes: '+alert.previousDate+')':''}`,
        `${name(alert.dataset) || 'Carga'} · ${originNames[alert.origin] || alert.origin} · ${locationName(alert.location)}${alert.warehouses?.length?' · '+alert.warehouses.map(warehouseName).join(', '):alert.warehouse && alert.warehouse!=='*'?' · '+warehouseName(alert.warehouse):''}`,
        (()=>{const cell=node('div');cell.append(node('strong',alert.id || '—'));
          const affected=[...new Set([...(alert.presentation?.rows || []),...(alert.presentation?.notices || [])].map(row=>row.itemName).filter(item=>item && item!=='Documento'))];
          if(affected.length)cell.append(node('p',affected.slice(0,2).join(', ')+(affected.length>2?` y ${affected.length-2} más`:''),'panel-description'));
          return cell;})(),inspect];
    }));alertsTable.classList.add('historical-alerts-table');target.append(alertsTable);
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
    el('historical-detail-pagination').hidden=false;
    el('historical-detail').showModal();await loadDetails();
  }
  async function loadDetails() {
    const target=el('historical-detail-content');target.replaceChildren(node('p','Consultando cambios…'));
    try {
      const q=query();q.set('offset',String(detailOffset));q.set('limit','30');
      const data=await api(`/api/historical-control/runs/${detailId}/changes?`+q);target.replaceChildren();
      for(const source of data.sources || [])target.append(node('p',`${name(source.dataset)} · ${locationName(source.location)} · ${sourceStatus(source)}.`,'panel-description'));
      for(const change of data.changes){
        const block=node('article',null,'historical-change');
        block.append(node('h4',`${types[change.type]} · ${name(change.dataset)} · ${change.id || 'Sin identificador'}`));
        block.append(node('p',change.type==='ambiguous'?change.reason:`Detectado el ${time(change.detectedAt)}; operación del ${change.operationDate || 'fecha no disponible'}${change.previousDate && change.previousDate!==change.operationDate?' (antes: '+change.previousDate+')':''}. ${locationName(change.location)} · Bodega: ${change.warehouses?.length?change.warehouses.map(warehouseName).join(', '):change.warehouse || 'No informada'}.`));
        if(change.fields?.length)block.append(changeContent(change));
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
        el('historical-date-to').value=data.today;
        for(const [id,items] of [['historical-dataset',Object.entries(data.datasets)],['historical-origin',data.origins.map(o=>[o,originNames[o] || o])],['historical-location',data.locations.map(l=>[l,locationName(l)])],['historical-warehouse-filter',data.warehouses.map(w=>[w,warehouseName(w)])]])for(const [value,label] of items){const option=node('option',label);option.value=value;el(id).append(option);}
      }catch(error){el('historical-status').textContent=error.message;return;}
    }
    await refresh();
  };
  for(const id of ['historical-date','historical-date-to','historical-alert-type','historical-dataset','historical-origin','historical-location','historical-warehouse-filter'])el(id).addEventListener('change',()=>{
    if(id==='historical-date' && el('historical-date-to').value<el(id).value)el('historical-date-to').value=el(id).value;
    offset=0;refresh();
  });
  el('historical-refresh').addEventListener('click',()=>window.openHistoricalControl());
  for(const button of document.querySelectorAll('[data-historical-tab]'))button.addEventListener('click',()=>{
    tab=button.dataset.historicalTab;offset=0;for(const b of document.querySelectorAll('[data-historical-tab]'))b.setAttribute('aria-selected',String(b===button));
    updateTabFilters();refresh();
  });
  function updateTabFilters() {
    for(const filter of document.querySelectorAll('[data-historical-alert-filter]'))filter.hidden=tab!=='alerts';
    el('historical-date-label').textContent=tab==='alerts'?'Detectado desde':'Fecha de carga';
    for(const id of ['historical-dataset','historical-origin','historical-location','historical-warehouse-filter'])el(id).disabled=tab==='storage';
  }
  el('historical-prev').addEventListener('click',()=>{offset=Math.max(0,offset-30);refresh();});el('historical-next').addEventListener('click',()=>{offset+=30;refresh();});
  el('historical-detail-close').addEventListener('click',()=>el('historical-detail').close());
  el('historical-detail-prev').addEventListener('click',()=>{detailOffset=Math.max(0,detailOffset-30);loadDetails();});el('historical-detail-next').addEventListener('click',()=>{detailOffset+=30;loadDetails();});
})();
