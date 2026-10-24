const { parentPort, workerData } = require('node:worker_threads');
const { createApp } = require('./server');

const app = createApp({
  uploadsRoot: workerData.uploadsRoot,
  sourceMode: workerData.sourceMode,
  reportToday: workerData.reportToday,
  projectionToday: workerData.projectionToday,
  enableToteatSync: false,
  enableMercadoPagoSync: false,
  storageMaintenance: false,
  enableBackgroundCalculations: false
});
const server = app.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
