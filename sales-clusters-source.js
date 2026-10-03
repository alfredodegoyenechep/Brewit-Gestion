const { Worker } = require('node:worker_threads');
const path = require('node:path');

// A persistent reader reuses the existing sales caches without blocking HTTP on XLSX parsing.
function createClusterSourceLoader({ uploadsRoot, sourceMode, today, workerPath = path.join(__dirname, 'sales-clusters-source-worker.js') }) {
  let worker = null, sequence = 0, disposed = false;
  const requests = new Map();
  function rejectAll(message) {
    for (const entry of requests.values()) { clearTimeout(entry.timer); const error = new Error(message); error.status = 503; entry.reject(error); }
    requests.clear();
  }
  function start() {
    worker = new Worker(workerPath, { workerData: { uploadsRoot, sourceMode }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const current = worker;
    current.on('message', message => {
      const entry = requests.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); requests.delete(message.id);
      if (message.error) { const error = new Error(message.error); error.status = message.status || 500; entry.reject(error); }
      else entry.resolve(message.source);
    });
    current.on('error', () => { if (worker === current) { rejectAll('No se pudieron preparar las ventas para el análisis de clusters.'); worker = null; } });
    current.on('exit', () => { if (worker === current) { worker = null; rejectAll('La preparación de ventas fue interrumpida. Intenta nuevamente.'); } });
    current.unref();
  }
  function load(query) {
    if (disposed) return Promise.reject(new Error('El servicio de clusters se está cerrando.'));
    if (!worker) start();
    if (requests.size >= 6) { const error = new Error('Hay varias consultas de cobertura en curso. Espera antes de iniciar otra.'); error.status = 429; return Promise.reject(error); }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = worker; worker = null;
        rejectAll('La preparación de ventas superó el tiempo disponible. Intenta nuevamente con una cafetería.');
        current?.terminate().catch(() => {});
      }, 120000);
      timer.unref(); requests.set(id, { resolve, reject, timer }); worker.postMessage({ id, query, today: today() });
    });
  }
  function dispose() { disposed = true; rejectAll('La preparación de ventas fue cancelada.'); worker?.terminate().catch(() => {}); worker = null; }
  return { load, dispose };
}
module.exports = { createClusterSourceLoader };
