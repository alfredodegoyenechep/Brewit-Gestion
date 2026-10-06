const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('unavailable recovery browser reports a connection failure without claiming a login window', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-no-browser-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const reader=require('../server').createToteatAutomation(root,{cdpEndpoint:'http://127.0.0.1:9224',executablePath:chrome,
  chromium:{connectOverCDP:async()=>{throw Error('private endpoint failure');},launchPersistentContext:async()=>{throw Error('private launch failure');}}});
 await assert.rejects(reader.readNativeSources({restaurantId:'r',localId:'1'}),error=>{
  assert.equal(error.code,'TOTEAT_BROWSER_UNAVAILABLE');assert.equal(error.loginOpened,undefined);
  assert.doesNotMatch(error.message,/private|Dejamos abierta/);return true;
 });
});
test('native reader recognizes login redirect and leaves a visible login context open', {skip:!fs.existsSync(chrome)}, async t=>{
 const app=require('express')();app.get('/restaurant',(req,res)=>res.redirect('/login'));app.get('/login',(req,res)=>res.send('<input type="password"><button>Ingresar</button>'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}`,contexts=[],launches=[];
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-session-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const chromium={launchPersistentContext:async(dir,options)=>{
  launches.push(options.headless);
  const context=await require('playwright-core').chromium.launchPersistentContext(dir,{...options,headless:true});contexts.push(context);return context;
 }};
 t.after(async()=>{for(const c of contexts)await c.close().catch(()=>{});});
 const reader=require('../server').createToteatAutomation(root,{chromium,executablePath:chrome,restaurantsUrl:origin+'/restaurant',loginUrl:origin+'/login'});
 await assert.rejects(reader.readNativeSources({restaurantId:'r',localId:'1'}),e=>e.code==='TOTEAT_AUTH_REQUIRED'&&e.loginOpened===true);
 assert.deepEqual(launches,[true,false]);
 const page=contexts[1].pages()[0];assert.equal(page.isClosed(),false);assert.equal(page.url(),origin+'/login');
 await page.locator('input').fill('unfinished-login');
 // A repeated sync reuses the login window, without spawning another browser.
 await assert.rejects(reader.readNativeSources({restaurantId:'r',localId:'1'}),e=>e.code==='TOTEAT_AUTH_REQUIRED');
 assert.deepEqual(launches,[true,false]);assert.equal(page.isClosed(),false);
 assert.equal(await page.locator('input').inputValue(),'unfinished-login');
});

test('stale CDP opens a retained recovery profile and resumes the same update after login', {skip:!fs.existsSync(chrome)}, async t=>{
 const contexts=[],launches=[];let connections=0,source;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-cdp-session-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 // The persisted endpoint reproduces a browser that has been closed.
 fs.writeFileSync(path.join(root,'browser-connection.json'),JSON.stringify({cdpEndpoint:'http://127.0.0.1:9224'}));
 const chromium={
  connectOverCDP:async()=>{connections++;throw Error('private connection detail');},
  launchPersistentContext:async(dir,options)=>{
   launches.push(options.headless);
   const context=await require('playwright-core').chromium.launchPersistentContext(dir,{...options,headless:true});contexts.push(context);
   await context.route('https://res8.toteat.com/**',route=>route.fulfill({contentType:'text/html',body:`
    <script>
     if(location.pathname==='/login'){
      document.write('<input type="password"><button>Ingresar</button>');
      document.querySelector('button').onclick=()=>{localStorage.setItem('authenticated','yes');location.href='/restaurant';};
     }
     else if(!localStorage.getItem('authenticated'))location.href='/login';
     else {
      localStorage.setItem('resto',JSON.stringify({ir:'r',il:'1'}));
      document.write('<table><tr ng-click="selecciona"><td>r</td><td>1</td><td>Local</td><td></td><td></td></tr></table>');
      const services={configuracion:{objeto:{ir:'r',il:'1'}},masterProd:{maestro:{local:[{m_id:'p1'}]}},setupConfig:{Refresh:(_id,done)=>done(),jerarquias:{listado:[]},jerarquiasIngredientes:{listado:[]},jerarquiasExtras:{listado:[]}}};
      window.angular={element:()=>({injector:()=>({get:name=>services[name]})})};
      if(location.pathname==='/')for(const kind of ['products','warehouses'])fetch('https://api.toteat.com/locals/local1/'+kind+'/',{headers:{authorization:'test-session'}});
     }
    </script>`}));
   await context.route('https://api.toteat.com/**',route=>route.fulfill({headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization'},json:{results:route.request().url().includes('/products/')?[{id:'p1',local:'local1'}]:[]}}));
   return context;
  }
 };
 t.after(async()=>{for(const context of contexts)await context.close().catch(()=>{});});
 const reader=require('../server').createToteatAutomation(root,{chromium,executablePath:chrome,restaurantsUrl:'https://res8.toteat.com/restaurant',loginUrl:'https://res8.toteat.com/login'});
 const app=require('express')();app.use(require('express').json());
 require('../upload-overview').registerUploadOverview(app,{uploadsRoot:root,locations:()=>[],
  masters:{sharedStatus:()=>({}),synchronizeShared:async()=>{source=await reader.readNativeSources({restaurantId:'r',localId:'1'});}},
  sales:{},stock:{},files:()=>[],masterFiles:()=>[]});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const post=route=>fetch(origin+route,{method:'POST'});
 const settle=async()=>{for(let i=0;i<200;i++){const {job}=await fetch(origin+'/api/uploads/overview').then(r=>r.json());if(job.waitingForAuthentication||!job.running)return job;await new Promise(r=>setTimeout(r,25));}assert.fail('Update did not settle');};
 await post('/api/uploads/refresh');let job=await settle();const id=job.id;
 assert.equal(job.waitingForAuthentication,true);assert.equal(job.steps[0].state,'waiting-auth');assert.equal(job.finishedAt,null);
 assert.match(job.steps[0].message,/Dejamos abierta/);assert.doesNotMatch(JSON.stringify(job),/private connection detail/);
 assert.deepEqual(launches,[false]);assert.equal(connections,1);
 const page=contexts[0].pages()[0];await page.locator('input').fill('in-progress');
 await post('/api/uploads/resume');job=await settle();assert.equal(job.waitingForAuthentication,true);
 assert.equal(await page.locator('input').inputValue(),'in-progress');assert.equal(connections,1);assert.deepEqual(launches,[false]);
 await page.getByRole('button',{name:'Ingresar'}).click();await page.waitForURL('**/restaurant');
 await post('/api/uploads/resume');job=await settle();
 assert.equal(job.id,id);assert.equal(job.running,false);assert.equal(job.summary.complete,1);assert.equal(job.waitingForAuthentication,false);
 assert.equal(source.products[0].id,'p1');assert.equal(source.localId,'1');assert.equal(page.isClosed(),false);
 assert.equal(connections,1);assert.deepEqual(launches,[false]);
});

test('receipt verification can use the saved authenticated profile when the configured browser is unavailable', {skip:!fs.existsSync(chrome)}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-receipt-session-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const contexts=[],launches=[];let connections=0;
 const chromium={connectOverCDP:async()=>{connections++;throw Error('private connection failure');},launchPersistentContext:async(dir,options)=>{
  launches.push(options.headless);const context=await require('playwright-core').chromium.launchPersistentContext(dir,options);contexts.push(context);
  await context.route('https://res8.toteat.com/**',route=>route.fulfill({contentType:'text/html',body:`<script>
   localStorage.setItem('resto',JSON.stringify({ir:'r',il:'1',nr:'Local'}));
   document.write('<table><tr ng-click="selecciona"><td>r</td><td>1</td><td>Local</td><td></td><td></td></tr></table>');
   const services={configuracion:{objeto:{ir:'r',il:'1'}},masterProd:{maestro:{local:[{m_id:'p1'}]}},setupConfig:{Refresh:(_id,done)=>done(),jerarquias:{listado:[]},jerarquiasIngredientes:{listado:[]},jerarquiasExtras:{listado:[]}}};
   window.angular={element:()=>({injector:()=>({get:name=>services[name]})})};
   for(const kind of ['products','warehouses'])fetch('https://api.toteat.com/locals/local1/'+kind+'/',{headers:{authorization:'test-session'}});
  </script>`}));
  await context.route('https://api.toteat.com/**',route=>route.fulfill({headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization'},json:{results:route.request().url().includes('/products/')?[{id:'p1',local:'local1'}]:[]}}));
  return context;
 }};
 t.after(async()=>{for(const context of contexts)await context.close().catch(()=>{});});
 const reader=require('../server').createToteatAutomation(root,{chromium,executablePath:chrome,cdpEndpoint:'http://127.0.0.1:9224',restaurantsUrl:'https://res8.toteat.com/restaurant'});
 const source=await reader.readNativeSources({restaurantId:'r',localId:'1'},{allowSavedProfileFallback:true});
 assert.equal(source.localId,'1');assert.equal(source.products[0].id,'p1');assert.equal(connections,1);assert.deepEqual(launches,[true]);
 assert.ok(!JSON.stringify(source).includes('test-session'));
});
