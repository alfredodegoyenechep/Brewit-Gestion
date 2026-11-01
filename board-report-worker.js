'use strict';
const { parentPort, workerData: data } = require('node:worker_threads');
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
(async () => {
  let app, staging;
  try {
    app = require('./server').createApp({ uploadsRoot: data.uploadsRoot, sourceMode: data.sourceMode, reportToday: data.today, reportCutoff: data.cutoff,
      boardWorker: true, includeInactiveStores: true, productXrayWorker: false, recurrenceWorker: false, clusterSourceWorker: false, clusterCachePersistence: false,
      enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false });
    const report = await app.locals.boardSource.generate({ month: data.month }, (message, progress) => parentPort.postMessage({ type: 'progress', message, progress }));
    report.id = data.id; report.deck = require('./board-deck').build(report);
    const files = await require('./board-export').exportFiles(report);
    if (app.locals.boardSource.fingerprint() !== report.sourceVersion) throw Error('Las fuentes cambiaron durante la exportación; no se publicó la versión.');
    report.artifacts = Object.fromEntries(Object.entries(files).map(([kind, buffer]) => [kind, { bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') }]));
    const root = path.join(data.uploadsRoot, 'board-reports'); staging = path.join(root, `.pending-${data.id}`); fs.mkdirSync(staging, { recursive: true });
    for (const [kind, buffer] of Object.entries(files)) fs.writeFileSync(path.join(staging, `presentation.${kind}`), buffer, { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'report.json'), JSON.stringify(report), { flag: 'wx' });
    fs.renameSync(staging, path.join(root, data.id)); staging = null;
    parentPort.postMessage({ type: 'complete', reportId: data.id });
  } catch (e) { parentPort.postMessage({ type: 'error', error: e.message }); }
  finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); app?.locals.shutdown?.(); parentPort.close(); }
})();
