(() => {
  'use strict';
  const $=s=>document.querySelector(s), state={user:null,csrf:'',tab:'items',page:0,rows:[],items:[],warehouses:[],suppliers:[],documents:[]};
  const labels={items:'Catálogo y recetas',imports:'Maestros importados',warehouses:'Bodegas',suppliers:'Proveedores',documents:'Documentos',balances:'Existencias y costos',lots:'Lotes',movements:'Kardex',payables:'Cuentas por pagar',issues:'Incidencias',baseline:'Revisión de migración'};
  const importKinds={item:'Artículo',recipe:'Receta',supplier:'Proveedor',warehouse:'Bodega','hierarchy-products':'Jerarquía productos','hierarchy-ingredients':'Jerarquía ingredientes','hierarchy-extras':'Jerarquía extras'};
  let activationToken=new URLSearchParams(location.hash.slice(1)).get('activate');
  if(activationToken)history.replaceState(null,'',location.pathname);
  const kindNames={opening:'Apertura',receipt:'Recepción de compra',purchase_order:'Orden de compra',consumption:'Consumo',marketing:'Marketing',employees:'Colaboradores',waste:'Merma',count:'Toma de inventario',production:'Producción',transfer_dispatch:'Despacho a otra bodega',transfer_receive:'Recepción de transferencia',return:'Devolución física',invoice:'Factura de proveedor',payment:'Pago realizado'};
  const locNames={'store-1':'La Concepción','store-2':'Portal Lyon','main-warehouse':'Bodega Principal'};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=v=>v==null?'Pendiente':new Intl.NumberFormat('es-CL',{maximumFractionDigits:4}).format(Number(v));
  const date=v=>v?new Date(v).toLocaleString('es-CL'):'—';
  const message=(text,error=false)=>{ $('#message').textContent=text;$('#message').dataset.error=String(error); };
  async function request(path,method='GET',body,key){
    const r=await fetch(`/api/v1/operations/${path}`,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf,...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json();if(!r.ok){if(r.status===401){$('#workspace').hidden=true;$('#login-panel').hidden=false;}throw Error(data.error || 'No se completó la solicitud.');}return data;
  }
  const run=fn=>async e=>{e?.preventDefault();try{await fn(e);}catch(err){message(err.message,true);}};
  const isAdmin=()=>['director','admin'].includes(state.user?.role);
  const options=(rows,value,name,selected)=>rows.map(r=>`<option value="${esc(value(r))}" ${value(r)===selected?'selected':''}>${esc(name(r))}</option>`).join('');
  const allowedLocations=()=>state.user.role==='director'?Object.keys(locNames):state.user.locations;
  const locationOptions=selected=>options(allowedLocations(),r=>r,r=>locNames[r],selected);
  const warehouseOptions=selected=>options(state.warehouses.filter(w=>w.kind!=='transit'),r=>r.id,r=>`${locNames[r.location]} · ${r.name}`,selected);
  const itemOptions=selected=>'<option value="">Seleccionar…</option>'+options([...state.items,...(state.tab==='imports'?state.rows.filter(r=>r.kind==='item'&&!state.items.some(i=>i.body.code===r.code)).map(r=>({body:{code:r.code,name:r.original.name}})):[])],r=>r.body.code,r=>`${r.body.code} · ${r.body.name}`,selected);
  const field=(name,label,value='',type='text',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const localNow=()=>{const d=new Date();return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  function table(headers,rows){return `<div class="scroll"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
  function td(values){return `<tr>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;}
  function columns(row){
    switch(state.tab){
      case 'imports':return [esc(importKinds[row.kind]||row.kind),esc(row.code),esc(row.original.name || ''),row.status==='accepted'?'Aprobado':'Pendiente de revisión',esc(row.issues.join(' · ')||'Revisar antes de habilitar'),`<button class="small" data-import="${row.id}">Ver detalle</button>`];
      case 'items': return [esc(row.body.code),esc(row.body.name),esc(row.body.baseUnit),esc({stock:'Producto almacenado',prepared:'Preparado',recipe:'Receta al vender',service:'Sin stock'}[row.body.policy]),esc(row.body.bar),String(row.version),isAdmin()?`<button class="small" data-edit="${row.id}">Editar</button>`:''];
      case 'warehouses':return [esc(row.id),esc(row.name),esc(locNames[row.location]),esc(row.kind)];
      case 'suppliers':return [esc(row.code),esc(row.body.name),esc(row.body.taxId),esc(row.body.email)];
      case 'documents':return [esc(row.id.slice(0,8)),esc(kindNames[row.kind] || row.kind),esc(locNames[row.location]),date(row.effective_at),esc(row.status),`<button class="small" data-detail="${row.id}">Ver</button> ${row.status==='draft'&&state.user.role!=='viewer'?`<button class="small" data-action="submit" data-id="${row.id}">Presentar</button>`:''} ${row.status==='submitted'&&['director','admin','manager'].includes(state.user.role)&&row.created_by!==state.user.id?`<button class="small" data-action="post" data-id="${row.id}">Aprobar y publicar</button>`:''}`];
      case 'balances':return [esc(row.warehouse_name),esc(row.code),esc(row.name),fmt(row.quantity),esc(row.unit),fmt(row.average_cost),fmt(row.last_purchase_cost),row.cost_pending?'Pendiente de conciliación':fmt(row.value),row.kind==='transit'?'En tránsito':''];
      case 'lots':return [esc(row.warehouse),esc(row.code),esc(row.lot||'Sin lote'),fmt(row.quantity),row.expires_on?esc(String(row.expires_on).slice(0,10)):'—',esc(row.status)];
      case 'movements':return [date(row.effective_at),esc(row.code),esc(row.warehouse),esc(row.lot),fmt(row.quantity),fmt(row.value),esc(row.metadata.costMethod),esc(row.document_id.slice(0,8))];
      case 'payables':return [esc(row.supplier),esc(row.number),esc(String(row.due_on).slice(0,10)),fmt(row.total),fmt(row.paid),fmt(Number(row.total)-Number(row.paid))];
      case 'issues':return [date(row.created_at),esc(row.code),esc(row.details.code),esc(row.details.warehouse),row.resolved_at?'Resuelta':'Pendiente'];
      case 'baseline':return [esc(row.code),esc(row.name),esc(row.baseUnit),esc(row.proposedPolicy),esc(row.issues.join(' · ')||'Requiere validación de negocio')];
    }
  }
  const headings={items:['Código','Nombre','Unidad','Política','Barra','Versión',''],warehouses:['Código','Bodega','Ubicación','Tipo'],suppliers:['Código','Nombre','Identificación','Correo'],documents:['Documento','Tipo','Ubicación','Fecha efectiva','Estado','Acciones'],balances:['Bodega','Código','Artículo','Existencia','Unidad','Costo promedio','Última compra','Valor inventario','Estado'],lots:['Bodega','Artículo','Lote','Cantidad','Vencimiento','Estado'],movements:['Fecha efectiva','Artículo','Bodega','Lote','Cantidad','Valor','Método','Documento'],payables:['Proveedor','Factura','Vencimiento','Total','Pagado','Saldo'],issues:['Fecha','Incidencia','Artículo','Bodega','Estado'],baseline:['Código','Nombre','Unidad','Política propuesta','Revisión pendiente']};
  function render(){
    const query=$('#search').value.toLowerCase(),rows=state.rows.filter(r=>JSON.stringify(r).toLowerCase().includes(query)),pages=Math.max(1,Math.ceil(rows.length/50));state.page=Math.min(state.page,pages-1);
    $('#title').textContent=labels[state.tab];$('#count').textContent=`${rows.length} registros`;
    $('#content').innerHTML=rows.length?table(headings[state.tab],rows.slice(state.page*50,state.page*50+50).map(r=>td(columns(r)))):'<p class="muted">No hay registros para esta selección.</p>';
    $('#pagination').innerHTML=`<button id="prev" ${state.page===0?'disabled':''}>Anterior</button><span>Página ${state.page+1} de ${pages}</span><button id="next" ${state.page===pages-1?'disabled':''}>Siguiente</button>`;
    $('#prev').onclick=()=>{state.page--;render();};$('#next').onclick=()=>{state.page++;render();};
    $('#new').hidden=!(isAdmin()&&['items','suppliers','warehouses'].includes(state.tab) || state.tab==='documents'&&state.user.role!=='viewer');
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editItem(state.items.find(r=>r.id===b.dataset.edit)));
    document.querySelectorAll('[data-import]').forEach(b=>b.onclick=()=>importDetail(state.rows.find(r=>r.id===b.dataset.import)));
    document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detail(state.documents.find(r=>r.id===b.dataset.detail)));
    document.querySelectorAll('[data-action]').forEach(b=>b.onclick=run(async()=>{b.disabled=true;try{await request(`documents/${b.dataset.id}/${b.dataset.action}`,'POST',{});await refresh();message('Documento actualizado.');}finally{b.disabled=false;}}));
  }
  async function refresh(){
    $('#editor').hidden=true;
    const resources=['items','warehouses','suppliers','documents'];
    await Promise.all(resources.map(async r=>{state[r]=(await request(`data/${r}`)).rows;}));
    if(state.tab==='imports'){const b=await request('imports');state.rows=b.rows;message(b.report?`Importados a PostgreSQL: ${b.rows.length} registros · Captura ${date(b.report.observedAt)}. ${b.rows.filter(r=>r.status==='accepted').length} publicados · ${b.rows.filter(r=>r.status==='pending').length} pendientes. Los publicados están disponibles en la operación de preparación; los reportes actuales conservan sus fuentes.`:'Todavía no hay maestros importados.');}
    else if(state.tab==='baseline'){const b=await request('baseline');state.rows=b.items;message(b.available?`Captura ${date(b.observedAt)} · ${b.issues.length} observaciones. La revisión no modifica maestros.`:b.issues[0].message);}
    else state.rows=resources.includes(state.tab)?state[state.tab].filter(r=>!$('#location').value || !r.location || r.location===$('#location').value):(await request(`data/${state.tab}?location=${encodeURIComponent($('#location').value)}`)).rows;
    render();
  }
  async function enter(session){
    state.user=session.user;state.csrf=session.csrf;$('#login-panel').hidden=true;$('#workspace').hidden=false;$('#identity').textContent=`${state.user.name} · ${state.user.role}`;
    $('#location').innerHTML='<option value="">Todas las autorizadas</option>'+locationOptions('');
    $('#tabs').innerHTML=Object.entries(labels).filter(([k])=>(!['baseline','imports'].includes(k)||isAdmin())&&(k!=='payables'||isAdmin()||state.user.role==='viewer')).map(([k,v])=>`<button data-tab="${k}" aria-selected="${k===state.tab}">${v}</button>`).join('');
    document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=run(async()=>{state.tab=b.dataset.tab;state.page=0;document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));message('');await refresh();}));
    await refresh();
  }
  function showEditor(title,html,save){$('#editor').hidden=false;$('#editor-title').textContent=title;$('#edit-form').innerHTML=html+'<div class="actions"><button class="primary" type="submit">Guardar borrador</button></div>';$('#edit-form').onsubmit=run(async e=>{const b=e.target.querySelector('button[type=submit]');b.disabled=true;try{await save(new FormData(e.target));await refresh();message('Guardado.');}finally{b.disabled=false;}});$('#editor').scrollIntoView({behavior:'smooth',block:'start'});}
  function lineEditor(target,initial=[],type='stock'){
    const root=document.getElementById(target);let counter=0;
    const headers=type==='recipe'?['Ingrediente','Cantidad','Unidad','']:type==='conversion'?['Presentación','Numerador','Denominador','']:['Artículo','Cantidad','Unidad','Costo por unidad comprada','Lote','Vencimiento',''];
    root.innerHTML=table(headers,[])+'<button type="button" class="small">Agregar línea</button>';
    const add=line=>{const tr=document.createElement('tr');tr.dataset.line=String(counter++);
      tr.innerHTML=(type==='conversion'?`<td><input data-field="unit" value="${esc(line.unit||'')}" required></td><td><input data-field="numerator" inputmode="decimal" value="${esc(line.numerator??'1')}" required></td><td><input data-field="denominator" inputmode="decimal" value="${esc(line.denominator??'1')}" required></td>`:`<td><select data-field="code" required>${itemOptions(line.code)}</select></td><td><input data-field="quantity" inputmode="decimal" value="${esc(line.quantity??'1')}" required></td><td><input data-field="unit" value="${esc(line.unit||'UN')}" required></td>${type==='recipe'?'':`<td><input data-field="unitCost" inputmode="decimal" value="${esc(line.unitCost??'')}" placeholder="Cuando corresponda"></td><td><input data-field="lot" value="${esc(line.lot||'')}"></td><td><input data-field="expiresOn" type="date" value="${esc(line.expiresOn||'')}"></td>`}`)+'<td><button type="button" class="small">Quitar</button></td>';
      tr.querySelector('button').onclick=()=>tr.remove();tr.querySelector('[data-field=code]')?.addEventListener('change',e=>{tr.querySelector('[data-field=unit]').value=state.items.find(r=>r.body.code===e.target.value)?.body.baseUnit||'UN';});root.querySelector('tbody').append(tr);
    };
    root.querySelector(':scope > button').onclick=()=>add({});initial.forEach(add);
    return ()=>[...root.querySelectorAll('tbody tr')].map(tr=>Object.fromEntries([...tr.querySelectorAll('[data-field]')].filter(i=>i.value!=='').map(i=>[i.dataset.field,i.value])));
  }
  function editItem(row,importRow=null){
    const b=row?.body||{policy:'stock',bar:'other',baseUnit:'UN'};let conversions,recipe;
    showEditor(row?'Nueva versión del artículo':'Crear artículo',`<div class="grid">${field('code','Código',b.code,'text',row?'readonly':'required')}${field('name','Nombre',b.name,'text','required')}${field('baseUnit','Unidad base',b.baseUnit,'text','required')}<label>Política<select name="policy">${options(['stock','prepared','recipe','service'],x=>x,x=>({stock:'Almacenado',prepared:'Preparado almacenado',recipe:'Receta al vender',service:'Sin stock'}[x]),b.policy)}</select></label><label>Barra<select name="bar">${options(['hot','cold','other'],x=>x,x=>({hot:'Caliente',cold:'Fría',other:'Otros'}[x]),b.bar)}</select></label><label>Lote obligatorio<input name="lotRequired" type="checkbox" ${b.lotRequired?'checked':''}></label><label>Vencimiento obligatorio<input name="expiryRequired" type="checkbox" ${b.expiryRequired?'checked':''}></label><label>Activo<input name="active" type="checkbox" ${b.active!==false?'checked':''}></label></div><h3>Conversiones de compra</h3><p class="muted">Ejemplo: CAJ · 36 / 1 unidades base.</p><div id="conversions" class="form-lines"></div><h3>Receta</h3>${field('yield','Cantidad producida en unidad base',b.recipe?.yield||'1')}<div id="recipe" class="form-lines"></div>`,async f=>{
      const lines=recipe();const item={...b,code:f.get('code'),name:f.get('name'),baseUnit:f.get('baseUnit').toUpperCase(),policy:f.get('policy'),bar:f.get('bar'),lotRequired:f.has('lotRequired'),expiryRequired:f.has('expiryRequired'),active:f.has('active'),externalCodes:Object.fromEntries(['store-1','store-2'].filter(l=>f.get(`external-${l}`)?.trim()).map(l=>[l,f.get(`external-${l}`).trim()])),effectiveAt:new Date().toISOString(),conversions:conversions(),recipe:lines.length?{yield:f.get('yield'),lines}:null};
      if(importRow)await saveReview(importRow,item,f);else await request('items','POST',{version:row?.version||0,item});
    });
    $('#edit-form button[type=submit]').textContent='Publicar versión';conversions=lineEditor('conversions',b.conversions||[],'conversion');recipe=lineEditor('recipe',b.recipe?.lines||[],'recipe');
    const mapping=document.createElement('div');mapping.className='grid';mapping.innerHTML=['store-1','store-2'].map(l=>field(`external-${l}`,`Código Toteat · ${locNames[l]}`,b.externalCodes?.[l]||'')).join('');$('#edit-form').insertBefore(mapping,$('#edit-form > .actions'));
    if(importRow){$('#editor-title').textContent=`Revisar artículo y receta · ${importRow.code}`;reviewControls(importRow);}
  }
  function documentEditor(kind='receipt'){
    let readLines;const special=kind==='invoice'||kind==='payment';
    showEditor('Nuevo documento',`<div class="grid"><label>Tipo<select name="kind" id="document-kind">${options(Object.keys(kindNames),x=>x,x=>kindNames[x],kind)}</select></label><label>Ubicación<select name="location">${locationOptions($('#location').value)}</select></label>${field('effectiveAt','Fecha y hora efectiva',localNow(),'datetime-local','required')}<label>Bodega<select name="warehouse">${warehouseOptions('')}</select></label>${field('reason','Motivo / observación','','text',kind==='waste'?'required':'')}</div><div id="document-extra" class="grid" style="margin-top:14px">${kind==='transfer_dispatch'?`<label>Bodega destino<select name="destinationWarehouse">${warehouseOptions('')}</select></label>`:''}${kind==='transfer_receive'?`<label>Despacho pendiente<select name="dispatchId">${options(state.documents.filter(d=>d.kind==='transfer_dispatch'&&d.status==='posted'),d=>d.id,d=>`${d.id.slice(0,8)} · ${d.body.destinationWarehouse}`,'')}</select></label>`:''}${kind==='return'?field('originalDocumentId','Documento original (identificador)','','text','required'):''}${kind==='invoice'?`<label>Proveedor<select name="supplierId" required>${options(state.suppliers,s=>s.id,s=>s.body.name,'')}</select></label>${field('number','Número de factura','','text','required')}${field('dueOn','Vencimiento','','date','required')}${field('total','Total a pagar','','text','required')}`:''}${kind==='payment'?`<label>Factura<select name="invoiceId" required>${options(state.documents.filter(d=>d.kind==='invoice'&&d.status==='posted'),d=>d.id,d=>`${d.body.number} · ${d.id.slice(0,8)}`,'')}</select></label>${field('total','Monto pagado','','text','required')}${field('reference','Comprobante del pago','','text','required')}`:''}</div>${special?'':'<h3>Detalle</h3><div id="lines" class="form-lines"></div>'}${kind==='production'?`<h3>Producción obtenida</h3><div class="grid"><label>Preparado<select name="outputCode">${itemOptions('')}</select></label>${field('outputQuantity','Cantidad obtenida','1')}${field('outputUnit','Unidad','UN')}${field('outputLot','Lote')}${field('outputExpiry','Vencimiento','','date')}</div><p class="muted">Este formulario registra un resultado; todos los insumos consumidos se valorizan en él.</p>`:''}`,async f=>{
      const body={warehouse:f.get('warehouse'),reason:f.get('reason'),lines:special?[kind==='invoice'?{total:f.get('total')}:{invoiceId:f.get('invoiceId'),total:f.get('total')}]:readLines()};
      for(const k of ['destinationWarehouse','dispatchId','originalDocumentId','supplierId','number','dueOn','reference'])if(f.get(k))body[k]=f.get(k);
      if(kind==='invoice')body.documentType='invoice';
      if(kind==='production')body.outputs=[{code:f.get('outputCode'),quantity:f.get('outputQuantity'),unit:f.get('outputUnit'),lot:f.get('outputLot'),expiresOn:f.get('outputExpiry')||undefined,costShare:'1'}];
      await request('documents','POST',{kind,location:f.get('location'),effectiveAt:new Date(f.get('effectiveAt')).toISOString(),body},state.documentKey);
    });
    state.documentKey=crypto.randomUUID();if(!special)readLines=lineEditor('lines',[{}]);$('#document-kind').onchange=e=>documentEditor(e.target.value);
  }
  function detail(d){
    $('#editor').hidden=false;$('#editor-title').textContent=`${kindNames[d.kind]||d.kind} · ${d.id}`;
    $('#edit-form').onsubmit=e=>e.preventDefault();$('#edit-form').innerHTML=`<p>Estado: ${esc(d.status)} · Ubicación: ${esc(locNames[d.location])} · Fecha: ${date(d.effective_at)}</p><p>${esc(d.body.reason || '')}</p>${table(['Artículo / factura','Cantidad / monto','Unidad','Costo','Lote'],(d.body.lines||[]).map(l=>td([esc(l.code||l.invoiceId||'Total'),esc(l.quantity??l.total),esc(l.unit),esc(l.unitCost),esc(l.lot)])))}`;
    if(isAdmin() && d.status==='posted' && !['invoice','payment','transfer_dispatch','transfer_receive','reversal'].includes(d.kind)){
      const row=document.createElement('div');row.className='actions';row.innerHTML='<label>Motivo del reverso<input id="reversal-reason" minlength="5"></label><button type="button" id="reverse-document">Revertir documento</button>';$('#edit-form').append(row);
      $('#reverse-document').onclick=run(async()=>{await request(`documents/${d.id}/reverse`,'POST',{reason:$('#reversal-reason').value});await refresh();message('Reverso publicado con referencia al documento original.');});
    }
    $('#editor').scrollIntoView({behavior:'smooth'});
  }
  headings.imports=['Tipo','Código','Nombre','Estado','Observaciones','Detalle'];
  function reviewControls(row){
    const div=document.createElement('div');div.innerHTML=`<p class="notice">Revisa las observaciones del origen: ${esc(row.issues.join(' · ')||'Sin errores técnicos detectados')}. Confirma política, barra, conversiones y receta. Publicar habilita este maestro únicamente en la operación de preparación.</p><label>Resultado de la revisión / motivo de correcciones<input name="reviewReason" required minlength="5" maxlength="2000"></label><label>Acción<select name="reviewAction"><option value="save">Guardar revisión pendiente</option><option value="publish">Aprobar y publicar en Brewit</option></select></label>`;
    $('#edit-form').insertBefore(div,$('#edit-form > .actions'));$('#edit-form button[type=submit]').textContent='Aplicar revisión';
  }
  async function saveReview(row,proposal,f){
    return request(`imports/${row.id}/review`,'POST',{revision:row.revision,proposal,reason:f.get('reviewReason'),publish:f.get('reviewAction')==='publish'});
  }
  function reviewEditor(row){
    if(row.kind==='recipe'){const item=state.rows.find(r=>r.kind==='item'&&r.code===row.code);if(item)return reviewEditor(item);return;}
    const o=row.original,b=row.proposal||{};
    if(row.kind==='item'){
      const candidate=b.code?b:{...b,code:row.code,bar:'',conversions:(o.conversions||[]).filter(c=>c.conversion_unit!==o.stockUnit || !(c.numerator>0&&c.denominator>0&&Number(c.numerator)===Number(c.denominator))).map(c=>({unit:c.conversion_unit,numerator:c.numerator,denominator:c.denominator})),recipe:o.recipe?.ingredients?.length?{yield:'',lines:o.recipe.ingredients.map(l=>({code:l.custom_id,quantity:l.quantity,unit:l.quantity_unit}))}:null};
      editItem({body:candidate,version:0},row);
      if(!b.code){const select=$('#edit-form [name=bar]');select.insertAdjacentHTML('afterbegin','<option value="" selected>Seleccionar barra…</option>');select.required=true;}
      if(o.recipe?.ingredients?.length){const note=document.createElement('p');note.className='notice';note.textContent='Receta: indica la producción neta en unidad base y las cantidades BRUTAS de ingredientes (incluyendo pérdidas). Las cantidades originales no se ajustan automáticamente por rendimiento ni porciones. Compara el detalle original antes de aprobar. Publica primero los ingredientes.';$('#recipe').before(note);if(!b.code)$('#edit-form [name=yield]').value='';$('#edit-form [name=yield]').required=true;}
      return;
    }
    let html='';
    if(row.kind==='warehouse')html=`${field('id','Código Brewit',b.id||`toteat-${row.code}`,'text','required')}${field('name','Nombre',b.name||o.name,'text','required')}<label>Ubicación<select name="location" required><option value="">Seleccionar…</option>${locationOptions(b.location||'')}</select></label><label>Tipo<select name="kind"><option value="operating" ${b.kind==='operating'?'selected':''}>Operativa</option><option value="waste" ${b.kind==='waste'?'selected':''}>Merma</option></select></label>`;
    else html=`${field('code','Código',row.code,'text','readonly')}${field('name','Nombre',b.name||o.name,'text','required')}`+(row.kind==='supplier'?`${field('taxId','Identificación fiscal',b.taxId||o.taxId||'')}${field('email','Correo',b.email||o.email||'','email')}`:'');
    showEditor(`Revisar ${importKinds[row.kind]} · ${row.code}`,`<div class="grid">${html}</div>`,f=>{const proposal={...o,...b,...Object.fromEntries(f)};delete proposal.reviewReason;delete proposal.reviewAction;return saveReview(row,proposal,f);});reviewControls(row);
  }
  function importDetail(row){
    $('#editor').hidden=false;$('#editor-title').textContent=`${importKinds[row.kind] || row.kind} · ${row.code}`;
    const original=row.original,recipe=row.kind==='recipe'?original:original.recipe;
    let html=`<p>${esc(original.name || '')}</p><p class="notice">Registro importado para revisión. ${esc(row.issues.join(' · '))}</p>`;
    if(row.proposal)html+=table(['Dato propuesto','Valor'],Object.entries(row.proposal).map(([k,v])=>td([esc(k),esc(v)])));
    if(original.conversions?.length)html+='<h3>Conversiones de origen</h3>'+table(['Unidad','Unidad base','Numerador','Denominador'],original.conversions.map(c=>td([esc(c.conversion_unit),esc(c.base_unit),esc(c.numerator),esc(c.denominator)])));
    if(recipe?.ingredients?.length)html+=`<h3>Receta original</h3><p>Producción: ${esc(recipe.quantity)} ${esc(recipe.quantity_unit)} · Porciones por unidad: ${esc(recipe.portions_per_unit)}</p>`+table(['Ingrediente','Nombre','Cantidad original','Unidad','Rendimiento (%)'],recipe.ingredients.map(l=>td([esc(l.custom_id),esc(l.name),esc(l.quantity),esc(l.quantity_unit),esc(l.yield_rate)])));
    html+=`<details><summary>Registro original completo</summary><pre>${esc(JSON.stringify(original,null,2))}</pre></details>`;
    if(row.status==='pending')html+='<button type="button" id="review-import">Revisar y corregir</button>';
    else html+=`<h3>Propuesta publicada</h3><pre>${esc(JSON.stringify(row.proposal,null,2))}</pre><p>Publicado: ${date(row.accepted_at)}</p>`;
    $('#edit-form').innerHTML=html;$('#review-import')?.addEventListener('click',()=>reviewEditor(row));$('#edit-form').onsubmit=e=>e.preventDefault();$('#editor').scrollIntoView({behavior:'smooth'});
  }
  $('#new').onclick=()=>{
    if(state.tab==='items')return editItem();if(state.tab==='documents')return documentEditor();
    if(state.tab==='warehouses')showEditor('Crear bodega',`<div class="grid">${field('id','Código','','text','required')}${field('name','Nombre','','text','required')}<label>Ubicación<select name="location">${locationOptions('')}</select></label><label>Tipo<select name="kind"><option value="operating">Operativa</option><option value="waste">Merma</option></select></label></div>`,f=>request('warehouses','POST',Object.fromEntries(f)));
    if(state.tab==='suppliers')showEditor('Crear proveedor',`<div class="grid">${field('code','Código','','text','required')}${field('name','Nombre','','text','required')}${field('taxId','Identificación fiscal')}${field('email','Correo','','email')}</div>`,f=>request('suppliers','POST',Object.fromEntries(f)));
  };
  $('#login').onsubmit=run(async e=>{const f=new FormData(e.target);const session=await request('login','POST',Object.fromEntries(f));e.target.reset();message('');await enter(session);});
  $('#activation-form').onsubmit=run(async e=>{
    const f=new FormData(e.target);if(f.get('password')!==f.get('confirmation'))throw Error('Las contraseñas no coinciden.');
    await request('enrollment/finish','POST',{token:activationToken,password:f.get('password'),code:f.get('code')});
    activationToken=null;e.target.reset();$('#activation-secret').textContent='';$('#activation-panel').hidden=true;$('#login-panel').hidden=false;message('Cuenta activada. Inicia sesión con tu correo, contraseña y el siguiente código del autenticador.');
  });
  async function beginActivation(){
    $('#workspace').hidden=true;$('#login-panel').hidden=true;$('#activation-panel').hidden=true;$('#activation-secret').textContent='';
    const activation=await request('enrollment/start','POST',{token:activationToken});
    $('#activation-panel').hidden=false;$('#activation-identity').textContent=`${activation.name} · ${activation.email}`;$('#activation-secret').textContent=activation.secret;message('');
  }
  window.addEventListener('hashchange',run(async()=>{const token=new URLSearchParams(location.hash.slice(1)).get('activate');if(token){activationToken=token;history.replaceState(null,'',location.pathname);await beginActivation();}}));
  $('#logout').onclick=run(async()=>{await request('logout','POST',{});state.user=null;state.csrf='';$('#workspace').hidden=true;$('#login-panel').hidden=false;});
  $('#cancel').onclick=()=>$('#editor').hidden=true;$('#refresh').onclick=run(refresh);$('#location').onchange=run(async()=>{state.page=0;await refresh();});$('#search').oninput=()=>{state.page=0;render();};$('#print').onclick=()=>{
    const rows=state.rows.filter(r=>JSON.stringify(r).toLowerCase().includes($('#search').value.toLowerCase())),popup=window.open('','_blank');
    if(!popup){message('Permite abrir la ventana de impresión para generar el PDF.',true);return;}
    popup.opener=null;popup.document.write(`<!doctype html><html lang="es"><head><title>Brewit · ${esc(labels[state.tab])}</title><style>body{font:12px system-ui;color:#111}table{border-collapse:collapse;width:100%}td,th{padding:7px;border:1px solid #bbb;text-align:left}button{display:none}thead{display:table-header-group}@page{size:landscape}</style></head><body><h1>${esc(labels[state.tab])}</h1><p>Ensayo operativo · ${rows.length} registros · ${esc(date(new Date()))}</p>${table(headings[state.tab],rows.map(r=>td(columns(r))))}</body></html>`);popup.document.close();popup.focus();popup.print();
  };
  $('#export').onclick=()=>{
    const rows=state.rows.filter(r=>JSON.stringify(r).toLowerCase().includes($('#search').value.toLowerCase()));
    const text=html=>{const el=document.createElement('span');el.innerHTML=html;return el.textContent;};
    const safe=v=>{const s=String(v??'');return '"'+(/^[=+@-]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';};
    const csv='\ufeff'+[headings[state.tab],...rows.map(r=>columns(r).map(text))].map(r=>r.map(safe).join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`Brewit-${state.tab}.csv`;a.click();URL.revokeObjectURL(url);
  };
  run(async()=>{const status=await request('status');$('#connection-status').textContent=status.configured?'PostgreSQL conectado':'PostgreSQL pendiente de configurar';if(!status.configured){$('#setup').hidden=false;return;}if(activationToken){await beginActivation();return;}try{await enter(await request('session'));}catch(e){$('#login-panel').hidden=false;if(!e.message.includes('Inicia sesión'))message(e.message,true);}})();
})();
