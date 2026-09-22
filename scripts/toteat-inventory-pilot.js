// Reproducible, read-only pilot. Existing snapshots are analyzed by default.
// --capture reads a fresh snapshot through the authenticated Toteat browser.
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { reconcileInventory, recipePilot, transformationPilot } = require('../toteat-inventory');
const { createMasterSync } = require('../toteat-masters');

function compareFiles(uploads, source, reconciliation) {
  const differences = [], missing = [], files = new Set(), cells = [];
  const mapping = source.location && source.location !== 'store-1'
    ? { 2: [source.location, 'kardex'], 3: [source.location, 'waste'] }
    : { 1: ['main-warehouse', 'kardex'], 2: ['store-1', 'kardex'], 3: ['store-1', 'waste'], 4: ['main-warehouse', 'waste'] };
  const fields = { II: 'opening', BUY: 'purchase', 'TRL-IN': 'transfer_local_in', 'MOV-IN': 'transfer_warehouse_in', 'TRN-IN': 'transformed_in', USO: 'use', 'TRL-OUT': 'transfer_local_out', 'MOV-OUT': 'transfer_warehouse_out', 'TRN-OUT': 'transformed_out', IF: 'closing', Costo: 'costLastInbound' };
  for (const warehouse of source.warehouses) {
    const [location, field] = mapping[warehouse.custom_id] || [];
    if (!location) continue;
    const base = path.join(uploads, 'transactions', location), indexFile = path.join(base, 'index.json');
    const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { fields: {} };
    const records = (index.fields[field]?.files || []).slice().sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    const control = new Map();
    for (const record of records) {
      const range = record.detectedRange || record.confirmedRange;
      if (!range || range.from > source.range.to || range.to < source.range.from) continue;
      const book = XLSX.readFile(path.join(base, record.name), { cellDates: true });
      const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: null });
      let date;
      for (let column = 3; column < (rows[0]?.length || 0); column++) {
        const value = rows[0][column];
        if (value instanceof Date) date = value.toISOString().slice(0, 10);
        else if (/^\d{2}-\d{2}-\d{4}$/.test(String(value))) date = String(value).split('-').reverse().join('-');
        if (!date || date < source.range.from || date > source.range.to) continue;
        const field = fields[String(rows[1]?.[column] || '').split(' - ')[0]];
        if (!field) continue;
        for (const row of rows.slice(2)) if (row[0] && typeof row[column] === 'number') control.set(`${row[0]}|${date}|${field}`, { value: row[column], unit: row[2], file: record.name });
      }
    }
    for (const row of reconciliation.daily.filter(r => r.warehouse === warehouse.id)) for (const field of Object.values(fields)) {
      if (row[field] == null) { missing.push({ warehouse: warehouse.name, code: row.code, date: row.date, field, reason: 'Valor propio no disponible' }); continue; }
      const original = control.get(`${row.code}|${row.date}|${field}`);
      if (!original) { missing.push({ warehouse: warehouse.name, code: row.code, date: row.date, field }); continue; }
      if (original.unit && String(original.unit).toUpperCase() !== String(row.unit).toUpperCase()) { missing.push({ warehouse: warehouse.name, code: row.code, date: row.date, field, reason: 'Unidades distintas; no se comparan cantidades incompatibles' }); continue; }
      files.add(original.file); cells.push(1);
      const delta = row[field] - original.value;
      // The XLSX export rounds costs; quantity tolerance remains 1e-6.
      if (Math.abs(delta) > (field === 'costLastInbound' ? 0.001 : 1e-6)) differences.push({ warehouse: warehouse.name, code: row.code, date: row.date, field, calculated: row[field], fileValue: original.value, delta, file: original.file });
    }
  }
  return { comparedCells: cells.length, files: [...files], differences, missing };
}

