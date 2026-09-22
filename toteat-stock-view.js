(() => {
  const el=id=>document.getElementById(id),location=el('location-select');
  if(!location||!el('stock-sync'))return;
  const base='/api/integrations/toteat/stock';let data=null,last=null,busy=false;
  el('stock-to').value=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date());
  async function request(route,body){const r=await fetch(base+route+(body?'':`?location=${encodeURIComponent(location.value)}`),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo consultar inventario.');return d;}
  const cell=value=>{const td=document.createElement('td');td.textContent=value??'—';return td;};
  const num=v=>v==null?'Sin saldo inicial':new Intl.NumberFormat('es-CL',{maximumFractionDigits:5}).format(v);
  function render(){if(!data)return;const names=new Map(data.warehouses.map(w=>[w.id,w.name])),search=el('stock-search').value.toLowerCase(),wh=el('stock-warehouse').value;
    const rows=data.daily.filter(r=>(!wh||r.warehouse===wh)&&`${r.code} ${r.name}`.toLowerCase().includes(search));
    el('stock-rows').replaceChildren(...rows.slice(0,300).map(r=>{const tr=document.createElement('tr');[r.date,names.get(r.warehouse)||r.warehouse,r.code,r.name,r.unit,...[r.opening,r.purchase,r.transfer_warehouse_in+r.transfer_local_in,r.transfer_warehouse_out+r.transfer_local_out,r.transformed_in,r.transformed_out,r.use,r.closing].map(num),r.adjustment==null?'—':num(r.adjustment)].forEach(v=>tr.append(cell(v)));return tr;}));
    el('stock-row-count').textContent=`${rows.length} filas; se muestran hasta 300. El Excel incluye el detalle completo.`;
  }
  async function show(){const selected=location.value;try{const result=await request('/current');if(selected!==location.value)return;data=result;el('stock-warehouse').replaceChildren(new Option('Todas',''),...data.warehouses.map(w=>new Option(w.name,w.id)));
    el('stock-summary').textContent=`Borrador · ${data.range.from} a ${data.range.to}. ${data.comparison.comparedCells} celdas comparadas con archivos Toteat; ${data.comparison.differences.length} diferencias y ${data.comparison.missing.length} celdas sin comparación. ${data.issues.length} incidencias. Los saldos con consumos pendientes no son definitivos. La comparación completa está en el Excel.`;
    const grouped=new Map();for(const issue of data.issues){const key=issue.message;grouped.set(key,(grouped.get(key)||0)+1);}
    el('stock-issues').replaceChildren(...[...data.assumptions,...[...grouped].slice(0,12).map(([text,count])=>`${text}${count>1?` (${count} casos)`:''}`),'El Excel incluye cada documento y línea pendiente.'].map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));el('stock-result').open=true;render();
  }catch(e){el('stock-status').textContent=e.message;}}
  async function poll(){if(busy)return;busy=true;const selected=location.value;try{const s=await request('/status');if(selected!==location.value)return;
    el('stock-sync').disabled=s.running;
    el('stock-status').textContent=s.running?'Actualizando las tres fuentes…':s.error||(!s.updatedAt?'Fuentes aún no sincronizadas.':`Última lectura: ${new Date(s.updatedAt).toLocaleString('es-CL')} · período ${s.range.from} a ${s.range.to}.`);
    el('stock-sources').replaceChildren(...[['counts','Tomas de inventario'],['transformations','Transformaciones'],['transfers','Transferencias entre bodegas']].map(([k,label])=>{const tr=document.createElement('tr'),v=s.counts?.[k];[label,v?.documents??'Sin sincronizar',v?.approved??'—',v?.lines??'—'].forEach(x=>tr.append(cell(x)));return tr;}));
    el('stock-export').href=base+'/export?location='+encodeURIComponent(location.value);
    if(last&&s.updatedAt!==last&&s.updatedAt)await show();last=s.updatedAt;
  }catch(e){el('stock-status').textContent=e.message;}finally{busy=false;}}
  el('stock-sync').addEventListener('click',async()=>{el('stock-sync').disabled=true;try{await request('/sync',{location:location.value,from:el('stock-from').value,to:el('stock-to').value});await poll();}catch(e){el('stock-status').textContent=e.message;el('stock-sync').disabled=false;}});
  el('stock-view').addEventListener('click',show);el('stock-search').addEventListener('input',render);el('stock-warehouse').addEventListener('change',render);
  location.addEventListener('change',()=>{data=null;last=null;el('stock-rows').replaceChildren();el('stock-result').open=false;el('stock-sync').disabled=false;poll();});
  setInterval(poll,10000);poll();
})();
