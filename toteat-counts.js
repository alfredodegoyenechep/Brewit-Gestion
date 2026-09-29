// Original physical count documents, independent of Toteat's aggregate Kardex.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson } = require('./toteat-sales');
const { normalizeOperations } = require('./toteat-stock');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
function createCountSync({ uploadsRoot, activeLocation, credentials, reader }) {
  const root = path.join(uploadsRoot, '.integrations/toteat-api/original-counts');
  const jobs = new Map();
  const keyFor = id => {
    const key = id === 'main-warehouse' ? 'store-1' : id;
    if (activeLocation(key)?.type !== 'store') throw Error('Selecciona una cafetería activa.');
    return key;
  };
  function current(id) {
    const key = keyFor(id), pointer = read(path.join(root, key, 'current.json'));
    return pointer ? read(path.join(root, key, pointer.version, 'state.json')) : null;
  }
  function status(id) {
    const key = keyFor(id), state = current(key), attempt = read(path.join(root, key, 'attempt.json'));
    return { location: key, running: jobs.has(key), error: attempt?.error || null,
      updatedAt: state?.capturedAt || null, range: state?.range || null, sourceKind: 'original-count-documents',
      documents: state?.documents.length ?? null, approved: state?.documents.filter(d => d.status === 'APPROVED').length ?? null,
      lines: state?.lines.length ?? null };
  }
  function publish(id, source) {
    const key = keyFor(id), config = credentials()[key];
    if (!config || String(source.restaurantId) !== String(config.restaurantId) || String(source.localId) !== String(config.localId)) throw Error('Las tomas pertenecen a otro local.');
    if (!validDate(source.range?.from) || !validDate(source.range?.to) || source.range.from > source.range.to) throw Error('Cobertura de tomas inválida.');
    if (!Array.isArray(source.operations?.counts)) throw Error('Faltan los documentos originales de tomas.');
    const result = normalizeOperations({ ...source, operations: { counts: source.operations.counts, transfers: [], transformations: [] } }, source.products);
    const state = { ...result, location: key, range: source.range, capturedAt: source.capturedAt, warehouses: source.warehouses,
      source: 'Toteat /take-inventory/', boundaryPolicy: 'Conteo físico por fecha operativa. Solo APPROVED afecta inventario; los demás estados se conservan para revisión.' };
    const version = crypto.randomUUID(), directory = path.join(root, key, version);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicJson(path.join(directory, 'original.json'), source);
    atomicJson(path.join(directory, 'state.json'), state);
    atomicJson(path.join(root, key, 'current.json'), { version });
    atomicJson(path.join(root, key, 'attempt.json'), { error: null });
    return status(key);
  }
  function synchronize(id, range) {
    const key = keyFor(id);
    if (jobs.has(key)) return jobs.get(key);
    if (!validDate(range.from) || !validDate(range.to) || range.from > range.to || Date.parse(range.to) - Date.parse(range.from) > 366 * 86400000) throw Error('Selecciona un período de hasta un año.');
    const config = credentials()[key]; if (!config) throw Error('Configura la conexión Toteat del local.');
    const task = Promise.resolve().then(async () => {
      try {
        const source = await reader({ restaurantId: String(config.restaurantId), localId: String(config.localId) },
          { from: range.from, to: range.to, includeOperations: true, operationKinds: ['counts'] });
        return publish(key, source);
      } catch {
        const error = 'No se pudieron actualizar las tomas originales. Revisa la sesión autorizada de Toteat; se conserva la última versión completa.';
        atomicJson(path.join(root, key, 'attempt.json'), { error }); throw Error(error);
      } finally { jobs.delete(key); }
    });
    jobs.set(key, task); return task;
  }
  function records(id, from, to) {
    const state = current(id);
    if (!state) return { rows: [], note: 'Tomas originales aún no sincronizadas. Actualiza las fuentes de inventario.' };
    const codes = id === 'main-warehouse' ? [1, 4] : [2, 3];
    const warehouses = new Map(state.warehouses.filter(w => codes.includes(Number(w.custom_id))).map(w => [w.id, w.name]));
    const documents = new Map(state.documents.map(d => [d.key, d]));
    return { rows: state.lines.filter(l => warehouses.has(l.warehouse) && l.date >= from && l.date <= to).map(l => {
      const doc = documents.get(l.document);
      return { Fecha: l.date, Documento: doc.id, Estado: l.status, Bodega: warehouses.get(l.warehouse), Código: l.code,
        Producto: l.name, 'Cantidad toma': l.quantity, Unidad: l.unit, 'Cantidad original': l.originalQuantity, 'Unidad original': l.originalUnit,
        'Afecta inventario': l.active ? 'Sí' : 'No', 'Fecha registro': doc.createdAt, 'Fecha aprobación': doc.approvedAt };
    }), coverage: state.range, updatedAt: state.capturedAt,
      note: 'Documentos originales de tomas físicas de Toteat. Solo las tomas aprobadas afectan inventario. Se conservan también los documentos pendientes y anulados.' };
  }
  return { current, status, publish, synchronize, records };
}
module.exports = { createCountSync };
