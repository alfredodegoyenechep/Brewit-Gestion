const { Worker } = require('node:worker_threads');
const path = require('node:path');
function register(app, config) {
  const active = new Set();
  const run = action => async (req, res) => {
    const streaming = action === 'report' && req.query.progress === '1';
    let worker, timer, release, completed = false;
    const clean = () => { clearTimeout(timer); release?.(); release = null; if (worker) { active.delete(worker); worker.terminate().catch(() => {}); worker = null; } };
    const write = data => { if (!res.destroyed) res.write(`${JSON.stringify(data)}\n`); };
    const progress = (message, step) => { if (streaming) write({ type: 'progress', message, step, steps: 4 }); };
    const finish = (error, report) => {
      if (completed) return; completed = true; clean(); if (res.destroyed) return;
      if (streaming) { write(error ? { type: 'error', error: error.message, status: error.status || 500 } : { type: 'result', report }); res.end(); }
      else if (error) res.status(error.status || 500).json({ error: error.message });
      else res.json(report);
    };
    res.set('Cache-Control', 'no-store');
    if (active.size >= 2) return res.status(429).json({ error: 'Hay fichas en preparación. Espera y vuelve a intentar.' });
    if (streaming) { res.set('Content-Type', 'application/x-ndjson'); res.flushHeaders(); }
    res.on('close', () => { completed = true; clean(); });
    try {
      const input = { ...req.query, serverToday: config.today(), serverCutoff: config.cutoff() };
      if (action === 'version') return finish(null, { sourceVersion: config.fingerprint(input) });
      if (config.local) return finish(null, await config.read(action, input, progress));
      release = require('./storage-retention').readLease(config.uploadsRoot);
      worker = new Worker(path.join(__dirname, 'product-xray-worker.js'), { workerData: { uploadsRoot: config.uploadsRoot, sourceMode: config.sourceMode, action, input }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
      active.add(worker);
      timer = setTimeout(() => finish(Object.assign(new Error('El informe excedió el tiempo disponible. Prueba con una cafetería o una jerarquía.'), { status: 503 })), 900000);
      worker.on('message', m => m.type === 'progress' ? progress(m.message, m.step) : finish(m.error ? Object.assign(new Error(m.error), { status: m.status }) : null, m.report));
      worker.on('error', e => finish(e)); worker.on('exit', () => { if (!completed) finish(new Error('La preparación de la ficha fue interrumpida.')); });
    } catch (e) { finish(e); }
  };
  app.get('/api/sales/product-xray/options', run('options'));
  app.get('/api/sales/product-xray/version', run('version'));
  app.get('/api/sales/product-xray', run('report'));
  return { dispose() { for (const worker of active) worker.terminate().catch(() => {}); active.clear(); } };
}
module.exports = { register };
