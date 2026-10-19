const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const express = require('express');
const { History, register, responseBody, annotate } = require('../historical-control');
const { compare } = require('../historical-worker');
const { extract, differences } = require('../historical-adapters');
const options = { now:'2026-10-18T15:00:00Z', runId:'new', complete:true, ranges:[{from:'2026-10-01',to:'2026-10-18'}] };
const record = (id, date='2026-10-05', amount=100) => ({id,date,fields:{id,date,amount},warehouse:'w1'});
const incoming = records => ({records,ambiguous:[]});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-historical-')), history=new History(root);
  t.after(async()=>{await history.idle();fs.rmSync(root,{recursive:true,force:true});});
  return {root,history};
}
test('baseline, field changes, complete deletions, historical additions and current-day growth',()=>{
  const first=compare(null,incoming([record('a'),record('b')]),{...options,runId:'base'});
  assert.equal(first.status,'baseline');assert.equal(first.changes.length,0);
  const second=compare(first.state,incoming([record('a','2026-10-05',120),record('c'),record('d','2026-10-18')]),options);
  assert.deepEqual(second.summary,{modified:1,deleted:1,historicalAdded:1,growth:1,masterAdded:0,ambiguous:0});
  assert.deepEqual(second.changes.find(c=>c.type==='modified').fields[0],{field:'amount',before:100,after:120,beforePresent:true,afterPresent:true});
  assert.equal(second.changes[0].previousRunId,'base');
});
test('unobserved historical dates and coverage gaps are normal growth',()=>{
  const first=compare(null,incoming([]),{...options,ranges:[{from:'2026-10-05',to:'2026-10-05'}]});
  const second=compare(first.state,incoming([record('a','2026-10-01')]),{...options,ranges:[{from:'2026-10-01',to:'2026-10-01'}]});
  assert.equal(second.summary.historicalAdded,0);assert.equal(second.summary.growth,1);
});
test('partial and non-overlapping windows never delete records outside verified coverage',()=>{
  const first=compare(null,incoming([record('a')]),options);
  assert.equal(compare(first.state,incoming([]),{...options,complete:false}).summary.deleted,0);
  assert.equal(compare(first.state,incoming([]),{...options,ranges:[{from:'2026-10-10',to:'2026-10-18'}]}).summary.deleted,0);
  assert.equal(compare(first.state,incoming([]),options).summary.deleted,1);
});
test('valid empty complete windows become historical coverage; partial empties do not',()=>{
  for(const complete of [true,false]){
    const first=compare(null,incoming([]),{...options,complete});
    const second=compare(first.state,incoming([record('a')]),options);
    assert.equal(second.summary.historicalAdded,complete?1:0);
  }
});
test('unresolved identities prevent false deletions while identifiable modifications continue',()=>{
  const first=compare(null,incoming([record('a'),record('b')]),options);
  const second=compare(first.state,{records:[record('a','2026-10-05',200)],ambiguous:[{reason:'Sin ID'}]},options);
  assert.equal(second.summary.modified,1);assert.equal(second.summary.deleted,0);assert.equal(second.status,'partial');
});
test('masters separate new records from changes and verified removals',()=>{
  const first=compare(null,incoming([record('a'),record('b')]),{...options,master:true});
  const second=compare(first.state,incoming([record('a','2026-10-05',200),record('c')]),{...options,master:true});
  assert.equal(second.summary.masterAdded,1);assert.equal(second.summary.historicalAdded,0);assert.equal(second.summary.modified,1);assert.equal(second.summary.deleted,1);
});
test('stable IDs detect changed operation dates and nested fields; ordering does not produce changes',()=>{
  const first=compare(null,incoming([record('a')]),options);
  const second=compare(first.state,incoming([record('a','2026-10-06')]),options);
  assert.equal(second.changes[0].previousDate,'2026-10-05');assert.equal(second.changes[0].operationDate,'2026-10-06');
  assert.deepEqual(differences([{id:'a',q:1},{id:'b',q:2}],[{id:'b',q:2},{id:'a',q:1}]),[]);
  assert.equal(differences({products:[{lineId:'x',quantity:1}]},{products:[{lineId:'x',quantity:2}]})[0].field,'products[x].quantity');
});
test('manual composite identity preserves repeated legitimate document rows and flags unidentifiable rows',()=>{
  const bytes=Buffer.from('Fecha,Documento,Producto,Cantidad\n05/10/2026,F1,Cafe,1\n05/10/2026,F1,Cafe,1\n');
  const result=extract(bytes,{format:'file',name:'compras.csv'},{dataset:'purchases'});
  assert.equal(result.records.length,1);assert.equal(result.records[0].fields.rows.length,2);
  assert.equal(extract(Buffer.from('Fecha,Producto,Cantidad\n05/10/2026,Cafe,1'),{format:'file'},{dataset:'waste'}).ambiguous.length,1);
});
test('API date conversion respects Santiago and duplicates do not become arbitrary matches',()=>{
  const result=extract(Buffer.from(JSON.stringify({data:[{paymentId:'p',dateClosed:'2026-10-06T01:00:00Z'}]})),{format:'json'},{dataset:'sales',selector:'data'});
  assert.equal(result.records[0].date,'2026-10-05');
  assert.equal(extract(Buffer.from('[{"id":1},{"id":1}]'),{format:'json'},{dataset:'counts'}).ambiguous.length,1);
});
test('each identical execution keeps its original response and completes a comparison',async t=>{
  const {history}=fixture(t), body='{ "ok": true, "data": [{"id":1,"date":"2026-10-05","q":2}] }';
  for(let i=0;i<2;i++)await history.track({origin:'api',location:'s1'},async()=>{
    const received=await responseBody({text:async()=>body},{name:'data.json'});
    annotate(received,[{dataset:'sales',selector:'data',range:options.ranges[0],complete:true}]);
  });
  await history.idle();
  const runs=history.manifests().sort((a,b)=>a.sequence-b.sequence);
  assert.equal(runs.length,2);assert.notEqual(runs[0].id,runs[1].id);
  for(const run of runs){assert.equal(run.artifacts.length,1);assert.equal(run.comparison,'done');assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(history.directory(run.id),run.artifacts[0].id+'.gz'))).toString(),body);}
  assert.equal(history.report(runs[1].id).sources[0].status,'complete');assert.equal(history.report(runs[1].id).sources[0].changes.length,0);
});
test('failed executions preserve received evidence without advancing the baseline',async t=>{
  const {history}=fixture(t);
  await assert.rejects(history.track({origin:'api',location:'s1'},async()=>{
    history.capture(require('../historical-control').context.getStore().run,{body:[{id:'a'}],datasets:[{dataset:'counts',complete:true}]});throw Error('Upstream failed');
  }));
  await history.idle();const [run]=history.manifests();assert.equal(run.artifacts.length,1);assert.equal(run.reception,'incomplete');assert.equal(run.comparison,'not-applicable');assert.equal(history.report(run.id),null);
});
test('backup write failure prevents the publication callback',async t=>{
  const {history}=fixture(t);let published=false;
  const original=history.capture.bind(history);history.capture=()=>{throw Object.assign(Error('Disk full'),{code:'HISTORICAL_BACKUP_FAILED'});};
  await assert.rejects(history.track({},async()=>{history.capture();published=true;}));assert.equal(published,false);history.capture=original;
});
test('restart marks interrupted reception and resumes queued comparisons',async t=>{
  const {root,history}=fixture(t), interrupted=history.begin({}), pending=history.begin({origin:'api'});
  history.capture(pending,{body:[{id:1,date:'2026-10-05'}],datasets:[{dataset:'counts',complete:true,range:options.ranges[0]}]});
  pending.reception='complete';pending.finishedAt=new Date().toISOString();pending.publication='published';history.save(pending);
  const recovered=new History(root);recovered.resume();await recovered.idle();
  assert.equal(recovered.load(interrupted.id).reception,'incomplete');assert.equal(recovered.load(pending.id).comparison,'done');
});
test('storage sums actual physical compressed files without double-counting shared datasets',async t=>{
  const {history}=fixture(t);
  await history.track({},async run=>history.capture(run,{body:[{id:1}],datasets:[{dataset:'sales',complete:true},{dataset:'payment-details',complete:true}]}));await history.idle();
  const run=history.manifests()[0], stats=history.storage(require('../historical-control').localDay(new Date()));
  assert.equal(stats.files.filter(f=>f.artifactId).length,1);
  const actual=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).reduce((sum,e)=>sum+(e.isDirectory()?actual(path.join(dir,e.name)):fs.statSync(path.join(dir,e.name)).size),0);
  assert.equal(stats.currentBytes,actual(history.root));assert.equal(stats.dailyBytes,stats.currentBytes);assert.equal(stats.averagePeriod.days,1);
  assert.equal(stats.files.find(f=>f.artifactId).bytes,run.artifacts[0].bytes);
});
test('migration is idempotent, marks reconstructions and never creates retroactive alerts',async t=>{
  const {root,history}=fixture(t);const dir=path.join(root,'transactions','s1');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'original.csv'),'Fecha,Documento\n05/10/2026,1');
  const records=require('../record-store');records.registerRoot(root);records.importFile(path.join(dir,'original.csv'));records.removeOriginal(path.join(dir,'original.csv'));
  history.bootstrap();const first=history.manifests();assert.equal(first.length,1);assert.equal(first[0].artifacts[0].evidence,'reconstruction');assert.equal(first[0].comparison,'not-applicable');
  history.bootstrap();assert.equal(history.manifests().length,1);
});
test('API filters, pagination, original downloads, missing IDs and date validation',async t=>{
  const {history}=fixture(t);await history.track({origin:'manual',location:'s1'},async run=>history.capture(run,{bytes:Buffer.from('Original bytes\n'),name:'original.csv',format:'file'}));await history.idle();
  const app=express();register(app,history);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/api/historical-control`,run=history.manifests()[0];
  assert.equal((await (await fetch(base+'/runs?location=s1')).json()).total,1);
  assert.equal((await (await fetch(base+'/runs?location=other')).json()).total,0);
  assert.equal((await fetch(base+'/storage?date=2026-02-31')).status,400);
  assert.equal((await fetch(base+'/runs/invalid')).status,400);
  const response=await fetch(`${base}/runs/${run.id}/files/${run.artifacts[0].id}/download`);assert.equal(await response.text(),'Original bytes\n');
  assert.equal((await fetch(`${base}/runs/${run.id}/files/missing/download`)).status,404);
});
test('backup record counts stay per response when several windows belong to one synchronization',async t=>{
  const {history}=fixture(t);
  await history.track({origin:'api',location:'s1'},async run=>{
    for(const id of ['a','b'])history.capture(run,{body:[{id,date:'2026-10-05'}],datasets:[{dataset:'counts',complete:true,range:options.ranges[0]}]});
  });await history.idle();const run=history.manifests().find(r=>!r.antecedent);
  assert.deepEqual(run.artifacts.map(a=>a.datasets[0].recordCount),[1,1]);assert.equal(history.report(run.id).sources[0].recordCount,2);
});
test('corrupt evidence leaves comparison pending and retries before the next version without reversing chronology',async t=>{
  const {history}=fixture(t);history.bootstrap();const first=history.begin({origin:'api',location:'s1'});
  const artifact=history.capture(first,{body:[{id:'a',date:'2026-10-05',q:1}],datasets:[{dataset:'counts',complete:true,range:options.ranges[0]}]});
  const file=path.join(history.directory(first.id),artifact.id+'.gz'),original=fs.readFileSync(file);fs.writeFileSync(file,'corrupt');
  history.finish(first);await history.idle();assert.equal(history.load(first.id).comparison,'pending');
  fs.writeFileSync(file,original);
  await history.track({origin:'api',location:'s1'},async run=>history.capture(run,{body:[{id:'a',date:'2026-10-05',q:2}],datasets:[{dataset:'counts',complete:true,range:options.ranges[0]}]}));
  await history.idle();assert.equal(history.load(first.id).comparison,'done');const newest=history.manifests().sort((a,b)=>b.sequence-a.sequence)[0];assert.equal(history.report(newest.id).sources[0].summary.modified,1);
});
test('migration prefers available original bytes, preserves known receipt dates and precedes operational pruning',async t=>{
  const {root,history}=fixture(t),dir=path.join(root,'transactions','s1');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'sales.csv'),original='Fecha,Documento,Importe\r\n05/10/2026,F1,100\r\n';fs.writeFileSync(file,original);
  const records=require('../record-store');records.registerRoot(root);records.importFile(file);
  fs.writeFileSync(path.join(dir,'index.json'),JSON.stringify({fields:{sales:{files:[{name:'sales.csv',originalName:'original-sales.csv',savedAt:'2026-10-06T15:00:00Z'}]}}}));
  const base=path.join(root,'.integrations/toteat-api/original-counts/s1');
  for(let i=0;i<5;i++){
    const directory=path.join(base,'v'+i);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'original.json'),JSON.stringify({restaurantId:'r',localId:'1',localRef:'l',capturedAt:'2026-10-05T15:00:00Z',range:options.ranges[0],operations:{counts:[]}}));
    fs.writeFileSync(path.join(directory,'state.json'),'{}');
  }
  fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({version:'v4'}));history.bootstrap();
  const run=history.manifests().find(r=>r.artifacts[0]?.name==='original-sales.csv');assert.ok(run);assert.equal(run.originalReceivedAt,'2026-10-06T15:00:00Z');assert.equal(run.artifacts[0].evidence,'original');
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(history.directory(run.id),run.artifacts[0].id+'.gz'))).toString(),original);
  const count=history.manifests().length;require('../storage-retention').startup(root);assert.equal(history.manifests().length,count);assert.equal(history.manifests().filter(r=>r.artifacts[0]?.name==='original.json').length,5);
});
test('storage includes unregistered physical evidence and zero-load calendar days in its average',async t=>{
  const {history}=fixture(t);fs.writeFileSync(path.join(history.root,'unregistered.gz'),'unexpected-evidence');
  const today=require('../historical-control').localDay(new Date()),future=new Date(Date.parse(today+'T12:00:00Z')+2*86400000).toISOString().slice(0,10),stats=history.storage(future);
  assert.equal(stats.averagePeriod.days,3);assert.equal(stats.dailyBytes,0);assert.equal(stats.averageDailyBytes,stats.totalBytes/3);
  assert.equal(history.storage(today).files.filter(f=>f.kind==='unregistered-evidence').length,1);
});
test('external identifiers cannot overwrite object prototypes and missing operation dates stay unresolved',()=>{
  const first=compare(null,incoming([record('__proto__')]),options);assert.ok(Object.hasOwn(first.state.records,'__proto__'));
  const second=compare(first.state,incoming([record('__proto__','2026-10-05',200)]),options);assert.equal(second.summary.modified,1);
  const parsed=extract(Buffer.from('[{"id":"undated","q":1}]'),{format:'json'},{dataset:'purchases'});assert.equal(parsed.ambiguous.length,1);
  assert.equal(compare(first.state,parsed,options).summary.growth,0);
});
test('reconfigured upstream locations establish independent baselines without recording credentials',async t=>{
  const {history}=fixture(t);
  for(const restaurantId of ['restaurant-a','restaurant-b'])await history.track({origin:'api',location:'s1',upstream:{restaurantId,localId:'1',token:'must-not-be-saved'}},async run=>history.capture(run,{
    body:[{id:'same-id',date:'2026-10-05',amount:restaurantId==='restaurant-a'?100:200}],datasets:[{dataset:'sales',range:options.ranges[0],complete:true}]
  }));
  await history.idle();const runs=history.manifests().filter(r=>!r.antecedent).sort((a,b)=>b.sequence-a.sequence);
  assert.equal(history.report(runs[0].id).sources[0].status,'baseline');assert.doesNotMatch(JSON.stringify(runs),/must-not-be-saved/);
});
test('malformed prior evidence remains downloadable and does not prevent antecedent migration',async t=>{
  const {root,history}=fixture(t),dir=path.join(root,'.integrations/toteat-api/stock/s1/v1');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'state.json'),'{incomplete');fs.writeFileSync(path.join(dir,'original.json'),'{original-incomplete');
  history.bootstrap();assert.equal(history.manifests().length,2);assert.equal(history.manifests().find(r=>r.artifacts[0].name==='state.json').artifacts[0].evidence,'incomplete');
  for(const run of history.manifests())assert.equal(run.comparison,'not-applicable');
});
test('daily consumption exports have consistent product-day identities across all consumption families',()=>{
  const bytes=Buffer.from('ID Producto **\tNombre Producto *\t2026-10-05\t2026-10-06\nP1\tCafé\t1\t2');
  for(const dataset of ['marketing','employees','calibrations','waste']) {
    const result=extract(bytes,{format:'file'},{dataset});assert.equal(result.records.length,2);assert.equal(result.ambiguous.length,0);assert.notEqual(result.records[0].id,result.records[1].id);
    assert.equal(result.records[0].fields.Valor,'1');
  }
});
