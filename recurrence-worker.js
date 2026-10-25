const { parentPort, workerData } = require('node:worker_threads');
const { createApp } = require('./server');
let today, cutoff;
const app = createApp({ uploadsRoot: workerData.uploadsRoot, sourceMode: workerData.sourceMode, reportToday: () => today,
  reportCutoff: '23:59:59', recurrenceWorker: false, clusterSourceWorker: false, clusterCachePersistence: false,
  enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false });
parentPort.on('message', async message => {
  today = message.today; cutoff = message.cutoff;
  try { const result = await app.locals.recurrenceService.request(message.action, { ...message.input, serverCutoff: cutoff, serverToday: today }, message.owner); parentPort.postMessage({ id: message.id, result }); }
  catch (error) { parentPort.postMessage({ id: message.id, error: error.message, status: error.status || 500 }); }
});
