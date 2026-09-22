const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const dateKey = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const addDays = (value, days) => new Date(Date.parse(`${value}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date());
const normalizeId = value => String(value ?? '').trim().replace(/^'+/, '');
const localTimestamp = value => {
  const parsed = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Toteat entregó una fecha inválida.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(parsed).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
};
function windows(from, to) {
  const result = [];
  for (let start = from; start <= to; start = addDays(start, 15)) result.push({ from: start, to: addDays(start, 14) });
  return result;
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

// Keep money in CLP, retain line identities, and never interpret a failed response as an empty day.
function salesRows(payments) {
  const orders = new Map(), seenPayments = new Set(), warnings = [];
  const normalized = payments.map(p => {
    // Some NC responses repeat the original positive product amounts while the payment is negative.
    if (p.fiscalType === 'NC' && p.total < 0 && Array.isArray(p.products) && p.products.length
      && Math.abs(p.products.reduce((sum, line) => sum + Number(line.payed), 0) + p.total) <= 2) {
      return { ...p, products: p.products.map(line => ({ ...line, ...Object.fromEntries(['quantity', 'payed', 'discounts', 'taxes', 'netPrice', 'totalCost'].filter(key => Number.isFinite(line[key])).map(key => [key, -line[key]])) })) };
    }
    return p;
  });
  for (const p of normalized) {
    if (!normalizeId(p.orderId) || !normalizeId(p.paymentId) || seenPayments.has(normalizeId(p.paymentId))) throw new Error('Identidades de pagos inválidas o repetidas.');
    seenPayments.add(normalizeId(p.paymentId));
    for (const key of ['total', 'discounts', 'taxes', 'gratuity', 'payed', 'change']) if (typeof p[key] !== 'number' || !Number.isFinite(p[key])) throw new Error(`Toteat no entregó el importe requerido: ${key}.`);
    if (!Array.isArray(p.products) || !Array.isArray(p.paymentForms)) throw new Error('El detalle de productos o pagos está incompleto.');
    if (p.products.length === 0 && p.total !== 0) warnings.push({ orderId: normalizeId(p.orderId), paymentId: normalizeId(p.paymentId), total: p.total, reason: 'Toteat entrega el importe del pago sin productos asociados.' });
    const paidLines = p.products.reduce((s, l) => s + Number(l.payed), 0);
    if (p.products.length && (!Number.isFinite(paidLines) || Math.abs(paidLines - p.total) > 2)) throw new Error('El total del pago no concilia con sus productos.');
    const order = orders.get(normalizeId(p.orderId)) || [];
    order.push(p); orders.set(normalizeId(p.orderId), order);
  }
  const sales = [], details = [];
  for (const [orderId, group] of orders) {
    const sum = key => group.reduce((s, p) => s + p[key], 0);
    const total = sum('total'), discount = sum('discounts'), tip = sum('gratuity'), paid = sum('payed');
    let first = true;
    const lineOwners = new Map();
    for (const p of group) {
      const opened = localTimestamp(p.dateOpen), closed = localTimestamp(p.dateClosed);
      const lines = p.products;
      const ordered = [];
      const appended = new Set();
      const visit = l => { if (appended.has(l)) return; appended.add(l); ordered.push(l); for (const extra of lines.filter(x => normalizeId(x.lineReference) === normalizeId(l.lineId) && x !== l)) visit(extra); };
      for (const l of lines.filter(l => !l.lineReference)) visit(l);
      for (const l of lines) visit(l);
      // Header-only records retain money, including reversals, without inventing a product or quantity.
      if (!ordered.length) ordered.push({ headerOnly: true });
      for (const l of ordered) {
        if (!l.headerOnly) {
        for (const k of ['quantity', 'payed', 'discounts', 'taxes']) if (typeof l[k] !== 'number' || !Number.isFinite(l[k])) throw new Error(`Detalle inválido de producto: ${k}.`);
        if (!normalizeId(l.id) || !normalizeId(l.lineId)) throw new Error('Faltan códigos o IDs de línea: se requiere el detalle completo de ventas.');
        const lineIdentity = `${p.fiscalType === 'NC' ? 'NC:' : ''}${l.lineId}`;
        if (lineOwners.has(lineIdentity)) throw new Error('Una línea se repite entre pagos. Se requiere revisar la división de la cuenta antes de importarla.');
        lineOwners.set(lineIdentity, p.paymentId);
        }
        const hierarchy = String(l.hierarchyId || '');
        sales.push({
          'ID de orden': orderId, 'Fecha de creacion': opened.date, 'Hora de creacion': opened.time,
          'Fecha de cierre': closed.date, 'Hora de cierre': closed.time, 'Nombre de mesa': p.tableName === 'Virtual' ? p.tableId : p.tableName || '',
          'Numero de clientes': p.numberClients, 'Capacidad de la mesa': p.tableCapacity ?? p.tableCapaticy,
          Sector: p.zoneName || '', Origen: null, 'Nombre garzón apertura': p.waiterName || '',
          'Impuestos totales': first ? sum('taxes') : null, 'Pago total': first ? total - discount : null,
          'ID Caja': p.registerId, 'Nombre de la caja': p.registerName, 'Total con propina': first ? total - discount + tip : null,
          'ID de Pago': normalizeId(p.paymentId), Folio: p.fiscalId, 'Valor de boleta': first ? total : null,
          'Tipo de documento': p.fiscalType, Descuentos: first ? discount : null, 'Total a pagar': first ? total - discount : null,
          Propina: first ? tip : null, Pagado: first ? paid : null, Cambio: first ? sum('change') : null,
          'Diferencia a favor': p.difference || 0, Valor: first ? paid : null, 'Forma de Pago': p.paymentForms.map(f => f.name).join(' / '),
          'ID Producto': l.headerOnly ? '' : String(l.id), Nombre: l.name || '', Cantidad: l.quantity ?? null,
          'Precio a Pagar': l.payed, 'Precio Base': l.quantity ? (l.payed - l.discounts) / l.quantity : null, 'Precio Lista': l.headerOnly ? null : l.payed - l.discounts,
          Costo: Number.isFinite(l.totalCost) ? l.totalCost : null, Descuento: l.discounts, Impuesto: l.taxes,
          'Fecha Pedido': null, 'Hora Pedido': null,
          'AB.': hierarchy.startsWith('BA.') ? '' : hierarchy, 'Categorías de Productos/Platos': hierarchy.startsWith('BA.') ? '' : l.hierarchyName,
          'BA.': hierarchy.startsWith('BA.') ? hierarchy : '', 'Jerarquía de Extras': hierarchy.startsWith('BA.') ? l.hierarchyName : '',
          'API Line ID': l.headerOnly ? '' : String(l.lineId), 'API Line Reference': String(l.lineReference || ''), 'API Source': 'Toteat',
          'API Detalle': l.headerOnly ? 'Sin productos en respuesta de Toteat' : 'Completo',
          'API Referenced Payment': p.referencedPayment?.id ? String(p.referencedPayment.id) : ''
        });
        first = false;
      }
      const detail = { FechaCierre: `${closed.date} ${closed.time}`, Comanda: orderId, Pago: normalizeId(p.paymentId),
        Caja: p.registerId, Mesa: p.tableName, Total: p.total - p.discounts, Descuentos: p.discounts,
        'A Pagar': p.total, Propina: p.gratuity, Pagos: p.payed, Cambio: p.change, Folio: p.fiscalId,
        'Tipo de documento': p.fiscalType, 'Comentario General': p.comment || '', 'Comentario Descuento': p.discountComment || '',
        'API Moneda': 'CLP', 'API Total Orden': total, 'API Pagado Orden': paid, 'API Propina Orden': tip,
        'API Source': 'Toteat' };
      for (const f of p.paymentForms) {
        if (!Number.isFinite(f.amount) || !Number.isFinite(f.tip)) throw new Error('Medio de pago con importes inválidos.');
        const label = `Medio ${f.id} · ${f.name}`;
        detail[label] = (detail[label] || 0) + f.amount - (f.id === 1000 ? p.change : 0);
      }
      details.push(detail);
    }
  }
  return { sales, details, orders: orders.size, warnings };
}

function createSalesSync({ uploadsRoot, activeLocation, credentials, request, clock = today }) {
  const root = path.join(uploadsRoot, '.integrations', 'toteat-api', 'sales');
  const settingsFile = path.join(root, 'settings.json');
  const running = new Map();
  const cache = new Map();
  let timer;
  const readJson = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  const settings = () => readJson(settingsFile, {});
  const get = location => {
    const pointer = path.join(root, location, 'current.json');
    if (!fs.existsSync(pointer)) return null;
    const stamp = fs.statSync(pointer).mtimeMs;
    if (cache.get(location)?.stamp === stamp) return cache.get(location).state;
    const { version } = readJson(pointer);
    const state = readJson(path.join(root, location, version, 'state.json'));
    state.directory = path.join(root, location, version);
    state.ownedOrderSet = new Set(state.ownedOrders);
    cache.set(location, { stamp, state }); return state;
  };
  function status(location) {
    const s = get(location), config = settings()[location];
    return { location, configured: !!credentials()[location], enabled: config?.enabled || false,
      from: config?.from || null, intervalMinutes: config?.intervalMinutes || 5, running: running.has(location),
      lastSuccess: s?.syncedAt || null, paymentCount: s?.payments.length || 0, orderCount: s?.orderCount || 0,
      completedWindows: Object.keys(s?.batches || {}).length, lastError: config?.lastError || null,
      detailWarnings: s?.warnings || [],
      state: running.has(location) ? 'syncing' : config?.lastError ? 'error' : !s ? 'not-synced' : s.payments.length ? 'connected' : 'connected-empty',
      progress: running.get(location)?.progress || null };
  }
  function configure(location, body) {
    if (running.has(location)) throw new Error('Espera a que termine la actualización antes de cambiar la configuración.');
    if (activeLocation(location)?.type !== 'store' || !credentials()[location]) throw new Error('Conecta primero la API de esta cafetería.');
    const from = String(body.from || '');
    if (!dateKey(from) || from > clock()) throw new Error('Selecciona una fecha inicial válida, no futura.');
    const intervalMinutes = Number(body.intervalMinutes ?? 5);
    if (![5, 15].includes(intervalMinutes) || typeof body.enabled !== 'boolean') throw new Error('Frecuencia o activación no válidas.');
    const all = settings();
    if (get(location) && all[location]?.from !== from) throw new Error('La fecha histórica ya está fijada. Para ampliarla se requiere una conciliación del histórico.');
    all[location] = { ...all[location], from, intervalMinutes, enabled: body.enabled };
    atomicJson(settingsFile, all); return status(location);
  }
  async function synchronize(location, { full = false } = {}) {
    if (running.has(location)) return running.get(location).promise;
    const config = settings()[location];
    const credential = credentials()[location];
    if (activeLocation(location)?.type !== 'store' || !credential || !config) throw new Error('Configura la conexión y la fecha inicial de la cafetería.');
    const registered = activeLocation(location);
    if ((registered.toteatRestaurantId && String(registered.toteatRestaurantId) !== credential.restaurantId)
      || (registered.toteatLocalId && String(registered.toteatLocalId) !== credential.localId)) throw new Error('La conexión API no corresponde a los identificadores configurados para esta cafetería.');
    const job = { progress: 'Consultando turno…' };
    running.set(location, job);
    job.promise = (async () => {
      const shift = await request(credential, 'shiftstatus', {});
      if (!shift.data || !['open', 'closed'].includes(String(shift.data.status).toLowerCase())) throw new Error('Toteat no confirmó el estado del turno.');
      if (shift.data.localNumber != null && String(shift.data.localNumber) !== credential.localId) throw new Error('Toteat respondió con otro local.');
      const opened = String(shift.data.status).toLowerCase() === 'open' ? localTimestamp(shift.data.date).date : null;
      const previous = get(location);
      const batches = { ...(previous?.batches || {}) };
      const allWindows = windows(config.from, clock());
      // Fixed windows let a refresh replace a whole shift range, including payments later cancelled.
      const selected = allWindows.filter((w, i) => full || !batches[w.from] || i >= allWindows.length - 2 || (opened && opened >= w.from && opened <= w.to) || (previous?.openShift && previous.openShift >= w.from && previous.openShift <= w.to));
      if (opened && opened < config.from) throw new Error('Hay un turno abierto anterior al inicio configurado. Amplía el período antes de sincronizar.');
      let count = 0;
      for (const w of selected) {
        job.progress = `Consultando ${++count} de ${selected.length}: ${w.from}…`;
        const response = await request(credential, 'sales', { ini: w.from.replaceAll('-', ''), end: (w.to > clock() ? clock() : w.to).replaceAll('-', ''), detail_cancel_order: 'true' });
        if (!Array.isArray(response.data)) throw new Error('Toteat no entregó una lista de ventas válida.');
        batches[w.from] = response.data.map(({ client, ...p }) => p);
      }
      const byPayment = new Map();
      for (const batch of Object.values(batches)) for (const p of batch) {
        const key = normalizeId(p.paymentId);
        if (byPayment.has(key) && JSON.stringify(byPayment.get(key)) !== JSON.stringify(p)) throw new Error('El mismo pago tiene versiones incompatibles entre turnos.');
        byPayment.set(key, p);
      }
      const payments = [...byPayment.values()];
      const converted = salesRows(payments);
      const currentCredential = credentials()[location];
      if (activeLocation(location)?.type !== 'store' || !currentCredential || ['restaurantId', 'localId', 'userId', 'token'].some(key => credential[key] !== currentCredential[key])) throw new Error('La conexión cambió durante la actualización. Vuelve a sincronizar.');
      const ownedOrders = [...new Set([...(previous?.ownedOrders || []), ...payments.map(p => normalizeId(p.orderId))])];
      const syncedAt = new Date().toISOString(), version = crypto.randomUUID();
      const dir = path.join(root, location, version);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const state = { version, syncedAt, batches, payments, ownedOrders, warnings: converted.warnings, openShift: opened, orderCount: converted.orders, from: config.from, through: clock() };
        atomicJson(path.join(dir, 'state.json'), state);
        for (const [field, rows] of [['sales', converted.sales], ['payment-details', converted.details]]) {
          const workbook = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), field === 'sales' ? 'Ventas API' : 'Detalle Pagos API');
          XLSX.writeFile(workbook, path.join(dir, `${field}.xlsx`));
          fs.chmodSync(path.join(dir, `${field}.xlsx`), 0o600);
        }
        // One pointer publishes both sources atomically. Failures never advance it.
        atomicJson(path.join(root, location, 'current.json'), { version });
        cache.delete(location);
        // Keep the previous two complete generations for in-flight previews/downloads.
        try {
        const generations = fs.readdirSync(path.join(root, location), { withFileTypes: true }).filter(e => e.isDirectory())
          .map(e => ({ dir: path.join(root, location, e.name), time: fs.statSync(path.join(root, location, e.name)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        for (const old of generations.slice(3)) fs.rmSync(old.dir, { recursive: true, force: true });
        } catch { /* Cleanup must never roll back an already published pair of sources. */ }
      } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
      const all = settings(); all[location] = { ...all[location], lastError: null, lastAttempt: syncedAt,
        lastFullSuccess: selected.length === allWindows.length ? syncedAt : all[location]?.lastFullSuccess }; atomicJson(settingsFile, all);
    })().catch(error => {
      const all = settings(); all[location] = { ...all[location], lastError: error.message, lastAttempt: new Date().toISOString() }; atomicJson(settingsFile, all);
      throw error;
    }).finally(() => running.delete(location));
    return job.promise;
  }
  function source(location, field) {
    if (!['sales', 'payment-details'].includes(field)) return [];
    const state = get(location); if (!state) return [];
    const filePath = path.join(state.directory, `${field}.xlsx`);
    const sourceId = `toteat-api:${location}:${field}`;
    return [{ filePath, destination: state.directory, week: null, sourceId, excludedRanges: [], record: {
      id: sourceId, name: path.basename(filePath), originalName: `${field} · Toteat API`, origin: 'toteat-api',
      savedAt: state.syncedAt, size: fs.statSync(filePath).size,
      detectedRange: { from: state.from, to: state.through }, confirmedRange: { from: state.from, to: state.through },
      url: `/api/integrations/toteat/api/sales/export?location=${encodeURIComponent(location)}&field=${field}`
    } }];
  }
  function filterLegacy(filePath, rows) {
    const relative = path.relative(uploadsRoot, filePath).split(path.sep);
    const location = relative[0] === 'transactions' ? relative[1] : relative[0] === 'weeks' ? relative[2] : null;
    if (!location || !activeLocation(location)) return rows;
    const state = get(location); if (!state) return rows;
    const owned = state.ownedOrderSet;
    return rows.filter(row => !owned.has(normalizeId(row['ID de orden'] ?? row['Id de orden'] ?? row.Comanda ?? row.Ticket)));
  }
  function start() {
    if (timer) return;
    const tick = () => { for (const [location, config] of Object.entries(settings())) {
      if (!config.enabled || activeLocation(location)?.type !== 'store' || running.has(location)) continue;
      const last = Date.parse(config.lastAttempt || 0) || 0;
      if (Date.now() - last >= config.intervalMinutes * 60000) synchronize(location, { full: Date.now() - (Date.parse(config.lastFullSuccess || '') || 0) >= 86400000 }).catch(() => {});
    } };
    timer = setInterval(tick, 30000); timer.unref(); tick();
  }
  return { configure, synchronize, status, source, filterLegacy, get, start, stop: () => { clearInterval(timer); timer = null; } };
}
module.exports = { createSalesSync, salesRows, windows, localTimestamp, atomicJson };
