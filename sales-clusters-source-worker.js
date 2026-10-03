const { parentPort, workerData } = require('node:worker_threads');
const { createApp } = require('./server');
let today;
const app = createApp({ uploadsRoot: workerData.uploadsRoot, sourceMode: workerData.sourceMode,
  reportToday: () => today, enableToteatSync: false, clusterSourceWorker: false, clusterCachePersistence: false });

parentPort.on('message', message => {
  try {
    today = message.today;
    const source = app.locals.salesClusterSource(message.query);
    // Do not transfer the raw source or its comments/instrument identifiers to the HTTP process.
    parentPort.postMessage({ id: message.id, source: { input: source.input, sourceOptions: source.sourceOptions,
      filters: source.payload.filters, today: source.payload.today, availablePeriod: source.payload.availablePeriod } });
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message, status: error.status }); }
});
