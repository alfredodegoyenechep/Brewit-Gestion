// Supplementary browser observations and independent-client contention timings.
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const repo=path.resolve(__dirname,'../../..'),work=fs.readFileSync('/private/tmp/brewit-audit-current.txt','utf8').trim();
if(!work.startsWith('/private/tmp/brewit-audit-20261024-'))throw Error('Audit root required');
for(const key of ['BREWIT_DATABASE_URL','BREWIT_TEST_DATABASE_URL','BREWIT_AUTH_KEY','BREWIT_REQUIRE_AUTH'])delete process.env[key];
const fetchLocal=global.fetch;global.fetch=(input,...args)=>{if(!['127.0.0.1','localhost'].includes(new URL(typeof input==='string'?input:input.url).hostname))throw Error('External fetch blocked');return fetchLocal(input,...args);};
const app=require(path.join(repo,'server')).createApp({uploadsRoot:path.join(work,'uploads'),enableToteatSync:false,enableMercadoPagoSync:false,storageMaintenance:false});
const output={inventory:[],contention:[],costReview:[],navigationRace:[],sources:[],screens:[]};
async function main(){
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await require(path.join(repo,'node_modules/playwright-core')).chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:950}});await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.goto(base);await page.waitForFunction(()=>typeof locationRegistry!=='undefined'&&Object.keys(locationRegistry).length>0);await page.evaluate(()=>setView('config'));
  // Existing startup requests finish before measurements.
  await page.waitForLoadState('networkidle');
  for(let repetition=0;repetition<5;repetition++){
   await page.evaluate(()=>setView('config'));
   const observed=await page.evaluate(async()=>{
    const start=performance.now();setView('inventory');const el=document.getElementById('inventory-source-status');const immediate={text:el.textContent,visible:!!el.getClientRects().length};
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {...immediate,paintOpportunityMs:performance.now()-start};
   });await page.waitForFunction(()=>!document.getElementById('inventory-source-status').textContent.includes('Consultando'));
   output.inventory.push({repetition,...observed});
  }
  // Delayed local response makes the sources view's initial feedback observable.
  await page.route('**/api/uploads/overview',async r=>{await new Promise(resolve=>setTimeout(resolve,700));await r.continue();});
  await page.evaluate(()=>setView('config'));await page.evaluate(()=>setView('uploads'));
  output.sources.push(await page.evaluate(()=>({status:document.getElementById('upload-overview-status').textContent,busy:document.getElementById('upload-overview').getAttribute('aria-busy')})));
  await page.waitForLoadState('networkidle');await page.unroute('**/api/uploads/overview');
  for(const view of ['uploads','purchases','financial-results']){
   await page.evaluate(v=>setView(v),view);await page.waitForLoadState('networkidle');
   await page.screenshot({path:path.join(work,'ui-'+view+'.png'),fullPage:false});
   output.screens.push({view,horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),selectedFilters:await page.locator('section:not([hidden]) select').count()});
  }
  await page.evaluate(()=>setView('config'));
  for(let repetition=0;repetition<5;repetition++){
   const r=await page.evaluate(async()=>{
    const start=performance.now();
    const get=async url=>{const response=await fetch(url);await response.arrayBuffer();return {ms:performance.now()-start,status:response.status};};
    const heavy=get('/api/financial-results?location=all&dateFrom=2026-10-01&dateTo=2026-10-23');
    const light=get('/api/purchase-orders?location=store-1');const [financial,orders]=await Promise.all([heavy,light]);return {financial,orders};
   });output.contention.push({repetition,...r});console.log(JSON.stringify({contention:repetition,...r}));
   const start=performance.now(),response=await fetchLocal(base+'/api/cost-review?location=store-1&dateTo=2026-10-23');await response.arrayBuffer();output.costReview.push({repetition,status:response.status,ms:performance.now()-start});
  }
  await page.evaluate(()=>setView('financial-results'));await page.waitForLoadState('networkidle');
  const template=await page.evaluate(()=>JSON.parse(JSON.stringify(financialResultsState)));
  for(let repetition=0;repetition<5;repetition++){
   let count=0;await page.route('**/api/financial-results?*',async route=>{const n=++count,data=structuredClone(template);data.scope.label=n===1?'AUDIT_OLD':'AUDIT_NEW';await new Promise(r=>setTimeout(r,n===1?400:40));await route.fulfill({json:data});});
   await page.evaluate(()=>{setView('config');document.getElementById('financial-results-from').value='2026-10-01';setView('financial-results');});
   await page.waitForTimeout(30);
   await page.evaluate(()=>{document.getElementById('financial-results-from').value='2026-10-02';setView('config');setView('financial-results');});
   await page.waitForTimeout(600);
   output.navigationRace.push({repetition,requests:count,...await page.evaluate(()=>({filterFrom:document.getElementById('financial-results-from').value,shownLabel:financialResultsState.scope.label}))});
   await page.unroute('**/api/financial-results?*');
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(work,'supplementary.json'),JSON.stringify(output,null,2));}
}
main().catch(e=>{output.failure=e.stack;fs.writeFileSync(path.join(work,'supplementary.json'),JSON.stringify(output,null,2));console.error(e);process.exitCode=1;});
