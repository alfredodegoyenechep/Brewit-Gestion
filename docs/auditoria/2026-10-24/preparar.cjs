// Read-only source inventory; private, credential-free copy for the audit.
// Run from the repository root: node docs/auditoria/2026-10-24/preparar.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const source = path.join(repo, 'uploads');
const work = fs.mkdtempSync('/private/tmp/brewit-audit-20261024-');
fs.chmodSync(work, 0o700);
const dest = path.join(work, 'uploads');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const baseline = { capturedAt: new Date().toISOString(), node: process.version,
  commit: cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd:repo,encoding:'utf8'}).trim(),
  trackedDiffSha256: hash(cp.execFileSync('git', ['diff', 'HEAD'], {cwd:repo,maxBuffer:20*1024*1024})),
  files: [], inconsistent: [], historical: [], lastRefresh: null, settings: {} };
function copy(relative) {
  const input = path.join(source, relative), output = path.join(dest, relative);
  if (!fs.existsSync(input)) return;
  const before = fs.lstatSync(input);
  if (before.isSymbolicLink()) throw Error('Refusing symlink in audit input');
  if (before.isDirectory()) {
    fs.mkdirSync(output, {recursive:true,mode:0o700});
    for (const name of fs.readdirSync(input)) if (name !== '.DS_Store' && !(relative === '.records' && name === 'readers')) copy(path.join(relative,name));
  } else {
    fs.mkdirSync(path.dirname(output), {recursive:true,mode:0o700});
    const bytes = fs.readFileSync(input);
    fs.writeFileSync(output,bytes,{mode:0o600});
    const after = fs.statSync(input);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) baseline.inconsistent.push(relative);
    baseline.files.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});
  }
}
for (const name of ['config','masters','transactions','weeks','reports','.records','.historical-control']) copy(name);
for (const name of ['sales','purchases','stock','masters','original-counts','original-operations','last-refresh.json','native-refresh.json']) copy('.integrations/toteat-api/'+name);
for (const name of ['settings.json','state.json']) copy('.integrations/mercadopago/'+name);
const runRoot = path.join(dest,'.historical-control/runs');
if(fs.existsSync(runRoot)) for(const dir of fs.readdirSync(runRoot)) {
  const m = read(path.join(runRoot,dir,'manifest.json')); if(!m) continue;
  baseline.historical.push({id:m.id,origin:m.origin,location:m.location,label:m.label,datasets:m.datasets,
    startedAt:m.startedAt,finishedAt:m.finishedAt,ms:Date.parse(m.finishedAt)-Date.parse(m.startedAt),
    reception:m.reception,publication:m.publication,comparison:m.comparison,
    artifacts:(m.artifacts||[]).map(a=>({name:a.name,bytes:a.bytes,kind:a.kind}))});
}
const latest = read(path.join(dest,'.integrations/toteat-api/last-refresh.json'));
baseline.lastRefresh = latest && {trigger:latest.trigger,startedAt:latest.startedAt,finishedAt:latest.finishedAt,
  steps:latest.steps?.map(s=>({label:s.label,state:s.state,method:s.method,startedAt:s.startedAt,finishedAt:s.finishedAt,ms:Date.parse(s.finishedAt)-Date.parse(s.startedAt)}))};
for(const kind of ['sales','purchases']) {
  const settings=read(path.join(dest,'.integrations/toteat-api',kind,'settings.json'))||{};
  baseline.settings[kind]=Object.fromEntries(Object.entries(settings).map(([k,s])=>[k,Object.fromEntries(['enabled','intervalMinutes','from','lastAttempt','lastFullSuccess'].filter(key=>key in s).map(key=>[key,s[key]]))]));
}
baseline.settings.native = read(path.join(dest,'.integrations/toteat-api/native-refresh.json'));
baseline.settings.mercadoPago = read(path.join(dest,'.integrations/mercadopago/settings.json'));
// Rebase absolute local paths in copied JSON only; source manifests remain intact.
let rebased=0;
for(const f of baseline.files.filter(f=>f.path.endsWith('.json'))) {
  const target=path.join(dest,f.path), raw=fs.readFileSync(target,'utf8');
  if(raw.includes(source)){fs.writeFileSync(target,raw.split(source).join(dest));rebased++;}
}
baseline.copy={files:baseline.files.length,bytes:baseline.files.reduce((n,f)=>n+f.bytes,0),rebased,credentialsCopied:false};
fs.writeFileSync(path.join(work,'baseline-private.json'),JSON.stringify(baseline,null,2));
fs.writeFileSync('/private/tmp/brewit-audit-current.txt',work,{mode:0o600});
console.log(JSON.stringify({work,copy:baseline.copy,inconsistent:baseline.inconsistent,historyRuns:baseline.historical.length}));
if(baseline.inconsistent.length) process.exitCode=1;
