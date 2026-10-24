const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-data-ui-'));
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false, manualExternalSources: true });
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  const browser = await chromium.launch({ executablePath:chrome, headless:true });
  const page = await browser.newPage({ viewport:{width:1440,height:1000} }); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await browser.close(); await app.locals.mercadoPagoSync.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const overview=await page.request.get(base+'/api/uploads/overview').then(r=>r.json());
  overview.masterStatus={...overview.masterStatus,connection:'Credencial vencida',credentialExpiresAt:'2026-01-01T00:00:00Z',observedAt:'2026-01-01T00:00:00Z'};
  await page.route('**/api/uploads/overview',route=>route.fulfill({json:overview}));
  return {page,base,overview};
}
async function open(page,base){await page.goto(base);await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();await page.locator('.upload-source-row').first().waitFor();}
const source=(page,id,key)=>page.locator(`.upload-source-row[data-location="${id}"][data-source="${key}"]`);

test('selección de fuentes conserva foco y alcance al consultar estados y envía un solo proceso', {skip:!fs.existsSync(chrome)}, async t=>{
 const {page,base,overview}=await setup(t);const requests=[];
 await page.route('**/api/uploads/refresh',route=>{
  requests.push(route.request().postDataJSON());
  overview.job={id:'selected-job',running:true,waitingForAuthentication:true,steps:[{label:'Maestros',state:'waiting-auth',code:'TOTEAT_AUTH_REQUIRED',message:'Inicia sesión en TotEat.'}],summary:{'waiting-auth':1},startedAt:'2026-10-24T12:00:00Z'};
  return route.fulfill({json:overview.job,status:202});
 });
 await open(page,base);
 assert.match(await page.locator('#upload-attention').innerText(),/Maestros compartidos.*revisa la conexión/s);
 await page.locator('#upload-location-filter').selectOption('store-2');
 assert.equal(await page.locator('.upload-source-row[data-location="store-1"]').count(),0);
 const checkbox=source(page,'store-2','sales').getByRole('checkbox');await checkbox.check();await checkbox.focus();
 overview.rows.find(r=>r.id==='store-2').cells.find(c=>c.key==='sales').lastCheck={finishedAt:'2026-10-24T14:00:00Z',windows:[],durationMs:20};
 await page.evaluate(()=>loadUploadOverview());
 assert.equal(await checkbox.isChecked(),true);assert.equal(await checkbox.evaluate(el=>el===document.activeElement),true);
 const configure=source(page,'store-2','sales').getByRole('button',{name:'Configurar conexión'});await configure.focus();
 overview.rows.find(r=>r.id==='store-2').cells.find(c=>c.key==='sales').lastCheck.durationMs=40;
 await page.evaluate(()=>loadUploadOverview());assert.equal(await configure.evaluate(el=>el===document.activeElement),true);
 await page.locator('#upload-select-masters').check();
 assert.match(await page.locator('#upload-selection-summary').innerText(),/Tienda 2.*Ventas y pagos.*Maestros compartidos/s);
 await page.getByRole('button',{name:'Actualizar selección',exact:true}).click();
 await page.locator('#upload-refresh-progress').filter({hasText:'En pausa'}).waitFor();
 assert.deepEqual(requests,[{targets:[{location:'store-2',key:'sales'},{location:'shared',key:'masters'}]}]);
 assert.equal(await page.getByRole('button',{name:'Actualizar selección',exact:true}).isDisabled(),true);
 assert.equal(await page.locator('#resume-upload-api').isVisible(),true);
 await page.getByRole('tab',{name:'Revisar períodos anteriores'}).click();
 await page.locator('#source-history-from').fill('2026-08-15');
 await page.evaluate(()=>loadUploadOverview());
 assert.equal(await page.locator('#source-history-from').inputValue(),'2026-08-15');
 assert.equal(await page.locator('#upload-refresh-progress').isVisible(),true);
 await page.locator('#source-history-location').selectOption('store-1');
 await page.locator('#upload-open-source-detail').click();
 assert.equal(await page.locator('#source-sync-location').inputValue(),'store-1');
});

test('servidor anterior permite actualización individual sin convertir la selección en una actualización global', {skip:!fs.existsSync(chrome)}, async t=>{
 const {page,base,overview}=await setup(t);delete overview.capabilities;const writes=[];
 await page.route('**/api/uploads/refresh*',route=>{writes.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});return route.fulfill({json:{}});});
 await open(page,base);
 assert.match(await page.locator('#upload-attention').innerText(),/Reinicia Brewit/);
 assert.equal(await page.getByRole('button',{name:'Actualizar selección',exact:true}).isDisabled(),true);
 await source(page,'store-1','sales').getByRole('button',{name:'Actualizar ventas y pagos'}).click();
 await page.waitForResponse(r=>r.url().endsWith('/api/uploads/overview'));
 assert.deepEqual(writes,[{path:'/api/uploads/refresh-source',body:{location:'store-1',key:'sales'}}]);
});

test('tareas separadas, enlaces con ubicación y diseño adaptable al 130 %', {skip:!fs.existsSync(chrome)}, async t=>{
 const {page,base}=await setup(t);await open(page,base);
 assert.equal(await page.locator('#inventory-sync-panel').isVisible(),false);
 await page.getByRole('tab',{name:'Estado y actualización'}).focus();await page.keyboard.press('ArrowRight');
 assert.equal(await page.getByRole('tab',{name:'Cargar archivos',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#upload-mercadopago-shared').isVisible(),true);
 assert.equal(await page.locator('#sync-mercadopago-web').isVisible(),false);
 await page.locator('#upload-location-filter').selectOption('store-2');
 assert.equal(await page.locator('#upload-manual-actions tbody tr:visible').count(),1);
 await page.keyboard.press('Escape');
 await page.getByRole('tab',{name:'Estado y actualización'}).click();
 await source(page,'store-2','sales').getByRole('button',{name:'Configurar conexión'}).click();
 assert.equal(await page.locator('#toteat-api-location').inputValue(),'store-2');
 await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();
 await source(page,'store-2','inventory').getByRole('button',{name:'Abrir Inventario'}).click();
 assert.equal(await page.locator('#inventory-sync-panel').isVisible(),true);assert.equal(await page.locator('#location-select').inputValue(),'store-2');
 await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();
 await page.evaluate(()=>document.documentElement.style.setProperty('--font-scale','1.3'));
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const [tab,panel] of [['Estado y actualización','status'],['Cargar archivos','files'],['Revisar períodos anteriores','history']]){
   await page.getByRole('tab',{name:tab,exact:true}).click();
   await page.locator(`#upload-panel-${panel}`).screenshot({path:`/tmp/brewit-data-${panel}-${width}.png`,animations:'disabled'});
   if(panel==='status') await page.locator('.upload-source-row').first().screenshot({path:`/tmp/brewit-data-row-${width}.png`,animations:'disabled'});
   const overflow=await page.locator(`#upload-panel-${panel}`).evaluate(el=>[...el.querySelectorAll('button,input,select')].filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility() && r.width && (r.right>innerWidth+1||r.left<0);}).map(e=>e.outerHTML));
   assert.deepEqual(overflow,[],`${width}px ${panel}`);
  }
 }
});
