const XLSX = require('xlsx');
const multer = require('multer');
const crypto = require('node:crypto');
const { CATEGORIES, NAME_STATES, failure } = require('./order-gender-review');
const { searchKey } = require('./recorded-name-search');
const { validDate } = require('./recurrence');
const HEADERS = ['Local ID', 'Cafetería', 'Pedido / Comanda', 'Fecha', 'Comentario original', 'Nombre obtenido', 'Estado del nombre', 'Género actual', 'Estado de revisión', 'Versión del registro', 'Género asignado', 'Nombre corregido', 'Observación', 'Origen del comentario'];
const REVIEW_STATES = { pending: 'Pendiente', source: 'Registrado en fuente', reviewed: 'Revisado', stale: 'Comentario modificado: revisar' };
function category(value) {
  const text = searchKey(value).replace(/_/g, ' ');
  const values = { masculino: 'masculine', hombre: 'masculine', femenino: 'feminine', mujer: 'feminine',
    'no atribuible': 'unattributable', 'no identificable': 'unattributable', 'sin informacion': 'missing', 'no informado': 'missing' };
  return values[text] || null;
}
const rowFor = order => {
  const a = order.commentAnalysis, review = order.genderReview;
  return { orderKey: order.orderKey, locationId: order.locationId, location: order.locationName,
    orderId: String(order.orderReference || order.orderKey), date: order.date, comment: a.original,
    name: review.name, nameStatus: a.name.status, nameReason: a.name.reason, suggestion: a.name.suggestion,
    category: review.category, reviewState: review.state, reviewer: review.reviewer, reviewedAt: review.reviewedAt,
    note: review.note, origin: review.origin, sourceHash: a.sourceHash, token: `${a.sourceHash}:${review.revision}`,
    sources: [...new Set((a.sourceEvidence || []).map(e => `${e.source || 'Fuente de ventas'}${e.paymentId ? ` · pago ${e.paymentId}` : ''}`))],
    mode: a.mode.key, modeStatus: a.mode.status };
};
function registerGenderReview(app, { store, source, locations, today }) {
  const previews = new Map();
  function all() {
    const data = source();
    return { rows: data.orders.filter(order => order.orderReference != null).map(rowFor), warnings: data.warnings };
  }
  function filtered(query = {}) {
    const data = all();
    const from = query.dateFrom || '', to = query.dateTo || '';
    if (from && !validDate(from) || to && !validDate(to) || from && to && from > to) failure('Revisa el período de fechas.');
    if (query.location && query.location !== 'all' && !locations().some(l => l.id === query.location)) failure('Cafetería inválida.');
    const state = query.status || 'pending', name = query.name || 'all', search = searchKey(query.search || '');
    if (!['pending', 'unassigned', 'reviewed', 'all'].includes(state) || !['all', 'with', 'without', 'ambiguous'].includes(name)) failure('Filtro inválido.');
    const scoped = data.rows.filter(r => (!query.location || query.location === 'all' || r.locationId === query.location) && (!from || r.date >= from) && (!to || r.date <= to));
    const summary = { total: scoped.length, assigned: scoped.filter(r => ['masculine', 'feminine'].includes(r.category)).length,
      pending: scoped.filter(r => ['pending', 'stale'].includes(r.reviewState)).length, reviewed: scoped.filter(r => r.reviewState === 'reviewed').length,
      withoutComment: scoped.filter(r => !r.comment.trim()).length };
    const rows = scoped.filter(r => (state === 'all' || state === 'pending' && ['pending', 'stale'].includes(r.reviewState)
      || state === 'reviewed' && r.reviewState === 'reviewed' || state === 'unassigned' && !['masculine', 'feminine'].includes(r.category))
      && (name === 'all' || name === 'with' && !!r.name || name === 'without' && !r.name || name === 'ambiguous' && r.nameStatus === 'ambiguous')
      && (!search || searchKey([r.comment, r.name, r.orderId].join(' ')).includes(search)))
      .sort((a, b) => b.date.localeCompare(a.date) || a.location.localeCompare(b.location, 'es') || a.orderId.localeCompare(b.orderId));
    return { rows, summary, warnings: data.warnings };
  }
  function exportBook(data) {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([HEADERS, ...data.rows.map(r => [r.locationId, r.location, r.orderId, r.date, r.comment,
      r.name, NAME_STATES[r.nameStatus], CATEGORIES[r.category], REVIEW_STATES[r.reviewState], r.token, '', '', '', r.sources.join('\n')])]);
    sheet['!cols'] = [15, 24, 25, 14, 48, 32, 26, 24, 30, 32, 24, 32, 50, 45].map(wch => ({ wch }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    for (let r = 2; r <= data.rows.length + 1; r++) sheet[`C${r}`].z = '@';
    XLSX.utils.book_append_sheet(book, sheet, 'Asignaciones');
    const instructions = XLSX.utils.aoa_to_sheet([
      ['Instrucción', 'Detalle'], ['Completar', 'Escribe Género asignado en las filas que quieras actualizar. Las filas vacías no se modifican.'],
      ['Valores permitidos', Object.values(CATEGORIES).join(' / ')],
      ['Opcionales', 'Nombre corregido y Observación. El nombre corregido se aplica únicamente al pedido de esa fila.'],
      ['Identificación', 'Conserva Local ID, Pedido / Comanda, Comentario original y Versión del registro. La comanda debe permanecer como texto.'],
      ['Revisión', 'Al cargar el archivo podrás revisar los cambios y aplicarlos juntos. Un error impide aplicar toda la importación.'],
      ['Alcance', 'Cada asignación corresponde al pedido identificado. Los pedidos con el mismo nombre se revisan por separado.'],
      ['Sin cambios', 'Las asignaciones ya aplicadas no generan una segunda revisión al cargar el mismo archivo.'],
      ['Pedidos exportados', data.rows.length], ['Versión de plantilla', 'gender-review-v1']
    ]);
    instructions['!cols'] = [{ wch: 24 }, { wch: 120 }]; XLSX.utils.book_append_sheet(book, instructions, 'Instrucciones');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
  }
  function validate(proposals, rows) {
    const current = new Map(rows.map(r => [`${r.locationId}\n${r.orderId}`, r])), changes = [], errors = [];
    let unchanged = 0;
    for (const p of proposals) {
      const row = current.get(`${p.locationId}\n${p.orderId}`);
      if (!row) { errors.push(`Fila ${p.row}: no existe el pedido en las fuentes vigentes.`); continue; }
      if (row.sourceHash !== p.token.split(':')[0] || row.comment !== p.comment) { errors.push(`Fila ${p.row}: el comentario o la fuente cambió; exporta nuevamente.`); continue; }
      const name = p.name || row.name, note = p.note || row.note;
      if (row.reviewState === 'reviewed' && row.category === p.category && row.name === name && row.note === note) { unchanged++; continue; }
      if (row.token !== p.token) { errors.push(`Fila ${p.row}: existe una revisión posterior; exporta nuevamente.`); continue; }
      changes.push({ orderKey: row.orderKey, orderId: row.orderId, location: row.location, sourceHash: row.sourceHash, category: p.category,
        name, note, previous: row.category, comment: row.comment });
    }
    return { changes, errors, unchanged };
  }
  function parse(buffer) {
    let book;
    try { book = XLSX.read(buffer, { type: 'buffer', cellFormula: true, sheetRows: 20002 }); }
    catch { failure('No se pudo leer el archivo XLSX.'); }
    const sheet = book.Sheets.Asignaciones;
    if (!sheet) failure('Falta la hoja Asignaciones. Usa la planilla exportada desde esta pantalla.');
    const fullRange = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
    if (fullRange.e.r > 20000 || fullRange.e.c > 50) failure('El archivo supera 20.000 filas o 51 columnas; usa un período menor.');
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }), header = matrix[0] || [];
    if (new Set(header).size !== header.length) failure('Hay encabezados repetidos.');
    for (const name of ['Local ID', 'Pedido / Comanda', 'Comentario original', 'Versión del registro', 'Género asignado']) if (!header.includes(name)) failure(`Falta la columna ${name}.`);
    const proposals = [], errors = [], keys = new Set(); let skipped = 0;
    for (let i = 1; i < matrix.length; i++) {
      const values = matrix[i], get = key => values[header.indexOf(key)] ?? '';
      if (!values.some(value => value !== '')) continue;
      if (!String(get('Género asignado')).trim()) { skipped++; continue; }
      const row = i + 1, locationId = get('Local ID'), orderId = get('Pedido / Comanda'), parsedCategory = category(get('Género asignado'));
      const cellFormula = header.some((_, c) => sheet[XLSX.utils.encode_cell({ r: i, c })]?.f);
      if (cellFormula) { errors.push(`Fila ${row}: las asignaciones deben ser valores, no fórmulas.`); continue; }
      if (typeof orderId !== 'string' || typeof locationId !== 'string') { errors.push(`Fila ${row}: el identificador y el local deben conservarse como texto.`); continue; }
      if (!parsedCategory) { errors.push(`Fila ${row}: Género asignado debe ser ${Object.values(CATEGORIES).join(', ')}.`); continue; }
      if (!/^[a-f0-9]{64}:(?:0|[a-f0-9-]{36})$/.test(get('Versión del registro'))) { errors.push(`Fila ${row}: versión del registro inválida.`); continue; }
      const key = `${locationId}\n${orderId}`;
      if (keys.has(key)) { errors.push(`Fila ${row}: el pedido está repetido.`); continue; } keys.add(key);
      const name = String(get('Nombre corregido')).trim(), note = String(get('Observación')).trim();
      if (name.length > 160 || note.length > 1000) { errors.push(`Fila ${row}: nombre o observación demasiado extenso.`); continue; }
      proposals.push({ row, locationId, orderId, category: parsedCategory, token: get('Versión del registro'), comment: String(get('Comentario original')), name, note });
    }
    if (!proposals.length && !errors.length) failure('Completa Género asignado en al menos una fila.');
    return { proposals, errors, skipped };
  }
  const route = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 500).json({ error: error.message }); } };
  app.get('/api/sales/gender-review/options', route((req, res) => {
    const data = all(), dates = data.rows.map(r => r.date).sort();
    res.set('Cache-Control', 'no-store').json({ locations: locations(), today: today(), availableFrom: dates[0] || null, availableTo: dates.at(-1) || null, categories: CATEGORIES });
  }));
  app.get('/api/sales/gender-review', route((req, res) => {
    const data = filtered(req.query), page = Math.max(1, Number(req.query.page) || 1), limit = 50;
    if (!Number.isInteger(page)) failure('Página inválida.');
    res.set('Cache-Control', 'no-store').json({ ...data, rows: data.rows.slice((page - 1) * limit, page * limit), total: data.rows.length, page, limit, nameStates: NAME_STATES, reviewStates: REVIEW_STATES, categories: CATEGORIES });
  }));
  app.get('/api/sales/gender-review/export', route((req, res) => {
    const data = filtered(req.query);
    if (data.rows.length > 20000) failure('Selecciona un período con hasta 20.000 pedidos para exportar.');
    res.set('Cache-Control', 'no-store').attachment('revision-genero-ventas.xlsx').send(exportBook(data));
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } }).single('file');
  app.post('/api/sales/gender-review/import/preview', (req, res) => upload(req, res, error => {
    if (error) return res.status(400).json({ error: 'El archivo debe ser XLSX de hasta 10 MB.' });
    return route((req, res) => {
      if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) failure('Selecciona un archivo XLSX.');
      const parsed = parse(req.file.buffer), verified = validate(parsed.proposals, all().rows), errors = [...parsed.errors, ...verified.errors];
      if (errors.length) return res.status(400).json({ error: 'No se aplicó ningún cambio. Corrige las filas indicadas.', errors: errors.slice(0, 100), errorCount: errors.length });
      for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
      if (previews.size >= 10) previews.delete(previews.keys().next().value);
      const id = crypto.randomUUID();
      previews.set(id, { ...parsed, filename: req.file.originalname, fileHash: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), expires: Date.now() + 15 * 60 * 1000 });
      const assignments = Object.fromEntries(Object.keys(CATEGORIES).map(key => [key, 0]));
      for (const change of verified.changes) assignments[change.category]++;
      res.json({ id, filename: req.file.originalname, changes: verified.changes.length, unchanged: verified.unchanged,
        skipped: parsed.skipped, assignments, categories: CATEGORIES });
    })(req, res);
  }));
  app.post('/api/sales/gender-review/import/apply', route((req, res) => {
    const preview = previews.get(req.body?.id);
    if (!preview || preview.expires < Date.now()) failure('La vista previa venció. Carga nuevamente el archivo.', 409);
    const result = validate(preview.proposals, all().rows);
    if (result.errors.length) return res.status(409).json({ error: 'Los registros cambiaron después de la vista previa. Exporta nuevamente.', errors: result.errors.slice(0, 100) });
    const committed = store.commit(result.changes, preview); previews.delete(req.body.id);
    res.json({ ...committed, unchanged: result.unchanged, skipped: preview.skipped });
  }));
  app.get('/api/sales/gender-review/history', route((req, res) => {
    const row = all().rows.find(r => r.locationId === req.query.location && r.orderId === req.query.orderId);
    if (!row) failure('Pedido no encontrado.', 404);
    res.set('Cache-Control', 'no-store').json({ entries: store.history(row.orderKey) });
  }));
  return { rebuild: all, filtered, exportBook, store };
}
module.exports = { registerGenderReview, HEADERS };
