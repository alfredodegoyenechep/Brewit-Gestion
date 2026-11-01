const { parentPort, workerData } = require('node:worker_threads');
const { createApp } = require('./server');
const { input, action, uploadsRoot, sourceMode } = workerData;
try {
  const app = createApp({ uploadsRoot, sourceMode, reportToday: input.serverToday, reportCutoff: input.serverCutoff,
    productXrayWorker: false, recurrenceWorker: false, clusterSourceWorker: false, clusterCachePersistence: false,
    enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false });
  const report = app.locals.productXray.read(action, input, (message, step) => parentPort.postMessage({ type: 'progress', message, step }));
  parentPort.postMessage({ type: 'result', report });
} catch (e) { parentPort.postMessage({ error: e.message, status: e.status || 500 }); }
