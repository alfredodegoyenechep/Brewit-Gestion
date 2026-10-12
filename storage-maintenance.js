const fs=require('node:fs'),path=require('node:path');
const records=require('./record-store'),retention=require('./storage-retention');
const read=(file,fallback=null)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;
function files(dir) {
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isSymbolicLink()?[]:e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
}
function statTree(dir) {
  const entries=fs.statSync(dir).isFile()?[dir]:files(dir);
  const list=entries.map(file=>{const s=fs.statSync(file);return {file:path.relative(dir,file),size:s.size,mtime:s.mtimeMs,blocks:s.blocks};});
  return {stamp:records.hash(JSON.stringify(list.sort((a,b)=>a.file.localeCompare(b.file)))),bytes:list.reduce((n,s)=>n+s.size,0),allocatedBytes:list.reduce((n,s)=>n+s.blocks*512,0)};
}
function contained(root,relative) {
  const file=path.resolve(root,relative);
  if(!relative||path.isAbsolute(relative)||!file.startsWith(path.resolve(root)+path.sep))throw Error('Ruta de mantenimiento fuera del almacenamiento.');
  for(let dir=file;dir!==path.resolve(root);dir=path.dirname(dir))if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('No se permiten enlaces simbólicos en la limpieza.');
  return file;
}
function unusedMasterProof(file) {
  const source=read(file),directory=path.dirname(file),normalized=read(path.join(directory,'normalized.json'));
  if(!source||!normalized)return {safe:false,reason:'missing-normalized-master'};
  const expected=require('./toteat-masters').normalizeMasters(source);
  const actual={...normalized};delete actual.inputFingerprint;
  if(JSON.stringify(actual)!==JSON.stringify(expected))return {safe:false,reason:'master-schema-not-equivalent'};
  for(const name of ['master-catalog','master-recipes','product-hierarchy','ingredient-hierarchy','extras-hierarchy',...(source.suppliers?.length?['master-suppliers']:[])]) {
    const view=path.join(directory,name+'.xlsx');if(!records.descriptor(view))return {safe:false,reason:'master-view-not-migrated'};records.load(view);
  }
  return {safe:true,reason:'master-source-replaced-by-validated-records',sourceHash:records.hash(fs.readFileSync(file)),normalizedHash:records.hash(fs.readFileSync(path.join(directory,'normalized.json')))};
}
function audit(root,{progress=()=>{}}={}) {
  root=path.resolve(root);records.registerRoot(root);
  const candidates=[],preserved=[];
  for(const kind of retention.KINDS) {
    const base=path.join(root,'.integrations/toteat-api',kind);if(!fs.existsSync(base))continue;
    for(const entry of fs.readdirSync(base,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()) {
      const location=entry.name,ctx=retention.context(root,kind,location),dirs=retention.generations(root,kind,location);
      for(const [i,g]of dirs.entries()) {
        try {
          const proof=retention.proof(root,kind,location,g,ctx),item={kind,location,version:g.version,path:path.relative(root,g.directory),...statTree(g.directory),proof};
          (proof.safe?candidates:preserved).push(item);
        }catch(error){preserved.push({kind,location,version:g.version,path:path.relative(root,g.directory),proof:{safe:false,reason:'unreadable-or-unverified'}});}
        if(i%200===0)progress(`${kind}/${location}: ${i+1}/${dirs.length}`);
      }
    }
  }
  for(const file of files(path.join(root,'.integrations/toteat-api/masters')))if(path.basename(file)==='original.json') {
    try {const proof=unusedMasterProof(file),item={kind:'unused-master-source',path:path.relative(root,file),...statTree(file),proof};(proof.safe?candidates:preserved).push(item);}
    catch {preserved.push({path:path.relative(root,file),proof:{safe:false,reason:'unverified-master-source'}});}
  }
  const indexedSources=new Set(sourceFiles(root));
  for(const area of ['masters','transactions','weeks','.integrations/toteat-api'])for(const file of files(path.join(root,area))) {
    if(!/\.(xlsx?|csv|txt)$/i.test(file)||indexedSources.has(file))continue;
    const relative=path.relative(root,file);
    preserved.push({kind:'unindexed-source',path:relative,...statTree(file),proof:{safe:false,
      reason:/\/validation[^/]*\//.test(relative)?'saved-validation-artifact':'no-proven-replacement'}});
  }
  // Staging needs an expired review, not merely an old directory timestamp.
  const staging=path.join(root,'.staging');
  if(fs.existsSync(staging))for(const e of fs.readdirSync(staging,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink()) {
    const dir=path.join(staging,e.name),manifest=read(path.join(dir,'manifest.json'));
    if(manifest&&Date.now()-Date.parse(manifest.createdAt)>24*3600000)candidates.push({kind:'expired-staging',path:path.relative(root,dir),...statTree(dir),proof:{safe:true,reason:'expired-upload-review'}});
    else preserved.push({path:path.relative(root,dir),proof:{safe:false,reason:'active-or-unknown-staging'}});
  }
  return {format:'brewit-storage-audit-v1',root,createdAt:new Date().toISOString(),candidates,preserved,
    candidateBytes:candidates.reduce((n,c)=>n+c.bytes,0),candidateAllocatedBytes:candidates.reduce((n,c)=>n+c.allocatedBytes,0),
    alwaysPreserved:['masters and their historical source versions','user reports, purchase orders and closed results','credentials, browser sessions, configuration and operations data','unreferenced files without a proven replacement']};
}
function apply(root,manifest,{progress=()=>{}}={}) {
  root=path.resolve(root);
  if(manifest.format!=='brewit-storage-audit-v1'||manifest.root!==root)throw Error('Manifiesto incompatible.');
  const removed=[],skipped=[],contexts=new Map();
  for(const item of manifest.candidates) {
    const dir=contained(root,item.path);
    if(!fs.existsSync(dir)){skipped.push({path:item.path,reason:'already-absent'});continue;}
    if(statTree(dir).stamp!==item.stamp){skipped.push({path:item.path,reason:'changed-after-audit'});continue;}
    if(item.kind==='expired-staging') {
      if(!/^\.staging\/[a-f0-9-]{36}$/.test(item.path))throw Error('Temporal fuera del área de cargas.');
      const m=read(path.join(dir,'manifest.json'));if(!m||Date.now()-Date.parse(m.createdAt)<=24*3600000){skipped.push({path:item.path,reason:'review-not-expired'});continue;}
    }else if(item.kind==='unused-master-source'){
      if(!/^\.integrations\/toteat-api\/masters\/[\w-]+\/[\w.-]+\/original\.json$/.test(item.path))throw Error('Fuente de maestro fuera de su ubicación.');
      const proof=unusedMasterProof(dir);if(!proof.safe||proof.sourceHash!==item.proof.sourceHash||proof.normalizedHash!==item.proof.normalizedHash){skipped.push({path:item.path,reason:'master-records-changed'});continue;}
    }else{
      if(!retention.KINDS.includes(item.kind)||!/^[\w-]+$/.test(item.location)||!/^[\w-]+$/.test(item.version)||path.relative(root,dir)!==path.join('.integrations/toteat-api',item.kind,item.location,item.version))throw Error('Candidato ajeno a las versiones operativas.');
      const key=item.kind+':'+item.location;
      if(!contexts.has(key))contexts.set(key,retention.context(root,item.kind,item.location));
      const proof=retention.proof(root,item.kind,item.location,{version:item.version,directory:dir},contexts.get(key));
      if(!proof.safe||proof.current!==item.proof.current||proof.currentSourceHash!==item.proof.currentSourceHash){skipped.push({path:item.path,reason:'dependency-or-authority-changed'});continue;}
    }
    fs.rmSync(dir,{recursive:true});removed.push({path:item.path,reason:item.proof.reason,bytes:item.bytes,allocatedBytes:item.allocatedBytes});
    if(removed.length%200===0)progress(`Versiones eliminadas: ${removed.length}/${manifest.candidates.length}`);
  }
  return {createdAt:new Date().toISOString(),removed,skipped,freedBytes:removed.reduce((n,r)=>n+r.bytes,0),freedAllocatedBytes:removed.reduce((n,r)=>n+r.allocatedBytes,0)};
}
function sourceFiles(root) {
  const result=new Set();
  const add=(base,record)=>{
    if(!record)return;
    if(Array.isArray(record)){record.forEach(r=>add(base,r));return;}
    if(record.name&&/\.(xlsx?|csv|txt)$/i.test(record.name)) {
      const file=path.resolve(base,record.name);
      if(file.startsWith(path.resolve(base)+path.sep)&&(fs.existsSync(file)||fs.existsSync(records.descriptorPath(file))))result.add(file);
    }
    for(const part of record.parts||[])add(base,part);
  };
  const index=read(path.join(root,'masters/masters.json'),{});
  for(const group of Object.values(index))for(const record of Object.values(group))add(path.join(root,'masters'),record);
  for(const file of files(path.join(root,'transactions')))if(path.basename(file)==='index.json') {
    for(const group of Object.values(read(file,{}).fields||{}))for(const record of group.files||[])add(path.dirname(file),record);
  }
  for(const file of files(path.join(root,'weeks')))if(path.basename(file)==='meta.json')for(const record of Object.values(read(file,{}).files||{}))add(path.dirname(file),record);
  for(const kind of ['sales','purchases','masters']) {
    const base=path.join(root,'.integrations/toteat-api',kind);
    for(const file of files(base))if(/\.(xlsx?|csv|txt)$/i.test(file))result.add(file);
    else if(file.endsWith('.records.json'))result.add(file.slice(0,-'.records.json'.length));
  }
  return [...result].sort();
}
function migrate(root,{remove=false,progress=()=>{}}={}) {
  root=path.resolve(root);records.registerRoot(root);
  const migrated=[],pending=[];
  for(const file of sourceFiles(root)) {
    try {
      const d=records.importFile(file,file,root);
      if(remove)records.removeOriginal(file);
      migrated.push({path:path.relative(root,file),blob:d.blob,sourceBytes:d.sourceBytes||0,originalRemoved:!fs.existsSync(file)});
    }catch(error){pending.push({path:path.relative(root,file),reason:error.message});}
    if((migrated.length+pending.length)%20===0)progress(`Fuentes: ${migrated.length} migradas; ${pending.length} pendientes`);
  }
  return {createdAt:new Date().toISOString(),migrated,pending};
}
module.exports={unusedMasterProof,audit,apply,migrate,sourceFiles,statTree,contained};
