const { Worker } = require('node:worker_threads');
const path = require('node:path');
function createRecurrenceLoader({ uploadsRoot, sourceMode, today, cutoff }) {
  let worker, sequence = 0;
  const pending = new Map();
  const rejectAll = message => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.release(); entry.reject(Object.assign(new Error(message), { status: 503 })); } pending.clear(); };
  function start() {
    worker = new Worker(path.join(__dirname, 'recurrence-worker.js'), { workerData: { uploadsRoot, sourceMode }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const current = worker;
    worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); entry.release();
      if (message.error) entry.reject(Object.assign(new Error(message.error), { status: message.status })); else entry.resolve(message.result);
      if (!pending.size) current.unref();
    });
    worker.on('error', () => { if (worker === current) { worker = null; rejectAll('La preparación del reporte falló. Vuelve a generar.'); } });
    worker.on('exit', () => { if (worker === current) { worker = null; rejectAll('La preparación del reporte fue interrumpida. Vuelve a generar.'); } });
    worker.unref();
  }
  return { request(action, input, owner) {
    if (!worker) start();
    if (pending.size >= 6) return Promise.reject(Object.assign(new Error('Hay varios reportes en curso. Espera y vuelve a intentar.'), { status: 429 }));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const old = worker; worker = null; rejectAll('El reporte superó el tiempo disponible. Prueba con una cafetería.'); old?.terminate().catch(() => {}); }, 120000);
      timer.unref(); const release = require('./storage-retention').readLease(uploadsRoot);
      pending.set(id, { resolve, reject, timer, release }); worker.ref();
      worker.postMessage({ id, action, input, owner, today: today(), cutoff: cutoff() });
    });
  }, dispose() { rejectAll('El servidor está cerrando.'); worker?.terminate().catch(() => {}); worker = null; } };
}
module.exports = { createRecurrenceLoader };
