const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const {createApp}=require('../server');
const {extract}=require('../historical-adapters');
const {chromium}=require('playwright-core');
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function service(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-history-ingest-'));
  const app=createApp({uploadsRoot:root,enableLegacyTools:true,enableToteatSync:false}),history=app.locals.historicalControl;
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await app.locals.mercadoPagoSync.close();await history.idle();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  return {root,app,history,base:`http://127.0.0.1:${server.address().port}`};
}
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('manual MercadoPago backs up the unsplit original, reports corrections before dedup and survives operational removal',async t=>{
  const {base,history}=await service(t);
  const header='STORE_ID;SOURCE_ID;TRANSACTION_TYPE;TRANSACTION_DATE;TRANSACTION_AMOUNT\n';
  async function upload(amount,complete){
    const content=header+`82010740;p1;SETTLEMENT;2026-10-05T10:00:00-03:00;${amount}\n81555097;p2;SETTLEMENT;2026-10-05T11:00:00-03:00;200\n`;
    const form=new FormData();form.append('mercadopago',new Blob([content]),'shared-original.csv');
    const inspection=await fetch(base+'/api/uploads/transactions/inspect',{method:'POST',body:form});assert.equal(inspection.status,200);
    const manifest=await inspection.json();assert.ok(manifest.historicalRunId);
    const response=await fetch(base+'/api/uploads/transactions/confirm',post({token:manifest.token,dateFrom:'2026-10-01',dateTo:'2026-10-10',confirmed:true,historicalComplete:complete}));assert.equal(response.status,200);
    await history.idle();const run=history.load(manifest.historicalRunId);assert.equal(run.artifacts.length,1);assert.equal(run.artifacts[0].datasets.length,2);
    const download=await fetch(`${base}/api/historical-control/runs/${run.id}/files/${run.artifacts[0].id}/download`);assert.equal(await download.text(),content);
    return run;
  }
  await upload(100,true);const changed=await upload(150,true);
  assert.equal(history.report(changed.id).sources.find(s=>s.location==='store-1').summary.modified,1);
  assert.equal(history.report(changed.id).sources.find(s=>s.location==='store-2').summary.modified,0);
  const snapshot=history.storage(require('../historical-control').localDay(new Date()));
  await fetch(base+'/api/transactions/store-1/mercadopago/remove',post({action:'all',confirmation:'ELIMINAR'}));
  assert.equal(history.load(changed.id).artifacts.length,1);assert.equal(history.storage(snapshot.date).currentBytes,snapshot.currentBytes);
});
test('original backup failure blocks manual confirmation and leaves previous operational data intact',async t=>{
  const {base,history,root}=await service(t);const originalCapture=history.capture;
  history.capture=()=>{throw Object.assign(Error('Respaldo no disponible'),{code:'HISTORICAL_BACKUP_FAILED'});};
  const form=new FormData();form.append('mercadopago',new Blob(['STORE_ID;SOURCE_ID;TRANSACTION_TYPE;TRANSACTION_DATE\n82010740;a;SETTLEMENT;2026-10-05T10:00:00-03:00']),'x.csv');
  const response=await fetch(base+'/api/uploads/transactions/inspect',{method:'POST',body:form});assert.equal(response.status,507);
  assert.equal(fs.existsSync(path.join(root,'transactions','store-1','index.json')),false);history.capture=originalCapture;
});
test('real source formats support daily Kardex keys, purchase documents and every shared master family',()=>{
  const root=path.join(__dirname,'..','docs');
  const samples=[
    ['transaccional-data-files/kardex_report (BLC 040826 090826).xlsx','kardex',false],
    ['transaccional-data-files/listado_compras_detalle (040826 090826).xls','purchases',false],
    ['transaccional-data-files/ventas_totales.csv','sales',false],
    ['master-data-files/AdvMaestroProdsTotal_1774666275011576_1_2026-08-09T12_52_32.xlsx','master-catalog',true],
    ['master-data-files/Brewit-proveedores.xlsx','master-suppliers',true],
    ['master-data-files/DETALLE_RECETAS.txt','master-recipes',true],
    ['master-data-files/toteat_product_hierarchy-1774666275011576-1-AB.2026-08-09T12_52_06.244Z.csv.txt','product-hierarchy',true],
    ['master-data-files/toteat_ingr_hierarchy-1774666275011576-1-IC.2026-08-09T12_53_59.958Z.csv.txt','ingredient-hierarchy',true],
    ['master-data-files/toteat_extras_hierarchy-1774666275011576-1-BA.2026-08-09T12_53_01.498Z.csv.txt','extras-hierarchy',true]
  ];
  for(const [file,dataset,master]of samples){const result=extract(fs.readFileSync(path.join(root,file)),{format:'file',name:file},{dataset,master});assert.ok(result.records.length>0,dataset);assert.equal(result.ambiguous.length,0,dataset);}
  for(const dataset of ['counts','transfers','transformations','receipts','local-transfers','waste','marketing','employees','calibrations']){
    const result=extract(Buffer.from(JSON.stringify([{id:'d1',registration_date:'2026-10-05',products:[{id:'l1',q:2}]}])),{format:'json'},{dataset});assert.equal(result.records[0].id,'d1');assert.equal(result.records[0].date,'2026-10-05');
  }
  const hierarchy=extract(Buffer.from(JSON.stringify({data:[{listado:[['AB.1',1,'Café','AB.']]}]})),{format:'json'},{dataset:'product-hierarchy',master:true,selector:'data',hierarchy:true});assert.equal(hierarchy.records[0].id,'AB.1');
});
test('historical UI opens below data sync, separates baseline from no changes and exposes details, backups and storage',{skip:!fs.existsSync(chrome)},async t=>{
  const {base,history}=await service(t);
  for(const amount of [100,100,150])await history.track({origin:'manual',location:'store-1'},async run=>history.capture(run,{body:[{id:'purchase-1',date:'2026-10-05',amount}],datasets:[{dataset:'purchases',range:{from:'2026-10-01',to:'2026-10-10'},complete:true}]}));
  await history.idle();const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.goto(base);await page.getByRole('link',{name:'Control histórico',exact:true}).click();
  await page.getByRole('tab',{name:'Cambios del día',exact:true}).click();
  await page.locator('#historical-content .historical-run').first().waitFor();
  assert.deepEqual(await page.locator('.nav-group:last-of-type .nav-link').evaluateAll(links=>links.map(l=>l.dataset.view)),['findings','transaction-audit','uploads','historical-control','config']);
  assert.ok(await page.getByText('Sin cambios históricos detectados',{exact:true}).count());assert.ok(await page.getByText('Línea base',{exact:true}).count());
  await page.getByRole('button',{name:'Ver detalle de comparación'}).first().click();await page.getByText('Valor anterior',{exact:true}).waitFor();
  assert.match(await page.locator('#historical-detail-content').innerText(),/purchase-1/);assert.match(await page.locator('#historical-detail-content').innerText(),/100/);assert.match(await page.locator('#historical-detail-content').innerText(),/150/);
  await page.getByRole('button',{name:'Cerrar',exact:true}).click();await page.getByRole('tab',{name:'Respaldos',exact:true}).click();await page.getByRole('link',{name:'Descargar',exact:true}).first().waitFor();
  await page.getByRole('tab',{name:'Almacenamiento',exact:true}).click();await page.locator('#historical-content').getByText('Promedio diario',{exact:true}).waitFor();assert.equal(await page.locator('#historical-content .historical-kpi').count(),6);
  await page.screenshot({path:'/private/tmp/brewit-historical-control.png',fullPage:true});
});
test('historical UI explains missing assets and retries initialization after an unavailable endpoint',{skip:!fs.existsSync(chrome)},async t=>{
  const {base}=await service(t);
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('**/historical-control-view.js',route=>route.abort());
  await page.goto(base);await page.getByRole('link',{name:'Control histórico',exact:true}).click();
  assert.match(await page.locator('#historical-status').innerText(),/Reinicia el servidor/);
  await page.unroute('**/historical-control-view.js');
  await page.route('**/api/historical-control/options',route=>route.fulfill({status:404,contentType:'text/html',body:'Cannot GET /api/historical-control/options'}));
  await page.reload();await page.getByRole('link',{name:'Control histórico',exact:true}).click();
  await page.getByText('El servidor no tiene disponible esta consulta de Control histórico.',{exact:false}).waitFor();
  await page.unroute('**/api/historical-control/options');
  await page.getByRole('button',{name:'Actualizar vista',exact:true}).click();
  await page.getByText('No hay cargas ni comparaciones para este período y filtros.',{exact:true}).waitFor();
  assert.equal(await page.locator('#historical-status').innerText(),'');
  assert.ok(await page.locator('#historical-dataset option').count()>1);
});
test('audit alerts are the default view, filter findings, show before and after values and export the selected report',{skip:!fs.existsSync(chrome)},async t=>{
  const {base,history}=await service(t);
  const old=history.begin({antecedent:true,origin:'legacy',location:'store-1'});history.capture(old,{body:[{id:'old'}],datasets:[{dataset:'purchases'}]});history.finish(old);
  for(const records of [
    [{id:'a',date:'2020-01-02',amount:100},{id:'b',date:'2020-01-02',amount:200}],
    [{id:'a',date:'2020-01-02',amount:150},{id:'c',date:'2020-01-02',amount:300}]
  ])await history.track({origin:'manual',location:'store-1'},run=>history.capture(run,{body:records,datasets:[{dataset:'purchases',range:{from:'2020-01-01',to:'2020-01-03'},complete:true}]}));
  await history.idle();const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.goto(base);await page.getByRole('link',{name:'Control histórico',exact:true}).click();
  await page.getByRole('link',{name:'Descargar reporte CSV',exact:true}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Alertas',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.historical-alert-badge').count(),3);assert.equal(await page.locator('.historical-run').count(),0);
  assert.match(await page.locator('#historical-content').innerText(),/1 antecedentes incorporados/);
  const filtered=page.waitForResponse(r=>r.url().includes('/alerts?')&&r.url().includes('type=modified'));
  await page.locator('#historical-alert-type').selectOption('modified');await filtered;await page.waitForFunction(()=>!document.getElementById('historical-status').textContent);
  assert.equal(await page.locator('.historical-alert-badge').count(),1);
  await page.getByRole('button',{name:'Ver detalle de alerta',exact:true}).click();
  const content=await page.locator('#historical-detail-content').innerText();assert.match(content,/operación del 2020-01-02/);assert.match(content,/Importe/);assert.match(content,/100/);assert.match(content,/150/);
  const exported=await fetch(base+await page.getByRole('link',{name:'Descargar reporte CSV',exact:true}).getAttribute('href'));const csv=await exported.text();assert.match(csv,/Registro modificado/);assert.doesNotMatch(csv,/Registro eliminado/);assert.match(csv,/150/);
  await page.getByRole('button',{name:'Consultar carga y respaldos',exact:true}).click();await page.getByRole('link',{name:'Descargar respuesta.json',exact:true}).waitFor();
  await page.screenshot({path:'/private/tmp/brewit-historical-alerts.png',fullPage:true});
  await page.getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.getByRole('tab',{name:'Cambios del día',exact:true}).click();assert.equal(await page.locator('#historical-date-to').isVisible(),false);
});

