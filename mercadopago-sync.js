const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./toteat-sales');
const { createMercadoPagoBrowser } = require('./mercadopago-web');

function santiagoClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function createMercadoPagoSync({ uploadsRoot, checkpoints, importReports, browser, clock = () => new Date(), enableScheduler = true }) {
  const root = path.join(uploadsRoot, '.integrations', 'mercadopago');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const settingsFile = path.join(root, 'settings.json'), stateFile = path.join(root, 'state.json');
  const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  let settings = read(settingsFile, { enabled: false }), state = read(stateFile, { status: 'idle' }), running, timer;
  if (state.status === 'running') state = { ...state, status: 'error', message: 'La actualización se interrumpió al detener el servidor. Reintenta para continuar sin duplicar registros.' };
  const automation = browser || createMercadoPagoBrowser(path.join(root, 'profile'));
  const status = () => ({ ...state, historicalRunId:require('./historical-control').get(uploadsRoot).latest('all',['mercadopago']), running: Boolean(running), enabled: settings.enabled, schedule: { time: '08:00', timeZone: 'America/Santiago' } });
  const saveState = update => { state = { ...state, ...update }; atomicJson(stateFile, state); };
  function synchronize({ interactive = true } = {}) {
    if (running) return running;
    saveState({ status: 'running', message: 'Revisando períodos y descargando reportes de MercadoPago…', startedAt: clock().toISOString(), result: null, code: null });
    running = require('./historical-control').get(uploadsRoot).track({origin:'mercadopago-web',location:'all',label:'Reportes MercadoPago',datasets:['mercadopago']},async () => {
      const directory = fs.mkdtempSync(path.join(root, 'download-'));
      try {
        if (fs.existsSync(path.join(uploadsRoot, '.storage-maintenance.lock'))) throw Object.assign(new Error('Mantenimiento de almacenamiento en curso. Reintenta al terminar.'), { code: 'MP_MAINTENANCE' });
        const stores = checkpoints();
        if (!stores.length) throw Object.assign(new Error('Configura el STORE_ID de al menos una cafetería activa antes de actualizar MercadoPago.'), { code: 'MP_NO_STORES' });
        const from = stores.map(store => store.from).sort()[0], to = santiagoClock(clock()).today;
        const reports = await automation.download({ from, to, directory, interactive });
        for (const report of reports) require('./historical-control').captureFileCurrent(report.path,{datasets:stores.map(store=>({dataset:'mercadopago',location:store.location,storeId:store.storeId,range:report.period,complete:!!report.period}))});
        const result = reports.length ? await importReports(reports, stores, to) : { newTransactions: 0, duplicateTransactions: 0, skippedCount: 0 };
        const latestReportDate = reports.map(report => report.period.to).sort().at(-1) || null;
        saveState({ status: 'complete', code: null, finishedAt: clock().toISOString(), result: { ...result, reports: reports.length, from, to, latestReportDate },
          message: reports.length ? `${result.newTransactions} transacciones nuevas guardadas; ${result.duplicateTransactions} repetidas omitidas; ${result.skippedCount} sin cafetería asociada. Reportes disponibles hasta ${latestReportDate}.`
            : `No hay reportes CSV disponibles para el período ${from} a ${to}. Crea el reporte en MercadoPago y vuelve a actualizar.` });
      } catch (error) {
        const auth = error.code === 'MP_AUTH_REQUIRED';
        saveState({ status: auth ? 'waiting-auth' : 'error', code: error.code || 'MP_SYNC_FAILED', finishedAt: clock().toISOString(),
          message: error.code==='HISTORICAL_BACKUP_FAILED' ? error.message : auth && !interactive ? 'La sesión de MercadoPago venció. Pulsa «Ya inicié sesión, continuar» para abrir el navegador del servidor; inicia sesión allí y vuelve a pulsar continuar.'
            : error.code?.startsWith('MP_') ? error.message : 'No se pudieron validar o guardar los reportes. Revisa que contengan STORE_ID, SOURCE_ID, TRANSACTION_TYPE y TRANSACTION_DATE y vuelve a intentar.' });
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
      if (['error','waiting-auth'].includes(state.status)) throw Object.assign(Error(state.message),{code:state.code});
      return status();
    }).catch(() => status()).finally(() => { running = undefined; });
    return running;
  }
  function configure(enabled) {
    if (typeof enabled !== 'boolean') throw Error('Indica si deseas activar la actualización diaria.');
    settings = { ...settings, enabled }; atomicJson(settingsFile, settings); return status();
  }
  async function tick() {
    const { today, hour } = santiagoClock(clock());
    if (!settings.enabled || hour < 8 || settings.lastAttemptDate === today || running || fs.existsSync(path.join(uploadsRoot, '.storage-maintenance.lock'))) return;
    settings.lastAttemptDate = today; atomicJson(settingsFile, settings);
    await synchronize({ interactive: false });
  }
  if (enableScheduler) { timer = setInterval(() => tick().catch(() => {}), 30000); timer.unref(); }
  return { status, synchronize, configure, tick, async close() { clearInterval(timer); await running; await automation.close?.(); } };
}
module.exports = { santiagoClock, createMercadoPagoSync };
