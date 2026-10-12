// Durable data records. Logical source filenames remain stable for provenance;
// only <logical>.records.json and shared compressed record blobs are persisted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const XLSX = require('xlsx');
const roots = new Set();
const FORMAT = 'brewit-records-v1';
const suffix = '.records.json';
const workbookCache=new Map();
let workbookCacheBytes=0;
const WORKBOOK_CACHE_LIMIT=16*1024*1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function atomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function registerRoot(root) { roots.add(path.resolve(root)); }
function rootFor(file) {
  const absolute = path.resolve(file);
  const registered = [...roots].filter(root => absolute.startsWith(root + path.sep)).sort((a,b)=>b.length-a.length)[0];
  if (registered) return registered;
  for (let dir = path.dirname(absolute); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.records', 'blobs'))) return dir;
  }
  throw Error('No se encontró el almacén interno de registros.');
}
function managed(file) {
  if (typeof file !== 'string' || !/\.(xlsx?|csv|txt)$/i.test(file)) return false;
  const absolute = path.resolve(file);
  return [...roots].some(root => {
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    return /^(?:masters\/|transactions\/|weeks\/|\.integrations\/toteat-api\/(?:sales|purchases|masters)\/)/.test(rel);
  });
}
function descriptorPath(file) { return String(file).endsWith(suffix) ? String(file) : String(file) + suffix; }
function descriptor(file) {
  const p = descriptorPath(file);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (d.format !== FORMAT || !/^[a-f0-9]{64}$/.test(d.blob)) throw Error('Referencia de registros inválida.');
  return d;
}
function resolve(file) {
  if (typeof file !== 'string') return file;
  return fs.existsSync(descriptorPath(file)) ? descriptorPath(file) : file;
}
function put(root, data) {
  registerRoot(root);
  const bytes = Buffer.from(JSON.stringify(data));
  const digest = hash(bytes), file = path.join(root, '.records', 'blobs', digest + '.json.gz');
  if (!fs.existsSync(file)) atomic(file, zlib.gzipSync(bytes));
  // Read back before a descriptor can publish this blob.
  const check = zlib.gunzipSync(fs.readFileSync(file));
  if (hash(check) !== digest) throw Error('No se pudieron verificar los registros escritos.');
  return digest;
}
function load(file) {
  const d = descriptor(file);
  if (!d) return null;
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(rootFor(file), '.records', 'blobs', d.blob + '.json.gz')));
  if (hash(bytes) !== d.blob) throw Error('Los registros internos no superaron la verificación.');
  return JSON.parse(bytes);
}
function workbookData(book) {
  // Retain typed values, formula results, number formats, sheet topology and
  // merged headers used by the existing parsers; discard presentation/assets.
  const sheets = {};
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name], cells = {};
    for (const key of Object.keys(sheet).sort()) {
      if (key === '!ref' || key === '!merges') { cells[key] = sheet[key]; continue; }
      if (key.startsWith('!')) continue;
      const cell = sheet[key], value = {};
      for (const field of ['t','v','z','w','f']) if (cell[field] !== undefined) value[field] = cell[field];
      if (cell.v instanceof Date) value.v = { date: cell.v.toISOString() };
      cells[key] = value;
    }
    sheets[name] = cells;
  }
  return { kind: 'workbook', SheetNames: book.SheetNames, Sheets: sheets,
    date1904: Boolean(book.Workbook?.WBProps?.date1904) };
}
function readWorkbook(file, options = {}) {
  const meta=descriptor(file);
  let cacheKey;
  if(meta){
    const blobFile=path.join(rootFor(file),'.records/blobs',meta.blob+'.json.gz');
    const stamp=fs.statSync(blobFile);
    cacheKey=blobFile+':'+stamp.mtimeMs+':'+stamp.size+':'+JSON.stringify(options);
    const cached=workbookCache.get(cacheKey);
    if(cached)return structuredClone(cached.book);
  }
  const data = load(file);
  if (!data) return XLSX.readFile(file, options);
  if (data.kind === 'text') return XLSX.read(data.lines.join('\n'), { ...options, type: 'string' });
  if (data.kind !== 'workbook') throw Error('Tipo de registros incompatible.');
  const book = { SheetNames: data.SheetNames, Sheets: data.Sheets, Workbook: { WBProps: { date1904: data.date1904 } } };
  // SheetJS applies the exact same date/format/header options as a normal source.
  for (const sheet of Object.values(book.Sheets)) for (const cell of Object.values(sheet)) {
    if (cell && typeof cell === 'object' && cell.v?.date) cell.v = new Date(cell.v.date);
  }
  const parsed=XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), options);
  for(const name of book.SheetNames)for(const [key,cell]of Object.entries(book.Sheets[name])) {
    if(cell?.w!==undefined && parsed.Sheets[name]?.[key])parsed.Sheets[name][key].w=cell.w;
  }
  const bytes=JSON.stringify(parsed).length;
  if(cacheKey&&bytes<=2*1024*1024){
    while(workbookCacheBytes+bytes>WORKBOOK_CACHE_LIMIT&&workbookCache.size){const first=workbookCache.keys().next().value;workbookCacheBytes-=workbookCache.get(first).bytes;workbookCache.delete(first);}
    workbookCache.set(cacheKey,{book:structuredClone(parsed),bytes});workbookCacheBytes+=bytes;
  }
  return parsed;
}
function save(file, data, provenance = {}) {
  const root = rootFor(file), blob = put(root, data);
  const d = { format: FORMAT, blob, importerVersion: 1, originalName: path.basename(file), ...provenance };
  atomic(descriptorPath(file), JSON.stringify(d));
  return d;
}
function saveWorkbook(file, book) { return save(file, workbookData(book), { savedAt: new Date().toISOString(), origin: 'generated-data' }); }
function importFile(source, destination = source, root) {
  if (root) registerRoot(root);
  const existing = descriptor(source);
  if (existing) {
    load(source);
    if (descriptorPath(source) !== descriptorPath(destination)) atomic(descriptorPath(destination), JSON.stringify(existing));
    return existing;
  }
  const bytes = fs.readFileSync(source);
  const data = /\.txt$/i.test(source)
    ? { kind: 'text', lines: bytes.toString('utf8').split('\n') }
    : workbookData(XLSX.read(bytes, { type: 'buffer', cellNF: true, cellDates: false }));
  const candidate = destination + '.validation-' + crypto.randomUUID();
  try {
  const d = save(candidate, data, { originalName: path.basename(source), sourceHash: hash(bytes), sourceBytes: bytes.length,
    savedAt: new Date().toISOString(), origin: 'imported-data' });
  // Verify actual consumers' row views, including Date values and formatted cells.
  if (data.kind === 'workbook') for (const options of [{ cellDates: true }, { cellDates: false }, { raw: false }]) {
    const before = XLSX.read(bytes, { type: 'buffer', ...options }), after = readWorkbook(candidate, options);
    const rows = book => book.SheetNames.map(name => ({ name,
      raw: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null }),
      formatted: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null, raw: false }) }));
    if (JSON.stringify(rows(before)) !== JSON.stringify(rows(after))) {
      throw Error(`La conversión no conserva los datos de ${path.basename(source)}.`);
    }
  }
  if (data.kind === 'text' && !Buffer.from(data.lines.join('\n')).equals(bytes)) throw Error('El texto fuente no está codificado en UTF-8.');
  atomic(descriptorPath(destination), JSON.stringify(d));
  return d;
  } finally { fs.rmSync(descriptorPath(candidate), { force: true }); }
}
function removeOriginal(file) {
  const d = descriptor(file);
  if (!d) throw Error('No existe una migración validada.');
  load(file);
  if (fs.existsSync(file)) {
    if (!d.sourceHash || hash(fs.readFileSync(file)) !== d.sourceHash) throw Error('El archivo fuente cambió después de migrarlo.');
    fs.unlinkSync(file);
  }
}
function exportData(file) {
  const data = load(file);
  if (!data) return { bytes: fs.readFileSync(file), name: path.basename(file) };
  if (data.kind === 'text') return { bytes: Buffer.from(data.lines.join('\n')), name: path.basename(file).replace(/\.records\.json$/, '') };
  return { bytes: XLSX.write(readWorkbook(file,{cellNF:true}), { type: 'buffer', bookType: 'xlsx', compression: true }),
    name: path.basename(file).replace(/\.records\.json$/, '').replace(/\.(xlsx?|csv)$/i, '') + '.xlsx' };
}
function download(res, file, name) {
  if (!descriptor(file)) {
    let release;try { release=require('./storage-retention').readLease(rootFor(file)); } catch {}
    if(release){res.once('finish',release);res.once('close',release);}
    return res.download(file, name);
  }
  const exported = exportData(file);
  res.attachment(name || exported.name).send(exported.bytes);
}
function middleware(root) {
  return (req,res,next) => {
    try {
      const rel = decodeURIComponent(req.path);
      if (rel.endsWith(suffix) || rel.split('/').some(p=>p.startsWith('.'))) return res.sendStatus(404);
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(path.resolve(root) + path.sep)) return res.sendStatus(404);
      if (!descriptor(file)) return next();
      return download(res, file);
    } catch (error) { return next(error); }
  };
}
// Filesystem adapter only for source consumers; normal JSON and directories use
// native fs. Old metadata URLs/names resolve to internal record descriptors.
const sourceFs = Object.create(fs);
for (const name of ['existsSync','statSync','chmodSync','unlinkSync']) sourceFs[name] = (file,...args) => fs[name](resolve(file),...args);
sourceFs.readFileSync = (file, options) => {
  if (typeof file === 'string' && /\.txt$/i.test(file) && descriptor(file)) {
    const bytes = exportData(file).bytes;
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  }
  return fs.readFileSync(resolve(file), options);
};
sourceFs.rmSync = (file, options) => {
  const resolved = resolve(file);
  fs.rmSync(resolved, options);
  if (resolved !== file && fs.existsSync(file)) fs.rmSync(file, options);
};
for (const name of ['copyFileSync','renameSync']) sourceFs[name] = (source,target,...args) => {
  if (managed(target)) {
    importFile(source,target);
    if (name === 'renameSync') sourceFs.rmSync(source, { force: true });
    return;
  }
  if (descriptor(source)) {
    fs.writeFileSync(target, exportData(source).bytes, { mode: 0o600 });
    if (name === 'renameSync') sourceFs.rmSync(source,{force:true});
    return;
  }
  return fs[name](source,target,...args);
};
function referencedBlobs(root) {
  const refs=new Set();
  const scan=dir=>{
    if(!fs.existsSync(dir))return;
    for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
      if(e.isSymbolicLink())continue;
      const file=path.join(dir,e.name);
      if(e.isDirectory())scan(file);
      else if(file.endsWith(suffix)) { const d=descriptor(file);if(!refs.has(d.blob))load(file);refs.add(d.blob); }
    }
  };
  for(const relative of ['masters','transactions','weeks','.integrations/toteat-api'])scan(path.join(root,relative));
  return refs;
}
function collectGarbage(root,{minimumAgeMs=3600000}={}) {
  if(require('./storage-retention').activeReaders(root)||fs.existsSync(path.join(root,'.storage-maintenance.lock')))return [];
  const base=path.join(root,'.records/blobs');if(!fs.existsSync(base))return [];
  const refs=referencedBlobs(root),removed=[];
  for(const name of fs.readdirSync(base))if(/^[a-f0-9]{64}\.json\.gz$/.test(name)&&!refs.has(name.slice(0,64))) {
    const file=path.join(base,name),stat=fs.statSync(file);
    if(Date.now()-stat.mtimeMs<minimumAgeMs)continue;
    fs.unlinkSync(file);removed.push({blob:name.slice(0,64),bytes:stat.size});
  }
  return removed;
}
module.exports = { referencedBlobs,collectGarbage,registerRoot, managed, descriptorPath, descriptor, resolve, put, load, hash,
  importFile, removeOriginal, readWorkbook, saveWorkbook, exportData, download, middleware, fs: sourceFs };
