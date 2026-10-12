// Retention applies only to replaceable operational snapshots, never masters,
// reports, credentials or user documents. Unproven candidates are retained.
const fs = require('node:fs'), path = require('node:path');
const records = require('./record-store');
const KINDS = ['stock','original-counts','sales','purchases'];
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const rootOf = root => path.join(root, '.integrations', 'toteat-api');
const leases = new Map();
function fingerprint(value) {
  const canonical = v => {
    if (Array.isArray(v)) return v.map(canonical);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.keys(v).sort().filter(k => !['capturedAt','syncedAt','observedAt','sourceCapturedAt','version','directory','ownedOrderSet','inputFingerprint'].includes(k)).map(k=>[k,canonical(v[k])]));
  };
  return records.hash(JSON.stringify(canonical(value)));
}
function lease(directory) {
  const key=path.resolve(directory);leases.set(key,(leases.get(key)||0)+1);
  return ()=>{const n=(leases.get(key)||1)-1;if(n)leases.set(key,n);else leases.delete(key);};
}
function readLease(root) {
  const directory=path.join(root,'.records','readers');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,require('node:crypto').randomUUID()+'.json');
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
  return ()=>fs.rmSync(file,{force:true});
}
function activeReaders(root) {
  const directory=path.join(root,'.records','readers');if(!fs.existsSync(directory))return false;
  for(const name of fs.readdirSync(directory)) {
    const file=path.join(directory,name);
    try {const reader=read(file);process.kill(reader.pid,0);return true;}
    catch(error){if(error.code==='ESRCH')fs.rmSync(file,{force:true});else return true;}
  }
  return false;
}
function generations(root,kind,location) {
  const dir=path.join(rootOf(root),kind,location);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^[\w-]+$/.test(e.name))
    .map(e=>({version:e.name,directory:path.join(dir,e.name),mtime:fs.statSync(path.join(dir,e.name)).mtimeMs}))
    .sort((a,b)=>b.mtime-a.mtime);
}
function retained(root,kind,location) {
  const current=read(path.join(rootOf(root),kind,location,'current.json'))?.version;
  const dirs=generations(root,kind,location);
  const keep=new Set([current,...dirs.filter(d=>d.version!==current).slice(0,2).map(d=>d.version)]);
  for(const d of dirs)if(leases.has(path.resolve(d.directory)))keep.add(d.version);
  return keep;
}
function references(root,kind,location) {
  const pins=new Set();
  if(kind==='stock')return pins;
  const keepStock=retained(root,'stock',location);
  for(const s of generations(root,'stock',location))if(keepStock.has(s.version)) {
    const state=read(path.join(s.directory,'state.json'));
    const key=kind==='original-counts'?'counts':kind;
    if(state?.dependencies?.[key])pins.add(state.dependencies[key]);
  }
  return pins;
}
function superseded(older, latest) {
  if(!older||!latest||!older.range||!latest.range)return false;
  for(const field of ['restaurantId','localId'])if(older[field]!==latest[field])return false;
  // The retired public aggregate API did not expose localRef. Its verified
  // restaurant/local tuple still identifies the location without inventing a ref.
  if(older.kind!=='public-inventory'&&older.localRef!==latest.localRef)return false;
  if(older.localRef!=null&&older.localRef!==latest.localRef)return false;
  if(older.range.from<latest.range.from||older.range.to>latest.range.to)return false;
  if(!Number.isFinite(Date.parse(older.capturedAt))||Date.parse(older.capturedAt)>Date.parse(latest.capturedAt))return false;
  // A newer confirmed complete window is authoritative, including removals and
  // cancellations. Old documents outside that window must NEVER be unioned in.
  if(!latest.operations || !(older.operations || older.kind==='public-inventory'))return false;
  for(const [kind,docs]of Object.entries(older.operations||{}))if(Array.isArray(docs)) {
    const currentIds=new Set((latest.operations[kind]||[]).map(d=>String(d.id)));
    for(const doc of docs) {
      const date=String(doc.registration_date||doc.date||'').slice(0,10);
      if((!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<latest.range.from||date>latest.range.to)&&!currentIds.has(String(doc.id)))return false;
    }
  }
  return true;
}
function context(root,kind,location) {
  const base=path.join(rootOf(root),kind,location),pointer=read(path.join(base,'current.json'));
  return {base,pointer,keep:retained(root,kind,location),pins:references(root,kind,location),
    currentSource:pointer?read(path.join(base,pointer.version,'original.json')):null,
    currentSourceHash:pointer&&fs.existsSync(path.join(base,pointer.version,'original.json'))?records.hash(fs.readFileSync(path.join(base,pointer.version,'original.json'))):null,
    currentState:pointer?read(path.join(base,pointer.version,'state.json')):null};
}
function proof(root,kind,location,generation,ctx=context(root,kind,location)) {
  const {base,pointer,keep,pins,currentSource,currentState,currentSourceHash}=ctx;
  if(!pointer)return {safe:false,reason:'missing-current-pointer'};
  if(activeReaders(root)||keep.has(generation.version)||pins.has(generation.version))return {safe:false,reason:'retained-or-referenced'};
  const dir=generation.directory;
  const names=fs.readdirSync(dir);
  if(!names.length)return {safe:true,reason:'empty-unpublished-generation',current:pointer.version};
  if(!fs.existsSync(path.join(dir,'state.json'))) {
    if(names.length===1&&names[0]==='original.json'&&currentSourceHash&&records.hash(fs.readFileSync(path.join(dir,'original.json')))===currentSourceHash)
      return {safe:true,reason:'identical-unpublished-source',current:pointer.version,currentSourceHash};
    return {safe:false,reason:'incomplete-generation'};
  }
  const latest=path.join(base,pointer.version);
  if(kind==='stock'||kind==='original-counts') {
    const oldSource=read(path.join(dir,'original.json'));
    if(!superseded(oldSource,currentSource))return {safe:false,reason:'unique-or-unconfirmed-coverage'};
    return {safe:true,reason:'replaced-by-confirmed-window',current:pointer.version,
      sourceHash:records.hash(fs.readFileSync(path.join(dir,'original.json'))),currentSourceHash};
  }
  const old=read(path.join(dir,'state.json')),current=currentState;
  if(!old||!current||old.from<current.from||old.through>current.through)return {safe:false,reason:'unique-or-unconfirmed-coverage'};
  // Ownership tombstones are essential for excluding replaced/manual orders.
  for(const field of ['ownedOrders','owned'])if((old[field]||[]).some(id=>!(current[field]||[]).includes(id)))return {safe:false,reason:'missing-ownership-tombstone'};
  return {safe:true,reason:'replaced-operational-generation',current:pointer.version};
}
function prune(root,kind,location,{limit=Infinity}={}) {
  const removed=[],pending=[],ctx=context(root,kind,location);
  for(const generation of generations(root,kind,location)) {
    if(removed.length>=limit)break;
    const p=proof(root,kind,location,generation,ctx);
    if(!p.safe){pending.push({version:generation.version,reason:p.reason});continue;}
    fs.rmSync(generation.directory,{recursive:true});removed.push(generation.version);
  }
  return {removed,pending};
}
function safePrune(root,kind,location) {try{const result=prune(root,kind,location);if(result.removed.length)records.collectGarbage(root);return result;}catch{return {removed:[],pending:[{reason:'retention-check-failed'}]};}}
function startup(root) {
  if(fs.existsSync(path.join(root,'.storage-maintenance.lock')))return;
  for(const kind of KINDS) {
    const base=path.join(rootOf(root),kind);if(!fs.existsSync(base))continue;
    for(const e of fs.readdirSync(base,{withFileTypes:true}))if(e.isDirectory()) {
      // A large legacy backlog belongs to the explicit audited maintenance job.
      if(generations(root,kind,e.name).length<=32)safePrune(root,kind,e.name);
    }
  }
  try { records.collectGarbage(root); } catch { /* An unreadable reference protects all blobs. */ }
}
module.exports={readLease,activeReaders,context,KINDS,fingerprint,lease,generations,retained,references,proof,prune,safePrune,startup,superseded};
