const { Worker } = require('node:worker_threads');
const http = require('node:http');
const path = require('node:path');

function registerReportWorkerProxy(app, { uploadsRoot, sourceMode, reportToday, projectionToday }) {
  let active = null;
  let pending = null;
  const launch = (req, res) => {
    const worker = new Worker(path.join(__dirname, 'report-worker.js'), { workerData: { uploadsRoot, sourceMode, reportToday, projectionToday } });
    const job = { worker, request: null };
    active = job;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      job.request?.destroy();
      worker.terminate().catch(() => {});
      if (active === job) {
        active = null;
        if (pending) {
          const next = pending;
          pending = null;
          if (!next.res.destroyed) launch(next.req, next.res);
        }
      }
    };
    const fail = message => { if (!res.headersSent) res.status(503).json({ error: message }); else res.destroy();cleanup(); };
    const timer = setTimeout(() => fail('El cálculo superó el tiempo máximo. Vuelve a consultar.'), 120000);
    res.once('close', cleanup);
    worker.once('message', ({ port }) => {
      if (finished) return;
      const request = http.get({ hostname: '127.0.0.1', port, path: req.originalUrl,
        headers: { accept: req.headers.accept || 'application/json' } }, response => {
        if (finished) { response.destroy(); return; }
        res.status(response.statusCode || 500);
        if (response.headers['content-type']) res.set('Content-Type', response.headers['content-type']);
        if (response.headers['cache-control']) res.set('Cache-Control', response.headers['cache-control']);
        response.pipe(res);
      });
      job.request = request;
      request.once('error', () => { if (!finished) fail('No se pudo completar el cálculo aislado. Vuelve a consultar.'); });
    });
    worker.once('error', () => { if (!finished) fail('No se pudo iniciar el cálculo aislado. Vuelve a consultar.'); });
    worker.once('exit', code => { if (!finished) fail(`El cálculo aislado terminó antes de entregar resultados (${code}).`); });
  };
  for (const route of ['/api/financial-results', '/api/ingredients', '/api/purchase-projections']) app.get(route, (req, res) => {
    if (!active) return launch(req, res);
    if (pending) return res.status(503).json({ error: 'Hay dos cálculos pendientes. Espera a que termine uno antes de consultar otro informe.' });
    pending = { req, res };
    res.once('close', () => { if (pending?.res === res) pending = null; });
  });
}

module.exports = { registerReportWorkerProxy };
