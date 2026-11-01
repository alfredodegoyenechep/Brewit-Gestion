'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const { Worker } = require('node:worker_threads');
const { period } = require('./board-report');
function register(app, config) {
  const root = path.join(config.uploadsRoot, 'board-reports'), jobs = new Map(), queue = []; let active = null, closed = false;
  fs.mkdirSync(root, { recursive: true });
  const validId = id => /^[0-9a-f-]{36}$/.test(id);
  const archive = id => { if (!validId(id)) throw Object.assign(Error('Versión no válida.'), { status: 400 }); return path.join(root, id); };
  const read = id => { const file = path.join(archive(id), 'report.json'); if (!fs.existsSync(file)) throw Object.assign(Error('No se encontró la versión.'), { status: 404 }); return JSON.parse(fs.readFileSync(file, 'utf8')); };
  const clean = job => { clearTimeout(job.timer); job.release?.(); delete job.release; delete job.timer; if (job.worker) { job.worker.terminate().catch(() => {}); delete job.worker; } };
  const publicJob = job => { const { worker, release, timer, ...result } = job; return result; };
  const run = () => {
    if (active || closed) return;
    const job = queue.shift(); if (!job) return; if (job.status !== 'queued') return run();
    active = job; job.status = 'running'; job.startedAt = new Date().toISOString();
    const finish = (error, reportId) => {
      if (active !== job) return;
      clean(job); job.finishedAt = new Date().toISOString();
      if (job.status !== 'cancelled') { job.status = error ? 'failed' : 'complete'; job.error = error?.message; job.reportId = reportId; if (!error) job.progress = 100; }
      active = null; run();
    };
    try {
      job.release = require('./storage-retention').readLease(config.uploadsRoot);
      job.worker = new Worker(path.join(__dirname, 'board-report-worker.js'), { workerData: { uploadsRoot: config.uploadsRoot, sourceMode: config.sourceMode, id: job.id, month: job.month, today: config.today(), cutoff: config.cutoff() }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
      job.timer = setTimeout(() => finish(Error('Se excedió el tiempo máximo del cierre (30 minutos).')), 30 * 60000);
      job.worker.on('message', msg => { if (msg.type === 'progress') { job.message = msg.message; job.progress = Math.max(job.progress, Math.min(99, msg.progress)); } else finish(msg.error ? Error(msg.error) : null, msg.reportId); });
      job.worker.on('error', finish); job.worker.on('exit', code => { if (active === job) finish(Error(`El proceso de cierre terminó sin publicar una versión (${code}).`)); });
    } catch (e) { finish(e); }
  };
  const route = fn => async (req, res) => { res.set('Cache-Control', 'no-store'); try { await fn(req, res); } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); } };
  app.get('/api/board-reports/options', route((req, res) => res.json(config.source.options())));
  app.post('/api/board-reports/jobs', route((req, res) => {
    const p = period(req.body?.month); if (p.from > config.today()) throw Object.assign(Error('No puedes generar un mes futuro.'), { status: 400 });
    if (queue.length >= 10) throw Object.assign(Error('Hay diez cierres en espera. Intenta cuando termine alguno.'), { status: 429 });
    const job = { id: crypto.randomUUID(), month: p.month, status: 'queued', progress: 0, message: 'En cola', createdAt: new Date().toISOString() };
    jobs.set(job.id, job); queue.push(job); run(); res.status(202).json(publicJob(job));
  }));
  app.get('/api/board-reports/jobs/:id', route((req, res) => { const job = jobs.get(req.params.id); if (!job) throw Object.assign(Error('No se encontró el proceso.'), { status: 404 }); res.json(publicJob(job)); }));
  app.delete('/api/board-reports/jobs/:id', route(async (req, res) => {
    const job = jobs.get(req.params.id); if (!job) throw Object.assign(Error('No se encontró el proceso.'), { status: 404 });
    if (['complete', 'failed', 'cancelled'].includes(job.status)) return res.json(publicJob(job));
    // A committed immutable version cannot be removed by a late cancellation.
    if (fs.existsSync(path.join(archive(job.id), 'report.json'))) { job.status = 'complete'; job.reportId = job.id; return res.json(publicJob(job)); }
    job.status = 'cancelled'; job.finishedAt = new Date().toISOString();
    const worker = job.worker; if (worker) await worker.terminate();
    clean(job);
    if (fs.existsSync(path.join(archive(job.id), 'report.json'))) { job.status = 'complete'; job.reportId = job.id; job.progress = 100; }
    else fs.rmSync(path.join(root, `.pending-${job.id}`), { recursive: true, force: true });
    if (active === job) active = null; run(); res.json(publicJob(job));
  }));
  app.get('/api/board-reports', route((req, res) => {
    if (req.query.month) period(req.query.month);
    const versions = fs.readdirSync(root).filter(validId).flatMap(id => { try { const r = read(id); return !req.query.month || r.month === req.query.month ? [{ id, month: r.month, createdAt: r.generatedAt, pages: r.expectedPages, locations: r.locations, sourceVersion: r.sourceVersion }] : []; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    res.json({ versions, jobs: [...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).map(publicJob) });
  }));
  app.get('/api/board-reports/:id/export', route((req, res) => {
    const format = req.query.format; if (!['pdf', 'pptx'].includes(format)) throw Object.assign(Error('Formato no válido.'), { status: 400 });
    const report = read(req.params.id), file = path.join(archive(report.id), `presentation.${format}`);
    if (!fs.existsSync(file)) throw Object.assign(Error('El archivo de esta versión no está disponible.'), { status: 404 });
    res.download(file, `Brewit-Directorio-${report.month}-${report.id.slice(0, 8)}.${format}`);
  }));
  app.get('/api/board-reports/:id', route((req, res) => res.json(read(req.params.id))));
  return { dispose() { closed = true; for (const job of jobs.values()) if (['running', 'queued'].includes(job.status)) { job.status = 'cancelled'; clean(job); } queue.length = 0; active = null; } };
}
module.exports = { register };
