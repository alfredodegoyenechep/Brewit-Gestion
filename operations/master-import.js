const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {baseline}=require('./migration');
const {check}=require('./domain');
function readSharedSource(uploadsRoot) {
  const indexFile=path.join(uploadsRoot,'masters','masters.json');
  check(fs.existsSync(indexFile),'No hay maestros sincronizados para importar.');
  const index=JSON.parse(fs.readFileSync(indexFile,'utf8'));
  const selected=Object.values(index).map(g=>g['master-catalog']).filter(r=>r?.source==='toteat-shared-api').sort((a,b)=>b.savedAt.localeCompare(a.savedAt))[0];
  check(selected?.sourceVersion && /^[\w.-]+$/.test(selected.sourceVersion),'No hay publicación API válida.');
  return JSON.parse(fs.readFileSync(path.join(uploadsRoot,'.integrations','toteat-api','masters','store-1',selected.sourceVersion,'normalized.json'),'utf8'));
}
function prepare(source) {
  check(source && Array.isArray(source.products) && Array.isArray(source.suppliers) && Array.isArray(source.warehouses),'Captura incompleta.');
  check(Number.isFinite(Date.parse(source.observedAt)),'La captura no tiene fecha válida.');
  const summary=baseline(source),rows=[],seen=new Set();
  const add=(kind,code,original,proposal,issues=[])=>{
    check(typeof code==='string' && code.length>0,`Código ausente en ${kind}.`);
    const key=JSON.stringify([kind,code]);check(!seen.has(key),`Código repetido en ${kind}: ${code}.`);seen.add(key);
    rows.push({kind,code,original,proposal,issues});
  };
  for(const p of source.products){
    const b=summary.items.find(i=>i.code===p.code);
    add('item',p.code,p,{name:p.name,baseUnit:p.stockUnit,policy:b.proposedPolicy,active:p.active},b.issues);
    if(p.recipe?.ingredients?.length)add('recipe',p.code,{name:p.name,...p.recipe},null,summary.issues.filter(i=>i.code===p.code).map(i=>i.message));
  }
  for(const s of source.suppliers)add('supplier',String(s.code || s.id || ''),s,{name:s.name,taxId:s.taxId,sourceId:s.id},s.code?[]:['Sin código de proveedor; se conserva su identificador de origen.']);
  for(const w of source.warehouses)add('warehouse',String(w.code),w,null,['Confirmar ubicación y política de la bodega antes de habilitarla.']);
  for(const [kind,list] of Object.entries(source.hierarchies || {}))for(const h of list)add(`hierarchy-${kind}`,h.code,h,null);
  const counts=Object.fromEntries([...new Set(rows.map(r=>r.kind))].map(kind=>[kind,rows.filter(r=>r.kind===kind).length]));
  return {rows,report:{validationVersion:2,counts,issues:summary.issues,observedAt:source.observedAt,source:source.source,mode:'review',published:false}};
}
async function importShared(db,source) {
  const {rows,report}=prepare(source),hash=crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return db.transaction(async c=>{
    const old=(await c.query('SELECT id,report,created_at FROM brewit.master_imports WHERE source_hash=$1',[hash])).rows[0];
    if(old){
      if(old.report.validationVersion!==report.validationVersion){
        await c.query('UPDATE brewit.master_imports SET report=$2 WHERE id=$1',[old.id,report]);
        for(const row of rows)await c.query("UPDATE brewit.master_import_rows SET issues=$4 WHERE import_id=$1 AND kind=$2 AND code=$3 AND status='pending'",[old.id,row.kind,row.code,JSON.stringify(row.issues)]);
        await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES(NULL,$1,$2,$3)',['masters.import.reaudit',old.id,{validationVersion:report.validationVersion}]);
      }
      return {...old,report,reused:true};
    }
    const id=crypto.randomUUID();
    await c.query('INSERT INTO brewit.master_imports(id,source_hash,observed_at,source,report) VALUES($1,$2,$3,$4,$5)',[id,hash,source.observedAt,source,report]);
    for(const r of rows)await c.query('INSERT INTO brewit.master_import_rows(id,import_id,kind,code,original,proposal,issues) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),id,r.kind,r.code,r.original,r.proposal,JSON.stringify(r.issues)]);
    await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES(NULL,$1,$2,$3)',['masters.import.review',id,{counts:report.counts,source:source.source,method:'authorized-local-import'}]);
    return {id,report,reused:false};
  });
}
async function importedRows(db){
  const latest=(await db.pool.query('SELECT id,report,created_at FROM brewit.master_imports ORDER BY created_at DESC LIMIT 1')).rows[0];
  if(!latest)return {rows:[],report:null};
  const rows=(await db.pool.query('SELECT * FROM brewit.master_import_rows WHERE import_id=$1 ORDER BY kind,code',[latest.id])).rows;
  return {rows,report:latest.report,importedAt:latest.created_at};
}
module.exports={readSharedSource,prepare,importShared,importedRows};
