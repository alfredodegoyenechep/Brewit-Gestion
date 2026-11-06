const { parentPort, workerData } = require('node:worker_threads');
try {
  const { input, action, uploadsRoot, sourceMode } = workerData;
  const app = require('./server').createApp({ uploadsRoot, sourceMode, reportToday: input.serverToday, reportCutoff: input.serverCutoff,
    productTimelineWorker: false, productXrayWorker: false, recurrenceWorker: false, clusterSourceWorker: false,
    clusterCachePersistence: false, enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false });
  parentPort.postMessage({ report: app.locals.productTimeline.read(action, input) });
} catch (error) { parentPort.postMessage({ error: error.message, status: error.status || 500 }); }
