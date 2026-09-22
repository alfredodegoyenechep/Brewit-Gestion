const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerUploadOverview}=require('../upload-overview');
test('overview distinguishes manual files, central source, schedules and sequential API refresh',async t=>{
 const calls=[],app=express();app.use(express.json());
 const status=id=>({configured:true,from:'2026-08-23',enabled:id==='store-1',intervalMinutes:5,lastSuccess:'2026-09-22T10:00:00Z'});
 const sales={status,synchronize:async id=>calls.push('sales:'+id),purchases:{status,synchronize:async id=>calls.push('purchases:'+id)}};
 registerUploadOverview(app,{locations:()=>[{id:'store-1',name:'La Concepción',type:'store',status:'active'},{id:'store-2',name:'Lyon',type:'store',status:'active'},{id:'main-warehouse',name:'Bodega Principal',type:'warehouse',status:'active'}],sales,
 masters:{sharedStatus:()=>({running:false}),synchronizeShared:async()=>calls.push('masters')},stock:{status:()=>({range:{from:'2026-08-23'},updatedAt:'2026-09-22T11:00:00Z'}),synchronize:async id=>calls.push('stock:'+id)},files:()=>[{savedAt:'2026-09-20T10:00:00Z'}],masterFiles:()=>[{savedAt:'2026-09-21T10:00:00Z'}]});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}`;
 let data=await fetch(url+'/api/uploads/overview').then(r=>r.json());assert.equal(data.columns.length,9);assert.equal(data.masters.length,6);assert.equal(data.rows[2].cells[0].applicable,false);assert.equal(data.rows[2].cells[5].sharedFrom,'La Concepción');assert.equal(data.rows[0].cells[3].origin,'Archivo cargado');assert.equal(data.rows[1].schedules[0].enabled,false);
 assert.equal((await fetch(url+'/api/uploads/refresh',{method:'POST'})).status,202);
 for(let i=0;i<20;i++){data=await fetch(url+'/api/uploads/overview').then(r=>r.json());if(!data.job.running)break;}
 assert.deepEqual(calls,['masters','sales:store-1','purchases:store-1','stock:store-1','sales:store-2','purchases:store-2','stock:store-2']);assert.ok(data.job.steps.every(s=>s.state==='complete'));
});
test('native schedules persist, respect due times, avoid overlap and retry failures at the selected interval',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-native-schedule-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let clock=Date.parse('2026-09-22T10:00:00Z'),calls=[],release;
 const app=express();app.use(express.json());
 const deps={uploadsRoot:root,now:()=>clock,locations:()=>[{id:'store-1',name:'La Concepción',type:'store',status:'active'}],sales:{status:()=>({configured:true,from:'2026-08-23'}),purchases:{status:()=>({})}},masters:{sharedStatus:()=>({}),synchronizeShared:async()=>{calls.push('masters');if(release===undefined)await new Promise(r=>release=r);}},stock:{status:()=>({range:{from:'2026-08-23'}}),synchronize:async()=>{calls.push('inventory');throw Error('offline');}},files:()=>[],masterFiles:()=>[]};
 const control=registerUploadOverview(app,deps),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}`;
 const save=body=>fetch(url+'/api/uploads/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await save({masters:5,inventory:15})).status,400);
 assert.equal((await save({masters:15,inventory:60})).status,200);
 await control.tick();assert.deepEqual(calls,[]);
 clock+=15*60000;const pending=control.tick();await control.tick();assert.deepEqual(calls,['masters']);release();await pending;
 clock+=45*60000;await control.tick();assert.deepEqual(calls,['masters','masters','inventory']);await control.tick();assert.equal(calls.length,3);
 const app2=express();app2.use(express.json());const restored=registerUploadOverview(app2,deps);await restored.tick();assert.equal(calls.length,3);
 clock+=60*60000;await restored.tick();assert.equal(calls.filter(c=>c==='inventory').length,2);
 assert.equal((await save({masters:null,inventory:null})).status,200);clock+=86400000;await control.tick();assert.equal(calls.length,5);
});
test('refresh exposes the full plan before execution and preserves success and failure results after restart',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-refresh-report-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let release;const hold=new Promise(r=>release=r),status=()=>({configured:true,from:'2026-08-23'});
 const deps={uploadsRoot:root,locations:()=>[{id:'store-1',name:'La Concepción',type:'store',status:'active'}],sales:{status,synchronize:async()=>{},purchases:{status,synchronize:async()=>{throw Error('secret-token-must-not-leak');}}},masters:{sharedStatus:()=>({}),synchronizeShared:()=>hold},stock:{status:()=>({range:{from:'2026-08-23'}}),synchronize:async()=>{}},files:()=>[],masterFiles:()=>[]};
 const app=express();app.use(express.json());registerUploadOverview(app,deps);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}`;
 let job=await fetch(url+'/api/uploads/refresh',{method:'POST'}).then(r=>r.json());assert.equal(job.steps.length,4);assert.equal(job.steps[0].sources.length,6);assert.equal(job.summary.pending,3);assert.equal(job.summary.running,1);
 const same=await fetch(url+'/api/uploads/refresh',{method:'POST'}).then(r=>r.json());assert.equal(same.id,job.id);
 release();for(let i=0;i<30;i++){job=(await fetch(url+'/api/uploads/overview').then(r=>r.json())).job;if(!job.running)break;}
 assert.equal(job.running,false);assert.equal(job.summary.complete,3);assert.equal(job.summary.error,1);assert.ok(job.finishedAt);assert.ok(job.steps.every(s=>s.startedAt&&s.finishedAt));assert.ok(!JSON.stringify(job).includes('secret-token'));
 const saved=JSON.parse(fs.readFileSync(path.join(root,'.integrations/toteat-api/last-refresh.json')));assert.equal(saved.id,job.id);assert.equal(saved.steps[2].state,'error');
 const app2=express();app2.use(express.json());registerUploadOverview(app2,deps);
 const server2=app2.listen(0,'127.0.0.1');await new Promise(r=>server2.once('listening',r));t.after(()=>new Promise(r=>server2.close(r)));
 const restored=await fetch(`http://127.0.0.1:${server2.address().port}/api/uploads/overview`).then(r=>r.json());assert.equal(restored.job.id,job.id);assert.equal(restored.job.summary.error,1);
});
