const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const maintenance=require('../storage-maintenance'),retention=require('../storage-retention');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=path.join(root,'.integrations/toteat-api/stock/store-1');fs.mkdirSync(base,{recursive:true});for(let i=0;i<6;i++){const dir=path.join(base,'v'+i);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'original.json'),JSON.stringify({restaurantId:'r',localId:'1',localRef:'l',capturedAt:'2026-10-08T00:00:00Z',range:{from:'2026-08-23',to:'2026-10-08'},operations:{counts:[{id:1,registration_date:'2026-08-30'}]}}));fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({dependencies:{},daily:[{quantity:i}]}));fs.utimesSync(dir,new Date(1000+i*1000),new Date(1000+i*1000));}fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({version:'v5'}));return {root,base};}
test('audit is read-only, manifests delete only confirmed candidates, repeat application is safe',t=>{
 const {root,base}=fixture(t);const audit=maintenance.audit(root);assert.equal(audit.candidates.length,3);assert.equal(fs.readdirSync(base).length,7);const report=maintenance.apply(root,audit);assert.equal(report.removed.length,3);assert.equal(fs.readdirSync(base).length,4);assert.equal(maintenance.apply(root,audit).removed.length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(base,'current.json'))).version,'v5');
});
test('unique coverage, changed candidates and active readers are preserved',t=>{
 const {root,base}=fixture(t);const file=path.join(base,'v0/original.json');const source=JSON.parse(fs.readFileSync(file));source.range.from='2026-05-18';fs.writeFileSync(file,JSON.stringify(source));const release=retention.lease(path.join(base,'v1'));const audit=maintenance.audit(root);assert.equal(audit.candidates.length,1);fs.appendFileSync(path.join(base,'v2/state.json'),' ');assert.equal(maintenance.apply(root,audit).removed.length,0);release();assert.ok(fs.existsSync(file));
});
test('manifest cannot remove masters, escape root or follow symlinks',t=>{
 const {root}=fixture(t);const audit=maintenance.audit(root);audit.candidates[0].path='../outside';assert.throws(()=>maintenance.apply(root,audit),/fuera/);const masters=path.join(root,'masters');fs.mkdirSync(masters);fs.writeFileSync(path.join(masters,'critical.json'),'{}');const bad=maintenance.audit(root);bad.candidates=[{kind:'masters',path:'masters',...maintenance.statTree(masters),proof:{}}];assert.throws(()=>maintenance.apply(root,bad),/ajeno/);assert.ok(fs.existsSync(path.join(masters,'critical.json')));
});
test('a newer confirmed window replaces cancellations rather than unioning old documents',()=>{
 const old={restaurantId:'r',localId:'1',capturedAt:'2026-09-01T00:00:00Z',range:{from:'2026-08-23',to:'2026-08-30'},operations:{counts:[{id:1,registration_date:'2026-08-30',status:'APPROVED'}]}};const latest={...old,capturedAt:'2026-10-01T00:00:00Z',operations:{counts:[]}};assert.equal(retention.superseded(old,latest),true);old.operations.counts[0].registration_date='2026-09-01';assert.equal(retention.superseded(old,latest),false);
});


test('retired aggregate inventory is replaceable only by complete documents of the same verified local',()=>{
 const old={kind:'public-inventory',restaurantId:'r',localId:'1',capturedAt:'2026-09-01T00:00:00Z',range:{from:'2026-08-23',to:'2026-08-30'},batches:{}};
 const current={restaurantId:'r',localId:'1',localRef:'local',capturedAt:'2026-10-01T00:00:00Z',range:{from:'2026-08-23',to:'2026-10-01'},operations:{counts:[],transfers:[],transformations:[]}};
 assert.equal(retention.superseded(old,current),true);assert.equal(retention.superseded({...old,localId:'2'},current),false);assert.equal(retention.superseded({...old,range:{from:'2026-05-18',to:'2026-08-30'}},current),false);
});
