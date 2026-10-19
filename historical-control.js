// Append-only source evidence. This store deliberately does not use record-store's
// virtual filesystem: an exported workbook is not the original uploaded bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Worker } = require('node:worker_threads');
const { LABELS, extract } = require('./historical-adapters');
const context = new AsyncLocalStorage(), stores = new Map();
const responses = new WeakMap();
const uuid = () => crypto.randomUUID();
const validId = id => /^[a-f0-9-]{36}$/.test(String(id));
const dateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const localDay = time => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date(time));
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(error) { if(error.code==='ENOENT')return fallback;throw error; } };
function atomic(file, bytes, createDirectory = true) {
  if (createDirectory) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + uuid() + '.tmp';
  try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function backupError() { return Object.assign(Error('No se pudo verificar el respaldo original. Se conserva la información vigente; revisa el espacio disponible y reintenta.'), { code: 'HISTORICAL_BACKUP_FAILED' }); }
class History {
  constructor(uploadsRoot) {
    this.uploadsRoot = path.resolve(uploadsRoot); this.root = path.join(this.uploadsRoot, '.historical-control');
    this.queue = Promise.resolve(); this.queued = new Set(); this.active = new Set(); this.sequence = 0;
    fs.mkdirSync(path.join(this.root, 'runs'), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(this.root, 'activation.json'))) atomic(path.join(this.root, 'activation.json'), JSON.stringify({ activatedAt: new Date().toISOString(), schemaVersion: 1 }));
    const existing = this.manifests();
    this.sequence = existing.reduce((n, m) => Math.max(n, m.sequence || 0, m.completionSequence || 0), 0);
    this.cache = new Map(existing.map(m => [m.id, m]));
  }
  directory(id) { if (!validId(id)) throw Object.assign(Error('Identificador inválido.'), { status: 400 }); return path.join(this.root, 'runs', id); }
  load(id) { const run = read(path.join(this.directory(id), 'manifest.json')); if (run && this.cache) this.cache.set(id, run); return run; }
  save(run) { atomic(path.join(this.directory(run.id), 'manifest.json'), JSON.stringify(run), false); this.cache?.set(run.id, run); }
  manifests() {
    if (this.cache) return [...this.cache.values()];
    return fs.readdirSync(path.join(this.root, 'runs')).filter(validId).flatMap(id => { const m = this.load(id); return m ? [m] : []; });
  }
  begin(meta = {}) {
    try {
      const now = new Date().toISOString();
      const run = { id: uuid(), sequence: ++this.sequence, origin: meta.origin || 'manual', location: meta.location || 'shared',
        label: meta.label || null, datasets:meta.datasets || [], startedAt: now, savedAt: now, reception: 'receiving', publication: 'pending', comparison: 'pending', artifacts: [],
        ...(meta.antecedent ? { antecedent: true, originalReceivedAt: meta.originalReceivedAt || null } : {}) };
      if (meta.upstream) run.upstream=Object.fromEntries(['restaurantId','localId'].filter(k=>meta.upstream[k]!=null).map(k=>[k,String(meta.upstream[k])]));
      fs.mkdirSync(this.directory(run.id), { recursive:true, mode:0o700 });
      this.save(run); return run;
    } catch { throw backupError(); }
  }
  capture(runOrId, { bytes, body, name = 'respuesta.json', datasets = [], format = 'json', receivedAt, evidence = 'original', origin }) {
    const run = typeof runOrId === 'string' ? this.load(runOrId) : runOrId;
    if (!run) throw backupError();
    try {
      const raw = bytes !== undefined ? Buffer.from(bytes) : Buffer.from(JSON.stringify(body));
      const artifact = { id: uuid(), name: path.basename(name), format, evidence, origin:origin || run.origin, receivedAt: receivedAt || new Date().toISOString(),
        savedAt: new Date().toISOString(), hash: crypto.createHash('sha256').update(raw).digest('hex'), originalBytes: raw.length, datasets };
      const file = path.join(this.directory(run.id), artifact.id + '.gz');
      atomic(file, zlib.gzipSync(raw));
      if (!zlib.gunzipSync(fs.readFileSync(file)).equals(raw)) throw Error('Integrity');
      artifact.bytes = fs.statSync(file).size;
      // Extraction errors are comparison limitations, never grounds to discard evidence.
      for (const source of datasets) {
        try {
          const extracted=extract(raw, artifact, source);source.recordCount=extracted.count;
          const dates=[...extracted.records,...extracted.ambiguous].map(r=>r.date).filter(Boolean).sort();
          source.receivedRange=dates.length?{from:dates[0],to:dates.at(-1)}:null;
        }
        catch { source.recordCount = null; source.extractionPending = true; }
      }
      run.datasets = [...new Set([...run.datasets,...datasets.map(d=>d.dataset)])];
      run.artifacts.push(artifact); this.save(run); return artifact;
    } catch { throw backupError(); }
  }
  updateCoverage(id, { range, complete = false, warehouse = '*' } = {}) {
    const run = this.load(id); if (!run || run.publication !== 'pending') throw backupError();
    for (const file of run.artifacts) for (const source of file.datasets) { source.range = range; source.complete = complete; source.warehouse = warehouse; }
    this.save(run); return run;
  }
  finish(runOrId, { success = true, error = null, publication = success ? 'published' : 'not-published' } = {}) {
    const run = typeof runOrId === 'string' ? this.load(runOrId) : runOrId;
    if (!run) return;
    run.finishedAt = new Date().toISOString(); run.reception = success ? 'complete' : 'incomplete'; run.publication = publication;
    run.completionSequence = ++this.sequence;
    run.error = error ? (error.code === 'HISTORICAL_BACKUP_FAILED' ? error.message : 'La carga o sincronización no se completó; no se generan alertas históricas.') : null;
    run.comparison = success && !run.antecedent ? 'pending' : 'not-applicable';
    this.save(run);
    if (success && !run.antecedent) {
      for (const pending of this.manifests().filter(r=>r.reception==='complete' && r.comparison==='pending' && r.comparisonError).sort((a,b)=>(a.completionSequence || a.sequence)-(b.completionSequence || b.sequence))) this.enqueue(pending.id);
      this.enqueue(run.id);
    }
    return run.id;
  }
  async track(meta, fn) {
    if (context.getStore()?.history === this) return fn();
    if (!this.bootstrapped) this.bootstrap();
    const run = this.begin(meta);
    const task = context.run({ history: this, run, downloads:new Map() }, async () => {
      try { const result = await fn(run); this.finish(run); return result === undefined ? {historicalRunId:run.id} : result && typeof result === 'object' && !Array.isArray(result) ? { ...result, historicalRunId: run.id } : result; }
      catch (error) { this.finish(run, { success: false, error }); throw error; }
    });
    this.active.add(task);
    try { return await task; } finally { this.active.delete(task); }
  }
  enqueue(id) {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue = this.queue.catch(() => {}).then(() => new Promise(resolve => {
      const worker = new Worker(path.join(__dirname, 'historical-worker.js'), { workerData: { root: this.root, id } });
      let outcome;
      worker.once('message', result => { outcome = result; });
      worker.once('error', () => { outcome = { ok: false }; });
      worker.once('exit', () => {
        try {
          const run = this.load(id);
          if (!outcome?.ok && run) { run.comparison = 'pending'; run.comparisonError = 'Comparación pendiente; se reintentará al reiniciar o en la próxima carga.'; this.save(run); }
        } catch { /* A pending manifest is recoverable; shutdown must still settle. */ }
        finally { this.queued.delete(id); resolve(); }
      });
    }));
  }
  resume() {
    for (const run of this.manifests().sort((a, b) => (a.completionSequence || a.sequence) - (b.completionSequence || b.sequence))) {
      if (run.reception === 'receiving') {
        this.finish(run, { success: false });
      } else if (run.reception === 'complete' && run.comparison === 'pending' && !run.antecedent) this.enqueue(run.id);
    }
  }
  async idle() {
    for (;;) {
      await Promise.allSettled([...this.active]);
      const queued = this.queue; await queued;
      if (!this.active.size && queued === this.queue) return;
    }
  }
  report(id) {
    const run = this.load(id); if (!run || run.comparison !== 'done') return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.directory(id), 'report.json.gz'))));
  }
  latest(location, datasets) {
    return this.manifests().filter(r => r.location === location && (r.datasets?.some(d=>datasets.includes(d)) || r.artifacts.some(a => a.datasets.some(d => datasets.includes(d.dataset)))))
      .sort((a, b) => b.sequence - a.sequence)[0]?.id || null;
  }
  bootstrap() {
    // Re-scan on an unfinished migration. Each evidence item carries its source
    // key so a crash between writing evidence and updating the checkpoint is safe.
    const checkpoint = path.join(this.root, 'migration.json');
    if (!read(checkpoint)?.complete) {
      const imported = new Set(this.manifests().filter(r => r.antecedent && r.reception === 'complete' && r.artifacts.length).map(r => r.migrationKey));
      const records = require('./record-store');
      records.registerRoot(this.uploadsRoot);
      const readableJson = file => { try { return read(file,{}); } catch(error) { if(error instanceof SyntaxError)return {};throw error; } };
      const metadata = new Map();
      const remember = (directory, record, dataset, location) => {
        if (!record || typeof record !== 'object') return;
        if (record.name) metadata.set(path.join(directory,record.name), { ...record, dataset, location });
        for (const part of record.parts || []) remember(directory,part,dataset,location);
      };
      const indexes = directory => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(directory,entry.name);
          if (entry.isDirectory()) indexes(file);
          else if (entry.name === 'index.json' || entry.name === 'meta.json') {
            const index=readableJson(file);
            for (const [field,source] of Object.entries(index.fields || index.files || {})) for(const record of source.files || [source]) remember(directory,record,field,index.location || path.basename(directory));
          } else if(entry.name==='masters.json') {
            for (const group of Object.values(readableJson(file))) for(const [field,record] of Object.entries(group)) remember(directory,record,field,'shared');
          }
        }
      };
      for(const directory of ['transactions','masters','weeks','trash/locations']) indexes(path.join(this.uploadsRoot,directory));
      const walk = dir => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;
          const file = path.join(dir, e.name);
          if (e.isDirectory()) walk(file);
          else if (/\.(xlsx?|csv|txt)(\.records\.json)?$/i.test(e.name) || ['original.json', 'state.json', 'normalized.json'].includes(e.name)) {
            const relative = path.relative(this.uploadsRoot, file);
            const key = crypto.createHash('sha256').update(relative).digest('hex');
            if (imported.has(key)) continue;
            if (e.name.endsWith('.records.json') && fs.existsSync(file.slice(0,-'.records.json'.length))) continue;
            const parts = relative.split(path.sep), integrated = parts[0] === '.integrations';
            const sourceMeta = metadata.get(file.replace(/\.records\.json$/,''));
            const location = sourceMeta?.location || (integrated ? parts[3] : parts[0] === 'masters' ? 'shared' : parts[0] === 'weeks' ? parts[2] : parts[1]);
            const dataset = sourceMeta?.dataset || (integrated ? ({'original-counts':'counts',masters:'master-catalog',stock:'kardex'}[parts[2]] || parts[2])
              : Object.keys(LABELS).sort((a,b)=>b.length-a.length).find(k => e.name.startsWith(k)) || null);
            const knownDate = sourceMeta?.savedAt || (e.name.endsWith('.json') && !e.name.endsWith('.records.json') ? readableJson(file).capturedAt : null);
            const originalReceivedAt = knownDate && Number.isFinite(Date.parse(knownDate)) ? knownDate : null;
            const run = this.begin({ origin: 'legacy', location: location || 'shared', antecedent: true, originalReceivedAt });
            run.migrationKey = key; this.save(run);
            let bytes, name = sourceMeta?.originalName || e.name, evidence = integrated && /\.(xlsx?|csv|txt)$/i.test(e.name) ? 'reconstruction' : 'original';
            if (e.name.endsWith('.records.json')) {
              try { const exported = records.exportData(file.slice(0, -'.records.json'.length)); bytes = exported.bytes; name = exported.name; evidence = 'reconstruction'; }
              catch { bytes=fs.readFileSync(file);name=e.name;evidence='incomplete'; }
            }
            else if (['state.json','normalized.json'].includes(e.name)) {
              try {
                const state = read(file);
                bytes = Buffer.from(JSON.stringify(state.batches ? { batches:state.batches, receiptSource:state.receiptSource } : state));
                evidence = 'reconstruction';
              } catch(error) { if(!(error instanceof SyntaxError))throw error;bytes=fs.readFileSync(file);evidence='incomplete'; }
            } else bytes = fs.readFileSync(file);
            this.capture(run, { bytes, name, evidence, format: name.endsWith('.json') ? 'json' : 'file', datasets: dataset ? [{dataset,location:run.location,complete:false,range:sourceMeta?.confirmedRange || sourceMeta?.detectedRange || null,validFrom:sourceMeta?.validFrom || null}] : [] });
            this.finish(run, { publication: 'antecedent' }); imported.add(key);
          }
        }
      };
      for (const relative of ['transactions', 'masters', 'weeks', 'trash/locations', '.integrations/toteat-api/sales', '.integrations/toteat-api/purchases', '.integrations/toteat-api/masters', '.integrations/toteat-api/stock', '.integrations/toteat-api/original-counts']) walk(path.join(this.uploadsRoot, relative));
      atomic(checkpoint, JSON.stringify({ complete: true, finishedAt: new Date().toISOString() }));
    }
    this.resume();
    this.bootstrapped = true;
  }
  storage(date) {
    const files = [], runs = this.manifests(), known = new Map();
    const add = (file, savedAt, meta) => { known.set(file, { ...meta, savedAt }); };
    for (const run of runs) {
      const dir = this.directory(run.id);
      for (const artifact of run.artifacts) add(path.join(dir, artifact.id + '.gz'), artifact.savedAt, { runId: run.id, artifactId: artifact.id, name: artifact.name + '.gz', kind: 'original', datasets: artifact.datasets.map(d => d.dataset) });
      add(path.join(dir, 'manifest.json'), run.savedAt, { runId: run.id, name: 'manifest.json', kind: 'metadata' });
      for (const name of ['report.json.gz', 'state.json.gz']) add(path.join(dir, name), run.comparedAt, { runId: run.id, name, kind: name.startsWith('report') ? 'report' : 'comparison-state' });
    }
    const activation = read(path.join(this.root, 'activation.json'));
    for (const name of ['activation.json', 'migration.json']) {
      const file = path.join(this.root, name); if (fs.existsSync(file)) add(file, fs.statSync(file).mtime.toISOString(), { name, kind: 'metadata' });
    }
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else {
          const stat = fs.statSync(file), meta = known.get(file) || { name:entry.name, kind:'unregistered-evidence' };
          const savedAt = meta.savedAt || stat.mtime.toISOString();
          files.push({...meta, savedAt, date:localDay(savedAt), bytes:stat.size});
        }
      }
    };
    walk(this.root);
    const selected = files.filter(f => f.date === date), through = files.filter(f => f.date <= date), from = localDay(activation.activatedAt);
    const days = Math.max(0, Math.round((Date.parse(date) - Date.parse(from)) / 86400000) + 1), totalBytes = through.reduce((n, f) => n + f.bytes, 0);
    const dailyBytes = selected.reduce((n, f) => n + f.bytes, 0), averageDailyBytes = days ? totalBytes / days : 0;
    return { date, files: selected, fileCount: selected.length, dailyBytes, totalBytes, currentBytes: files.reduce((n, f) => n + f.bytes, 0),
      averageDailyBytes, estimatedMonthlyBytes: averageDailyBytes * new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0).getDate(),
      averagePeriod: { from, to: date, days }, units: 'decimal', formula: 'Bytes acumulados / días calendario transcurridos; estimación = promedio × días del mes' };
  }
}
function get(root) { const key = path.resolve(root); if (!stores.has(key)) stores.set(key, new History(key)); return stores.get(key); }
function captureCurrent(options) { const active = context.getStore(); return active ? active.history.capture(active.run, options) : null; }
async function responseBody(response, options) {
  if (!context.getStore()) return response.json();
  let bytes, body;
  if (typeof response.body === 'function') { bytes = await response.body(); }
  else if (typeof response.text === 'function') { bytes = Buffer.from(await response.text()); }
  else { body = await response.json(); bytes = Buffer.from(JSON.stringify(body)); }
  const artifact = captureCurrent({ ...options, bytes });
  if (body === undefined) body = JSON.parse(bytes);
  if (body && typeof body === 'object' && artifact) responses.set(body, artifact);
  return body;
}
function captureFileCurrent(file, options = {}) {
  const active = context.getStore(); if (!active) return;
  const key = path.resolve(file), prior = active.downloads.get(key);
  if (prior) {
    if (options.datasets?.length && !prior.datasets.length) { prior.datasets=options.datasets; active.history.save(active.run); }
    return prior;
  }
  const artifact = captureCurrent({ ...options, bytes:fs.readFileSync(file), name:options.name || path.basename(file), format:'file' });
  active.downloads.set(key, artifact); return artifact;
}
function annotate(body, datasets, name = 'respuesta.json') {
  const active = context.getStore(); if (!active) return;
  const artifact = responses.get(body);
  if (artifact && active.run.artifacts.includes(artifact)) {
    for (const source of datasets) {
      let selected = body;
      for (const key of (source.selector || '').split('.').filter(Boolean)) selected = selected?.[key];
      source.recordCount = Array.isArray(selected) ? selected.length : selected ? 1 : 0;
    }
    artifact.datasets.push(...datasets); active.history.save(active.run); return artifact;
  }
  return captureCurrent({ body, datasets, name });
}
function snapshot(source, descriptors) {
  const active = context.getStore(); if (!active) return;
  // Injected/custom readers return original source objects instead of network
  // responses. Preserve those too, before operational normalization.
  const existing = new Set(active.run.artifacts.flatMap(a => a.datasets.map(d => d.dataset)));
  const missing = descriptors.filter(d => !existing.has(d.dataset));
  if (missing.length) return captureCurrent({ body: source, name: 'fuentes-originales.json', datasets: missing });
}
function register(app, history, presentationOptions = {}) {
  const base = '/api/historical-control';
  const wrap = fn => (req, res, next) => { try { fn(req, res); } catch (e) { if(e.status)return res.status(e.status).json({error:e.message});next(e); } };
  const filtered = query => history.manifests().filter(r => (!query.date || localDay(r.startedAt) === query.date)
    && (!query.origin || r.origin === query.origin || r.artifacts.some(a=>a.origin===query.origin)) && (!query.location || r.location === query.location || r.artifacts.some(a => a.datasets.some(d => d.location === query.location)))
    && (!query.dataset || r.datasets?.includes(query.dataset) || r.artifacts.some(a => a.datasets.some(d => d.dataset === query.dataset)))
    && (!query.warehouse || r.summaries?.some(s=>s.warehouse===query.warehouse || s.warehouses?.includes(query.warehouse)) || r.artifacts.some(a=>a.datasets.some(d=>d.warehouse===query.warehouse))));
  app.get(base + '/options', wrap((req, res) => {
    const runs = history.manifests();
    res.json({ today: localDay(new Date()), datasets: LABELS, origins: [...new Set(runs.flatMap(r => [r.origin,...r.artifacts.map(a=>a.origin || r.origin)]))],
      warehouses:[...new Set(runs.flatMap(r=>(r.summaries || []).flatMap(s=>s.warehouses || [])))],
      warehouseLabels:Object.assign({},...runs.flatMap(r=>(r.summaries || []).map(s=>s.warehouseNames || {}))),
      locations: [...new Set(runs.flatMap(r => [r.location, ...r.artifacts.flatMap(a => a.datasets.map(d => d.location).filter(Boolean))]))] });
  }));
  app.get(base + '/runs', wrap((req, res) => {
    if (req.query.date && !dateKey(req.query.date)) return res.status(400).json({ error: 'Fecha inválida.' });
    const runs = filtered(req.query).sort((a, b) => b.sequence - a.sequence), offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    res.json({ total: runs.length, runs: runs.slice(offset, offset + limit) });
  }));
  app.get(base + '/storage', wrap((req, res) => {
    const date = req.query.date || localDay(new Date()); if (!dateKey(date)) return res.status(400).json({ error: 'Fecha inválida.' });
    res.json(history.storage(date));
  }));
  app.get(base + '/alerts', wrap((req,res) => {
    const date=req.query.date || localDay(new Date()), dateTo=req.query.dateTo || date;
    if(!dateKey(date) || !dateKey(dateTo) || date>dateTo)return res.status(400).json({error:'Selecciona un período de detección válido.'});
    if(req.query.type && !['modified','deleted','historicalAdded','review'].includes(req.query.type))return res.status(400).json({error:'Tipo de alerta inválido.'});
    const alerts=require('./historical-alerts'),report=alerts.collect(history,{...req.query,date,dateTo});
    res.set('Cache-Control','no-store');
    if(req.query.format==='csv') {
      const registry=read(path.join(history.uploadsRoot,'config','locations.json'),{locations:[]});
      const locations=Object.fromEntries((registry.locations || []).map(l=>[l.id,l.name]));
      return res.attachment(`alertas-historicas-${date}-${dateTo}.csv`).type('text/csv; charset=utf-8').send(alerts.csv(report,{locations}));
    }
    const offset=Math.max(0,Math.floor(Number(req.query.offset)||0)),limit=Math.min(100,Math.max(1,Math.floor(Number(req.query.limit)||30)));
    const present=require('./historical-change-presentation').presenter(history,presentationOptions);
    res.json({...report,total:report.alerts.length,alerts:report.alerts.slice(offset,offset+limit).map(present)});
  }));
  app.get(base + '/runs/:id', wrap((req, res) => { const run = history.load(req.params.id); return run ? res.json(run) : res.sendStatus(404); }));
  app.get(base + '/runs/:id/changes', wrap((req, res) => {
    const run = history.load(req.params.id); if (!run) return res.sendStatus(404);
    const report = history.report(run.id); if (!report) return res.json({ status: run.comparison, changes: [], total: 0 });
    const sources = report.sources.filter(s => (!req.query.dataset || s.dataset === req.query.dataset) && (!req.query.location || s.location === req.query.location));
    const changes = sources.flatMap(s => [...s.changes.map(c => ({ ...c, sourceKey:s.key, dataset: s.dataset, location: s.location })), ...s.ambiguous.map(c => ({ ...c, type: 'ambiguous', dataset: s.dataset, location: s.location }))])
      .filter(c=>!req.query.warehouse || c.warehouses?.includes(req.query.warehouse) || c.warehouse===req.query.warehouse);
    const offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const present=require('./historical-change-presentation').presenter(history,presentationOptions);
    res.json({ status: 'done', total: changes.length, changes: changes.slice(offset, offset + limit).map(present), sources: sources.map(({ changes, ambiguous, ...s }) => s) });
  }));
  app.get(base + '/runs/:id/files/:fileId/download', wrap((req, res) => {
    const run = history.load(req.params.id), file = run?.artifacts.find(a => a.id === req.params.fileId); if (!file) return res.sendStatus(404);
    const bytes = zlib.gunzipSync(fs.readFileSync(path.join(history.directory(run.id), file.id + '.gz')));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.hash) return res.status(409).json({ error: 'El archivo no superó la verificación de integridad.' });
    res.attachment(file.name).send(bytes);
  }));
  app.get(base + '/runs/:id/report', wrap((req, res) => {
    const report = history.report(req.params.id); if (!report) return res.sendStatus(404);
    res.attachment(`control-historico-${req.params.id}.json`).json(report);
  }));
}
module.exports = { get, History, context, captureCurrent, captureFileCurrent, responseBody, annotate, snapshot, register, localDay, dateKey };
