const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
 // A repeated sync reuses the login window, without spawning another browser.
 await assert.rejects(reader.readNativeSources({restaurantId:'r',localId:'1'}),e=>e.code==='TOTEAT_AUTH_REQUIRED');
 assert.deepEqual(launches,[true,false]);assert.equal(page.isClosed(),false);
});
