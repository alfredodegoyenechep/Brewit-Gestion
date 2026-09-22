const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const { atomicJson, windows } = require('./toteat-sales');

const text = value => String(value ?? '').trim();
const normalized = value => text(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const date = value => {
  const s = text(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new Error('Fecha de compras inválida.');
  return s;
};
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
function documentType(value) {
  const n = normalized(value);
  if (['standardinvoice', 'normalinvoice', 'facturanormal', 'factura'].includes(n)) return 'invoice';
  if (['electronicreceipt', 'electronicballot', 'boletaelectronica'].includes(n)) return 'receipt';
  if (['creditnote', 'notadecredito', 'notacredito'].includes(n)) return 'credit';
  if (['withoutdocument', 'sindocumento', 'nodocument'].includes(n)) return 'withoutdocument';
  if (['exemptinvoice', 'facturaexenta', 'exemptedinvoice'].includes(n)) return 'exemptinvoice';
  return n;
}
function documentKey(supplier, type, number) {
  return [normalized(supplier), documentType(type), text(number).replace(/^'+/, '').replace(/^0+(?=\d)/, '')].join('|');
}
function legacyKey(row) {
  const entries = new Map(Object.entries(row).map(([key, value]) => [normalized(key), value]));
  const get = keys => keys.map(normalized).map(key => entries.get(key)).find(v => v != null && v !== '');
  return documentKey(get(['Número identificador fiscal', 'RUT/Fiscal ID', 'RUT', 'Tax ID number']),
    get(['Tipo Documento', 'Tipo de documento', 'Document Type']), get(['Documento', 'Número documento', 'Document']));
}

function purchaseRows(documents, localId) {
  const rows = [], owned = [], warnings = [], seen = new Set();
  for (const p of documents) {
    if (!text(p.movement_id) || seen.has(text(p.movement_id))) throw new Error('Compras sin identificador único de movimiento.');
    seen.add(text(p.movement_id));
    if (String(p.local_id) !== String(localId)) throw new Error('Toteat entregó compras de otro local.');
    if (!text(p.provider_id) || !text(p.document_id) || !text(p.document_type)) throw new Error('Faltan proveedor o documento para conciliar las compras.');
    if (!Number.isFinite(p.total_amount) || !Array.isArray(p.products) || !p.products.length) throw new Error('Una compra no tiene importe o detalle válido; se conserva la actualización anterior.');
    const issued = date(p.emission_date);
    owned.push(documentKey(p.provider_id, p.document_type, p.document_id));
    let lineTotal = 0;
    p.products.forEach((l, index) => {
      for (const k of ['invoice_quantity', 'received_quantity', 'total_price', 'unit_price']) if (!Number.isFinite(l[k])) throw new Error(`Falta un campo de compra requerido: ${k}.`);
      const missing = !text(l.sku) || !text(l.invoice_measurement) || !text(l.received_measurement);
      if (missing) warnings.push({ type: 'missing-product', movementId: text(p.movement_id), line: index + 1,
        message: 'Toteat no entrega SKU o unidades en esta línea; se conserva el importe sin asociarlo a un producto del catálogo.' });
      lineTotal += l.total_price;
      rows.push({
        'Fecha emisión': issued, 'Tipo Documento': { STANDARD_INVOICE: 'Factura Normal', ELECTRONIC_RECEIPT: 'Boleta Electrónica', CREDIT_NOTE: 'Nota de Crédito', WITHOUT_DOCUMENT: 'Sin Documento', EXEMPT_INVOICE: 'Factura Exenta' }[p.document_type] || p.document_type,
        Documento: text(p.document_id), 'Proveedor/Para': p.provider, 'Número identificador fiscal': text(p.provider_id),
        Usuario: null, 'Forma de pago': null, 'Fecha de pago': p.paid_date ? date(p.paid_date) : null,
        Lin: `${p.movement_id}:${index + 1}`, Cod: text(l.sku), PRODUCTO: l.product || 'Producto no identificado en Toteat',
        'Q.Rec': l.received_quantity, 'Um.Rec': l.received_measurement, 'Q.Fac': l.invoice_quantity, 'Um.Fac': l.invoice_measurement,
        Costo: l.unit_price, 'Costo negociado': null, 'DIF costo negociado': null, DIF: null,
        'Monto neto': null, Descuento: null, 'Monto total': l.total_price,
        'API Source': 'Toteat', 'API Movimiento': text(p.movement_id), 'API Línea': index + 1,
        'API Detalle': missing ? 'Sin SKU o unidades en Toteat; revisar' : 'Identificado',
        'API Total documento': index === 0 ? p.total_amount : null,
        'API Bodega Toteat': l.warehouse ?? null, 'API Fecha recepción': (p.received_date || p.recieived_date) ? date(p.received_date || p.recieived_date) : null,
        'API Observación': p.observation || '', 'API Costo efectivo unitario': l.invoice_quantity ? l.total_price / l.invoice_quantity : null,
        'API Campos no disponibles': 'Usuario; forma de pago; costo negociado; monto neto antes de descuento; descuento de línea'
      });
    });
    if (Math.abs(lineTotal - p.total_amount) > 0.001) warnings.push({ type: 'rounding', movementId: text(p.movement_id), difference: lineTotal - p.total_amount,
      message: 'La suma de líneas difiere de la cabecera; los reportes usan los importes de línea.' });
  }
  return { rows, owned, warnings };
}

function createPurchaseSync({ uploadsRoot, activeLocation, credentials, request, clock = today }) {
  const root = path.join(uploadsRoot, '.integrations/toteat-api/purchases');
  const settingsFile = path.join(root, 'settings.json'), jobs = new Map(), cache = new Map();
  const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  const settings = () => read(settingsFile, {});
  let timer;
  function get(location) {
    const pointer = path.join(root, location, 'current.json');
    if (!fs.existsSync(pointer)) return null;
    const stamp = fs.statSync(pointer).mtimeMs;
    if (cache.get(location)?.stamp === stamp) return cache.get(location).state;
    const { version } = read(pointer), directory = path.join(root, location, version);
    const state = { ...read(path.join(directory, 'state.json')), directory };
    state.ownedSet = new Set(state.owned);
    cache.set(location, { stamp, state }); return state;
  }
  function status(location) {
    const s = get(location), config = settings()[location];
    return { location, configured: !!credentials()[location], enabled: config?.enabled || false, from: config?.from || null,
      intervalMinutes: config?.intervalMinutes || 15, running: jobs.has(location), progress: jobs.get(location)?.progress || null,
      lastSuccess: s?.syncedAt || null, lastError: config?.lastError || null, documentCount: s?.documents.length || 0,
      lineCount: s?.lineCount || 0, warnings: s?.warnings || [],
      excludedCashMovements: Object.values(s?.excludedByRange || {}).reduce((sum, value) => sum + value, 0),
      state: jobs.has(location) ? 'syncing' : config?.lastError ? 'error' : !s ? 'not-synced' : s.documents.length ? 'connected' : 'connected-empty' };
  }
  function configure(location, body) {
    if (jobs.has(location)) throw new Error('Espera a que termine la actualización de compras.');
    if (activeLocation(location)?.type !== 'store' || !credentials()[location]) throw new Error('Conecta primero la API de esta cafetería.');
    const from = date(body.from), intervalMinutes = Number(body.intervalMinutes ?? 15);
    if (from > clock() || ![15, 60].includes(intervalMinutes) || typeof body.enabled !== 'boolean') throw new Error('Fecha o frecuencia de compras no válida.');
    const all = settings();
    if (get(location) && all[location]?.from !== from) throw new Error('La fecha histórica ya está fijada; ampliarla requiere conciliar la cobertura.');
    all[location] = { ...all[location], from, intervalMinutes, enabled: body.enabled };
    atomicJson(settingsFile, all); return status(location);
  }
  async function synchronize(location, { full = false } = {}) {
    if (jobs.has(location)) return jobs.get(location).promise;
    const config = settings()[location], credential = credentials()[location];
    if (activeLocation(location)?.type !== 'store' || !config || !credential) throw new Error('Configura primero la conexión y el período de compras.');
    const job = { progress: 'Preparando compras…' }; jobs.set(location, job);
    job.promise = (async () => {
      const registered = activeLocation(location);
      if ((registered.toteatRestaurantId && String(registered.toteatRestaurantId) !== credential.restaurantId)
        || (registered.toteatLocalId && String(registered.toteatLocalId) !== credential.localId)) throw new Error('La API no corresponde a esta cafetería.');
      const previous = get(location), batches = { ...(previous?.batches || {}) }, ranges = windows(config.from, clock());
      const excludedByRange = { ...(previous?.excludedByRange || {}) };
      const selected = ranges.filter((w, i) => full || !batches[w.from] || i >= ranges.length - 3);
      let count = 0;
      for (const w of selected) {
        job.progress = `Consultando ${++count} de ${selected.length}: ${w.from}…`;
        const response = await request(credential, 'accountingmovements', { initial_date: w.from.replaceAll('-', ''), final_date: (w.to > clock() ? clock() : w.to).replaceAll('-', ''), include_sales: 'false' });
        if (!Array.isArray(response.data?.purchases)) throw new Error('Toteat no confirmó una lista de compras válida.');
        // Accounting movements also includes manual cash entries, even with include_sales=false.
        // Those entries are outside the purchase file and must not inflate purchases or costs.
        excludedByRange[w.from] = 0;
        batches[w.from] = response.data.purchases.filter(p => {
          if (p.movement_class === 'CASH_FLOW') { excludedByRange[w.from] += 1; return false; }
          if (p.movement_class !== 'PROVIDERS') throw new Error('Toteat entregó una clase de movimiento no validada para compras.');
          return true;
        });
      }
      const unique = new Map();
      for (const batch of Object.values(batches)) for (const p of batch) {
        const key = text(p.movement_id);
        if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(p)) throw new Error('Una compra aparece con versiones diferentes en dos períodos; revisa todo el histórico.');
        unique.set(key, p);
      }
      const documents = [...unique.values()];
      let converted;
      try { converted = purchaseRows(documents, credential.localId); }
      catch (error) {
        atomicJson(path.join(root, location, 'last-rejected.json'), { capturedAt: new Date().toISOString(), reason: error.message, batches });
        throw error;
      }
      const currentCredential = credentials()[location];
      if (activeLocation(location)?.type !== 'store' || !currentCredential || ['restaurantId', 'localId', 'userId', 'token'].some(key => credential[key] !== currentCredential[key])) throw new Error('La conexión cambió durante la actualización.');
      const version = crypto.randomUUID(), syncedAt = new Date().toISOString(), directory = path.join(root, location, version);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const state = { version, syncedAt, from: config.from, through: clock(), documents, batches, excludedByRange, lineCount: converted.rows.length,
          warnings: converted.warnings, owned: [...new Set([...(previous?.owned || []), ...converted.owned])] };
        atomicJson(path.join(directory, 'state.json'), state);
        const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(converted.rows), 'Compras API');
        XLSX.writeFile(workbook, path.join(directory, 'purchases.xlsx')); fs.chmodSync(path.join(directory, 'purchases.xlsx'), 0o600);
        atomicJson(path.join(root, location, 'current.json'), { version }); cache.delete(location);
      } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
      const all = settings(); all[location] = { ...all[location], lastError: null, lastAttempt: syncedAt,
        lastFullSuccess: selected.length === ranges.length ? syncedAt : all[location]?.lastFullSuccess }; atomicJson(settingsFile, all);
      try {
        const dirs = fs.readdirSync(path.join(root, location), { withFileTypes: true }).filter(e => e.isDirectory())
          .map(e => path.join(root, location, e.name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        for (const dir of dirs.slice(3)) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* Retention failure does not invalidate published purchases. */ }
    })().catch(error => {
      const all = settings(); all[location] = { ...all[location], lastAttempt: new Date().toISOString(), lastError: error.message }; atomicJson(settingsFile, all); throw error;
    }).finally(() => jobs.delete(location));
    return job.promise;
  }
  function source(location, field) {
    if (field !== 'purchases') return [];
    const state = get(location); if (!state) return [];
    const filePath = path.join(state.directory, 'purchases.xlsx'), sourceId = `toteat-api:${location}:purchases`;
    return [{ filePath, destination: state.directory, sourceId, week: null, excludedRanges: [], record: {
      id: sourceId, name: 'purchases.xlsx', originalName: 'Compras · Toteat API', origin: 'toteat-api', savedAt: state.syncedAt,
      size: fs.statSync(filePath).size, detectedRange: { from: state.from, to: state.through }, confirmedRange: { from: state.from, to: state.through },
      url: `/api/integrations/toteat/api/purchases/export?location=${encodeURIComponent(location)}`
    } }];
  }
  function filterLegacy(filePath, rows) {
    const parts = path.relative(uploadsRoot, filePath).split(path.sep);
    const location = parts[0] === 'transactions' ? parts[1] : parts[0] === 'weeks' ? parts[2] : null;
    const state = location && activeLocation(location) ? get(location) : null;
    return state ? rows.filter(row => !state.ownedSet.has(legacyKey(row))) : rows;
  }
  function start() {
    if (timer) return;
    const tick = () => { for (const [location, config] of Object.entries(settings())) {
      if (!config.enabled || jobs.has(location) || activeLocation(location)?.type !== 'store') continue;
      if (Date.now() - (Date.parse(config.lastAttempt || '') || 0) >= config.intervalMinutes * 60000)
        synchronize(location, { full: Date.now() - (Date.parse(config.lastFullSuccess || '') || 0) >= 86400000 }).catch(() => {});
    } };
    timer = setInterval(tick, 30000); timer.unref(); tick();
  }
  return { configure, synchronize, status, get, source, filterLegacy, start, stop: () => { clearInterval(timer); timer = null; } };
}
module.exports = { createPurchaseSync, purchaseRows, legacyKey, documentKey };
