const { Worker } = require('node:worker_threads');
const path = require('node:path');
function register(app, config) {
  const active = new Set();
  const run = action => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (active.size >= 2) return res.status(429).json({ error: 'Hay reportes en preparación. Espera y vuelve a intentar.' });
    let worker, timer, release, completed = false;
    const clean = () => { clearTimeout(timer); release?.(); release = null; if (worker) { active.delete(worker); worker.terminate().catch(() => {}); worker = null; } };
    const finish = (error, data) => {
      if (completed) return; completed = true; clean(); if (res.destroyed) return;
      if (error) res.status(error.status || 500).json({ error: error.message }); else res.json(data);
    };
    res.on('close', () => { completed = true; clean(); });
    try {
      const input = { ...req.query, serverToday: config.today(), serverCutoff: config.cutoff() };
      if (config.local) return finish(null, config.read(action, input));
      release = require('./storage-retention').readLease(config.uploadsRoot);
      worker = new Worker(path.join(__dirname, 'product-timeline-worker.js'), {
        workerData: { action, input, uploadsRoot: config.uploadsRoot, sourceMode: config.sourceMode }, resourceLimits: { maxOldGenerationSizeMb: 768 }
      });
      active.add(worker);
      timer = setTimeout(() => finish(Object.assign(new Error('El reporte tardó demasiado. Prueba con menos productos o un período más breve.'), { status: 503 })), 180000);
      worker.on('message', message => finish(message.error ? Object.assign(new Error(message.error), { status: message.status }) : null, message.report));
      worker.on('error', error => finish(error));
      worker.on('exit', () => { if (!completed) finish(new Error('La generación fue interrumpida. Vuelve a intentar.')); });
    } catch (error) { finish(error); }
  };
  app.get('/api/sales/product-timeline/options', run('options'));
  app.get('/api/sales/product-timeline', run('report'));
  app.get('/api/sales/product-hourly', run('product-hourly'));
  app.get('/api/sales/daily-distribution/options', run('options'));
  app.get('/api/sales/daily-distribution', run('weekday-report'));
  return { dispose() { for (const worker of active) worker.terminate().catch(() => {}); active.clear(); } };
}
module.exports = { register };
