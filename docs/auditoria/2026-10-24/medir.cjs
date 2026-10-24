// Local-only instrumentation. Run after preparar.cjs; never start against real uploads.
const fs=require('node:fs'),path=require('node:path');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {AsyncLocalStorage}=require('node:async_hooks');
const repo=path.resolve(__dirname,'../../..');
const work=fs.readFileSync('/private/tmp/brewit-audit-current.txt','utf8').trim();
if(!work.startsWith('/private/tmp/brewit-audit-20261024-'))throw Error('Private audit root required');
const root=path.join(work,'uploads');
for(const key of ['BREWIT_DATABASE_URL','BREWIT_TEST_DATABASE_URL','BREWIT_AUTH_KEY','BREWIT_REQUIRE_AUTH'])delete process.env[key];
process.env.BREWIT_DISABLE_SYNC='1';
const realFetch=global.fetch;
global.fetch=(input,...rest)=>{
  const url=new URL(typeof input==='string'?input:input.url||String(input));
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Audit blocks external fetch');
  return realFetch(input,...rest);
};
const context=new AsyncLocalStorage(),requests=[];
function wrap(object,key,label) {
  const original=object[key]; object[key]=function(...args){
    const current=context.getStore(),start=performance.now();
    try{return original.apply(this,args);}finally{if(current){const metric=current.parts[label]||={calls:0,ms:0};metric.calls++;metric.ms+=performance.now()-start;}}
  };
}
wrap(fs,'readFileSync','fsRead');wrap(require('node:zlib'),'gunzipSync','gunzip');
const workbook=require(path.join(repo,'record-workbooks'));
wrap(workbook,'readFile','workbookRead');wrap(workbook.utils,'sheet_to_json','sheetToRows');
const stock=require(path.join(repo,'toteat-stock')),stockFactory=stock.createStockSync;
stock.createStockSync=(...args)=>{const service=stockFactory(...args);wrap(service,'current','stockCurrent');return service;};
const {createApp}=require(path.join(repo,'server'));
const app=createApp({uploadsRoot:root,enableToteatSync:false,enableMercadoPagoSync:false,storageMaintenance:false,
  reportToday:'2026-10-24',projectionToday:'2026-10-24',
  mercadoPagoBrowser:{download(){throw Error('Audit forbids external sync');},async close(){}},
  toteatApiFetch(){throw Error('Audit forbids external sync');}});