test('historical details show named article changes, readable values and search, and distinguish reordered equivalents',{skip:!fs.existsSync(chrome)},async t=>{
  const {base,history}=await service(t);
  const salsa=(quantity,cost)=>({pl:'SSR008',np:'Salsa chocolate',cant:quantity,costo:cost,unit_select:'KG'});
  const chips={pl:'CCB002',np:'Chips Chocolate',cant:1,unit_select:'KG',conv:[{cden:1,cnum:16,umed:'BOLSA',umedb:'KG'},{cden:1,cnum:1,umed:'KG',umedb:'KG'}]};
  for(const current of [false,true])await history.track({origin:'manual',location:'store-1'},run=>history.capture(run,{body:[
    {id:'T-readable',date:'2020-01-02',det:{listas:[[],[],[salsa(current?4:2,current?8500:8000)],[salsa(current?4:2,current?8500:8000)]]}},
    {id:'T-order',date:'2020-01-02',det:{listas:[[],[],[{...chips,conv:current?[...chips.conv].reverse():chips.conv}]]}}
  ],datasets:[{dataset:'local-transfers',range:{from:'2020-01-01',to:'2020-01-03'},complete:true}]}));
  await history.idle();
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('link',{name:'Control histórico',exact:true}).click();
  await page.locator('.historical-alerts-table tbody tr').filter({hasText:'T-readable'}).getByRole('button',{name:'Ver detalle de alerta'}).click();
  const modal=page.locator('#historical-detail'),content=page.locator('#historical-detail-content');
  assert.match(await content.innerText(),/Salsa chocolate/);assert.match(await content.innerText(),/SSR008/);
  assert.match(await content.innerText(),/2 kg/);assert.match(await content.innerText(),/4 kg/);assert.match(await content.innerText(),/\+2 kg/);
  assert.match(await content.innerText(),/Costo unitario/);assert.match(await content.innerText(),/\$8.000/);assert.match(await content.innerText(),/\$8.500/);
  assert.doesNotMatch(await content.innerText(),/det\.listas|unit_select|"cant"|Versiones:/);
  assert.equal(await content.locator('pre').count(),0);
  await content.getByRole('searchbox').fill('costo');
  assert.equal(await content.locator('.historical-readable-table tbody tr').count(),2);
  await content.getByRole('searchbox').fill('inexistente');assert.match(await content.innerText(),/No hay cambios que coincidan/);
  await content.getByRole('searchbox').fill('SSR008');
  await page.screenshot({path:'/private/tmp/brewit-historical-readable-changes.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await modal.evaluate(dialog=>dialog.getBoundingClientRect().width<=innerWidth));
  assert.ok(await content.locator('.historical-readable-table').evaluate(wrap=>wrap.scrollWidth>wrap.clientWidth));
  await page.getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.locator('.historical-alerts-table tbody tr').filter({hasText:'T-order'}).getByRole('button',{name:'Ver detalle de alerta'}).click();
  assert.match(await content.innerText(),/Solo cambió el orden/);assert.match(await content.innerText(),/Chips Chocolate/);
  assert.match(await content.innerText(),/CCB002/);assert.equal(await content.locator('.historical-readable-table').count(),0);
  assert.deepEqual(errors,[]);
});
