(() => {
 const dialog=document.createElement('dialog');dialog.id='upload-records-dialog';dialog.className='upload-records-dialog';
 dialog.innerHTML=`<div class="panel-heading"><h2 id="upload-records-title">Registros</h2><button type="button" id="upload-records-close" class="icon-button">Cerrar</button></div>
 <form id="upload-records-filter" class="upload-overview-actions"><label>Período <select id="upload-records-period"><option value="7">Última semana (7 días)</option><option value="30">Último mes (30 días)</option><option value="custom">Fechas personalizadas</option></select></label><label>Desde <input type="date" id="upload-records-from" required></label><label>Hasta <input type="date" id="upload-records-to" required></label><button class="primary" type="submit">Consultar</button></form>
 <p id="upload-records-note"></p><p id="upload-records-status" role="status" aria-live="polite"></p><div class="upload-records-scroll"><table id="upload-records-table"></table></div><div class="upload-overview-actions"><button id="upload-records-prev" type="button" class="icon-button">Anterior</button><span id="upload-records-page"></span><button id="upload-records-next" type="button" class="icon-button">Siguiente</button></div>`;
 dialog.setAttribute('aria-labelledby','upload-records-title');document.body.append(dialog);
 const el=id=>document.getElementById('upload-records-'+id);let target,page=1,sequence=0,abort;
 const text=(tag,value)=>{const e=document.createElement(tag);e.textContent=value??'—';return e;};
 function dates(){const n=Number(el('period').value);if(!n)return;const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date());el('to').value=today;el('from').value=new Date(Date.parse(today+'T12:00:00Z')-(n-1)*86400000).toISOString().slice(0,10);}
 async function query(){
  abort?.abort();abort=new AbortController();const request=++sequence;
  el('status').textContent='Consultando registros…';el('table').replaceChildren();el('note').textContent='';el('page').textContent='';el('prev').disabled=el('next').disabled=true;
  try{const params=new URLSearchParams({...target,from:el('from').value,to:el('to').value,page});const r=await fetch('/api/uploads/records?'+params,{signal:abort.signal,cache:'no-store'}),data=await r.json();if(!r.ok)throw Error(data.error||'No se pudieron consultar los registros.');if(request!==sequence)return;
   el('note').textContent=data.note+(data.coverage?` Cobertura sincronizada: ${data.coverage.from} a ${data.coverage.to}.`:'');
   el('status').textContent=data.total?`${data.total} registros encontrados.`:'No hay registros para esta ubicación y período en los datos guardados.';
   const head=document.createElement('thead'),tr=document.createElement('tr');tr.append(...data.columns.map(c=>text('th',c)));head.append(tr);const body=document.createElement('tbody');
   body.append(...data.rows.map(row=>{const tr=document.createElement('tr');tr.append(...data.columns.map(c=>text('td',typeof row[c]==='number'?new Intl.NumberFormat('es-CL',{maximumFractionDigits:5}).format(row[c]):row[c])));return tr;}));el('table').replaceChildren(head,body);el('page').textContent=`Página ${data.page} de ${data.pages}`;el('prev').disabled=page<=1;el('next').disabled=page>=data.pages;
  }catch(e){if(e.name!=='AbortError'&&request===sequence)el('status').textContent=e.message;}
 }
 window.openUploadRecords=(location,field,label)=>{target={location,field};page=1;el('title').textContent=label;dates();if(!dialog.open)dialog.showModal();query();};
 el('close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{sequence++;abort?.abort();});
 el('filter').onsubmit=e=>{e.preventDefault();page=1;query();};el('period').onchange=()=>{dates();if(el('period').value!=='custom'){page=1;query();}};
 for(const id of ['from','to'])el(id).oninput=()=>{el('period').value='custom';};
 el('prev').onclick=()=>{page--;query();};el('next').onclick=()=>{page++;query();};
})();