const originalHandle=app.handle;
app.handle=function(req,res,next){
  const sample={url:req.url,method:req.method,started:performance.now(),parts:{}};
  return context.run(sample,()=>{res.once('finish',()=>{sample.ms=performance.now()-sample.started;sample.status=res.statusCode;delete sample.started;requests.push(sample);});return originalHandle.call(this,req,res,next);});
};
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
const results={api:[],browser:[],hypotheses:[],requests,blockedExternal:[],pageErrors:[]};
function persist(){fs.writeFileSync(path.join(work,'measurements-private.json'),JSON.stringify(results,null,2));}
async function main(){
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try {
    const orders=await realFetch(base+'/api/purchase-orders?location=store-1').then(r=>r.json());
    const latest=orders.orders?.[0]?.id;
    const endpoints=[
      ['/api/purchase-orders?location=store-1','ordenes'],
      ...(latest?[[`/api/purchase-orders/${latest}`,'abrir-orden']]:[]),
      ['/api/uploads/overview','estado-fuentes'],
      ['/api/purchases?location=store-1&dateFrom=2026-10-01&dateTo=2026-10-23','compras'],
      ['/api/ingredients?location=store-1&dateFrom=2026-10-01&dateTo=2026-10-23','ingredientes'],
      ['/api/cost-review?location=store-1&dateTo=2026-10-23','costos'],
      ['/api/reports/network-sales','resumen-ventas'],
      ['/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-23','resultados'],
      ['/api/inventory/current?location=main-warehouse&date=2026-10-23','inventario'],
      ['/api/purchase-projections?location=main-warehouse','abastecimiento']
    ];
    for(const [url,label]of endpoints) {
      for(let repetition=0;repetition<5;repetition++) {
        const start=performance.now(),r=await realFetch(base+url),headersMs=performance.now()-start;
        const bytes=await r.arrayBuffer();
        let data;try{data=JSON.parse(Buffer.from(bytes).toString());}catch{}
        results.api.push({label,repetition,status:r.status,headersMs,ms:performance.now()-start,bytes:bytes.byteLength,error:data?.error||null});
      }
      persist();console.log(JSON.stringify({completed:label,last:results.api.at(-1)}));
    }
    const {chromium}=require(path.join(repo,'node_modules/playwright-core'));
    browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:950}});
    await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==base && !['data:','blob:'].includes(u.protocol)){results.blockedExternal.push(u.origin);return route.abort();}return route.continue();});
    page.on('pageerror',error=>results.pageErrors.push(error.message));
    const pending=new Set(),traffic=[];
    page.on('request',request=>{if(request.url().includes('/api/')){pending.add(request);traffic.push({url:request.url().replace(base,''),method:request.method(),at:performance.now()});}});
    const done=request=>pending.delete(request);page.on('requestfinished',done);page.on('requestfailed',done);
    async function settle(){const end=performance.now()+90000;let idle=0;while(performance.now()<end){if(!pending.size){if(++idle>=3)return;}else idle=0;await new Promise(r=>setTimeout(r,100));}throw Error('UI requests did not settle');}
    await page.goto(base);await page.waitForFunction(()=>typeof locationRegistry!=='undefined'&&Object.keys(locationRegistry).length>0);await settle();
    await page.addInitScript(()=>{});
    const views=[['purchases','purchases-status'],['ingredients','ingredients-status'],['cost-review','cost-review-status'],['financial-results','financial-results-status'],['report','report-status'],['purchase-projection','purchase-projection-status'],['inventory','inventory-source-status'],['uploads','upload-overview-status']];
    for(const [view,statusId]of views) {
      for(let repetition=0;repetition<5;repetition++) {
        await page.evaluate(()=>setView('config'));const before=traffic.length,start=performance.now();
        const immediate=await page.evaluate(({view,statusId})=>{
          const start=performance.now();setView(view);const el=document.getElementById(statusId);
          return {dispatchMs:performance.now()-start,text:el?.textContent||null,visible:el?!!el.getClientRects().length:false};
        },{view,statusId});
        await settle();
        results.browser.push({view,repetition,ms:performance.now()-start,immediate,requests:traffic.slice(before).map(({url,method})=>({url,method}))});
      }
      persist();console.log(JSON.stringify({completed:'UI '+view,lastMs:results.browser.at(-1).ms}));
    }
    // Native change handlers: choose two dates in one action, before waiting.
    await page.evaluate(()=>setView('purchases'));await settle();let before=traffic.length;
    await page.evaluate(()=>{for(const [id,value]of [['purchases-date-from','2026-10-02'],['purchases-date-to','2026-10-22']]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();
    results.hypotheses.push({case:'two-purchase-filters',requests:traffic.slice(before).map(({url,method})=>({url,method}))});
    // Capture actual response shapes, then invert responses without external traffic.
    await page.evaluate(()=>setView('financial-results'));await settle();
    const template=await page.evaluate(()=>JSON.parse(JSON.stringify(financialResultsState)));
    let sequence=0;
    await page.route('**/api/financial-results?*',async route=>{
      const n=++sequence,data=structuredClone(template);data.scope.label=n===1?'AUDIT_OLD':'AUDIT_NEW';
      await new Promise(r=>setTimeout(r,n===1?400:40));await route.fulfill({json:data});
    });
    await page.evaluate(async()=>{
      document.getElementById('financial-results-from').value='2026-10-01';const older=loadFinancialResults();
      document.getElementById('financial-results-from').value='2026-10-02';const newer=loadFinancialResults();await Promise.all([older,newer]);
    });
    results.hypotheses.push({case:'financial-reversed-responses',...await page.evaluate(()=>({selectedFrom:document.getElementById('financial-results-from').value,lastLabel:financialResultsState.scope.label}))});
    await page.unroute('**/api/financial-results?*');
    // Block one main-thread calculation while issuing a lightweight order request.
    const concurrentStart=performance.now();
    const heavy=realFetch(base+'/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-23');
    const light=realFetch(base+'/api/purchase-orders?location=store-1');
    const [hr,lr]=await Promise.all([heavy,light]);await Promise.all([hr.arrayBuffer(),lr.arrayBuffer()]);
    results.hypotheses.push({case:'financial-and-orders-concurrent',ms:performance.now()-concurrentStart,statuses:[hr.status,lr.status]});
    await page.evaluate(()=>setView('uploads'));await settle();await page.screenshot({path:path.join(work,'sources.png'),fullPage:false});
    results.navigation=await page.locator('.navigation .nav-group').evaluateAll(groups=>groups.map(g=>({group:g.querySelector('h2')?.textContent,links:[...g.querySelectorAll('a')].map(a=>({text:a.textContent.trim(),view:a.dataset.view||a.getAttribute('href')}))})));
  } finally {
    results.eventLoop={maxMs:lag.max/1e6,meanMs:lag.mean/1e6};lag.disable();
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));persist();
  }
}
main().catch(error=>{results.failure={message:error.message,stack:error.stack};persist();console.error(error);process.exitCode=1;});