async function main() {
  const uploads = path.resolve(process.env.BREWIT_UPLOADS_ROOT || path.join(__dirname, '..', 'uploads'));
  const evidence = path.join(uploads, '.integrations', 'toteat-api', 'inventory-review-2026-09-21');
  const input = path.join(evidence, 'pilot-local1.json');
  const credentials = () => JSON.parse(fs.readFileSync(path.join(uploads, '.integrations', 'toteat-api', 'credentials.json'), 'utf8'));
  if (process.argv.includes('--capture')) {
    const { createToteatAutomation } = require('../server');
    const config = credentials()['store-1'];
    const reader = createToteatAutomation(path.join(uploads, '.integrations', 'toteat'));
    let last = 0;
    const source = await reader.readNativeSources({ restaurantId: config.restaurantId, localId: config.localId }, { from: '2026-08-23', to: '2026-08-30', onProgress: message => {
      if (Date.now() - last > 15000) { console.log(message); last = Date.now(); }
    } });
    fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
    fs.writeFileSync(input, JSON.stringify(source), { mode: 0o600 });
  }
  const source = JSON.parse(fs.readFileSync(input, 'utf8'));
  const reconciliation = reconcileInventory(source);
  const base = path.join(uploads, '.integrations', 'toteat-api', 'sales', 'store-1');
  const pointer = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'));
  const sales = JSON.parse(fs.readFileSync(path.join(base, pointer.version, 'state.json'), 'utf8'));
  const recipes = recipePilot(source, sales.payments);
  const transformations = transformationPilot(source);
  const fileComparison = compareFiles(uploads, source, reconciliation);
  const output = path.join(uploads, 'reports', 'inventory', 'pilot-2026-08-23_2026-08-30');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ capturedAt: source.capturedAt, salesVersion: pointer.version, reconciliation, recipes, transformations, fileComparison }), { mode: 0o600 });
  const names = new Map(source.warehouses.map(w => [w.id, w.name]));
  const workbook = XLSX.utils.book_new();
  const sheets = {
    'Kardex reconstruido': reconciliation.daily,
    'Tomas y diferencias': reconciliation.closures,
    'Recetas estimadas': recipes.comparisons,
    'Recetas de transformacion': transformations.comparisons,
    'Transformaciones excluidas': transformations.excluded,
    'Diferencias archivos': fileComparison.differences,
    'Cobertura archivos': fileComparison.missing,
    'Ordenes excluidas': recipes.excluded,
    'Movimientos originales': source.partitions.flatMap(p => p.rows.map((r, ordinal) => ({ ...r, ordinal })))
  };
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.map(r => ({ ...r, ...(r.warehouse ? { warehouse: names.get(r.warehouse) || r.warehouse } : {}) }))), name);
  XLSX.writeFile(workbook, path.join(output, 'Piloto_Kardex_Brewit.xlsx'));
  if (process.argv.includes('--publish-masters')) {
    const sync = createMasterSync({ uploadsRoot: uploads, credentials, activeLocation: id => ['store-1', 'store-2'].includes(id) ? { type: 'store' } : null });
    const { daily, partitions, range, ...masters } = source;
    console.log('La Concepción:', sync.publish('store-1', masters).counts);
    const lyon = path.join(evidence, 'master-local2.json');
    if (fs.existsSync(lyon)) console.log('Lyon:', sync.publish('store-2', JSON.parse(fs.readFileSync(lyon, 'utf8'))).counts);
  }
  console.log(JSON.stringify({ output, nativeReconciliationPassed: reconciliation.nativeReconciliationPassed,
    rows: reconciliation.rowCount, dailyCells: reconciliation.comparedCells, fileCells: fileComparison.comparedCells,
    fileDifferences: fileComparison.differences.length, missingFileCells: fileComparison.missing.length,
    physicalClosures: reconciliation.closures.length, countDifferences: reconciliation.closures.filter(r => Math.abs(r.countDifference) > 1e-6).length,
    recipeOrders: recipes.includedOrders, recipeSourceOrders: recipes.sourceOrders, recipeReview: recipes.comparisons.filter(r => r.status.startsWith('review') || r.status === 'unexplained').length }));
}
if (require.main === module) main().catch(() => { console.error('No se pudo completar el piloto. Se conserva la evidencia anterior; revisa las fuentes y la sesión de Toteat.'); process.exitCode = 1; });
module.exports = { compareFiles };
