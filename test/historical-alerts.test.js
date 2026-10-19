const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const {History,register,localDay}=require('../historical-control');

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-alerts-')),history=new History(root);
  history.bootstrap();const app=express();register(app,history);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await history.idle();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/api/historical-control/alerts`;
  const date=localDay(new Date());
  const get=async query=>{const response=await fetch(base+'?'+new URLSearchParams({date,...query}));assert.equal(response.status,200);return response.json();};
  const load=async(records,source={},meta={})=>{
    await history.track({origin:'manual',location:'s1',...meta},run=>history.capture(run,{body:records,datasets:[{dataset:'purchases',complete:true,range:{from:'2020-01-01',to:'2020-01-03'},...source}]}));
    await history.idle();return history.manifests().sort((a,b)=>b.sequence-a.sequence)[0];
  };
  return {history,base,date,get,load};
}
const record=(id,amount=100,warehouse='w1')=>({id,date:'2020-01-02',amount,warehouse});
test('alert report consolidates historical changes, excludes normal growth and master additions, paginates and exports all fields',async t=>{
  const {load,get,base,date}=await fixture(t);
  await load([record('a'),record('b')]);
  const changed=await load([record('a',150),record('c'),{id:'today',date,amount:10}]);
  await load([record('m1')],{dataset:'master-catalog',master:true});
  await load([record('m1'),record('m2')],{dataset:'master-catalog',master:true});
  const report=await get({limit:'1'});
  assert.equal(report.total,3);assert.equal(report.alerts.length,1);
  assert.equal(report.summary.modified,1);assert.equal(report.summary.deleted,1);assert.equal(report.summary.historicalAdded,1);assert.equal(report.summary.review,0);
  const detail=await get({type:'modified'});assert.equal(detail.total,1);assert.equal(detail.alerts[0].runId,changed.id);assert.equal(detail.alerts[0].operationDate,'2020-01-02');
  assert.equal(detail.alerts[0].fields.find(f=>f.field==='amount').before,100);
  assert.equal((await get({offset:'1',limit:'1'})).alerts.length,1);
  const response=await fetch(base+'?'+new URLSearchParams({date,limit:'1',format:'csv'}));
  assert.match(response.headers.get('content-disposition'),/alertas-historicas/);assert.match(response.headers.get('content-type'),/text\/csv/);
  const csv=await response.text();assert.match(csv,/Registro eliminado/);assert.match(csv,/Alta histórica/);assert.match(csv,/amount/);assert.match(csv,/150/);assert.match(csv,/2020-01-02/);assert.match(csv,/America\/Santiago|Chile/);
});
test('alert filters apply to each source and affected warehouse, and use detection date rather than operation or reception date',async t=>{
  const {load,get,history}=await fixture(t);
  await load([record('a',100,'w1'),record('b',100,'w2')]);
  const run=await load([record('a',150,'w1'),record('b',200,'w2')]);
  run.startedAt='2019-01-01T12:00:00Z';history.save(run);
  assert.equal((await get({})).total,2);
  assert.equal((await get({warehouse:'w1'})).summary.modified,1);
  assert.equal((await get({warehouse:'w2'})).alerts[0].id,'b');
  for(const query of [{origin:'other'},{location:'s2'},{dataset:'sales'},{date:'2020-01-02'},{warehouse:'other'}])assert.equal((await get(query)).total,0);
  assert.equal((await get({origin:'manual',location:'s1',dataset:'purchases'})).total,2);
});
test('antecedents, baselines, partial comparisons, incomplete loads and pending jobs never masquerade as a complete clean audit',async t=>{
  const {history,get,load}=await fixture(t);
  const old=history.begin({antecedent:true,location:'s1'});history.capture(old,{body:[record('old')],datasets:[{dataset:'purchases'}]});history.finish(old);
  const antecedents=await get({});assert.equal(antecedents.total,0);assert.equal(antecedents.summary.antecedents,1);assert.match(antecedents.message,/Solo hay antecedentes/);
  await load([record('a')]);assert.match((await get({})).message,/línea base/);
  await load([record('a',200)],{complete:false});
  const failed=history.begin({location:'s1',datasets:['purchases']});history.finish(failed,{success:false});
  history.begin({location:'s1',datasets:['purchases']});
  const report=await get({});assert.equal(report.summary.modified,1);assert.equal(report.summary.deleted,0);assert.equal(report.summary.review,3);
  assert.deepEqual(new Set((await get({type:'review'})).alerts.map(a=>a.type)),new Set(['partial','incomplete','pending']));
  assert.equal((await get({type:'deleted'})).total,0);
});
test('API validates ranges and types, labels complete comparisons explicitly and protects exported source values from spreadsheet formulas',async t=>{
  const {base,load,get}=await fixture(t);
  for(const query of ['date=2026-02-31','date=2026-10-19&dateTo=2026-10-18','type=unknown'])assert.equal((await fetch(base+'?'+query)).status,400);
  await load([record('a')]);await load([record('a')]);
  // Select only the second execution's detection day to exercise the clean verdict.
  const {collect,csv}=require('../historical-alerts');
  const clean=collect({manifests:()=>[{id:'r',origin:'manual',location:'s1',artifacts:[],reception:'complete',comparison:'done',comparedAt:'2026-10-19T15:00:00Z',summaries:[{dataset:'purchases',origin:'manual',location:'s1',status:'complete',summary:{modified:0,deleted:0,historicalAdded:0}}]}]},{date:'2026-10-19',dateTo:'2026-10-19'});
  assert.equal(clean.message,'Sin cambios históricos detectados');
  clean.alerts=[{type:'modified',detectedAt:clean.generatedAt,fields:[{field:'name',before:'=1+1',beforePresent:true,after:'@SUM(1)',afterPresent:true}],location:'s1'}];
  const exported=csv(clean);assert.ok(exported.startsWith('\uFEFF'));assert.match(exported,/'=1\+1/);assert.match(exported,/'@SUM/);
  clean.alerts[0].fields=[{field:'optional',before:null,beforePresent:true,afterPresent:false}];
  assert.match(csv(clean),/"null";"Campo ausente"/);
  assert.equal((await get({type:'review'})).total,0);
});
test('mixed origins and datasets in a shared execution remain independently filterable and unreadable reports require review',async t=>{
  const {history,get}=await fixture(t);
  for(const amount of [100,200]){
    await history.track({origin:'manual',location:'s1'},run=>{
      for(const [dataset,origin]of [['purchases','manual'],['sales','web']])history.capture(run,{body:[record('a',amount)],origin,datasets:[{dataset,complete:true,range:{from:'2020-01-01',to:'2020-01-03'}}]});
    });await history.idle();
  }
  assert.equal((await get({})).summary.modified,2);
  assert.equal((await get({dataset:'purchases',origin:'web'})).total,0);
  assert.equal((await get({dataset:'sales',origin:'web'})).summary.modified,1);
  const latest=history.manifests().sort((a,b)=>b.sequence-a.sequence)[0];
  fs.writeFileSync(path.join(history.directory(latest.id),'report.json.gz'),'unreadable');
  const report=await get({});assert.equal(report.summary.modified,0);assert.equal(report.summary.review,2);
  assert.ok(report.alerts.every(alert=>alert.type==='pending'));assert.match(report.message,/requieren revisión/);
});
