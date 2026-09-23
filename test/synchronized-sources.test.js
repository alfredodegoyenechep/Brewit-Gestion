const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),XLSX=require('xlsx');
const {createApp}=require('../server');
const {synchronizedMaster}=require('../synchronized-sources');
test('synchronized master selection excludes a newer manual master and never merges historical recipes',()=>{
 const records=[{source:'manual',validFrom:'2026-09-22',name:'obsolete'}, {source:'toteat-shared-api',validFrom:'2026-09-21',name:'observed'}];
 assert.equal(synchronizedMaster(records,'2026-09-22').name,'observed');assert.equal(synchronizedMaster(records,'2026-08-23').name,'observed');assert.equal(synchronizedMaster(records.slice(0,1),'2026-09-22'),null);
});
test('synchronized installation never falls back to a downloaded sale or Kardex, even before the first API sync',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-source-policy-'));const dir=path.join(root,'weeks','2026-08-24','store-1');fs.mkdirSync(dir,{recursive:true});
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([{'Fecha de creacion':'2026-08-24','ID Producto':'OBSOLETE',Nombre:'Old data',Cantidad:100,'Pago total':999999}]),'Ventas');XLSX.writeFile(wb,path.join(dir,'old.xlsx'));
 fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify({files:{sales:{name:'old.xlsx',originalName:'old.xlsx',detectedRange:{from:'2026-08-24',to:'2026-08-24'}},kardex:{name:'old.xlsx'}}}));
 const server=createApp({uploadsRoot:root,sourceMode:'synchronized',reportToday:'2026-08-25'}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}`;
 const sales=await(await fetch(base+'/api/reports/weekly-sales?location=store-1')).json();assert.equal(sales.filesRead,0);assert.equal(sales.sourcePolicy.legacyFallback,false);
 const inv=await fetch(base+'/api/purchase-projections?location=store-1');assert.notEqual(inv.status,200);assert.match((await inv.json()).error,/API/);
 const policy=await(await fetch(base+'/api/source-policy')).json();assert.equal(policy.mode,'synchronized');
});


test('historical costs never restore a recipe removed from the applicable synchronized version', () => {
  const { effectiveRecipeVersions } = require('../synchronized-sources');
  const records = [
    {name:'manual',source:'manual',validFrom:'2026-09-22'},
    {name:'direct-api',source:'toteat-shared-api',validFrom:'2026-09-22',recipes:[]},
    {name:'previous-sync',source:'toteat-shared-api',validFrom:'2026-09-21',recipes:['RETIRED']}
  ];
  assert.deepEqual(effectiveRecipeVersions(records,'2026-09-22',true).flatMap(r=>r.recipes),[]);
  assert.deepEqual(effectiveRecipeVersions(records,'2026-09-21',true).flatMap(r=>r.recipes),['RETIRED']);
  assert.deepEqual(effectiveRecipeVersions(records,'2026-09-20',true),[]);
});
