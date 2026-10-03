const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { normalizeConfig, VERSION } = require('./sales-clusters');

const TTL = 24 * 60 * 60 * 1000;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function failure(message, status) { const error = new Error(message); error.status = status; throw error; }

function createClusterJobs({ workerPath = path.join(__dirname, 'sales-clusters-worker.js'), maximumMs = 185000, ttlMs = TTL, storageRoot } = {}) {
  const jobs = new Map(), cache = new Map(), queue = [];
  const registry = new Map();
  let running = null, disposed = false;
  function writeAtomic(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file);
  }
  if (storageRoot) {
    fs.mkdirSync(storageRoot, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(storageRoot, 'index.json'), 'utf8'));
      for (const record of saved) if (/^[a-f0-9-]{36}$/.test(record.id)) {
        if (Date.now() - record.updatedAt <= ttlMs) { registry.set(record.id, record); cache.set(record.cacheKey, record.id); }
        else { try { fs.unlinkSync(path.join(storageRoot, `${record.id}.json`)); } catch { /* Expired files may already be removed. */ } }
      }
    } catch { /* The first launch has no cache index. */ }
  }
  function persist(job) {
    if (!storageRoot || job.status !== 'completed') return;
    try {
      const record = { id: job.id, owner: job.owner, cacheKey: job.cacheKey, updatedAt: job.updatedAt };
      const snapshot = { ...record, input: job.input, mode: job.mode, createdAt: job.createdAt, status: job.status,
        progress: job.progress, message: job.message, output: job.output, persisted: true };
      writeAtomic(path.join(storageRoot, `${job.id}.json`), snapshot);
      registry.set(job.id, record); job.persisted = true;
      writeAtomic(path.join(storageRoot, 'index.json'), [...registry.values()]);
    } catch {
      job.output.result.warnings ||= [];
      job.output.result.warnings.push('No se pudo conservar este resultado en disco; estará disponible mientras el servidor siga activo.');
    }
  }
  function prune() {
    const now = Date.now();
    for (const [id, record] of registry) if (now - record.updatedAt > ttlMs) {
      registry.delete(id); if (cache.get(record.cacheKey) === id) cache.delete(record.cacheKey);
      try { fs.unlinkSync(path.join(storageRoot, `${id}.json`)); } catch { /* A previously removed cache file is harmless. */ }
    }
    for (const [id, job] of jobs) if (!['running', 'queued'].includes(job.status) && now - job.updatedAt > ttlMs) { jobs.delete(id); if (cache.get(job.cacheKey) === id) cache.delete(job.cacheKey); }
    // Bound retained snapshots in addition to TTL. Active jobs and their lineage are kept.
    const protectedIds = new Set([...jobs.values()].filter(j => ['running', 'queued'].includes(j.status)).flatMap(j => [j.id, j.input.parent?.jobId, j.input.referenceJobId]));
    for (const [id, job] of jobs) {
      if (jobs.size <= 24) break;
      if (!protectedIds.has(id) && !['running', 'queued'].includes(job.status)) { jobs.delete(id); if (!job.persisted && cache.get(job.cacheKey) === id) cache.delete(job.cacheKey); }
    }
  }
  function get(id, owner = 'local') {
    prune();
    let job = jobs.get(id);
    const record = registry.get(id);
    if (!job && record?.owner === owner) {
      try { job = JSON.parse(fs.readFileSync(path.join(storageRoot, `${record.id}.json`), 'utf8')); jobs.set(id, job); }
      catch { registry.delete(id); }
    }
    if (!job || job.owner !== owner) failure('El cálculo no existe o venció. Calcula nuevamente los clusters.', 404);
    return job;
  }
  function publicJob(job) {
    return { id: job.id, status: job.status, mode: job.mode, progress: job.progress, message: job.message,
      error: job.error || null, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(),
      expiresAt: new Date(job.updatedAt + ttlMs).toISOString(), sourceFingerprint: job.input.sourceFingerprint,
      parameters: job.input.config.parameters, customParameters: job.input.config.customParameters,
      resultAvailable: job.status === 'completed' };
  }
  function launchNext() {
    if (running || disposed) return;
    const job = queue.shift();
    if (!job) return;
    running = job; job.status = 'running'; job.message = 'Iniciando cálculo.'; job.updatedAt = Date.now();
    const worker = new Worker(workerPath, { workerData: { input: job.input, mode: job.mode, reference: job.reference },
      resourceLimits: { maxOldGenerationSizeMb: 512 } });
    job.worker = worker;
    let finished = false;
    const finish = (status, output, error) => {
      if (finished) return;
      finished = true; clearTimeout(job.timer);
      job.status = status; job.output = output || null; job.error = error || null; job.updatedAt = Date.now();
      job.progress = status === 'completed' ? 100 : job.progress;
      job.message = status === 'completed' ? output.result.message : error || 'Cálculo cancelado.';
      delete job.provisional; delete job.reference; delete job.worker;
      persist(job);
      worker.terminate().catch(() => {});
      if (running === job) running = null;
      launchNext();
    };
    job.finish = finish;
    worker.on('message', message => {
      if (finished) return;
      if (message.type === 'progress') {
        job.progress = message.update.percent; job.message = message.update.message; job.updatedAt = Date.now();
        if (message.update.provisional) job.provisional = message.update.provisional;
      } else if (message.type === 'complete') finish('completed', message.output);
      else if (message.type === 'failed') finish('failed', null, message.error);
    });
    worker.on('error', error => finish('failed', null, error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'El cálculo superó la memoria disponible. Reduce el período o el detalle.' : 'No se pudo completar el cálculo de clusters.'));
    worker.on('exit', code => { if (!finished) finish('failed', null, `El cálculo terminó antes de completar el resultado (${code}).`); });
    worker.unref();
    job.timer = setTimeout(() => {
      if (job.provisional) {
        job.provisional.result.message = 'Se alcanzó el límite de tres minutos. Resultado exploratorio con validación incompleta.';
        job.provisional.result.warnings.push(job.provisional.result.message);
        finish('completed', job.provisional);
      } else finish('failed', null, 'Se alcanzó el límite de cálculo sin obtener una agrupación. Reduce el período o el detalle.');
    }, maximumMs);
    job.timer.unref();
  }
  function submit(input, owner = 'local', mode = 'analysis', reference = null) {
    if (disposed) failure('El servicio de clusters se está cerrando.', 503);
    prune();
    input = { ...input, config: normalizeConfig(input.config) };
    if (input.depth > 3) failure('La profundización admite hasta tres niveles.', 400);
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify(stable({ version: VERSION, owner, mode,
      source: input.sourceFingerprint, config: input.config, period: input.period, parent: input.parent,
      referenceJobId: input.referenceJobId, seed: input.seed }))).digest('hex');
    let cached = jobs.get(cache.get(cacheKey));
    if (!cached && registry.has(cache.get(cacheKey))) {
      try { cached = get(cache.get(cacheKey), owner); } catch { /* Recompute an unavailable disk snapshot. */ }
    }
    if (cached && ['queued', 'running', 'completed'].includes(cached.status)) return { ...publicJob(cached), cached: true };
    if (running && queue.length >= 2) failure('Ya hay un cálculo activo y dos en espera. Espera o cancela uno antes de iniciar otro.', 429);
    const now = Date.now(), job = { id: crypto.randomUUID(), owner, input, mode, reference, cacheKey,
      createdAt: now, updatedAt: now, status: 'queued', progress: 0, message: 'Cálculo en espera.' };
    jobs.set(job.id, job); cache.set(cacheKey, job.id); queue.push(job); launchNext();
    return publicJob(job);
  }
  function cancel(id, owner) {
    const job = get(id, owner);
    if (job.status === 'running') job.finish('cancelled');
    else if (job.status === 'queued') { queue.splice(queue.indexOf(job), 1); job.status = 'cancelled'; job.message = 'Cálculo cancelado.'; job.updatedAt = Date.now(); }
    return publicJob(job);
  }
  function result(id, owner) {
    const job = get(id, owner);
    if (job.status !== 'completed') failure(job.error || 'El resultado todavía no está disponible.', job.status === 'failed' ? 422 : 409);
    return job;
  }
  function dispose() {
    disposed = true;
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      if (job.worker) job.worker.terminate().catch(() => {});
    }
    queue.length = 0; jobs.clear(); cache.clear(); running = null;
  }
  return { submit, get, result, cancel, publicJob, dispose };
}

module.exports = { createClusterJobs, stable, TTL };
