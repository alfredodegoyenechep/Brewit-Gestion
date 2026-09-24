const express = require('express');
const { registerToteatApi } = require('./toteat-api');
const { readNative } = require('./toteat-native');
const { createMasterSync } = require('./toteat-masters');
const { createStockSync } = require('./toteat-stock');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildProductAnalytics, reconcileOrderLineSales } = require('./product-analytics');
const { reconcilePaymentDetail } = require('./payment-reconciliation');
const { reversalSignals } = require('./transaction-signals');
const { buildSourceDiagnostics } = require('./source-diagnostics');
const { businessClock, buildNetworkSalesDashboard } = require('./network-sales');
const { averageTicketWithVat } = require('./metric-policy');
const { buildDemandAnalysis, resolveDemandPeriod, orderMatches } = require('./demand-analysis');
const { linkOrdersToSettlements } = require('./transaction-linkage');
const { classifyRecordedName, NAME_CLASSIFIER_VERSION } = require('./name-segmentation');

const DEFAULT_PORT = 3000;
const FIRST_WEEK = '2026-05-18';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PREVIEW_MAX_ROWS = 400;
const PREVIEW_MAX_COLUMNS = 400;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx', '.txt']);
const DEFAULT_LOCATIONS = [
  { id: 'store-1', name: 'Tienda 1', type: 'store' },
  { id: 'store-2', name: 'Tienda 2', type: 'store' },
  { id: 'main-warehouse', name: 'Bodega principal', type: 'warehouse' }
];
const HEAD_OFFICE_UNIT = { id: 'head-office', name: 'Casa Matriz', label: 'Casa Matriz', type: 'head-office', status: 'active' };
const WEEK_FIELDS = ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales', 'payment-details', 'mercadopago']
  .map(name => ({ name, maxCount: 1 }));
const MASTER_FIELDS = [
  { name: 'master-catalog', maxCount: 1 },
  { name: 'product-hierarchy', maxCount: 1 },
  { name: 'ingredient-hierarchy', maxCount: 1 },
  { name: 'extras-hierarchy', maxCount: 1 },
  { name: 'master-recipes', maxCount: 1 },
  { name: 'master-suppliers', maxCount: 1 }
];
const GENERAL_EXPENSE_CATEGORIES = [
  ['rent', 'Arriendo'],
  ['commonExpenses', 'Gastos Comunes'],
  ['salaries', 'Sueldos'],
  ['salaryProvision', 'Provisión Sueldos'],
  ['basicServices', 'Cuentas Servicios Básicos'],
  ['toteat', 'TotEat'],
  ['enMedio', 'enMedio'],
  ['spotify', 'Spotify'],
  ['gntAccountingHr', 'GNT Contab y RRHH'],
  ['insurance', 'Seguros'],
  ['mediaMarketing', 'Marketing Medios'],
  ['marketingAgencySocial', 'Agencia Marketing y RRSS'],
  ['otherExpenses', 'Otros gastos'],
  ['inventoryDifference', 'Diferencia de Inventario ajustada']
];

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidWeekKey(value) {
  if (!isValidDate(value) || value < FIRST_WEEK) return false;
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1;
}

function isLegacySundayWeekKey(value) {
  return isValidDate(value) && value >= '2026-05-17' && new Date(`${value}T00:00:00.000Z`).getUTCDay() === 0;
}

function mondayForLegacySunday(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function mondayContaining(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function migratedWeekForMetadata(sourceWeek, metadata) {
  const from = metadata?.confirmedRange?.from;
  const to = metadata?.confirmedRange?.to;
  if (isValidDate(from) && isValidDate(to)) {
    const duration = (new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86400000;
    if (duration >= 0 && duration <= 13) return mondayContaining(to);
  }
  return mondayForLegacySunday(sourceWeek);
}

function rewriteMetadataWeek(metadata, targetWeek, location) {
  metadata.week = targetWeek;
  for (const value of Object.values(metadata.files || {})) {
    const records = Array.isArray(value) ? value : [value];
    for (const record of records) {
      if (record?.name) record.url = `/uploads/weeks/${targetWeek}/${location}/${encodeURIComponent(record.name)}`;
      for (const part of record?.parts || []) {
        if (part?.name) part.url = `/uploads/weeks/${targetWeek}/${location}/${encodeURIComponent(part.name)}`;
      }
    }
  }
  return metadata;
}

function migrateLegacySundayWeeks(weeksRoot) {
  for (const sourceWeek of fs.readdirSync(weeksRoot)) {
    if (!isLegacySundayWeekKey(sourceWeek)) continue;
    const sourceRoot = path.join(weeksRoot, sourceWeek);
    for (const location of fs.readdirSync(sourceRoot)) {
      const sourceLocation = path.join(sourceRoot, location);
      if (!fs.statSync(sourceLocation).isDirectory()) continue;
      const sourceMetadata = readJson(path.join(sourceLocation, 'meta.json'), { files: {} });
      const targetWeek = migratedWeekForMetadata(sourceWeek, sourceMetadata);
      const targetRoot = path.join(weeksRoot, targetWeek);
      const targetLocation = path.join(targetRoot, location);
      ensureDir(targetRoot);
      if (!fs.existsSync(targetLocation)) {
        fs.cpSync(sourceLocation, targetLocation, { recursive: true, errorOnExist: true });
        const metadataPath = path.join(targetLocation, 'meta.json');
        const metadata = readJson(metadataPath, null);
        if (metadata) {
          writeJsonAtomic(metadataPath, rewriteMetadataWeek(metadata, targetWeek, location));
        }
        continue;
      }
      const targetMetadataPath = path.join(targetLocation, 'meta.json');
      const targetMetadata = readJson(targetMetadataPath, { files: {} });
      for (const filename of fs.readdirSync(sourceLocation).filter(name => name !== 'meta.json')) {
        const sourceFile = path.join(sourceLocation, filename);
        const targetFile = path.join(targetLocation, filename);
        if (!fs.existsSync(targetFile)) fs.copyFileSync(sourceFile, targetFile);
      }
      const sourceIsNewer = String(sourceMetadata.uploadedAt || '') > String(targetMetadata.uploadedAt || '');
      const olderMetadata = sourceIsNewer ? targetMetadata : sourceMetadata;
      const newerMetadata = sourceIsNewer ? sourceMetadata : targetMetadata;
      writeJsonAtomic(targetMetadataPath, rewriteMetadataWeek({
        ...olderMetadata,
        ...newerMetadata,
        files: { ...(olderMetadata.files || {}), ...(newerMetadata.files || {}) }
      }, targetWeek, location));
    }
  }
}

function fieldsForLocation(type) {
  return type === 'warehouse'
    ? ['kardex', 'waste']
    : ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales', 'payment-details', 'mercadopago'];
}

function safeFilename(file) {
  const original = path.basename(file.originalname).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}_${file.fieldname}_${original}`;
}

function fileFilter(req, file, callback) {
  if (!ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
    return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  callback(null, true);
}

function uploadedFiles(req) {
  return Object.values(req.files || {}).flat();
}

function removeFiles(files) {
  for (const file of files) {
    if (file && file.path) fs.rmSync(file.path, { force: true });
  }
}

function removeStoredRecords(root, records) {
  const list = Array.isArray(records) ? records : [records];
  for (const record of list) {
    if (Array.isArray(record?.parts)) removeStoredRecords(root, record.parts);
    if (!record || !record.name) continue;
    const resolved = path.resolve(root, record.name);
    if (path.dirname(resolved) === path.resolve(root)) fs.rmSync(resolved, { force: true });
  }
}

function describeFile(file, urlPrefix) {
  return {
    name: file.filename,
    originalName: file.originalname,
    size: file.size,
    url: `${urlPrefix}/${encodeURIComponent(file.filename)}`
  };
}

function multerErrorMessage(error) {
  if (error.code === 'LIMIT_FILE_SIZE') return `Each file must be ${MAX_FILE_SIZE / 1024 / 1024} MB or smaller.`;
  if (error.code === 'LIMIT_UNEXPECTED_FILE') return 'Only CSV, XLS, XLSX, and TXT files are accepted in the expected fields.';
  return error.message;
}

function toIsoDate(year, month, day) {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidDate(value) && year >= 2020 && year <= 2100 ? value : null;
}

function localizedDate(year, first, second, dateOrder = 'dmy') {
  let day = dateOrder === 'mdy' ? second : first;
  let month = dateOrder === 'mdy' ? first : second;
  if (first > 12 && second <= 12) {
    day = first;
    month = second;
  } else if (second > 12 && first <= 12) {
    day = second;
    month = first;
  }
  return toIsoDate(year, month, day);
}

function dateOrderForHeaders(headers = []) {
  const normalized = headers.map(normalizeHeader);
  return normalized.some(header => ['dateclosing', 'date closing', 'closing date'].includes(header)) ? 'mdy' : 'dmy';
}

function datesInText(value, dateOrder = 'dmy') {
  const text = String(value || '');
  const dates = [];
  for (const match of text.matchAll(/(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) {
    const parsed = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (parsed) dates.push(parsed);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)/g)) {
    const parsed = localizedDate(Number(match[3]), Number(match[1]), Number(match[2]), dateOrder);
    if (parsed) dates.push(parsed);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/g)) {
    const parsed = localizedDate(2000 + Number(match[3]), Number(match[1]), Number(match[2]), dateOrder);
    if (parsed) dates.push(parsed);
  }
  return dates;
}

function datesInFilename(filename) {
  const dates = datesInText(filename);
  for (const match of filename.matchAll(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?=\D|$)/g)) {
    const parsed = toIsoDate(2000 + Number(match[3]), Number(match[2]), Number(match[1]));
    if (parsed) dates.push(parsed);
  }
  return dates;
}

function detectFileDateRange(file) {
  const dates = new Set(datesInFilename(file.originalname));
  try {
    const workbook = XLSX.readFile(file.path, { cellDates: true });
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false });
      const dateOrder = dateOrderForHeaders(rows.slice(0, 5).flat());
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith('!')) continue;
        if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
          const parsed = toIsoDate(cell.v.getUTCFullYear(), cell.v.getUTCMonth() + 1, cell.v.getUTCDate());
          if (parsed) dates.add(parsed);
        } else if (typeof cell.v === 'string') {
          datesInText(cell.v, dateOrder).forEach(date => dates.add(date));
        }
        if (typeof cell.w === 'string') datesInText(cell.w, dateOrder).forEach(date => dates.add(date));
      }
    }
  } catch (error) {
    // Filename detection still provides a useful fallback for unusual exports.
  }
  const sorted = [...dates].sort();
  return sorted.length ? { from: sorted[0], to: sorted.at(-1) } : null;
}

const UPLOAD_STRUCTURE_LABELS = {
  kardex: 'Kardex / tarjeta de inventario',
  waste: 'Merma',
  marketing: 'Consumo de marketing',
  employees: 'Consumo de colaboradores',
  purchases: 'Compras',
  sales: 'Transacciones de venta',
  'payment-details': 'Detalle Pagos',
  mercadopago: 'Transacciones MercadoPago',
  'master-catalog': 'Maestro Productos / Ingredientes / Extras',
  'product-hierarchy': 'Jerarquía Productos',
  'ingredient-hierarchy': 'Jerarquía Ingredientes',
  'extras-hierarchy': 'Jerarquía Extras',
  'master-recipes': 'Maestro de recetas',
  'master-suppliers': 'Maestro Proveedores',
  inventory: 'un archivo Kardex o Merma',
  consumption: 'una planilla de consumo',
  unknown: 'una estructura no reconocida'
};

function workbookStructure(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return workbook.SheetNames.map(name => ({
    name,
    normalizedName: normalizeHeader(name),
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false
    }).slice(0, 10)
  }));
}

function normalizedRow(row) {
  return (row || []).map(value => normalizeHeader(value));
}

function rowContainsAll(row, required) {
  const cells = new Set(normalizedRow(row));
  return required.every(value => cells.has(normalizeHeader(value)));
}

function structureHasHeader(sheets, required) {
  return sheets.some(sheet => sheet.rows.slice(0, 5).some(row => rowContainsAll(row, required)));
}

function detectUploadStructure(file) {
  let sheets;
  try {
    sheets = workbookStructure(file.path);
  } catch {
    return { field: 'unknown', invalidFile: true, reason: 'El archivo no pudo leerse como CSV, XLS, XLSX o TXT.' };
  }
  if (!sheets.length || !sheets.some(sheet => sheet.rows.length)) {
    return { field: 'unknown', invalidFile: true, reason: 'El archivo está vacío.' };
  }
  if (structureHasHeader(sheets, ['ID de orden', 'Fecha de creacion', 'Pago total'])) {
    return { field: 'sales', reason: 'Se detectaron columnas de órdenes, fecha de creación y pago total.' };
  }
  if (structureHasHeader(sheets, ['FechaCierre', 'Comanda', 'Comentario General'])) {
    return {
      field: 'payment-details',
      dateOrder: 'dmy',
      reason: 'Se detectaron los encabezados en español de Detalle Pagos; sus fechas se interpretan como día/mes/año.'
    };
  }
  if (structureHasHeader(sheets, ['DateClosing', 'Ticket', 'General Comment'])) {
    return {
      field: 'payment-details',
      dateOrder: 'mdy',
      reason: 'Se detectaron los encabezados en inglés de Detalle Pagos; sus fechas se interpretan como mes/día/año.'
    };
  }
  if (structureHasHeader(sheets, ['Fecha emisión', 'Documento', 'Proveedor/Para', 'PRODUCTO'])
    || structureHasHeader(sheets, ['Broadcast date', 'Document', 'Supplier/To', 'PRODUCT'])) {
    return { field: 'purchases', reason: 'Se detectaron columnas de fecha de emisión, proveedor, documento y producto.' };
  }
  const inventorySheet = sheets.find(sheet => {
    const first = sheet.rows[0] || [];
    const second = normalizedRow(sheet.rows[1]);
    return rowContainsAll(first, ['Código', 'Nombre', 'Unidad'])
      && first.slice(3).some(value => cellDate(value))
      && second.some(value => value.startsWith('ii - inventario inicial'))
      && second.some(value => value.startsWith('if - inventario final'));
  });
  if (inventorySheet) {
    const filename = normalizeHeader(file.originalname);
    if (/\bbme\b|merma/.test(filename)) {
      return { field: 'waste', family: 'inventory', reason: 'La estructura es de Kardex y el nombre identifica una carga de Merma.' };
    }
    if (/\bblc\b|\bbce\b|kardex/.test(filename)) {
      return { field: 'kardex', family: 'inventory', reason: 'Se detectó la estructura diaria de Kardex.' };
    }
    return { field: 'inventory', family: 'inventory', reason: 'Se detectó una estructura común de Kardex/Merma.' };
  }
  if (structureHasHeader(sheets, ['Id Producto', 'Id Ingrediente', 'Cantidad Ingrediente', 'Unidad Medida'])) {
    return { field: 'master-recipes', reason: 'Se detectaron columnas de producto, ingrediente, cantidad y unidad de receta.' };
  }
  if (structureHasHeader(sheets, ['Nombre*', 'RUT/Fiscal ID*'])) {
    return { field: 'master-suppliers', reason: 'Se detectaron las columnas de nombre y RUT de proveedores.' };
  }
  const hierarchySheet = sheets.find(sheet =>
    structureHasHeader([sheet], ['ID Jerarquia', 'ID Nodo **', 'ID nodo padre'])
    || structureHasHeader([sheet], ['Hierarchy ID', 'Node ID **', 'Parent node ID'])
  );
  if (hierarchySheet) {
    const identifiers = hierarchySheet.rows.slice(1).map(row => String(row[0] || '').trim().toUpperCase());
    if (identifiers.some(value => value.startsWith('AB.'))) return { field: 'product-hierarchy', reason: 'Se detectaron nodos de jerarquía AB.' };
    if (identifiers.some(value => value.startsWith('IC.'))) return { field: 'ingredient-hierarchy', reason: 'Se detectaron nodos de jerarquía IC.' };
    if (identifiers.some(value => value.startsWith('BA.'))) return { field: 'extras-hierarchy', reason: 'Se detectaron nodos de jerarquía BA.' };
    return { field: 'unknown', reason: 'La jerarquía no contiene identificadores AB, IC o BA reconocibles.' };
  }
  const consumptionSheet = sheets.find(sheet => {
    const dateCount = (sheet.rows[0] || []).filter(value => cellDate(value)).length;
    return dateCount > 0 && sheet.rows.slice(0, 3).some(row => rowContainsAll(row, ['ID Producto **', 'Nombre Producto *']));
  });
  if (consumptionSheet) {
    const hint = normalizeHeader(`${file.originalname} ${sheets.map(sheet => sheet.name).join(' ')}`);
    if (/beneficio|colaborador|empleado|equipo/.test(hint)) {
      return { field: 'employees', family: 'consumption', reason: 'La planilla contiene fechas por producto y referencias a colaboradores/equipo.' };
    }
    if (/marketing|coffee break|coffe break/.test(hint)) {
      return { field: 'marketing', family: 'consumption', reason: 'La planilla contiene fechas por producto y referencias a marketing/coffee break.' };
    }
    return { field: 'consumption', family: 'consumption', reason: 'Se detectó una estructura común de consumos por producto y fecha.' };
  }
  if (structureHasHeader(sheets, ['ID Producto **', 'Nombre Producto *', 'Costo'])) {
    return { field: 'master-catalog', reason: 'Se detectaron columnas de código, nombre y costo del catálogo.' };
  }
  return { field: 'unknown', reason: 'No se encontraron los encabezados u hojas esperados para ninguna categoría.' };
}

function validateUploadStructure(file) {
  const expected = file.fieldname;
  const detected = detectUploadStructure(file);
  if (expected === 'payment-details' && detected.invalidFile) {
    return {
      ok: false,
      expected,
      detected: detected.field,
      error: `El archivo seleccionado como ${UPLOAD_STRUCTURE_LABELS[expected]} no es una planilla legible o está vacío.`,
      reason: detected.reason
    };
  }
  if (expected === 'mercadopago') {
    return {
      ok: true,
      permissive: true,
      expected,
      detected: detected.field,
      reason: 'Aceptado sin validación estructural porque aún no existe un archivo MercadoPago de referencia.'
    };
  }
  if (expected === 'payment-details') {
    if (detected.field === expected) {
      return { ok: true, expected, detected: detected.field, dateOrder: detected.dateOrder, reason: detected.reason };
    }
    return {
      ok: true,
      permissive: true,
      expected,
      detected: detected.field,
      reason: `Se verificó que la planilla de ${UPLOAD_STRUCTURE_LABELS[expected]} es legible. Sus encabezados quedarán disponibles para definir análisis posteriores.`
    };
  }
  const inventoryFields = ['kardex', 'waste'];
  const expectedInventory = inventoryFields.includes(expected);
  const detectedInventory = [...inventoryFields, 'inventory'].includes(detected.field);
  if (expectedInventory && detectedInventory) {
    return {
      ok: true,
      permissive: true,
      requiresCategoryConfirmation: true,
      expected,
      detected: detected.field,
      reason: `Kardex y Merma comparten la misma estructura. Confirma que “${file.originalname}” es el archivo correcto para cargar como ${UPLOAD_STRUCTURE_LABELS[expected]}.`
    };
  }
  const sharedConsumption = ['marketing', 'employees'].includes(expected) && detected.field === 'consumption';
  if (detected.field === expected || sharedConsumption) {
    return { ok: true, expected, detected: detected.field, reason: detected.reason };
  }
  return {
    ok: false,
    expected,
    detected: detected.field,
    reason: detected.reason,
    error: `El archivo “${file.originalname}” fue seleccionado como ${UPLOAD_STRUCTURE_LABELS[expected] || expected}, pero parece corresponder a ${UPLOAD_STRUCTURE_LABELS[detected.field] || detected.field}. ${detected.reason}`
  };
}

function filterPreviewRowsByDate(allRows, field, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return allRows;
  if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
    throw new Error('Selecciona un rango de fechas válido para la previsualización.');
  }
  if (!allRows.length) return allRows;
  if (['kardex', 'waste'].includes(field)) {
    const dateHeader = allRows[0] || [];
    const groups = [];
    for (let column = 0; column < dateHeader.length; column += 1) {
      const date = cellDate(dateHeader[column]);
      if (date) groups.push({ date, startColumn: column });
    }
    if (!groups.length) return allRows;
    const keepColumns = new Set(Array.from({ length: groups[0].startColumn }, (_, column) => column));
    groups.forEach((group, index) => {
      if (group.date < dateFrom || group.date > dateTo) return;
      const endColumn = groups[index + 1]?.startColumn ?? Math.max(...allRows.map(row => row.length));
      for (let column = group.startColumn; column < endColumn; column += 1) keepColumns.add(column);
    });
    const selected = [...keepColumns].sort((left, right) => left - right);
    return allRows.map(row => selected.map(column => row[column] ?? ''));
  }
  if (['marketing', 'employees'].includes(field)) {
    const width = Math.max(...allRows.map(row => row.length));
    const columnDates = Array.from({ length: width }, (_, column) => {
      for (const row of allRows.slice(0, 5)) {
        const date = cellDate(row[column]);
        if (date) return date;
      }
      return null;
    });
    if (!columnDates.some(Boolean)) return allRows;
    const selected = columnDates.flatMap((date, column) =>
      !date || (date >= dateFrom && date <= dateTo) ? [column] : []);
    return allRows.map(row => selected.map(column => row[column] ?? ''));
  }
  return allRows;
}

function previewFrozenRowCount(rows, field) {
  if (!rows.length) return 0;
  if (['kardex', 'waste'].includes(field)) return Math.min(2, rows.length);
  if (rows.length < 2) return 1;
  const headerPattern = /(?:id\s+producto|nombre\s+producto|id\s+ingrediente|id\s+jerarquia|id\s+jerarquía|fecha\s+emision|fecha\s+emisión|id\s+de\s+orden)/i;
  const firstLooksLikeHeader = rows[0].some(value => headerPattern.test(String(value ?? '')));
  const secondLooksLikeHeader = rows[1].some(value => headerPattern.test(String(value ?? '')));
  return secondLooksLikeHeader && !firstLooksLikeHeader ? 2 : 1;
}

function buildSpreadsheetPreview(filePath, originalName, options = {}) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheets = workbook.SheetNames.map(sheetName => {
    const sourceRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      dateNF: 'yyyy-mm-dd',
      blankrows: false
    });
    const allRows = filterPreviewRowsByDate(
      sourceRows,
      options.field,
      options.dateFrom,
      options.dateTo
    );
    return {
      name: sheetName,
      rows: options.complete ? allRows : allRows.slice(0, PREVIEW_MAX_ROWS).map(row => row.slice(0, PREVIEW_MAX_COLUMNS)),
      totalRows: allRows.length,
      frozenRows: previewFrozenRowCount(allRows, options.field),
      truncated: !options.complete && (allRows.length > PREVIEW_MAX_ROWS || allRows.some(row => row.length > PREVIEW_MAX_COLUMNS))
    };
  });
  return {
    originalName,
    selectedRange: options.dateFrom && options.dateTo
      ? { from: options.dateFrom, to: options.dateTo }
      : null,
    sheets
  };
}

function buildCombinedSalesPreview(destination, record) {
  const rows = [];
  let totalDataRows = 0;
  let hasWideRows = false;
  for (const part of salesRecordParts(record)) {
    const filePath = path.resolve(destination, part.name);
    if (path.dirname(filePath) !== path.resolve(destination) || !fs.existsSync(filePath)) continue;
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const allRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
      raw: false,
      dateNF: 'yyyy-mm-dd hh:mm:ss',
      blankrows: false
    });
    if (!allRows.length) continue;
    if (allRows.some(row => row.length > PREVIEW_MAX_COLUMNS)) hasWideRows = true;
    if (!rows.length) rows.push(allRows[0].slice(0, PREVIEW_MAX_COLUMNS));
    totalDataRows += Math.max(0, allRows.length - 1);
    for (const row of allRows.slice(1)) {
      if (rows.length >= PREVIEW_MAX_ROWS) break;
      rows.push(row.slice(0, PREVIEW_MAX_COLUMNS));
    }
  }
  return {
    originalName: record.originalName || 'Transacciones de venta',
    sheets: [{
      name: 'Ventas consolidadas',
      rows,
      totalRows: totalDataRows + (rows.length ? 1 : 0),
      frozenRows: rows.length ? 1 : 0,
      truncated: totalDataRows > PREVIEW_MAX_ROWS - 1 || hasWideRows
    }]
  };
}

function parseKardexWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: false });
  if (rows.length < 3) throw new Error('Kardex does not contain the expected headers and product rows.');
  const dateHeader = rows[0];
  const metricHeader = rows[1];
  const groups = [];
  for (let column = 3; column < dateHeader.length; column += 1) {
    const date = cellDate(dateHeader[column]);
    if (date) groups.push({ date, startColumn: column, metrics: [] });
  }
  if (groups.length < 1) throw new Error('Kardex must contain a dated inventory group.');
  groups.forEach((group, index) => {
    const endColumn = groups[index + 1]?.startColumn ?? Math.max(dateHeader.length, metricHeader.length);
    for (let column = group.startColumn; column < endColumn; column += 1) {
      const label = String(metricHeader[column] || '').trim();
      if (label) group.metrics.push({ column, label, normalized: normalizeHeader(label) });
    }
  });
  const movementDefinitions = [];
  const seenMovementKeys = new Set();
  for (const group of groups) {
    for (const metric of group.metrics) {
      if (/^(ii\s*-|if\s*-|costo$)/i.test(metric.normalized)) continue;
      const key = metric.normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!seenMovementKeys.has(key)) {
        seenMovementKeys.add(key);
        movementDefinitions.push({ key, label: metric.label });
      }
    }
  }
  const products = rows.slice(2)
    .filter(row => row[0] !== null || row[1] !== null)
    .map(row => ({ row, code: String(row[0] ?? '').trim(), name: String(row[1] ?? '').trim(), unit: String(row[2] ?? '').trim() }));
  return { sheetName: workbook.SheetNames[0], groups, movementDefinitions, products };
}

function kardexMetricValue(product, group, matcher) {
  const metric = group.metrics.find(item => matcher(item.normalized));
  return metric ? numericValue(product.row[metric.column]) || 0 : 0;
}

function kardexMetricTotal(product, group, matcher) {
  return group.metrics
    .filter(item => matcher(item.normalized))
    .reduce((sum, metric) => sum + Math.abs(numericValue(product.row[metric.column]) || 0), 0);
}

function kardexMovementDirection(definition) {
  const key = definition.key;
  if (key.startsWith('uso-') || key.startsWith('trl-out-') || key.startsWith('mov-out-') || key.startsWith('trn-out-')) return -1;
  return 1;
}

function buildKardexInventoryReport(parsed, dateFrom, dateTo, selection = null) {
  const dates = parsed.groups.map(group => group.date);
  if (selection) {
    const initialGroup = parsed.groups.find(group => group.date === selection.initialDate);
    const finalGroup = parsed.groups.find(group => group.date === selection.finalDate);
    const selectedGroups = parsed.groups.filter(group => group.date >= dateFrom && group.date <= dateTo);
    if (!initialGroup) throw new Error(`La fecha de inventario inicial ${selection.initialDate} no existe en el Kardex.`);
    if (!finalGroup) throw new Error(`La fecha de inventario final ${selection.finalDate} no existe en el Kardex.`);
    if (!selectedGroups.length || dateFrom > dateTo) throw new Error('El rango de movimientos no contiene fechas disponibles en el Kardex.');
    if (!['initial', 'final'].includes(selection.initialBasis) || !['initial', 'final'].includes(selection.finalBasis)) {
      throw new Error('Selecciona Inventario Inicial o Inventario Final para ambos saldos.');
    }
    const metricMatcher = basis => basis === 'initial'
      ? metric => metric.startsWith('ii -')
      : metric => metric.startsWith('if -');
    const items = parsed.products.map(product => {
      const movements = Object.fromEntries(parsed.movementDefinitions.map(definition => {
        const total = selectedGroups.reduce((sum, group) => sum + kardexMetricValue(product, group, metric => {
          const key = metric.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          return key === definition.key;
        }), 0);
        return [definition.key, total];
      }));
      const initialInventory = kardexMetricValue(product, initialGroup, metricMatcher(selection.initialBasis));
      const theoreticalFinal = parsed.movementDefinitions.reduce((balance, definition) =>
        balance + kardexMovementDirection(definition) * movements[definition.key], initialInventory);
      const finalInventory = kardexMetricValue(product, finalGroup, metricMatcher(selection.finalBasis));
      return {
        code: product.code,
        name: product.name,
        unit: product.unit,
        initialInventory,
        movements,
        theoreticalFinal,
        finalInventory,
        difference: finalInventory - theoreticalFinal
      };
    });
    return {
      dateFrom,
      dateTo,
      selection,
      movementDefinitions: parsed.movementDefinitions,
      itemCount: items.length,
      items
    };
  }
  const fromIndex = dates.indexOf(dateFrom);
  const toIndex = dates.indexOf(dateTo);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) throw new Error('Select dates that exist in the Kardex.');
  if (toIndex >= dates.length - 1) throw new Error('The final date must be earlier than the last Kardex date.');
  const selectedGroups = parsed.groups.slice(fromIndex, toIndex + 1);
  const startGroup = parsed.groups[fromIndex];
  const endGroup = parsed.groups[toIndex];
  const physicalGroup = parsed.groups[toIndex + 1];
  const items = parsed.products.map(product => {
    const movements = Object.fromEntries(parsed.movementDefinitions.map(definition => {
      const total = selectedGroups.reduce((sum, group) => sum + kardexMetricValue(product, group, metric => {
        const key = metric.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return key === definition.key;
      }), 0);
      return [definition.key, total];
    }));
    const initialInventory = kardexMetricValue(product, startGroup, metric => metric.startsWith('ii -'));
    const theoreticalFinal = kardexMetricValue(product, endGroup, metric => metric.startsWith('if -'));
    const physicalFinal = kardexMetricValue(product, physicalGroup, metric => metric.startsWith('ii -'));
    return {
      code: product.code,
      name: product.name,
      unit: product.unit,
      initialInventory,
      movements,
      theoreticalFinal,
      physicalFinal,
      difference: physicalFinal - theoreticalFinal
    };
  });
  return {
    dateFrom,
    dateTo,
    physicalInventoryDate: physicalGroup.date,
    movementDefinitions: parsed.movementDefinitions,
    itemCount: items.length,
    items
  };
}

function buildCurrentTheoreticalInventoryReport(parsed, referenceDate, catalog, assignments, hierarchyLookups, costResolver = null) {
  const latestGroup = parsed.groups.filter(group => group.date <= referenceDate).at(-1);
  if (!latestGroup) throw new Error(`No hay un saldo de Kardex disponible al ${referenceDate} o en una fecha anterior.`);
  const usesFinalInventory = latestGroup.metrics.some(metric => metric.normalized.startsWith('if -'));
  const categoryLabels = { product: 'Productos', ingredient: 'Ingredientes', extra: 'Extras' };
  const items = parsed.products.map(product => {
    const codeKey = String(product.code || '').toUpperCase();
    const quantity = kardexMetricValue(product, latestGroup,
      metric => metric.startsWith(usesFinalInventory ? 'if -' : 'ii -'));
    const catalogItem = catalog?.get(product.code) || catalog?.get(codeKey);
    const costReference = costResolver?.resolve(product.code, product.unit, catalogItem)
      || { unitCost: unitCostForRecipeUnit(catalogItem, product.unit) ?? 0, source: 'master', sourceDate: null };
    const assignment = assignments?.get(codeKey);
    const category = categoryLabels[assignment?.type];
    const nestedPath = assignment?.hierarchyId
      ? hierarchyLookups?.[assignment.type]?.pathFor(assignment.hierarchyId) || []
      : [];
    const hierarchyPath = category
      ? [category, ...(nestedPath.length ? nestedPath : ['Sin jerarquía'])]
      : ['Sin jerarquía'];
    const unitCost = costReference.unitCost;
    return {
      code: product.code,
      name: product.name,
      unit: product.unit,
      hierarchyPath,
      quantity,
      unitCost,
      costSource: costReference.source,
      costSourceDate: costReference.sourceDate,
      costAvailable: costReference.source !== 'missing',
      valuation: quantity * unitCost
    };
  }).sort((left, right) => left.hierarchyPath.join('\u001f').localeCompare(right.hierarchyPath.join('\u001f'), 'es', { sensitivity: 'base' })
    || left.name.localeCompare(right.name, 'es', { sensitivity: 'base' })
    || left.code.localeCompare(right.code, 'es', { numeric: true }));
  return {
    date: latestGroup.date,
    balanceBasis: usesFinalInventory ? 'final' : 'initial',
    itemCount: items.length,
    hierarchyCount: new Set(items.map(item => item.hierarchyPath.join('\u001f'))).size,
    itemsWithoutCost: items.filter(item => !item.costAvailable).map(item => item.code || item.name),
    totalValue: items.reduce((sum, item) => sum + item.valuation, 0),
    items
  };
}

function buildWasteSummary(parsed, dateFrom, dateTo, catalog = null, costResolver = null) {
  const selectedGroups = parsed.groups.filter(group => group.date >= dateFrom && group.date <= dateTo);
  if (!dateFrom || !dateTo || dateFrom > dateTo || !selectedGroups.length) {
    throw new Error('Selecciona un período válido disponible en el archivo de Merma.');
  }
  const additionDefinitions = parsed.movementDefinitions.filter(definition =>
    /^buy\s*-/i.test(definition.label) || /(?:^|-)in(?:-|$)/i.test(definition.key)
  );
  const items = parsed.products.map(product => {
    const additions = Object.fromEntries(additionDefinitions.map(definition => {
      const total = selectedGroups.reduce((sum, group) => sum + kardexMetricValue(product, group, metric => {
        const key = metric.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return key === definition.key;
      }), 0);
      return [definition.key, total];
    }));
    const catalogItem = catalog?.get(product.code);
    const costReference = costResolver?.resolve(product.code, product.unit, catalogItem)
      || { unitCost: unitCostForRecipeUnit(catalogItem, product.unit) ?? 0, source: 'master', sourceDate: null };
    const unitCost = costReference.unitCost;
    const total = Object.values(additions).reduce((sum, value) => sum + value, 0);
    return {
      code: product.code,
      name: product.name,
      unit: product.unit,
      additions,
      total,
      unitCost,
      costSource: costReference.source,
      costSourceDate: costReference.sourceDate,
      totalCost: total * unitCost,
      costAvailable: costReference.source !== 'missing'
    };
  }).filter(item => Math.abs(item.total) > 0.0000001)
    .sort((left, right) => right.total - left.total || left.name.localeCompare(right.name, 'es'));
  const additionTotals = Object.fromEntries(additionDefinitions.map(definition => [
    definition.key,
    items.reduce((sum, item) => sum + item.additions[definition.key], 0)
  ]));
  return {
    dateFrom,
    dateTo,
    additionDefinitions,
    additionTotals,
    totalAdditions: items.reduce((sum, item) => sum + item.total, 0),
    totalCost: items.reduce((sum, item) => sum + item.totalCost, 0),
    itemsWithoutCost: items.filter(item => !item.costAvailable).map(item => item.code || item.name),
    itemCount: items.length,
    items
  };
}

function leadingQuantity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').trim().match(/^-?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : 0;
}

function findHeaderColumn(headers, names) {
  const wanted = new Set(names.map(normalizeHeader));
  return headers.findIndex(header => wanted.has(normalizeHeader(header)));
}

function consumptionProductSheets(workbook) {
  const candidates = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    if (rows.length < 3) continue;
    const headers = rows[1] || [];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto', 'Id Producto']);
    const nameColumn = findHeaderColumn(headers, ['Nombre Producto *', 'Nombre Producto', 'Nombre Producto*']);
    const costColumn = findHeaderColumn(headers, ['Costo']);
    if (codeColumn < 0 || nameColumn < 0) continue;
    const dateColumns = (rows[0] || []).map((value, column) => ({ date: cellDate(value), column }))
      .filter(item => item.date);
    candidates.push({ sheetName, rows, codeColumn, nameColumn, costColumn, dateColumns });
  }
  return candidates;
}

function parseConsumptionProductsFromSheets(candidates, dateFrom, dateTo) {
  const selected = candidates.map(candidate => {
    const dateColumns = candidate.dateColumns.filter(item => item.date >= dateFrom && item.date <= dateTo);
    return { ...candidate, dateColumns, score: dateColumns.length * 100 + (/prod|producto/i.test(candidate.sheetName) ? 10 : 0) };
  }).sort((left, right) => right.score - left.score)[0];
  if (!selected?.dateColumns.length) {
    throw new Error(`No product sheet contains dates between ${dateFrom} and ${dateTo}.`);
  }
  const products = selected.rows.slice(2).flatMap(row => {
    const code = String(row[selected.codeColumn] ?? '').trim();
    const name = String(row[selected.nameColumn] ?? '').trim();
    if (!code && !name) return [];
    const quantity = selected.dateColumns.reduce((sum, item) => sum + leadingQuantity(row[item.column]), 0);
    if (!quantity) return [];
    const unitCost = selected.costColumn >= 0 ? numericValue(row[selected.costColumn]) || 0 : 0;
    return [{ code, name, unit: 'UN', quantity, unitCost, totalCost: quantity * unitCost }];
  });
  return {
    sheetName: selected.sheetName,
    datesProcessed: selected.dateColumns.map(item => item.date),
    products,
    totalQuantity: products.reduce((sum, product) => sum + product.quantity, 0),
    totalCost: products.reduce((sum, product) => sum + product.totalCost, 0)
  };
}

function parseConsumptionProducts(filePath, dateFrom, dateTo) {
  return parseConsumptionProductsFromSheets(
    consumptionProductSheets(XLSX.readFile(filePath, { cellDates: true })), dateFrom, dateTo
  );
}

function parseRecipes(filePath) {
  let rows;
  if (['.txt', '.tsv'].includes(path.extname(filePath).toLowerCase())) {
    const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    const headers = (lines.shift() || '').split('\t');
    rows = lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
  } else {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
  }
  const recipes = new Map();
  for (const row of rows) {
    const productId = String(rowValue(row, ['Id Producto', 'ID Producto']) ?? '').trim();
    const ingredientId = String(rowValue(row, ['Id Ingrediente', 'ID Ingrediente']) ?? '').trim();
    if (!productId || !ingredientId) continue;
    const quantity = numericValue(rowValue(row, ['Cantidad Ingrediente'])) || 0;
    const yieldRate = numericValue(rowValue(row, ['Tasa Rendimiento'])) || 100;
    const recipe = {
      ingredientId,
      ingredientName: String(rowValue(row, ['Nombre Ingrediente*', 'Nombre Ingrediente']) ?? '').trim(),
      quantity,
      unit: String(rowValue(row, ['Unidad Medida']) ?? '').trim(),
      yieldRate
    };
    if (!recipes.has(productId)) recipes.set(productId, []);
    recipes.get(productId).push(recipe);
  }
  return recipes;
}

function parseIngredientCatalog(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const catalog = new Map();
  const sheetNames = workbook.SheetNames.filter(name => /^prod|producto|^ingr|ingred|^extr/i.test(name));
  if (!sheetNames.length) throw new Error('The master catalog does not contain product, ingredient, or extras sheets.');
  for (const sheetName of sheetNames) {
    const type = /^prod|producto/i.test(sheetName) ? 'product'
      : /^ingr|ingred/i.test(sheetName) ? 'ingredient' : 'extra';
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto']);
    const nameColumn = findHeaderColumn(headers, ['Nombre Producto *', 'Nombre Producto']);
    const costColumn = findHeaderColumn(headers, ['Costo']);
    const unitColumn = findHeaderColumn(headers, ['Medida Base', 'Unidad Base', 'Unidad de Reportes']);
    const activeColumn = findHeaderColumn(headers, ['Activo']);
    const stockColumn = findHeaderColumn(headers, ['Control de Stocks Activado', 'wact']);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code) continue;
      catalog.set(code, {
        code,
        name: String(row[nameColumn] ?? '').trim(),
        unit: String(row[unitColumn] ?? '').trim(),
        unitCost: numericValue(row[costColumn]) || 0,
        type,
        active: activeColumn < 0 || numericValue(row[activeColumn]) !== 0,
        stockManaged: stockColumn < 0 || row[stockColumn] == null ? null
          : /^(1|true|si|sí)$/i.test(String(row[stockColumn]).trim()) ? true
            : /^(0|false|no)$/i.test(String(row[stockColumn]).trim()) ? false : null
      });
    }
  }
  return catalog;
}

function parsePurchaseUnitConversions(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const catalog = new Map();
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false
    });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const labels = rows[headerIndex];
    const technical = rows[Math.max(0, headerIndex - 1)] || [];
    const codeColumn = findHeaderColumn(labels, ['ID Producto **', 'ID Producto']);
    const baseUnitColumn = findHeaderColumn(labels, ['Unidad Base', 'Medida Base']);
    const conversionGroups = technical.flatMap((header, column) => {
      const match = String(header || '').match(/^conv\.(\d+)\.umed$/i);
      if (!match) return [];
      const prefix = `conv.${match[1]}.`;
      return [{
        unitColumn: column,
        baseUnitColumn: technical.findIndex(value => String(value).toLowerCase() === `${prefix}umedb`),
        numeratorColumn: technical.findIndex(value => String(value).toLowerCase() === `${prefix}cnum`),
        denominatorColumn: technical.findIndex(value => String(value).toLowerCase() === `${prefix}cden`)
      }];
    });
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code) continue;
      const baseUnit = String(row[baseUnitColumn] ?? '').trim();
      const conversions = new Map();
      for (const group of conversionGroups) {
        const purchaseUnit = String(row[group.unitColumn] ?? '').trim();
        const numerator = numericValue(row[group.numeratorColumn]);
        const denominator = numericValue(row[group.denominatorColumn]);
        if (!purchaseUnit || !(numerator > 0) || !(denominator > 0)) continue;
        conversions.set(normalizedUnit(purchaseUnit), {
          purchaseUnit,
          baseUnit: String(row[group.baseUnitColumn] ?? '').trim() || baseUnit,
          unitsPerPurchaseUnit: numerator / denominator
        });
      }
      catalog.set(code.toUpperCase(), { code, baseUnit, conversions });
    }
  }
  return catalog;
}

function applyCatalogProductCosts(result, catalog, costResolver = null) {
  const productsWithoutMasterCost = [];
  const products = result.products.map(product => {
    const catalogItem = catalog.get(product.code);
    const costReference = costResolver?.resolve(product.code, product.unit, catalogItem)
      || { unitCost: unitCostForRecipeUnit(catalogItem, product.unit) ?? product.unitCost, source: 'master', sourceDate: null };
    if (costReference.source === 'missing') productsWithoutMasterCost.push(product.code || product.name);
    const unitCost = costReference.unitCost;
    return {
      ...product,
      unitCost,
      costSource: costReference.source,
      costSourceDate: costReference.sourceDate,
      totalCost: product.quantity * unitCost
    };
  });
  return {
    ...result,
    products,
    totalCost: products.reduce((sum, product) => sum + product.totalCost, 0),
    productsWithoutMasterCost
  };
}

function normalizedUnit(value) {
  const unit = normalizeHeader(value).replace(/\s+/g, '');
  if (['ml', 'cc', 'cm3'].includes(unit)) return 'ml';
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(unit)) return 'l';
  if (['g', 'gr', 'grs', 'gramo', 'gramos'].includes(unit)) return 'g';
  if (['kg', 'kilo', 'kilos'].includes(unit)) return 'kg';
  if (['un', 'und', 'unidad', 'unidades'].includes(unit)) return 'un';
  return unit;
}

function unitCostForRecipeUnit(catalogItem, recipeUnit) {
  if (!(Number(catalogItem?.unitCost) > 0)) return null;
  const source = normalizedUnit(catalogItem.unit);
  const target = normalizedUnit(recipeUnit || catalogItem.unit);
  if (!source || !target || source === target) return catalogItem.unitCost;
  if ((source === 'kg' && target === 'g') || (source === 'l' && target === 'ml')) return catalogItem.unitCost / 1000;
  if ((source === 'g' && target === 'kg') || (source === 'ml' && target === 'l')) return catalogItem.unitCost * 1000;
  return null;
}

function canonicalConsumptionUnit(unit) {
  const normalized = normalizedUnit(unit);
  if (normalized === 'g') return { unit: 'kg', factor: 0.001 };
  if (normalized === 'kg') return { unit: 'kg', factor: 1 };
  if (normalized === 'ml') return { unit: 'L', factor: 0.001 };
  if (normalized === 'l') return { unit: 'L', factor: 1 };
  if (normalized === 'un') return { unit: 'UN', factor: 1 };
  return { unit: String(unit || '').trim(), factor: 1 };
}

function convertQuantityUnit(quantity, sourceUnit, targetUnit) {
  const source = normalizedUnit(sourceUnit);
  const target = normalizedUnit(targetUnit);
  if (!source || !target || source === target) return quantity;
  if ((source === 'kg' && target === 'g') || (source === 'l' && target === 'ml')) return quantity * 1000;
  if ((source === 'g' && target === 'kg') || (source === 'ml' && target === 'l')) return quantity / 1000;
  return null;
}

function consumptionQuantityForKardex(consumptionReport, code, targetUnit) {
  if (!consumptionReport?.available || consumptionReport.error) return 0;
  const rows = [
    ...(consumptionReport.products?.products || []),
    ...(consumptionReport.ingredients?.items || [])
  ];
  return rows.filter(item => item.code === code).reduce((sum, item) => {
    const converted = convertQuantityUnit(Number(item.quantity) || 0, item.unit, targetUnit);
    return sum + (converted ?? 0);
  }, 0);
}

function enrichKardexReport(report, consumption, catalog, costResolver = null) {
  const itemsWithoutCost = new Set();
  const items = report.items.map(item => {
    const employeeConsumption = consumptionQuantityForKardex(consumption.employees, item.code, item.unit);
    const marketingConsumption = consumptionQuantityForKardex(consumption.marketing, item.code, item.unit);
    const baseTheoreticalFinal = Number(item.theoreticalFinal) || 0;
    const theoreticalFinal = baseTheoreticalFinal - employeeConsumption - marketingConsumption;
    const finalInventory = report.boundaryMode && !item.finalIsPhysical ? null : report.selection ? Number(item.finalInventory) || 0 : Number(item.physicalFinal) || 0;
    const difference = finalInventory === null ? null : finalInventory - theoreticalFinal;
    const catalogItem = catalog?.get(item.code) || catalog?.get(String(item.code || '').toUpperCase());
    const costReference = costResolver?.resolve(item.code, item.unit, catalogItem)
      || { unitCost: unitCostForRecipeUnit(catalogItem, item.unit) ?? 0, source: 'master', sourceDate: null };
    if (costReference.source === 'missing') itemsWithoutCost.add(item.code || item.name);
    const unitCost = costReference.unitCost;
    return {
      ...item,
      employeeConsumption,
      marketingConsumption,
      baseTheoreticalFinal,
      theoreticalFinal,
      difference,
      unitCost,
      costSource: costReference.source,
      costSourceDate: costReference.sourceDate,
      costAvailable: costReference.source !== 'missing',
      totalCost: difference === null ? null : difference * unitCost
    };
  });
  return {
    ...report,
    items,
    itemsWithoutCost: [...itemsWithoutCost],
    totalCost: items.reduce((sum, item) => sum + item.totalCost, 0)
  };
}

function buildInventoryExecutiveSummary({
  location,
  dateFrom,
  dateTo,
  report,
  waste,
  consumption,
  lac001Substitutions,
  syrupSauceSubstitutions,
  avoidedPackaging,
  salesData
}) {
  const netSales = (salesData?.orderFacts || []).reduce((sum, order) => sum + (Number(order.net) || 0), 0);
  const metric = (amount, available = true, detail = {}) => {
    const numericAmount = available ? Number(amount) || 0 : null;
    return {
      amount: numericAmount,
      percentOfNetSales: numericAmount !== null && netSales !== 0 ? numericAmount / netSales * 100 : null,
      available,
      ...detail
    };
  };
  const consumptionMetric = entry => metric(
    entry?.products?.totalCost ?? entry?.ingredients?.totalCost ?? 0,
    entry?.available === true && !entry?.error,
    { quantity: Number(entry?.products?.totalQuantity) || 0 }
  );
  const physicalQuantity = item => report.selection ? item.finalInventory : item.physicalFinal;
  const inventoryValue = quantityField => report.items.reduce((sum, item) =>
    item.costAvailable ? sum + (Number(quantityField(item)) || 0) * (Number(item.unitCost) || 0) : sum, 0);
  const packaging = avoidedPackaging?.avoidedDisposablePackaging
    || avoidedPackaging?.avoidedDisposableCups
    || [];
  const kardexCostForCodes = codes => {
    const wanted = new Set(codes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean));
    const items = report.items.filter(item => wanted.has(String(item.code || '').trim().toUpperCase()));
    return {
      amount: items.reduce((sum, item) => item.costAvailable ? sum + (Number(item.totalCost) || 0) : sum, 0),
      matchedItemCount: items.length,
      codes: [...wanted]
    };
  };
  const lac001Kardex = kardexCostForCodes(['LAC001']);
  const lac001SubstitutedCost = Number(lac001Substitutions?.totalSubstitutedCost) || 0;
  const lac001AdjustedCost = lac001Kardex.amount - lac001SubstitutedCost;
  const syrupSauceCodes = [...new Set((syrupSauceSubstitutions?.items || [])
    .map(item => String(item.originalCode || '').trim().toUpperCase()).filter(Boolean))];
  const syrupSauceKardex = kardexCostForCodes(syrupSauceCodes);
  const syrupSauceSubstitutedCost = Number(syrupSauceSubstitutions?.totalSubstitutedCost) || 0;
  const syrupSauceAdjustedCost = syrupSauceKardex.amount - syrupSauceSubstitutedCost;
  const packagingKardex = kardexCostForCodes(packaging.map(item => item.code));
  const avoidedPackagingCost = Number(avoidedPackaging?.totalAvoidedPackagingCost) || 0;
  const packagingAdjustedCost = packagingKardex.amount - avoidedPackagingCost;
  const theoreticalFinalInventoryValue = inventoryValue(item => item.theoreticalFinal);
  const totalSubstitutionAndPackagingCost = lac001SubstitutedCost
    + syrupSauceSubstitutedCost
    + avoidedPackagingCost;
  const adjustedKardexTotalCost = report.totalCost - totalSubstitutionAndPackagingCost;
  const adjustedTheoreticalFinalInventoryValue = theoreticalFinalInventoryValue
    + totalSubstitutionAndPackagingCost;

  return {
    period: {
      dateFrom,
      dateTo,
      locations: [{ id: location.id, name: location.name, type: location.type }]
    },
    netSales,
    netSalesOrderCount: salesData?.orderFacts?.length || 0,
    salesFilesRead: salesData?.filesRead || 0,
    metrics: {
      marketingConsumption: consumptionMetric(consumption?.marketing),
      employeeConsumption: consumptionMetric(consumption?.employees),
      waste: metric(waste?.report?.totalCost || 0, waste?.available === true && !waste?.error, {
        itemCount: Number(waste?.report?.itemCount) || 0
      }),
      kardexTotalCost: metric(report.totalCost),
      adjustedKardexTotalCost: metric(adjustedKardexTotalCost, true, {
        kardexTotalCost: report.totalCost,
        syrupSauceSubstitutionCost: syrupSauceSubstitutedCost,
        lac001SubstitutionCost: lac001SubstitutedCost,
        avoidedPackagingCost,
        totalAdjustmentCost: totalSubstitutionAndPackagingCost,
        theoreticalFinalInventoryValue,
        adjustedTheoreticalFinalInventoryValue
      }),
      theoreticalFinalInventoryValue: metric(theoreticalFinalInventoryValue),
      physicalInventoryValue: metric(inventoryValue(physicalQuantity)),
      lac001AdjustedKardexCost: metric(lac001AdjustedCost, Boolean(lac001Substitutions), {
        kardexCost: lac001Kardex.amount,
        compensationCost: lac001SubstitutedCost,
        substitutedQuantity: Number(lac001Substitutions?.lac001VolumeLiters) || 0,
        substitutionCount: Number(lac001Substitutions?.substitutionCount) || 0,
        matchedItemCount: lac001Kardex.matchedItemCount
      }),
      syrupSauceSubstitutions: metric(syrupSauceSubstitutions?.totalSubstitutedCost || 0, Boolean(syrupSauceSubstitutions), {
        substitutionCount: Number(syrupSauceSubstitutions?.substitutionCount) || 0
      }),
      syrupSauceAdjustedKardexCost: metric(syrupSauceAdjustedCost, Boolean(syrupSauceSubstitutions), {
        kardexCost: syrupSauceKardex.amount,
        compensationCost: syrupSauceSubstitutedCost,
        substitutionCount: Number(syrupSauceSubstitutions?.substitutionCount) || 0,
        matchedItemCount: syrupSauceKardex.matchedItemCount,
        codes: syrupSauceCodes
      }),
      avoidedPackaging: metric(avoidedPackagingCost, Boolean(avoidedPackaging), {
        quantity: packaging.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
      }),
      packagingKardexCost: metric(packagingKardex.amount, Boolean(avoidedPackaging), {
        matchedItemCount: packagingKardex.matchedItemCount
      }),
      packagingAdjustedKardexCost: metric(packagingAdjustedCost, Boolean(avoidedPackaging), {
        kardexCost: packagingKardex.amount,
        compensationCost: avoidedPackagingCost,
        avoidedQuantity: packaging.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
        matchedItemCount: packagingKardex.matchedItemCount
      })
    },
    packagingComparison: {
      avoidedPackagingCost,
      kardexTotalCost: packagingKardex.amount,
      adjustedKardexCost: packagingAdjustedCost
    }
  };
}

function buildIngredientConsumption(products, recipes, catalog, costResolver = null) {
  const ingredients = new Map();
  const productsWithoutRecipe = new Set();
  const ingredientsWithoutCost = new Set();
  const ingredientsWithoutConversion = new Set();
  for (const product of products) {
    // Stocked finished goods are already counted in the product consumption
    // rows. Their ingredients belong to production, not to this consumption.
    if (catalog.get(product.code)?.stockManaged === true) continue;
    const productRecipe = recipes.get(product.code);
    if (!productRecipe?.length) {
      productsWithoutRecipe.add(product.code || product.name);
      continue;
    }
    for (const recipe of productRecipe) {
      const yieldFactor = recipe.yieldRate > 0 ? recipe.yieldRate / 100 : 1;
      const canonical = canonicalConsumptionUnit(recipe.unit);
      const quantity = product.quantity * recipe.quantity / yieldFactor * canonical.factor;
      const catalogItem = catalog.get(recipe.ingredientId);
      const costReference = costResolver?.resolve(recipe.ingredientId, canonical.unit, catalogItem)
        || { unitCost: unitCostForRecipeUnit(catalogItem, canonical.unit) ?? 0, source: catalogItem?.unitCost ? 'master' : 'missing', sourceDate: null };
      const unitCost = costReference.unitCost;
      if (costReference.source === 'missing') ingredientsWithoutCost.add(recipe.ingredientId);
      else if (!Number.isFinite(unitCost)) ingredientsWithoutConversion.add(recipe.ingredientId);
      const key = `${recipe.ingredientId}:${canonical.unit}`;
      const current = ingredients.get(key) || {
        code: recipe.ingredientId,
        name: catalogItem?.name || recipe.ingredientName,
        unit: canonical.unit || catalogItem?.unit || '',
        quantity: 0,
        unitCost: unitCost || 0,
        costSource: costReference.source,
        costSourceDate: costReference.sourceDate,
        totalCost: 0
      };
      current.quantity += quantity;
      current.totalCost += quantity * current.unitCost;
      ingredients.set(key, current);
    }
  }
  const items = [...ingredients.values()].sort((left, right) => left.name.localeCompare(right.name, 'es'));
  return {
    items,
    totalCost: items.reduce((sum, ingredient) => sum + ingredient.totalCost, 0),
    productsWithoutRecipe: [...productsWithoutRecipe],
    ingredientsWithoutCost: [...ingredientsWithoutCost],
    ingredientsWithoutConversion: [...ingredientsWithoutConversion]
  };
}

function repairMojibake(value) {
  const text = String(value ?? '');
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') ? text : repaired;
  } catch {
    return text;
  }
}

function parseProductCatalog(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames.find(name => /^prod|producto/i.test(name));
  if (!sheetName) throw new Error('El maestro no contiene una hoja de productos.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
  const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
  if (headerIndex < 0) throw new Error('La hoja de productos no contiene encabezados reconocibles.');
  const headers = rows[headerIndex];
  const column = names => findHeaderColumn(headers, names);
  const codeColumn = column(['ID Producto **', 'ID Producto']);
  const nameColumn = column(['Nombre Producto *', 'Nombre Producto']);
  const priceColumn = column(['Precio Base', 'Precio de venta']);
  const costColumn = column(['Costo']);
  const unitColumn = column(['Medida Base', 'Unidad Base', 'Unidad de Reportes']);
  const activeColumn = column(['Activo']);
  const hierarchyColumn = column(['Jerarquías de Producto *', 'Jerarquía de Producto', 'Jerarquias de Producto *']);
  return rows.slice(headerIndex + 1).flatMap(row => {
    const code = String(row[codeColumn] ?? '').trim();
    if (!code) return [];
    const hierarchyIds = String(row[hierarchyColumn] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const price = numericValue(row[priceColumn]) || 0;
    const cost = numericValue(row[costColumn]) || 0;
    const netPrice = price / 1.19;
    return [{
      code,
      name: repairMojibake(row[nameColumn]),
      price,
      netPrice,
      cost,
      unit: String(row[unitColumn] ?? '').trim(),
      marginPercent: netPrice ? ((netPrice - cost) / netPrice) * 100 : null,
      active: activeColumn < 0 || Boolean(numericValue(row[activeColumn])),
      hierarchyId: hierarchyIds[0] || null
    }];
  });
}

function parseIngredientsCatalog(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const ingredientSheetNames = workbook.SheetNames.filter(name => /^ingr|ingred/i.test(name));
  if (!ingredientSheetNames.length) throw new Error('El maestro no contiene una hoja de ingredientes.');
  const extraSheetNames = workbook.SheetNames.filter(name => /^extr|extra/i.test(name));
  const ingredients = new Map();
  for (const sheetName of [...ingredientSheetNames, ...extraSheetNames]) {
    const isExtraSheet = extraSheetNames.includes(sheetName);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto']);
    const nameColumn = findHeaderColumn(headers, ['Nombre Producto *', 'Nombre Producto']);
    const costColumn = findHeaderColumn(headers, ['Costo']);
    const unitColumn = findHeaderColumn(headers, ['Medida Base', 'Unidad Base', 'Unidad de Reportes']);
    const activeColumn = findHeaderColumn(headers, ['Activo']);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      const key = code.toUpperCase();
      if (!code || (isExtraSheet && (!key.startsWith('SUB') || ingredients.has(key)))) continue;
      ingredients.set(key, {
        code,
        name: repairMojibake(row[nameColumn]) || code,
        unit: String(row[unitColumn] ?? '').trim(),
        unitCost: numericValue(row[costColumn]) || 0,
        active: activeColumn < 0 || Boolean(numericValue(row[activeColumn]))
      });
    }
  }
  return ingredients;
}

function parseSalesAnalysisCatalog(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const products = new Map();
  const ingredients = new Map();
  const recipeExtras = new Map();
  for (const sheetName of workbook.SheetNames) {
    const isProductSheet = /^prod|producto/i.test(sheetName);
    const isIngredientSheet = /^ingr|ingred/i.test(sheetName);
    const isExtraSheet = /^extr|extra/i.test(sheetName);
    if (!isProductSheet && !isIngredientSheet && !isExtraSheet) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto']);
    const nameColumn = findHeaderColumn(headers, ['Nombre Producto *', 'Nombre Producto']);
    const activeColumn = findHeaderColumn(headers, ['Activo']);
    const unitColumn = findHeaderColumn(headers, ['Medida Base', 'Unidad Base', 'Unidad de Reportes']);
    const priceColumn = findHeaderColumn(headers, ['Precio Base', 'Precio de venta']);
    const ingredientHierarchyColumn = findHeaderColumn(headers, ['Jerarquías de Ingredientes *', 'Jerarquía de Ingredientes']);
    const extrasHierarchyColumn = findHeaderColumn(headers, ['Jerarquías de Extras *', 'Jerarquía de Extras']);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code || (activeColumn >= 0 && !Boolean(numericValue(row[activeColumn])))) continue;
      const item = {
        code,
        name: repairMojibake(row[nameColumn]) || code,
        unit: String(row[unitColumn] ?? '').trim(),
        listPrice: priceColumn >= 0 ? numericValue(row[priceColumn]) || 0 : 0,
        hierarchyIds: String(row[isIngredientSheet ? ingredientHierarchyColumn : extrasHierarchyColumn] ?? '')
          .split(',').map(value => value.trim()).filter(Boolean)
      };
      if (isIngredientSheet) ingredients.set(code.toUpperCase(), item);
      else if (isExtraSheet) recipeExtras.set(code.toUpperCase(), item);
      else products.set(code.toUpperCase(), item);
    }
  }
  return { products, ingredients, recipeExtras };
}

function parseInventoryHierarchyAssignments(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const assignments = new Map();
  for (const sheetName of workbook.SheetNames) {
    const type = /^prod|producto/i.test(sheetName)
      ? 'product'
      : /^ingr|ingred/i.test(sheetName)
        ? 'ingredient'
        : /^extr|extra/i.test(sheetName) ? 'extra' : null;
    if (!type) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto']);
    const hierarchyHeaders = type === 'product'
      ? ['Jerarquías de Producto *', 'Jerarquía de Producto', 'Jerarquias de Producto *']
      : type === 'ingredient'
        ? ['Jerarquías de Ingredientes *', 'Jerarquía de Ingredientes']
        : ['Jerarquías de Extras *', 'Jerarquía de Extras'];
    const hierarchyColumn = findHeaderColumn(headers, hierarchyHeaders);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code) continue;
      const hierarchyId = String(row[hierarchyColumn] ?? '').split(',').map(value => value.trim()).find(Boolean) || null;
      assignments.set(code.toUpperCase(), { type, hierarchyId });
    }
  }
  return assignments;
}

function parseNamedHierarchies(filePath, nameHeaders) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
  const hierarchyMap = new Map();
  for (const row of rows) {
    const id = String(rowValue(row, ['ID Jerarquia', 'ID Jerarquía', 'Hierarchy ID']) ?? '').trim();
    if (!id) continue;
    hierarchyMap.set(id, {
      id,
      name: repairMojibake(rowValue(row, [
        ...nameHeaders,
        'Hierarchy Name *', 'Product Hierarchy Name *', 'Ingredient Hierarchy Name *', 'Extras Hierarchy Name *'
      ])) || id,
      parentId: String(rowValue(row, ['ID nodo padre', 'Parent node ID']) ?? '').trim() || null,
      order: numericValue(rowValue(row, ['Orden', 'Order'])) || 0
    });
  }
  const pathFor = id => {
    const result = [];
    const visited = new Set();
    let current = hierarchyMap.get(id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentId) result.unshift(current.name);
      current = current.parentId ? hierarchyMap.get(current.parentId) : null;
    }
    return result;
  };
  const descendantIds = id => new Set([...hierarchyMap.values()]
    .filter(candidate => candidate.id === id || pathForIds(candidate.id).includes(id))
    .map(candidate => candidate.id));
  const pathForIds = id => {
    const result = [];
    const visited = new Set();
    let current = hierarchyMap.get(id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.unshift(current.id);
      current = current.parentId ? hierarchyMap.get(current.parentId) : null;
    }
    return result;
  };
  return { hierarchyMap, pathFor, descendantIds };
}

function parseProductHierarchies(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
  const hierarchyMap = new Map();
  for (const row of rows) {
    const id = String(rowValue(row, ['ID Jerarquia', 'ID Jerarquía', 'Hierarchy ID']) ?? '').trim();
    if (!id) continue;
    hierarchyMap.set(id, {
      id,
      name: repairMojibake(rowValue(row, [
        'Nombre Jerarquía Producto *', 'Nombre Jerarquia Producto *', 'Product Hierarchy Name *', 'Hierarchy Name *'
      ])) || id,
      parentId: String(rowValue(row, ['ID nodo padre', 'Parent node ID']) ?? '').trim() || null,
      order: numericValue(rowValue(row, ['Orden', 'Order'])) || 0
    });
  }
  const pathFor = id => {
    const path = [];
    const visited = new Set();
    let current = hierarchyMap.get(id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentId) path.unshift(current.name);
      current = current.parentId ? hierarchyMap.get(current.parentId) : null;
    }
    return path;
  };
  return { hierarchyMap, pathFor };
}

function normalizeHeader(value) {
  return repairMojibake(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function rowValue(row, names) {
  const wanted = new Set(names.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key))) return value;
  }
  return null;
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!text) return null;
  let normalized = text;
  if (text.includes(',') && text.includes('.')) {
    normalized = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    normalized = text.replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cellDate(value, dateOrder = 'dmy') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? toIsoDate(parsed.y, parsed.m, parsed.d) : null;
  }
  return datesInText(value, dateOrder)[0] || null;
}

function cellTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // SheetJS materializes time-only cells as local Date values anchored in 1899.
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${String(parsed.H || 0).padStart(2, '0')}:${String(parsed.M || 0).padStart(2, '0')}:${String(Math.floor(parsed.S || 0)).padStart(2, '0')}`;
  }
  const match = String(value || '').match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}` : null;
}

function salesTransactionDateTime(row) {
  const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
  if (!date) return null;
  const time = cellTime(rowValue(row, ['Hora de creacion', 'Hora de creación', 'Hora de cierre'])) || '00:00:00';
  return `${date}T${time}`;
}

function salesTransactionKey(row) {
  const orderId = rowValue(row, ['ID de orden', 'Id de orden', 'Folio']);
  if (orderId !== null && orderId !== undefined && String(orderId).trim()) {
    return `order:${String(orderId).trim().replace(/^'+/, '')}`;
  }
  const canonical = Object.entries(row)
    .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  return `row:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function salesRecordParts(record) {
  if (!record) return [];
  if (Array.isArray(record)) return record.flatMap(salesRecordParts);
  return Array.isArray(record.parts) && record.parts.length ? record.parts : [record];
}

function auditSourceFields(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value instanceof Date ? (/hora|time/i.test(key) ? cellTime(value) : cellDate(value)) : value
  ]));
}

function readSalesRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

function readPurchaseRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

function supplierNamesByTaxId(filePath) {
  if (!filePath) return new Map();
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames.find(name => normalizeHeader(name) === 'proveedores') || workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });
  return new Map(rows.map(row => {
    const taxId = String(rowValue(row, ['RUT/Fiscal ID*', 'RUT/Fiscal ID', 'Número identificador fiscal']) || '')
      .replace(/[^0-9kK]/g, '').toUpperCase();
    const name = String(rowValue(row, ['Nombre*', 'Nombre', 'Proveedor']) || '').trim();
    return [taxId, name];
  }).filter(([taxId, name]) => taxId && name));
}

function purchaseRecord(row, location, supplierNames) {
  const date = cellDate(rowValue(row, ['Fecha emisión', 'Fecha de emisión', 'Fecha', 'Broadcast date', 'Issue Date']));
  if (!date) return null;
  const supplierTaxId = String(rowValue(row, ['Número identificador fiscal', 'RUT/Fiscal ID', 'RUT', 'Tax ID number']) || '')
    .replace(/[^0-9kK]/g, '').toUpperCase();
  const sourceSupplier = String(rowValue(row, ['Proveedor/Para', 'Proveedor', 'Supplier/To']) || '').trim() || 'Proveedor sin identificar';
  const supplier = supplierNames.get(supplierTaxId) || sourceSupplier;
  const billedQuantity = numericValue(rowValue(row, ['Q.Fac', 'Cantidad facturada']));
  const receivedQuantity = numericValue(rowValue(row, ['Q.Rec', 'Cantidad recibida']));
  const quantity = billedQuantity ?? receivedQuantity ?? 0;
  const unit = String(rowValue(row, ['Um.Fac', 'Unidad facturada', 'Um.Rec', 'Unidad recibida']) || '').trim();
  const listedUnitPrice = numericValue(rowValue(row, ['Costo', 'Cost'])) || 0;
  const missingPurchaseValue = row['API Source'] === 'Toteat' ? null : 0;
  const negotiatedUnitPrice = numericValue(rowValue(row, ['Costo negociado', 'Negotiated cost'])) ?? missingPurchaseValue;
  const netAmount = numericValue(rowValue(row, ['Monto neto', 'Net amount'])) ?? missingPurchaseValue;
  const discount = numericValue(rowValue(row, ['Descuento', 'Discount'])) ?? missingPurchaseValue;
  const reportedTotalAmount = numericValue(rowValue(row, ['Monto total', 'Total amount']));
  const totalAmount = reportedTotalAmount ?? netAmount - discount;
  const effectiveUnitPrice = quantity ? totalAmount / quantity : listedUnitPrice;
  // This establishes consistency with TotEat's net field, not independent tax verification.
  const matchesNet = (actual, expected) => Math.abs(actual - expected) <= Math.max(1, Math.abs(expected) * 0.005);
  const costBasisEvidence = quantity > 0 && listedUnitPrice > 0 && netAmount > 0 && reportedTotalAmount !== null
    && matchesNet(listedUnitPrice * quantity, netAmount)
    && matchesNet(totalAmount, netAmount - discount)
    ? 'net-field-consistent' : 'unverified';
  const document = String(rowValue(row, ['Documento', 'Número documento', 'Document']) || '').trim();
  const line = String(rowValue(row, ['Lin', 'Línea', 'Line']) || '').trim();
  const code = String(rowValue(row, ['Cod', 'Código', 'Código producto', 'Code']) || '').trim();
  const product = String(rowValue(row, ['PRODUCTO', 'Producto', 'Insumo']) || '').trim();
  const supplierKey = supplierTaxId || normalizeHeader(supplier);
  return {
    date,
    locationId: location.id,
    locationName: location.name,
    supplierKey,
    supplier,
    supplierTaxId,
    documentType: String(rowValue(row, ['Tipo Documento', 'Tipo de documento', 'Document Type']) || '').trim(),
    document,
    line,
    code,
    product,
    quantity,
    unit,
    listedUnitPrice,
    negotiatedUnitPrice,
    effectiveUnitPrice,
    costBasisEvidence,
    netAmount,
    discount,
    totalAmount
  };
}

function writeSalesRows(filePath, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: headers }), 'Ventas');
  XLSX.writeFile(workbook, filePath, { bookType: 'xlsx' });
}

function addDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function buildSalesReport(dailySales, todayKey, includeToday = false) {
  const referenceDate = includeToday ? todayKey : addDays(todayKey, -1);
  const referenceDayNumber = new Date(`${referenceDate}T00:00:00.000Z`).getUTCDay();
  const weekStart = addDays(referenceDate, -((referenceDayNumber + 6) % 7));
  const monthStart = `${referenceDate.slice(0, 7)}-01`;
  const historicalDates = Object.keys(dailySales).filter(date => date <= referenceDate).sort();
  const hasReferenceDay = Object.hasOwn(dailySales, referenceDate);
  const reference = dailySales[referenceDate] || { gross: 0, discounts: 0, net: 0, orders: 0 };
  const sameWeekdayDates = historicalDates.filter(date => new Date(`${date}T00:00:00.000Z`).getUTCDay() === referenceDayNumber);
  const priorEight = sameWeekdayDates.filter(date => date < referenceDate).sort().reverse().slice(0, 8);
  const sameWeekdayAverage = priorEight.length
    ? priorEight.reduce((sum, date) => sum + dailySales[date].net, 0) / priorEight.length
    : 0;
  const rank = dates => ({
    position: hasReferenceDay && dates.length ? 1 + dates.filter(date => dailySales[date].net > reference.net).length : null,
    total: dates.length
  });
  const rankTotals = (totals, currentKey) => {
    const currentTotal = totals.get(currentKey);
    return {
      position: currentTotal !== undefined
        ? 1 + [...totals.values()].filter(total => total > currentTotal).length
        : null,
      total: totals.size
    };
  };
  const sumRange = (from, to) => historicalDates
    .filter(date => date >= from && date <= to)
    .reduce((sum, date) => sum + dailySales[date].net, 0);
  const variationPercent = (current, previous) => {
    if (!previous) return current ? 100 : 0;
    return ((current / previous) - 1) * 100;
  };
  const addSequentialVariation = (rows, valueKey = 'netSales') => rows.map((item, index) => ({
    ...item,
    variationPercent: index === rows.length - 1
      ? null
      : variationPercent(item[valueKey], rows[index + 1][valueKey])
  }));

  const averageTicketRange = (from, to) => {
    const totals = historicalDates
      .filter(date => date >= from && date <= to)
      .reduce((result, date) => {
        const sales = dailySales[date];
        result.grossSalesWithVat += sales.gross + sales.discounts;
        result.orders += sales.orders || 0;
        return result;
      }, { grossSalesWithVat: 0, orders: 0 });
    return {
      ...totals,
      averageTicketWithVat: totals.orders ? totals.grossSalesWithVat / totals.orders : 0
    };
  };
  const discountRange = (from, to) => {
    const totals = historicalDates
      .filter(date => date >= from && date <= to)
      .reduce((result, date) => {
        const sales = dailySales[date];
        result.grossSalesBeforeDiscounts += sales.gross;
        result.signedDiscounts += sales.discounts;
        return result;
      }, { grossSalesBeforeDiscounts: 0, signedDiscounts: 0 });
    const discountAmount = Math.max(0, -totals.signedDiscounts);
    return {
      ...totals,
      discountAmount,
      discountPercent: totals.grossSalesBeforeDiscounts
        ? discountAmount / totals.grossSalesBeforeDiscounts * 100
        : 0
    };
  };
  const addSequentialPointVariation = rows => rows.map((item, index) => ({
    ...item,
    variationPoints: index === rows.length - 1
      ? null
      : item.discountPercent - rows[index + 1].discountPercent
  }));

  const monthKeyAtOffset = offset => {
    const reference = new Date(`${referenceDate.slice(0, 7)}-01T00:00:00.000Z`);
    reference.setUTCMonth(reference.getUTCMonth() + offset);
    return reference.toISOString().slice(0, 7);
  };
  const months = addSequentialVariation(Array.from({ length: 14 }, (_, index) => {
    const monthKey = monthKeyAtOffset(-index);
    const from = `${monthKey}-01`;
    const nextMonth = new Date(`${from}T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const calendarEnd = addDays(nextMonth.toISOString().slice(0, 10), -1);
    const to = calendarEnd > referenceDate ? referenceDate : calendarEnd;
    return { key: monthKey, from, to, netSales: sumRange(from, to) };
  }));
  const weeks = addSequentialVariation(Array.from({ length: 14 }, (_, index) => {
    const from = addDays(weekStart, -7 * index);
    const calendarEnd = addDays(from, 6);
    const to = calendarEnd > referenceDate ? referenceDate : calendarEnd;
    return { from, to, netSales: sumRange(from, to) };
  }));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -index);
    const netSales = dailySales[date]?.net || 0;
    const priorWeekSales = dailySales[addDays(date, -7)]?.net || 0;
    return {
      date,
      netSales,
      variationPercent: index === 13 ? null : variationPercent(netSales, priorWeekSales)
    };
  });
  const equivalentDays = addSequentialVariation(Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -7 * index);
    return { date, netSales: dailySales[date]?.net || 0 };
  }));
  const averageTicketMonths = addSequentialVariation(months.map(({ key, from, to }) => ({
    key, from, to, ...averageTicketRange(from, to)
  })), 'averageTicketWithVat');
  const averageTicketWeeks = addSequentialVariation(weeks.map(({ from, to }) => ({
    from, to, ...averageTicketRange(from, to)
  })), 'averageTicketWithVat');
  const averageTicketDays = Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -index);
    const current = averageTicketRange(date, date);
    const priorWeek = averageTicketRange(addDays(date, -7), addDays(date, -7));
    return {
      date,
      ...current,
      variationPercent: index === 13 ? null : variationPercent(current.averageTicketWithVat, priorWeek.averageTicketWithVat)
    };
  });
  const averageTicketEquivalentDays = addSequentialVariation(Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -7 * index);
    return { date, ...averageTicketRange(date, date) };
  }), 'averageTicketWithVat');
  const discountMonths = addSequentialPointVariation(months.map(({ key, from, to }) => ({
    key, from, to, ...discountRange(from, to)
  })));
  const discountWeeks = addSequentialPointVariation(weeks.map(({ from, to }) => ({
    from, to, ...discountRange(from, to)
  })));
  const discountDays = Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -index);
    const current = discountRange(date, date);
    const priorWeek = discountRange(addDays(date, -7), addDays(date, -7));
    return {
      date,
      ...current,
      variationPoints: index === 13 ? null : current.discountPercent - priorWeek.discountPercent
    };
  });
  const discountEquivalentDays = addSequentialPointVariation(Array.from({ length: 14 }, (_, index) => {
    const date = addDays(referenceDate, -7 * index);
    return { date, ...discountRange(date, date) };
  }));
  const referenceWeekOffset = (referenceDayNumber + 6) % 7;
  const comparableWeekTotals = new Map();
  const comparableMonthTotals = new Map();
  historicalDates.forEach(date => {
    const dateObject = new Date(`${date}T00:00:00.000Z`);
    const weekOffset = (dateObject.getUTCDay() + 6) % 7;
    if (weekOffset <= referenceWeekOffset) {
      const comparableWeekStart = addDays(date, -weekOffset);
      comparableWeekTotals.set(
        comparableWeekStart,
        (comparableWeekTotals.get(comparableWeekStart) || 0) + dailySales[date].net
      );
    }
    if (dateObject.getUTCDate() <= Number(referenceDate.slice(8, 10))) {
      const monthKey = date.slice(0, 7);
      comparableMonthTotals.set(monthKey, (comparableMonthTotals.get(monthKey) || 0) + dailySales[date].net);
    }
  });

  return {
    basis: 'gross-plus-signed-discounts-divided-by-1.19',
    currency: 'CLP',
    includeToday,
    cutoff: includeToday ? 'today' : 'yesterday',
    previousDay: {
      date: referenceDate,
      grossSales: reference.gross,
      discounts: reference.discounts,
      netSales: reference.net,
      generalRank: rank(historicalDates),
      sameWeekdayRank: rank(sameWeekdayDates),
      sameWeekdayAverage,
      comparisonToAveragePercent: hasReferenceDay && sameWeekdayAverage
        ? ((reference.net / sameWeekdayAverage) - 1) * 100
        : null,
      averageSampleSize: priorEight.length
    },
    week: {
      from: weekStart,
      to: referenceDate,
      netSales: sumRange(weekStart, referenceDate),
      equivalentRank: rankTotals(comparableWeekTotals, weekStart)
    },
    month: {
      from: monthStart,
      to: referenceDate,
      netSales: sumRange(monthStart, referenceDate),
      equivalentRank: rankTotals(comparableMonthTotals, referenceDate.slice(0, 7))
    },
    statistics: { months, weeks, days, equivalentDays },
    orderCountStatistics: {
      months: addSequentialVariation(averageTicketMonths.map(item => ({ ...item })), 'orders'),
      weeks: addSequentialVariation(averageTicketWeeks.map(item => ({ ...item })), 'orders'),
      days: averageTicketDays.map((item, index) => ({ ...item,
        variationPercent: index === 13 ? null : variationPercent(item.orders, averageTicketRange(addDays(item.date, -7), addDays(item.date, -7)).orders)
      })),
      equivalentDays: addSequentialVariation(averageTicketEquivalentDays.map(item => ({ ...item })), 'orders')
    },
    averageTicketStatistics: {
      basis: 'gross-plus-signed-discounts',
      includesVat: true,
      months: averageTicketMonths,
      weeks: averageTicketWeeks,
      days: averageTicketDays,
      equivalentDays: averageTicketEquivalentDays
    },
    discountStatistics: {
      basis: 'discount-amount-divided-by-gross-sales-before-discounts',
      comparisonUnit: 'percentage-points',
      months: discountMonths,
      weeks: discountWeeks,
      days: discountDays,
      equivalentDays: discountEquivalentDays
    },
    coverage: historicalDates.length ? { from: historicalDates[0], to: historicalDates.at(-1) } : null
  };
}

function buildIntradayReport(dailySales, transactionsByDate, referenceDate) {
  const referenceWeekday = new Date(`${referenceDate}T00:00:00.000Z`).getUTCDay();
  const completedDates = Object.keys(dailySales).filter(date => date < referenceDate);
  const bestDate = dates => dates.sort((left, right) => {
    const difference = dailySales[right].net - dailySales[left].net;
    return difference || right.localeCompare(left);
  })[0] || null;
  const sameWeekdayDate = bestDate(completedDates.filter(date =>
    new Date(`${date}T00:00:00.000Z`).getUTCDay() === referenceWeekday));
  const monthDate = bestDate(completedDates.filter(date => date.startsWith(referenceDate.slice(0, 7))));
  const historicalDate = bestDate([...completedDates]);
  const blocks = [
    { label: '07:00–09:00', end: '08:59:59' },
    { label: '09:00–11:00', end: '10:59:59' },
    { label: '11:00–13:00', end: '12:59:59' },
    { label: '13:00–15:00', end: '14:59:59' },
    { label: '15:00–17:00', end: '16:59:59' },
    { label: '17:00–19:00', end: '18:59:59' },
    { label: '19:00–cierre', end: '23:59:59' }
  ];
  const cumulativeAt = (date, end) => {
    if (!date) return null;
    return (transactionsByDate[date] || [])
      .filter(transaction => transaction.time <= end)
      .reduce((sum, transaction) => sum + transaction.net, 0);
  };
  const referenceTransactions = transactionsByDate[referenceDate] || [];
  const cutoffTime = referenceTransactions.reduce((latest, transaction) =>
    !latest || transaction.time > latest ? transaction.time : latest, null);
  const referenceNetSales = cutoffTime ? cumulativeAt(referenceDate, cutoffTime) : 0;
  const rankingAtCutoff = dates => ({
    position: cutoffTime
      ? 1 + dates.filter(date => date !== referenceDate && cumulativeAt(date, cutoffTime) > referenceNetSales).length
      : null,
    total: cutoffTime ? dates.length : 0
  });
  const priorSameWeekdays = completedDates
    .filter(date => new Date(`${date}T00:00:00.000Z`).getUTCDay() === referenceWeekday)
    .sort()
    .reverse();
  const priorEight = priorSameWeekdays.slice(0, 8);
  const sameWeekdayAverage = cutoffTime && priorEight.length
    ? priorEight.reduce((sum, date) => sum + cumulativeAt(date, cutoffTime), 0) / priorEight.length
    : 0;
  return {
    today: {
      date: referenceDate,
      cutoffTime,
      netSales: referenceNetSales,
      generalRank: rankingAtCutoff([...completedDates, ...(cutoffTime ? [referenceDate] : [])]),
      sameWeekdayRank: rankingAtCutoff([...priorSameWeekdays, ...(cutoffTime ? [referenceDate] : [])]),
      sameWeekdayAverage,
      comparisonToAveragePercent: cutoffTime && sameWeekdayAverage
        ? ((referenceNetSales / sameWeekdayAverage) - 1) * 100
        : null,
      averageSampleSize: priorEight.length
    },
    references: {
      sameWeekday: { date: sameWeekdayDate },
      month: { date: monthDate },
      historical: { date: historicalDate }
    },
    blocks: blocks.map(block => ({
      label: block.label,
      end: block.end,
      today: cumulativeAt(referenceDate, block.end),
      sameWeekday: cumulativeAt(sameWeekdayDate, block.end),
      month: cumulativeAt(monthDate, block.end),
      historical: cumulativeAt(historicalDate, block.end)
    }))
  };
}

function combinedDateRange(files) {
  const dates = files.flatMap(file => file.detectedRange ? [file.detectedRange.from, file.detectedRange.to] : []);
  dates.sort();
  return dates.length ? { from: dates[0], to: dates.at(-1) } : null;
}

function intersectDateRanges(left, right) {
  if (!left || !right) return null;
  const from = left.from > right.from ? left.from : right.from;
  const to = left.to < right.to ? left.to : right.to;
  return from <= to ? { from, to } : null;
}

function cleanExpiredStaging(stagingRoot) {
  const now = Date.now();
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(stagingRoot, entry.name);
    if (now - fs.statSync(target).mtimeMs > STAGING_MAX_AGE_MS) fs.rmSync(target, { recursive: true, force: true });
  }
}

const TOTEAT_REPORT_URL = 'https://res8.toteat.com/#/reportes/cierres';
const TOTEAT_REPORT_URLS = [
  TOTEAT_REPORT_URL,
  'https://res8.toteat.com/#/reportes/cierre'
];
const TOTEAT_PAYMENT_DETAILS_REPORT_URL = 'https://res8.toteat.com/#/reportes/detallepagos';
const TOTEAT_PAYMENT_DETAILS_REPORT_URLS = [
  TOTEAT_PAYMENT_DETAILS_REPORT_URL,
  'https://res8.toteat.com/#/reportes/detalle-pagos'
];
const TOTEAT_PURCHASES_URL = 'https://res8.toteat.com/#/compras';
const TOTEAT_KARDEX_URL = 'https://res8.toteat.com/#/list-kardex';
const TOTEAT_LOGIN_URL = 'https://res8.toteat.com/#/logintoteat';
const TOTEAT_SUPPLIERS_URL = 'https://res8.toteat.com/#/proveedores-new';
const TOTEAT_PRODUCTS_URL = 'https://res8.toteat.com/#/productos';
const TOTEAT_PRODUCT_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquia';
const TOTEAT_INGREDIENT_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquiaingredientes';
const TOTEAT_EXTRAS_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquiaextras';
const TOTEAT_RECIPES_URL = 'https://res8.toteat.com/#/ingredientes';
const TOTEAT_RESTAURANTS_URL = 'https://res8.toteat.com/#/restaurant';

function chromeExecutablePath(playwrightExecutablePath = null) {
  return [
    process.env.BREWIT_CHROME_PATH,
    playwrightExecutablePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean).find(candidate => fs.existsSync(candidate)) || null;
}

function createToteatAutomation(profilesRoot, factoryOptions = {}) {
  const contexts = new Map();
  let nativeQueue = Promise.resolve();
  const diagnosticsRoot = path.join(profilesRoot, 'diagnostics');
  const reportUrls = Array.isArray(factoryOptions.reportUrls) && factoryOptions.reportUrls.length
    ? factoryOptions.reportUrls
    : factoryOptions.reportUrl ? [factoryOptions.reportUrl] : TOTEAT_REPORT_URLS;
  const paymentDetailsReportUrls = Array.isArray(factoryOptions.paymentDetailsReportUrls) && factoryOptions.paymentDetailsReportUrls.length
    ? factoryOptions.paymentDetailsReportUrls
    : factoryOptions.paymentDetailsReportUrl
      ? [factoryOptions.paymentDetailsReportUrl]
      : TOTEAT_PAYMENT_DETAILS_REPORT_URLS;
  const purchasesUrl = factoryOptions.purchasesUrl || TOTEAT_PURCHASES_URL;
  const kardexUrl = factoryOptions.kardexUrl || TOTEAT_KARDEX_URL;
  const loginUrl = factoryOptions.loginUrl || TOTEAT_LOGIN_URL;
  const suppliersUrls = factoryOptions.suppliersUrl ? [factoryOptions.suppliersUrl] : [TOTEAT_SUPPLIERS_URL];
  const productsUrls = factoryOptions.productsUrl ? [factoryOptions.productsUrl] : [TOTEAT_PRODUCTS_URL];
  const productHierarchyUrls = factoryOptions.productHierarchyUrl
    ? [factoryOptions.productHierarchyUrl] : [TOTEAT_PRODUCT_HIERARCHY_URL];
  const ingredientHierarchyUrls = factoryOptions.ingredientHierarchyUrl
    ? [factoryOptions.ingredientHierarchyUrl] : [TOTEAT_INGREDIENT_HIERARCHY_URL];
  const extrasHierarchyUrls = factoryOptions.extrasHierarchyUrl
    ? [factoryOptions.extrasHierarchyUrl] : [TOTEAT_EXTRAS_HIERARCHY_URL];
  const recipesUrls = factoryOptions.recipesUrl ? [factoryOptions.recipesUrl] : [TOTEAT_RECIPES_URL];
  const restaurantsUrl = factoryOptions.restaurantsUrl || TOTEAT_RESTAURANTS_URL;
  const readyTimeout = Number(factoryOptions.readyTimeout) > 0 ? Number(factoryOptions.readyTimeout) : 10000;
  const transitionDelay = Number(factoryOptions.transitionDelay) >= 0 ? Number(factoryOptions.transitionDelay) : 900;
  ensureDir(profilesRoot);
  ensureDir(diagnosticsRoot);
  const automationError = (message, code, status = 500) => {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  };
  const normalizeToteatText = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const downloadLabel = /(?:Descargar|Download|Exportar|Export)\s+(?:las?\s+)?(?:Ventas(?:\s+Totales)?|Total\s+Sales|Sales)/i;
  const paymentDetailsDownloadLabel = /^(?:(?:Descargar|Download|Exportar|Export)\s+)?CSV$/i;
  const loginLabel = /^(?:Iniciar\s+sesión|Iniciar\s+sesion|Ingresar|Sign\s+in|Log\s+in)$/i;
  const logoutLabel = /^(?:Cerrar\s+sesión|Cerrar\s+sesion|Salir|Sign\s+out|Log\s+out)$/i;
  const restaurantTriggerLabel = /^(?:Seleccionar|Select|Cambiar|Change)(?:\s+(?:el|a))?\s+(?:Restaurante|Restaurant)(?:\s+Info)?$/i;
  const reportsLabel = /^(?:Reportes|Reports)$/i;
  const salesReportLabel = /^(?:Resumen(?:\s+general)?\s+de\s+ventas|Sales\s+Summary|Cierres?|Closures?|Ventas\s+consolidadas|Consolidated\s+Sales)$/i;
  const paymentDetailsReportLabel = /^(?:Detalle(?:\s+de)?\s+Pagos|Payment(?:s)?\s+Details?)$/i;
  const expiredSessionText = /(?:sesion.*(?:caducad|invalida)|session.*(?:invalid|expired|has problems)|abrir una nueva sesion|close.*(?:log on|log in).*toteat)/i;
  const reports = {
    sales: {
      key: 'sales',
      label: 'ventas',
      urls: reportUrls,
      downloadLabel,
      attributeSelector: [
        '[data-testid*="download-total-sales" i]', '[data-testid*="sales-download" i]',
        '[aria-label*="total sales" i]', '[aria-label*="ventas totales" i]',
        '[title*="total sales" i]', '[title*="ventas totales" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="reportes/cierre" i], a[href*="reportes/cierres" i], a[href*="reports/closure" i], a[href*="reports/closures" i]',
      menuLabel: salesReportLabel,
      menuPath: 'sales-report-link',
      routePattern: /reportes\/cierres?\b|reports\/closures?\b/i,
      defaultFilename: () => `ventas-toteat-${businessClock().today}.xlsx`
    },
    paymentDetails: {
      key: 'payment-details',
      label: 'Detalle Pagos',
      urls: paymentDetailsReportUrls,
      downloadLabel: paymentDetailsDownloadLabel,
      attributeSelector: [
        '[data-testid*="csv" i]', '[aria-label="CSV" i]', '[title="CSV" i]', 'a[download$=".csv" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="reportes/detallepagos" i], a[href*="reportes/detalle-pagos" i], a[href*="reports/payment-details" i]',
      menuLabel: paymentDetailsReportLabel,
      menuPath: 'payment-details-report-link',
      routePattern: /reportes\/detalle-?pagos\b|reports\/payment-details\b/i,
      defaultFilename: () => `detalle-pagos-toteat-${businessClock().today}.csv`
    },
    purchases: {
      key: 'purchases',
      label: 'Compras',
      urls: [purchasesUrl],
      downloadLabel: /^(?:Exportar|Export)$/i,
      attributeSelector: '[ng-click*="export" i], [data-testid*="export" i], [aria-label*="export" i], [title*="export" i]',
      directLinkSelector: 'a[href*="#/compras" i], a[href*="/compras" i]',
      menuLabel: /^(?:Compras|Purchases|Shopping)$/i,
      menuPath: 'purchases-link',
      routePattern: /\/compras\b|\/purchases\b/i,
      defaultFilename: () => `compras-toteat-${businessClock().today}.xls`
    },
    kardex: {
      key: 'kardex-summary',
      label: 'Kardex resumen diario',
      urls: [kardexUrl],
      downloadLabel: /^(?:Export|Exportar)$/i,
      defaultFilename: () => `kardex-toteat-${businessClock().today}.xlsx`
    },
    suppliers: {
      key: 'suppliers',
      label: 'Proveedores',
      urls: suppliersUrls,
      downloadLabel: /^Exportar$/i,
      attributeSelector: '[data-testid*="export" i], [aria-label="Exportar" i], [title="Exportar" i]',
      directLinkSelector: 'a[href*="proveedores-new" i]',
      menuLabel: /^Proveedores$/i,
      menuPath: 'suppliers-link',
      routePattern: /proveedores-new\b/i,
      skipRestaurantSelection: true,
      defaultFilename: () => `proveedores-toteat-${businessClock().today}.xlsx`
    },
    products: {
      key: 'products-master',
      label: 'Productos / Ingredientes / Extras',
      urls: productsUrls,
      downloadLabel: /XLS\s*Adv\.?\s*Total/i,
      attributeSelector: [
        '[data-testid*="xls-adv-total" i]', '[aria-label*="XLS Adv" i]', '[title*="XLS Adv" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="#/productos" i], a[href*="/productos" i]',
      menuLabel: /^Productos$/i,
      menuPath: 'products-link',
      routePattern: /\/productos\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^(?:Actions|Acciones)$/i,
      defaultFilename: () => `productos-ingredientes-extras-toteat-${businessClock().today}.xlsx`
    },
    productHierarchy: {
      key: 'product-hierarchy', label: 'Jerarquía de Productos', urls: productHierarchyUrls,
      downloadLabel: /^CSV\s+AB\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="#/jerarquia" i], a[href*="/jerarquia" i]',
      menuLabel: /Jerarqu[ií]a/i, menuPath: 'product-hierarchy-link', routePattern: /\/jerarquia\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^AB\.?$/i,
      defaultFilename: () => `jerarquia-productos-toteat-${businessClock().today}.csv`
    },
    ingredientHierarchy: {
      key: 'ingredient-hierarchy', label: 'Jerarquía de Ingredientes', urls: ingredientHierarchyUrls,
      downloadLabel: /^CSV\s+IC\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="jerarquiaingredientes" i]',
      menuLabel: /Jerarqu[ií]a.*Ingredientes/i, menuPath: 'ingredient-hierarchy-link',
      routePattern: /\/jerarquiaingredientes\b/i, skipRestaurantSelection: true,
      revealControlLabel: /^IC\.?$/i,
      defaultFilename: () => `jerarquia-ingredientes-toteat-${businessClock().today}.csv`
    },
    extrasHierarchy: {
      key: 'extras-hierarchy', label: 'Jerarquía de Extras', urls: extrasHierarchyUrls,
      downloadLabel: /^CSV\s+BA\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="jerarquiaextras" i]',
      menuLabel: /Jerarqu[ií]a.*Extras/i, menuPath: 'extras-hierarchy-link',
      routePattern: /\/jerarquiaextras\b/i, skipRestaurantSelection: true,
      revealControlLabel: /^BA\.?$/i,
      defaultFilename: () => `jerarquia-extras-toteat-${businessClock().today}.csv`
    },
    recipes: {
      key: 'recipes-master', label: 'Maestro de Recetas', urls: recipesUrls,
      expectedDownloads: 2,
      downloadLabel: /^(?:Exportar\s+Recetas|Export\s+Recipes)$/i,
      attributeSelector: 'button[ng-click="exportarRecetas()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="#/ingredientes" i], a[href*="/ingredientes" i]',
      menuLabel: /^Ingredientes$/i, menuPath: 'ingredients-link', routePattern: /\/ingredientes\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^(?:Recetas|Recipes)$/i,
      revealControlSelector: 'a[ng-click="selectTab(2)"]',
      defaultFilename: () => 'RECETAS_SIN_NOMBRE.txt'
    }
  };
  const elementLabel = async locator => {
    const text = await locator.innerText().catch(() => '');
    const ariaLabel = await locator.getAttribute('aria-label').catch(() => '');
    const title = await locator.getAttribute('title').catch(() => '');
    return String(ariaLabel || title || text || '').replace(/\s+/g, ' ').trim();
  };
  const findVisibleControl = async (page, pattern, selector = 'button, [role="button"], a, [role="menuitem"], [role="option"]') => {
    for (const frame of page.frames()) {
      const controls = frame.locator(selector);
      const count = Math.min(await controls.count().catch(() => 0), 160);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!await control.isVisible().catch(() => false)) continue;
        const label = await elementLabel(control);
        if (label.length <= 120 && pattern.test(label)) return control;
      }
    }
    return null;
  };
  const findVisibleTextControl = async (page, pattern) => {
    for (const frame of page.frames()) {
      const matches = frame.getByText(pattern);
      const count = Math.min(await matches.count().catch(() => 0), 80);
      let best = null;
      let bestLength = Infinity;
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const label = String(await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!pattern.test(label) || label.length >= bestLength) continue;
        best = candidate;
        bestLength = label.length;
      }
      if (best) return best;
    }
    return null;
  };
  const findDownloadButton = async (page, report) => {
    for (const frame of page.frames()) {
      const selects = frame.locator('select');
      const selectCount = Math.min(await selects.count().catch(() => 0), 40);
      for (let selectIndex = 0; selectIndex < selectCount; selectIndex += 1) {
        const select = selects.nth(selectIndex);
        if (!await select.isVisible().catch(() => false)) continue;
        const options = select.locator('option');
        const optionCount = Math.min(await options.count().catch(() => 0), 120);
        for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
          const option = options.nth(optionIndex);
          const label = String(await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!report.downloadLabel.test(label)) continue;
          const value = await option.getAttribute('value');
          return {
            click: () => value === null ? select.selectOption({ label }) : select.selectOption(value)
          };
        }
      }
    }
    if (report.attributeSelector) {
      const attributedControl = await findVisibleControl(page, report.downloadLabel, report.attributeSelector);
      if (attributedControl) return attributedControl;
      if (report.strictAttributeSelector) return null;
    }
    return await findVisibleControl(
      page,
      report.downloadLabel,
      'button, [role="button"], a, [role="menuitem"], [role="option"], li'
    ) || findVisibleTextControl(page, report.downloadLabel);
  };
  const waitForDownloadButton = async (page, report, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    let revealed = false;
    do {
      const button = await findDownloadButton(page, report);
      if (button) return button;
      if (!revealed && report.revealControlLabel) {
        const trigger = report.revealControlSelector
          ? await findVisibleControl(page, report.revealControlLabel, report.revealControlSelector)
          : await findVisibleControl(page, report.revealControlLabel)
          || await findVisibleTextControl(page, report.revealControlLabel);
        if (trigger) {
          await trigger.click();
          revealed = true;
          await page.waitForTimeout(transitionDelay);
          continue;
        }
      }
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    return null;
  };
  const expiredSessionDialog = async page => {
    for (const frame of page.frames()) {
      const dialogs = frame.locator('.ds-modal-container, [role="dialog"], .modal-dialog, .modal-content');
      const count = Math.min(await dialogs.count().catch(() => 0), 30);
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        if (!await dialog.isVisible().catch(() => false)) continue;
        const text = normalizeToteatText(await dialog.innerText().catch(() => ''));
        if (expiredSessionText.test(text)) return { dialog, text };
      }
    }
    return null;
  };
  const dismissExpiredSession = async page => {
    const expired = await expiredSessionDialog(page);
    if (!expired) return { detected: false, dismissed: false };
    const buttons = expired.dialog.locator('button, [role="button"], a');
    const count = Math.min(await buttons.count().catch(() => 0), 20);
    let confirmation = null;
    for (let index = 0; index < count; index += 1) {
      const candidate = buttons.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const label = await elementLabel(candidate);
      if (/^(?:OK|Aceptar|Continuar|Continue)$/i.test(label)) {
        confirmation = candidate;
        break;
      }
    }
    if (confirmation) {
      await confirmation.click({ timeout: 10000 });
      await page.waitForTimeout(transitionDelay);
      return { detected: true, dismissed: true };
    }
    return { detected: true, dismissed: false };
  };
  const ensureActiveSession = async (page, attempts) => {
    const expired = await dismissExpiredSession(page);
    if (!expired.detected) return;
    attempts.push({ action: 'expired-session-dialog', dismissed: expired.dismissed });
    const error = automationError(
      expired.dismissed
        ? 'La sesión de Toteat estaba vencida y fue cerrada. Inicia la nueva sesión en la ventana que se abrirá.'
        : 'La sesión de Toteat está vencida. Confirma el cierre de sesión en la ventana que se abrirá.',
      'TOTEAT_AUTH_REQUIRED', 409
    );
    error.state = 'session_expired';
    error.attempts = attempts;
    throw error;
  };
  const authenticationRequired = async page => {
    if (await expiredSessionDialog(page)) return true;
    if (/login|signin|auth/i.test(page.url())) return true;
    if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
    const logout = await findVisibleControl(page, logoutLabel);
    if (logout) return false;
    return Boolean(await findVisibleControl(page, loginLabel));
  };
  const selectRestaurant = async (page, restaurantName, attempts) => {
    const attempt = { action: 'restaurant-selection', restaurantName, required: false, selected: false };
    attempts.push(attempt);
    await ensureActiveSession(page, attempts);
    const trigger = await findVisibleControl(page, restaurantTriggerLabel);
    if (!trigger) return attempt;
    attempt.required = true;
    await trigger.click();
    await page.waitForTimeout(transitionDelay);
    await ensureActiveSession(page, attempts);
    const wanted = normalizeToteatText(restaurantName);
    for (const frame of page.frames()) {
      const options = frame.locator('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a');
      const count = Math.min(await options.count().catch(() => 0), 200);
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (!await option.isVisible().catch(() => false)) continue;
        const label = await elementLabel(option);
        const normalizedLabel = normalizeToteatText(label);
        if (!normalizedLabel || normalizedLabel.length > wanted.length + 45) continue;
        if (normalizedLabel === wanted || normalizedLabel.includes(wanted)) {
          await option.click();
          await page.waitForTimeout(transitionDelay);
          attempt.selected = true;
          attempt.label = label;
          return attempt;
        }
      }
    }
    return attempt;
  };
  const navigateThroughMenus = async (page, attempts, report) => {
    const attempt = { action: 'menu-navigation', path: null };
    attempts.push(attempt);
    await ensureActiveSession(page, attempts);
    const reportLink = await findVisibleControl(page, /./, report.directLinkSelector);
    if (reportLink) {
      attempt.path = 'direct-link';
      await reportLink.click();
      await page.waitForTimeout(transitionDelay);
      await ensureActiveSession(page, attempts);
      return attempt.path;
    }
    const reports = await findVisibleControl(page, reportsLabel);
    if (reports) {
      attempt.path = 'reports-menu';
      await reports.click();
      await page.waitForTimeout(transitionDelay);
      await ensureActiveSession(page, attempts);
    }
    const reportControl = await findVisibleControl(page, report.menuLabel);
    if (!reportControl) return null;
    attempt.path = reports ? 'reports-menu' : report.menuPath;
    await reportControl.click();
    await page.waitForTimeout(transitionDelay);
    await ensureActiveSession(page, attempts);
    return attempt.path;
  };
  const pageState = async (page, report) => {
    if (page.isClosed()) return 'browser_closed';
    if (await expiredSessionDialog(page)) return 'session_expired';
    if (await authenticationRequired(page)) return 'authentication_required';
    if (await findDownloadButton(page, report)) return 'report_ready';
    if (await findVisibleControl(page, restaurantTriggerLabel)) return 'restaurant_required';
    if (report.routePattern.test(page.url())) return 'report_unavailable';
    return 'unexpected_view';
  };
  const captureDiagnostic = async (page, locationId, state, attempts) => {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const id = `TOTEAT-${stamp}-${String(locationId).replace(/[^a-z0-9-]/gi, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const controls = [];
    for (const frame of page.frames()) {
      const candidates = frame.locator('button, [role="button"], a, [role="menuitem"], [role="option"]');
      const count = Math.min(await candidates.count().catch(() => 0), 160);
      for (let index = 0; index < count && controls.length < 24; index += 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const label = await elementLabel(candidate);
        if (label && label.length <= 120 && !controls.includes(label)) controls.push(label);
      }
    }
    const diagnostic = {
      id,
      capturedAt: new Date().toISOString(),
      locationId,
      state,
      url: page.url(),
      title: await page.title().catch(() => ''),
      attempts,
      visibleControls: controls
    };
    writeJsonAtomic(path.join(diagnosticsRoot, `${id}.json`), diagnostic);
    await page.screenshot({ path: path.join(diagnosticsRoot, `${id}.png`), fullPage: false }).catch(() => {});
    return diagnostic;
  };
  const attachDiagnostic = async (error, page, locationId, attempts, report) => {
    if (error.diagnosticId) return error;
    const state = error.state || await pageState(page, report).catch(() => 'unknown');
    const diagnostic = await captureDiagnostic(page, locationId, state, attempts).catch(() => null);
    error.state = state;
    if (diagnostic) {
      error.diagnosticId = diagnostic.id;
      error.message = `${error.message} Estado: ${state}. Diagnóstico: ${diagnostic.id}.`;
    }
    return error;
  };
  const launch = async (locationId, headless) => {
    let chromium = factoryOptions.chromium;
    try { if (!chromium) ({ chromium } = require('playwright-core')); } catch {
      throw automationError('La automatización de Toteat no está instalada en este servidor.', 'TOTEAT_BROWSER_UNAVAILABLE');
    }
    let playwrightExecutablePath = null;
    try { playwrightExecutablePath = chromium.executablePath?.() || null; } catch {}
    const executablePath = factoryOptions.executablePath || chromeExecutablePath(playwrightExecutablePath);
    if (!executablePath) {
      throw automationError('No se encontró Google Chrome o Chromium para conectarse a Toteat.', 'TOTEAT_BROWSER_UNAVAILABLE');
    }
    const profileRoot = path.join(profilesRoot, locationId);
    ensureDir(profileRoot);
    return chromium.launchPersistentContext(profileRoot, {
      executablePath,
      headless,
      acceptDownloads: true,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled']
    });
  };
  const reportPage = async (context, report) => {
    const pages = context.pages();
    const page = pages.find(item => item.url().includes('toteat.com')) || pages[0] || await context.newPage();
    await page.goto(report.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
    return page;
  };
  const selectRestaurantRecord = async (page, restaurant) => {
    await page.goto(restaurantsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureActiveSession(page, []);
    const rows = page.locator('tr[ng-click*="selecciona"]');
    const count = await rows.count();
    const expected = {
      restaurantId: String(restaurant.restaurantId || '').trim(),
      localId: String(restaurant.localId || '').trim(),
      name: normalizeToteatText(restaurant.name),
      simpleId: String(restaurant.simpleId || '').trim()
    };
    const readActiveRestaurant = () => page.evaluate(() => {
      try {
        const active = JSON.parse(localStorage.getItem('resto') || 'null');
        return active ? {
          restaurantId: String(active.ir ?? ''),
          localId: String(active.il ?? ''),
          name: String(active.nr ?? ''),
          simpleId: String(active.si ?? ''),
          createdAt: String(active.fc ?? '')
        } : null;
      } catch {
        return null;
      }
    });
    const isExpectedRestaurant = active => Boolean(active)
      && (!expected.restaurantId || active.restaurantId === expected.restaurantId)
      && (!expected.localId || active.localId === expected.localId)
      && (!expected.name || normalizeToteatText(active.name) === expected.name)
      && (!expected.simpleId || active.simpleId === expected.simpleId);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const cells = (await row.locator('td').allTextContents()).map(value => String(value).trim());
      if (cells.length < 5) continue;
      const matches = (!expected.restaurantId || cells[0] === expected.restaurantId)
        && (!expected.localId || cells[1] === expected.localId)
        && (!expected.name || normalizeToteatText(cells[2]) === expected.name)
        && (!expected.simpleId || cells[4] === expected.simpleId);
      if (!matches) continue;
      const alreadyActive = await readActiveRestaurant();
      if (isExpectedRestaurant(alreadyActive)) {
        return { ...alreadyActive, changed: false };
      }
      await row.click();
      await page.waitForFunction(element => element.classList.contains('seleccionado'), await row.elementHandle(), { timeout: 10000 });
      const confirm = page.locator('button:visible, a:visible, [role="button"]:visible')
        .filter({ hasText: /^\s*(?:Confirm|Confirmar)\s*$/i }).last();
      if (!await confirm.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
        throw automationError(
          `TotEat seleccionó “${restaurant.name}”, pero no mostró el botón para confirmar el cambio de local.`,
          'TOTEAT_RESTAURANT_CONFIRMATION_REQUIRED', 502
        );
      }
      await confirm.click();
      await page.waitForFunction(target => {
        try {
          const active = JSON.parse(localStorage.getItem('resto') || 'null');
          if (!active) return false;
          return (!target.restaurantId || String(active.ir ?? '') === target.restaurantId)
            && (!target.localId || String(active.il ?? '') === target.localId)
            && (!target.simpleId || String(active.si ?? '') === target.simpleId);
        } catch {
          return false;
        }
      }, expected, { timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(transitionDelay);
      const active = await readActiveRestaurant();
      if (!isExpectedRestaurant(active)) {
        throw automationError(
          `TotEat no confirmó “${restaurant.name}” como local activo. Se canceló la descarga para evitar mezclar ventas.`,
          'TOTEAT_RESTAURANT_SWITCH_FAILED', 502
        );
      }
      return { ...active, changed: true };
    }
    throw automationError(`No se encontró el local “${restaurant.name}” en TotEat con los identificadores configurados.`, 'TOTEAT_RESTAURANT_NOT_FOUND', 422);
  };
  const assertActiveRestaurant = async (page, restaurant) => {
    const active = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('resto') || 'null'); } catch { return null; }
    });
    if (!active || String(active.ir ?? '') !== String(restaurant.restaurantId)
      || String(active.il ?? '') !== String(restaurant.localId)
      || String(active.si ?? '') !== String(restaurant.simpleId)) {
      throw automationError(`TotEat no tiene activo el local “${restaurant.name}”. Se detuvo la descarga para evitar mezclar datos.`, 'TOTEAT_RESTAURANT_SWITCH_FAILED', 422);
    }
    return active;
  };
  const setToteatDateInput = async (page, input, modelField, value) => {
    await input.fill(value);
    await input.evaluate((element, date) => {
      const angular = window.angular;
      const wrapped = angular?.element(element);
      const injector = wrapped?.injector();
      const controller = wrapped?.controller('ngModel');
      const rootScope = injector?.get('$rootScope');
      if (!rootScope?.varios || !controller) return;
      const parsed = new Date(`${date.value}T12:00:00`);
      rootScope.$apply(() => {
        rootScope.varios[date.modelField] = parsed;
        controller.$setValidity('date', true);
      });
    }, { modelField, value });
    await page.waitForFunction(element => element.value && element.getAttribute('aria-invalid') !== 'true', await input.elementHandle(), { timeout: 10000 });
  };
  const configureDatedReport = async (page, dateFrom, dateTo, options = {}) => {
    const rangeLabel = page.locator('label[for="tipoRango"]:visible').last();
    await rangeLabel.click();
    const period = page.locator('select[ng-model="varios.seleccionFechas"]:visible').last();
    await period.selectOption('custom');
    await page.waitForTimeout(transitionDelay);
    const from = page.locator('input[ng-model="varios.fechaDesde"]:visible').last();
    const to = page.locator('input[ng-model="varios.fechaHasta"]:visible').last();
    await setToteatDateInput(page, from, 'fechaDesde', dateFrom);
    await setToteatDateInput(page, to, 'fechaHasta', dateTo);
    if (options.errorFactory?.()) throw options.errorFactory();
    const refresh = page.locator('button[ng-click="generaReporte()"]:visible').last();
    await refresh.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    if (options.errorFactory?.()) throw options.errorFactory();
    const downloadControl = page.locator(options.downloadSelector || 'a[ng-click="exportaTotalVentasExcel()"]:visible');
    try {
      await downloadControl.last().waitFor({ state: 'visible', timeout: 45000 });
    } catch (error) {
      if (options.errorFactory?.()) throw options.errorFactory();
      throw automationError(
        `TotEat no generó un archivo porque no encontró ${options.emptyLabel || 'registros'} para el local y período seleccionados.`,
        options.emptyCode || 'TOTEAT_NO_DATA_AVAILABLE', 422
      );
    }
    await page.waitForTimeout(transitionDelay);
  };
  const configureSalesDateRange = (page, dateFrom, dateTo, reportAccessError = () => null) => configureDatedReport(
    page, dateFrom, dateTo, {
      errorFactory: reportAccessError,
      downloadSelector: 'a[ng-click="exportaTotalVentasExcel()"]:visible',
      emptyLabel: 'ventas', emptyCode: 'TOTEAT_NO_SALES_AVAILABLE'
    }
  );
  const prepareReport = async (page, restaurantName, report) => {
    const attempts = [{ action: 'direct-url', url: page.url() }];
    const requireAuthentication = async () => {
      await ensureActiveSession(page, attempts);
      if (!await authenticationRequired(page)) return;
      const error = automationError(
        'La sesión de Toteat necesita autenticación. Inicia sesión en la ventana que se abrirá y vuelve a intentar.',
        'TOTEAT_AUTH_REQUIRED', 409
      );
      error.state = 'authentication_required';
      error.attempts = attempts;
      throw error;
    };
    const visitReportUrl = async (url, action) => {
      const attempt = { action, url };
      attempts.push(attempt);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await requireAuthentication();
      const found = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      attempt.ready = Boolean(found);
      return found;
    };
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await requireAuthentication();
      let button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      if (button) return { button, attempts };
      const restaurant = report.skipRestaurantSelection
        ? { required: false, selected: false }
        : await selectRestaurant(page, restaurantName, attempts);
      if (restaurant.required && !restaurant.selected) {
        const error = automationError(
          `Toteat solicita seleccionar un restaurante, pero no se encontró “${restaurantName}”.`,
          'TOTEAT_RESTAURANT_NOT_FOUND', 422
        );
        error.state = 'restaurant_required';
        throw error;
      }
      const urlsToTry = restaurant.selected ? report.urls : report.urls.slice(1);
      for (const [index, url] of urlsToTry.entries()) {
        button = await visitReportUrl(url, restaurant.selected && index === 0 ? 'report-after-restaurant' : 'alternate-report-url');
        if (button) return { button, attempts };
        const routeRestaurant = report.skipRestaurantSelection
          ? { required: false, selected: false }
          : await selectRestaurant(page, restaurantName, attempts);
        if (routeRestaurant.required && !routeRestaurant.selected) {
          const error = automationError(
            `Toteat solicita seleccionar un restaurante, pero no se encontró “${restaurantName}”.`,
            'TOTEAT_RESTAURANT_NOT_FOUND', 422
          );
          error.state = 'restaurant_required';
          throw error;
        }
        if (routeRestaurant.selected) {
          button = await visitReportUrl(url, 'report-after-restaurant');
          if (button) return { button, attempts };
        }
      }
      const menuPath = await navigateThroughMenus(page, attempts, report);
      button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      if (button) return { button, attempts };
      const reloadAttempt = { action: 'reload', url: page.url(), menuPath };
      attempts.push(reloadAttempt);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await requireAuthentication();
      button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      reloadAttempt.ready = Boolean(button);
      if (button) return { button, attempts };
      const error = automationError(
        `Toteat está autenticado, pero no fue posible llegar al reporte de ${report.label} ni encontrar su control de descarga.`,
        'TOTEAT_REPORT_NOT_READY', 502
      );
      error.state = await pageState(page, report);
      throw error;
    } catch (error) {
      error.attempts ||= attempts;
      throw error;
    }
  };
  const downloadReport = async (locationId, options, report) => {
    let context = options.context || contexts.get(locationId);
    const reusedVisibleContext = Boolean(contexts.get(locationId));
    if (!context) context = await launch(locationId, true);
    let page = null;
    let attempts = [];
    let captureDirectory = null;
    try {
      page = options.preparedPage || await reportPage(context, report);
      const prepared = options.preparedPage
        ? { button: await waitForDownloadButton(page, report, readyTimeout), attempts: [{ action: 'prepared-report', url: page.url() }] }
        : await prepareReport(page, options.restaurantName || locationId, report);
      if (!prepared.button) throw automationError(`No se encontró la descarga de ${report.label}.`, 'TOTEAT_REPORT_NOT_READY', 502);
      attempts = prepared.attempts;
      const button = prepared.button;
      attempts.push({ action: 'download-click', report: report.key });
      await ensureActiveSession(page, attempts);
      captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-toteat-download-'));
      const observedDownloads = [];
      const captures = [];
      const observeDownload = download => {
        const destination = path.join(captureDirectory, `${observedDownloads.length}.download`);
        observedDownloads.push(download);
        captures.push(download.saveAs(destination).then(
          () => ({ destination }),
          error => ({ error })
        ));
      };
      page.on('download', observeDownload);
      const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
      try {
        await button.click();
        await downloadPromise;
        const expectedDownloads = Math.max(1, Number(report.expectedDownloads) || 1);
        const additionalDeadline = Date.now() + 30000;
        while (observedDownloads.length < expectedDownloads && Date.now() < additionalDeadline) {
          await page.waitForTimeout(250);
        }
        if (observedDownloads.length < expectedDownloads) {
          throw automationError(
            `Toteat generó ${observedDownloads.length} de ${expectedDownloads} archivos para ${report.label}.`,
            'TOTEAT_INCOMPLETE_DOWNLOAD', 502
          );
        }
      } finally {
        page.off('download', observeDownload);
      }
      const files = [];
      const captured = await Promise.all(captures.slice(0, report.expectedDownloads || 1));
      const captureError = captured.find(item => item.error)?.error;
      if (captureError) throw captureError;
      for (const [index, download] of observedDownloads.slice(0, report.expectedDownloads || 1).entries()) {
        const suggestedFilename = download.suggestedFilename() || report.defaultFilename();
        const filename = suggestedFilename.replace(/\.csv\.txt$/i, '.csv');
        const extension = path.extname(filename).toLowerCase();
        files.push({
          filename,
          contentType: extension === '.csv'
            ? 'text/csv; charset=utf-8'
            : extension === '.txt' || extension === '.tsv'
              ? 'text/plain; charset=utf-8'
              : extension === '.xls'
                ? 'application/vnd.ms-excel'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: fs.readFileSync(captured[index].destination)
        });
      }
      return files.length === 1 ? files[0] : { files };
    } catch (caught) {
      const browserClosed = /Target page, context or browser has been closed|Target closed/i.test(caught?.message || '');
      const error = caught?.code ? caught : browserClosed
        ? automationError(
          'El navegador usado para descargar desde Toteat se cerró inesperadamente.',
          'TOTEAT_BROWSER_CLOSED', 502
        )
        : automationError(
          caught?.message || 'La automatización de Toteat falló inesperadamente.', 'TOTEAT_AUTOMATION_FAILED', 502
        );
      if (browserClosed) error.state = 'browser_closed';
      if (page) throw await attachDiagnostic(error, page, locationId, error.attempts || attempts, report);
      throw error;
    } finally {
      if (captureDirectory) fs.rmSync(captureDirectory, { recursive: true, force: true });
      if (!reusedVisibleContext) await context.close().catch(() => {});
    }
  };
  return {
    readNativeSources(restaurant, options = {}) {
      const task = nativeQueue.then(async () => {
        let browser, context, page, ownsPage = false;
        const connection = readJson(path.join(profilesRoot, 'browser-connection.json'), {});
        const endpoint = factoryOptions.cdpEndpoint || process.env.TOTEAT_CDP_ENDPOINT || connection.cdpEndpoint;
        try {
          if (endpoint) {
            if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('El navegador de Toteat debe estar en este equipo.');
            try { browser = await require('playwright-core').chromium.connectOverCDP(endpoint); }
            catch { throw automationError('El navegador conectado de Toteat no está disponible.', 'TOTEAT_BROWSER_UNAVAILABLE', 503); }
            context = browser.contexts()[0];
          } else context = contexts.get('master-downloads') || await launch('master-downloads', true);
          // Reuse the authenticated SPA: a new tab can lose Toteat's in-memory session.
          page = context.pages().filter(p => /^https:\/\/res\d*\.toteat\.com\//.test(p.url())).at(-1);
          if (!page) { page = await context.newPage(); ownsPage = true; }
          await selectRestaurantRecord(page, restaurant);
          return await readNative(page, restaurant, options);
        } finally {
          if (ownsPage) await page?.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
          else if (context && !contexts.has('master-downloads')) await context.close().catch(() => {});
        }
      });
      nativeQueue = task.catch(() => {});
      return task;
    },
    async connect(locationId) {
      const current = contexts.get(locationId);
      if (current) {
        const page = await reportPage(current, reports.sales);
        await page.bringToFront();
        return { opened: true };
      }
      const context = await launch(locationId, false);
      contexts.set(locationId, context);
      context.on('close', () => contexts.delete(locationId));
      await reportPage(context, reports.sales);
      return { opened: true };
    },
    async downloadSales(locationId, options = {}) {
      return downloadReport(locationId, options, reports.sales);
    },
    async connectTransactionalDownloads() {
      const locationId = 'master-downloads';
      const current = contexts.get(locationId);
      const context = current || await launch(locationId, false);
      if (!current) {
        contexts.set(locationId, context);
        context.on('close', () => contexts.delete(locationId));
      }
      const page = context.pages()[0] || await context.newPage();
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let requiresAuthentication = await authenticationRequired(page);
      let refreshed = false;
      if (!requiresAuthentication) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        refreshed = true;
        requiresAuthentication = await authenticationRequired(page);
      }
      await page.bringToFront();
      return { opened: true, requiresAuthentication, refreshed };
    },
    async downloadTransactionalSales(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      let reportUnavailable = false;
      const observeConsole = message => {
        if (message.type() === 'error' && /permission_denied at \/R\/PROD-/i.test(message.text())) reportUnavailable = true;
      };
      const reportAccessError = () => reportUnavailable ? automationError(
        `TotEat no generó un archivo porque “${options.restaurant?.name || 'el local'}” todavía no tiene ventas disponibles para el período seleccionado.`,
        'TOTEAT_NO_SALES_AVAILABLE', 422
      ) : null;
      page.on('console', observeConsole);
      try {
        const selectedRestaurant = await selectRestaurantRecord(page, options.restaurant || {});
        const restaurantCreatedAt = /^\d{4}-\d{2}-\d{2}/.test(selectedRestaurant.createdAt)
          ? selectedRestaurant.createdAt.slice(0, 10) : null;
        const effectiveDateFrom = restaurantCreatedAt && restaurantCreatedAt > options.dateFrom
          ? restaurantCreatedAt : options.dateFrom;
        await page.goto(reports.sales.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        if (reportAccessError()) throw reportAccessError();
        await configureSalesDateRange(page, effectiveDateFrom, options.dateTo, reportAccessError);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.sales);
        download.dateFrom = effectiveDateFrom;
        return download;
      } finally {
        page.off('console', observeConsole);
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async selectTransactionalRestaurant(restaurant) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        return await selectRestaurantRecord(page, restaurant);
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalPaymentDetails(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(reports.paymentDetails.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await configureDatedReport(page, dateFrom, options.dateTo, {
          downloadSelector: 'a[ng-click*="exportaCSVnew"][download$=".csv"]:visible, a:visible[download$=".csv"]',
          emptyLabel: 'pagos', emptyCode: 'TOTEAT_NO_PAYMENT_DETAILS_AVAILABLE'
        });
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.paymentDetails);
        download.dateFrom = dateFrom;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalPurchases(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(purchasesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        let purchaseFrame = null;
        const deadline = Date.now() + 60000;
        while (!purchaseFrame && Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (!/\/purchases\b/i.test(frame.url())) continue;
            if (await frame.locator('button:visible').filter({ hasText: /^\s*(?:Export|Exportar)\s*$/i }).first().isVisible().catch(() => false)) {
              purchaseFrame = frame;
              break;
            }
          }
          if (!purchaseFrame) await page.waitForTimeout(500);
        }
        if (!purchaseFrame) throw automationError('No se cargó la vista de Compras en TotEat.', 'TOTEAT_PURCHASE_REPORT_NOT_READY', 502);
        const exportButton = purchaseFrame.locator('button:visible').filter({ hasText: /^\s*(?:Export|Exportar)\s*$/i }).last();
        await exportButton.waitFor({ state: 'visible', timeout: 60000 });
        const moreFilters = purchaseFrame.locator('input[type="checkbox"]:visible').first();
        await moreFilters.check();
        await page.waitForTimeout(transitionDelay);
        const selects = purchaseFrame.locator('select:visible');
        const selectMatching = async expression => {
          const count = await selects.count();
          for (let index = 0; index < count; index += 1) {
            const select = selects.nth(index);
            const optionsList = await select.locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent.trim() })));
            const match = optionsList.find(item => expression.test(item.text));
            if (match) { await select.selectOption(match.value); return select; }
          }
          return null;
        };
        const dateRange = await selectMatching(/^(?:Personalizado|Custom)$/i);
        if (!dateRange) throw automationError('No se encontró el filtro de fechas personalizado en Compras.', 'TOTEAT_PURCHASE_FILTER_NOT_FOUND', 502);
        await page.waitForTimeout(transitionDelay);
        const dates = purchaseFrame.locator('input[type="date"]:visible');
        if (await dates.count() < 2) throw automationError('No se encontraron las fechas de inicio y fin en Compras.', 'TOTEAT_PURCHASE_DATES_NOT_FOUND', 502);
        await dates.first().fill(dateFrom);
        await dates.last().fill(options.dateTo);
        const visualization = await selectMatching(/^(?:Campos Adicionales|Additional Fields)$/i);
        if (!visualization) throw automationError('No se encontró “Campos Adicionales” en la visualización de Compras.', 'TOTEAT_PURCHASE_VIEW_NOT_FOUND', 502);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(transitionDelay);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.purchases);
        const workbook = XLSX.read(download.buffer, { type: 'buffer' });
        const hasRecords = workbook.SheetNames.some(name => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          header: 1, blankrows: false
        }).slice(1).some(row => row.some(value => String(value ?? '').trim())));
        if (!hasRecords) {
          throw automationError('TotEat no entregó registros de Compras para el local y período seleccionados.', 'TOTEAT_NO_PURCHASES_AVAILABLE', 422);
        }
        download.dateFrom = dateFrom;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalKardex(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        if (!page.url().includes('toteat.com')) {
          await page.goto(restaurantsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(kardexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        let frame = null;
        const deadline = Date.now() + 60000;
        while (!frame && Date.now() < deadline) {
          for (const candidate of page.frames()) {
            if (!/\/list-kardex\b/i.test(candidate.url()) || candidate === page.mainFrame()) continue;
            if (await candidate.getByText('Kardex resumen diario', { exact: true }).first().isVisible().catch(() => false)) {
              frame = candidate;
              break;
            }
          }
          if (!frame) await page.waitForTimeout(500);
        }
        if (!frame) throw automationError('No se cargó Kardex resumen diario en TotEat.', 'TOTEAT_KARDEX_REPORT_NOT_READY', 502);
        await frame.getByText('Kardex resumen diario', { exact: true }).first().click();
        await frame.locator('.multiselect').first().click();
        const localNumber = Number(options.restaurant.localId);
        if (!Number.isInteger(localNumber) || localNumber <= 0) {
          throw automationError('El ID Local de TotEat no es válido para seleccionar la bodega.', 'TOTEAT_KARDEX_LOCAL_ID_INVALID', 422);
        }
        const prefix = {
          local: 'bodega local',
          waste: 'bodega merma local',
          central: 'bodega central local',
          'central-waste': 'bodega central merma local'
        }[options.kind];
        if (!prefix) throw automationError('Tipo de Kardex no reconocido.', 'TOTEAT_KARDEX_KIND_INVALID', 400);
        const warehousePrefix = `${prefix} ${String(localNumber).padStart(3, '0')} `;
        const available = await frame.locator('.multiselect [role="option"]:visible').allTextContents();
        const matches = available.map(value => value.trim()).filter(value => normalizeToteatText(value).startsWith(warehousePrefix));
        if (matches.length !== 1) {
          throw automationError(
            `Se esperó una bodega “${warehousePrefix.trim()}” en TotEat, pero se encontraron ${matches.length}. Opciones: ${available.map(value => value.trim()).join(', ')}. Se canceló para evitar mezclar inventarios.`,
            'TOTEAT_KARDEX_WAREHOUSE_NOT_FOUND', 422
          );
        }
        const warehouseName = matches[0];
        await frame.getByRole('option', { name: warehouseName, exact: true }).click();
        if (!normalizeToteatText(await frame.locator('.multiselect').first().innerText()).includes(normalizeToteatText(warehouseName))) {
          throw automationError(`TotEat no confirmó la bodega “${warehouseName}”.`, 'TOTEAT_KARDEX_WAREHOUSE_NOT_SELECTED', 502);
        }
        const costSelect = frame.locator('#cost');
        await costSelect.selectOption('cost_last_inbound');
        if (await costSelect.inputValue() !== 'cost_last_inbound') {
          throw automationError('No se pudo seleccionar “Costo Última Compra” en TotEat. Se canceló el Kardex para evitar usar otro costo.', 'TOTEAT_KARDEX_COST_NOT_SELECTED', 502);
        }
        await frame.locator('#filter').selectOption('custom');
        await frame.locator('#date_init').fill(dateFrom);
        await frame.locator('#date_end').fill(options.dateTo);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(transitionDelay);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.kardex);
        const workbook = XLSX.read(download.buffer, { type: 'buffer' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = firstSheet ? XLSX.utils.sheet_to_json(firstSheet, { header: 1, range: 0, defval: null, blankrows: false }) : [];
        if (!rowContainsAll(rows[0] || [], ['Código', 'Nombre', 'Unidad'])
          || !(rows[0] || []).some(value => cellDate(value))) {
          throw automationError('TotEat descargó un archivo que no coincide con Kardex resumen diario.', 'TOTEAT_KARDEX_INVALID_FILE', 502);
        }
        if (!rows.slice(2).some(row => String(row[0] ?? '').trim() || String(row[1] ?? '').trim())) {
          throw automationError(`TotEat no entregó registros de Kardex para “${warehouseName}” en el período seleccionado.`, 'TOTEAT_NO_KARDEX_AVAILABLE', 422);
        }
        download.dateFrom = dateFrom;
        download.warehouseName = warehouseName;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadPaymentDetails(locationId, options = {}) {
      return downloadReport(locationId, options, reports.paymentDetails);
    },
    async connectMasterDownloads() {
      const locationId = 'master-downloads';
      const current = contexts.get(locationId);
      if (current) {
        const pages = current.pages();
        const page = pages.find(item => item.url().includes('toteat.com')) || pages[0] || await current.newPage();
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        let requiresAuthentication = await authenticationRequired(page);
        let refreshed = false;
        if (!requiresAuthentication) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          refreshed = true;
          requiresAuthentication = await authenticationRequired(page);
        }
        await page.bringToFront();
        return { opened: true, requiresAuthentication, refreshed };
      }
      const context = await launch(locationId, false);
      contexts.set(locationId, context);
      context.on('close', () => contexts.delete(locationId));
      const page = context.pages()[0] || await context.newPage();
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let requiresAuthentication = await authenticationRequired(page);
      let refreshed = false;
      if (!requiresAuthentication) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        refreshed = true;
        requiresAuthentication = await authenticationRequired(page);
      }
      return { opened: true, requiresAuthentication, refreshed };
    },
    async downloadSuppliers() {
      return downloadReport('master-downloads', {}, reports.suppliers);
    },
    async downloadProductsMaster() {
      return downloadReport('master-downloads', {}, reports.products);
    },
    async downloadProductHierarchy() {
      return downloadReport('master-downloads', {}, reports.productHierarchy);
    },
    async downloadIngredientHierarchy() {
      return downloadReport('master-downloads', {}, reports.ingredientHierarchy);
    },
    async downloadExtrasHierarchy() {
      return downloadReport('master-downloads', {}, reports.extrasHierarchy);
    },
    async downloadRecipes() {
      return downloadReport('master-downloads', {}, reports.recipes);
    }
  };
}

function createApp(options = {}) {
  const app = express();
  let toteatSalesSync;
  let toteatMasterSync;
  function readPurchaseRows(filePath) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
    return toteatSalesSync?.purchases ? toteatSalesSync.purchases.filterLegacy(filePath, rows) : rows;
  }
  function readSalesRows(filePath) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
    return toteatSalesSync ? toteatSalesSync.filterLegacy(filePath, rows) : rows;
  }
  const uploadsRoot = options.uploadsRoot || process.env.BREWIT_UPLOADS_ROOT || path.join(__dirname, 'uploads');
  const weeksRoot = path.join(uploadsRoot, 'weeks');
  const mastersRoot = path.join(uploadsRoot, 'masters');
  const stagingRoot = path.join(uploadsRoot, '.staging');
  const configRoot = path.join(uploadsRoot, 'config');
  const transactionsRoot = path.join(uploadsRoot, 'transactions');
  const productReportsRoot = path.join(uploadsRoot, 'reports', 'products');
  const purchaseOrdersRoot = path.join(uploadsRoot, 'reports', 'purchase-orders');
  const trashLocationsRoot = path.join(uploadsRoot, 'trash', 'locations');
  const toteatProfilesRoot = path.join(uploadsRoot, '.integrations', 'toteat');
  const locationsPath = path.join(configRoot, 'locations.json');
  const companyProfilePath = path.join(configRoot, 'company-profile.json');
  const purchaseOrderCounterPath = path.join(configRoot, 'purchase-order-counter.json');
  const purchaseProjectionPoliciesPath = path.join(configRoot, 'purchase-projection-policies.json');
  const findingsRegistryPath = path.join(configRoot, 'findings.json');
  const generalExpensesPath = path.join(configRoot, 'general-expenses.json');
  const sourcePolicyPath = path.join(configRoot, 'source-policy.json');
  const synchronizedOnly = options.sourceMode === 'synchronized' || (options.sourceMode !== 'legacy' && readJson(sourcePolicyPath, {}).mode === 'synchronized');
  const { TRANSACTION_FIELDS, INVENTORY_FIELDS, synchronizedMaster, effectiveRecipeVersions } = require('./synchronized-sources');
  function synchronizedTransactions(locationId, field) {
    return field === 'purchases' ? toteatSalesSync?.purchases.source(locationId,field) || [] : toteatSalesSync?.source(locationId,field) || [];
  }
  function synchronizedStock(locationId) {
    const state=stockSync.current(locationId);
    if(!state || state.sourceKind !== 'public-inventory') throw Error('No hay inventario API sincronizado para esta ubicación. Actualiza las fuentes; no se utilizará un Kardex descargado.');
    return state;
  }
  const productAnalyticsSourceCache = new Map();
  const demandEnrichmentCache = new Map();
  const toteatMasterDownloadBatches = new Map();
  ensureDir(weeksRoot);
  ensureDir(mastersRoot);
  ensureDir(stagingRoot);
  ensureDir(configRoot);
  ensureDir(transactionsRoot);
  ensureDir(productReportsRoot);
  ensureDir(purchaseOrdersRoot);
  ensureDir(trashLocationsRoot);
  ensureDir(toteatProfilesRoot);
  const toteatAutomation = options.toteatAutomation || createToteatAutomation(toteatProfilesRoot);
  migrateLegacySundayWeeks(weeksRoot);
  if (!fs.existsSync(locationsPath)) {
    const createdAt = new Date().toISOString();
    writeJsonAtomic(locationsPath, {
      locations: DEFAULT_LOCATIONS.map(location => ({ ...location, status: 'active', createdAt }))
    });
  }
  if (!fs.existsSync(companyProfilePath)) {
    writeJsonAtomic(companyProfilePath, {
      name: 'CODE SPA',
      taxId: '',
      logoUrl: 'docs/brewit-final-01.jpg',
      exportDecimalSystem: 'comma'
    });
  }
  if (!fs.existsSync(generalExpensesPath)) {
    writeJsonAtomic(generalExpensesPath, { version: 1, records: [] });
  }

  function readLocations() {
    return readJson(locationsPath, { locations: [] });
  }

  function readGeneralExpenses() {
    const stored = readJson(generalExpensesPath, { version: 1, records: [] });
    return { version: 1, records: Array.isArray(stored.records) ? stored.records : [] };
  }

  function activeLocation(id) {
    return readLocations().locations.find(location => location.id === id && location.status === 'active') || null;
  }

  function publicLocation(location) {
    return { ...location, label: location.name, fields: fieldsForLocation(location.type) };
  }

  function readCompanyProfile() {
    const defaults = {
      name: 'CODE SPA',
      taxId: '',
      logoUrl: 'docs/brewit-final-01.jpg',
      exportDecimalSystem: 'comma'
    };
    const profile = { ...defaults, ...readJson(companyProfilePath, defaults) };
    if (!['comma', 'dot'].includes(profile.exportDecimalSystem)) profile.exportDecimalSystem = 'comma';
    return profile;
  }

  function readPurchaseProjectionPolicies() {
    return readJson(purchaseProjectionPoliciesPath, { locations: {} });
  }

  function readFindingsRegistry() {
    const registry = readJson(findingsRegistryPath, { version: 1, lastNumber: 0, records: [] });
    return {
      version: 1,
      lastNumber: Math.max(0, Number(registry.lastNumber) || 0),
      records: Array.isArray(registry.records) ? registry.records : []
    };
  }

  function projectionToday() {
    const configured = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
    return configured || businessClock().today;
  }

  function transactionLocationRoot(locationId) {
    return path.join(transactionsRoot, locationId);
  }

  function transactionIndexPath(locationId) {
    return path.join(transactionLocationRoot(locationId), 'index.json');
  }

  function readTransactionIndex(locationId) {
    return readJson(transactionIndexPath(locationId), { location: locationId, fields: {}, exclusions: {} });
  }

  function writeTransactionIndex(locationId, index) {
    ensureDir(transactionLocationRoot(locationId));
    writeJsonAtomic(transactionIndexPath(locationId), index);
  }

  function rebuildTransactionExclusions(index) {
    const exclusions = {};
    for (const field of Object.values(index.fields || {})) {
      for (const record of field.files || []) {
        for (const effect of record.replacementEffects || []) {
          exclusions[effect.sourceId] ||= [];
          exclusions[effect.sourceId].push(effect.range);
        }
      }
    }
    index.exclusions = exclusions;
  }

  function dateIsExcluded(date, ranges = []) {
    return ranges.some(range => date >= range.from && date <= range.to);
  }

  function storedTransactionFiles(locationId, field) {
    if(synchronizedOnly && TRANSACTION_FIELDS.has(field)) return synchronizedTransactions(locationId,field);
    if(synchronizedOnly && INVENTORY_FIELDS.has(field)) return [];
    const index = readTransactionIndex(locationId);
    const root = transactionLocationRoot(locationId);
    const stored = (index.fields?.[field]?.files || []).flatMap(record => {
      const filePath = path.resolve(root, record.name || '');
      if (!record.name || path.dirname(filePath) !== path.resolve(root) || !fs.existsSync(filePath)) return [];
      return [{
        week: null,
        destination: root,
        record,
        filePath,
        sourceId: record.id,
        excludedRanges: index.exclusions?.[record.id] || []
      }];
    });
    if (field === 'purchases') return [...stored, ...(toteatSalesSync?.purchases.source(locationId, field) || [])];
    return field === 'payment-details' ? [...stored, ...(toteatSalesSync?.source(locationId, field) || [])] : stored;
  }

  function storedSalesFiles(locationId) {
    if(synchronizedOnly) return synchronizedTransactions(locationId,'sales');
    const output = [];
    for (const week of fs.readdirSync(weeksRoot).filter(isValidWeekKey)) {
      const destination = path.join(weeksRoot, week, locationId);
      const metadata = readJson(path.join(destination, 'meta.json'), null);
      for (const record of salesRecordParts(metadata?.files?.sales)) {
        if (!record?.name) continue;
        const filePath = path.resolve(destination, record.name);
        if (path.dirname(filePath) === path.resolve(destination) && fs.existsSync(filePath)) {
          const sourceId = `legacy:${week}:${locationId}:sales:${record.name}`;
          const index = readTransactionIndex(locationId);
          output.push({ week, destination, record, filePath, sourceId, excludedRanges: index.exclusions?.[sourceId] || [] });
        }
      }
    }
    return [...output, ...storedTransactionFiles(locationId, 'sales'), ...(toteatSalesSync?.source(locationId, 'sales') || [])];
  }

  function periodSalesData(locationId, dateFrom, dateTo, { apiOnly = false } = {}) {
    const rows = [];
    const orderMap = new Map();
    const rowsByOrder = new Map();
    const seenRows = new Set();
    const warnings = [];
    let filesRead = 0;

    for (const stored of (apiOnly ? toteatSalesSync?.source(locationId, 'sales') || [] : storedSalesFiles(locationId))) {
      try {
        const fileRows = readSalesRows(stored.filePath);
        filesRead += 1;
        for (const row of fileRows) {
          const date = cellDate(rowValue(row, apiOnly ? ['Fecha de cierre'] : ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
          if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
          const canonicalRow = Object.entries(row)
            .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
            .sort(([left], [right]) => left.localeCompare(right));
          const rowKey = `${locationId}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
          if (seenRows.has(rowKey)) continue;
          seenRows.add(rowKey);

          const orderKey = `${locationId}:${salesTransactionKey(row)}`;
          const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
          const item = {
            orderKey,
            lineId: row['API Line ID'] ? String(row['API Line ID']) : null,
            parentLineId: row['API Line Reference'] ? String(row['API Line Reference']) : null,
            date,
            code,
            name: repairMojibake(rowValue(row, ['Nombre', 'Producto'])) || code,
            quantity: row['API Source'] === 'Toteat' ? (numericValue(rowValue(row, ['Cantidad'])) ?? 0) : Math.max(0, numericValue(rowValue(row, ['Cantidad'])) ?? 1),
            extraHierarchyId: String(rowValue(row, ['BA.']) ?? '').trim(),
            extraHierarchyName: repairMojibake(rowValue(row, ['Jerarquía de Extras', 'Jerarquia de Extras']))
          };
          rows.push(item);
          const orderRows = rowsByOrder.get(orderKey) || [];
          orderRows.push(item);
          rowsByOrder.set(orderKey, orderRows);

          if (!orderMap.has(orderKey)) {
            const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
            if (gross !== null) {
              const discounts = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
              orderMap.set(orderKey, { orderKey, locationId, date, net: (gross + discounts) / 1.19 });
            }
          }
        }
      } catch {
        warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name}.`);
      }
    }

    for (const orderRows of rowsByOrder.values()) {
      const baseRows = orderRows.filter(item => item.code && !item.code.startsWith('BX') && !item.extraHierarchyId);
      const soleBase = baseRows.length === 1 ? baseRows[0] : null;
      let currentBase = null;
      for (const item of orderRows) {
        if (baseRows.includes(item)) currentBase = item;
        const parent = item.parentLineId ? orderRows.find(row => row.lineId === item.parentLineId) : null;
        const base = item.parentLineId ? parent : currentBase || soleBase;
        item.baseProductCode = base?.code || null;
        item.baseProductName = base?.name || null;
      }
    }
    return { rows, orderFacts: [...orderMap.values()], warnings, filesRead, apiOnly };
  }

  function recipeLinesForProduct(recipes, code) {
    if (!recipes || !code) return [];
    return recipes.get(code) || recipes.get(String(code).toUpperCase()) || [];
  }

  function lac001SubstitutionSummary(salesData, dateFrom, dateTo, recipes, catalog, costResolver = null) {
    const targetCodes = ['BX1010', 'BX1020', 'BX1030'];
    const targetCodeSet = new Set(targetCodes);
    const lac001Reference = costResolver?.resolve('LAC001', 'L', catalog?.get('LAC001'))
      || { unitCost: unitCostForRecipeUnit(catalog?.get('LAC001'), 'L') ?? 0, source: 'master', sourceDate: null };
    const lac001UnitCost = lac001Reference.unitCost;
    const rowsByCode = new Map(targetCodes.map(code => [code, {
      code,
      name: catalog?.get(code)?.name || code,
      orderKeys: new Set(),
      substitutionCount: 0,
      matchedSubstitutionCount: 0,
      lac001VolumeLiters: 0,
      unresolvedSubstitutionCount: 0
    }]));
    const allOrderKeys = new Set();
    for (const row of salesData.rows) {
          const { orderKey, code, quantity } = row;
          if (!targetCodeSet.has(code) || !quantity) continue;
          if (!quantity) continue;
          const detail = rowsByCode.get(code);
          detail.orderKeys.add(orderKey);
          detail.substitutionCount += quantity;
          allOrderKeys.add(orderKey);

          const lac001Lines = recipeLinesForProduct(recipes, row.baseProductCode)
            .filter(recipe => String(recipe.ingredientId || '').trim().toUpperCase() === 'LAC001');
          let volumePerProduct = 0;
          let recipeResolved = lac001Lines.length > 0;
          for (const recipe of lac001Lines) {
            const canonical = canonicalConsumptionUnit(recipe.unit);
            if (canonical.unit !== 'L') {
              recipeResolved = false;
              continue;
            }
            const yieldFactor = recipe.yieldRate > 0 ? recipe.yieldRate / 100 : 1;
            volumePerProduct += recipe.quantity / yieldFactor * canonical.factor;
          }
          if (!recipeResolved || !volumePerProduct) {
            detail.unresolvedSubstitutionCount += quantity;
            continue;
          }
          detail.matchedSubstitutionCount += quantity;
          detail.lac001VolumeLiters += quantity * volumePerProduct;
    }

    const items = targetCodes.map(code => {
      const item = rowsByCode.get(code);
      return {
        code: item.code,
        name: item.name,
        salesCount: item.orderKeys.size,
        substitutionCount: item.substitutionCount,
        matchedSubstitutionCount: item.matchedSubstitutionCount,
        lac001VolumeLiters: item.lac001VolumeLiters,
        unresolvedSubstitutionCount: item.unresolvedSubstitutionCount,
        unitCost: lac001UnitCost,
        costSource: lac001Reference.source,
        costSourceDate: lac001Reference.sourceDate,
        hasCost: lac001Reference.source !== 'missing',
        substitutedCost: lac001Reference.source !== 'missing' ? item.lac001VolumeLiters * lac001UnitCost : 0
      };
    });
    return {
      dateFrom,
      dateTo,
      salesCount: allOrderKeys.size,
      substitutionCount: items.reduce((sum, item) => sum + item.substitutionCount, 0),
      matchedSubstitutionCount: items.reduce((sum, item) => sum + item.matchedSubstitutionCount, 0),
      lac001VolumeLiters: items.reduce((sum, item) => sum + item.lac001VolumeLiters, 0),
      lac001UnitCost,
      costSource: lac001Reference.source,
      costSourceDate: lac001Reference.sourceDate,
      hasCost: lac001Reference.source !== 'missing',
      totalSubstitutedCost: items.reduce((sum, item) => sum + item.substitutedCost, 0),
      unresolvedSubstitutionCount: items.reduce((sum, item) => sum + item.unresolvedSubstitutionCount, 0),
      warnings: salesData.warnings,
      items
    };
  }

  function syrupSauceSubstitutionSummary(salesData, dateFrom, dateTo, recipes, catalog, catalogAssignments, costResolver = null) {
    const targetHierarchy = 'BA.090';
    const ingredientHierarchy = 'IC.030';
    const itemMap = new Map();
    const allOrderKeys = new Set();
    let substitutionCount = 0;
    let matchedSubstitutionCount = 0;
    let unresolvedSubstitutionCount = 0;
    const flavorType = value => {
      const name = normalizeHeader(value).replace(/[_-]+/g, ' ');
      if (/\bsalsa\b/.test(name)) return 'sauce';
      if (/\bsyrup\b/.test(name) && !/\bgoma\b/.test(name)) return 'flavoredSyrup';
      if (/\bgoma\b/.test(name)) return 'gum';
      return null;
    };
    const meaningfulTokens = value => new Set(normalizeHeader(value).replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
      .filter(token => token.length > 2 && !['syrup', 'salsa', 'goma', 'iced', 'hot', 'latte', 'frappe', 'cafe', 'matcha', 'sin', 'con', 'extra'].includes(token)));
    const candidateScore = (recipe, row, replacementType) => {
      const candidateName = catalog?.get(recipe.ingredientId)?.name || recipe.ingredientName;
      const candidateType = flavorType(candidateName);
      let score = candidateType === replacementType ? 100 : 0;
      const productTokens = meaningfulTokens(row.baseProductName);
      const candidateTokens = meaningfulTokens(candidateName);
      for (const token of candidateTokens) if (productTokens.has(token)) score += 10;
      score += Math.min(Math.max(Number(recipe.quantity) || 0, 0), 1000) / 10000;
      return score;
    };
    const isFlavorIngredient = recipe => {
      const assignment = catalogAssignments?.get(String(recipe.ingredientId || '').trim().toUpperCase());
      return assignment?.type === 'ingredient' && (assignment.hierarchyId === ingredientHierarchy
        || String(assignment.hierarchyId || '').startsWith(`${ingredientHierarchy}.`));
    };

    for (const row of salesData.rows) {
      if (row.extraHierarchyId !== targetHierarchy
        && !row.extraHierarchyId.startsWith(`${targetHierarchy}.`)) continue;
      if (!row.code || !row.quantity) continue;
      allOrderKeys.add(row.orderKey);
      substitutionCount += row.quantity;
      const recipeLines = recipeLinesForProduct(recipes, row.baseProductCode);
      let candidates = recipeLines.filter(isFlavorIngredient);
      if (!candidates.length) {
        candidates = recipeLines.filter(recipe => /\bsyrup\b|\bsalsa\b|\bgoma\b/.test(normalizeHeader(recipe.ingredientName)));
      }
      const replacementType = flavorType(row.name);
      if (replacementType === 'flavoredSyrup' || replacementType === 'sauce') {
        const sameType = candidates.filter(recipe => flavorType(
          catalog?.get(recipe.ingredientId)?.name || recipe.ingredientName
        ) === replacementType);
        if (sameType.length) candidates = sameType;
      }
      const original = [...candidates]
        .sort((left, right) => candidateScore(right, row, replacementType) - candidateScore(left, row, replacementType))[0] || null;
      const status = original ? 'resolved' : 'unresolved';
      if (status === 'resolved') matchedSubstitutionCount += row.quantity;
      else unresolvedSubstitutionCount += row.quantity;
      const originalCode = original ? String(original.ingredientId || '').trim().toUpperCase() : '';
      const originalName = original
        ? catalog?.get(original.ingredientId)?.name || original.ingredientName || originalCode
        : 'Sin ingrediente original identificable';
      const canonical = original ? canonicalConsumptionUnit(original.unit) : { unit: '', factor: 0 };
      const catalogItem = original ? catalog?.get(original.ingredientId) : null;
      const costReference = original
        ? costResolver?.resolve(original.ingredientId, canonical.unit, catalogItem)
          || { unitCost: unitCostForRecipeUnit(catalogItem, canonical.unit) ?? 0, source: catalogItem?.unitCost ? 'master' : 'missing', sourceDate: null }
        : { unitCost: 0, source: 'missing', sourceDate: null };
      const unitCost = costReference.unitCost;
      const key = `${row.code}:${originalCode || status}:${canonical.unit}`;
      const item = itemMap.get(key) || {
        replacementCode: row.code,
        replacementName: catalog?.get(row.code)?.name || row.name || row.code,
        originalCode,
        originalName,
        status,
        unit: canonical.unit,
        unitCost,
        costSource: costReference.source,
        costSourceDate: costReference.sourceDate,
        hasCost: costReference.source !== 'missing',
        orderKeys: new Set(),
        baseProducts: new Map(),
        substitutionCount: 0,
        theoreticalQuantity: 0,
        substitutedCost: 0
      };
      item.orderKeys.add(row.orderKey);
      if (row.baseProductCode) item.baseProducts.set(row.baseProductCode, row.baseProductName || row.baseProductCode);
      item.substitutionCount += row.quantity;
      if (original) {
        const yieldFactor = original.yieldRate > 0 ? original.yieldRate / 100 : 1;
        const theoreticalQuantity = row.quantity * original.quantity / yieldFactor * canonical.factor;
        item.theoreticalQuantity += theoreticalQuantity;
        if (costReference.source !== 'missing') item.substitutedCost += theoreticalQuantity * unitCost;
      }
      itemMap.set(key, item);
    }

    const items = [...itemMap.values()].map(item => ({
      replacementCode: item.replacementCode,
      replacementName: item.replacementName,
      originalCode: item.originalCode,
      originalName: item.originalName,
      status: item.status,
      unit: item.unit,
      salesCount: item.orderKeys.size,
      substitutionCount: item.substitutionCount,
      theoreticalQuantity: item.theoreticalQuantity,
      unitCost: item.unitCost,
      costSource: item.costSource,
      costSourceDate: item.costSourceDate,
      hasCost: item.hasCost,
      substitutedCost: item.substitutedCost,
      baseProducts: [...item.baseProducts].map(([code, name]) => ({ code, name }))
    })).sort((left, right) => right.substitutionCount - left.substitutionCount
      || left.replacementName.localeCompare(right.replacementName, 'es')
      || left.originalName.localeCompare(right.originalName, 'es'));
    const totalsByUnit = [...items.reduce((totals, item) => {
      if (item.status === 'resolved' && item.unit) {
        totals.set(item.unit, (totals.get(item.unit) || 0) + item.theoreticalQuantity);
      }
      return totals;
    }, new Map())].map(([unit, quantity]) => ({ unit, quantity }));
    return {
      dateFrom,
      dateTo,
      targetHierarchy,
      salesCount: allOrderKeys.size,
      substitutionCount,
      matchedSubstitutionCount,
      ambiguousSubstitutionCount: 0,
      unresolvedSubstitutionCount,
      totalsByUnit,
      totalSubstitutedCost: items.reduce((sum, item) => sum + item.substitutedCost, 0),
      itemsWithoutCost: items.filter(item => item.status === 'resolved' && !item.hasCost)
        .map(item => item.originalCode || item.originalName),
      warnings: salesData.warnings,
      items
    };
  }

  function storedWeeklyFiles(locationId, field) {
    if(synchronizedOnly && TRANSACTION_FIELDS.has(field)) return synchronizedTransactions(locationId,field);
    if(synchronizedOnly && INVENTORY_FIELDS.has(field)) return [];
    const output = [];
    for (const week of fs.readdirSync(weeksRoot).filter(isValidWeekKey)) {
      const destination = path.join(weeksRoot, week, locationId);
      const metadata = readJson(path.join(destination, 'meta.json'), null);
      const stored = metadata?.files?.[field];
      const records = Array.isArray(stored) ? stored : stored ? [stored] : [];
      for (const record of records) {
        if (!record?.name) continue;
        const filePath = path.resolve(destination, record.name);
        if (path.dirname(filePath) === path.resolve(destination) && fs.existsSync(filePath)) {
          const sourceId = `legacy:${week}:${locationId}:${field}:${record.name}`;
          const index = readTransactionIndex(locationId);
          output.push({ week, destination, record, filePath, sourceId, excludedRanges: index.exclusions?.[sourceId] || [] });
        }
      }
    }
    return [...output, ...storedTransactionFiles(locationId, field)];
  }

  function chronologicalSources(locationId, field) {
    return storedWeeklyFiles(locationId, field).sort((left, right) =>
      String(left.record.savedAt || left.week || '').localeCompare(String(right.record.savedAt || right.week || '')));
  }

  function mergedKardexData(locationId, field) {
    if(synchronizedOnly) {
      const state=synchronizedStock(locationId),location=activeLocation(locationId);
      return require('./inventory-original-report').originalReportData(state,location,{initialDate:state.range.from,finalDate:state.range.to,initialBasis:'initial',finalBasis:'final'},state.range.from,state.range.to,{waste:field==='waste',completeSeries:true}).parsed;
    }
    const sources = chronologicalSources(locationId, field);
    if (!sources.length) return null;
    const productMap = new Map();
    const dateMetrics = new Map();
    for (const source of sources) {
      let parsed;
      try {
        parsed = parseKardexWorkbook(source.filePath);
      } catch {
        continue;
      }
      for (const group of parsed.groups) {
        if (dateIsExcluded(group.date, source.excludedRanges)) continue;
        if (!dateMetrics.has(group.date)) dateMetrics.set(group.date, new Map());
        const metrics = dateMetrics.get(group.date);
        group.metrics.forEach(metric => {
          const key = metric.normalized;
          metrics.set(key, metric.label);
        });
        for (const product of parsed.products) {
          const productKey = product.code || normalizeHeader(product.name);
          if (!productMap.has(productKey)) {
            productMap.set(productKey, { code: product.code, name: product.name, unit: product.unit, values: new Map() });
          }
          const target = productMap.get(productKey);
          target.code = product.code || target.code;
          target.name = product.name || target.name;
          target.unit = product.unit || target.unit;
          for (const metric of group.metrics) {
            const valueKey = `${group.date}|${metric.normalized}`;
            target.values.set(valueKey, numericValue(product.row[metric.column]) || 0);
          }
        }
      }
    }
    if (!dateMetrics.size) throw new Error('No stored Kardex contains the expected dated structure.');
    const groups = [];
    let column = 3;
    for (const date of [...dateMetrics.keys()].sort()) {
      const metrics = [...dateMetrics.get(date)].map(([normalized, label]) => ({ column: column++, label, normalized }));
      groups.push({ date, startColumn: metrics[0]?.column || column, metrics });
    }
    const movementDefinitions = [];
    const movementKeys = new Set();
    groups.forEach(group => group.metrics.forEach(metric => {
      if (/^(ii\s*-|if\s*-|costo$)/i.test(metric.normalized)) return;
      const key = metric.normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!movementKeys.has(key)) {
        movementKeys.add(key);
        movementDefinitions.push({ key, label: metric.label });
      }
    }));
    const products = [...productMap.values()].map(product => {
      const row = [product.code, product.name, product.unit];
      groups.forEach(group => group.metrics.forEach(metric => {
        row[metric.column] = product.values.get(`${group.date}|${metric.normalized}`) || 0;
      }));
      return { row, code: product.code, name: product.name, unit: product.unit };
    });
    return { sheetName: 'Consolidado', groups, movementDefinitions, products, sources };
  }

  function mergedConsumptionProducts(locationId, field, dateFrom, dateTo) {
    const sources = chronologicalSources(locationId, field);
    const dailyProducts = new Map();
    const datesProcessed = new Set();
    let sheetName = null;
    for (const source of sources) {
      let sheets;
      try {
        sheets = consumptionProductSheets(XLSX.readFile(source.filePath, { cellDates: true }));
      } catch {
        continue;
      }
      for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
        if (dateIsExcluded(date, source.excludedRanges)) continue;
        try {
          const parsed = parseConsumptionProductsFromSheets(sheets, date, date);
          sheetName ||= parsed.sheetName;
          datesProcessed.add(date);
          parsed.products.forEach(product => {
            const key = `${date}|${product.code || normalizeHeader(product.name)}`;
            if (!dailyProducts.has(key)) dailyProducts.set(key, product);
          });
        } catch {
          // This source simply has no product data for the requested day.
        }
      }
    }
    if (!dailyProducts.size) throw new Error(`No product sheet contains dates between ${dateFrom} and ${dateTo}.`);
    const products = new Map();
    dailyProducts.forEach(product => {
      const key = product.code || normalizeHeader(product.name);
      const current = products.get(key) || { ...product, quantity: 0, totalCost: 0 };
      current.quantity += product.quantity;
      current.totalCost += product.totalCost;
      products.set(key, current);
    });
    const items = [...products.values()];
    return {
      sheetName: sheetName || 'Productos consolidados',
      datesProcessed: [...datesProcessed].sort(),
      products: items,
      totalQuantity: items.reduce((sum, product) => sum + product.quantity, 0),
      totalCost: items.reduce((sum, product) => sum + product.totalCost, 0)
    };
  }

  function latestWeeklyFile(locationId, field) {
    if(synchronizedOnly && INVENTORY_FIELDS.has(field)) {
      const state=stockSync.current(locationId);
      if(state?.sourceKind!=='public-inventory')return null;
      return {originalName:field==='waste'?'Merma · Toteat API':'Inventario · Toteat API',source:'toteat-api',dataThrough:state.range.to,confirmedRange:state.range,detectedRange:state.range,savedAt:state.sourceCapturedAt,previewUrl:`/api/inventory/synchronized-preview?location=${encodeURIComponent(locationId)}&field=${field}`,url:`/api/integrations/toteat/stock/export?location=${encodeURIComponent(locationId)}`};
    }
    const candidates = storedWeeklyFiles(locationId, field).map(stored => ({
      ...stored.record,
      week: stored.week,
      filePath: stored.filePath,
      sourceId: stored.sourceId,
      excludedRanges: stored.excludedRanges,
      dataThrough: stored.record.detectedRange?.to || stored.record.confirmedRange?.to || stored.week || '',
      confirmedRange: stored.record.confirmedRange || null,
      savedAt: stored.record.savedAt || null,
      previewUrl: stored.week
        ? `/api/weeks/${stored.week}/${encodeURIComponent(locationId)}/${field}/preview`
        : `/api/transactions/${encodeURIComponent(locationId)}/${field}/preview?source=${encodeURIComponent(stored.sourceId)}`
    }));
    return candidates.sort((left, right) =>
      right.dataThrough.localeCompare(left.dataThrough)
      || String(right.savedAt || '').localeCompare(String(left.savedAt || ''))
      || String(right.week || '').localeCompare(String(left.week || '')))[0] || null;
  }

  function masterFiles(field, location) {
    const index = readJson(path.join(mastersRoot, 'masters.json'), {});
    const candidates = [];
    for (const [version, group] of Object.entries(index)) {
      const record = group[field];
      if (!record || !record.name || !isValidDate(record.validFrom)) continue;
      if(synchronizedOnly && record.source !== 'toteat-shared-api') continue;
      const filePath = path.resolve(mastersRoot, record.name);
      if (path.dirname(filePath) !== path.resolve(mastersRoot) || !fs.existsSync(filePath)) continue;
      candidates.push({ ...record, version, filePath });
    }
    return candidates.sort((left, right) =>
      right.validFrom.localeCompare(left.validFrom)
      || String(right.savedAt || right.version).localeCompare(String(left.savedAt || left.version)));
  }

  function latestMasterFile(field, effectiveDate, location) {
    const records=masterFiles(field,location);
    return synchronizedOnly ? synchronizedMaster(records,effectiveDate) : records.find(record => record.validFrom <= effectiveDate) || null;
  }

  function resolveRecipes(effectiveDate, location) {
    if(synchronizedOnly) {
      const master=latestMasterFile('master-recipes',effectiveDate,location);
      const recipes=master?parseRecipes(master.filePath):new Map();
      return {recipes,primary:master,sources:master?[{master,contributedProducts:recipes.size}]:[],errors:[]};
    }
    const allMasters = masterFiles('master-recipes').filter(record => record.source !== 'toteat-shared-api' || record.validFrom <= effectiveDate);
    const datedMaster = allMasters.find(record => record.validFrom <= effectiveDate) || null;
    if (datedMaster?.source === 'toteat-shared-api') {
      const recipes = parseRecipes(datedMaster.filePath);
      return { recipes, primary: datedMaster, sources: [{ master: datedMaster, contributedProducts: recipes.size }], errors: [] };
    }
    const orderedMasters = [...new Map([
      datedMaster,
      allMasters[0],
      ...allMasters
    ].filter(Boolean).map(record => [`${record.version}:${record.name}`, record])).values()];
    const recipes = new Map();
    const sources = [];
    const errors = [];
    for (const master of orderedMasters) {
      try {
        const parsed = parseRecipes(master.filePath);
        let contributedProducts = 0;
        for (const [productCode, lines] of parsed) {
          if (recipes.has(productCode)) continue;
          recipes.set(productCode, lines);
          contributedProducts += 1;
        }
        sources.push({ master, contributedProducts });
      } catch (error) {
        errors.push(`${master.originalName || master.name}: ${error.message}`);
      }
    }
    return {
      recipes,
      primary: sources[0]?.master || orderedMasters[0] || null,
      sources,
      errors
    };
  }

  function salesHistory(locationId, additionalExcludedRanges = []) {
    const keys = new Set();
    let latestTransactionAt = null;
    let filesRead = 0;
    for (const stored of storedSalesFiles(locationId)) {
      const rows = readSalesRows(stored.filePath);
      filesRead += 1;
      for (const row of rows) {
        const rowDate = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
        if (rowDate && (dateIsExcluded(rowDate, stored.excludedRanges) || dateIsExcluded(rowDate, additionalExcludedRanges))) continue;
        keys.add(salesTransactionKey(row));
        const dateTime = salesTransactionDateTime(row);
        if (dateTime && (!latestTransactionAt || dateTime > latestTransactionAt)) latestTransactionAt = dateTime;
      }
    }
    return { keys, latestTransactionAt, transactionCount: keys.size, filesRead };
  }

  function prepareIncrementalSales(staged, locationId, stagingDirectory, additionalExcludedRanges = []) {
    const source = path.join(stagingDirectory, staged.filename);
    const rows = readSalesRows(source);
    const history = salesHistory(locationId, additionalExcludedRanges);
    const acceptedKeys = new Set();
    const duplicateKeys = new Set();
    const filteredRows = rows.filter(row => {
      const key = salesTransactionKey(row);
      if (history.keys.has(key)) {
        duplicateKeys.add(key);
        return false;
      }
      if (key.startsWith('row:') && acceptedKeys.has(key)) {
        duplicateKeys.add(key);
        return false;
      }
      acceptedKeys.add(key);
      return true;
    });
    let latestTransactionAt = history.latestTransactionAt;
    for (const row of filteredRows) {
      const dateTime = salesTransactionDateTime(row);
      if (dateTime && (!latestTransactionAt || dateTime > latestTransactionAt)) latestTransactionAt = dateTime;
    }
    if (!filteredRows.length) {
      fs.rmSync(source, { force: true });
      return {
        staged: null,
        stats: {
          uploadedRows: rows.length,
          newRows: 0,
          newTransactions: 0,
          duplicateTransactions: duplicateKeys.size,
          latestTransactionAt
        }
      };
    }
    const incrementalFilename = `${path.parse(staged.filename).name}_solo_nuevas.xlsx`;
    const incrementalPath = path.join(stagingDirectory, incrementalFilename);
    writeSalesRows(incrementalPath, filteredRows);
    fs.rmSync(source, { force: true });
    const acceptedDates = filteredRows.map(row => cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre'])))
      .filter(Boolean).sort();
    return {
      staged: {
        ...staged,
        filename: incrementalFilename,
        size: fs.statSync(incrementalPath).size,
        detectedRange: acceptedDates.length ? { from: acceptedDates[0], to: acceptedDates.at(-1) } : staged.detectedRange,
        transactionCount: acceptedKeys.size,
        rowCount: filteredRows.length,
        latestTransactionAt
      },
      stats: {
        uploadedRows: rows.length,
        newRows: filteredRows.length,
        newTransactions: acceptedKeys.size,
        duplicateTransactions: duplicateKeys.size,
        latestTransactionAt
      }
    };
  }

  function genericTransactionRowDate(row, header = []) {
    const dates = [];
    const dateOrder = dateOrderForHeaders(header);
    row.forEach((value, column) => {
      const normalizedHeader = normalizeHeader(header[column]);
      const isDateColumn = /\b(fecha|date)\b/.test(normalizedHeader)
        || ['dateclosing', 'closingdate'].includes(normalizedHeader.replace(/\s+/g, ''));
      const parsed = value instanceof Date || typeof value === 'string' || isDateColumn ? cellDate(value, dateOrder) : null;
      if (parsed) dates.push(parsed);
      if (typeof value === 'string') datesInText(value, dateOrder).forEach(date => dates.push(date));
    });
    return dates.sort()[0] || null;
  }

  function genericTransactionRowKey(row) {
    const values = row.map(value => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
      if (typeof value === 'string') return value.trim();
      return value ?? '';
    });
    return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
  }

  function readGenericTransactionSheets(filePath) {
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    return workbook.SheetNames.map(name => ({
      name,
      rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false
      })
    }));
  }

  function genericTransactionHistory(locationId, field, additionalExcludedRanges = []) {
    const keys = new Set();
    for (const stored of storedTransactionFiles(locationId, field)) {
      for (const sheet of readGenericTransactionSheets(stored.filePath)) {
        const header = sheet.rows[0] || [];
        for (const row of sheet.rows.slice(1)) {
          const date = genericTransactionRowDate(row, header);
          if (date && (dateIsExcluded(date, stored.excludedRanges) || dateIsExcluded(date, additionalExcludedRanges))) continue;
          keys.add(genericTransactionRowKey(row));
        }
      }
    }
    return keys;
  }

  function latestGenericTransactionAt(locationId, field) {
    let latest = null;
    for (const stored of storedWeeklyFiles(locationId, field)) {
      for (const sheet of readGenericTransactionSheets(stored.filePath)) {
        const header = sheet.rows[0] || [];
        for (const row of sheet.rows.slice(1)) {
          const record = Object.fromEntries(header.map((name, index) => [name, row[index]]));
          const date = field === 'purchases'
            ? cellDate(rowValue(record, ['Fecha emisión', 'Fecha emision', 'Broadcast date', 'Issue Date']))
            : cellDate(rowValue(record, ['FechaCierre', 'Fecha Cierre', 'DateClosing', 'Closing Date', 'Fecha']), dateOrderForHeaders(header));
          if (date && !dateIsExcluded(date, stored.excludedRanges) && (!latest || date > latest)) latest = date;
        }
      }
    }
    return latest;
  }

  function latestKardexAt(locationId, field) {
    try {
      const data = mergedKardexData(locationId, field);
      if (data?.groups?.length) return data.groups[data.groups.length - 1].date;
    } catch {}
    return latestWeeklyFile(locationId, field)?.dataThrough || null;
  }

  function transactionRecordDates(file) {
    const field = file.fieldname;
    if (['kardex', 'waste'].includes(field)) {
      return [...new Set(parseKardexWorkbook(file.path).groups.map(group => group.date))].sort();
    }
    if (field === 'sales') {
      return [...new Set(readSalesRows(file.path)
        .map(row => cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre'])))
        .filter(Boolean))].sort();
    }
    if (['purchases', 'payment-details'].includes(field)) {
      const dates = [];
      for (const sheet of readGenericTransactionSheets(file.path)) {
        const header = sheet.rows[0] || [];
        for (const row of sheet.rows.slice(1)) {
          const record = Object.fromEntries(header.map((name, index) => [name, row[index]]));
          const date = field === 'purchases'
            ? cellDate(rowValue(record, ['Fecha emisión', 'Fecha emision', 'Broadcast date', 'Issue Date']))
            : cellDate(rowValue(record, ['FechaCierre', 'Fecha Cierre', 'DateClosing', 'Closing Date', 'Fecha']), dateOrderForHeaders(header));
          if (date) dates.push(date);
        }
      }
      return [...new Set(dates)].sort();
    }
    return [];
  }

  function prepareIncrementalGenericTransactions(staged, locationId, stagingDirectory, field, sheetName, additionalExcludedRanges = []) {
    const source = path.join(stagingDirectory, staged.filename);
    const sheets = readGenericTransactionSheets(source);
    const historyKeys = genericTransactionHistory(locationId, field, additionalExcludedRanges);
    const acceptedKeys = new Set();
    const acceptedDates = [];
    let uploadedRows = 0;
    let duplicateTransactions = 0;
    const filteredSheets = sheets.map(sheet => {
      const header = sheet.rows[0] || [];
      const rows = sheet.rows.slice(1).filter(row => {
        uploadedRows += 1;
        const key = genericTransactionRowKey(row);
        if (historyKeys.has(key) || acceptedKeys.has(key)) {
          duplicateTransactions += 1;
          return false;
        }
        acceptedKeys.add(key);
        const date = genericTransactionRowDate(row, header);
        if (date) acceptedDates.push(date);
        return true;
      });
      return { name: sheet.name, rows: [header, ...rows], dataRows: rows.length };
    });
    if (!acceptedKeys.size) {
      fs.rmSync(source, { force: true });
      return {
        staged: null,
        stats: { uploadedRows, newRows: 0, newTransactions: 0, duplicateTransactions }
      };
    }
    const workbook = XLSX.utils.book_new();
    filteredSheets.forEach(sheet => {
      if (!sheet.dataRows) return;
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31) || sheetName);
    });
    const incrementalFilename = `${path.parse(staged.filename).name}_solo_nuevas.xlsx`;
    const incrementalPath = path.join(stagingDirectory, incrementalFilename);
    XLSX.writeFile(workbook, incrementalPath);
    fs.rmSync(source, { force: true });
    acceptedDates.sort();
    return {
      staged: {
        ...staged,
        filename: incrementalFilename,
        size: fs.statSync(incrementalPath).size,
        detectedRange: acceptedDates.length ? { from: acceptedDates[0], to: acceptedDates.at(-1) } : staged.detectedRange,
        transactionCount: acceptedKeys.size,
        rowCount: acceptedKeys.size
      },
      stats: {
        uploadedRows,
        newRows: acceptedKeys.size,
        newTransactions: acceptedKeys.size,
        duplicateTransactions
      }
    };
  }

  function prepareIncrementalMercadoPago(staged, locationId, stagingDirectory, additionalExcludedRanges = []) {
    return prepareIncrementalGenericTransactions(
      staged, locationId, stagingDirectory, 'mercadopago', 'MercadoPago', additionalExcludedRanges
    );
  }

  function prepareIncrementalPaymentDetails(staged, locationId, stagingDirectory, additionalExcludedRanges = []) {
    return prepareIncrementalGenericTransactions(
      staged, locationId, stagingDirectory, 'payment-details', 'Detalle Pagos', additionalExcludedRanges
    );
  }

  app.disable('x-powered-by');
  app.use(express.json());
  require('./operations/routes').registerOperations(app, {
    connectionString: options.operationsDatabaseUrl || process.env.BREWIT_DATABASE_URL,
    authKey: options.operationsAuthKey || process.env.BREWIT_AUTH_KEY,
    masters: () => toteatMasterSync?.sharedCurrent(),
    protectLegacy: process.env.BREWIT_REQUIRE_AUTH === '1'
  });
  app.use('/api', (req,res,next)=>{
    if(!synchronizedOnly || !/^\/(reports\/|sales\/|products(?:\/|$)|ingredients$|sales-by-ingredients$|financial-results$|findings$|purchase-projections$|inventory\/)/.test(req.path))return next();
    const send=res.json.bind(res);
    res.json=payload=>{
      if(payload && !Array.isArray(payload) && typeof payload==='object' && req.path !== '/masters') payload.sourcePolicy={mode:'synchronized',legacyFallback:false,
        masterHistory:'Se usa un maestro compartido observado; no se certifican recetas ni costos maestros históricos anteriores a la sincronización.',
        manualSources:['MercadoPago','Marketing','Colaboradores','Órdenes y gastos de Brewit']};
      if(payload?.sourcePolicy) {
        const from=payload.period?.from || req.query.dateFrom || req.body?.initialInventoryDate;
        const scope=payload.scope?.location || req.query.location || req.body?.location || 'all';
        const coverageWarnings=[];
        for(const location of readLocations().locations.filter(l=>l.status==='active' && (scope==='all'||scope===l.id))) {
          const id=location.type==='warehouse'?'store-1':location.id;
          for(const [name,service] of [['Ventas',toteatSalesSync],['Compras',toteatSalesSync.purchases]]) {
            if(name==='Ventas'&&location.type!=='store')continue;
            const status=service.status(id);
            if(!status.lastSuccess)coverageWarnings.push(`${name} (${location.name}): no hay sincronización disponible; no equivale a actividad cero.`);
            else if(from && status.from && status.from>from)coverageWarnings.push(`${name} (${location.name}): la cobertura comienza el ${status.from}; el período solicitado empieza antes.`);
          }
        }
        payload.sourcePolicy.coverageWarnings=coverageWarnings;
        if(Array.isArray(payload.warnings))payload.warnings.push(...coverageWarnings);
      }
      return send(payload);
    };
    next();
  });

  toteatSalesSync = registerToteatApi(app, { uploadsRoot, activeLocation, locations: () => readLocations().locations,
    fetchImpl: options.toteatApiFetch, enableSync: options.enableToteatSync,
    requestSpacing: options.toteatRequestSpacing, syncClock: options.toteatSyncClock });
  app.locals.toteatSalesSync = toteatSalesSync;
  toteatMasterSync = createMasterSync({ uploadsRoot, activeLocation,
    credentials: () => readJson(path.join(uploadsRoot, '.integrations', 'toteat-api', 'credentials.json'), {}),
    reader: (restaurant, readOptions) => require('./toteat-direct-masters').configured(uploadsRoot)
      ? require('./toteat-direct-masters').readDirectMasters(uploadsRoot, restaurant)
      : toteatAutomation.readNativeSources(restaurant, readOptions) });
  app.locals.toteatMasterSync = toteatMasterSync;
  const stockSync = createStockSync({ uploadsRoot, activeLocation,
    credentials: () => readJson(path.join(uploadsRoot, '.integrations/toteat-api/credentials.json'), {}),
    masters: () => toteatMasterSync.sharedCurrent(),
    publicReader: (config, range, warehouses) => toteatSalesSync.requestInventory(config, range, warehouses),
    reader: (restaurant, readOptions) => toteatAutomation.readNativeSources(restaurant, readOptions) });
  app.locals.toteatStockSync = stockSync;
  require('./upload-overview').registerUploadOverview(app, { uploadsRoot, enableSync: options.enableToteatSync, locations: () => readLocations().locations, sales: toteatSalesSync, masters: toteatMasterSync, stock: stockSync, files: (id, field) => storedFieldFiles(id, field).map(item => item.record), masterFiles: field => masterFiles(field) });
  require('./upload-records').registerUploadRecords(app, {location:activeLocation,load(location,field,from,to) {
    const central=location.id==='main-warehouse',id=central?'store-1':location.id;
    const within=d=>d&&d>=from&&d<=to;
    if(['counts','transformations','transfers'].includes(field)) {
      const state=stockSync.current(id);
      if(!state)return {rows:[],note:'Esta ubicación aún no tiene inventario sincronizado.'};
      const warehouses=new Map(state.warehouses.filter(w=>central?[1,4].includes(Number(w.custom_id)):[2,3].includes(Number(w.custom_id))).map(w=>[w.id,w.name]));
      const rows=state.daily.filter(r=>warehouses.has(r.warehouse)&&within(r.date)&&!r.carriedForward).flatMap(r=>{
        const base={Fecha:r.date,Bodega:warehouses.get(r.warehouse),Código:r.code,Producto:r.name,Unidad:r.unit};
        if(field==='counts')return r.physicalCount?[{...base,'Cantidad toma':r.opening}]:[];
        const defs=field==='transformations'?[['transformed_in','Entrada transformación',1],['transformed_out','Salida transformación',-1]]:[['transfer_local_in','Entrada entre locales',1],['transfer_local_out','Salida entre locales',-1],['transfer_warehouse_in','Entrada entre bodegas',1],['transfer_warehouse_out','Salida entre bodegas',-1]];
        return defs.filter(([k])=>r[k]!==0).map(([k,label,sign])=>({...base,Movimiento:label,Cantidad:r[k]*sign}));
      });
      return {rows,note:'Registros diarios por producto y bodega; no documentos individuales. Incluye la bodega de merma correspondiente.',updatedAt:state.sourceCapturedAt,coverage:state.range};
    }
    if(['marketing','employees'].includes(field)) {
      const sources=chronologicalSources(id,field),seen=new Set(),rows=[];let unreadable=0;
      for(const source of sources) {
        let sheets;try{sheets=consumptionProductSheets(XLSX.readFile(source.filePath,{cellDates:true}));}catch{unreadable++;continue;}
        for(let date=from;date<=to;date=addDays(date,1)) {
          if(dateIsExcluded(date,source.excludedRanges))continue;
          let data;try{data=parseConsumptionProductsFromSheets(sheets,date,date);}catch{continue;}
          for(const p of data.products){const key=date+'|'+(p.code||normalizeHeader(p.name));if(seen.has(key))continue;seen.add(key);rows.push({Fecha:date,Código:p.code,Producto:p.name,Cantidad:p.quantity,Unidad:p.unit});}
        }
      }
      return {rows,note:`Consumos por producto y día de los archivos cargados.${unreadable?' Hay archivos que no pudieron leerse.':''}`};
    }
    if(field==='purchases'&&toteatSalesSync.purchases.get(id)) {
      const state=toteatSalesSync.purchases.get(id),rows=[];
      for(const d of state.documents||[]) {
        const date=String(d.received_date||d.recieived_date||d.emission_date||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3').slice(0,10);
        if(!within(date))continue;
        for(const p of d.products||[]) {
          if(central?![1,4].includes(Number(p.warehouse)):![2,3].includes(Number(p.warehouse)))continue;
          rows.push({Fecha:date,Documento:d.document_id,Tipo:d.document_type,Proveedor:d.provider,Bodega:p.warehouse,Código:p.sku,Producto:p.product,'Cantidad recibida':p.received_quantity,Unidad:p.received_measurement,'Costo unitario':p.unit_price,'Total línea':p.total_price});
        }
      }
      return {rows,note:'Detalle de compras API por fecha de recepción (emisión si no se informó recepción), filtrado por bodega de la ubicación y su merma.'};
    }
    const api=['sales','payment-details'].includes(field)?toteatSalesSync.source(id,field):[];
    const sources=api.length?api:storedFieldFiles(id,field),rows=[],seen=new Set();let unreadable=0;
    if(central&&field==='purchases')return {rows:[],note:'Sin compras API que permitan identificar la bodega principal.'};
    for(const source of sources) {
      try {
        for(const sheet of readGenericTransactionSheets(source.filePath)) {
          const header=sheet.rows[0]||[];
          for(const values of sheet.rows.slice(1)) {
            const row=Object.fromEntries(header.map((h,i)=>[String(h||`Columna ${i+1}`),values[i]??null]));
            const date=field==='mercadopago'?mercadoPagoDateTime(row)?.slice(0,10):cellDate(rowValue(row,field==='sales'?['Fecha de cierre','Fecha de creacion']:field==='payment-details'?['FechaCierre','Fecha cierre','Fecha']:['Fecha emisión','Fecha']));
            if(!within(date)||dateIsExcluded(date,source.excludedRanges))continue;
            const key=JSON.stringify(row);if(seen.has(key))continue;seen.add(key);rows.push(row);
          }
        }
      }catch{unreadable++;}
    }
    return {rows,note:`${api.length?'Datos sincronizados desde Toteat API.':'Datos de los archivos cargados.'}${unreadable?' Hay archivos que no pudieron leerse.':''}`};
  }});
  app.get('/api/integrations/toteat/stock/status', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(stockSync.status(req.query.location || 'store-1')); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/integrations/toteat/stock/sync', (req, res) => {
    try { stockSync.synchronize(req.body.location, req.body).catch(() => {}); res.status(202).json({ started: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/integrations/toteat/stock/current', (req, res) => {
    try {
      const data = stockSync.view(req.query.location || 'store-1');
      if (!data) return res.status(404).json({ error: 'Actualiza primero las fuentes de inventario.' });
      const comparison = synchronizedOnly ? null : require('./scripts/toteat-inventory-pilot').compareFiles(uploadsRoot, data, data);
      res.set('Cache-Control', 'no-store').json({ ...data, comparison });
    } catch { res.status(400).json({ error: 'No se pudo consultar o comparar el inventario local.' }); }
  });
  app.get('/api/integrations/toteat/stock/export', (req, res) => {
    try {
      const data = stockSync.view(req.query.location || 'store-1');
      if (!data) return res.status(404).json({ error: 'Actualiza primero las fuentes de inventario.' });
      const comparison = synchronizedOnly ? null : require('./scripts/toteat-inventory-pilot').compareFiles(uploadsRoot, data, data);
      res.attachment('Kardex_Propio_Brewit.xlsx').send(stockSync.workbook(data, comparison));
    } catch { res.status(400).json({ error: 'No se pudo exportar el Kardex propio.' }); }
  });
  app.get('/api/integrations/toteat/masters/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ locations: [toteatMasterSync.sharedStatus()] });
  });
  app.get('/api/integrations/toteat/masters/current', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const data = toteatMasterSync.sharedCurrent(); return data ? res.json({ ...data, scope: 'shared', sourceLocation: 'store-1' }) : res.status(404).json({ error: 'Aún no se publicaron los maestros compartidos de La Concepción.' }); }
    catch { return res.status(400).json({ error: 'Selecciona una cafetería válida.' }); }
  });
  app.post('/api/integrations/toteat/masters/sync', (req, res) => {
    toteatMasterSync.synchronizeShared().catch(() => {});
    return res.status(202).json({ started: ['store-1'], shared: true });
  });
  const inventoryPilotRoot = path.join(uploadsRoot, 'reports', 'inventory', 'pilot-2026-08-23_2026-08-30');
  app.get('/api/integrations/toteat/inventory/pilot', (req, res) => {
    const result = readJson(path.join(inventoryPilotRoot, 'results.json'), null);
    res.set('Cache-Control', 'no-store');
    if (!result) return res.status(404).json({ error: 'El piloto aún no ha sido ejecutado.' });
    const r = result.reconciliation;
    return res.json({ capturedAt: result.capturedAt, range: r.range, rows: r.rowCount, nativeReconciliationPassed: r.nativeReconciliationPassed,
      comparedMovementCells: r.comparedCells, physicalClosures: r.closures.length,
      countDifferences: r.closures.filter(c => Math.abs(c.countDifference) > r.epsilon).length,
      fileDifferences: result.fileComparison.differences.length, missingFileCells: result.fileComparison.missing.length,
      recipeOrders: result.recipes.includedOrders, recipeSourceOrders: result.recipes.sourceOrders,
      exportUrl: '/api/integrations/toteat/inventory/pilot/export' });
  });
  app.get('/api/integrations/toteat/inventory/pilot/export', (req, res) => {
    const file = path.join(inventoryPilotRoot, 'Piloto_Kardex_Brewit.xlsx');
    return fs.existsSync(file) ? res.download(file, 'Piloto_Kardex_Brewit_23-30_Agosto_2026.xlsx') : res.sendStatus(404);
  });
  app.use('/uploads/weeks', express.static(weeksRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/transactions', express.static(transactionsRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/masters', express.static(mastersRoot, { fallthrough: false, dotfiles: 'deny' }));

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
  app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
  app.get('/operations-session.js', (req,res)=>res.sendFile(path.join(__dirname,'operations/session-fetch.js')));
  app.get('/sales-insight-filters.js', (req,res)=>res.sendFile(path.join(__dirname,'sales-insight-filters.js')));
  app.get('/toteat-api-view.js', (req, res) => res.sendFile(path.join(__dirname, 'toteat-api-view.js')));
  app.get('/toteat-purchases-view.js', (req, res) => res.sendFile(path.join(__dirname, 'toteat-purchases-view.js')));
  app.get('/toteat-masters-view.js', (req, res) => res.sendFile(path.join(__dirname, 'toteat-masters-view.js')));
  app.get('/upload-records-view.js', (req, res) => res.sendFile(path.join(__dirname, 'upload-records-view.js')));
  app.get('/toteat-stock-view.js', (req, res) => res.sendFile(path.join(__dirname, 'toteat-stock-view.js')));
  app.get('/demand-view.js', (req, res) => res.sendFile(path.join(__dirname, 'demand-view.js')));
  app.get('/vendor/xlsx.full.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')));
  app.get('/docs/brewit-final-01.jpg', (req, res) => res.sendFile(path.join(__dirname, 'docs', 'brewit-final-01.jpg')));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/source-policy', (req,res) => res.json({mode:synchronizedOnly?'synchronized':'legacy',
    message:synchronizedOnly?'Fuentes Toteat sincronizadas. Las descargas históricas no alimentan los cálculos.':'Fuentes históricas habilitadas.',
    manual:['MercadoPago','Marketing','Colaboradores','Órdenes de compra y gastos de Brewit'],
    masterNote:`Maestros compartidos desde La Concepción mediante ${require('./toteat-direct-masters').configured(uploadsRoot) ? 'API interna directa con autenticación autorizada' : 'servicios internos con sesión web'}. Para períodos anteriores a su primera lectura se usa el maestro observado disponible, sin certificar una versión histórica.`,
    locations:readLocations().locations.filter(l=>l.status==='active').map(l=>{const id=l.type==='warehouse'?'store-1':l.id;const stock=stockSync.current(l.id);return {id:l.id,name:l.name,sales:l.type==='store'?toteatSalesSync.status(id):null,purchases:toteatSalesSync.purchases.status(id),inventory:stock?{range:stock.range,updatedAt:stock.sourceCapturedAt}:null};})}));

  app.get('/api/locations', (req, res) => {
    const active = readLocations().locations.filter(location => location.status === 'active');
    res.json(Object.fromEntries(active.map(location => [location.id, publicLocation(location)])));
  });

  app.get('/api/config/locations', (req, res) => {
    const locations = readLocations().locations;
    res.json({
      active: locations.filter(location => location.status === 'active').map(publicLocation),
      trash: locations.filter(location => location.status === 'trashed').map(publicLocation)
    });
  });

  app.get('/api/config/company', (req, res) => {
    res.json(readCompanyProfile());
  });

  app.get('/api/financial-results/general-expenses', (req, res) => {
    const locationId = String(req.query.location || '');
    const month = String(req.query.month || '');
    const location = locationId === HEAD_OFFICE_UNIT.id ? HEAD_OFFICE_UNIT : activeLocation(locationId);
    if (!location || !['store', 'head-office'].includes(location.type)) return res.status(400).json({ error: 'Selecciona una cafetería o unidad válida.' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Selecciona un mes válido.' });
    const record = readGeneralExpenses().records.find(item => item.locationId === locationId && item.month === month) || null;
    return res.json({
      location: publicLocation(location), month,
      categories: GENERAL_EXPENSE_CATEGORIES.filter(([key])=>key!=='inventoryDifference'||location.type==='store').map(([key, label]) => ({ key, label })),
      values: Object.fromEntries(GENERAL_EXPENSE_CATEGORIES.map(([key]) => [key, key==='inventoryDifference' ? record?.values?.[key] ?? null : Number(record?.values?.[key]) || 0])),
      configured: Boolean(record), updatedAt: record?.updatedAt || null
    });
  });

  app.put('/api/financial-results/general-expenses', (req, res) => {
    const locationId = String(req.body?.location || '');
    const month = String(req.body?.month || '');
    const location = locationId === HEAD_OFFICE_UNIT.id ? HEAD_OFFICE_UNIT : activeLocation(locationId);
    if (!location || !['store', 'head-office'].includes(location.type)) return res.status(400).json({ error: 'Selecciona una cafetería o unidad válida.' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Selecciona un mes válido.' });
    const values = {};
    for (const [key] of GENERAL_EXPENSE_CATEGORIES) {
      if(key==='inventoryDifference') {
        const raw=req.body?.values?.[key];
        if(raw===null || raw==='' || raw===undefined){values[key]=null;continue;}
        const value=Number(raw);
        if(!Number.isFinite(value)||Math.abs(value)>1_000_000_000)return res.status(400).json({error:'La diferencia de inventario debe ser un monto válido, positivo o negativo.'});
        values[key]=Math.round(value);continue;
      }
      const value = Number(req.body?.values?.[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        return res.status(400).json({ error: 'Cada gasto debe ser un monto mensual válido y no negativo.' });
      }
      values[key] = Math.round(value);
    }
    const stored = readGeneralExpenses();
    const updatedAt = new Date().toISOString();
    const index = stored.records.findIndex(item => item.locationId === locationId && item.month === month);
    const record = { locationId, month, values, updatedAt };
    if (index >= 0) stored.records[index] = record;
    else stored.records.push(record);
    writeJsonAtomic(generalExpensesPath, stored);
    return res.json({ location: publicLocation(location), month, values, configured: true, updatedAt });
  });

  app.patch('/api/config/company', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const taxId = String(req.body?.taxId || '').trim();
    const currentProfile = readCompanyProfile();
    const exportDecimalSystem = req.body?.exportDecimalSystem === undefined
      ? currentProfile.exportDecimalSystem
      : String(req.body.exportDecimalSystem || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'La razón social debe tener entre 2 y 100 caracteres.' });
    if (taxId.length > 30) return res.status(400).json({ error: 'El RUT no puede superar 30 caracteres.' });
    if (!['comma', 'dot'].includes(exportDecimalSystem)) {
      return res.status(400).json({ error: 'Selecciona un sistema decimal válido para las exportaciones.' });
    }
    const profile = { ...currentProfile, name, taxId, exportDecimalSystem, updatedAt: new Date().toISOString() };
    writeJsonAtomic(companyProfilePath, profile);
    return res.json(profile);
  });

  app.post('/api/config/locations', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    const type = req.body?.type;
    const toteatRestaurantId = String(req.body?.toteatRestaurantId || '').trim();
    const toteatLocalId = String(req.body?.toteatLocalId || '').trim();
    const toteatName = String(req.body?.toteatName || '').trim();
    const toteatSimpleId = String(req.body?.toteatSimpleId || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Location name must be between 2 and 80 characters.' });
    if (address.length > 200) return res.status(400).json({ error: 'La dirección no puede superar 200 caracteres.' });
    if (!['store', 'warehouse'].includes(type)) return res.status(400).json({ error: 'Select a valid location type.' });
    const registry = readLocations();
    if (registry.locations.some(location => location.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'A location with this name already exists, including locations in trash.' });
    }
    const location = {
      id: `location-${crypto.randomUUID()}`, name, address, type, status: 'active', createdAt: new Date().toISOString(),
      toteatRestaurantId, toteatLocalId, toteatName, toteatSimpleId
    };
    registry.locations.push(location);
    writeJsonAtomic(locationsPath, registry);
    return res.status(201).json(publicLocation(location));
  });

  app.patch('/api/config/locations/:id', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Location name must be between 2 and 80 characters.' });
    if (address.length > 200) return res.status(400).json({ error: 'La dirección no puede superar 200 caracteres.' });
    const registry = readLocations();
    const location = registry.locations.find(item => item.id === req.params.id && item.status === 'active');
    if (!location) return res.status(404).json({ error: 'Active location not found.' });
    if (registry.locations.some(item => item.id !== location.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'A location with this name already exists, including locations in trash.' });
    }
    if (req.body?.openingDate !== undefined && req.body.openingDate && !isValidDate(req.body.openingDate)) {
      return res.status(400).json({ error: 'Indica una fecha de apertura válida.' });
    }
    if (req.body?.operatingWeekdays !== undefined && (!Array.isArray(req.body.operatingWeekdays)
      || req.body.operatingWeekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
      return res.status(400).json({ error: 'Selecciona días de operación válidos.' });
    }
    if (req.body?.operatingHours !== undefined && (!req.body.operatingHours || typeof req.body.operatingHours !== 'object'
      || Array.isArray(req.body.operatingHours) || Object.entries(req.body.operatingHours).some(([day, hours]) =>
        !/^[0-6]$/.test(day) || !hours || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.open)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hours.close) || hours.open >= hours.close))) {
      return res.status(400).json({ error: 'Indica horarios de apertura y cierre válidos para cada día.' });
    }
    if (req.body?.closedDates !== undefined && (!Array.isArray(req.body.closedDates)
      || req.body.closedDates.some(date => !isValidDate(date)))) {
      return res.status(400).json({ error: 'Indica fechas de cierre válidas.' });
    }
    location.name = name;
    location.address = address;
    if (req.body?.openingDate !== undefined) location.openingDate = String(req.body.openingDate || '');
    if (req.body?.operatingWeekdays !== undefined) location.operatingWeekdays = [...new Set(req.body.operatingWeekdays)];
    if (req.body?.operatingHours !== undefined) location.operatingHours = req.body.operatingHours;
    if (req.body?.closedDates !== undefined) location.closedDates = [...new Set(req.body.closedDates)].sort();
    for (const field of ['toteatRestaurantId', 'toteatLocalId', 'toteatName', 'toteatSimpleId']) {
      if (req.body?.[field] !== undefined) location[field] = String(req.body[field] || '').trim();
    }
    location.updatedAt = new Date().toISOString();
    writeJsonAtomic(locationsPath, registry);
    for (const week of fs.readdirSync(weeksRoot)) {
      const metadataPath = path.join(weeksRoot, week, location.id, 'meta.json');
      if (!fs.existsSync(metadataPath)) continue;
      const metadata = readJson(metadataPath, null);
      if (metadata) {
        metadata.locationLabel = name;
        writeJsonAtomic(metadataPath, metadata);
      }
    }
    return res.json(publicLocation(location));
  });

  app.post('/api/config/locations/:id/trash', (req, res) => {
    const registry = readLocations();
    const location = registry.locations.find(item => item.id === req.params.id && item.status === 'active');
    if (!location) return res.status(404).json({ error: 'Active location not found.' });
    if (req.body?.confirmationStage !== 2 || req.body?.confirmationText !== location.name) {
      return res.status(400).json({ error: 'Two-step confirmation and the exact location name are required.' });
    }

    const trashRoot = path.join(trashLocationsRoot, location.id);
    const moved = [];
    try {
      ensureDir(trashRoot);
      for (const week of fs.readdirSync(weeksRoot)) {
        const source = path.join(weeksRoot, week, location.id);
        if (!fs.existsSync(source)) continue;
        const destination = path.join(trashRoot, week);
        if (fs.existsSync(destination)) throw new Error('Trash destination already exists');
        fs.renameSync(source, destination);
        moved.push({ source, destination });
      }
      const transactionSource = transactionLocationRoot(location.id);
      if (fs.existsSync(transactionSource)) {
        const transactionDestination = path.join(trashRoot, 'transactions');
        if (fs.existsSync(transactionDestination)) throw new Error('Transaction trash destination already exists');
        fs.renameSync(transactionSource, transactionDestination);
        moved.push({ source: transactionSource, destination: transactionDestination });
      }
      location.status = 'trashed';
      location.trashedAt = new Date().toISOString();
      writeJsonAtomic(locationsPath, registry);
      return res.json({ ok: true, location: publicLocation(location), movedWeekCount: moved.length });
    } catch (error) {
      moved.reverse().forEach(item => {
        if (fs.existsSync(item.destination)) fs.renameSync(item.destination, item.source);
      });
      return res.status(500).json({ error: 'Could not move the location to trash.' });
    }
  });

  app.post('/api/config/locations/:id/restore', (req, res) => {
    const registry = readLocations();
    const location = registry.locations.find(item => item.id === req.params.id && item.status === 'trashed');
    if (!location) return res.status(404).json({ error: 'Trashed location not found.' });
    if (registry.locations.some(item => item.id !== location.id && item.status === 'active' && item.name.toLocaleLowerCase() === location.name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'Rename the active location with the same name before restoring this one.' });
    }

    const trashRoot = path.join(trashLocationsRoot, location.id);
    const moved = [];
    try {
      if (fs.existsSync(trashRoot)) {
        for (const week of fs.readdirSync(trashRoot)) {
          const source = path.join(trashRoot, week);
          const destination = week === 'transactions'
            ? transactionLocationRoot(location.id)
            : path.join(weeksRoot, week, location.id);
          if (fs.existsSync(destination)) throw new Error('Active destination already exists');
          ensureDir(path.dirname(destination));
          fs.renameSync(source, destination);
          moved.push({ source, destination });
        }
      }
      location.status = 'active';
      location.restoredAt = new Date().toISOString();
      delete location.trashedAt;
      writeJsonAtomic(locationsPath, registry);
      return res.json({ ok: true, location: publicLocation(location), restoredWeekCount: moved.length });
    } catch (error) {
      moved.reverse().forEach(item => {
        if (fs.existsSync(item.destination)) fs.renameSync(item.destination, item.source);
      });
      return res.status(500).json({ error: 'Could not restore the location.' });
    }
  });

  app.get('/api/sales/latest', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location || location.type !== 'store') return res.status(400).json({ error: 'Select a valid cafeteria.' });
    try {
      const history = salesHistory(location.id);
      return res.json({
        location: location.id,
        latestTransactionAt: history.latestTransactionAt,
        transactionCount: history.transactionCount,
        filesRead: history.filesRead
      });
    } catch (error) {
      return res.status(500).json({ error: 'Could not read the latest sales transaction.' });
    }
  });

  function kardexPurchaseRows(location) {
    const parsed = mergedKardexData(location.id, 'kardex');
    const rows = [];
    for (const group of parsed.groups) {
      for (const product of parsed.products) {
        const quantity = kardexMetricValue(product, group, metric => metric.startsWith('buy -'));
        if (Math.abs(quantity) <= 0.0000001) continue;
        const unitCost = kardexMetricValue(product, group, metric => metric === 'costo');
        rows.push({
          date: group.date,
          locationId: location.id,
          locationName: location.name,
          supplierKey: 'kardex-buy',
          supplier: 'Ingresos BUY según Kardex',
          supplierTaxId: '',
          documentType: 'Kardex BUY',
          document: 'Kardex',
          line: product.code,
          code: product.code,
          product: product.name,
          quantity,
          unit: product.unit,
          listedUnitPrice: unitCost,
          negotiatedUnitPrice: 0,
          effectiveUnitPrice: unitCost,
          netAmount: quantity * unitCost,
          discount: 0,
          totalAmount: quantity * unitCost,
          sourceType: 'kardex-buy'
        });
      }
    }
    return rows;
  }

  function buildPurchasesPayload(query = {}) {
    const activeLocations = readLocations().locations.filter(location => location.status === 'active');
    const activeStores = activeLocations.filter(location => location.type === 'store');
    const requestedLocation = query.location || 'all';
    const selectedLocations = requestedLocation === 'all'
      ? (synchronizedOnly ? activeLocations : activeStores)
      : activeLocations.filter(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedLocations.length) {
      const error = new Error('Selecciona una ubicación válida.');
      error.status = 400;
      throw error;
    }
    const supplierMaster = latestMasterFile('master-suppliers', '2100-01-01');
    const supplierNames = supplierNamesByTaxId(supplierMaster?.filePath);
    const unique = new Map();
    let sourceFileCount = 0;
    for (const location of selectedLocations) {
      const auditApi = (query.auditSources || synchronizedOnly) && toteatSalesSync.purchases.get(location.type === 'warehouse' ? 'store-1' : location.id);
      const auditDocuments = query.auditSources ? new Map((auditApi?.documents || []).map(document => [String(document.movement_id), document])) : null;
      if (location.type === 'warehouse' && !auditApi) {
        if(synchronizedOnly) continue;
        if (latestWeeklyFile(location.id, 'kardex')) {
          sourceFileCount += 1;
          for (const purchase of kardexPurchaseRows(location)) {
            const key = [location.id, purchase.date, purchase.code, purchase.quantity].join('|');
            if (!unique.has(key)) unique.set(key, purchase);
          }
        }
        continue;
      }
      for (const stored of (auditApi ? toteatSalesSync.purchases.source(location.type === 'warehouse' ? 'store-1' : location.id, 'purchases') : storedWeeklyFiles(location.id, 'purchases'))) {
        sourceFileCount += 1;
        for (const row of readPurchaseRows(stored.filePath)) {
          if (auditApi && !(location.type === 'warehouse' ? [1,4] : [2,3]).includes(Number(row['API Bodega Toteat']))) continue;
          const purchase = purchaseRecord(row, location, supplierNames);
          if (!purchase) continue;
          if (query.auditSources) purchase.evidence = { 'Ubicación': location.name, 'Archivo fuente': path.basename(stored.filePath), ...auditSourceFields(row),
            'Documento original API': auditDocuments.get(String(row['API Movimiento'])) || null };
          if (dateIsExcluded(purchase.date, stored.excludedRanges)) continue;
          const identity = purchase.document || crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
          const key = [location.id, purchase.date, purchase.supplierKey, identity, purchase.line, purchase.code].join('|');
          if (!unique.has(key)) unique.set(key, purchase);
        }
      }
    }
    const allRows = [...unique.values()];
    const catalogMasterByDate = new Map();
    const conversionsByFile = new Map();
    allRows.forEach(row => {
      if (!catalogMasterByDate.has(row.date)) catalogMasterByDate.set(row.date, latestMasterFile('master-catalog', row.date));
      const master = catalogMasterByDate.get(row.date);
      if (!master) {
        row.purchaseUnit = row.unit;
        row.baseUnit = null;
        row.unitsPerPurchaseUnit = null;
        row.baseUnitCost = null;
        return;
      }
      if (!conversionsByFile.has(master.filePath)) {
        conversionsByFile.set(master.filePath, parsePurchaseUnitConversions(master.filePath));
      }
      const catalogItem = conversionsByFile.get(master.filePath).get(row.code)
        || conversionsByFile.get(master.filePath).get(String(row.code).toUpperCase());
      const conversion = catalogItem?.conversions.get(normalizedUnit(row.unit));
      const sameAsBase = catalogItem && normalizedUnit(row.unit) === normalizedUnit(catalogItem.baseUnit);
      row.purchaseUnit = row.unit;
      row.baseUnit = conversion?.baseUnit || catalogItem?.baseUnit || null;
      row.unitsPerPurchaseUnit = conversion?.unitsPerPurchaseUnit ?? (sameAsBase ? 1 : catalogItem ? convertQuantityUnit(1,row.unit,catalogItem.baseUnit) : null);
      row.baseUnitCost = row.unitsPerPurchaseUnit
        ? row.effectiveUnitPrice / row.unitsPerPurchaseUnit
        : null;
    });
    const dates = allRows.map(row => row.date).sort();
    const availablePeriod = dates.length ? { from: dates[0], to: dates.at(-1) } : null;
    const dateFrom = query.dateFrom || availablePeriod?.from || null;
    const dateTo = query.dateTo || availablePeriod?.to || null;
    if ((dateFrom && !isValidDate(dateFrom)) || (dateTo && !isValidDate(dateTo)) || (dateFrom && dateTo && dateFrom > dateTo)) {
      const error = new Error('Selecciona un período válido para las compras.');
      error.status = 400;
      throw error;
    }
    const suppliers = [...new Map(allRows.map(row => [row.supplierKey, {
      key: row.supplierKey,
      name: row.supplier,
      taxId: row.supplierTaxId
    }])).values()].sort((left, right) => left.name.localeCompare(right.name, 'es'));
    const requestedSupplier = query.supplier || 'all';
    if (requestedSupplier !== 'all' && !suppliers.some(supplier => supplier.key === requestedSupplier)) {
      const error = new Error('Selecciona un proveedor válido.');
      error.status = 400;
      throw error;
    }
    const requestedProduct = String(query.product || '').trim();
    const productOptions = [...new Map(allRows.map(row => [row.code || normalizeHeader(row.product), {
      key: row.code || normalizeHeader(row.product),
      code: row.code,
      name: row.product
    }])).values()].sort((left, right) => left.name.localeCompare(right.name, 'es'));

    allRows.sort((left, right) => left.date.localeCompare(right.date)
      || left.document.localeCompare(right.document, 'es', { numeric: true })
      || left.line.localeCompare(right.line, 'es', { numeric: true }));
    require('./purchase-price-history').applyPurchasePriceHistory(allRows, normalizedUnit);

    const rows = allRows.filter(row => (!dateFrom || row.date >= dateFrom)
      && (!dateTo || row.date <= dateTo)
      && (requestedSupplier === 'all' || row.supplierKey === requestedSupplier)
      && (!requestedProduct || normalizeHeader(`${row.code} ${row.product}`).includes(normalizeHeader(requestedProduct))));
    rows.sort((left, right) => left.supplier.localeCompare(right.supplier, 'es')
      || right.date.localeCompare(left.date)
      || left.product.localeCompare(right.product, 'es')
      || left.document.localeCompare(right.document, 'es', { numeric: true }));
    return {
      scope: requestedLocation === 'all'
        ? { location: 'all', label: 'Todas las cafeterías', type: 'stores' }
        : { location: requestedLocation, label: selectedLocations[0].name, type: selectedLocations[0].type },
      locations: activeLocations.map(publicLocation),
      suppliers,
      products: productOptions,
      filters: { location: requestedLocation, supplier: requestedSupplier, product: requestedProduct, dateFrom, dateTo },
      availablePeriod,
      sourceFileCount,
      summary: {
        lineCount: rows.length,
        supplierCount: new Set(rows.map(row => row.supplierKey)).size,
        productCount: new Set(rows.map(row => row.code || normalizeHeader(row.product))).size,
        totalAmount: rows.reduce((sum, row) => sum + row.totalAmount, 0),
        changedPriceCount: rows.filter(row => row.priceChangePercent !== null && Math.abs(row.priceChangePercent) >= 0.01).length
      },
      rows
    };
  }

  function buildDirectCostResolver(dateTo, locationIds = [], options = {}) {
    const cutoffDate = isValidDate(dateTo) ? dateTo : projectionToday();
    const activeLocations = readLocations().locations.filter(location => location.status === 'active');
    const activeStores = activeLocations.filter(location => location.type === 'store');
    const requestedIds = [...new Set((locationIds || []).filter(id => activeLocations.some(location => location.id === id)))];
    const requestedSet = new Set(requestedIds.length ? requestedIds : activeStores.map(location => location.id));
    const locationsToRead = new Set([...requestedSet, ...(synchronizedOnly ? activeLocations : activeStores).map(location => location.id)]);
    const localByCode = new Map();
    const globalByCode = new Map();
    const rowIdentity = row => [row.locationId, row.date, row.document, row.line, row.code, row.purchaseUnit || row.unit].join('|');
    const compareLatest = (left, right) => right.date.localeCompare(left.date)
      || String(right.document || '').localeCompare(String(left.document || ''), 'es', { numeric: true })
      || String(right.line || '').localeCompare(String(left.line || ''), 'es', { numeric: true })
      || String(right.locationId || '').localeCompare(String(left.locationId || ''), 'es');
    const addCandidate = (map, code, row) => {
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(row);
    };

    for (const locationId of locationsToRead) {
      let rows = options.purchaseRowsByLocation?.get(locationId) || [];
      if (!options.purchaseRowsByLocation) {
        try {
          rows = buildPurchasesPayload({
            location: locationId,
            supplier: 'all',
            product: '',
            dateFrom: '1900-01-01',
            dateTo: cutoffDate
          }).rows;
        } catch {}
      }
      for (const row of rows) {
        const code = String(row.code || '').trim().toUpperCase();
        if (!code || row.date > cutoffDate) continue;
        if (!(row.quantity > 0) || /credito|credit note|credit_note/.test(normalizeHeader(row.documentType))) continue;
        if (requestedSet.has(locationId)) addCandidate(localByCode, code, row);
        if ((synchronizedOnly ? activeLocations : activeStores).some(location => location.id === locationId)) addCandidate(globalByCode, code, row);
      }
    }
    for (const map of [localByCode, globalByCode]) {
      for (const rows of map.values()) rows.sort(compareLatest);
    }

    const purchaseCostInUnit = (row, targetUnit) => {
      const hasBaseCost = Number(row.baseUnitCost) > 0;
      const rawCost = hasBaseCost
        ? Number(row.baseUnitCost)
        : Number(row.effectiveUnitPrice) > 0
          ? Number(row.effectiveUnitPrice)
          : Number(row.listedUnitPrice);
      const sourceUnit = hasBaseCost ? row.baseUnit : (row.purchaseUnit || row.unit);
      if (!(rawCost > 0)) return null;
      return unitCostForRecipeUnit({ unitCost: rawCost, unit: sourceUnit }, targetUnit);
    };

    return {
      dateTo: cutoffDate,
      locationIds: [...requestedSet],
      resolve(code, targetUnit, catalogItem = null) {
        const key = String(code || '').trim().toUpperCase();
        const seen = new Set();
        const candidates = [...(localByCode.get(key) || []), ...(globalByCode.get(key) || [])]
          .filter(row => {
            const identity = rowIdentity(row);
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
          });
        candidates.sort(compareLatest);
        for (const [index, purchase] of candidates.entries()) {
          const unitCost = purchaseCostInUnit(purchase, targetUnit);
          if (unitCost === null) continue;
          const previous = candidates.slice(index + 1).find(row => purchaseCostInUnit(row, targetUnit) !== null);
          return {
            previousPurchaseCost: previous ? purchaseCostInUnit(previous, targetUnit) : null,
            previousPurchaseDate: previous?.date || null,
            unitCost,
            source: 'purchase',
            sourceDate: purchase.date,
            sourceLocationId: purchase.locationId,
            sourceLocationName: purchase.locationName,
            supplier: purchase.supplier,
            purchaseUnit: purchase.purchaseUnit || purchase.unit,
            costBasisEvidence: purchase.costBasisEvidence || 'unverified',
            fallback: false
          };
        }
        const masterCost = options.purchaseOnly ? null : unitCostForRecipeUnit(catalogItem, targetUnit);
        if (masterCost !== null) {
          return {
            unitCost: masterCost,
            source: 'master',
            costBasisEvidence: 'unverified',
            sourceDate: options.masterEffectiveDate || null,
            sourceLocationId: null,
            sourceLocationName: null,
            supplier: null,
            purchaseUnit: null,
            fallback: true
          };
        }
        return {
          unitCost: 0,
          source: 'missing',
          costBasisEvidence: 'unverified',
          sourceDate: null,
          sourceLocationId: null,
          sourceLocationName: null,
          supplier: null,
          purchaseUnit: null,
          fallback: true
        };
      }
    };
  }

  function buildInventoryPurchaseCostResolver(dateTo, location, state, {catalog=null,recipes=null,waste=false}={}) {
    // La Concepción's purchase feed includes Central; search all stores by date,
    // not by warehouse, since receiving transfers does not establish a purchase price.
    const purchases=buildDirectCostResolver(dateTo, [location.type==='warehouse'?'store-1':location.id], {purchaseOnly:true,latestAcrossLocations:true});
    const api=require('./toteat-public-inventory').publicInventoryCostResolver(state,location.type==='warehouse'?(waste?4:1):(waste?3:2),dateTo,convertQuantityUnit,{positiveOnly:true});
    const directResolver={dateTo,resolve(code,unit,item) {
      const purchase=purchases.resolve(code,unit,item);
      if(purchase.source==='purchase')return purchase;
      const masterCost=unitCostForRecipeUnit(item,unit);
      if(masterCost>0)return {unitCost:masterCost,source:'master',sourceDate:state.masterObservedAt?.slice(0,10)||null,fallback:true};
      const reference=api.resolve(code,unit);
      return reference.unitCost>0?reference:{unitCost:0,source:'missing',sourceDate:null};
    }};
    return buildCostResolver(dateTo,[],{catalog,recipes,directResolver,preferDirectMaster:true});
  }

  function buildCostResolver(dateTo, locationIds = [], options = {}) {
    const directResolver = options.directResolver || buildDirectCostResolver(dateTo, locationIds, options);
    const cutoffDate = directResolver.dateTo;
    let catalog = options.catalog || null;
    let recipes = options.recipes || null;

    if (!catalog) {
      try {
        const catalogMaster = latestMasterFile('master-catalog', cutoffDate);
        catalog = catalogMaster ? parseIngredientCatalog(catalogMaster.filePath) : new Map();
      } catch {
        catalog = new Map();
      }
    }
    if (!recipes) {
      try {
        recipes = resolveRecipes(cutoffDate).recipes;
      } catch {
        recipes = new Map();
      }
    }

    const catalogByCode = new Map([...catalog].map(([code, item]) => [String(code).trim().toUpperCase(), item]));
    const recipesByCode = new Map([...recipes].map(([code, lines]) => [String(code).trim().toUpperCase(), lines]));
    const cache = new Map();

    const resolve = (code, targetUnit, suppliedCatalogItem = null, ancestors = new Set()) => {
      const key = String(code || '').trim().toUpperCase();
      const catalogItem = suppliedCatalogItem || catalogByCode.get(key) || null;
      const requestedUnit = targetUnit || catalogItem?.unit || '';
      const cacheKey = `${key}|${normalizedUnit(requestedUnit)}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey);

      const direct = directResolver.resolve(key, requestedUnit, catalogItem);
      if (direct.source === 'purchase' || direct.source === 'toteat-api' || ((options.preferDirectMaster || synchronizedOnly || catalogByCode.get(key)?.type === 'ingredient') && direct.source === 'master')) {
        cache.set(cacheKey, direct);
        return direct;
      }
      const recipe = recipesByCode.get(key);
      if (!recipe?.length) {
        cache.set(cacheKey, direct);
        return direct;
      }
      if (ancestors.has(key)) {
        return {
          unitCost: 0,
          source: 'missing',
          sourceDate: null,
          fallback: false,
          reason: 'recipe-cycle'
        };
      }

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(key);
      const components = [];
      let recipeCost = 0;
      for (const line of recipe) {
        const ingredientKey = String(line.ingredientId || '').trim().toUpperCase();
        const ingredient = catalogByCode.get(ingredientKey) || null;
        const component = resolve(ingredientKey, line.unit, ingredient, nextAncestors);
        const quantity = Number(line.quantity);
        const yieldFactor = Number(line.yieldRate) > 0 ? Number(line.yieldRate) / 100 : 1;
        if (!ingredientKey || !Number.isFinite(quantity) || component.source === 'missing'
          || !Number.isFinite(component.unitCost)) {
          const missing = {
            unitCost: 0,
            source: 'missing',
            sourceDate: null,
            fallback: false,
            reason: component.reason || 'recipe-component-missing',
            missingComponent: ingredientKey || line.ingredientId || null
          };
          cache.set(cacheKey, missing);
          return missing;
        }
        const effectiveQuantity = quantity / yieldFactor;
        const lineCost = effectiveQuantity * component.unitCost;
        recipeCost += lineCost;
        components.push({
          code: ingredientKey,
          quantity,
          effectiveQuantity,
          unit: line.unit,
          unitCost: component.unitCost,
          totalCost: lineCost,
          costSource: component.source,
          costBasisEvidence: component.costBasisEvidence || 'unverified',
          costSourceDate: component.sourceDate
        });
      }

      const baseUnit = catalogItem?.unit || requestedUnit;
      const convertedCost = unitCostForRecipeUnit({ unitCost: recipeCost, unit: baseUnit }, requestedUnit);
      if (!(convertedCost > 0)) {
        const missing = {
          unitCost: 0,
          source: 'missing',
          sourceDate: null,
          fallback: false,
          reason: convertedCost === null ? 'recipe-unit-conversion' : 'recipe-zero-cost'
        };
        cache.set(cacheKey, missing);
        return missing;
      }
      const sourceDates = [options.recipeEffectiveDate, ...components.map(component => component.costSourceDate)].filter(Boolean).sort();
      const calculated = {
        unitCost: convertedCost,
        source: 'recipe',
        costBasisEvidence: components.every(component => component.costBasisEvidence === 'net-field-consistent')
          ? 'net-field-consistent' : 'unverified',
        sourceDate: sourceDates.at(-1) || null,
        fallback: false,
        recipeCode: key,
        components
      };
      cache.set(cacheKey, calculated);
      return calculated;
    };

    return {
      dateTo: cutoffDate,
      locationIds: directResolver.locationIds,
      resolve,
      resolveDirect: directResolver.resolve
    };
  }

  // A historical margin must use only purchases and masters already effective
  // on the sale date. Reuse a resolver until one of those sources changes.
  function buildHistoricalCostResolver(dateTo, locationIds = []) {
    const cutoffDate = isValidDate(dateTo) ? dateTo : projectionToday();
    const activeLocations = readLocations().locations.filter(location => location.status === 'active');
    const activeStores = activeLocations.filter(location => location.type === 'store');
    const requestedIds = [...new Set(locationIds.filter(id => activeLocations.some(location => location.id === id)))];
    const locationsToRead = [...new Set([...requestedIds, ...(synchronizedOnly ? activeLocations : activeStores).map(location => location.id)])];
    const purchaseRowsByLocation = new Map();
    const changeDates = new Set();
    for (const locationId of locationsToRead) {
      let rows = [];
      try {
        rows = buildPurchasesPayload({
          location: locationId, supplier: 'all', product: '', dateFrom: '1900-01-01', dateTo: cutoffDate
        }).rows;
      } catch {}
      purchaseRowsByLocation.set(locationId, rows);
      for (const row of rows) if (isValidDate(row.date)) changeDates.add(row.date);
    }
    const catalogMasters = masterFiles('master-catalog');
    const recipeMasters = masterFiles('master-recipes');
    for (const master of [...catalogMasters, ...recipeMasters]) changeDates.add(master.validFrom);
    const epochs = [...changeDates].filter(date => date <= cutoffDate).sort();
    const catalogs = new Map();
    const recipes = new Map();
    const resolvers = new Map();
    const epochFor = date => {
      let left = 0;
      let right = epochs.length;
      while (left < right) {
        const middle = (left + right) >> 1;
        if (epochs[middle] <= date) left = middle + 1;
        else right = middle;
      }
      return epochs[left - 1] || '1900-01-01';
    };
    const resolverFor = date => {
      const epoch = epochFor(date);
      if (resolvers.has(epoch)) return resolvers.get(epoch);
      const catalogMaster = catalogMasters.find(master => master.validFrom <= epoch) || null;
      const catalogKey = catalogMaster?.filePath || '';
      if (!catalogs.has(catalogKey)) {
        let catalog = new Map();
        try { if (catalogMaster) catalog = parseIngredientCatalog(catalogMaster.filePath); } catch {}
        catalogs.set(catalogKey, catalog);
      }
      const applicableRecipes = effectiveRecipeVersions(recipeMasters, epoch, synchronizedOnly);
      const recipeKey = applicableRecipes.map(master => master.filePath).join('|');
      if (!recipes.has(recipeKey)) {
        const resolved = new Map();
        for (const master of applicableRecipes) {
          try {
            for (const [code, lines] of parseRecipes(master.filePath)) {
              if (!resolved.has(code)) resolved.set(code, lines);
            }
          } catch {}
        }
        recipes.set(recipeKey, resolved);
      }
      const resolver = buildCostResolver(epoch, requestedIds, {
        purchaseRowsByLocation,
        catalog: catalogs.get(catalogKey),
        recipes: recipes.get(recipeKey),
        masterEffectiveDate: catalogMaster?.validFrom || null,
        recipeEffectiveDate: applicableRecipes[0]?.validFrom || null
      });
      const result = { resolver, catalog: catalogs.get(catalogKey), catalogMaster };
      resolvers.set(epoch, result);
      return result;
    };
    return {
      resolve(date, code, targetUnit = null) {
        const { resolver, catalog, catalogMaster } = resolverFor(date);
        const item = catalog.get(String(code || '').trim().toUpperCase()) || null;
        const reference = resolver.resolve(code, targetUnit || item?.unit, item);
        if (reference.source !== 'missing' || reference.reason) return reference;
        return {
          ...reference,
          reason: !catalogMaster ? 'no-effective-catalog'
            : !item ? 'not-in-effective-catalog' : 'no-positive-convertible-cost'
        };
      },
      valuationDate: 'sale-date'
    };
  }

  function buildPurchaseCostVariationsPayload(query = {}) {
    const dateTo = projectionToday();
    const dateFrom = addDays(dateTo, -29);
    const purchases = buildPurchasesPayload({
      location: query.location || 'all',
      supplier: 'all',
      product: '',
      dateFrom,
      dateTo
    });
    const rowsByItem = new Map();
    for (const row of purchases.rows) {
      if (!(row.quantity > 0) || !(row.comparisonUnitCost > 0) || /credito|credit_note|credit note/.test(normalizeHeader(row.documentType))) continue;
      const key = [
        row.supplierKey,
        row.locationId,
        row.code || normalizeHeader(row.product),
        normalizedUnit(row.comparisonUnit)
      ].join('|');
      if (!rowsByItem.has(key)) rowsByItem.set(key, []);
      rowsByItem.get(key).push(row);
    }
    const groupsBySupplier = new Map();
    for (const itemRows of rowsByItem.values()) {
      itemRows.sort((left, right) => left.date.localeCompare(right.date)
        || left.document.localeCompare(right.document, 'es', { numeric: true })
        || left.line.localeCompare(right.line, 'es', { numeric: true }));
      const changes = itemRows.filter(row => row.unitCostChangePercent !== null
        && Math.abs(row.unitCostChangePercent) >= 0.01);
      if (!changes.length) continue;
      const first = itemRows[0];
      const latest = itemRows.at(-1);
      const costs = itemRows.map(row => row.comparisonUnitCost);
      const firstComparableCost = changes[0].previousComparisonUnitCost ?? first.comparisonUnitCost;
      const netChangePercent = firstComparableCost
        ? ((latest.comparisonUnitCost / firstComparableCost) - 1) * 100
        : null;
      const item = {
        key: [first.locationId, first.code || normalizeHeader(first.product), first.purchaseUnit || first.unit].join('|'),
        code: first.code,
        product: first.product,
        locationId: first.locationId,
        locationName: first.locationName,
        purchaseUnit: latest.purchaseUnit || latest.unit,
        comparisonUnit: first.comparisonUnit,
        firstCost: firstComparableCost,
        latestCost: latest.comparisonUnitCost,
        minCost: Math.min(firstComparableCost, ...costs),
        maxCost: Math.max(firstComparableCost, ...costs),
        netChangePercent,
        fluctuationCount: changes.length,
        increaseCount: changes.filter(row => row.unitCostChangePercent > 0).length,
        decreaseCount: changes.filter(row => row.unitCostChangePercent < 0).length,
        maxIncreasePercent: Math.max(0, ...changes.map(row => row.unitCostChangePercent)),
        maxDecreasePercent: Math.min(0, ...changes.map(row => row.unitCostChangePercent)),
        lastChangeDate: changes.at(-1).date
      };
      if (!groupsBySupplier.has(first.supplierKey)) {
        groupsBySupplier.set(first.supplierKey, {
          supplierKey: first.supplierKey,
          supplier: first.supplier,
          supplierTaxId: first.supplierTaxId,
          items: []
        });
      }
      groupsBySupplier.get(first.supplierKey).items.push(item);
    }
    const groups = [...groupsBySupplier.values()]
      .sort((left, right) => left.supplier.localeCompare(right.supplier, 'es'))
      .map(group => ({
        ...group,
        items: group.items.sort((left, right) => left.product.localeCompare(right.product, 'es')
          || left.locationName.localeCompare(right.locationName, 'es'))
      }));
    const items = groups.flatMap(group => group.items);
    return {
      scope: purchases.scope,
      period: { from: dateFrom, to: dateTo },
      summary: {
        supplierCount: groups.length,
        itemCount: items.length,
        fluctuationCount: items.reduce((sum, item) => sum + item.fluctuationCount, 0),
        increaseCount: items.reduce((sum, item) => sum + item.increaseCount, 0),
        decreaseCount: items.reduce((sum, item) => sum + item.decreaseCount, 0)
      },
      groups
    };
  }

  app.get('/api/purchases', (req, res) => {
    try {
      return res.json(buildPurchasesPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudieron procesar las compras.' });
    }
  });

  app.get('/api/cost-review', (req, res) => {
    try {
      const dateTo = String(req.query.dateTo || projectionToday());
      if (!isValidDate(dateTo) || dateTo > projectionToday()) {
        return res.status(400).json({ error: 'Selecciona una fecha de corte válida, no futura.' });
      }
      const requestedLocation = String(req.query.location || 'all');
      const stores = readLocations().locations.filter(item => item.status === 'active' && item.type === 'store');
      const selected = requestedLocation === 'all' ? stores : stores.filter(item => item.id === requestedLocation);
      if (!selected.length) return res.status(400).json({ error: 'Selecciona una cafetería activa válida.' });
      const master = latestMasterFile('master-catalog', dateTo);
      if (!master) return res.status(404).json({ error: 'No hay un maestro de productos, ingredientes y extras vigente.' });
      const catalog = parseIngredientCatalog(master.filePath);
      const resolver = buildCostResolver(dateTo, selected.map(item => item.id), { catalog, masterEffectiveDate: master.validFrom });
      const selectedIds = new Set(selected.map(item => item.id));
      const items = [...catalog.values()].filter(item => item.active).map(item => {
        const direct = resolver.resolveDirect(item.code, item.unit, item);
        const effective = resolver.resolve(item.code, item.unit, item);
        const hasPurchase = direct.source === 'purchase';
        const otherLocation = hasPurchase && requestedLocation !== 'all' && !selectedIds.has(direct.sourceLocationId);
        const status = !hasPurchase && effective.source === 'missing' ? 'missing'
          : !hasPurchase ? 'no-purchase' : otherLocation ? 'other-location' : 'covered';
        return {
          code: item.code, name: item.name, type: item.type, unit: item.unit,
          status, effectiveCost: effective.source === 'missing' ? null : effective.unitCost,
          effectiveSource: effective.source, reason: effective.reason || null,
          missingComponent: effective.missingComponent || null,
          purchaseCost: hasPurchase ? direct.unitCost : null,
          purchaseDate: hasPurchase ? direct.sourceDate : null,
          purchaseLocation: hasPurchase ? direct.sourceLocationName : null,
          catalogCost: item.unitCost > 0 ? item.unitCost : null,
          costBasisEvidence: effective.costBasisEvidence || 'unverified'
        };
      });
      const priority = { missing: 0, 'no-purchase': 1, 'other-location': 2, covered: 3 };
      items.sort((left, right) => priority[left.status] - priority[right.status]
        || left.type.localeCompare(right.type) || left.name.localeCompare(right.name, 'es'));
      return res.json({
        dateTo,
        scope: { location: requestedLocation, label: requestedLocation === 'all' ? 'Todas las cafeterías' : selected[0].name },
        master: { validFrom: master.validFrom },
        summary: {
          activeItems: items.length,
          missing: items.filter(item => item.status === 'missing').length,
          noPurchase: items.filter(item => item.status === 'no-purchase').length,
          masterFallback: items.filter(item => item.status === 'no-purchase' && item.effectiveSource === 'master').length,
          recipeFallback: items.filter(item => item.status === 'no-purchase' && item.effectiveSource === 'recipe').length,
          otherLocation: items.filter(item => item.status === 'other-location').length,
          covered: items.filter(item => item.status === 'covered').length
        },
        items
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo revisar la cobertura de costos.' });
    }
  });

  app.get('/api/purchase-cost-variations', (req, res) => {
    try {
      return res.json(buildPurchaseCostVariationsPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo generar el reporte de variaciones de costo.' });
    }
  });

  function projectionPurchaseReferences(locationId, cutoffDate = projectionToday()) {
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const supplierMaster = latestMasterFile('master-suppliers', projectionToday());
    const supplierDirectory = supplierNamesByTaxId(supplierMaster?.filePath);
    const suppliers = new Map([...supplierDirectory].map(([key, name]) => [key, { key, name, taxId: key }]));
    const local = new Map();
    const global = new Map();
    const bySupplier = new Map();
    const newer=(a,b)=>!b || a.date>b.date || (a.date===b.date && (a.document.localeCompare(b.document,'es',{numeric:true}) || a.line.localeCompare(b.line,'es',{numeric:true}))>0);
    for (const store of stores) {
      for (const stored of storedWeeklyFiles(store.id, 'purchases')) {
        for (const sourceRow of readPurchaseRows(stored.filePath)) {
          const row = purchaseRecord(sourceRow, store, supplierDirectory);
          if (!row || !row.code || row.date > cutoffDate || dateIsExcluded(row.date, stored.excludedRanges) || !(row.quantity > 0) || /credito|credit_note|credit note/.test(normalizeHeader(row.documentType))) continue;
          suppliers.set(row.supplierKey, { key: row.supplierKey, name: row.supplier, taxId: row.supplierTaxId });
          const key = row.code.toUpperCase();
          if (newer(row,global.get(key))) global.set(key,row);
          if (store.id === locationId && newer(row,local.get(key))) local.set(key,row);
          const supplierItemKey = `${key}|${row.supplierKey}`;
          if (newer(row,bySupplier.get(supplierItemKey))) {
            bySupplier.set(supplierItemKey, row);
          }
        }
      }
    }
    return { local, global, bySupplier, suppliers };
  }

  function normalizedTaxIdentifier(value) {
    return String(value || '').replace(/[^0-9k]/gi, '').toLowerCase();
  }

  function supplierIsCompany(supplier, company) {
    const supplierTaxId = normalizedTaxIdentifier(supplier?.taxId || supplier?.key);
    const companyTaxId = normalizedTaxIdentifier(company?.taxId);
    if (supplierTaxId && companyTaxId && supplierTaxId === companyTaxId) return true;
    return Boolean(normalizeHeader(supplier?.name)
      && normalizeHeader(supplier?.name) === normalizeHeader(company?.name));
  }

  function branchPurchaseOrderConsolidation(selectedLocationIds) {
    const company = readCompanyProfile();
    const stores = readLocations().locations
      .filter(location => location.status === 'active' && location.type === 'store')
      .sort((left, right) => left.name.localeCompare(right.name, 'es'));
    const allowedIds = new Set(stores.map(store => store.id));
    const selectedIds = selectedLocationIds === null
      ? new Set(allowedIds)
      : new Set(selectedLocationIds.filter(id => allowedIds.has(id)));
    const orders = readPurchaseOrders().filter(order => order.status === 'confirmed'
      && allowedIds.has(order.location?.id)
      && supplierIsCompany(order.supplier, company));
    const dateForOrder = order => order.confirmedAt || order.updatedAt || order.createdAt || '';
    const demandByItem = new Map();
    for (const order of orders.filter(order => selectedIds.has(order.location.id))) {
      for (const item of order.items || []) {
        const key = String(item.key || item.code || '').trim().toUpperCase();
        const internalQuantity = item.internalQuantity === null || item.internalQuantity === undefined
          ? null : Number(item.internalQuantity);
        const unitsPerPurchaseUnit = item.unitsPerPurchaseUnit === null || item.unitsPerPurchaseUnit === undefined
          ? null : Number(item.unitsPerPurchaseUnit);
        const quantity = item.quantity === null || item.quantity === undefined ? null : Number(item.quantity);
        const value = Number.isFinite(internalQuantity)
          ? internalQuantity
          : (Number.isFinite(quantity) && Number.isFinite(unitsPerPurchaseUnit)
            ? quantity * unitsPerPurchaseUnit : null);
        if (!key || value === null) continue;
        if (!demandByItem.has(key)) demandByItem.set(key, []);
        demandByItem.get(key).push({ quantity: value, unit: item.internalUnit || '' });
      }
    }
    const staleBefore = addDays(projectionToday(), -3);
    const locations = stores.map(store => {
      const storeOrders = orders
        .filter(order => order.location.id === store.id)
        .sort((left, right) => dateForOrder(right).localeCompare(dateForOrder(left)));
      const latestOrder = storeOrders[0] || null;
      const latestAt = latestOrder ? dateForOrder(latestOrder) : null;
      return {
        id: store.id,
        name: store.name,
        selected: selectedIds.has(store.id),
        orderCount: storeOrders.length,
        latestOrder: latestOrder ? {
          id: latestOrder.id,
          orderNumber: latestOrder.orderNumber,
          confirmedAt: latestAt,
          date: latestAt.slice(0, 10),
          stale: latestAt.slice(0, 10) < staleBefore
        } : null
      };
    });
    return {
      companySupplier: { name: company.name, taxId: company.taxId || '' },
      selectedLocationIds: [...selectedIds],
      locations,
      selectedOrderCount: orders.filter(order => selectedIds.has(order.location.id)).length,
      demandByItem
    };
  }

  function projectionPurchaseOrderSelection(locationId, selectedOrderIds) {
    const dateForOrder = order => order.confirmedAt || order.updatedAt || order.createdAt || '';
    const orders = readPurchaseOrders()
      .filter(order => order.status === 'confirmed' && order.location?.id === locationId)
      .sort((left, right) => dateForOrder(right).localeCompare(dateForOrder(left)));
    const allowedIds = new Set(orders.map(order => order.id));
    const selectedIds = new Set((selectedOrderIds || []).filter(id => allowedIds.has(id)));
    const demandByItem = new Map();
    for (const order of orders.filter(order => selectedIds.has(order.id))) {
      for (const item of order.items || []) {
        const key = String(item.key || item.code || '').trim().toUpperCase();
        const internalQuantity = item.internalQuantity === null || item.internalQuantity === undefined
          ? null : Number(item.internalQuantity);
        const unitsPerPurchaseUnit = item.unitsPerPurchaseUnit === null || item.unitsPerPurchaseUnit === undefined
          ? null : Number(item.unitsPerPurchaseUnit);
        const quantity = item.quantity === null || item.quantity === undefined ? null : Number(item.quantity);
        const value = Number.isFinite(internalQuantity)
          ? internalQuantity
          : (Number.isFinite(quantity) && Number.isFinite(unitsPerPurchaseUnit)
            ? quantity * unitsPerPurchaseUnit : null);
        if (!key || value === null) continue;
        if (!demandByItem.has(key)) demandByItem.set(key, []);
        demandByItem.get(key).push({ quantity: value, unit: item.internalUnit || '' });
      }
    }
    return {
      selectedOrderIds: [...selectedIds],
      selectedOrderCount: selectedIds.size,
      orders: orders.map(order => {
        const confirmedAt = dateForOrder(order);
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          supplier: order.supplier,
          confirmedAt,
          date: confirmedAt.slice(0, 10),
          itemCount: (order.items || []).length,
          total: order.total,
          selected: selectedIds.has(order.id)
        };
      }),
      demandByItem
    };
  }

  function roundUpToPackageMultiple(quantity, unitsPerPackage) {
    const value = Number(quantity);
    const packageSize = Number(unitsPerPackage);
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(packageSize) || packageSize <= 0) return value;
    return Number((Math.ceil((value / packageSize) - 1e-9) * packageSize).toPrecision(12));
  }

  function purchaseUnitsForInternalQuantity(quantity, unitsPerPurchaseUnit) {
    const value = Number(quantity);
    const conversion = Number(unitsPerPurchaseUnit);
    if (!(value > 0) || !(conversion > 0)) return null;
    return Math.ceil((value / conversion) - 1e-9);
  }

  function inventoryCorrection(location,stock,recipes,ingredientCatalog,catalogAssignments,costResolver,originalMode=true) {
        const cache=new Map();
        return (code,unit,from,to)=>{
          const key=from+'|'+to;
          if(!cache.has(key)) {
            const sales=periodSalesData(location.id,from,to,{apiOnly:originalMode});
            if(originalMode && stock.sourceKind !== 'public-inventory'){const included=new Set((stock.includedOrders||[]).map(id=>`${location.id}:order:${id}`));sales.rows=sales.rows.filter(r=>included.has(r.orderKey));sales.orderFacts=sales.orderFacts.filter(r=>included.has(r.orderKey));}
            const milk=lac001SubstitutionSummary(sales,from,to,recipes,ingredientCatalog,costResolver);
            const syrup=syrupSauceSubstitutionSummary(sales,from,to,recipes,ingredientCatalog,catalogAssignments,costResolver);
            const packaging=inventoryAvoidedPackagingSummary(location,sales,from,to,recipes,ingredientCatalog,costResolver);
            const internal=[];
            for(const field of ['marketing','employees']) {
              if(!latestWeeklyFile(location.id,field))continue;
              let products;try{products=mergedConsumptionProducts(location.id,field,from,to);}catch(e){if(/No product sheet contains dates/.test(e.message))continue;throw e;}
              const ingredients=recipes&&ingredientCatalog?buildIngredientConsumption(products.products,recipes,ingredientCatalog,costResolver):{items:[]};
              internal.push({available:true,products,ingredients});
            }
            cache.set(key,{milk,syrup,packaging,internal});
          }
          const c=cache.get(key);
          const additions=[{code:'LAC001',unit:'L',quantity:c.milk.lac001VolumeLiters},...c.syrup.items.filter(i=>i.status==='resolved').map(i=>({code:i.originalCode,unit:i.unit,quantity:i.theoreticalQuantity})),...c.packaging.avoidedDisposablePackaging];
          return additions.filter(i=>i.code===code).reduce((n,i)=>n+(convertQuantityUnit(i.quantity,i.unit,unit)??0),0)-c.internal.reduce((n,r)=>n+consumptionQuantityForKardex(r,code,unit),0);
        };
  }

  function apiProjectionBasis(location,today,state,periodFrom) {
    const master=latestMasterFile('master-catalog',state.masterObservedAt?.slice(0,10)||today,location.id);
    if(!master)throw Error('Actualiza los maestros compartidos para calcular el inventario API.');
    const catalog=parseIngredientCatalog(master.filePath),assignments=parseInventoryHierarchyAssignments(master.filePath);
    const recipes=resolveRecipes(state.masterObservedAt?.slice(0,10)||today,location.id).recipes;
    const cost=buildInventoryPurchaseCostResolver(today,location,state,{catalog,recipes});
    const correction=inventoryCorrection(location,state,recipes,catalog,assignments,cost,true);
    return require('./projection-inventory').projectionInventory(state,location,today,correction,periodFrom);
  }

  function buildPurchaseProjection(locationId, selectedBranchLocationIds = null, selectedPurchaseOrderIds = null) {
    const location = activeLocation(locationId);
    if (!location) {
      const error = new Error('Selecciona una cafetería o bodega válida.');
      error.status = 400;
      throw error;
    }
    const today = projectionToday();
    const state=synchronizedOnly?synchronizedStock(location.id):stockSync.current(location.id);
    const apiProjection=state?.sourceKind==='public-inventory'?apiProjectionBasis(location,today,state):null;
    const apiItems=new Map((apiProjection?.items||[]).map(r=>[r.code+'|'+r.unit,r]));
    const parsed = apiProjection?{products:apiProjection.items,groups:[{date:apiProjection.to,metrics:[]}]}:mergedKardexData(location.id, 'kardex');
    if (!parsed?.groups.length) {
      const error = new Error('La ubicación no tiene un Kardex disponible para proyectar compras.');
      error.status = 404;
      throw error;
    }
    const periodFrom = addDays(today, -29);
    const groups = parsed.groups.filter(group => group.date <= today);
    const latestGroup = groups.at(-1);
    if (!latestGroup) {
      const error = new Error('El Kardex no contiene fechas utilizables para la proyección.');
      error.status = 422;
      throw error;
    }
    const consumptionGroups = groups.filter(group => group.date >= periodFrom);
    const policies = readPurchaseProjectionPolicies().locations?.[location.id]?.items || {};
    const references = projectionPurchaseReferences(location.id, today);
    const branchOrders = location.type === 'warehouse'
      ? branchPurchaseOrderConsolidation(selectedBranchLocationIds)
      : null;
    const purchaseOrders = projectionPurchaseOrderSelection(location.id, selectedPurchaseOrderIds);
    const catalogMaster = latestMasterFile('master-catalog', today);
    if (!catalogMaster) {
      const error = new Error('Se requiere un maestro de productos, ingredientes y extras vigente para identificar los ingredientes de la proyección.');
      error.status = 404;
      throw error;
    }
    const catalogAssignments = parseInventoryHierarchyAssignments(catalogMaster.filePath);
    const isProjectionItem = product => {
      const key = String(product.code || '').trim().toUpperCase();
      return key === 'SUB005' || catalogAssignments.get(key)?.type === 'ingredient' || (apiProjection && toteatMasterSync.sharedCurrent()?.products.some(p=>p.code===key&&p.stockManaged===true));
    };
    const conversions = parsePurchaseUnitConversions(catalogMaster.filePath);
    const costCatalog = parseIngredientCatalog(catalogMaster.filePath);
    const costResolver = apiProjection?buildInventoryPurchaseCostResolver(today,location,state,{catalog:costCatalog}):buildCostResolver(today, [location.id]);
    const supplierOptions = new Map(references.suppliers);
    supplierOptions.set('unassigned', { key: 'unassigned', name: 'Proveedor no asignado', taxId: '' });
    const items = parsed.products.filter(product => (product.code || product.name) && isProjectionItem(product)).map(product => {
      const key = (product.code || normalizeHeader(product.name)).toUpperCase();
      const policy = policies[key] || {};
      const minDays = Number.isFinite(Number(policy.minDays)) ? Number(policy.minDays) : 7;
      const maxDays = Number.isFinite(Number(policy.maxDays)) ? Number(policy.maxDays) : 14;
      const unitsPerPackage = Number.isFinite(Number(policy.unitsPerPackage)) && Number(policy.unitsPerPackage) > 0
        ? Number(policy.unitsPerPackage) : 1;
      const managed = policy.managed === true;
      const metricMatcher = metric => metric.startsWith('uso -') || metric.startsWith('trl-out -')
        || metric.startsWith('mov-out -') || metric.startsWith('trn-out -');
      const apiItem=apiItems.get(product.code+'|'+product.unit);
      const consumption30 = apiItem?apiItem.consumption30:consumptionGroups.reduce((sum, group) =>
        sum + kardexMetricTotal(product, group, metricMatcher), 0);
      const averageDailyConsumption = consumption30 / (apiItem?.consumptionDays || apiProjection?.days || 30);
      const hasFinal = latestGroup.metrics.some(metric => metric.normalized.startsWith('if -'));
      const currentInventory = apiItem?apiItem.currentInventory:kardexMetricValue(product, latestGroup,
        metric => metric.startsWith(hasFinal ? 'if -' : 'ii -'));
      const supplierSpecificPurchase = policy.supplierKey
        ? references.bySupplier.get(`${key}|${policy.supplierKey}`)
        : null;
      const latestPurchase = supplierSpecificPurchase || references.global.get(key) || references.local.get(key) || null;
      const catalogItem = conversions.get(key);
      let conversion = latestPurchase ? catalogItem?.conversions.get(normalizedUnit(latestPurchase.unit)) : null;
      if (!latestPurchase && !conversion && catalogItem) {
        conversion = [...catalogItem.conversions.values()].find(item =>
          normalizedUnit(item.purchaseUnit) !== normalizedUnit(catalogItem.baseUnit))
          || [...catalogItem.conversions.values()][0]
          || null;
      }
      const purchaseUnit = latestPurchase?.unit || conversion?.purchaseUnit || product.unit;
      const rawUnitsPerPurchaseUnit = conversion?.unitsPerPurchaseUnit
        ?? (normalizedUnit(purchaseUnit) === normalizedUnit(product.unit) ? 1 : null);
      const unitsPerPurchaseUnit = rawUnitsPerPurchaseUnit === null
        ? null
        : convertQuantityUnit(rawUnitsPerPurchaseUnit, conversion?.baseUnit || product.unit, product.unit);
      const inferredSupplier = latestPurchase
        ? { key: latestPurchase.supplierKey, name: latestPurchase.supplier, taxId: latestPurchase.supplierTaxId }
        : supplierOptions.get('unassigned');
      const configuredSupplier = policy.supplierKey ? supplierOptions.get(policy.supplierKey) : null;
      const supplier = configuredSupplier || inferredSupplier || supplierOptions.get('unassigned');
      const minimumStock = averageDailyConsumption * minDays;
      const maximumStock = averageDailyConsumption * maxDays;
      const ownNeedsPurchase = averageDailyConsumption > 0 && currentInventory <= minimumStock;
      const ownSuggestedInternalQuantity = ownNeedsPurchase ? Math.max(0, maximumStock - currentInventory) : 0;
      let branchOrderConversionMissing = false;
      const branchOrderInternalQuantity = (branchOrders?.demandByItem.get(key) || []).reduce((sum, demand) => {
        const converted = convertQuantityUnit(demand.quantity, demand.unit, product.unit);
        if (converted === null) branchOrderConversionMissing = true;
        return sum + (converted ?? 0);
      }, 0);
      const inventoryAfterBranchOrders = currentInventory - branchOrderInternalQuantity;
      const rawSuggestedInternalQuantity = averageDailyConsumption > 0
        ? (inventoryAfterBranchOrders <= minimumStock
          ? Math.max(0, maximumStock - inventoryAfterBranchOrders)
          : 0)
        : Math.max(0, -inventoryAfterBranchOrders);
      const needsPurchase = rawSuggestedInternalQuantity > 0;
      const suggestedInternalQuantity = roundUpToPackageMultiple(rawSuggestedInternalQuantity, unitsPerPackage);
      let purchaseOrderConversionMissing = false;
      const purchaseOrderInternalQuantity = (purchaseOrders.demandByItem.get(key) || []).reduce((sum, demand) => {
        const converted = convertQuantityUnit(demand.quantity, demand.unit, product.unit);
        if (converted === null) purchaseOrderConversionMissing = true;
        return sum + (converted ?? 0);
      }, 0);
      const inventoryAfterPurchaseOrders = currentInventory
        + purchaseOrderInternalQuantity
        - branchOrderInternalQuantity;
      const coverageAfterPurchaseOrdersDays = averageDailyConsumption > 0
        ? inventoryAfterPurchaseOrders / averageDailyConsumption
        : null;
      const suggestedPurchaseUnits = purchaseUnitsForInternalQuantity(
        suggestedInternalQuantity, unitsPerPurchaseUnit
      );
      const projectedInternalQuantity = suggestedPurchaseUnits === null
        ? suggestedInternalQuantity
        : suggestedPurchaseUnits * unitsPerPurchaseUnit;
      const fallbackCostReference = costResolver.resolve(key, product.unit, costCatalog.get(key));
      const estimatedPurchaseUnitCost = latestPurchase
        ? latestPurchase.effectiveUnitPrice || latestPurchase.listedUnitPrice || 0
        : fallbackCostReference.source !== 'missing' && unitsPerPurchaseUnit
          ? fallbackCostReference.unitCost * unitsPerPurchaseUnit
          : null;
      return {
        key,
        code: product.code,
        name: product.name,
        internalUnit: product.unit,
        currentInventory,
        currentInventoryBasis: apiItem?'Teórico API con compensaciones e internos':hasFinal ? 'Inventario Final' : 'Inventario Inicial',
        inventoryAnchorDate:apiItem?.anchorDate||null,
        consumptionFrom:apiItem?.consumptionFrom||periodFrom,
        consumptionDays:apiItem?.consumptionDays||30,
        consumptionBreakdown:apiItem?{sales:apiItem.salesConsumption,transfersOut:apiItem.transferOut,transformationsOut:apiItem.transformationOut,netCompensationsAndInternal:apiItem.netCorrections}:null,
        consumption30,
        averageDailyConsumption,
        currentCoverageDays: averageDailyConsumption > 0 ? currentInventory / averageDailyConsumption : null,
        minDays,
        maxDays,
        unitsPerPackage,
        managed,
        minimumStock,
        maximumStock,
        ownNeedsPurchase,
        ownSuggestedInternalQuantity,
        rawSuggestedInternalQuantity,
        branchOrderInternalQuantity,
        branchOrderConversionMissing,
        inventoryAfterBranchOrders,
        purchaseOrderInternalQuantity,
        purchaseOrderConversionMissing,
        inventoryAfterPurchaseOrders,
        coverageAfterPurchaseOrdersDays,
        supplierKey: supplier.key,
        supplier: supplier.name,
        supplierTaxId: supplier.taxId || '',
        supplierInferred: !configuredSupplier && Boolean(latestPurchase),
        supplierReferenceLocation: latestPurchase?.locationName || null,
        supplierPurchaseReferenceMatched: !policy.supplierKey || Boolean(supplierSpecificPurchase),
        purchaseUnit,
        unitsPerPurchaseUnit,
        suggestedInternalQuantity,
        suggestedPurchaseUnits,
        projectedInternalQuantity,
        estimatedPurchaseUnitCost,
        estimatedCostSource: latestPurchase ? 'purchase' : fallbackCostReference.source,
        estimatedCostSourceDate: latestPurchase?.date || fallbackCostReference.sourceDate,
        estimatedTotal: suggestedPurchaseUnits === null || estimatedPurchaseUnitCost === null
          ? null
          : suggestedPurchaseUnits * estimatedPurchaseUnitCost,
        needsPurchase,
        conversionAvailable: unitsPerPurchaseUnit !== null && unitsPerPurchaseUnit > 0
      };
    }).sort((left, right) => left.supplier.localeCompare(right.supplier, 'es') || left.name.localeCompare(right.name, 'es'));
    return {
      location: publicLocation(location),
      company: readCompanyProfile(),
      period: { from: apiProjection?.from||periodFrom, to: today, dataThrough: latestGroup.date, days: apiProjection?.days??30 },
      inventorySource:apiProjection?'toteat-api':'files',
      excluded:apiProjection?.excluded||[],
      warnings:apiProjection?.warnings||[],
      consumptionCriteria: apiProjection ? 'Salidas API: ventas, transferencias y transformaciones, más consumos internos y menos compensaciones; inventario desde tomas y movimientos con el mismo criterio del informe' : location.type === 'warehouse'
        ? 'Transferencias y transformaciones salientes del Kardex'
        : 'Consumo por ventas, transferencias y transformaciones salientes del Kardex',
      branchOrders: branchOrders ? {
        available: true,
        companySupplier: branchOrders.companySupplier,
        selectedLocationIds: branchOrders.selectedLocationIds,
        selectedOrderCount: branchOrders.selectedOrderCount,
        locations: branchOrders.locations,
        unconvertedItemCount: items.filter(item => item.branchOrderConversionMissing).length
      } : { available: false, selectedLocationIds: [], selectedOrderCount: 0, locations: [] },
      purchaseOrders: {
        available: true,
        selectedOrderIds: purchaseOrders.selectedOrderIds,
        selectedOrderCount: purchaseOrders.selectedOrderCount,
        orders: purchaseOrders.orders,
        unconvertedItemCount: items.filter(item => item.purchaseOrderConversionMissing).length
      },
      suppliers: [...supplierOptions.values()].sort((left, right) => left.name.localeCompare(right.name, 'es')),
      items,
      summary: {
        itemCount: items.length,
        managedItemCount: items.filter(item => item.managed).length,
        purchaseItemCount: items.filter(item => item.managed && item.needsPurchase).length,
        estimatedTotal: items.filter(item => item.managed).reduce((sum, item) => sum + (item.estimatedTotal || 0), 0),
        missingConversionCount: items.filter(item => item.managed && item.needsPurchase && !item.conversionAvailable).length,
        missingCostCount: items.filter(item => item.managed && item.needsPurchase && item.estimatedPurchaseUnitCost === null).length,
        unassignedSupplierCount: items.filter(item => item.managed && item.needsPurchase && item.supplierKey === 'unassigned').length
      }
    };
  }

  app.get('/api/purchase-projections', (req, res) => {
    try {
      const selectedBranchLocationIds = Object.prototype.hasOwnProperty.call(req.query, 'branches')
        ? String(req.query.branches || '').split(',').map(value => value.trim()).filter(Boolean)
        : null;
      const selectedPurchaseOrderIds = Object.prototype.hasOwnProperty.call(req.query, 'orders')
        ? String(req.query.orders || '').split(',').map(value => value.trim()).filter(Boolean)
        : null;
      return res.json(buildPurchaseProjection(
        String(req.query.location || ''), selectedBranchLocationIds, selectedPurchaseOrderIds
      ));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo calcular la proyección de compras.' });
    }
  });

  app.put('/api/purchase-projections/policies', (req, res) => {
    const location = activeLocation(String(req.body?.location || ''));
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    const requested = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requested.length) return res.status(400).json({ error: 'No se recibieron criterios para guardar.' });
    const registry = readPurchaseProjectionPolicies();
    registry.locations ||= {};
    registry.locations[location.id] ||= { items: {} };
    for (const item of requested) {
      const key = String(item.key || '').trim().toUpperCase();
      const minDays = Number(item.minDays);
      const maxDays = Number(item.maxDays);
      const unitsPerPackage = item.unitsPerPackage === undefined ? 1 : Number(item.unitsPerPackage);
      const managed = item.managed === true;
      const supplierKey = String(item.supplierKey || 'unassigned').trim();
      if (!key || !Number.isFinite(minDays) || !Number.isFinite(maxDays) || !Number.isFinite(unitsPerPackage)
        || minDays < 0 || maxDays < minDays || maxDays > 365 || unitsPerPackage <= 0 || unitsPerPackage > 1000000) {
        return res.status(400).json({ error: 'Cada ítem debe tener días mínimos, días máximos y unidades por empaque válidos; el máximo no puede ser menor que el mínimo.' });
      }
      registry.locations[location.id].items[key] = {
        minDays, maxDays, unitsPerPackage, supplierKey, managed, updatedAt: new Date().toISOString()
      };
    }
    writeJsonAtomic(purchaseProjectionPoliciesPath, registry);
    return res.json({ ok: true, saved: requested.length });
  });

  function purchaseOrderPath(orderId) {
    if (!/^OC-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/.test(orderId || '')) return null;
    const filePath = path.resolve(purchaseOrdersRoot, `${orderId}.json`);
    return path.dirname(filePath) === path.resolve(purchaseOrdersRoot) ? filePath : null;
  }

  function purchaseOrderFiles() {
    return fs.readdirSync(purchaseOrdersRoot)
      .filter(name => /^OC-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}\.json$/.test(name));
  }

  function ensurePurchaseOrderSequences() {
    const orders = purchaseOrderFiles()
      .map(name => ({ filePath: path.join(purchaseOrdersRoot, name), order: readJson(path.join(purchaseOrdersRoot, name), null) }))
      .filter(entry => entry.order?.id)
      .sort((left, right) => String(left.order.createdAt || '').localeCompare(String(right.order.createdAt || '')));
    const savedCounter = Number(readJson(purchaseOrderCounterPath, { last: 0 }).last) || 0;
    let last = Math.max(savedCounter, ...orders.map(entry => Number(entry.order.sequence) || 0));
    for (const entry of orders.filter(item => !Number.isInteger(Number(item.order.sequence)) || Number(item.order.sequence) <= 0)) {
      last += 1;
      entry.order.sequence = last;
      entry.order.orderNumber = `OC-${String(last).padStart(6, '0')}`;
      writeJsonAtomic(entry.filePath, entry.order);
    }
    for (const entry of orders.filter(item => Number.isInteger(Number(item.order.sequence)) && Number(item.order.sequence) > 0)) {
      const expectedNumber = `OC-${String(Number(entry.order.sequence)).padStart(6, '0')}`;
      if (entry.order.orderNumber !== expectedNumber) {
        entry.order.orderNumber = expectedNumber;
        writeJsonAtomic(entry.filePath, entry.order);
      }
    }
    writeJsonAtomic(purchaseOrderCounterPath, { last });
  }

  function nextPurchaseOrderSequence() {
    const counter = readJson(purchaseOrderCounterPath, { last: 0 });
    const sequence = (Number(counter.last) || 0) + 1;
    writeJsonAtomic(purchaseOrderCounterPath, { last: sequence });
    return sequence;
  }

  function purchaseOrderMetadata(order) {
    return {
      id: order.id,
      sequence: order.sequence,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      confirmedAt: order.confirmedAt,
      location: order.location,
      supplier: order.supplier,
      itemCount: order.items.length,
      total: order.total,
      hidden: order.hidden === true,
      hiddenAt: order.hiddenAt || null
    };
  }

  function purchaseOrderWithCurrentDetails(order) {
    const currentLocation = readLocations().locations.find(location => location.id === order.location?.id);
    const company = readCompanyProfile();
    return {
      ...order,
      company: {
        ...(order.company || {}),
        ...company
      },
      location: {
        ...(currentLocation ? publicLocation(currentLocation) : {}),
        ...(order.location || {}),
        address: order.location?.address || currentLocation?.address || ''
      }
    };
  }

  function readPurchaseOrders() {
    return purchaseOrderFiles()
      .flatMap(name => {
        const order = readJson(path.join(purchaseOrdersRoot, name), null);
        return order?.id ? [purchaseOrderWithCurrentDetails(order)] : [];
      });
  }

  ensurePurchaseOrderSequences();

  function normalizedPurchaseOrderItems(requested, availableItems, existingItems = null) {
    if (!Array.isArray(requested) || !requested.length) {
      const error = new Error('Selecciona al menos un ítem para la orden de compra.');
      error.status = 400;
      throw error;
    }
    const allowed = new Map(availableItems.map(item => [item.key, item]));
    for (const item of existingItems || []) allowed.set(item.key, item);
    const seen = new Set();
    return requested.map(requestedItem => {
      const key = String(requestedItem.key || '').trim().toUpperCase();
      const source = allowed.get(key);
      const quantity = Number(requestedItem.quantity);
      const requestedUnitCost = Number(requestedItem.unitCost);
      if (!source || seen.has(key) || !Number.isFinite(quantity) || quantity <= 0
        || !Number.isFinite(requestedUnitCost) || requestedUnitCost < 0) {
        const error = new Error('Cada ítem debe ser válido, no repetirse y tener cantidad y costo correctos.');
        error.status = 400;
        throw error;
      }
      seen.add(key);
      const unitCost = Math.round(requestedUnitCost);
      const referenceCost = Math.round(Number(source.estimatedPurchaseUnitCost ?? source.referenceUnitCost ?? 0));
      const unitsPerPurchaseUnit = Number(source.unitsPerPurchaseUnit);
      const unitsPerPackage = Number(source.unitsPerPackage);
      return {
        key,
        code: source.code || '',
        name: source.name,
        internalUnit: source.internalUnit || '',
        purchaseUnit: source.purchaseUnit || '',
        unitsPerPurchaseUnit: Number.isFinite(unitsPerPurchaseUnit) ? unitsPerPurchaseUnit : null,
        unitsPerPackage: Number.isFinite(unitsPerPackage) && unitsPerPackage > 0 ? unitsPerPackage : 1,
        suggestedPurchaseUnits: source.suggestedPurchaseUnits ?? null,
        referenceUnitCost: referenceCost,
        quantity,
        unitCost,
        internalQuantity: Number.isFinite(unitsPerPurchaseUnit) ? quantity * unitsPerPurchaseUnit : null,
        costModified: unitCost !== referenceCost,
        total: quantity * unitCost
      };
    });
  }

  app.get('/api/purchase-orders', (req, res) => {
    const location = String(req.query.location || '');
    const supplier = String(req.query.supplier || '');
    const orders = readPurchaseOrders()
      .filter(order => (!location || order.location.id === location) && (!supplier || order.supplier.key === supplier))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(purchaseOrderMetadata);
    return res.json({ orders });
  });

  app.get('/api/purchase-orders/:orderId', (req, res) => {
    const filePath = purchaseOrderPath(req.params.orderId);
    const order = filePath ? readJson(filePath, null) : null;
    if (!order) return res.status(404).json({ error: 'No se encontró la orden de compra.' });
    return res.json(purchaseOrderWithCurrentDetails(order));
  });

  app.post('/api/purchase-orders', (req, res) => {
    try {
      const projection = buildPurchaseProjection(String(req.body?.location || ''));
      const supplierKey = String(req.body?.supplierKey || '');
      const supplier = projection.suppliers.find(item => item.key === supplierKey);
      if (!supplier || ['all', 'unassigned'].includes(supplierKey)) {
        return res.status(400).json({ error: 'Selecciona un proveedor válido para generar la orden.' });
      }
      const availableItems = projection.items.filter(item => item.supplierKey === supplierKey);
      const items = normalizedPurchaseOrderItems(req.body?.items, availableItems);
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const id = `OC-${stamp.slice(0, 8)}-${stamp.slice(8)}-${crypto.randomBytes(4).toString('hex')}`;
      const sequence = nextPurchaseOrderSequence();
      const order = {
        id,
        sequence,
        orderNumber: `OC-${String(sequence).padStart(6, '0')}`,
        status: 'confirmed',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        confirmedAt: now.toISOString(),
        location: projection.location,
        company: projection.company,
        supplier,
        projectionPeriod: projection.period,
        filters: {
          onlyRequired: req.body?.filters?.onlyRequired === true,
          onlyManaged: req.body?.filters?.onlyManaged === true,
          branchLocationIds: Array.isArray(req.body?.filters?.branchLocationIds)
            ? req.body.filters.branchLocationIds.map(value => String(value)) : [],
          selectedPurchaseOrderIds: Array.isArray(req.body?.filters?.selectedPurchaseOrderIds)
            ? req.body.filters.selectedPurchaseOrderIds.map(value => String(value)) : []
        },
        items,
        total: items.reduce((sum, item) => sum + item.total, 0)
      };
      writeJsonAtomic(purchaseOrderPath(id), order);
      return res.status(201).json(order);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo guardar la orden de compra.' });
    }
  });

  app.put('/api/purchase-orders/:orderId', (req, res) => {
    try {
      const filePath = purchaseOrderPath(req.params.orderId);
      const existing = filePath ? readJson(filePath, null) : null;
      if (!existing) return res.status(404).json({ error: 'No se encontró la orden de compra.' });
      const projection = buildPurchaseProjection(existing.location.id);
      const availableItems = projection.items.filter(item => item.supplierKey === existing.supplier.key);
      const items = normalizedPurchaseOrderItems(req.body?.items, availableItems, existing.items);
      const updatedAt = new Date().toISOString();
      const order = {
        ...existing,
        status: 'confirmed',
        updatedAt,
        confirmedAt: updatedAt,
        company: readCompanyProfile(),
        items,
        total: items.reduce((sum, item) => sum + item.total, 0)
      };
      writeJsonAtomic(filePath, order);
      return res.json(order);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo actualizar la orden de compra.' });
    }
  });

  app.patch('/api/purchase-orders/:orderId/visibility', (req, res) => {
    const filePath = purchaseOrderPath(req.params.orderId);
    const order = filePath ? readJson(filePath, null) : null;
    if (!order) return res.status(404).json({ error: 'No se encontró la orden de compra.' });
    if (typeof req.body?.hidden !== 'boolean') {
      return res.status(400).json({ error: 'Indica si la orden debe quedar oculta o visible.' });
    }
    const changedAt = new Date().toISOString();
    const updated = {
      ...order,
      hidden: req.body.hidden,
      hiddenAt: req.body.hidden ? changedAt : null,
      visibilityUpdatedAt: changedAt
    };
    writeJsonAtomic(filePath, updated);
    return res.json(purchaseOrderMetadata(updated));
  });

  app.delete('/api/purchase-orders/:orderId', (req, res) => {
    const filePath = purchaseOrderPath(req.params.orderId);
    const order = filePath ? readJson(filePath, null) : null;
    if (!order) return res.status(404).json({ error: 'No se encontró la orden de compra.' });
    if (String(req.body?.confirmation || '') !== order.orderNumber) {
      return res.status(400).json({ error: 'Confirma el número exacto de la orden antes de eliminarla.' });
    }
    fs.rmSync(filePath);
    return res.json({ ok: true, deleted: order.id });
  });

  function buildProductsPayload(requestedLocation = 'all') {
      const todayKey = projectionToday();
      const activeStores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
      const selectedStore = requestedLocation === 'all' ? null : activeStores.find(location => location.id === requestedLocation);
      if (requestedLocation !== 'all' && !selectedStore) {
        const error = new Error('Selecciona una cafetería válida.');
        error.status = 400;
        throw error;
      }

      const catalogMaster = latestMasterFile('master-catalog', todayKey);
      if (!catalogMaster) {
        const error = new Error('No hay un maestro de productos vigente.');
        error.status = 404;
        throw error;
      }
      const hierarchyMaster = latestMasterFile('product-hierarchy', todayKey);
      if (!hierarchyMaster) {
        const error = new Error('No hay una jerarquía de productos vigente.');
        error.status = 404;
        throw error;
      }
      const costResolver = buildCostResolver(todayKey, (selectedStore ? [selectedStore] : activeStores).map(location => location.id));
      const products = parseProductCatalog(catalogMaster.filePath).map(product => {
        const costReference = costResolver.resolve(product.code, product.unit, {
          unitCost: product.cost,
          unit: product.unit
        });
        const cost = costReference.unitCost;
        return {
          ...product,
          masterCost: product.cost,
          cost,
          costSource: costReference.source,
          costSourceDate: costReference.sourceDate,
          marginPercent: costReference.source !== 'missing' && product.netPrice
            ? ((product.netPrice - cost) / product.netPrice) * 100
            : null
        };
      });
      const { hierarchyMap, pathFor } = parseProductHierarchies(hierarchyMaster.filePath);
      const last7From = addDays(todayKey, -6);
      const last56From = addDays(todayKey, -55);
      const metrics = new Map();
      const datesRead = [];
      const warnings = [];
      let filesRead = 0;
      for (const location of selectedStore ? [selectedStore] : activeStores) {
        for (const stored of storedSalesFiles(location.id)) {
          try {
            for (const row of readSalesRows(stored.filePath)) {
              const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim();
              const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
              const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
              if (!code || !date || date > todayKey || date < last56From || !quantity) continue;
              if (dateIsExcluded(date, stored.excludedRanges)) continue;
              datesRead.push(date);
              const item = metrics.get(code) || { units56: 0, units7: 0 };
              item.units56 += quantity;
              if (date >= last7From) item.units7 += quantity;
              metrics.set(code, item);
            }
            filesRead += 1;
          } catch {
            warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
          }
        }
      }

      const groups = new Map();
      for (const product of products) {
        const hierarchy = product.hierarchyId ? hierarchyMap.get(product.hierarchyId) : null;
        const hierarchyPath = hierarchy ? pathFor(hierarchy.id) : [];
        const groupId = hierarchy?.id || 'unassigned';
        const sales = metrics.get(product.code) || { units56: 0, units7: 0 };
        const averageWeeklyUnits8 = sales.units56 / 8;
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            id: groupId,
            name: hierarchy?.name || 'Sin jerarquía',
            path: hierarchyPath.length ? hierarchyPath : ['Sin jerarquía'],
            order: hierarchy?.order || 9999,
            products: []
          });
        }
        groups.get(groupId).products.push({
          ...product,
          averageWeeklyUnits8,
          unitsLast7Days: sales.units7,
          unitsChangePercent: averageWeeklyUnits8
            ? ((sales.units7 / averageWeeklyUnits8) - 1) * 100
            : null
        });
      }
      const hierarchyGroups = [...groups.values()]
        .map(group => ({
          ...group,
          products: group.products.sort((left, right) =>
            right.unitsLast7Days - left.unitsLast7Days || left.name.localeCompare(right.name, 'es'))
        }))
        .sort((left, right) => left.path.join(' / ').localeCompare(right.path.join(' / '), 'es') || left.order - right.order);
      const publicMaster = record => (({ filePath, ...value }) => value)(record);
      return {
        date: todayKey,
        scope: selectedStore
          ? { type: 'location', location: selectedStore.id, label: selectedStore.name }
          : { type: 'all', location: null, label: 'Todas las cafeterías' },
        periods: { last7: { from: last7From, to: todayKey }, last8Weeks: { from: last56From, to: todayKey, divisor: 8 } },
        productCount: products.length,
        hierarchyCount: hierarchyGroups.length,
        hierarchies: hierarchyGroups,
        coverage: datesRead.length ? { from: datesRead.sort()[0], to: datesRead.sort().at(-1) } : null,
        filesRead,
        warnings,
        sources: { catalog: publicMaster(catalogMaster), hierarchy: publicMaster(hierarchyMaster) }
      };
  }

  function productSnapshotPath(snapshotId) {
    if (!/^\d{4}-\d{2}-\d{2}--[a-zA-Z0-9._-]+$/.test(snapshotId || '')) return null;
    const filePath = path.resolve(productReportsRoot, `${snapshotId}.json`);
    return path.dirname(filePath) === path.resolve(productReportsRoot) ? filePath : null;
  }

  function productSnapshotMetadata(snapshot, snapshotId) {
    return {
      id: snapshotId,
      date: snapshot.date,
      savedAt: snapshot.savedAt,
      scope: snapshot.scope,
      productCount: snapshot.productCount,
      hierarchyCount: snapshot.hierarchyCount
    };
  }

  function listProductSnapshots(requestedLocation) {
    return fs.readdirSync(productReportsRoot)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        const snapshotId = name.slice(0, -5);
        const snapshot = readJson(path.join(productReportsRoot, name), null);
        if (!snapshot || (snapshot.scope.location || 'all') !== requestedLocation) return [];
        return [productSnapshotMetadata(snapshot, snapshotId)];
      })
      .sort((left, right) => right.date.localeCompare(left.date) || right.savedAt.localeCompare(left.savedAt));
  }

  function flattenProductReport(report) {
    return report.hierarchies.flatMap(group => group.products.map(product => ({
      ...product,
      hierarchyPath: group.path
    })));
  }

  function withPreviousProductPrices(report, requestedLocation) {
    const oldestAcceptedDate = addDays(report.date, -30);
    const previousMetadata = listProductSnapshots(requestedLocation)
      .find(snapshot => snapshot.date < report.date && snapshot.date >= oldestAcceptedDate);
    if (!previousMetadata) return { ...report, priceReference: null };
    const filePath = productSnapshotPath(previousMetadata.id);
    const previous = filePath ? readJson(filePath, null) : null;
    if (!previous) return { ...report, priceReference: null };
    const previousProducts = new Map(flattenProductReport(previous).map(product => [product.code, product]));
    return {
      ...report,
      priceReference: productSnapshotMetadata(previous, previousMetadata.id),
      hierarchies: report.hierarchies.map(group => ({
        ...group,
        products: group.products.map(product => {
          const previousProduct = previousProducts.get(product.code);
          const previousPrice = previousProduct && Math.abs((previousProduct.price || 0) - (product.price || 0)) > 0.005
            ? previousProduct.price
            : null;
          return { ...product, previousPrice };
        })
      }))
    };
  }

  function productAnalyticsLocations(requestedLocation) {
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    if (requestedLocation === 'all') return stores;
    const selected = stores.find(location => location.id === requestedLocation);
    if (!selected) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    return [selected];
  }

  function storedFileIntersectsPeriod(stored, period) {
    if (!period) return true;
    const range = stored.record?.detectedRange || stored.record?.confirmedRange;
    return !range || (range.to >= period.from && range.from <= period.to);
  }

  function productAnalyticsSourceFingerprint(stores, sourcePeriod = null) {
    const paths = stores.flatMap(store => [
      ...storedSalesFiles(store.id),
      ...storedTransactionFiles(store.id, 'payment-details')
    ]).filter(stored => storedFileIntersectsPeriod(stored, sourcePeriod)).map(stored => {
      const stat = fs.statSync(stored.filePath);
      return `${stored.filePath}:${stat.size}:${stat.mtimeMs}`;
    }).sort();
    return crypto.createHash('sha256').update(paths.join('|')).digest('hex');
  }

  function buildProductAnalyticsSource(requestedLocation, sourcePeriod = null) {
    const stores = productAnalyticsLocations(requestedLocation);
    const fingerprint = productAnalyticsSourceFingerprint(stores, sourcePeriod);
    const periodKey = sourcePeriod ? `${sourcePeriod.from}:${sourcePeriod.to}` : 'all';
    const cacheKey = `${stores.map(store => store.id).sort().join(',')}:${periodKey}:${fingerprint}`;
    const cached = productAnalyticsSourceCache.get(cacheKey);
    if (cached) return cached;
    const warnings = [];
    const seenRows = new Set();
    const orders = new Map();
    let salesFilesRead = 0;
    for (const location of stores) {
      for (const stored of storedSalesFiles(location.id).filter(file => storedFileIntersectsPeriod(file, sourcePeriod))) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const dateTime = salesTransactionDateTime(row);
            const date = dateTime?.slice(0, 10);
            if (!date || dateIsExcluded(date, stored.excludedRanges)
              || (sourcePeriod && (date < sourcePeriod.from || date > sourcePeriod.to))) continue;
            const canonical = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
            if (seenRows.has(rowKey)) continue;
            seenRows.add(rowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto'])) || code;
            if (!code && !name) continue;
            const transactionKey = salesTransactionKey(row);
            const orderKey = `${location.id}:${transactionKey}`;
            const paid = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar']));
            const list = numericValue(rowValue(row, ['Precio Lista', 'Precio de lista'])) || 0;
            const discount = numericValue(rowValue(row, ['Descuento'])) || 0;
            // Toteat's line-level "Precio a Pagar" is already the final amount after
            // discounts. Apply "Descuento" only when that final-price column is absent.
            const lineGrossSales = paid !== null ? paid : list + discount;
            const quantity = row['API Source'] === 'Toteat' ? (numericValue(rowValue(row, ['Cantidad'])) ?? 0) : Math.max(0, numericValue(rowValue(row, ['Cantidad'])) ?? 1);
            const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
            const orderDiscount = numericValue(rowValue(row, ['Descuentos', 'Descuento total'])) || 0;
            const existing = orders.get(orderKey) || {
              orderKey,
              orderReference: transactionKey.startsWith('order:') ? transactionKey.slice('order:'.length) : null,
              locationId: location.id,
              locationName: location.name,
              date,
              dateTime,
              time: dateTime.slice(11, 16),
              hour: Number(dateTime.slice(11, 13)) + Number(dateTime.slice(14, 16)) / 60,
              channel: String(rowValue(row, ['Origen', 'Canal', 'Channel']) || '').trim(),
              clients: Math.max(0, numericValue(rowValue(row, ['Numero de clientes', 'Número de clientes'])) || 0),
              grossSales: gross,
              orderDiscount,
              netSales: gross !== null ? (gross + orderDiscount) / 1.19 : 0,
              reversalSignals: new Set(),
              lines: []
            };
            if (!existing.channel) existing.channel = String(rowValue(row, ['Origen', 'Canal', 'Channel']) || '').trim();
            for (const signal of reversalSignals({
              orderAmount: gross,
              quantity: numericValue(rowValue(row, ['Cantidad'])),
              lineAmount: lineGrossSales,
              status: rowValue(row, ['Estado', 'Estado de orden', 'Status', 'Order Status']),
              documentType: rowValue(row, ['Tipo de documento', 'Tipo documento', 'Document Type'])
            })) existing.reversalSignals.add(signal);
            existing.lines.push({
              code,
              name,
              quantity,
              listGross: list,
              baseGross: numericValue(rowValue(row, ['Precio Base', 'Base Price'])),
              paidGross: paid,
              discountGross: discount,
              promotionLabel: String(rowValue(row, ['Promoción', 'Promocion', 'Promotion']) || '').trim(),
              size: String(rowValue(row, ['Tamaño', 'Tamano', 'Size']) || '').trim(),
              netSales: lineGrossSales / 1.19,
              hierarchyId: String(rowValue(row, ['AB.']) ?? '').trim() || null,
              hierarchyName: repairMojibake(rowValue(row, ['Categorías de Productos/Platos', 'Categorias de Productos/Platos'])) || '',
              extraHierarchyId: String(rowValue(row, ['BA.']) ?? '').trim() || null,
              extraHierarchyName: repairMojibake(rowValue(row, ['Jerarquía de Extras', 'Jerarquia de Extras'])) || ''
            });
            orders.set(orderKey, existing);
          }
          salesFilesRead += 1;
        } catch {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    const orderFacts = [...orders.values()];
    for (const order of orderFacts) {
      if (!(order.netSales > 0)) order.netSales = order.lines.reduce((total, line) => total + line.netSales, 0);
      order.reversalSignals = [...order.reversalSignals];
    }
    const payment = paymentDetailModes(stores, warnings, orderFacts.map(order => ({ orderKey: order.orderKey, net: order.netSales })), sourcePeriod);
    for (const order of orderFacts) {
      const detail = payment.modes.get(order.orderKey);
      order.mode = detail?.key || 'unknown';
      order.modeAmbiguous = Boolean(detail?.ambiguous);
      order.paymentDue = detail?.dueAmount ?? null;
      order.paymentTotal = detail?.orderTotal ?? null;
      order.paymentPaid = detail?.paidTotal ?? null;
      order.paymentTip = detail?.gratuity ?? null;
      order.paymentTotalAmbiguous = Boolean(detail?.totalAmbiguous);
      order.paymentDuePartial = Boolean(detail?.hasPartialDue);
      order.paymentMatched = Boolean(detail);
      order.paymentAmountAmbiguous = Boolean(detail?.amountAmbiguous);
      order.paymentFilesRead = payment.filesReadByLocation.get(order.locationId) || 0;
      order.paymentComment = detail?.comment || '';
    }
    const result = {
      stores,
      orders: orderFacts.sort((left, right) => left.date.localeCompare(right.date) || left.orderKey.localeCompare(right.orderKey)),
      warnings,
      fingerprint,
      salesFilesRead,
      paymentFilesRead: payment.filesRead,
      coverage: {
        paymentMatchPercent: orderFacts.length ? orderFacts.filter(order => payment.modes.has(order.orderKey)).length / orderFacts.length * 100 : 0,
        ambiguousPaymentOrders: orderFacts.filter(order => order.modeAmbiguous).length
      }
    };
    if (productAnalyticsSourceCache.size >= 6) {
      productAnalyticsSourceCache.delete(productAnalyticsSourceCache.keys().next().value);
    }
    productAnalyticsSourceCache.set(cacheKey, result);
    return result;
  }

  function buildProductAnalyticsSnapshot(requestedLocation, dateTo) {
    const source = buildProductAnalyticsSource(requestedLocation);
    const catalogMaster = latestMasterFile('master-catalog', dateTo);
    const hierarchyMaster = latestMasterFile('product-hierarchy', dateTo);
    const recipeResolution = resolveRecipes(dateTo);
    const recipesMaster = recipeResolution.primary;
    if (!catalogMaster || !hierarchyMaster || !recipesMaster || !recipeResolution.recipes.size) {
      const error = new Error('Se requieren los maestros vigentes de productos, jerarquías y recetas para construir el análisis.');
      error.status = 404;
      throw error;
    }
    const catalogProducts = parseProductCatalog(catalogMaster.filePath);
    const analysisCatalog = parseSalesAnalysisCatalog(catalogMaster.filePath);
    const fullCatalog = parseIngredientCatalog(catalogMaster.filePath);
    const recipes = recipeResolution.recipes;
    const hierarchy = parseProductHierarchies(hierarchyMaster.filePath);
    const hierarchyAncestors = id => {
      const ids = [];
      const visited = new Set();
      let current = hierarchy.hierarchyMap.get(id);
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ids.unshift(current.id);
        current = current.parentId ? hierarchy.hierarchyMap.get(current.parentId) : null;
      }
      return ids;
    };
    const productByCode = new Map(catalogProducts.map(product => [product.code.toUpperCase(), product]));
    const costResolver = buildCostResolver(dateTo, source.stores.map(store => store.id));
    const products = catalogProducts.map(product => {
      const hierarchyIds = hierarchyAncestors(product.hierarchyId);
      const cost = costResolver.resolve(product.code, product.unit, { unitCost: product.cost, unit: product.unit });
      return {
        code: product.code.toUpperCase(),
        name: product.name,
        hierarchyIds,
        hierarchyPath: product.hierarchyId ? hierarchy.pathFor(product.hierarchyId) : [],
        listPrice: product.price,
        unitCost: cost.unitCost,
        costSource: cost.source,
        costSourceDate: cost.sourceDate,
        costAvailable: cost.source !== 'missing'
      };
    });
    const productLookup = new Map(products.map(product => [product.code, product]));
    const orders = source.orders.map(order => ({
      ...order,
      lines: order.lines.map(line => {
        const product = productLookup.get(line.code);
        const hierarchyIds = line.hierarchyId ? hierarchyAncestors(line.hierarchyId) : product?.hierarchyIds || [];
        const hierarchyPath = line.hierarchyId ? hierarchy.pathFor(line.hierarchyId) : product?.hierarchyPath || (line.hierarchyName ? [line.hierarchyName] : []);
        return {
          ...line,
          hierarchyIds,
          hierarchyPath,
          isExtra: Boolean(line.extraHierarchyId || analysisCatalog.recipeExtras.has(line.code))
        };
      })
    }));
    const recipePayload = {};
    for (const [code, lines] of recipes) {
      recipePayload[String(code).toUpperCase()] = lines.map(line => {
        const catalogItem = fullCatalog.get(line.ingredientId) || fullCatalog.get(String(line.ingredientId).toUpperCase());
        const yieldFactor = line.yieldRate > 0 ? line.yieldRate / 100 : 1;
        const cost = costResolver.resolve(line.ingredientId, line.unit, catalogItem);
        return {
          ingredientId: String(line.ingredientId).toUpperCase(),
          ingredientName: catalogItem?.name || line.ingredientName || line.ingredientId,
          quantity: line.quantity,
          effectiveQuantity: line.quantity / yieldFactor,
          unit: line.unit,
          unitCost: cost.unitCost,
          costSource: cost.source,
          costSourceDate: cost.sourceDate
        };
      });
    }
    const usedHierarchyIds = new Set(orders.flatMap(order => order.lines.filter(line => !line.isExtra).flatMap(line => line.hierarchyIds || [])));
    const hierarchies = [...hierarchy.hierarchyMap.values()].filter(node => usedHierarchyIds.has(node.id)).map(node => ({
      id: node.id,
      name: node.name,
      path: hierarchy.pathFor(node.id),
      pathLabel: hierarchy.pathFor(node.id).join(' › ') || node.name,
      depth: hierarchyAncestors(node.id).length
    })).sort((left, right) => left.pathLabel.localeCompare(right.pathLabel, 'es'));
    return {
      orders,
      products,
      recipes: recipePayload,
      hierarchies,
      coverage: source.coverage,
      warnings: source.warnings,
      sources: {
        salesFiles: source.salesFilesRead,
        paymentFiles: source.paymentFilesRead,
        catalog: catalogMaster.originalName || catalogMaster.name,
        recipes: recipesMaster.originalName || recipesMaster.name,
        hierarchy: hierarchyMaster.originalName || hierarchyMaster.name
      }
    };
  }

  app.get('/api/products/analysis/options', (req, res) => {
    try {
      const requestedLocation = String(req.query.location || 'all');
      const source = buildProductAnalyticsSource(requestedLocation);
      const dates = source.orders.map(order => order.date).sort();
      const reportDate = dates.at(-1) || projectionToday();
      const snapshot = buildProductAnalyticsSnapshot(requestedLocation, reportDate);
      return res.json({
        locations: readLocations().locations.filter(location => location.status === 'active' && location.type === 'store').map(publicLocation),
        hierarchies: snapshot.hierarchies,
        availablePeriod: dates.length ? { from: dates[0], to: dates.at(-1) } : null,
        coverage: snapshot.coverage
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudieron cargar las opciones del análisis de productos.' });
    }
  });

  app.get('/api/products/analysis', (req, res) => {
    try {
      const requestedLocation = String(req.query.location || 'all');
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
        return res.status(400).json({ error: 'Selecciona un período válido para el análisis de productos.' });
      }
      const stores = productAnalyticsLocations(requestedLocation);
      const snapshot = buildProductAnalyticsSnapshot(requestedLocation, dateTo);
      const report = buildProductAnalytics(snapshot, {
        location: requestedLocation,
        locationLabel: requestedLocation === 'all' ? 'Todas las cafeterías' : stores[0].name,
        hierarchyId: String(req.query.hierarchyId || 'all'),
        from: dateFrom,
        to: dateTo
      });
      report.sources = snapshot.sources;
      return res.json(report);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el análisis estadístico de productos.' });
    }
  });

  function demandStores(query = {}) {
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const raw = String(query.locations || 'all').trim();
    if (raw === 'all') return stores;
    const ids = [...new Set(raw.split(',').map(id => id.trim()).filter(Boolean))];
    if (!ids.length || ids.some(id => !stores.some(store => store.id === id))) {
      const error = new Error('Selecciona una o más cafeterías activas válidas.');
      error.status = 400;
      throw error;
    }
    return stores.filter(store => ids.includes(store.id));
  }

  function demandFilters(query = {}, today = projectionToday()) {
    const mode = String(query.mode || 'month');
    if (!['custom', 'day', 'week', 'month', 'ytd', 'all'].includes(mode)) {
      const error = new Error('Selecciona un período válido para el análisis de la demanda.');
      error.status = 400;
      throw error;
    }
    const anchor = String(query.anchor || today);
    const dateFrom = String(query.dateFrom || '');
    const dateTo = String(query.dateTo || '');
    if (!isValidDate(anchor) || anchor > today
      || (mode === 'custom' && (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo || dateTo > today))) {
      const error = new Error('Selecciona fechas válidas, no futuras y en orden.');
      error.status = 400;
      throw error;
    }
    const modeOfService = String(query.modeOfService || 'all');
    if (!['all', 'takeaway', 'dineIn', 'unknown'].includes(modeOfService)) {
      const error = new Error('Selecciona una modalidad válida.');
      error.status = 400;
      throw error;
    }
    const priceBand = Math.min(10000, Math.max(100, Math.round(Number(query.priceBand) || 500)));
    const morningEnd = Math.round(Number(query.morningEnd) || 12);
    const middayEnd = Math.round(Number(query.middayEnd) || 16);
    const afternoonEnd = Math.round(Number(query.afternoonEnd) || 20);
    if (!(morningEnd >= 1 && morningEnd < middayEnd && middayEnd < afternoonEnd && afternoonEnd <= 23)) {
      const error = new Error('Las franjas horarias deben estar en orden y dentro de 1–23 horas.');
      error.status = 400;
      throw error;
    }
    const nameGender = String(query.nameGender || 'all');
    if (!['all', 'feminine-associated', 'masculine-associated', 'indeterminate', 'unavailable'].includes(nameGender)) {
      const error = new Error('Selecciona un segmento de nombre válido.'); error.status = 400; throw error;
    }
    const recurrence = String(query.recurrence || 'all');
    if (!['all', 'returning-instrument', 'single-observed-date', 'unlinked'].includes(recurrence)) {
      const error = new Error('Selecciona un segmento de recurrencia válido.'); error.status = 400; throw error;
    }
    return { mode, anchor, dateFrom, dateTo, modeOfService, priceBand, morningEnd, middayEnd, afternoonEnd,
      nameGender, recurrence,
      category: String(query.category || '').trim(), product: String(query.product || '').trim().toUpperCase(),
      channel: String(query.channel || '').trim(), size: String(query.size || '').trim() };
  }

  function demandSalesRanges(store, today) {
    return storedSalesFiles(store.id).flatMap(stored => {
      const range = stored.record.confirmedRange || stored.record.detectedRange;
      if (!isValidDate(range?.from) || !isValidDate(range?.to) || range.from > range.to
        || range.to > today || (Date.parse(range.to) - Date.parse(range.from)) / 86400000 > 366) return [];
      return [{ from: range.from, to: range.to, excludedRanges: stored.excludedRanges || [] }];
    });
  }

  function demandMercadoPagoSettlements(stores) {
    const settlements = [];
    const seen = new Set();
    const warnings = [];
    let filesRead = 0;
    let reversalsIgnored = 0;
    let duplicatesIgnored = 0;
    let rowsRead = 0;
    const pseudonymKey = process.env.BREWIT_PSEUDONYM_SECRET || `brewit-local:${path.resolve(uploadsRoot)}`;
    for (const location of stores) {
      for (const stored of storedTransactionFiles(location.id, 'mercadopago')) {
        try {
          for (const sheet of readGenericTransactionSheets(stored.filePath)) {
            const header = sheet.rows[0] || [];
            const normalizedHeaders = new Set(header.map(normalizeHeader));
            if (!normalizedHeaders.has('transaction_date') || !normalizedHeaders.has('transaction_amount')
              || !normalizedHeaders.has('source_id')) {
              warnings.push(`Se omitió una hoja no compatible almacenada como MercadoPago: ${stored.record.originalName || stored.record.name}.`);
              continue;
            }
            for (const values of sheet.rows.slice(1)) {
              rowsRead += 1;
              const row = Object.fromEntries(header.map((name, index) => [String(name || `column-${index}`), values[index]]));
              const type = String(rowValue(row, ['TRANSACTION_TYPE']) || '').trim().toUpperCase();
              if (type && type !== 'SETTLEMENT') { reversalsIgnored += 1; continue; }
              const dateTime = mercadoPagoDateTime(row);
              const date = dateTime?.slice(0, 10);
              if (!date || dateIsExcluded(date, stored.excludedRanges)) continue;
              const sourceId = String(rowValue(row, ['SOURCE_ID']) ?? '').trim();
              const key = `${location.id}:${sourceId || genericTransactionRowKey(values)}`;
              if (seen.has(key)) { duplicatesIgnored += 1; continue; }
              seen.add(key);
              const rawInstrument = mercadoPagoCardKey(row);
              settlements.push({ key, sourceId: sourceId || null, locationId: location.id, date, dateTime,
                amount: Math.abs(numericValue(rowValue(row, ['TRANSACTION_AMOUNT'])) || 0),
                instrumentKey: rawInstrument ? crypto.createHmac('sha256', pseudonymKey).update(rawInstrument).digest('hex').slice(0, 24) : null,
                paymentMethod: String(rowValue(row, ['PAYMENT_METHOD', 'PAYMENT_METHOD_TYPE']) || '').trim() || null });
            }
          }
          filesRead += 1;
        } catch {
          warnings.push(`No se pudo leer MercadoPago: ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    settlements.sort((left, right) => left.dateTime.localeCompare(right.dateTime));
    return { settlements, coverage: { filesRead, rowsRead, settlements: settlements.length,
      identifiableSettlements: settlements.filter(item => item.instrumentKey).length, reversalsIgnored, duplicatesIgnored, warnings } };
  }

  function addDemandIdentity(payload, orders) {
    const paymentSource = demandMercadoPagoSettlements(payload.stores);
    const linkage = linkOrdersToSettlements(orders, paymentSource.settlements, { maximumMinutes: 2, amountTolerance: 2 });
    const instrumentDates = new Map();
    for (const settlement of paymentSource.settlements) {
      if (!settlement.instrumentKey) continue;
      const dates = instrumentDates.get(settlement.instrumentKey) || new Set();
      dates.add(settlement.date);
      instrumentDates.set(settlement.instrumentKey, dates);
    }
    const enriched = orders.map(order => {
      const link = linkage.links.get(order.orderKey) || { status: 'unlinked' };
      const name = classifyRecordedName(order.paymentComment);
      const instrumentDatesUntilToday = link.instrumentKey
        ? [...(instrumentDates.get(link.instrumentKey) || [])].filter(date => date <= payload.today) : [];
      return { ...order, nameGenderSegment: name.segment, nameClassificationBasis: name.basis,
        paymentLinkStatus: link.status, paymentLinkConfidence: link.confidence || null,
        instrumentKey: link.status === 'estimated-high' ? link.instrumentKey : null,
        recurrenceGroup: link.status === 'estimated-high'
          ? (new Set(instrumentDatesUntilToday).size >= 2 ? 'returning-instrument' : 'single-observed-date') : 'unlinked' };
    });
    return { orders: enriched, linkageCoverage: { ...linkage.coverage,
      potentialSplitOrders: orders.filter(order => order.paymentDuePartial).length,
      paymentSource: paymentSource.coverage,
      classifierVersion: NAME_CLASSIFIER_VERSION } };
  }

  function demandEnrichmentFingerprint(payload) {
    const signatures = [payload.source.fingerprint, payload.today, ...payload.stores.map(store => store.id).sort()];
    const visit = directory => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else {
          const stat = fs.statSync(entryPath);
          signatures.push(`${entryPath}:${stat.size}:${stat.mtimeMs}`);
        }
      }
    };
    visit(mastersRoot);
    payload.stores.forEach(store => visit(transactionLocationRoot(store.id)));
    return crypto.createHash('sha256').update(signatures.sort().join('|')).digest('hex');
  }

  function demandOrdersWithIdentity(payload) {
    const key = demandEnrichmentFingerprint(payload);
    const cached = demandEnrichmentCache.get(key);
    if (cached) return cached;
    const result = addDemandIdentity(payload, enrichedDemandOrders(payload));
    if (demandEnrichmentCache.size >= 4) demandEnrichmentCache.delete(demandEnrichmentCache.keys().next().value);
    demandEnrichmentCache.set(key, result);
    return result;
  }

  function buildDemandSource(query = {}) {
    const today = projectionToday();
    const stores = demandStores(query);
    const filters = demandFilters(query, today);
    const source = buildProductAnalyticsSource('all');
    const selectedIds = new Set(stores.map(store => store.id));
    const sourceOrders = source.orders.filter(order => selectedIds.has(order.locationId) && order.date <= today);
    const selectedStores = stores.map(store => ({ ...store, salesRanges: demandSalesRanges(store, today) }));
    const availableDates = sourceOrders.map(order => order.date).sort();
    return { today, stores: selectedStores, filters, source, sourceOrders,
      availablePeriod: availableDates.length ? { from: availableDates[0], to: availableDates.at(-1) } : null };
  }

  function demandOptions(payload) {
    const products = new Map();
    const categories = new Map();
    const channels = new Set();
    const sizes = new Set();
    for (const order of payload.sourceOrders) {
      if (order.channel) channels.add(order.channel);
      for (const line of order.lines) {
        if (line.size) sizes.add(line.size);
        if (line.extraHierarchyId) continue;
        if (line.code) products.set(line.code, { code: line.code, name: line.name || line.code });
        if (line.hierarchyId) categories.set(line.hierarchyId,
          { id: line.hierarchyId, name: line.hierarchyName || line.hierarchyId });
      }
    }
    return {
      today: payload.today,
      locations: readLocations().locations.filter(item => item.status === 'active' && item.type === 'store').map(publicLocation),
      selectedLocations: payload.stores.map(store => store.id),
      availablePeriod: payload.availablePeriod,
      products: [...products.values()].sort((left, right) => left.name.localeCompare(right.name, 'es')),
      categories: [...categories.values()].sort((left, right) => left.name.localeCompare(right.name, 'es')),
      channels: [...channels].sort(), sizes: [...sizes].sort(),
      capabilities: { channel: channels.size > 0, size: sizes.size > 0 },
      sourceUpdatedAt: payload.stores.flatMap(store => storedSalesFiles(store.id).map(file => file.record.savedAt).filter(Boolean)).sort().at(-1) || null
    };
  }

  function enrichedDemandOrders(payload) {
    const effectiveCatalog = latestMasterFile('master-catalog', payload.today);
    const productMap = new Map();
    let extras = new Map();
    if (effectiveCatalog) {
      try {
        for (const product of parseProductCatalog(effectiveCatalog.filePath)) {
          productMap.set(product.code.toUpperCase(), { listPrice: product.price });
        }
        extras = parseSalesAnalysisCatalog(effectiveCatalog.filePath).recipeExtras;
      } catch {}
    }
    const hierarchyByFile = new Map();
    const historicalCostByStore = new Map();
    const hierarchyFor = date => {
      const master = latestMasterFile('product-hierarchy', date);
      if (!master) return null;
      if (!hierarchyByFile.has(master.filePath)) {
        try { hierarchyByFile.set(master.filePath, parseProductHierarchies(master.filePath)); }
        catch { hierarchyByFile.set(master.filePath, null); }
      }
      return hierarchyByFile.get(master.filePath);
    };
    return payload.sourceOrders.map(rawOrder => {
      const order = reconcileOrderLineSales(rawOrder, productMap);
      const hierarchy = hierarchyFor(order.date);
      if (!historicalCostByStore.has(order.locationId)) {
        historicalCostByStore.set(order.locationId, buildHistoricalCostResolver(payload.today, [order.locationId]));
      }
      const costResolver = historicalCostByStore.get(order.locationId);
      let cost = 0;
      let costAvailable = true;
      const lines = order.lines.map(line => {
        const hierarchyNode = hierarchy?.hierarchyMap.get(line.hierarchyId);
        const categoryPath = hierarchyNode ? hierarchy.pathFor(hierarchyNode.id) :
          line.hierarchyName ? [line.hierarchyName] : [];
        const isExtra = Boolean(line.extraHierarchyId || extras.has(line.code));
        const reference = costResolver.resolve(order.date, line.code);
        const available = line.quantity <= 0 || reference.source !== 'missing';
        const lineCost = available ? line.quantity * (Number(reference.unitCost) || 0) : 0;
        cost += lineCost;
        if (!available) costAvailable = false;
        return { ...line, isExtra, categoryId: line.hierarchyId || '', categoryName: categoryPath.at(-1) || line.hierarchyName || 'Sin categoría',
          categoryPath, cost: lineCost, costAvailable: available, costSource: reference.source,
          costBasisEvidence: reference.costBasisEvidence || 'unverified' };
      });
      return { ...order, lines, cost, costAvailable };
    });
  }

  app.get('/api/demand-analysis/options', (req, res) => {
    try { return res.json(demandOptions(buildDemandSource(req.query))); }
    catch (error) { return res.status(error.status || 500).json({ error: error.message || 'No se pudieron cargar las opciones de demanda.' }); }
  });

  app.get('/api/demand-analysis', (req, res) => {
    try {
      const payload = buildDemandSource(req.query);
      const identity = demandOrdersWithIdentity(payload);
      const orders = identity.orders;
      const options = demandOptions(payload);
      const report = buildDemandAnalysis({ orders, stores: payload.stores, filters: payload.filters,
        today: payload.today, cutoff: businessClock().cutoff, capabilities: options.capabilities,
        linkageCoverage: identity.linkageCoverage });
      report.options = options;
      report.coverage.sourceFiles = payload.source.salesFilesRead;
      report.coverage.paymentFiles = payload.source.paymentFilesRead;
      report.coverage.warnings = payload.source.warnings;
      return res.json(report);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el análisis de la demanda.' });
    }
  });

  app.get('/api/demand-analysis/orders', (req, res) => {
    try {
      const payload = buildDemandSource(req.query);
      const detailedOrders = demandOrdersWithIdentity(payload).orders;
      const firstDate = payload.availablePeriod?.from || payload.today;
      const period = resolveDemandPeriod(payload.filters, payload.today, firstDate);
      const kind = String(req.query.kind || 'all');
      const key = String(req.query.key || '');
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const page = Math.max(1, Math.trunc(Number(req.query.page) || 1));
      const matchesEvidence = order => {
        if (kind === 'product') return order.lines.some(line => line.code === key);
        if (kind === 'category') return order.lines.some(line => line.hierarchyId?.startsWith(key));
        if (kind === 'pair') {
          const codes = key.split('|');
          return codes.length === 2 && codes.every(code => order.lines.some(line => line.code === code));
        }
        if (kind === 'heatmap') {
          const [day, hour] = key.split('-').map(Number);
          return new Date(`${order.date}T12:00:00Z`).getUTCDay() === day && Number(order.time.slice(0, 2)) === hour;
        }
        if (kind === 'ticket') {
          const from = Number(key);
          return Number.isFinite(from) && order.netSales * 1.19 >= from && order.netSales * 1.19 < from + payload.filters.priceBand;
        }
        if (kind === 'product-price') {
          const from = Number(key);
          return Number.isFinite(from) && order.lines.some(line => line.quantity > 0 &&
            !line.isExtra && Number(line.netSales) * 1.19 / line.quantity >= from &&
            Number(line.netSales) * 1.19 / line.quantity < from + payload.filters.priceBand);
        }
        if (kind === 'name-segment') return order.nameGenderSegment === key;
        if (kind === 'recurrence') return order.recurrenceGroup === key;
        if (kind === 'occasion') {
          const [from, to] = key.split('-').map(Number);
          return Number.isFinite(from) && Number.isFinite(to) && order.hour >= from && order.hour < to;
        }
        if (kind === 'day') return order.date === key;
        if (kind === 'week') return order.date >= key && order.date <= addDays(key, 6);
        if (kind === 'month') return order.date.slice(0, 7) === key;
        if (kind === 'location') return order.locationId === key;
        return kind === 'all';
      };
      const filtered = detailedOrders.filter(order => order.date >= period.from && order.date <= period.to
        && !order.reversalSignals.length && orderMatches(order, payload.filters) && matchesEvidence(order))
        .sort((left, right) => right.dateTime.localeCompare(left.dateTime) || right.orderKey.localeCompare(left.orderKey));
      return res.json({ period, kind, key, total: filtered.length, page, limit,
        orders: filtered.slice((page - 1) * limit, page * limit).map(order => ({
          orderKey: order.orderKey, orderReference: order.orderReference,
          locationId: order.locationId, locationName: order.locationName,
          date: order.date, time: order.time, ticketGross: order.netSales * 1.19,
          netSales: order.netSales, discountGross: order.orderDiscount, cost: order.costAvailable ? order.cost : null,
          costAvailable: order.costAvailable, mode: order.mode, channel: order.channel || null,
          nameGenderSegment: order.nameGenderSegment, recurrenceGroup: order.recurrenceGroup,
          paymentLinkStatus: order.paymentLinkStatus,
          lines: order.lines.map(line => ({ code: line.code, name: line.name, quantity: line.quantity,
            paidGross: line.paidGross, netSales: line.netSales, cost: line.costAvailable ? line.cost : null,
            costSource: line.costSource, costBasisEvidence: line.costBasisEvidence,
            salesAllocation: line.salesAllocation || 'reported' }))
        })) });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo abrir el detalle de los pedidos.' });
    }
  });

  function buildAuditSourceDiagnostics(stores, transactions, dateFrom, dateTo) {
    const settlements = [];
    const warnings = [];
    const seen = new Set();
    const fileCoverage = {};
    for (const store of stores) {
      const coverage = {
        sales: storedSalesFiles(store.id).filter(file => storedFileIntersectsPeriod(file, { from: dateFrom, to: dateTo })).length,
        paymentDetails: storedTransactionFiles(store.id, 'payment-details')
          .filter(file => storedFileIntersectsPeriod(file, { from: dateFrom, to: dateTo })).length,
        mercadoPago: 0
      };
      fileCoverage[store.id] = coverage;
      for (const stored of storedTransactionFiles(store.id, 'mercadopago')
        .filter(file => storedFileIntersectsPeriod(file, { from: dateFrom, to: dateTo }))) {
        try {
          let validFile = false;
          for (const sheet of readGenericTransactionSheets(stored.filePath)) {
            const header = sheet.rows[0] || [];
            if (!header.some(name => normalizeHeader(name) === 'transaction_date')
              || !header.some(name => normalizeHeader(name) === 'transaction_amount')) continue;
            validFile = true;
            for (const values of sheet.rows.slice(1)) {
              const row = Object.fromEntries(header.map((name, index) => [String(name || `column-${index}`), values[index]]));
              if (String(rowValue(row, ['TRANSACTION_TYPE']) || '').trim().toUpperCase() !== 'SETTLEMENT') continue;
              const date = mercadoPagoDateTime(row)?.slice(0, 10);
              if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
              const sourceId = String(rowValue(row, ['SOURCE_ID']) ?? '').trim();
              const identity = `${store.id}:${sourceId || genericTransactionRowKey(values)}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
              const feeField = ['FEE_AMOUNT', 'MP_FEE', 'COMMISSION_AMOUNT', 'COMISION', 'COMISIÓN', 'FEE']
                .find(name => rowValue(row, [name]) !== null);
              settlements.push({
                locationId: store.id,
                date,
                amount: numericValue(rowValue(row, ['TRANSACTION_AMOUNT'])),
                fee: feeField ? numericValue(rowValue(row, [feeField])) : null
              });
            }
          }
          if (validFile) coverage.mercadoPago += 1;
          else warnings.push(`MercadoPago sin columnas de liquidación reconocidas: ${stored.record.originalName || stored.record.name} (${store.name}).`);
        } catch {
          warnings.push(`No se pudo leer MercadoPago: ${stored.record.originalName || stored.record.name} (${store.name}).`);
        }
      }
    }
    return { ...buildSourceDiagnostics({ stores, transactions, settlements, fileCoverage }), warnings };
  }

  app.get('/api/transactions/audit', (req, res) => {
    try {
      const requestedLocation = String(req.query.location || 'all');
      const dateTo = String(req.query.dateTo || projectionToday());
      const dateFrom = String(req.query.dateFrom || addDays(dateTo, -29));
      if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
        return res.status(400).json({ error: 'Selecciona un período válido para auditar las transacciones.' });
      }
      const finiteFilter = name => {
        const raw = String(req.query[name] ?? '').trim();
        if (!raw) return null;
        const value = numericValue(raw);
        if (value === null) {
          const error = new Error(`El filtro ${name} debe ser numérico.`);
          error.status = 400;
          throw error;
        }
        return value;
      };
      const minAmount = finiteFilter('minAmount');
      const maxAmount = finiteFilter('maxAmount');
      const minDiscount = finiteFilter('minDiscount');
      const maxDiscount = finiteFilter('maxDiscount');
      if ((minAmount !== null && maxAmount !== null && minAmount > maxAmount)
        || (minDiscount !== null && maxDiscount !== null && minDiscount > maxDiscount)) {
        return res.status(400).json({ error: 'El valor mínimo de un rango no puede superar su valor máximo.' });
      }

      const source = buildProductAnalyticsSource(requestedLocation, { from: dateFrom, to: dateTo });
      const catalogMaster = latestMasterFile('master-catalog', dateTo);
      const catalog = catalogMaster ? parseSalesAnalysisCatalog(catalogMaster.filePath) : null;
      const listPrices = new Map(catalog ? [
        ...catalog.products.values(),
        ...catalog.recipeExtras.values()
      ].map(item => [String(item.code).toUpperCase(), Number(item.listPrice) || 0]) : []);
      const auditCostResolvers = new Map();
      const allTransactions = source.orders.flatMap(order => {
        if (order.date < dateFrom || order.date > dateTo) return [];
        const reportedGross = Number(order.grossSales);
        const hasReportedGross = order.grossSales !== null && order.grossSales !== undefined && Number.isFinite(reportedGross);
        const signedDiscount = Number(order.orderDiscount) || 0;
        const fallbackAfterGross = Math.max(0, order.lines.reduce((total, line) => total + (Number(line.netSales) || 0), 0) * 1.19);
        const saleBeforeDiscount = hasReportedGross
          ? Math.max(0, signedDiscount > 0 ? reportedGross + signedDiscount : reportedGross)
          : fallbackAfterGross;
        const saleWithDiscount = hasReportedGross
          ? Math.max(0, signedDiscount < 0 ? reportedGross + signedDiscount : reportedGross)
          : fallbackAfterGross;
        const discountAmount = Math.max(0, saleBeforeDiscount - saleWithDiscount);
        const discountPercent = saleBeforeDiscount > 0 ? discountAmount / saleBeforeDiscount * 100 : 0;
        const netSale = saleWithDiscount / 1.19;
        const units = order.lines.reduce((total, line) => total + Math.max(0, Number(line.quantity) || 0), 0);
        const reconciled = reconcileOrderLineSales({ ...order, netSales: netSale }, new Map());
        if (!auditCostResolvers.has(order.locationId)) auditCostResolvers.set(order.locationId, buildHistoricalCostResolver(dateTo, [order.locationId]));
        const resolver = auditCostResolvers.get(order.locationId);
        let netCost = 0;
        let costAvailable = order.lines.length > 0;
        for (const line of order.lines) {
          const quantity = Number(line.quantity);
          const reference = resolver.resolve(order.date, line.code);
          if (!line.code || !Number.isFinite(quantity) || (quantity !== 0 && reference.source === 'missing')) costAvailable = false;
          else netCost += quantity * reference.unitCost;
        }
        const margin = costAvailable ? netSale - netCost : null;

        return [{
          id: order.orderKey,
          orderReference: order.orderReference || order.orderKey,
          locationId: order.locationId,
          locationName: order.locationName,
          date: order.date,
          time: order.time || order.dateTime?.slice(11, 16) || '00:00',
          saleBeforeDiscount: Math.round(saleBeforeDiscount),
          discountAmount: Math.round(discountAmount),
          discountPercent: Math.round(discountPercent * 10) / 10,
          saleWithDiscount: Math.round(saleWithDiscount),
          netSale: Math.round(netSale),
          netCost: costAvailable ? Math.round(netCost) : null,
          margin: margin === null ? null : Math.round(margin),
          marginPercent: margin !== null && netSale !== 0 ? margin / netSale * 100 : null,

          units: Math.round(units * 10) / 10,
          clients: order.clients,
          mode: order.mode,
          modeLabel: order.mode === 'takeaway' ? 'Para llevar' : order.mode === 'dineIn' ? 'Servir en el local' : 'Sin información',
          paymentDue: order.paymentDue,
          paymentTotal: order.paymentTotal,
          paymentTotalAmbiguous: order.paymentTotalAmbiguous,
          paymentDuePartial: order.paymentDuePartial,
          paymentMatched: order.paymentMatched,
          paymentAmountAmbiguous: order.paymentAmountAmbiguous,
          paymentFilesRead: order.paymentFilesRead,
          paymentComment: order.paymentComment,
          reversalSignals: order.reversalSignals,
          lines: reconciled.lines.map(line => ({
            code: line.code,
            name: line.name,
            type: line.extraHierarchyId ? 'Extra' : 'Producto',
            hierarchy: line.extraHierarchyName || line.hierarchyName || 'Sin jerarquía',
            quantity: Math.round((Number(line.quantity) || 0) * 10) / 10,
            listPrice: Math.round(Math.max(0,
              listPrices.get(String(line.code).toUpperCase())
                ?? ((Number(line.listGross) || 0) / Math.max(1, Number(line.quantity) || 1)))),
            reportedSale: line.paidGross === null ? null : Math.round(Number(line.paidGross) || 0),
            reportedDiscount: Math.round(Number(line.discountGross) || 0),
            netSale: Math.round(Number(line.netSales) || 0),
            grossSale: Math.round((Number(line.netSales) || 0) * 1.19),
            allocation: line.salesAllocation
          }))
        }];
      });
      const transactions = allTransactions.filter(transaction => (
        (minAmount === null || transaction.saleWithDiscount >= minAmount)
        && (maxAmount === null || transaction.saleWithDiscount <= maxAmount)
        && (minDiscount === null || transaction.discountPercent >= minDiscount)
        && (maxDiscount === null || transaction.discountPercent <= maxDiscount)
      ));
      const reconciliationCounts = { matched: 0, difference: 0, 'not-linked': 0, 'no-source': 0, ambiguous: 0, 'no-amount': 0, 'no-sale-amount': 0, 'review-reversal': 0 };
      for (const transaction of allTransactions) {
        transaction.paymentReconciliation = reconcilePaymentDetail({
          reversalReviewRequired: transaction.reversalSignals.length > 0,
          saleWithDiscount: transaction.saleWithDiscount,
          paymentTotal: transaction.paymentTotal,
          paymentTotalAmbiguous: transaction.paymentTotalAmbiguous,
          paymentDue: transaction.paymentDue,
          paymentMatched: transaction.paymentMatched,
          paymentAmountAmbiguous: transaction.paymentAmountAmbiguous,
          paymentFilesRead: transaction.paymentFilesRead
        });
      }
      for (const transaction of transactions) reconciliationCounts[transaction.paymentReconciliation.status] += 1;
      const summary = transactions.reduce((result, transaction) => {
        result.transactions += 1;
        result.saleBeforeDiscount += transaction.saleBeforeDiscount;
        result.discountAmount += transaction.discountAmount;
        result.saleWithDiscount += transaction.saleWithDiscount;
        result.netSale += transaction.netSale;
        result.units += transaction.units;
        return result;
      }, { transactions: 0, saleBeforeDiscount: 0, discountAmount: 0, saleWithDiscount: 0, netSale: 0, units: 0 });
      summary.discountPercent = summary.saleBeforeDiscount
        ? Math.round(summary.discountAmount / summary.saleBeforeDiscount * 1000) / 10
        : 0;
      summary.units = Math.round(summary.units * 10) / 10;
      summary.paymentReconciliation = reconciliationCounts;
      summary.paymentDuePartial = transactions.filter(transaction => transaction.paymentDuePartial).length;
      summary.reversalReviewRequired = transactions.filter(transaction => transaction.reversalSignals.length > 0).length;
      transactions.sort((left, right) => right.date.localeCompare(left.date) || right.time.localeCompare(left.time));
      return res.json({
        filters: { location: requestedLocation, dateFrom, dateTo, minAmount, maxAmount, minDiscount, maxDiscount },
        locations: source.stores.map(publicLocation),
        availablePeriod: source.orders.length
          ? { from: source.orders[0].date, to: source.orders.at(-1).date }
          : null,
        summary,
        transactions,
        sourceDiagnostics: buildAuditSourceDiagnostics(source.stores, allTransactions, dateFrom, dateTo),
        warnings: source.warnings,
        coverage: source.coverage
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudieron auditar las transacciones.' });
    }
  });

  app.get('/api/products', (req, res) => {
    try {
      const requestedLocation = String(req.query.location || 'all');
      return res.json(withPreviousProductPrices(buildProductsPayload(requestedLocation), requestedLocation));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir la vista de productos.' });
    }
  });

  function buildIngredientsPayload(query = {}) {
    const today = projectionToday();
    const dateTo = String(query.dateTo || today);
    const dateFrom = String(query.dateFrom || addDays(dateTo, -29));
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
      const error = new Error('Selecciona un período válido para analizar los ingredientes.');
      error.status = 400;
      throw error;
    }
    const allLocations = readLocations().locations.filter(location => location.status === 'active');
    const stores = allLocations.filter(location => location.type === 'store');
    const requestedLocation = String(query.location || 'all');
    const selectedLocation = requestedLocation === 'all'
      ? null
      : allLocations.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedLocation) {
      const error = new Error('Selecciona una ubicación válida.');
      error.status = 400;
      throw error;
    }
    const catalogMaster = latestMasterFile('master-catalog', dateTo);
    const recipeResolution = resolveRecipes(dateTo);
    const recipesMaster = recipeResolution.primary;
    if (!catalogMaster || !recipesMaster || !recipeResolution.recipes.size) {
      const error = new Error('Se requiere un maestro de ingredientes y un maestro de recetas vigentes para el período.');
      error.status = 404;
      throw error;
    }
    const ingredientCatalog = parseIngredientsCatalog(catalogMaster.filePath);
    const fullCatalog = parseIngredientCatalog(catalogMaster.filePath);
    const products = new Map(parseProductCatalog(catalogMaster.filePath).map(product => [product.code, product]));
    const recipes = recipeResolution.recipes;
    const usedBy = new Map();
    for (const [productCode, lines] of recipes) {
      for (const line of lines) {
        const yieldFactor = line.yieldRate > 0 ? line.yieldRate / 100 : 1;
        const canonical = canonicalConsumptionUnit(line.unit);
        const detail = {
          code: productCode,
          name: products.get(productCode)?.name || productCode,
          recipeQuantity: line.quantity,
          recipeUnit: line.unit,
          yieldRate: line.yieldRate,
          effectiveQuantity: line.quantity / yieldFactor * canonical.factor,
          effectiveUnit: canonical.unit
        };
        const key = line.ingredientId.toUpperCase();
        if (!usedBy.has(key)) usedBy.set(key, []);
        usedBy.get(key).push(detail);
      }
    }

    const usageByIngredient = new Map();
    const productQuantities = new Map();
    const selectedStores = selectedLocation?.type === 'store' ? [selectedLocation] : selectedLocation ? [] : stores;
    const costResolver = buildCostResolver(
      dateTo,
      selectedLocation ? [selectedLocation.id] : stores.map(location => location.id)
    );
    if (selectedStores.length) {
      const seenRows = new Set();
      for (const location of selectedStores) {
        for (const stored of storedSalesFiles(location.id)) {
          for (const row of readSalesRows(stored.filePath)) {
            const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
            if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right)))).digest('hex')}`;
            if (seenRows.has(rowKey)) continue;
            seenRows.add(rowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim();
            const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
            if (code && quantity) productQuantities.set(code, (productQuantities.get(code) || 0) + quantity);
          }
        }
      }
      const consumption = buildIngredientConsumption(
        [...productQuantities].map(([code, quantity]) => ({ code, name: products.get(code)?.name || code, quantity })),
        recipes,
        fullCatalog,
        costResolver
      );
      for (const item of consumption.items) {
        const key = item.code.toUpperCase();
        const current = usageByIngredient.get(key) || { quantity: 0, totalCost: 0, unit: item.unit };
        const converted = convertQuantityUnit(item.quantity, item.unit, current.unit);
        current.quantity += converted ?? item.quantity;
        current.totalCost += item.totalCost;
        usageByIngredient.set(key, current);
      }
    } else if (selectedLocation?.type === 'warehouse') {
      const parsed = mergedKardexData(selectedLocation.id, 'kardex');
      const groups = parsed.groups.filter(group => group.date >= dateFrom && group.date <= dateTo);
      const matcher = metric => metric.startsWith('uso -') || metric.startsWith('trl-out -')
        || metric.startsWith('mov-out -') || metric.startsWith('trn-out -');
      for (const product of parsed.products) {
        const key = String(product.code || '').toUpperCase();
        if (!ingredientCatalog.has(key)) continue;
        const rawQuantity = groups.reduce((sum, group) => sum + kardexMetricTotal(product, group, matcher), 0);
        const catalogItem = ingredientCatalog.get(key);
        const canonical = canonicalConsumptionUnit(product.unit || catalogItem.unit);
        const quantity = rawQuantity * canonical.factor;
        const costReference = costResolver.resolve(key, canonical.unit, catalogItem);
        usageByIngredient.set(key, {
          quantity,
          unit: canonical.unit,
          totalCost: quantity * costReference.unitCost,
          costSource: costReference.source,
          costSourceDate: costReference.sourceDate
        });
      }
    }

    let purchaseRows = [];
    try { purchaseRows = buildPurchasesPayload({ location: requestedLocation, supplier: 'all' }).rows; } catch { purchaseRows = []; }
    const purchasesByIngredient = new Map();
    for (const row of purchaseRows) {
      const key = String(row.code || '').toUpperCase();
      if (!ingredientCatalog.has(key)) continue;
      if (!purchasesByIngredient.has(key)) purchasesByIngredient.set(key, []);
      purchasesByIngredient.get(key).push(row);
    }
    const items = [...ingredientCatalog].map(([key, ingredient]) => {
      const history = (purchasesByIngredient.get(key) || [])
        .filter(row => row.date <= dateTo)
        .sort((left, right) => left.date.localeCompare(right.date));
      const latest = history.at(-1) || null;
      const periodHistory = history.filter(row => row.date >= dateFrom && row.date <= dateTo);
      const purchaseCost = row => {
        const rawCost = row.baseUnitCost ?? row.effectiveUnitPrice;
        const sourceUnit = row.baseUnitCost != null ? row.baseUnit : row.unit;
        return unitCostForRecipeUnit({ unitCost: rawCost, unit: sourceUnit }, ingredient.unit);
      };
      const firstCost = periodHistory.length ? purchaseCost(periodHistory[0]) : null;
      const lastCost = periodHistory.length ? purchaseCost(periodHistory.at(-1)) : null;
      const usage = usageByIngredient.get(key) || { quantity: 0, unit: canonicalConsumptionUnit(ingredient.unit).unit, totalCost: 0 };
      const displayCostReference = costResolver.resolve(key, ingredient.unit, ingredient);
      const usageCostReference = costResolver.resolve(key, usage.unit, ingredient);
      const usageCost = usage.quantity * usageCostReference.unitCost;
      return {
        ...ingredient,
        masterUnitCost: ingredient.unitCost,
        unitCost: displayCostReference.unitCost,
        costSource: displayCostReference.source,
        costSourceDate: displayCostReference.sourceDate,
        supplierKey: latest?.supplierKey || 'unassigned',
        supplier: displayCostReference.supplier || latest?.supplier || 'Proveedor no identificado',
        latestPurchaseDate: displayCostReference.source === 'purchase' ? displayCostReference.sourceDate : null,
        latestPurchaseCost: displayCostReference.source === 'purchase' ? displayCostReference.unitCost : null,
        firstPeriodCost: firstCost,
        lastPeriodCost: lastCost,
        previousPurchaseCost: displayCostReference.previousPurchaseCost ?? null,
        previousPurchaseDate: displayCostReference.previousPurchaseDate ?? null,
        costChangePercent: displayCostReference.source === 'purchase' && displayCostReference.previousPurchaseCost > 0
          ? ((displayCostReference.unitCost / displayCostReference.previousPurchaseCost) - 1) * 100 : null,
        purchaseCount: periodHistory.length,
        usageQuantity: usage.quantity,
        usageUnit: usage.unit,
        usageCost,
        usageCostSource: usageCostReference.source,
        usageCostSourceDate: usageCostReference.sourceDate,
        products: (usedBy.get(key) || []).map(product => ({
          ...product,
          periodProductQuantity: selectedStores.length ? productQuantities.get(product.code) || 0 : null,
          periodIngredientQuantity: selectedStores.length
            ? (productQuantities.get(product.code) || 0) * product.recipeQuantity
              / (product.yieldRate > 0 ? product.yieldRate / 100 : 1)
            : null,
          periodIngredientEffectiveQuantity: selectedStores.length
            ? (productQuantities.get(product.code) || 0) * product.effectiveQuantity
            : null,
          periodIngredientUnit: product.recipeUnit
        })).sort((left, right) => left.name.localeCompare(right.name, 'es'))
      };
    });
    const suppliers = [...new Map(items.map(item => [item.supplierKey, { key: item.supplierKey, name: item.supplier }])).values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'es'));
    return {
      date: today,
      period: { from: dateFrom, to: dateTo },
      scope: selectedLocation
        ? { location: selectedLocation.id, label: selectedLocation.name, type: selectedLocation.type }
        : { location: 'all', label: 'Todas las cafeterías', type: 'stores' },
      locations: allLocations.map(publicLocation),
      suppliers,
      items,
      summary: {
        ingredientCount: items.length,
        usedIngredientCount: items.filter(item => item.usageQuantity > 0).length,
        totalUsageCost: items.reduce((sum, item) => sum + item.usageCost, 0),
        changedCostCount: items.filter(item => item.costChangePercent !== null && Math.abs(item.costChangePercent) >= 0.01).length
      }
    };
  }

  app.get('/api/ingredients', (req, res) => {
    try {
      return res.json(buildIngredientsPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir la vista de ingredientes.' });
    }
  });

  function buildSalesByIngredientsPayload(query = {}) {
    const today = projectionToday();
    const dateTo = String(query.dateTo || today);
    const dateFrom = String(query.dateFrom || addDays(dateTo, -29));
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
      const error = new Error('Selecciona un período válido para analizar las ventas.');
      error.status = 400;
      throw error;
    }
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const requestedLocation = String(query.location || 'all');
    const selectedStore = requestedLocation === 'all' ? null : stores.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedStore) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    const catalogMaster = latestMasterFile('master-catalog', dateTo);
    const recipeResolution = resolveRecipes(dateTo);
    const recipesMaster = recipeResolution.primary;
    if (!catalogMaster || !recipesMaster || !recipeResolution.recipes.size) {
      const error = new Error('Se requiere el maestro de productos e ingredientes y el maestro de recetas vigentes para el período.');
      error.status = 404;
      throw error;
    }
    const ingredientHierarchyMaster = latestMasterFile('ingredient-hierarchy', dateTo);
    const extrasHierarchyMaster = latestMasterFile('extras-hierarchy', dateTo);
    const catalog = parseSalesAnalysisCatalog(catalogMaster.filePath);
    const costCatalog = parseIngredientCatalog(catalogMaster.filePath);
    const recipes = recipeResolution.recipes;
    const recipesByProduct = new Map([...recipes].map(([code, lines]) => [code.toUpperCase(), lines]));
    const ingredientHierarchies = ingredientHierarchyMaster
      ? parseNamedHierarchies(ingredientHierarchyMaster.filePath, ['Nombre Jerarquía *', 'Nombre Jerarquia *', 'Nombre Jerarquía Producto *'])
      : null;
    const extrasHierarchies = extrasHierarchyMaster
      ? parseNamedHierarchies(extrasHierarchyMaster.filePath, ['Nombre Jerarquía Producto *', 'Nombre Jerarquia Producto *', 'Nombre Jerarquía *'])
      : null;

    const ingredientOptions = [...catalog.ingredients.values()].map(item => {
      const hierarchyId = item.hierarchyIds[0] || 'unassigned';
      const hierarchyPath = ingredientHierarchies?.pathFor(hierarchyId) || ['Sin jerarquía'];
      return { key: `ingredient:${item.code}`, code: item.code, name: item.name, unit: item.unit, hierarchyId, hierarchyPath, source: 'ingredient' };
    });
    const recipeIngredientCodes = new Set([...recipes.values()].flat().map(line => line.ingredientId.toUpperCase()));
    ingredientOptions.push(...[...catalog.recipeExtras.values()]
      .filter(item => /^SUB/i.test(item.code) && recipeIngredientCodes.has(item.code.toUpperCase()))
      .map(item => {
        const rawHierarchyId = item.hierarchyIds[0] || 'unassigned';
        const extraPath = extrasHierarchies?.pathFor(rawHierarchyId) || ['Sin jerarquía'];
        return {
          key: `ingredient:${item.code}`,
          code: item.code,
          name: item.name,
          unit: item.unit,
          hierarchyId: `recipe-extra:${rawHierarchyId}`,
          hierarchyPath: ['Extras con receta', ...extraPath],
          source: 'recipe-extra'
        };
      }));
    ingredientOptions.sort((left, right) => left.hierarchyPath.join('/').localeCompare(right.hierarchyPath.join('/'), 'es')
      || left.name.localeCompare(right.name, 'es'));
    const extraOptions = extrasHierarchies
      ? [...extrasHierarchies.hierarchyMap.values()]
        .filter(item => item.parentId)
        .map(item => ({ key: `extra:${item.id}`, id: item.id, name: item.name, hierarchyPath: extrasHierarchies.pathFor(item.id) }))
        .sort((left, right) => left.hierarchyPath.join('/').localeCompare(right.hierarchyPath.join('/'), 'es'))
      : [];

    const selectedKeys = [...new Set(String(query.selections || '').split(',').map(value => value.trim()).filter(Boolean))].slice(0, 50);
    const validOptions = new Map([...ingredientOptions, ...extraOptions].map(item => [item.key, item]));
    const selectedOptions = selectedKeys.map(key => validOptions.get(key)).filter(Boolean);
    const selectedStores = selectedStore ? [selectedStore] : stores;
    const costResolver = buildCostResolver(dateTo, selectedStores.map(location => location.id));
    const facts = [];
    const seenRows = new Set();
    let filesRead = 0;
    const warnings = [];
    for (const location of selectedStores) {
      for (const stored of storedSalesFiles(location.id)) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
            if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
            const canonicalRow = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
            if (seenRows.has(rowKey)) continue;
            seenRows.add(rowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto'])) || catalog.products.get(code.toUpperCase())?.name || code;
            const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
            const paidLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar']));
            const listLine = numericValue(rowValue(row, ['Precio Lista'])) || 0;
            const discount = numericValue(rowValue(row, ['Descuento'])) || 0;
            const grossLine = paidLine !== null ? paidLine : listLine + discount;
            const catalogItem = costCatalog.get(code.toUpperCase());
            const costReference = costResolver.resolve(code, catalogItem?.unit, catalogItem);
            const totalCost = quantity * costReference.unitCost;
            if (code || name) facts.push({
              locationId: location.id,
              code,
              name,
              quantity,
              netSales: grossLine / 1.19,
              totalCost,
              unitCost: costReference.unitCost,
              costSource: costReference.source,
              costSourceDate: costReference.sourceDate,
              costAvailable: costReference.source !== 'missing'
            });
          }
          filesRead += 1;
        } catch {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    const productsSold = new Map();
    for (const fact of facts) {
      const key = fact.code.toUpperCase() || normalizeHeader(fact.name);
      const current = productsSold.get(key) || {
        code: fact.code, name: fact.name, quantity: 0, netSales: 0, totalCost: 0, costAvailable: true
      };
      current.quantity += fact.quantity;
      current.netSales += fact.netSales;
      current.totalCost += fact.totalCost;
      current.costAvailable = current.costAvailable && fact.costAvailable;
      productsSold.set(key, current);
    }
    const matchedProductKeys = new Set();
    const groups = selectedOptions.map(option => {
      const isIngredient = option.key.startsWith('ingredient:');
      const products = [];
      let ingredientQuantity = 0;
      let ingredientUnit = isIngredient ? canonicalConsumptionUnit(option.unit).unit || option.unit : null;
      for (const [productKey, sold] of productsSold) {
        if (isIngredient) {
          const matchingLines = (recipesByProduct.get(productKey) || [])
            .filter(line => line.ingredientId.toUpperCase() === option.code.toUpperCase());
          if (!matchingLines.length) continue;
          let required = 0;
          let compatible = true;
          for (const line of matchingLines) {
            const yieldFactor = line.yieldRate > 0 ? line.yieldRate / 100 : 1;
            const canonical = canonicalConsumptionUnit(line.unit);
            const lineQuantity = line.quantity / yieldFactor * canonical.factor * sold.quantity;
            const converted = convertQuantityUnit(lineQuantity, canonical.unit, ingredientUnit);
            if (converted === null) compatible = false;
            else required += converted;
          }
          if (!compatible) ingredientUnit = 'Varias';
          ingredientQuantity += required;
          products.push({ ...sold, ingredientQuantity: compatible ? required : null, ingredientUnit });
        } else {
          const descendants = extrasHierarchies.descendantIds(option.id);
          const product = catalog.products.get(productKey);
          if (!product?.hierarchyIds.some(id => descendants.has(id))) continue;
          products.push({ ...sold, ingredientQuantity: null, ingredientUnit: null });
        }
        matchedProductKeys.add(productKey);
      }
      products.sort((left, right) => right.quantity - left.quantity || right.netSales - left.netSales);
      const productUnits = products.reduce((sum, item) => sum + item.quantity, 0);
      const netSales = products.reduce((sum, item) => sum + item.netSales, 0);
      const totalCost = products.reduce((sum, item) => sum + item.totalCost, 0);
      const costAvailable = products.every(item => item.costAvailable);
      return {
        ...option,
        type: isIngredient ? 'ingredient' : 'extra',
        products,
        totals: {
          productUnits,
          ingredientQuantity: isIngredient ? ingredientQuantity : null,
          ingredientUnit,
          netSales,
          totalCost,
          costAvailable,
          contributionMarginPercent: costAvailable && netSales ? (netSales - totalCost) / netSales * 100 : null
        },
        shareOfPeriodSales: facts.reduce((sum, fact) => sum + fact.netSales, 0) ? netSales / facts.reduce((sum, fact) => sum + fact.netSales, 0) * 100 : 0
      };
    });
    const uniqueProducts = [...matchedProductKeys].map(key => productsSold.get(key)).filter(Boolean);
    const periodNetSales = facts.reduce((sum, fact) => sum + fact.netSales, 0);
    const uniqueNetSales = uniqueProducts.reduce((sum, item) => sum + item.netSales, 0);
    const uniqueTotalCost = uniqueProducts.reduce((sum, item) => sum + item.totalCost, 0);
    const uniqueCostAvailable = uniqueProducts.every(item => item.costAvailable);
    return {
      date: today,
      period: { from: dateFrom, to: dateTo },
      scope: selectedStore
        ? { location: selectedStore.id, label: selectedStore.name }
        : { location: 'all', label: 'Todas las cafeterías' },
      locations: stores.map(publicLocation),
      options: {
        ingredients: ingredientOptions,
        extras: extraOptions,
        ingredientHierarchiesAvailable: Boolean(ingredientHierarchyMaster),
        extrasHierarchiesAvailable: Boolean(extrasHierarchyMaster)
      },
      selections: selectedOptions.map(item => item.key),
      groups,
      totals: {
        selectedGroups: groups.length,
        uniqueProducts: uniqueProducts.length,
        productUnits: uniqueProducts.reduce((sum, item) => sum + item.quantity, 0),
        netSales: uniqueNetSales,
        totalCost: uniqueTotalCost,
        costAvailable: uniqueCostAvailable,
        contributionMarginPercent: uniqueCostAvailable && uniqueNetSales
          ? (uniqueNetSales - uniqueTotalCost) / uniqueNetSales * 100
          : null,
        periodNetSales,
        shareOfPeriodSales: periodNetSales ? uniqueNetSales / periodNetSales * 100 : 0
      },
      filesRead,
      warnings
    };
  }

  app.get('/api/sales-by-ingredients', (req, res) => {
    try {
      return res.json(buildSalesByIngredientsPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el reporte de ventas por ingredientes.' });
    }
  });

  function financialLineMetric(items) {
    const netSales = items.reduce((sum, item) => sum + (Number(item.netSales) || 0), 0);
    const totalCost = items.reduce((sum, item) => sum + (Number(item.totalCost) || 0), 0);
    const costAvailable = items.every(item => item.costAvailable !== false);
    return {
      netSales,
      totalCost: costAvailable ? totalCost : null,
      contributionMargin: costAvailable ? netSales - totalCost : null,
      marginPercent: costAvailable && netSales ? (netSales - totalCost) / netSales * 100 : null,
      salesSharePercent: 0,
      costAvailable
    };
  }

  function financialGroupedMetrics(items, key, labels) {
    const totalSales = items.reduce((sum, item) => sum + (Number(item.netSales) || 0), 0);
    return Object.entries(labels).map(([value, label]) => {
      const metric = financialLineMetric(items.filter(item => item[key] === value));
      metric.salesSharePercent = totalSales ? metric.netSales / totalSales * 100 : 0;
      return { key: value, label, ...metric };
    });
  }

  function financialInventoryForLocation(location,dateFrom,dateTo,ingredientCatalog,recipes) {
    const result=automaticFinancialInventoryForLocation(location,dateFrom,dateTo,ingredientCatalog,recipes);
    const override=require('./inventory-monthly-override').monthlyInventoryOverride(readGeneralExpenses().records,location.id,dateFrom,dateTo,
      (from,to)=>automaticFinancialInventoryForLocation(location,from,to,ingredientCatalog,recipes).inventoryDifference);
    if(override) {
      result.inventoryDifference=override;
      result.warnings=result.warnings.filter(message=>!message.startsWith('Diferencia de inventario no disponible'));
      if(!override.available)result.warnings.push(`Diferencia de inventario: faltan meses con monto manual o cálculo automático disponible en ${location.name}.`);
    }
    return result;
  }

  function automaticFinancialInventoryForLocation(location, dateFrom, dateTo, ingredientCatalog, recipes) {
    const result = {
      location: publicLocation(location),
      marketing: { amount: 0, available: false },
      employees: { amount: 0, available: false },
      waste: { amount: 0, available: false },
      inventoryDifference: { amount: 0, available: false },
      warnings: []
    };
    let parsed;
    let kardexReadFailed = false;
    try {
      parsed = mergedKardexData(location.id, 'kardex');
    } catch (error) {
      kardexReadFailed = true;
      result.warnings.push(`No se pudo consolidar el Kardex de ${location.name}: ${error.message}.`);
    }
    if (!parsed && !kardexReadFailed) {
      result.warnings.push(`No hay Kardex disponible para ${location.name}.`);
    }
    const movementGroups = parsed?.groups.filter(group => group.date >= dateFrom && group.date <= dateTo) || [];
    const nextBalanceGroup = movementGroups.length
      ? parsed.groups.find(group => group.date > movementGroups.at(-1).date)
      : null;
    const balanceDate = nextBalanceGroup?.date || dateTo;
    let inventoryCatalog = ingredientCatalog;
    let inventoryCatalogAssignments = new Map();
    const inventoryCatalogMaster = latestMasterFile('master-catalog', balanceDate);
    if (inventoryCatalogMaster) {
      try {
        inventoryCatalog = parseIngredientCatalog(inventoryCatalogMaster.filePath);
        inventoryCatalogAssignments = parseInventoryHierarchyAssignments(inventoryCatalogMaster.filePath);
      } catch {}
    }
    const costResolver = buildCostResolver(balanceDate, [location.id]);
    const consumption = {};
    for (const [field, label] of [['marketing', 'Marketing'], ['employees', 'Colaboradores']]) {
      try {
        if (!chronologicalSources(location.id, field).length) throw new Error('no hay archivo cargado');
        const mergedProducts = mergedConsumptionProducts(location.id, field, dateFrom, dateTo);
        const products = applyCatalogProductCosts(
          mergedProducts,
          inventoryCatalog,
          costResolver
        );
        const ingredients = buildIngredientConsumption(products.products, recipes, inventoryCatalog, costResolver);
        consumption[field] = { available: true, products, ingredients };
        result[field] = { amount: products.totalCost, available: true };
      } catch (error) {
        consumption[field] = { available: false, error: error.message };
        result.warnings.push(`Consumo de ${label.toLowerCase()} no disponible para ${location.name}: ${error.message}.`);
      }
    }
    try {
      const wasteData = mergedKardexData(location.id, 'waste');
      if (!wasteData) throw new Error('no hay archivo cargado');
      const waste = buildWasteSummary(wasteData, dateFrom, dateTo, inventoryCatalog, costResolver);
      result.waste = { amount: waste.totalCost, available: true };
    } catch (error) {
      result.warnings.push(`Merma no disponible para ${location.name}: ${error.message}.`);
    }
    if(synchronizedOnly) {
      try {
        const state=synchronizedStock(location.id);
        const cost=buildInventoryPurchaseCostResolver(dateTo,location,state,{catalog:inventoryCatalog,recipes});
        const correction=inventoryCorrection(location,state,recipes,inventoryCatalog,inventoryCatalogAssignments,cost,true);
        const report=require('./inventory-boundaries').countBoundaryReport(state,location,dateFrom,addDays(dateTo,1),correction);
        if(report.excluded.length || report.items.some(item=>!item.finalIsPhysical)) throw Error('No hay toma física final completa al inicio del día siguiente al cierre; no se calcula una pérdida usando saldos teóricos como conteo físico.');
        let adjustedDifferenceValue=0;
        for(const item of report.items) {
          const reference=cost.resolve(item.code,item.unit,inventoryCatalog.get(item.code));
          if(reference.source==='missing')throw Error(`Sin costo verificable para ${item.code}.`);
          adjustedDifferenceValue+=(item.finalInventory-item.theoreticalFinal-correction(item.code,item.unit,dateFrom,dateTo))*reference.unitCost;
        }
        result.inventoryDifference={amount:-adjustedDifferenceValue,available:true,adjustedDifferenceValue,openingDate:dateFrom,closingDate:addDays(dateTo,1),closingBasis:'physical',source:'toteat-api'};
      } catch(error) { result.warnings.push(`Diferencia de inventario no disponible para ${location.name}: ${error.message}`); }
      return result;
    }
    try {
      if (!parsed) throw new Error('no hay Kardex disponible');
      if (!movementGroups.length) throw new Error('el Kardex no contiene movimientos dentro del período');
      const initialGroup = parsed.groups.filter(group => group.date <= movementGroups[0].date).at(-1) || movementGroups[0];
      const nextGroup = nextBalanceGroup;
      const finalGroup = nextGroup || movementGroups.at(-1);
      const selection = {
        initialDate: initialGroup.date,
        initialBasis: 'initial',
        finalDate: finalGroup.date,
        finalBasis: nextGroup ? 'initial' : 'final'
      };
      const usesInventoryReportBasis = movementGroups[0].date === dateFrom
        && movementGroups.at(-1).date === dateTo
        && Boolean(nextGroup);
      const report = enrichKardexReport(
        buildKardexInventoryReport(
          parsed,
          movementGroups[0].date,
          movementGroups.at(-1).date,
          usesInventoryReportBasis ? null : selection
        ),
        consumption,
        inventoryCatalog,
        costResolver
      );
      const salesData = periodSalesData(location.id, dateFrom, dateTo);
      const lac001Substitutions = lac001SubstitutionSummary(
        salesData,
        dateFrom,
        dateTo,
        recipes,
        inventoryCatalog,
        costResolver
      );
      const syrupSauceSubstitutions = syrupSauceSubstitutionSummary(
        salesData,
        dateFrom,
        dateTo,
        recipes,
        inventoryCatalog,
        inventoryCatalogAssignments,
        costResolver
      );
      const avoidedPackaging = inventoryAvoidedPackagingSummary(
        location,
        salesData,
        dateFrom,
        dateTo,
        recipes,
        inventoryCatalog,
        costResolver
      );
      const lac001SubstitutionCost = Number(lac001Substitutions.totalSubstitutedCost) || 0;
      const syrupSauceSubstitutionCost = Number(syrupSauceSubstitutions.totalSubstitutedCost) || 0;
      const avoidedPackagingCost = Number(avoidedPackaging.totalAvoidedPackagingCost) || 0;
      const totalAdjustmentCost = lac001SubstitutionCost + syrupSauceSubstitutionCost + avoidedPackagingCost;
      const adjustedDifferenceValue = report.totalCost - totalAdjustmentCost;
      result.inventoryDifference = {
        // The inventory report expresses physical minus theoretical. A shortage is
        // therefore negative there and becomes a positive expense in the P&L.
        // This is the same adjusted Kardex formula used by the inventory executive
        // summary: raw difference minus milk, syrup/sauce and packaging adjustments.
        amount: -adjustedDifferenceValue,
        available: true,
        rawDifferenceValue: report.totalCost,
        adjustedDifferenceValue,
        adjustments: {
          lac001SubstitutionCost,
          syrupSauceSubstitutionCost,
          avoidedPackagingCost,
          totalAdjustmentCost
        },
        openingDate: initialGroup.date,
        closingDate: finalGroup.date,
        closingBasis: selection.finalBasis
      };
      if (movementGroups[0].date !== dateFrom || movementGroups.at(-1).date !== dateTo) {
        result.warnings.push(`La diferencia de inventario de ${location.name} usa movimientos disponibles entre ${movementGroups[0].date} y ${movementGroups.at(-1).date}.`);
      }
      if (!nextGroup) {
        result.warnings.push(`La diferencia de inventario de ${location.name} usa el inventario final del ${finalGroup.date}; no existe un inventario inicial posterior al período.`);
      }
    } catch (error) {
      result.warnings.push(`Diferencia de inventario no disponible para ${location.name}: ${error.message}.`);
    }
    return result;
  }

  function mercadoPagoFeesForPeriod(stores, dateFrom, dateTo) {
    const vatFactor = 1.18;
    const facts = [];
    const seen = new Set();
    const fields = new Set();
    const locationsWithFiles = new Set();
    const locationsWithFee = new Set();
    const warnings = [];
    let filesRead = 0;
    for (const location of stores) {
      for (const stored of storedTransactionFiles(location.id, 'mercadopago')) {
        try {
          for (const sheet of readGenericTransactionSheets(stored.filePath)) {
            const header = sheet.rows[0] || [];
            for (const values of sheet.rows.slice(1)) {
              const row = Object.fromEntries(header.map((name, index) => [String(name || `column-${index}`), values[index]]));
              const transactionType = String(rowValue(row, ['TRANSACTION_TYPE']) || '').trim().toUpperCase();
              if (transactionType && transactionType !== 'SETTLEMENT') continue;
              const date = mercadoPagoDateTime(row)?.slice(0, 10);
              if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
              const sourceId = String(rowValue(row, ['SOURCE_ID']) ?? '').trim();
              const uniqueId = `${location.id}:${sourceId || genericTransactionRowKey(values)}`;
              if (seen.has(uniqueId)) continue;
              seen.add(uniqueId);
              const candidates = ['FEE_AMOUNT', 'MP_FEE', 'COMMISSION_AMOUNT', 'COMISION', 'COMISIÓN', 'FEE'];
              const field = candidates.find(name => rowValue(row, [name]) !== null);
              const fee = field ? numericValue(rowValue(row, [field])) : null;
              if (field) fields.add(field);
              if (fee !== null) locationsWithFee.add(location.id);
              facts.push({ locationId: location.id, fee: fee === null ? null : Math.abs(fee) });
            }
          }
          locationsWithFiles.add(location.id);
          filesRead += 1;
        } catch (error) {
          warnings.push(`No se pudo leer MercadoPago para ${location.name}: ${stored.record.originalName || stored.record.name}.`);
        }
      }
    }
    const withFee = facts.filter(item => item.fee !== null);
    const grossAmount = withFee.reduce((sum, item) => sum + item.fee, 0);
    const netAmount = grossAmount / vatFactor;
    if (facts.length && !withFee.length) warnings.push('Las transacciones MercadoPago del período no contienen una columna de comisión reconocida.');
    return {
      amount: netAmount,
      grossAmount,
      netAmount,
      vatFactor,
      available: withFee.length > 0,
      transactions: facts.length,
      transactionsWithFee: withFee.length,
      filesRead,
      locationsWithFiles: locationsWithFiles.size,
      locationsWithFee: locationsWithFee.size,
      detectedFields: [...fields],
      warnings
    };
  }

  function generalExpensesForPeriod(locations, dateFrom, dateTo) {
    const records = readGeneralExpenses().records;
    const recordMap = new Map(records.map(record => [`${record.locationId}:${record.month}`, record]));
    const months = [];
    let cursor = `${dateFrom.slice(0, 7)}-01`;
    while (cursor <= dateTo) {
      const month = cursor.slice(0, 7);
      const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
      const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
      const overlapFrom = dateFrom > cursor ? dateFrom : cursor;
      const overlapTo = dateTo < monthEnd ? dateTo : monthEnd;
      const coveredDays = Math.round((new Date(`${overlapTo}T00:00:00Z`) - new Date(`${overlapFrom}T00:00:00Z`)) / 86400000) + 1;
      months.push({ month, daysInMonth, coveredDays, factor: coveredDays / daysInMonth });
      const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
      cursor = next.toISOString().slice(0, 10);
    }
    const expectedRecords = locations.length * months.length;
    return GENERAL_EXPENSE_CATEGORIES.filter(([key])=>key!=='inventoryDifference').map(([key, label]) => {
      let amount = 0;
      let configuredRecords = 0;
      const detail = [];
      for (const location of locations) {
        for (const month of months) {
          const record = recordMap.get(`${location.id}:${month.month}`);
          if (record) configuredRecords += 1;
          const monthlyAmount = Number(record?.values?.[key]) || 0;
          const proratedAmount = monthlyAmount * month.factor;
          amount += proratedAmount;
          detail.push({
            locationId: location.id, locationName: location.name, month: month.month,
            monthlyAmount, coveredDays: month.coveredDays, daysInMonth: month.daysInMonth,
            amount: proratedAmount, configured: Boolean(record)
          });
        }
      }
      return {
        key: `general:${key}`, categoryKey: key, label, amount,
        available: configuredRecords > 0,
        complete: expectedRecords > 0 && configuredRecords === expectedRecords,
        coveredLocations: new Set(detail.filter(item => item.configured).map(item => item.locationId)).size,
        totalLocations: locations.length,
        configuredRecords, expectedRecords, basis: 'monthly-prorated', detail
      };
    });
  }

  function buildFinancialResultsPayload(query = {}) {
    const today = projectionToday();
    const dateTo = String(query.dateTo || today);
    const dateFrom = String(query.dateFrom || addDays(dateTo, -29));
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo
      || (new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000 > 366) {
      const error = new Error('Selecciona un período válido de hasta 367 días.');
      error.status = 400;
      throw error;
    }
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const requestedLocation = String(query.location || 'all');
    const selectedStore = requestedLocation === 'all' ? null : stores.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedStore) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    const selectedStores = selectedStore ? [selectedStore] : stores;
    const costValuation = query.costValuation === 'historical' ? 'historical' : 'period-end';
    const warnings = [];
    const catalogMaster = latestMasterFile('master-catalog', dateTo);
    const productHierarchyMaster = latestMasterFile('product-hierarchy', dateTo);
    const extrasHierarchyMaster = latestMasterFile('extras-hierarchy', dateTo);
    const recipeResolution = resolveRecipes(dateTo);
    const recipes = new Map([...recipeResolution.recipes].map(([code, lines]) => [String(code).toUpperCase(), lines]));
    let analysisCatalog = { products: new Map(), ingredients: new Map(), recipeExtras: new Map() };
    let costCatalog = new Map();
    let hierarchyLookup = null;
    let extrasLookup = null;
    if (catalogMaster) {
      try {
        analysisCatalog = parseSalesAnalysisCatalog(catalogMaster.filePath);
        costCatalog = parseIngredientCatalog(catalogMaster.filePath);
      } catch (error) {
        warnings.push(`No se pudo leer el catálogo maestro: ${error.message}.`);
      }
    } else warnings.push('No hay un catálogo maestro vigente para clasificar barras y costos.');
    if (productHierarchyMaster) {
      try { hierarchyLookup = parseProductHierarchies(productHierarchyMaster.filePath); }
      catch (error) { warnings.push(`No se pudo leer la jerarquía de productos: ${error.message}.`); }
    }
    if (extrasHierarchyMaster) {
      try { extrasLookup = parseNamedHierarchies(extrasHierarchyMaster.filePath, ['Nombre Jerarquía Producto *', 'Nombre Jerarquia Producto *', 'Nombre Jerarquía *']); }
      catch (error) { warnings.push(`No se pudo leer la jerarquía de extras: ${error.message}.`); }
    }
    if (!recipes.size) warnings.push('No hay recetas vigentes; la clasificación Café / Matcha / Otros quedará incompleta.');

    const hotIds = extrasLookup?.descendantIds('BA.001') || new Set(['BA.001']);
    const coldIds = extrasLookup?.descendantIds('BA.002') || new Set(['BA.002']);
    const periodEndCostResolver = costValuation === 'period-end'
      ? buildCostResolver(dateTo, selectedStores.map(location => location.id)) : null;
    const historicalCostResolvers = costValuation === 'historical'
      ? new Map(selectedStores.map(location => [location.id, buildHistoricalCostResolver(dateTo, [location.id])])) : null;
    const facts = [];
    const seenRows = new Set();
    let salesFilesRead = 0;
    const orderTargets = new Map();
    for (const location of selectedStores) {
      for (const stored of storedSalesFiles(location.id)) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
            if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
            const canonicalRow = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
            if (seenRows.has(rowKey)) continue;
            seenRows.add(rowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto'])) || code;
            if (!code && !name) continue;
            const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
            const paidLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar']));
            const listLine = numericValue(rowValue(row, ['Precio Lista'])) || 0;
            const discount = numericValue(rowValue(row, ['Descuento'])) || 0;
            const grossLine = paidLine !== null ? paidLine : listLine + discount;
            const orderKey = `${location.id}:${salesTransactionKey(row)}`;
            if (!orderTargets.has(orderKey)) {
              const orderGross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
              if (orderGross !== null) {
                const orderDiscounts = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
                orderTargets.set(orderKey, (orderGross + orderDiscounts) / 1.19);
              }
            }
            const catalogItem = costCatalog.get(code);
            const costReference = costValuation === 'historical'
              ? historicalCostResolvers.get(location.id).resolve(date, code)
              : periodEndCostResolver.resolve(code, catalogItem?.unit, catalogItem);
            const reportedCost = numericValue(rowValue(row, ['Costo']));
            const usesResolvedCost = costReference.source !== 'missing';
            const usesSalesExportCost = !usesResolvedCost && reportedCost !== null
              && (costValuation === 'period-end' || reportedCost > 0);
            const totalCost = usesResolvedCost ? quantity * costReference.unitCost
              : usesSalesExportCost ? reportedCost : null;
            const hierarchyId = String(rowValue(row, ['AB.']) ?? '').trim();
            const hierarchyPath = hierarchyLookup?.pathFor(hierarchyId) || [];
            const fallbackHierarchy = repairMojibake(rowValue(row, ['Categorías de Productos/Platos', 'Categorias de Productos/Platos'])) || 'Sin jerarquía';
            const product = analysisCatalog.products.get(code);
            const barIds = product?.hierarchyIds || [];
            const classifiedBar = require('./sales-insight-filters').classifySalesBar({
              hierarchyIds: barIds, hierarchyPath: hierarchyPath.length ? hierarchyPath : [fallbackHierarchy],
              name: product?.name || name
            }, hotIds, coldIds);
            const recipeCodes = new Set((recipes.get(code) || []).map(line => String(line.ingredientId || '').toUpperCase()));
            const ingredientType = recipeCodes.has('CAF008') ? 'matcha' : recipeCodes.has('SUB005') ? 'coffee' : 'other';
            facts.push({
              locationId: location.id,
              locationName: location.name,
              date,
              orderKey,
              code,
              name,
              quantity,
              netSales: grossLine / 1.19,
              listGross: listLine,
              totalCost: totalCost ?? 0,
              costAvailable: totalCost !== null,
              costBasisEvidence: usesResolvedCost ? costReference.costBasisEvidence || 'unverified' : 'unverified',
              costSource: usesResolvedCost ? costReference.source : usesSalesExportCost ? 'sales-export' : 'missing',
              costSourceDate: usesResolvedCost ? costReference.sourceDate : usesSalesExportCost ? date : null,
              costMissingReason: totalCost === null ? costReference.reason || 'no-positive-convertible-cost' : null,
              missingComponent: totalCost === null ? costReference.missingComponent || null : null,
              hierarchy: hierarchyPath.length ? hierarchyPath.join(' / ') : fallbackHierarchy,
              hierarchyPath: hierarchyPath.length ? hierarchyPath : [fallbackHierarchy],
              barType: classifiedBar === 'other' ? 'none' : classifiedBar,
              ingredientType,
              extraHierarchyId: String(rowValue(row, ['BA.']) ?? '').trim()
            });
          }
          salesFilesRead += 1;
        } catch (error) {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}): ${error.message}.`);
        }
      }
    }
    // Attribute extras to their base product so their revenue follows the same
    // product hierarchy, bar and main-ingredient classification.
    const factsByOrder = new Map();
    facts.forEach(fact => {
      const rows = factsByOrder.get(fact.orderKey) || [];
      rows.push(fact);
      factsByOrder.set(fact.orderKey, rows);
    });
    for (const [orderKey, orderFacts] of factsByOrder) {
      if (!orderTargets.has(orderKey)) continue;
      const reconciled = reconcileOrderLineSales({
        orderKey,
        netSales: orderTargets.get(orderKey),
        lines: orderFacts
      }, analysisCatalog.products);
      reconciled.lines.forEach((line, index) => {
        orderFacts[index].netSales = line.netSales;
        orderFacts[index].salesAllocation = line.salesAllocation;
      });
    }
    for (const orderFacts of factsByOrder.values()) {
      const bases = orderFacts.filter(fact => !fact.extraHierarchyId && !fact.code.startsWith('BX'));
      const soleBase = bases.length === 1 ? bases[0] : null;
      let currentBase = null;
      for (const fact of orderFacts) {
        if (bases.includes(fact)) currentBase = fact;
        else if (fact.extraHierarchyId || fact.code.startsWith('BX')) {
          const base = currentBase || soleBase;
          if (base) {
            fact.hierarchy = base.hierarchy;
            fact.hierarchyPath = base.hierarchyPath;
            fact.barType = base.barType;
            fact.ingredientType = base.ingredientType;
          }
        }
      }
    }
    const missingCostCodes = [...new Set(facts.filter(fact => !fact.costAvailable).map(fact => fact.code || fact.name))];
    const missingCostProducts = new Map();
    for (const fact of facts.filter(item => !item.costAvailable)) {
      const key = [fact.code, fact.costMissingReason, fact.missingComponent].join('|');
      const item = missingCostProducts.get(key) || {
        code: fact.code, name: fact.name, reason: fact.costMissingReason,
        missingComponent: fact.missingComponent, lines: 0, netSales: 0,
        firstDate: fact.date, lastDate: fact.date
      };
      item.lines += 1;
      item.netSales += fact.netSales;
      if (fact.date < item.firstDate) item.firstDate = fact.date;
      if (fact.date > item.lastDate) item.lastDate = fact.date;
      missingCostProducts.set(key, item);
    }
    if (missingCostCodes.length) {
      warnings.push(`${missingCostCodes.length} producto(s) vendido(s) no tienen costo disponible: ${missingCostCodes.slice(0, 12).join(', ')}${missingCostCodes.length > 12 ? ', …' : ''}.`);
    }
    const unverifiedCostLines = facts.filter(fact => fact.costAvailable && fact.costBasisEvidence !== 'net-field-consistent').length;
    if (unverifiedCostLines) {
      warnings.push(`${unverifiedCostLines} línea(s) con costo disponible usan maestro o una fuente sin cotejo con «Monto neto» de Compras. Sus márgenes son estimados; no se aplicó ninguna conversión de IVA automática.`);
    }

    const barLabels = { hot: 'Barra Caliente', cold: 'Barra Fría', none: 'Sin Barra' };
    const ingredientLabels = { coffee: 'Café (SUB005)', matcha: 'Matcha (CAF008)', other: 'Otros' };
    const totalRevenue = facts.reduce((sum, fact) => sum + fact.netSales, 0);
    const hierarchyGroups = new Map();
    facts.forEach(fact => {
      const group = hierarchyGroups.get(fact.hierarchy) || { label: fact.hierarchy, path: fact.hierarchyPath, facts: [] };
      group.facts.push(fact);
      hierarchyGroups.set(fact.hierarchy, group);
    });
    const hierarchies = [...hierarchyGroups.values()].map(group => {
      const metric = financialLineMetric(group.facts);
      metric.salesSharePercent = totalRevenue ? metric.netSales / totalRevenue * 100 : 0;
      return {
        label: group.label,
        path: group.path,
        ...metric,
        bars: financialGroupedMetrics(group.facts, 'barType', barLabels),
        ingredients: financialGroupedMetrics(group.facts, 'ingredientType', ingredientLabels)
      };
    }).sort((left, right) => right.netSales - left.netSales || left.label.localeCompare(right.label, 'es'));
    const revenueMetric = financialLineMetric(facts);
    revenueMetric.salesSharePercent = totalRevenue ? 100 : 0;
    const inventoryByLocation = selectedStores.map(location => financialInventoryForLocation(location, dateFrom, dateTo, costCatalog, recipes));
    inventoryByLocation.forEach(item => warnings.push(...item.warnings));
    const expenseFromInventory = (key, label) => {
      const entries = inventoryByLocation.map(item => ({ location: item.location, ...item[key] }));
      const availableEntries = entries.filter(item => item.available);
      return {
        key,
        label,
        amount: availableEntries.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
        available: availableEntries.length > 0,
        complete: availableEntries.length === selectedStores.length,
        coveredLocations: availableEntries.length,
        totalLocations: selectedStores.length,
        locations: entries
      };
    };
    const mercadoPago = mercadoPagoFeesForPeriod(selectedStores, dateFrom, dateTo);
    warnings.push(...mercadoPago.warnings);
    const generalExpenses = generalExpensesForPeriod(selectedStores, dateFrom, dateTo);
    const headOfficeExpenses = requestedLocation === 'all'
      ? generalExpensesForPeriod([HEAD_OFFICE_UNIT], dateFrom, dateTo)
      : [];
    const expenses = [
      expenseFromInventory('marketing', 'Consumo de Marketing'),
      expenseFromInventory('employees', 'Consumo de Colaboradores'),
      expenseFromInventory('waste', 'Merma'),
      expenseFromInventory('inventoryDifference', 'Diferencia de Inventario ajustada'),
      {
        key: 'mercadoPago', label: 'Cobros netos de MercadoPago', amount: mercadoPago.amount,
        available: mercadoPago.available, complete: mercadoPago.locationsWithFee === selectedStores.length,
        coveredLocations: mercadoPago.locationsWithFee,
        totalLocations: selectedStores.length,
        detail: mercadoPago
      },
      ...generalExpenses
    ];
    const knownExpenses = expenses.filter(item => item.available).reduce((sum, item) => sum + item.amount, 0);
    const contributionMargin = revenueMetric.contributionMargin;
    const dataCoverageComplete = salesFilesRead > 0 && revenueMetric.costAvailable && expenses.every(item => item.complete);
    const operationalResult4Wall = contributionMargin === null ? null : contributionMargin - knownExpenses;
    const headOfficeAvailable = requestedLocation === 'all' && headOfficeExpenses.some(item => item.available);
    const headOfficeComplete = requestedLocation === 'all' && headOfficeExpenses.length > 0
      && headOfficeExpenses.every(item => item.complete);
    const headOfficeAmount = headOfficeExpenses.filter(item => item.available)
      .reduce((sum, item) => sum + item.amount, 0);
    return {
      date: today,
      period: { from: dateFrom, to: dateTo },
      scope: selectedStore
        ? { location: selectedStore.id, label: selectedStore.name }
        : { location: 'all', label: 'Todas las cafeterías' },
      locations: stores.map(publicLocation),
      revenue: {
        total: revenueMetric,
        bars: financialGroupedMetrics(facts, 'barType', barLabels),
        ingredients: financialGroupedMetrics(facts, 'ingredientType', ingredientLabels),
        hierarchies,
        filesRead: salesFilesRead,
        lineCount: facts.length,
        linesWithCost: facts.filter(fact => fact.costAvailable).length,
        linesWithNetFieldConsistentCost: facts.filter(fact => fact.costAvailable && fact.costBasisEvidence === 'net-field-consistent').length,
        linesWithUnverifiedCost: unverifiedCostLines,
        costValuationDate: costValuation === 'historical' ? 'sale-date' : 'period-end',
        costSources: Object.fromEntries(['recipe', 'purchase', 'master', 'sales-export', 'missing']
          .map(source => [source, facts.filter(fact => fact.costSource === source).length])),
        missingCostProducts: [...missingCostProducts.values()].sort((left, right) =>
          right.netSales - left.netSales || left.code.localeCompare(right.code, 'es')),
        latestSaleDate: facts.map(fact => fact.date).sort().at(-1) || null
      },
      statement: {
        netSales: revenueMetric.netSales,
        productCost: revenueMetric.totalCost,
        contributionMargin,
        contributionMarginPercent: revenueMetric.marginPercent,
        expenses,
        knownOperatingExpenses: knownExpenses,
        partialResult: operationalResult4Wall,
        operationalResult4Wall,
        headOffice: requestedLocation === 'all' ? {
          label: 'Casa Matriz', amount: headOfficeAmount,
          available: headOfficeAvailable, complete: headOfficeComplete,
          configuredRecords: headOfficeExpenses[0]?.configuredRecords || 0,
          expectedRecords: headOfficeExpenses[0]?.expectedRecords || 0,
          expenses: headOfficeExpenses
        } : null,
        operationalResultWithHeadOffice: requestedLocation === 'all' && operationalResult4Wall !== null && headOfficeAvailable
          ? operationalResult4Wall - headOfficeAmount
          : null,
        partial: !dataCoverageComplete,
        dataCoverageComplete,
        generalExpenses: {
          configured: generalExpenses.every(item => item.complete),
          configuredRecords: generalExpenses[0]?.configuredRecords || 0,
          expectedRecords: generalExpenses[0]?.expectedRecords || 0
        },
        pendingExpenseCategories: dataCoverageComplete ? [] : ['Fuentes operacionales o gastos generales sin cobertura completa']
      },
      inventoryByLocation,
      warnings: [...new Set(warnings)]
    };
  }

  app.get('/api/financial-results', (req, res) => {
    try {
      return res.json(buildFinancialResultsPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el estado de resultados.' });
    }
  });

  app.get('/api/products/reports', (req, res) => {
    const requestedLocation = String(req.query.location || 'all');
    if (requestedLocation !== 'all') {
      const location = activeLocation(requestedLocation);
      if (!location || location.type !== 'store') return res.status(400).json({ error: 'Selecciona una cafetería válida.' });
    }
    return res.json({ reports: listProductSnapshots(requestedLocation) });
  });

  app.post('/api/products/reports', (req, res) => {
    try {
      const requestedLocation = String(req.body?.location || 'all');
      const report = buildProductsPayload(requestedLocation);
      const scopeKey = report.scope.location || 'all';
      const snapshotId = `${report.date}--${scopeKey}`;
      const filePath = productSnapshotPath(snapshotId);
      const existed = fs.existsSync(filePath);
      if (existed && req.body?.replace !== true) {
        return res.status(409).json({
          error: `Ya existe un reporte de ${report.scope.label} para ${report.date}.`,
          requiresReplacement: true,
          snapshotId
        });
      }
      const snapshot = { ...report, savedAt: new Date().toISOString() };
      writeJsonAtomic(filePath, snapshot);
      return res.status(existed ? 200 : 201).json(productSnapshotMetadata(snapshot, snapshotId));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo guardar el reporte de productos.' });
    }
  });

  app.get('/api/products/reports/compare', (req, res) => {
    try {
      const requestedLocation = String(req.query.location || 'all');
      const snapshotId = String(req.query.snapshot || '');
      const filePath = productSnapshotPath(snapshotId);
      if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'El reporte guardado no existe.' });
      const previous = readJson(filePath, null);
      if (!previous || (previous.scope.location || 'all') !== requestedLocation) {
        return res.status(400).json({ error: 'El reporte guardado corresponde a otro filtro de cafetería.' });
      }
      const current = buildProductsPayload(requestedLocation);
      const oldProducts = new Map(flattenProductReport(previous).map(product => [product.code, product]));
      const currentProducts = new Map(flattenProductReport(current).map(product => [product.code, product]));
      const codes = new Set([...oldProducts.keys(), ...currentProducts.keys()]);
      const changes = [];
      const counts = { added: 0, removed: 0, price: 0, cost: 0, margin: 0 };
      const changed = (left, right) => Math.abs((left || 0) - (right || 0)) > 0.005;
      for (const code of codes) {
        const before = oldProducts.get(code) || null;
        const after = currentProducts.get(code) || null;
        const status = !before ? 'added' : !after ? 'removed' : 'changed';
        const priceChanged = Boolean(before && after && changed(before.price, after.price));
        const costChanged = Boolean(before && after && changed(before.cost, after.cost));
        const marginChanged = Boolean(before && after && changed(before.marginPercent, after.marginPercent));
        if (status === 'changed' && !priceChanged && !costChanged && !marginChanged) continue;
        if (status === 'added') counts.added += 1;
        if (status === 'removed') counts.removed += 1;
        if (priceChanged) counts.price += 1;
        if (costChanged) counts.cost += 1;
        if (marginChanged) counts.margin += 1;
        changes.push({
          code,
          name: after?.name || before?.name || code,
          hierarchyPath: after?.hierarchyPath || before?.hierarchyPath || ['Sin jerarquía'],
          status,
          priceChanged,
          costChanged,
          marginChanged,
          before: before ? { price: before.price, netPrice: before.netPrice, cost: before.cost, marginPercent: before.marginPercent } : null,
          after: after ? { price: after.price, netPrice: after.netPrice, cost: after.cost, marginPercent: after.marginPercent } : null
        });
      }
      changes.sort((left, right) => left.name.localeCompare(right.name, 'es'));
      return res.json({
        previous: productSnapshotMetadata(previous, snapshotId),
        current: { date: current.date, scope: current.scope },
        counts,
        changeCount: changes.length,
        changes
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo comparar el reporte de productos.' });
    }
  });

  app.get('/api/inventory/synchronized-preview', (req,res)=>{
    try {
      const location=activeLocation(req.query.location);if(!location)throw Error('Ubicación inválida.');
      const state=synchronizedStock(location.id),waste=req.query.field==='waste';
      const warehouse=state.warehouses.find(w=>Number(w.custom_id)===(location.type==='warehouse'?(waste?4:1):(waste?3:2)));
      const columns=['date','code','name','unit','opening','purchase','use','transfer_local_in','transfer_local_out','transfer_warehouse_in','transfer_warehouse_out','transformed_in','transformed_out','closing','physicalCount'];
      const rows=state.daily.filter(r=>r.warehouse===warehouse?.id && (!req.query.dateFrom || r.date>=req.query.dateFrom) && (!req.query.dateTo || r.date<=req.query.dateTo)).map(r=>columns.map(k=>r[k]??''));
      res.json({originalName:waste?'Merma · Toteat API':'Inventario · Toteat API',sheets:[{name:'Registros diarios API',rows:[columns,...rows],totalRows:rows.length+1,frozenRows:1,truncated:false}]});
    }catch(error){res.status(422).json({error:error.message});}
  });
  app.get('/api/inventory/sources', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location) return res.status(400).json({ error: 'Select a valid active location.' });
    const definitions = [
      { field: 'kardex', label: 'Kardex / tarjeta de inventario', applicable: true },
      { field: 'waste', label: 'Merma', applicable: true },
      { field: 'marketing', label: 'Consumo de marketing', applicable: location.type === 'store' },
      { field: 'employees', label: 'Consumo de colaboradores', applicable: location.type === 'store' }
    ];
    try {
      const sources = definitions.map(definition => {
        const latest = latestWeeklyFile(location.id, definition.field);
        if (!latest) return { ...definition, available: false, file: null };
        const { filePath, ...publicFile } = latest;
        const stored = chronologicalSources(location.id, definition.field);
        const dataRange = latest.source==='toteat-api' ? latest.confirmedRange : combinedDateRange(stored.map(item => ({ detectedRange: item.record.confirmedRange || item.record.detectedRange })));
        return { ...definition, available: true, file: { ...publicFile, dataRange, dataThrough: dataRange?.to || publicFile.dataThrough, fileCount: stored.length } };
      });
      const kardex = latestWeeklyFile(location.id, 'kardex');
      let kardexPeriod = null;
      let kardexError = null;
      if (kardex) {
        try {
          const parsed = mergedKardexData(location.id, 'kardex');
          const dates = parsed.groups.map(group => group.date);
          kardexPeriod = {
            dates,
            firstDate: dates[0],
            penultimateDate: dates.at(-2),
            lastDate: dates.at(-1)
          };
        } catch (error) {
          kardexError = error.message;
        }
      }
      return res.json({
        location: publicLocation(location),
        sources,
        ready: sources.filter(source => source.applicable).every(source => source.available),
        kardexPeriod,
        kardexError
      });
    } catch (error) {
      return res.status(500).json({ error: 'Could not determine the inventory source files.' });
    }
  });

  app.get('/api/inventory/current', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación activa válida.' });
    const apiStock = stockSync.current(location.id);
    const publicInventory = apiStock?.sourceKind === 'public-inventory';
    const kardex = publicInventory ? {originalName:'Inventario API pública Toteat',source:'toteat-api'} : latestWeeklyFile(location.id, 'kardex');
    if (!kardex) return res.status(404).json({ error: 'No hay un archivo de Kardex disponible para esta ubicación.' });
    try {
      const today = projectionToday();
      const referenceDate = String(req.query.date || today);
      if (!isValidDate(referenceDate)) throw new Error('Selecciona una fecha de referencia válida.');
      if (referenceDate > today) throw new Error('La fecha de referencia no puede ser posterior a hoy.');
      const apiDate = publicInventory ? (referenceDate < apiStock.range.to ? referenceDate : apiStock.range.to) : null;
      const parsed = publicInventory ? require('./inventory-original-report').originalReportData(apiStock, location, {initialDate:apiDate,finalDate:apiDate,initialBasis:'initial',finalBasis:'final'}, apiDate, apiDate).parsed : mergedKardexData(location.id, 'kardex');
      const balanceDate = parsed.groups.filter(group => group.date <= referenceDate).at(-1)?.date;
      if (!balanceDate) throw new Error(`No hay un saldo de Kardex disponible al ${referenceDate} o en una fecha anterior.`);
      const warnings = publicInventory ? ['Saldos de API Toteat valorizados a última compra disponible al corte (respaldo: maestro de ingredientes/productos, luego costo API positivo o receta); esta vista muestra el saldo informado por Toteat. Las compensaciones e internos de Brewit se calculan en el informe consolidado.', ...apiStock.issues.filter(i=>i.kind==='api-balance-discrepancy').map(i=>`${i.code} ${i.date}: ${i.message}`)] : [];
      const catalogMaster = latestMasterFile('master-catalog', balanceDate, location.id);
      let catalog = null;
      let assignments = new Map();
      if (catalogMaster) {
        try {
          catalog = parseIngredientCatalog(catalogMaster.filePath);
          assignments = parseInventoryHierarchyAssignments(catalogMaster.filePath);
        } catch (error) {
          warnings.push(`Maestro de productos: ${error.message}`);
        }
      } else {
        warnings.push('No hay un maestro de productos, ingredientes y extras vigente para valorizar el inventario.');
      }
      const hierarchyLookups = {};
      const hierarchyDefinitions = [
        ['product', 'product-hierarchy', 'Jerarquía de productos', filePath => parseProductHierarchies(filePath)],
        ['ingredient', 'ingredient-hierarchy', 'Jerarquía de ingredientes', filePath => parseNamedHierarchies(filePath, ['Nombre Jerarquía *', 'Nombre Jerarquia *', 'Nombre Jerarquía Producto *'])],
        ['extra', 'extras-hierarchy', 'Jerarquía de extras', filePath => parseNamedHierarchies(filePath, ['Nombre Jerarquía Producto *', 'Nombre Jerarquia Producto *', 'Nombre Jerarquía *'])]
      ];
      const hierarchyMasters = {};
      hierarchyDefinitions.forEach(([type, field, label, parser]) => {
        const master = latestMasterFile(field, balanceDate, location.id);
        hierarchyMasters[field] = master;
        if (!master) return;
        try {
          hierarchyLookups[type] = parser(master.filePath);
        } catch (error) {
          warnings.push(`${label}: ${error.message}`);
        }
      });
      const publicMaster = record => record ? (({ filePath, ...value }) => value)(record) : null;
      const { filePath, ...source } = kardex;
      return res.json({
        location: publicLocation(location),
        source,
        masterSources: {
          catalog: publicMaster(catalogMaster),
          productHierarchy: publicMaster(hierarchyMasters['product-hierarchy']),
          ingredientHierarchy: publicMaster(hierarchyMasters['ingredient-hierarchy']),
          extrasHierarchy: publicMaster(hierarchyMasters['extras-hierarchy'])
        },
        warnings,
        referenceDate,
        report: buildCurrentTheoreticalInventoryReport(
          parsed,
          referenceDate,
          catalog,
          assignments,
          hierarchyLookups,
          publicInventory ? buildInventoryPurchaseCostResolver(balanceDate, location, apiStock, {catalog}) : buildCostResolver(balanceDate, [location.id])
        )
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'No se pudo obtener el inventario teórico al día.' });
    }
  });

  app.get('/api/inventory/waste-summary', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location || location.type !== 'store') {
      return res.status(400).json({ error: 'Selecciona una cafetería activa.' });
    }
    const waste = latestWeeklyFile(location.id, 'waste');
    if (!waste) return res.status(404).json({ error: 'No hay un archivo de Merma disponible para esta cafetería.' });
    try {
      const catalogMaster = latestMasterFile('master-catalog', req.query.dateTo, location.id);
      const catalog = catalogMaster ? parseIngredientCatalog(catalogMaster.filePath) : null;
      const report = buildWasteSummary(
        mergedKardexData(location.id, 'waste'),
        req.query.dateFrom,
        req.query.dateTo,
        catalog,
        buildCostResolver(req.query.dateTo, [location.id])
      );
      const { filePath, ...source } = waste;
      const masterSource = catalogMaster
        ? (({ filePath, ...record }) => record)(catalogMaster)
        : null;
      return res.json({ location: publicLocation(location), source, masterSource, report });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'No se pudo procesar el resumen de Merma.' });
    }
  });

  app.get('/api/inventory/consumption-summary', (req, res) => {
    const location = activeLocation(req.query.location);
    const field = String(req.query.field || '');
    const labels = { marketing: 'Consumo de marketing', employees: 'Consumo de colaboradores' };
    if (!location || location.type !== 'store') return res.status(400).json({ error: 'Selecciona una cafetería activa.' });
    if (!Object.hasOwn(labels, field)) return res.status(400).json({ error: 'Selecciona un tipo de consumo válido.' });
    const stored = latestWeeklyFile(location.id, field);
    if (!stored) return res.status(404).json({ error: `No hay un archivo de ${labels[field]} disponible.` });
    try {
      const recipeResolution = resolveRecipes(req.query.dateTo, location.id);
      const recipeMaster = recipeResolution.primary;
      const catalogMaster = latestMasterFile('master-catalog', req.query.dateTo, location.id);
      if (!recipeMaster || !recipeResolution.recipes.size) throw new Error('No hay un maestro de recetas disponible.');
      if (!catalogMaster) throw new Error('No hay un maestro de productos / ingredientes / extras vigente para la fecha final seleccionada.');
      const catalog = parseIngredientCatalog(catalogMaster.filePath);
      const costResolver = buildCostResolver(req.query.dateTo, [location.id]);
      const products = applyCatalogProductCosts(
        mergedConsumptionProducts(location.id, field, req.query.dateFrom, req.query.dateTo),
        catalog,
        costResolver
      );
      const ingredients = buildIngredientConsumption(products.products, recipeResolution.recipes, catalog, costResolver);
      const { filePath, ...source } = stored;
      return res.json({
        location: publicLocation(location),
        field,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        summary: { label: labels[field], available: true, source, products, ingredients }
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || `No se pudo procesar ${labels[field]}.` });
    }
  });

  app.get('/api/inventory/calendar', (req, res) => {
    try {
      const location=activeLocation(req.query.location);if(!location)throw Error('Selecciona una ubicación activa.');
      const originalMode=synchronizedOnly || req.query.source==='originals';
      const stock=stockSync.current(location.id);
      const warehouse=stock?.warehouses.find(w=>Number(w.custom_id)===(location.type==='warehouse'?1:2));
      const countDates=[...new Set((stock?.daily||[]).filter(r=>r.warehouse===warehouse?.id&&r.physicalCount).map(r=>r.date))].sort();
      const parsed=originalMode?null:mergedKardexData(location.id,'kardex');
      const range=originalMode?stock?.range:parsed?.groups.length?{from:parsed.groups[0].date,to:parsed.groups.at(-1).date}:null;
      if(!range)throw Error('Actualiza primero las fuentes de inventario.');
      res.json({countDates,from:range.from,to:require('./inventory-boundaries').advance(range.to,1)});
    }catch(error){res.status(400).json({error:error.message});}
  });

  app.post('/api/inventory/process', (req, res) => {
    const location = activeLocation(req.body?.location);
    if (!location) return res.status(400).json({ error: 'Select a valid active location.' });
    const originalMode = synchronizedOnly || req.body?.source === 'originals';
    if (req.body?.source && !['files', 'originals'].includes(req.body.source)) return res.status(400).json({ error: 'Fuente de inventario inválida.' });
    const kardex = originalMode ? { originalName: 'Fuentes originales Toteat', source: 'toteat-originals' } : latestWeeklyFile(location.id, 'kardex');
    if (!kardex) return res.status(404).json({ error: 'No Kardex file is available for this location.' });
    try {
      const boundaryMode=synchronizedOnly || req.body?.criteriaMode==='count-boundaries';
      const movementDateFrom = boundaryMode?req.body.initialInventoryDate:req.body?.movementDateFrom || req.body?.dateFrom;
      const movementDateTo = boundaryMode?require('./inventory-boundaries').advance(req.body.finalInventoryDate,-1):req.body?.movementDateTo || req.body?.dateTo;
      const hasCustomSelection = req.body?.initialInventoryDate || req.body?.finalInventoryDate;
      const selection = hasCustomSelection ? {
        initialDate: req.body?.initialInventoryDate,
        initialBasis: boundaryMode?'initial':req.body?.initialInventoryBasis,
        finalDate: req.body?.finalInventoryDate,
        finalBasis: boundaryMode?'initial':req.body?.finalInventoryBasis
      } : null;
      const stock = originalMode ? (synchronizedOnly ? synchronizedStock(location.id) : stockSync.rebuild(location.id)) : boundaryMode ? stockSync.current(location.id) : null;
      const original = originalMode ? (boundaryMode ? { parsed:null, excluded:[],physicalFinalItems:0 } : require('./inventory-original-report').originalReportData(stock, location, selection, movementDateFrom, movementDateTo)) : null;
      const parsed = originalMode ? original.parsed : mergedKardexData(location.id, 'kardex');
      const balanceDate = selection?.finalDate
        || parsed.groups.find(group => group.date > movementDateTo)?.date
        || movementDateTo;
      const recipeResolution = resolveRecipes(originalMode ? stock.masterObservedAt.slice(0,10) : balanceDate, location.id);
      const recipeMaster = recipeResolution.primary;
      const catalogMaster = latestMasterFile('master-catalog', originalMode ? stock.masterObservedAt.slice(0,10) : balanceDate, location.id);
      let recipes = null;
      let ingredientCatalog = null;
      let catalogAssignments = null;
      const masterErrors = [];
      try {
        if (!recipeMaster || !recipeResolution.recipes.size) throw new Error('No recipe master is available.');
        recipes = recipeResolution.recipes;
        masterErrors.push(...recipeResolution.errors);
      } catch (error) {
        masterErrors.push(error.message);
      }
      try {
        if (!catalogMaster) throw new Error('No product / ingredient / extras master is valid for the selected final date.');
        ingredientCatalog = parseIngredientCatalog(catalogMaster.filePath);
        catalogAssignments = parseInventoryHierarchyAssignments(catalogMaster.filePath);
      } catch (error) {
        masterErrors.push(error.message);
      }
      const masterError = masterErrors.join(' ');
      const costResolver = originalMode && stock.sourceKind === 'public-inventory'
        ? buildInventoryPurchaseCostResolver(balanceDate, location, stock, {catalog:ingredientCatalog,recipes})
        : buildCostResolver(balanceDate, [originalMode && location.type === 'warehouse' ? 'store-1' : location.id], originalMode ? { catalog: ingredientCatalog, recipes } : {});
      const consumption = {};
      for (const [field, label] of [['marketing', 'Consumo de marketing'], ['employees', 'Consumo de colaboradores']]) {
        const stored = latestWeeklyFile(location.id, field);
        if (!stored) {
          consumption[field] = { label, available: false, error: 'No hay un archivo disponible.' };
          continue;
        }
        try {
          const parsedProducts = mergedConsumptionProducts(location.id, field, movementDateFrom, movementDateTo);
          const products = ingredientCatalog ? applyCatalogProductCosts(parsedProducts, ingredientCatalog, costResolver) : parsedProducts;
          const ingredients = recipes && ingredientCatalog
            ? buildIngredientConsumption(products.products, recipes, ingredientCatalog, costResolver)
            : { items: [], totalCost: 0, productsWithoutRecipe: [], ingredientsWithoutCost: [], ingredientsWithoutConversion: [], error: masterError };
          const { filePath, ...publicSource } = stored;
          consumption[field] = { label, available: true, source: publicSource, products, ingredients };
        } catch (error) {
          const { filePath, ...publicSource } = stored;
          consumption[field] = { label, available: true, source: publicSource, error: error.message };
        }
      }
      let waste = { label: 'Merma', available: false };
      const storedWaste = latestWeeklyFile(location.id, 'waste');
      if (originalMode) {
        try {
          const originalWaste = require('./inventory-original-report').originalReportData(stock, location, boundaryMode ? {...selection,finalDate:movementDateTo} : selection, movementDateFrom, movementDateTo, { waste: true });
          waste = { label: 'Merma', available: true, source: { originalName: 'Movimientos originales de bodega de merma' }, report: buildWasteSummary(originalWaste.parsed, movementDateFrom, movementDateTo, ingredientCatalog, stock.sourceKind === 'public-inventory' ? buildInventoryPurchaseCostResolver(balanceDate, location, stock, {catalog:ingredientCatalog,recipes,waste:true}) : costResolver) };
        } catch (error) { waste = { label: 'Merma', available: false, error: error.message }; }
      } else if (storedWaste) {
        try {
          const { filePath, ...publicSource } = storedWaste;
          waste = {
            label: 'Merma',
            available: true,
            source: publicSource,
            report: buildWasteSummary(
              mergedKardexData(location.id, 'waste'),
              movementDateFrom,
              movementDateTo,
              ingredientCatalog,
              costResolver
            )
          };
        } catch (error) {
          waste = { label: 'Merma', available: true, error: error.message };
        }
      }
      let boundaryReport=null;
      if(boundaryMode) {
        const correction=inventoryCorrection(location,stock,recipes,ingredientCatalog,catalogAssignments,costResolver,originalMode);
        let basis=stock;
        if(!originalMode) {
          const warehouseId='file';const physical=new Set((stock?.daily||[]).filter(r=>r.physicalCount&&stock.warehouses.find(w=>w.id===r.warehouse)?.custom_id===(location.type==='warehouse'?1:2)).map(r=>r.code+'|'+r.date));
          const fields={opening:'ii -',closing:'if -',purchase:'buy -',use:'uso -',transfer_local_in:'trl-in -',transfer_local_out:'trl-out -',transfer_warehouse_in:'mov-in -',transfer_warehouse_out:'mov-out -',transformed_in:'trn-in -',transformed_out:'trn-out -'};
          basis={range:{from:parsed.groups[0].date,to:parsed.groups.at(-1).date},warehouses:[{id:warehouseId,custom_id:location.type==='warehouse'?1:2}],daily:parsed.products.flatMap(p=>parsed.groups.map((g,index)=>({code:p.code,name:p.name,unit:p.unit,date:g.date,warehouse:warehouseId,physicalCount:physical.has(p.code+'|'+g.date),initialRecord:index===0,...Object.fromEntries(Object.entries(fields).map(([field,prefix])=>[field,kardexMetricValue(p,g,m=>m.startsWith(prefix))]))})))};
        }
        boundaryReport=require('./inventory-boundaries').countBoundaryReport(basis,location,selection.initialDate,selection.finalDate,correction);
        if(original)Object.assign(original,{excluded:boundaryReport.excluded,physicalFinalItems:boundaryReport.physicalFinalItems});
      }
      const report = enrichKardexReport(
        boundaryReport || buildKardexInventoryReport(parsed, movementDateFrom, movementDateTo, selection),
        consumption,
        ingredientCatalog,
        costResolver
      );
      const salesData = periodSalesData(location.id, movementDateFrom, movementDateTo, { apiOnly: originalMode });
      const includedOrderKeys = new Set((stock?.includedOrders || []).map(id => `${location.id}:order:${id}`));
      const adjustmentSales = originalMode && stock.sourceKind !== 'public-inventory' ? { ...salesData, rows: salesData.rows.filter(row => includedOrderKeys.has(row.orderKey)), orderFacts: salesData.orderFacts.filter(row => includedOrderKeys.has(row.orderKey)) } : salesData;
      const lac001Substitutions = lac001SubstitutionSummary(
        adjustmentSales,
        movementDateFrom,
        movementDateTo,
        recipes,
        ingredientCatalog,
        costResolver
      );
      const syrupSauceSubstitutions = syrupSauceSubstitutionSummary(
        adjustmentSales,
        movementDateFrom,
        movementDateTo,
        recipes,
        ingredientCatalog,
        catalogAssignments,
        costResolver
      );
      const avoidedPackaging = inventoryAvoidedPackagingSummary(
        location,
        adjustmentSales,
        movementDateFrom,
        movementDateTo,
        recipes,
        ingredientCatalog,
        costResolver
      );
      if(boundaryMode) {
        for(const item of report.items) {
          const credits=[{code:'LAC001',unit:'L',quantity:lac001Substitutions.lac001VolumeLiters},...syrupSauceSubstitutions.items.filter(i=>i.status==='resolved').map(i=>({code:i.originalCode,unit:i.unit,quantity:i.theoreticalQuantity})),...avoidedPackaging.avoidedDisposablePackaging];
          item.compensationQuantity=credits.filter(c=>c.code===item.code).reduce((n,c)=>n+(convertQuantityUnit(c.quantity,c.unit,item.unit)??0),0);
          item.adjustedTheoreticalFinal=item.theoreticalFinal+item.compensationQuantity;
        }
      }
      const executiveSummary = buildInventoryExecutiveSummary({
        location,
        dateFrom: movementDateFrom,
        dateTo: movementDateTo,
        report,
        waste,
        consumption,
        lac001Substitutions,
        syrupSauceSubstitutions,
        avoidedPackaging,
        salesData
      });
      if (originalMode) {
        const unavailable = salesData.filesRead ? [] : ['adjustedKardexTotalCost', 'lac001AdjustedKardexCost', 'syrupSauceSubstitutions', 'syrupSauceAdjustedKardexCost', 'avoidedPackaging', 'packagingKardexCost', 'packagingAdjustedKardexCost'];
        if (original.physicalFinalItems !== report.itemCount) unavailable.push('physicalInventoryValue');
        for (const key of unavailable) Object.assign(executiveSummary.metrics[key], { available: false, amount: null, percentOfNetSales: null });
      }
      if(boundaryMode) {
        const amount=report.items.reduce((n,i)=>n+(i.costAvailable?i.adjustedTheoreticalFinal*i.unitCost:0),0);
        Object.assign(executiveSummary.metrics.theoreticalFinalInventoryValue,{amount,percentOfNetSales:executiveSummary.netSales?amount/executiveSummary.netSales*100:null});
      }
      if(boundaryMode && report.items.some(i=>!i.finalIsPhysical)) {
        for(const key of ['physicalInventoryValue','kardexTotalCost','adjustedKardexTotalCost','lac001AdjustedKardexCost','syrupSauceAdjustedKardexCost','packagingKardexCost','packagingAdjustedKardexCost'])Object.assign(executiveSummary.metrics[key],{available:false,amount:null,percentOfNetSales:null});
      }
      // The executive summary retains its baseline and adjusted indicators.
      // Detail rows expose the compensated difference without applying credits twice.
      if (boundaryMode) {
        report.totalCostBeforeCompensations = report.totalCost;
        for (const item of report.items) {
          item.differenceBeforeCompensations = item.difference;
          item.totalCostBeforeCompensations = item.totalCost;
          item.difference = item.finalInventory === null ? null : item.finalInventory - item.adjustedTheoreticalFinal;
          item.totalCost = item.difference === null ? null : item.difference * item.unitCost;
        }
        report.totalCost = report.items.some(item => item.totalCost === null)
          ? null : report.items.reduce((sum, item) => sum + item.totalCost, 0);
      }
      const { filePath, ...source } = kardex;
      const publicMaster = record => record ? (({ filePath, ...value }) => value)(record) : null;
      return res.json({
        location: publicLocation(location),
        source,
        provenance: originalMode ? {
          mode: 'originals', label: stock.sourceKind === 'public-inventory' ? 'Inventario API pública Toteat' : 'Fuentes originales Toteat · informe provisional', capturedAt: stock.sourceCapturedAt,
          range: stock.range, masterObservedAt: stock.masterObservedAt, dependencies: stock.dependencies,
          excluded: original.excluded, issues: stock.issues, assumptions: stock.assumptions,
          physicalFinalItems: original.physicalFinalItems,
          note: stock.sourceKind === 'public-inventory' ? 'Cantidades desde la API pública Toteat. Valorización por última compra disponible hasta la fecha de corte, incluidas compras centrales; sin compra comparable, costo del maestro de ingredientes o productos; después, costo API positivo o receta calculada con costos disponibles. Sin antecedente verificable se indica Sin costo. Marketing y colaboradores usan sus archivos disponibles. Compensaciones aplicadas una sola vez. Los días sin cobertura no se consideran inventario cero; las incidencias se detallan en las fuentes. El saldo final es teórico cuando no hay toma física.' : 'Inventario y merma calculados desde fuentes originales. Marketing y colaboradores usan sus archivos disponibles. Consumo de ventas provisional; productos sin apertura conocida excluidos. Valoración estimada con el resolver de compras/maestros del informe, no costo histórico certificado de Toteat. El saldo final puede ser calculado cuando no existe toma física. El consumo base incluye productos y extras. Las sustituciones de leche, syrup/salsas y envases no usados se compensan una sola vez en el resumen ajustado, únicamente para las órdenes incorporadas al cálculo.'
        } : { mode: 'files', label: 'Archivos Kardex y Merma de Toteat' },
        waste,
        consumption,
        lac001Substitutions,
        syrupSauceSubstitutions,
        avoidedPackaging,
        executiveSummary,
        masterSources: { recipes: publicMaster(recipeMaster), catalog: publicMaster(catalogMaster), error: masterError },
        report
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Could not process the Kardex.' });
    }
  });

  function previousMonthPeriod(todayKey) {
    const [year, month, day] = todayKey.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 2, 1));
    const lastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(day, lastDay)));
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }

  function percentageChange(current, previous) {
    return previous ? ((current / previous) - 1) * 100 : null;
  }

  function periodSalesMetric(orderFacts, current, previous) {
    const sum = period => orderFacts
      .filter(fact => fact.date >= period.from && fact.date <= period.to)
      .reduce((total, fact) => total + fact.net, 0);
    const currentValue = sum(current);
    const previousValue = sum(previous);
    return {
      ...current,
      netSales: currentValue,
      previous: { ...previous, netSales: previousValue },
      changePercent: percentageChange(currentValue, previousValue)
    };
  }

  function mercadoPagoCardKey(row) {
    const initial = String(rowValue(row, ['CARD_INITIAL_NUMBER']) ?? '').replace(/\D/g, '');
    const last = String(rowValue(row, ['LAST_FOUR_DIGITS']) ?? '').replace(/\D/g, '').padStart(4, '0');
    return initial && last ? `${initial}|${last}` : null;
  }

  function mercadoPagoDateTime(row) {
    const value = rowValue(row, ['TRANSACTION_DATE']);
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    const text = String(value || '').trim();
    const localTimestamp = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
    if (localTimestamp) return `${localTimestamp[1]}T${localTimestamp[2]}`;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    const date = cellDate(value);
    return date ? `${date}T00:00:00.000Z` : null;
  }

  function recurringPeriodMetric(facts, current, previous) {
    const summarize = period => {
      const selected = facts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const totalSales = selected.reduce((sum, fact) => sum + fact.amount, 0);
      const recurring = selected.filter(fact => fact.recurring);
      const recurringSales = recurring.reduce((sum, fact) => sum + fact.amount, 0);
      return {
        ...period,
        transactions: selected.length,
        sales: totalSales,
        recurringTransactions: recurring.length,
        recurringSales,
        recurringTransactionPercent: selected.length ? recurring.length / selected.length * 100 : 0,
        recurringSalesPercent: totalSales ? recurringSales / totalSales * 100 : 0
      };
    };
    const value = summarize(current);
    const prior = summarize(previous);
    return {
      ...value,
      previous: prior,
      salesChangePercent: percentageChange(value.sales, prior.sales),
      transactionChangePercent: percentageChange(value.transactions, prior.transactions),
      recurringTransactionPercentChange: value.recurringTransactionPercent - prior.recurringTransactionPercent,
      recurringSalesPercentChange: value.recurringSalesPercent - prior.recurringSalesPercent
    };
  }

  function normalizedTransactionId(value) {
    return String(value ?? '').trim().replace(/^'+/, '').replace(/\.0+$/, '');
  }

  function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        current[rightIndex] = Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
  }

  function serviceModeFromComment(value) {
    const comment = normalizeHeader(value).replace(/\bserv\s+ir\b/g, 'servir').replace(/\bllev\s+ar\b/g, 'llevar');
    const tokens = comment.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
    const resembles = keyword => tokens.some(token => token.length >= 4 && token.length <= 8
      && editDistance(token.replace(/\d+$/g, ''), keyword) <= 2);
    const takeaway = /\btake\s*away\b/.test(comment) || resembles('llevar');
    const dineIn = resembles('servir') || /\b(en el )?local\b|\baqui\b|\baca\b/.test(comment);
    if (takeaway && !dineIn) return { key: 'takeaway', ambiguous: false };
    if (dineIn && !takeaway) return { key: 'dineIn', ambiguous: false };
    return { key: 'unknown', ambiguous: takeaway && dineIn };
  }

  function paymentDetailModes(stores, warnings, orderFacts = [], sourcePeriod = null, apiOnly = false) {
    const detailsByOrder = new Map();
    const amountFields = new Set();
    const filesReadByLocation = new Map();
    const grossSalesByOrder = new Map(orderFacts.map(fact => [fact.orderKey, fact.net * 1.19]));
    let filesRead = 0;
    for (const location of stores) {
      for (const stored of (apiOnly ? toteatSalesSync?.source(location.id, 'payment-details') || [] : storedTransactionFiles(location.id, 'payment-details'))
        .filter(file => storedFileIntersectsPeriod(file, sourcePeriod))) {
        try {
          const rows = readSalesRows(stored.filePath);
          const amountSamples = rows.flatMap(row => {
            const amount = numericValue(rowValue(row, ['Total', 'Order Total']))
              ?? numericValue(rowValue(row, ['A Pagar', 'Due']));
            const gratuity = numericValue(rowValue(row, ['Propina', 'Gratuity']));
            return amount && gratuity ? [{ amount: Math.abs(amount), gratuity: Math.abs(gratuity) }] : [];
          });
          const salesRatios = rows.flatMap(row => {
            const orderId = normalizedTransactionId(rowValue(row, ['Comanda', 'Ticket', 'ID de orden', 'Id de orden']));
            const amount = Math.abs(numericValue(rowValue(row, ['Total', 'Order Total']))
              ?? numericValue(rowValue(row, ['A Pagar', 'Due'])) ?? 0);
            const grossSales = grossSalesByOrder.get(`${location.id}:order:${orderId}`);
            return amount && grossSales ? [grossSales / amount] : [];
          }).sort((left, right) => left - right);
          const medianSalesRatio = salesRatios.length ? salesRatios[Math.floor(salesRatios.length / 2)] : null;
          const usesThousands = medianSalesRatio !== null
            ? medianSalesRatio >= 100
            : amountSamples.some(sample => sample.gratuity / sample.amount >= 20)
              || rows.some(row => {
              const amount = Math.abs(numericValue(rowValue(row, ['Total', 'Order Total']))
                ?? numericValue(rowValue(row, ['A Pagar', 'Due'])) ?? 0);
              return amount > 0 && amount < 200;
            });
          const amountScale = rows.some(row => row['API Moneda'] === 'CLP') ? 1 : usesThousands ? 1000 : 1;
          for (const row of rows) {
            const dateOrder = dateOrderForHeaders(Object.keys(row));
            const orderId = normalizedTransactionId(rowValue(row, ['Comanda', 'Ticket', 'ID de orden', 'Id de orden']));
            if (!orderId) continue;
            const date = cellDate(rowValue(row, ['FechaCierre', 'Fecha cierre', 'Fecha de cierre', 'Fecha', 'DateClosing', 'Date Closing', 'Closing Date']), dateOrder);
            if (date && (dateIsExcluded(date, stored.excludedRanges)
              || (sourcePeriod && (date < sourcePeriod.from || date > sourcePeriod.to)))) continue;
            const orderKey = `${location.id}:order:${orderId}`;
            const detail = detailsByOrder.get(orderKey) || { comments: new Set(), amountField: null, amounts: new Set(), totals: new Set(), paidTotals: new Set(), gratuities: new Set() };
            const comment = String(rowValue(row, ['Comentario General', 'Comentario general', 'General Comment']) || '').trim();
            if (comment) detail.comments.add(comment);
            const englishAmount = rowValue(row, ['Due']);
            const spanishAmount = rowValue(row, ['A Pagar']);
            const amount = numericValue(row['API Total Orden'] ?? englishAmount ?? spanishAmount);
            if (amount !== null) {
              detail.amounts.add(Math.round(amount * amountScale * 100) / 100);
              detail.amountField = englishAmount !== null && englishAmount !== undefined ? 'Due' : 'A Pagar';
              amountFields.add(detail.amountField);
            }
            const orderTotal = numericValue(row['API Total Orden'] ?? rowValue(row, ['Total', 'Order Total']));
            if (orderTotal !== null) detail.totals.add(Math.round(orderTotal * amountScale * 100) / 100);
            const paidTotal = numericValue(row['API Pagado Orden'] ?? rowValue(row, ['Pagos', 'Payments', 'Paid']));
            if (paidTotal !== null) detail.paidTotals.add(Math.round(paidTotal * amountScale * 100) / 100);
            const gratuity = numericValue(row['API Propina Orden'] ?? rowValue(row, ['Propina', 'Gratuity', 'Tip']));
            if (gratuity !== null) detail.gratuities.add(Math.round(gratuity * amountScale * 100) / 100);
            detailsByOrder.set(orderKey, detail);
          }
          filesRead += 1;
          filesReadByLocation.set(location.id, (filesReadByLocation.get(location.id) || 0) + 1);
        } catch {
          warnings.push(`No se pudo leer Detalle Pagos (${location.name}).`);
        }
      }
    }
    const modes = new Map();
    for (const [orderKey, detail] of detailsByOrder) {
      const comment = [...detail.comments].join(' / ');
      const orderTotal = detail.totals.size === 1 ? [...detail.totals][0] : null;
      modes.set(orderKey, {
        ...serviceModeFromComment(comment),
        comment,
        dueAmount: detail.amounts.size === 1 ? [...detail.amounts][0] : null,
        orderTotal,
        paidTotal: detail.paidTotals.size === 1 ? [...detail.paidTotals][0] : null,
        gratuity: detail.gratuities.size === 1 ? [...detail.gratuities][0] : null,
        totalAmbiguous: detail.totals.size > 1,
        hasPartialDue: orderTotal !== null && [...detail.amounts].some(amount =>
          amount < orderTotal - Math.max(2, Math.abs(orderTotal) * 0.005)),
        amountAmbiguous: detail.amounts.size > 1 || detail.paidTotals.size > 1,
        amountField: detail.amountField
      });
    }
    return { modes, filesRead, filesReadByLocation, amountFields: [...amountFields] };
  }

  function avoidedPackagingForProducts(products, modeFor, recipes, catalog, costResolver = null) {
    const recipesByCode = new Map([...(recipes || new Map())]
      .map(([code, entries]) => [String(code).toUpperCase(), entries]));
    const avoidedPackaging = new Map();
    const productsWithoutRecipe = new Set();
    for (const fact of products.filter(item => modeFor(item.orderKey) === 'dineIn' && item.quantity > 0)) {
      const recipe = recipesByCode.get(String(fact.code).toUpperCase());
      if (!recipe?.length) {
        productsWithoutRecipe.add(fact.code || fact.name);
        continue;
      }
      for (const ingredient of recipe) {
        const catalogItem = catalog?.get(ingredient.ingredientId) || catalog?.get(String(ingredient.ingredientId).toUpperCase());
        const name = catalogItem?.name || ingredient.ingredientName || ingredient.ingredientId;
        const normalizedName = normalizeHeader(name);
        const kind = /\btapa\b/.test(normalizedName) ? 'lid' : (/\bvaso\b/.test(normalizedName) ? 'cup' : null);
        if (!kind) continue;
        const key = String(ingredient.ingredientId || normalizedName).toUpperCase();
        const costReference = costResolver?.resolve(ingredient.ingredientId, ingredient.unit, catalogItem)
          || { unitCost: unitCostForRecipeUnit(catalogItem, ingredient.unit) ?? 0, source: catalogItem?.unitCost ? 'master' : 'missing', sourceDate: null };
        const unitCost = costReference.unitCost;
        const packaging = avoidedPackaging.get(key) || {
          code: ingredient.ingredientId,
          name,
          kind,
          unit: ingredient.unit || catalogItem?.unit || 'UN',
          quantity: 0,
          unitCost,
          costSource: costReference.source,
          costSourceDate: costReference.sourceDate,
          hasCost: costReference.source !== 'missing',
          totalCost: 0
        };
        const avoidedQuantity = fact.quantity * ingredient.quantity;
        packaging.quantity += avoidedQuantity;
        if (packaging.hasCost) packaging.totalCost += avoidedQuantity * packaging.unitCost;
        avoidedPackaging.set(key, packaging);
      }
    }
    const avoidedDisposablePackaging = [...avoidedPackaging.values()]
      .sort((left, right) => right.totalCost - left.totalCost
        || right.quantity - left.quantity
        || left.name.localeCompare(right.name, 'es'));
    return {
      avoidedDisposablePackaging,
      avoidedDisposableCups: avoidedDisposablePackaging.filter(item => item.kind === 'cup'),
      totalAvoidedPackagingCost: avoidedDisposablePackaging.reduce((sum, item) => sum + item.totalCost, 0),
      packagingWithoutCost: avoidedDisposablePackaging.filter(item => !item.hasCost).map(item => item.code || item.name),
      productsWithoutRecipe: [...productsWithoutRecipe]
    };
  }

  function inventoryAvoidedPackagingSummary(location, salesData, dateFrom, dateTo, recipes, catalog, costResolver = null) {
    const warnings = [...salesData.warnings];
    const modeData = paymentDetailModes([location], warnings, salesData.orderFacts, { from: dateFrom, to: dateTo }, salesData.apiOnly);
    const modeFor = orderKey => modeData.modes.get(orderKey)?.key || 'unknown';
    const packaging = avoidedPackagingForProducts(salesData.rows, modeFor, recipes, catalog, costResolver);
    const totalOrders = salesData.orderFacts.length;
    const matchedOrders = salesData.orderFacts.filter(fact => modeData.modes.has(fact.orderKey)).length;
    const dineInOrders = salesData.orderFacts.filter(fact => modeFor(fact.orderKey) === 'dineIn').length;
    const ambiguousOrders = salesData.orderFacts.filter(fact => modeData.modes.get(fact.orderKey)?.ambiguous).length;
    return {
      dateFrom,
      dateTo,
      totalOrders,
      matchedOrders,
      dineInOrders,
      ambiguousOrders,
      paymentDetailsFilesRead: modeData.filesRead,
      warnings,
      ...packaging
    };
  }

  function buildServiceModeInsights(periods, orderFacts, productFacts, modeData, todayKey, locationIds = []) {
    const definitions = [
      ['takeaway', 'Para llevar'],
      ['dineIn', 'Servir en el local'],
      ['unknown', 'Sin información']
    ];
    const recipeResolution = resolveRecipes(todayKey);
    const recipeMaster = recipeResolution.primary;
    const catalogMaster = latestMasterFile('master-catalog', todayKey);
    let recipes = new Map();
    let catalog = new Map();
    if (recipeMaster) recipes = recipeResolution.recipes;
    try { if (catalogMaster) catalog = parseIngredientCatalog(catalogMaster.filePath); } catch { catalog = new Map(); }
    const summarize = period => {
      const selectedOrders = orderFacts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const selectedProducts = productFacts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const modeFor = orderKey => modeData.modes.get(orderKey)?.key || 'unknown';
      const netForOrder = fact => {
        const dueAmount = modeData.modes.get(fact.orderKey)?.dueAmount;
        return dueAmount !== null && dueAmount !== undefined ? dueAmount / 1.19 : fact.net;
      };
      const resolvedOrderNet = new Map(selectedOrders.map(fact => [fact.orderKey, netForOrder(fact)]));
      const productNetByOrder = new Map();
      selectedProducts.forEach(fact => productNetByOrder.set(
        fact.orderKey, (productNetByOrder.get(fact.orderKey) || 0) + fact.net
      ));
      const allocatedProductNet = fact => {
        const sourceTotal = productNetByOrder.get(fact.orderKey) || 0;
        const resolvedTotal = resolvedOrderNet.get(fact.orderKey);
        return sourceTotal && resolvedTotal !== undefined ? fact.net * resolvedTotal / sourceTotal : fact.net;
      };
      const totalNetSales = selectedOrders.reduce((sum, fact) => sum + netForOrder(fact), 0);
      const groups = definitions.map(([key, label]) => {
        const orders = selectedOrders.filter(fact => modeFor(fact.orderKey) === key);
        const netSales = orders.reduce((sum, fact) => sum + netForOrder(fact), 0);
        return {
          key,
          label,
          orders: orders.length,
          netSales,
          averageTicket: averageTicketWithVat(netSales, orders.length) ?? 0,
          orderPercent: selectedOrders.length ? orders.length / selectedOrders.length * 100 : 0,
          salesPercent: totalNetSales ? netSales / totalNetSales * 100 : 0
        };
      });
      const hierarchyMap = new Map();
      for (const fact of selectedProducts) {
        const mode = modeFor(fact.orderKey);
        const hierarchy = hierarchyMap.get(fact.hierarchy) || {
          name: fact.hierarchy,
          takeaway: { orders: new Set(), netSales: 0 },
          dineIn: { orders: new Set(), netSales: 0 },
          unknown: { orders: new Set(), netSales: 0 }
        };
        hierarchy[mode].orders.add(fact.orderKey);
        hierarchy[mode].netSales += allocatedProductNet(fact);
        hierarchyMap.set(fact.hierarchy, hierarchy);
      }
      const hierarchies = [...hierarchyMap.values()].map(item => ({
        name: item.name,
        groups: Object.fromEntries(definitions.map(([key]) => [key, {
          orders: item[key].orders.size,
          netSales: item[key].netSales
        }])),
        totalNetSales: definitions.reduce((sum, [key]) => sum + item[key].netSales, 0)
      })).sort((left, right) => right.totalNetSales - left.totalNetSales || left.name.localeCompare(right.name, 'es'));
      const hierarchyTotals = Object.fromEntries(definitions.map(([key]) => [key,
        hierarchies.reduce((sum, hierarchy) => sum + hierarchy.groups[key].netSales, 0)
      ]));
      hierarchyTotals.total = hierarchies.reduce((sum, hierarchy) => sum + hierarchy.totalNetSales, 0);

      const packaging = avoidedPackagingForProducts(
        selectedProducts,
        modeFor,
        recipes,
        catalog,
        buildCostResolver(period.to, locationIds)
      );
      const matchedOrders = selectedOrders.filter(fact => modeData.modes.has(fact.orderKey)).length;
      const ambiguousOrders = selectedOrders.filter(fact => modeData.modes.get(fact.orderKey)?.ambiguous).length;
      return {
        period: { from: period.from, to: period.to },
        totalOrders: selectedOrders.length,
        totalNetSales,
        matchedOrders,
        ambiguousOrders,
        groups,
        hierarchies,
        hierarchyTotals,
        ...packaging
      };
    };
    return {
      classificationField: 'Comentario General / General Comment',
      paymentDetailsFilesRead: modeData.filesRead,
      amountFields: modeData.amountFields,
      recipeSource: recipeMaster ? { name: recipeMaster.originalName || recipeMaster.name, validFrom: recipeMaster.validFrom } : null,
      catalogSource: catalogMaster ? { name: catalogMaster.originalName || catalogMaster.name, validFrom: catalogMaster.validFrom } : null,
      periods: Object.fromEntries(Object.entries(periods).map(([key, period]) => [key, summarize(period.current)]))
    };
  }

  function buildSalesDashboard(requestedLocation = 'all', query = {}) {
    const todayKey = projectionToday();
    const activeStores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const selectedStore = requestedLocation === 'all' ? null : activeStores.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedStore) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    const stores = selectedStore ? [selectedStore] : activeStores;
    const weekStart = mondayContaining(todayKey);
    const monthStart = `${todayKey.slice(0, 7)}-01`;
    const customFrom = String(query.serviceDateFrom || '');
    const customTo = String(query.serviceDateTo || '');
    if ((customFrom || customTo) && (!isValidDate(customFrom) || !isValidDate(customTo)
      || customFrom > customTo
      || (new Date(`${customTo}T00:00:00Z`) - new Date(`${customFrom}T00:00:00Z`)) / 86400000 > 365)) {
      const error = new Error('Selecciona un rango personalizado válido de hasta 366 días.');
      error.status = 400;
      throw error;
    }
    const periods = {
      day: {
        label: 'Hoy', current: { from: todayKey, to: todayKey },
        previous: { from: addDays(todayKey, -7), to: addDays(todayKey, -7), label: 'Mismo día semana anterior' }
      },
      yesterday: {
        label: 'Día anterior', current: { from: addDays(todayKey, -1), to: addDays(todayKey, -1) },
        previous: { from: addDays(todayKey, -8), to: addDays(todayKey, -8), label: 'Mismo día semana anterior' }
      },
      week: {
        label: 'Semana actual', current: { from: weekStart, to: todayKey },
        previous: { from: addDays(weekStart, -7), to: addDays(todayKey, -7), label: 'Mismo tramo semana anterior' }
      },
      previousWeek: {
        label: 'Semana anterior', current: { from: addDays(weekStart, -7), to: addDays(weekStart, -1) },
        previous: { from: addDays(weekStart, -14), to: addDays(weekStart, -8), label: 'Semana previa' }
      },
      last30: {
        label: 'Últimos 30 días', current: { from: addDays(todayKey, -29), to: todayKey },
        previous: { from: addDays(todayKey, -59), to: addDays(todayKey, -30), label: '30 días anteriores' }
      },
      month: {
        label: 'Mes actual', current: { from: monthStart, to: todayKey },
        previous: { ...previousMonthPeriod(todayKey), label: 'Mismo tramo mes anterior' }
      }
    };
    if (customFrom && customTo) {
      const customDays = Math.round((new Date(`${customTo}T00:00:00Z`) - new Date(`${customFrom}T00:00:00Z`)) / 86400000) + 1;
      periods.custom = {
        label: 'Rango personalizado',
        current: { from: customFrom, to: customTo },
        previous: {
          from: addDays(customFrom, -customDays),
          to: addDays(customFrom, -1),
          label: 'Período anterior equivalente'
        }
      };
    }
    const hierarchyMaster = latestMasterFile('product-hierarchy', todayKey);
    const dashboardCatalogMaster = latestMasterFile('master-catalog', todayKey);
    let dashboardCatalog = new Map();
    try { if (dashboardCatalogMaster) dashboardCatalog = parseIngredientCatalog(dashboardCatalogMaster.filePath); } catch {}
    let dashboardProducts=new Map(),dashboardBars=null;
    try { if(dashboardCatalogMaster)dashboardProducts=parseSalesAnalysisCatalog(dashboardCatalogMaster.filePath).products;
      const master=latestMasterFile('extras-hierarchy',todayKey);
      if(master)dashboardBars=parseNamedHierarchies(master.filePath,['Nombre Jerarquía Producto *','Nombre Jerarquia Producto *','Nombre Jerarquía *']);
    } catch {}
    const dashboardHot=dashboardBars?.descendantIds('BA.001')||new Set(['BA.001']),dashboardCold=dashboardBars?.descendantIds('BA.002')||new Set(['BA.002']);
    const dashboardCostResolver = buildCostResolver(todayKey, stores.map(location => location.id));
    let hierarchyLookup = null;
    if (hierarchyMaster) {
      try { hierarchyLookup = parseProductHierarchies(hierarchyMaster.filePath); } catch { hierarchyLookup = null; }
    }
    const orderMap = new Map();
    const productFacts = [];
    const seenProductRows = new Set();
    const warnings = [];
    let salesFilesRead = 0;
    for (const location of stores) {
      for (const stored of storedSalesFiles(location.id)) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
            if (!date || dateIsExcluded(date, stored.excludedRanges)) continue;
            const orderKey = `${location.id}:${salesTransactionKey(row)}`;
            if (!orderMap.has(orderKey)) {
              const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
              if (gross !== null) {
                const discounts = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
                orderMap.set(orderKey, { orderKey, locationId: location.id, date, net: (gross + discounts) / 1.19 });
              }
            }
            const canonicalRow = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const productRowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
            if (seenProductRows.has(productRowKey)) continue;
            seenProductRows.add(productRowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto']));
            const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
            const paidLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar']));
            const listLine = numericValue(rowValue(row, ['Precio Lista'])) || 0;
            const lineDiscount = numericValue(rowValue(row, ['Descuento'])) || 0;
            // Toteat's "Precio a Pagar" is already the final line amount after discounts.
            // Only apply the discount separately when the report has no final-price column.
            const grossLine = paidLine !== null ? paidLine : listLine + lineDiscount;
            const catalogItem = dashboardCatalog.get(code.toUpperCase());
            const costReference = dashboardCostResolver.resolve(code, catalogItem?.unit, catalogItem);
            const lineCost = quantity * costReference.unitCost;
            const hierarchyId = String(rowValue(row, ['AB.']) ?? '').trim();
            const hierarchyNode = hierarchyLookup?.hierarchyMap.get(hierarchyId);
            const hierarchyPath = hierarchyNode ? hierarchyLookup.pathFor(hierarchyNode.id) : [];
            const fallbackHierarchy = repairMojibake(rowValue(row, ['Categorías de Productos/Platos', 'Categorias de Productos/Platos']))
              || 'Sin jerarquía';
            const resolvedHierarchyPath = hierarchyPath.length ? hierarchyPath : [fallbackHierarchy];
            const hierarchy = resolvedHierarchyPath.join(' / ');
            if (code || name) productFacts.push({
              orderKey, locationId: location.id, date, code, name: name || code, quantity,
              barType: require('./sales-insight-filters').classifySalesBar({ hierarchyIds: dashboardProducts.get(code.toUpperCase())?.hierarchyIds || [], hierarchyPath: resolvedHierarchyPath, name }, dashboardHot, dashboardCold),
              net: grossLine / 1.19,
              cost: lineCost,
              unitCost: costReference.unitCost,
              costSource: costReference.source,
              costSourceDate: costReference.sourceDate,
              costAvailable: costReference.source !== 'missing',
              hierarchy,
              hierarchyPath: resolvedHierarchyPath
            });
          }
          salesFilesRead += 1;
        } catch {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    const orderFacts = [...orderMap.values()];
    const serviceModeData = paymentDetailModes(stores, warnings, orderFacts);
    const serviceModes = buildServiceModeInsights(
      periods,
      orderFacts,
      productFacts,
      serviceModeData,
      todayKey,
      stores.map(location => location.id)
    );
    const salesMetrics = Object.fromEntries(['day', 'yesterday', 'week', 'month'].map(key => [
      key, periodSalesMetric(orderFacts, { ...periods[key].current, label: periods[key].label }, periods[key].previous)
    ]));
    const locations = stores.map(location => {
      const facts = orderFacts.filter(fact => fact.locationId === location.id);
      return {
        id: location.id,
        name: location.name,
        day: periodSalesMetric(facts, periods.day.current, periods.day.previous).netSales,
        yesterday: periodSalesMetric(facts, periods.yesterday.current, periods.yesterday.previous).netSales,
        week: periodSalesMetric(facts, periods.week.current, periods.week.previous).netSales,
        month: periodSalesMetric(facts, periods.month.current, periods.month.previous).netSales
      };
    });
    const insightFrom = String(query.insightDateFrom || addDays(todayKey, -29));
    const insightTo = String(query.insightDateTo || todayKey);
    if (!isValidDate(insightFrom) || !isValidDate(insightTo) || insightFrom > insightTo || insightTo > todayKey) {
      const error = new Error('Selecciona fechas válidas para productos y jerarquías, sin superar el día actual.');
      error.status = 400;
      throw error;
    }
    const insightPeriods = {
      day: periods.day.current, week: periods.week.current, month: periods.month.current,
      year: { from: `${todayKey.slice(0, 4)}-01-01`, to: todayKey },
      custom: { from: insightFrom, to: insightTo }
    };
    const productInsights = {};
    for (const [key, period] of Object.entries(insightPeriods)) {
      const selected = productFacts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const products = new Map();
      const hierarchies = new Map();
      selected.forEach(fact => {
        const productKey = fact.code || normalizeHeader(fact.name);
        const product = products.get(productKey) || { code: fact.code, name: fact.name, barType:fact.barType,hierarchyPath:fact.hierarchyPath,quantity: 0, netSales: 0,totalCost:0,costAvailable:true };
        product.quantity += fact.quantity;
        product.netSales += fact.net;
        product.totalCost+=fact.cost;product.costAvailable=product.costAvailable&&fact.costAvailable;
        products.set(productKey, product);
        hierarchies.set(fact.hierarchy, (hierarchies.get(fact.hierarchy) || 0) + fact.net);
      });
      const totalHierarchySales = [...hierarchies.values()].reduce((sum, value) => sum + value, 0);
      const hierarchyRoot = {
        name: 'Todas las jerarquías', path: [], netSales: 0, totalCost: 0, costAvailable: true,
        children: new Map(), products: new Map()
      };
      const addProductToNode = (node, fact) => {
        const productKey = fact.code || normalizeHeader(fact.name);
        const product = node.products.get(productKey) || {
          code: fact.code, name: fact.name, quantity: 0, netSales: 0, totalCost: 0, costAvailable: true
        };
        product.quantity += fact.quantity;
        product.netSales += fact.net;
        product.totalCost += fact.cost;
        product.costAvailable = product.costAvailable && fact.costAvailable;
        node.products.set(productKey, product);
      };
      selected.forEach(fact => {
        hierarchyRoot.netSales += fact.net;
        hierarchyRoot.totalCost += fact.cost;
        hierarchyRoot.costAvailable = hierarchyRoot.costAvailable && fact.costAvailable;
        addProductToNode(hierarchyRoot, fact);
        let node = hierarchyRoot;
        fact.hierarchyPath.forEach((name, index) => {
          if (!node.children.has(name)) {
            node.children.set(name, {
              name, path: fact.hierarchyPath.slice(0, index + 1), netSales: 0, totalCost: 0,
              costAvailable: true, children: new Map(), products: new Map()
            });
          }
          node = node.children.get(name);
          node.netSales += fact.net;
          node.totalCost += fact.cost;
          node.costAvailable = node.costAvailable && fact.costAvailable;
          addProductToNode(node, fact);
        });
      });
      const serializeHierarchyNode = node => ({
        name: node.name,
        path: node.path,
        netSales: node.netSales,
        totalCost: node.totalCost,
        contributionMarginPercent: node.costAvailable && node.netSales
          ? (node.netSales - node.totalCost) / node.netSales * 100
          : null,
        children: [...node.children.values()]
          .sort((left, right) => right.netSales - left.netSales)
          .map(serializeHierarchyNode),
        products: [...node.products.values()]
          .map(product => ({
            ...product,
            contributionMarginPercent: product.costAvailable && product.netSales
              ? (product.netSales - product.totalCost) / product.netSales * 100
              : null
          }))
          .sort((left, right) => right.netSales - left.netSales || right.quantity - left.quantity)
      });
      productInsights[key] = {
        period,
        analysisProducts:[...products.values()],
        topProducts: require('./sales-insight-filters').buildSalesInsights([...products.values()]).topProducts,
        hierarchies: [...hierarchies].map(([name, netSales]) => ({
          name, netSales, percent: totalHierarchySales ? netSales / totalHierarchySales * 100 : 0
        })).sort((left, right) => right.netSales - left.netSales),
        hierarchyTree: serializeHierarchyNode(hierarchyRoot)
      };
    }
    const mercadoPagoFacts = [];
    const seenMercadoPago = new Set();
    let mercadoPagoFilesRead = 0;
    for (const location of stores) {
      for (const stored of storedTransactionFiles(location.id, 'mercadopago')) {
        try {
          for (const sheet of readGenericTransactionSheets(stored.filePath)) {
            const header = sheet.rows[0] || [];
            for (const values of sheet.rows.slice(1)) {
              const row = Object.fromEntries(header.map((name, index) => [String(name || `column-${index}`), values[index]]));
              const transactionType = String(rowValue(row, ['TRANSACTION_TYPE']) || '').trim().toUpperCase();
              if (transactionType && transactionType !== 'SETTLEMENT') continue;
              const dateTime = mercadoPagoDateTime(row);
              const date = dateTime?.slice(0, 10);
              if (!date || dateIsExcluded(date, stored.excludedRanges)) continue;
              const sourceId = String(rowValue(row, ['SOURCE_ID']) ?? '').trim();
              const uniqueId = `${location.id}:${sourceId || genericTransactionRowKey(values)}`;
              if (seenMercadoPago.has(uniqueId)) continue;
              seenMercadoPago.add(uniqueId);
              mercadoPagoFacts.push({
                locationId: location.id,
                date,
                dateTime,
                amount: numericValue(rowValue(row, ['TRANSACTION_AMOUNT'])) || 0,
                customerKey: mercadoPagoCardKey(row),
                recurring: false
              });
            }
          }
          mercadoPagoFilesRead += 1;
        } catch {
          warnings.push(`No se pudo leer MercadoPago: ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    mercadoPagoFacts.sort((left, right) => left.dateTime.localeCompare(right.dateTime));
    const customerDates = new Map();
    mercadoPagoFacts.forEach(fact => {
      if (!fact.customerKey) return;
      const previousVisits = customerDates.get(fact.customerKey) || [];
      fact.recurring = previousVisits.length > 0;
      previousVisits.push(fact.dateTime);
      customerDates.set(fact.customerKey, previousVisits);
    });
    const emptyFrequency = () => ({
      moreThanThreeWeekly: 0, moreThanWeekly: 0, moreThanEvery15Days: 0, moreThanMonthly: 0, occasional: 0
    });
    const frequencyKey = visits => {
      if (visits.length < 2) return null;
      const gaps = visits.slice(1).map((value, index) => (new Date(value) - new Date(visits[index])) / 86400000);
      const averageGapDays = gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
      if (averageGapDays < 7 / 3) return 'moreThanThreeWeekly';
      if (averageGapDays < 7) return 'moreThanWeekly';
      if (averageGapDays < 15) return 'moreThanEvery15Days';
      if (averageGapDays < 30) return 'moreThanMonthly';
      return 'occasional';
    };
    const frequency = emptyFrequency();
    customerDates.forEach(visits => {
      const key = frequencyKey(visits);
      if (key) frequency[key] += 1;
    });
    const historySummary = period => {
      const selected = mercadoPagoFacts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const identifiedCards = new Set(selected.map(fact => fact.customerKey).filter(Boolean));
      const recurrentCards = new Set(selected.filter(fact => fact.recurring && fact.customerKey).map(fact => fact.customerKey));
      const totalSales = selected.reduce((sum, fact) => sum + fact.amount, 0);
      const recurringSales = selected.filter(fact => fact.recurring).reduce((sum, fact) => sum + fact.amount, 0);
      const periodFrequency = emptyFrequency();
      recurrentCards.forEach(customerKey => {
        const visitsThroughPeriod = (customerDates.get(customerKey) || []).filter(value => value.slice(0, 10) <= period.to);
        const key = frequencyKey(visitsThroughPeriod);
        if (key) periodFrequency[key] += 1;
      });
      return {
        ...period,
        transactions: selected.length,
        totalSales,
        recurringSales,
        recurringSalesPercent: totalSales ? recurringSales / totalSales * 100 : 0,
        identifiedCards: identifiedCards.size,
        recurrentCustomers: recurrentCards.size,
        frequency: periodFrequency
      };
    };
    const monthHistory = [];
    const [todayYear, todayMonth] = todayKey.split('-').map(Number);
    for (let offset = -5; offset <= 0; offset += 1) {
      const start = new Date(Date.UTC(todayYear, todayMonth - 1 + offset, 1));
      const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const from = start.toISOString().slice(0, 10);
      const naturalTo = addDays(next.toISOString().slice(0, 10), -1);
      monthHistory.push(historySummary({ from, to: offset === 0 ? todayKey : naturalTo }));
    }
    const weekHistory = [];
    const currentWeekStart = mondayContaining(todayKey);
    for (let offset = -7; offset <= 0; offset += 1) {
      const from = addDays(currentWeekStart, offset * 7);
      const naturalTo = addDays(from, 6);
      weekHistory.push(historySummary({ from, to: offset === 0 ? todayKey : naturalTo }));
    }
    return {
      date: todayKey,
      scope: selectedStore
        ? { type: 'location', location: selectedStore.id, label: selectedStore.name }
        : { type: 'all', location: null, label: 'Todas las cafeterías' },
      sales: { metrics: salesMetrics, locations, productInsights, serviceModes, filesRead: salesFilesRead },
      mercadoPago: {
        metrics: Object.fromEntries(['day', 'week', 'month'].map(key => [key,
          recurringPeriodMetric(mercadoPagoFacts, periods[key].current, periods[key].previous)
        ])),
        customers: {
          identified: customerDates.size,
          recurrent: [...customerDates.values()].filter(visits => visits.length > 1).length,
          frequency
        },
        history: { months: monthHistory, weeks: weekHistory },
        transactionsRead: mercadoPagoFacts.length,
        filesRead: mercadoPagoFilesRead,
        keyDefinition: 'CARD_INITIAL_NUMBER + LAST_FOUR_DIGITS'
      },
      warnings
    };
  }

  app.get('/api/sales/dashboard', (req, res) => {
    try {
      return res.json(buildSalesDashboard(String(req.query.location || 'all'), req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el panel de ventas.' });
    }
  });

  function buildFindingsPayload(query = {}) {
    const dateTo = String(query.dateTo || projectionToday());
    const dateFrom = String(query.dateFrom || addDays(dateTo, -29));
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo
      || (new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000 > 365) {
      const error = new Error('Selecciona un período válido de hasta 366 días para buscar hallazgos.');
      error.status = 400;
      throw error;
    }
    const locations = readLocations().locations.filter(location => location.status === 'active');
    const requestedLocation = String(query.location || 'all');
    const selectedLocation = requestedLocation === 'all'
      ? null
      : locations.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedLocation) {
      const error = new Error('Selecciona una ubicación válida para buscar hallazgos.');
      error.status = 400;
      throw error;
    }
    const auditedLocations = selectedLocation ? [selectedLocation] : locations;
    const auditedStores = auditedLocations.filter(location => location.type === 'store');
    const definitions = [
      ['products', 'Productos', 'Precios, costos, márgenes, jerarquías y códigos vendidos.'],
      ['recipes', 'Recetas', 'Cobertura de productos vendidos, cantidades, rendimientos e ingredientes referenciados.'],
      ['costs', 'Costos', 'Costos de última compra y variaciones respecto de la compra anterior.'],
      ['inventory', 'Inventarios', 'Cobertura de inventario, saldos corregidos y productos consumidos sin stock.'],
      ['purchase-orders', 'Órdenes de compra', 'Estado, proveedor, cantidades, costos y consistencia de totales.'],
      ['purchases', 'Compras', 'Proveedores, códigos, unidades, conversiones y montos registrados.'],
      ['sales', 'Ventas', 'Cobertura, productos desconocidos, cantidades y montos atípicos.']
    ];
    const sections = new Map(definitions.map(([key, label, description]) => [key, { key, label, description, findings: [] }]));
    const severityOrder = { high: 0, medium: 1, low: 2 };
    const warnings = [];
    const sources = [];
    const add = (sectionKey, finding) => {
      const section = sections.get(sectionKey);
      section.findings.push({
        id: `${sectionKey}-${section.findings.length + 1}`,
        severity: 'medium',
        date: null,
        location: null,
        code: null,
        observed: null,
        ...finding
      });
    };
    const masterSource = (type, master) => {
      if (!master) return;
      sources.push({ type, name: master.originalName || master.name, validFrom: master.validFrom, updatedAt: master.savedAt, origin: master.sourceVersion ? 'Maestros compartidos sincronizados · La Concepción' : 'Maestro compartido' });
    };

    const catalogMaster = latestMasterFile('master-catalog', dateTo);
    const recipeResolution = resolveRecipes(dateTo);
    const recipeMaster = recipeResolution.primary;
    const hierarchyMaster = latestMasterFile('product-hierarchy', dateTo);
    const findingsCostResolver = buildCostResolver(dateTo, [], { latestAcrossLocations: true, preferDirectMaster: true, validPurchasesOnly: true });
    masterSource('Catálogo', catalogMaster);
    masterSource('Recetas', recipeMaster);
    masterSource('Jerarquía de productos', hierarchyMaster);
    for (const [field,label] of [['ingredient-hierarchy','Jerarquía de ingredientes'],['extras-hierarchy','Jerarquía de extras'],['master-suppliers','Proveedores']]) masterSource(label,latestMasterFile(field,dateTo));
    let products = [];
    let productByCode = new Map();
    let ingredientCatalog = new Map();
    let fullCatalog = new Map();
    if (!catalogMaster) {
      add('products', {
        severity: 'high', title: 'No hay un catálogo maestro vigente',
        detail: `No fue posible validar productos ni costos al ${dateTo}.`,
        action: 'Carga un maestro de productos, ingredientes y extras con vigencia aplicable.'
      });
    } else {
      try {
        products = parseProductCatalog(catalogMaster.filePath).map(product => {
          const costReference = findingsCostResolver.resolve(product.code, product.unit, {
            unitCost: product.cost,
            unit: product.unit
          });
          const cost = costReference.unitCost;
          return {
            ...product,
            masterCost: product.cost,
            cost,
            costSource: costReference.source,
            costSourceDate: costReference.sourceDate,
            marginPercent: costReference.source !== 'missing' && product.netPrice
              ? ((product.netPrice - cost) / product.netPrice) * 100
              : null
          };
        });
        productByCode = new Map(products.map(product => [product.code.toUpperCase(), product]));
        ingredientCatalog = parseIngredientsCatalog(catalogMaster.filePath);
        fullCatalog = new Map([...parseIngredientCatalog(catalogMaster.filePath)].map(([code, item]) => [String(code).toUpperCase(), item]));
      } catch (error) {
        add('products', {
          severity: 'high', title: 'El catálogo vigente no se pudo interpretar', detail: error.message,
          action: 'Revisa las hojas y encabezados del maestro vigente.'
        });
      }
    }

    const salesQuantityByCode = new Map();
    const unknownSales = new Map();
    const nonPositiveSales = new Map();
    const latestSalesDate = new Map();
    const seenSalesRows = new Set();
    const seenSalesOrders = new Set();
    const missingSalesEvidence = [], discountEvidence = [];
    let missingSalesCode = 0;
    let suspiciousDiscounts = 0;
    let salesRowsRead = 0;
    for (const location of auditedStores) {
      const apiSources = toteatSalesSync.source(location.id, 'sales');
      const apiState = toteatSalesSync.status(location.id);
      const auditPayments = new Map((toteatSalesSync.get(location.id)?.payments || []).map(p => [String(p.paymentId), p]));
      const useApi = !!apiState.lastSuccess || apiSources.length > 0;
      sources.push({type:'Ventas · '+location.name,name:useApi?'Toteat API':'Archivos históricos',updatedAt:apiState.lastSuccess});
      if(useApi && apiState.from > dateFrom) warnings.push(`Ventas (${location.name}): la sincronización comienza el ${apiState.from}, después del inicio solicitado.`);
      if(apiState.lastError) warnings.push(`Ventas (${location.name}): la última sincronización tuvo problemas; se usa la última lectura guardada.`);
      for (const stored of (useApi ? apiSources : storedSalesFiles(location.id))) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const date = cellDate(rowValue(row, useApi ? ['Fecha de cierre'] : ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
            if (!date || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
            if (!latestSalesDate.get(location.id) || date > latestSalesDate.get(location.id)) latestSalesDate.set(location.id, date);
            if (date < dateFrom) continue;
            const canonical = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
            if (seenSalesRows.has(rowKey)) continue;
            seenSalesRows.add(rowKey);
            salesRowsRead += 1;
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto'])) || code || 'Producto sin identificar';
            const quantity = numericValue(rowValue(row, ['Cantidad']));
            const paymentId = String(rowValue(row, ['ID de Pago', 'ID Pago']) ?? '');
            const payment = auditPayments.get(paymentId);
            const evidence = { 'Ubicación': location.name, 'Archivo fuente': path.basename(stored.filePath), 'Zona horaria del reporte': 'America/Santiago', ...auditSourceFields(row),
              ...(payment ? { 'Pago original API (fechas en UTC)': payment } : {}) };
            if (!code) { missingSalesCode += 1; missingSalesEvidence.push(evidence); }
            else {
              salesQuantityByCode.set(code, (salesQuantityByCode.get(code) || 0) + (quantity || 0));
              if (fullCatalog.size && !fullCatalog.has(code)) {
                const item = unknownSales.get(code) || { code, name, rows: 0, quantity: 0, evidence: [] };
                item.rows += 1;
                item.quantity += quantity || 0;
                item.evidence.push(evidence);
                unknownSales.set(code, item);
              }
            }
            if (quantity !== null && quantity <= 0) {
              const key = code || normalizeHeader(name);
              const item = nonPositiveSales.get(key) || { code, name, rows: 0, quantity: 0, evidence: [] };
              item.rows += 1;
              item.quantity += quantity;
              item.evidence.push(evidence);
              nonPositiveSales.set(key, item);
            }
            const orderKey = `${location.id}:${salesTransactionKey(row)}`;
            if (!seenSalesOrders.has(orderKey)) {
              seenSalesOrders.add(orderKey);
              const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
              const discount = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
              if (gross !== null && gross >= 0 && Math.abs(discount) > gross) { suspiciousDiscounts += 1; discountEvidence.push(evidence); }
            }
          }
        } catch {
          warnings.push(`No se pudo auditar ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
      const latest = latestSalesDate.get(location.id);
      if ((!useApi && (!latest || latest < addDays(dateTo, -3))) || (useApi && (!apiState.lastSuccess || apiState.lastSuccess.slice(0,10) < dateTo))) {
        add('sales', {
          severity: 'medium', title: `Ventas desactualizadas en ${location.name}`,
          detail: latest ? `La última venta disponible es del ${latest}.` : 'No se encontraron ventas legibles.',
          observed: latest || 'Sin datos', location: location.name,
          action: 'Actualiza las ventas desde Toteat y revisa la cobertura del período.'
        });
      }
    }
    for (const item of unknownSales.values()) {
      add('sales', {
        severity: 'high', title: `Código vendido fuera del catálogo: ${item.code}`,
        detail: `${item.rows} fila(s), ${item.quantity.toLocaleString('es-CL')} unidad(es), asociadas a “${item.name}”.`,
        observed: `${item.rows} filas`, code: item.code, evidence: item.evidence,
        action: 'Confirma el código en Toteat o actualiza el catálogo maestro.'
      });
    }
    for (const item of nonPositiveSales.values()) {
      add('sales', {
        severity: 'medium', title: `Cantidad de venta no positiva: ${item.name}`,
        detail: `${item.rows} fila(s) suman ${item.quantity.toLocaleString('es-CL')} unidades. Pueden corresponder a devoluciones o anulaciones; el signo por sí solo no demuestra un error.`,
        observed: item.quantity, code: item.code || null, evidence: item.evidence,
        action: 'Confirma si corresponden a anulaciones, devoluciones o un dato incorrecto.'
      });
    }
    if (missingSalesCode) add('sales', {
      severity: 'medium', title: 'Ventas sin código de producto', detail: `${missingSalesCode} fila(s) no permiten vincular la venta con el catálogo.`,
      evidence: missingSalesEvidence, observed: `${missingSalesCode} filas`, action: 'Revisa los pagos originales y sus documentos. Toteat puede informar importes sin productos asociados; no se debe inventar un producto.'
    });
    if (suspiciousDiscounts) add('sales', {
      severity: 'high', title: 'Descuentos superiores al total de la venta',
      detail: `${suspiciousDiscounts} transacción(es) tienen un descuento absoluto mayor que su monto bruto.`,
      evidence: discountEvidence, observed: `${suspiciousDiscounts} transacciones`, action: 'Revisa descuentos, anulaciones y signos monetarios en el archivo de ventas.'
    });

    const productCodeCounts = new Map();
    products.forEach(product => productCodeCounts.set(product.code.toUpperCase(), (productCodeCounts.get(product.code.toUpperCase()) || 0) + 1));
    for (const product of products.filter(item => item.active)) {
      const code = product.code.toUpperCase();
      if (product.price <= 0) add('products', {
        severity: 'high', title: `Producto activo sin precio de venta: ${product.name}`,
        detail: `El producto ${product.code} tiene precio base ${product.price}.`, observed: product.price, code: product.code,
        action: 'Define un precio de venta válido o desactiva el producto.'
      });
      if (product.cost <= 0) add('products', {
        severity: salesQuantityByCode.has(code) ? 'high' : 'medium', title: `Producto activo sin costo: ${product.name}`,
        detail: salesQuantityByCode.has(code)
          ? 'El producto fue vendido en el período y su receta no permite calcular un costo completo.'
          : 'Su receta no permite calcular un costo completo y no existe un respaldo aplicable.',
        observed: product.cost, code: product.code, action: 'Confirma el costo o revisa la composición de su receta.'
      });
      if (product.netPrice > 0 && product.cost > product.netPrice) add('products', {
        severity: 'high', title: `Margen negativo: ${product.name}`,
        detail: `Costo ${product.cost.toLocaleString('es-CL')} versus precio neto ${Math.round(product.netPrice).toLocaleString('es-CL')}.`,
        observed: `${product.marginPercent.toFixed(1)}%`, code: product.code,
        action: 'Revisa precio, costo y receta antes de continuar vendiéndolo.'
      });
      else if (product.marginPercent !== null && product.marginPercent < 10) add('products', {
        severity: 'medium', title: `Margen bajo: ${product.name}`,
        detail: `El margen calculado con el costo aplicable es ${product.marginPercent.toFixed(1)}%.`, observed: `${product.marginPercent.toFixed(1)}%`, code: product.code,
        action: 'Confirma que precio y costo estén actualizados.'
      });
      if (!product.hierarchyId) add('products', {
        severity: 'low', title: `Producto sin jerarquía: ${product.name}`, detail: 'No tiene una jerarquía de producto asignada.',
        code: product.code, action: 'Asigna una jerarquía para mantener completos los reportes comerciales.'
      });
    }
    for (const [code, count] of productCodeCounts) if (count > 1) add('products', {
      severity: 'high', title: `Código de producto duplicado: ${code}`, detail: `El catálogo contiene ${count} filas con el mismo código.`,
      observed: `${count} filas`, code, action: 'Conserva una única definición vigente para el código.'
    });

    let recipes = new Map();
    if (!recipeMaster || !recipeResolution.recipes.size) {
      add('recipes', {
        severity: 'high', title: 'No hay un maestro de recetas vigente', detail: `No fue posible validar recetas al ${dateTo}.`,
        action: 'Carga un maestro de recetas con vigencia aplicable.'
      });
    } else {
      recipes = recipeResolution.recipes;
      recipeResolution.errors.forEach(error => add('recipes', {
        severity: 'high', title: 'Un maestro de recetas no se pudo interpretar', detail: error,
        action: 'Revisa su estructura y encabezados.'
      }));
    }
    const recipesByCode = new Map([...recipes].map(([code, lines]) => [String(code).toUpperCase(), lines]));
    const usedIngredientCodes = new Set();
    for (const [productCode, lines] of recipesByCode) {
      if (fullCatalog.size && !fullCatalog.has(productCode)) add('recipes', {
        severity: 'medium', title: `Receta asociada a un código inexistente: ${productCode}`,
        detail: `Hay ${lines.length} componente(s) para un producto o subreceta que no está en el catálogo vigente.`, code: productCode,
        action: 'Corrige el código de cabecera o incorpora el producto al catálogo.'
      });
      lines.forEach(line => {
        const ingredientCode = line.ingredientId.toUpperCase();
        usedIngredientCodes.add(ingredientCode);
        if (line.quantity <= 0) add('recipes', {
          severity: 'high', title: `Cantidad inválida en receta ${productCode}`,
          detail: `${ingredientCode} tiene cantidad ${line.quantity}.`, observed: line.quantity, code: productCode,
          action: 'Define una cantidad mayor que cero.'
        });
        if (line.yieldRate <= 0 || line.yieldRate > 100) add('recipes', {
          severity: 'high', title: `Rendimiento fuera de rango en receta ${productCode}`,
          detail: `${ingredientCode} tiene rendimiento ${line.yieldRate}%.`, observed: `${line.yieldRate}%`, code: productCode,
          action: 'Usa un rendimiento mayor que 0% y menor o igual a 100%.'
        });
        if (!line.unit) add('recipes', {
          severity: 'high', title: `Unidad faltante en receta ${productCode}`,
          detail: `${ingredientCode} no tiene unidad de medida.`, code: productCode, action: 'Completa una unidad compatible con el ingrediente.'
        });
        if (fullCatalog.size && !fullCatalog.has(ingredientCode)) add('recipes', {
          severity: 'high', title: `Ingrediente inexistente en receta ${productCode}`,
          detail: `${ingredientCode} no aparece en el catálogo vigente.`, code: ingredientCode,
          action: 'Corrige el código o incorpora el ingrediente al catálogo.'
        });
        if (ingredientCode === productCode) add('recipes', {
          severity: 'high', title: `Referencia circular en receta ${productCode}`,
          detail: 'La receta se utiliza a sí misma como ingrediente.', code: productCode,
          action: 'Reemplaza la línea por el ingrediente o subreceta correcto.'
        });
      });
    }
    for (const [code, quantity] of salesQuantityByCode) {
      if (quantity > 0 && productByCode.has(code) && !recipesByCode.has(code) && !fullCatalog.get(code)?.stockManaged) add('recipes', {
        severity: 'medium', title: `Producto vendido sin receta: ${productByCode.get(code).name}`,
        detail: `${quantity.toLocaleString('es-CL')} unidad(es) vendidas en el período no pueden descomponerse en ingredientes.`,
        observed: `${quantity.toLocaleString('es-CL')} unidades`, code,
        action: 'Confirma si requiere receta o si corresponde a un producto de reventa.'
      });
    }
    for (const code of usedIngredientCodes) {
      const ingredient = ingredientCatalog.get(code) || fullCatalog.get(code);
      const costReference = ingredient
        ? findingsCostResolver.resolve(code, ingredient.unit, ingredient)
        : { source: 'missing', unitCost: 0 };
      if (ingredient && costReference.source === 'missing') add('costs', {
        severity: 'high', title: `Ingrediente usado sin costo: ${ingredient.name || code}`,
        detail: 'Aparece en una receta, pero no tiene costo de compra ni costo maestro aplicable.', observed: 0, code,
        action: 'Actualiza el costo antes de analizar márgenes y consumo valorizado.'
      });
    }

    const purchaseRows = [];
    const purchaseScopes = selectedLocation
      ? [selectedLocation.id]
      : auditedLocations.map(location => location.id);
    for (const location of purchaseScopes) {
      try {
        purchaseRows.push(...buildPurchasesPayload({ location, supplier: 'all', product: '', dateFrom, dateTo, auditSources: true }).rows);
      } catch (error) {
        warnings.push(`Compras (${location}): ${error.message}`);
      }
    }
    for(const location of auditedLocations) {
      const status=toteatSalesSync.purchases.status(location.type==='warehouse'?'store-1':location.id);
      sources.push({type:'Compras · '+location.name,name:status.lastSuccess?'Toteat API · bodega de la ubicación y merma':'Archivos históricos',updatedAt:status.lastSuccess});
      const purchaseState=toteatSalesSync.purchases.get(location.type==='warehouse'?'store-1':location.id);
      if(purchaseState) {
        if(purchaseState.from>dateFrom || purchaseState.through<dateTo) warnings.push(`Compras (${location.name}): cobertura API ${purchaseState.from} a ${purchaseState.through}.`);
        const unknown=(purchaseState.documents||[]).flatMap(d=>d.products||[]).filter(p=>![1,2,3,4].includes(Number(p.warehouse))).length;
        if(unknown) warnings.push(`Compras (${location.name}): ${unknown} líneas sin bodega reconocida no se asignaron a esta ubicación.`);
      }
      if(status.lastError) warnings.push(`Compras (${location.name}): la última sincronización tuvo problemas; se usa la última lectura guardada.`);
      for(const [field,label] of [['marketing','Marketing'],['employees','Colaboradores']]) {
        const file=latestWeeklyFile(location.id,field);
        if(file)sources.push({type:label+' · '+location.name,name:file.record?.originalName || 'Archivos cargados',updatedAt:file.record?.savedAt});
      }
    }
    sources.push({type:'Órdenes de compra',name:'Registros locales de Brewit'});
    for (const row of purchaseRows) {
      const evidence = [row.evidence || row];
      const creditNote = /credito|credit[ _]note|^nc$|^61$/.test(normalizeHeader(row.documentType));
      const code = String(row.code || '').toUpperCase();
      if (!code) add('purchases', { evidence,
        severity: 'high', title: `Compra sin código: ${row.product || 'Producto sin identificar'}`,
        detail: `${row.locationName} · documento ${row.document || 'sin número'}.`, date: row.date, location: row.locationName,
        action: 'Completa el código para vincular compra, costo e inventario.'
      });
      if (!row.supplierKey || row.supplierKey === 'unassigned') add('purchases', { evidence,
        severity: 'medium', title: `Proveedor no identificado: ${row.product}`,
        detail: `${row.locationName} · documento ${row.document || 'sin número'}.`, date: row.date, location: row.locationName, code: row.code,
        action: 'Corrige el RUT o agrega el proveedor al maestro.'
      });
      if (row.quantity <= 0) add('purchases', { evidence,
        severity: creditNote ? 'low' : 'medium', title: `Cantidad de compra no positiva: ${row.product}`,
        detail: `Cantidad ${row.quantity} ${row.unit || ''} en ${row.locationName}. Documento ${row.document || 'sin número'} · ${row.documentType || 'tipo no informado'}. ${creditNote ? 'Nota de crédito informada: puede corresponder a una devolución o ajuste válido.' : 'Puede corresponder a una devolución o ajuste; no se considera un error solo por su signo.'}`, observed: row.quantity, date: row.date, location: row.locationName, code: row.code,
        action: 'Revisa el documento, su referencia y los movimientos asociados antes de decidir si requiere corrección.'
      });
      if (row.listedUnitPrice <= 0 && row.quantity > 0) add('purchases', { evidence,
        severity: 'high', title: `Compra sin costo unitario: ${row.product}`,
        detail: `${row.quantity} ${row.unit || ''} registradas con costo ${row.listedUnitPrice}.`, observed: row.listedUnitPrice, date: row.date, location: row.locationName, code: row.code,
        action: 'Corrige el costo del documento de compra.'
      });
      if (row.code && row.unitsPerPurchaseUnit === null) add('purchases', { evidence,
        severity: 'medium', title: `Conversión de compra faltante: ${row.product}`,
        detail: `No se puede convertir ${row.purchaseUnit || row.unit || 'la unidad de compra'} a la unidad base.`, date: row.date, location: row.locationName, code: row.code,
        action: 'Agrega la conversión de unidad en el catálogo maestro.'
      });
      const variation = Number(row.unitCostChangePercent);
      if (Number.isFinite(variation) && Math.abs(variation) >= 15) add('costs', { evidence,
        severity: Math.abs(variation) >= 30 ? 'high' : 'medium',
        title: `${variation > 0 ? 'Aumento' : 'Disminución'} relevante de costo: ${row.product}`,
        detail: `El costo comparable cambió ${variation.toFixed(1)}% en ${row.locationName}.`, observed: `${variation.toFixed(1)}%`,
        date: row.date, location: row.locationName, code: row.code,
        action: 'Confirma el documento, la unidad de compra y la negociación con el proveedor.'
      });
    }

    for (const location of auditedLocations) {
      const state = stockSync.current(location.id);
      if (state?.sourceKind === 'public-inventory') {
        sources.push({type:'Inventario · '+location.name,name:'Toteat API pública · saldos con compensaciones y consumos internos',updatedAt:state.sourceCapturedAt,range:state.range});
        try {
          const basis=apiProjectionBasis(location,dateTo,state,dateFrom);
          warnings.push(...basis.warnings.map(message=>`${location.name}: ${message}`));
          if (!basis.items.length || basis.to < dateTo || basis.from > dateFrom || basis.excluded.length) add('inventory',{
            title:`Cobertura de inventario incompleta: ${location.name}`,location:location.name,
            detail:basis.warnings.join(' '),action:'Actualiza las fuentes de inventario y verifica las tomas físicas. No se supone stock cero donde faltan datos.'
          });
          for (const product of basis.items) {
            if(product.currentInventory < -0.005) add('inventory',{
              severity:'high',title:`Inventario negativo: ${product.name || product.code}`,
              detail:`${product.currentInventory.toLocaleString('es-CL')} ${product.unit} al ${basis.to} en ${location.name}. Incluye compensaciones y consumos internos.`,
              observed:product.currentInventory,date:basis.to,location:location.name,code:product.code,
              action:'Revisa movimientos, unidades y conteos físicos en las fuentes sincronizadas.'
            });
            else if(Math.abs(product.currentInventory)<0.005 && product.consumption30>0) add('inventory',{
              title:`Producto consumido sin stock: ${product.name || product.code}`,
              detail:`Stock teórico cero y salidas netas de ${product.consumption30.toLocaleString('es-CL')} ${product.unit} desde ${product.consumptionFrom}.`,
              observed:'Stock 0',date:basis.to,location:location.name,code:product.code,action:'Confirma el stock físico y evalúa reposición.'
            });
          }
        } catch(error) {
          warnings.push(`Inventario API (${location.name}): ${error.message}`);
          add('inventory',{title:`Inventario API no calculable: ${location.name}`,location:location.name,detail:error.message,action:'Actualiza las fuentes de inventario y los maestros compartidos.'});
        }
        continue;
      }
      sources.push({type:'Inventario · '+location.name,name:'Kardex histórico (sin inventario API sincronizado)'});
      let kardex;
      try { kardex = mergedKardexData(location.id, 'kardex'); } catch (error) {
        warnings.push(`Kardex (${location.name}): ${error.message}`);
        kardex = null;
      }
      if (!kardex?.groups?.length) {
        add('inventory', {
          severity: 'medium', title: `Sin Kardex utilizable: ${location.name}`,
          detail: 'No hay información consolidable de inventario.', location: location.name,
          action: 'Carga el Kardex más reciente de la ubicación.'
        });
        continue;
      }
      const groups = kardex.groups.filter(group => group.date <= dateTo);
      const latestGroup = groups.at(-1);
      if (!latestGroup || latestGroup.date < dateFrom) {
        add('inventory', {
          severity: 'medium', title: `Kardex desactualizado: ${location.name}`,
          detail: latestGroup ? `La última fecha disponible es ${latestGroup.date}.` : `No hay fechas anteriores o iguales a ${dateTo}.`,
          observed: latestGroup?.date || 'Sin fecha', location: location.name,
          action: 'Carga un Kardex que cubra el período seleccionado.'
        });
        continue;
      }
      const periodGroups = groups.filter(group => group.date >= dateFrom);
      const hasFinal = latestGroup.metrics.some(metric => metric.normalized.startsWith('if -'));
      for (const product of kardex.products) {
        if (!product.code && !product.name) continue;
        const currentInventory = kardexMetricValue(product, latestGroup,
          metric => metric.startsWith(hasFinal ? 'if -' : 'ii -'));
        const consumption = periodGroups.reduce((sum, group) => sum + kardexMetricTotal(product, group,
          metric => metric.startsWith('uso -') || metric.startsWith('trl-out -')
            || metric.startsWith('mov-out -') || metric.startsWith('trn-out -')), 0);
        if (currentInventory < -0.005) add('inventory', {
          severity: 'high', title: `Inventario negativo: ${product.name || product.code}`,
          detail: `${currentInventory.toLocaleString('es-CL')} ${product.unit || ''} al ${latestGroup.date} en ${location.name}.`,
          observed: currentInventory, date: latestGroup.date, location: location.name, code: product.code,
          action: 'Revisa movimientos, unidades y conteo físico antes de proyectar compras.'
        });
        else if (Math.abs(currentInventory) < 0.005 && consumption > 0) add('inventory', {
          severity: 'medium', title: `Producto consumido sin stock: ${product.name || product.code}`,
          detail: `Stock final cero y consumo de ${consumption.toLocaleString('es-CL')} ${product.unit || ''} en el período.`,
          observed: 'Stock 0', date: latestGroup.date, location: location.name, code: product.code,
          action: 'Confirma el stock físico y evalúa reposición.'
        });
        if (!product.code) add('inventory', {
          severity: 'medium', title: `Fila de Kardex sin código: ${product.name}`,
          detail: `${location.name} · ${latestGroup.date}.`, date: latestGroup.date, location: location.name,
          action: 'Completa el código para relacionar inventario, compras y costos.'
        });
      }
    }

    const orders = readPurchaseOrders().filter(order => {
      const date = String(order.updatedAt || order.createdAt || '').slice(0, 10);
      return date >= dateFrom && date <= dateTo
        && (!selectedLocation || order.location?.id === selectedLocation.id);
    });
    for (const order of orders) {
      const date = String(order.updatedAt || order.createdAt || '').slice(0, 10);
      const label = order.orderNumber || order.id;
      if (!order.supplier?.key || order.supplier.key === 'unassigned') add('purchase-orders', {
        severity: 'high', title: `Orden sin proveedor: ${label}`, detail: `${order.location?.name || 'Ubicación no identificada'} · ${date}.`,
        date, location: order.location?.name, action: 'Asigna un proveedor válido antes de utilizar la orden.'
      });
      if (order.status !== 'confirmed' && date < addDays(dateTo, -3)) add('purchase-orders', {
        severity: 'medium', title: `Orden pendiente hace más de 3 días: ${label}`,
        detail: `Estado “${order.status || 'sin estado'}” desde ${date}.`, date, location: order.location?.name,
        action: 'Confirma, corrige u oculta la orden si ya no corresponde.'
      });
      if (order.status === 'confirmed' && !order.confirmedAt) add('purchase-orders', {
        severity: 'medium', title: `Orden confirmada sin fecha: ${label}`, detail: 'El estado y la fecha de confirmación no son consistentes.',
        date, location: order.location?.name, action: 'Revisa el registro de confirmación de la orden.'
      });
      const calculatedTotal = (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitCost) || 0), 0);
      if (Math.abs(calculatedTotal - (Number(order.total) || 0)) > 1) add('purchase-orders', {
        severity: 'high', title: `Total inconsistente en ${label}`,
        detail: `Total guardado ${Number(order.total || 0).toLocaleString('es-CL')}; suma de líneas ${calculatedTotal.toLocaleString('es-CL')}.`,
        observed: calculatedTotal - Number(order.total || 0), date, location: order.location?.name,
        action: 'Recalcula la orden y confirma cantidades y costos unitarios.'
      });
      for (const item of order.items || []) {
        if (!(Number(item.quantity) > 0)) add('purchase-orders', {
          severity: 'high', title: `Cantidad inválida en ${label}: ${item.name || item.code}`,
          detail: `Cantidad registrada: ${item.quantity}.`, observed: item.quantity, date, location: order.location?.name, code: item.code,
          action: 'Corrige o elimina la línea de la orden.'
        });
        if (!(Number(item.unitCost) > 0)) add('purchase-orders', {
          severity: 'medium', title: `Costo cero en ${label}: ${item.name || item.code}`,
          detail: `Costo unitario registrado: ${item.unitCost || 0}.`, observed: item.unitCost || 0, date, location: order.location?.name, code: item.code,
          action: 'Confirma el costo con el proveedor.'
        });
        const referenceCost = Number(item.referenceUnitCost);
        const unitCost = Number(item.unitCost);
        if (referenceCost > 0 && Number.isFinite(unitCost)) {
          const difference = (unitCost / referenceCost - 1) * 100;
          if (Math.abs(difference) >= 20) add('purchase-orders', {
            severity: 'medium', title: `Costo modificado en ${label}: ${item.name || item.code}`,
            detail: `El costo de la orden difiere ${difference.toFixed(1)}% de la referencia.`, observed: `${difference.toFixed(1)}%`,
            date, location: order.location?.name, code: item.code,
            action: 'Confirma que la modificación sea intencional.'
          });
        }
      }
    }

    const serializedSections = [...sections.values()].map(section => ({
      ...section,
      findings: section.findings.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
        || String(right.date || '').localeCompare(String(left.date || ''))
        || left.title.localeCompare(right.title, 'es'))
    }));
    const findings = serializedSections.flatMap(section => section.findings);
    return {
      sourceModel: 3,
      generatedAt: new Date().toISOString(),
      period: { from: dateFrom, to: dateTo },
      scope: selectedLocation
        ? { location: selectedLocation.id, label: selectedLocation.name, type: selectedLocation.type }
        : { location: 'all', label: 'Todas las ubicaciones', type: 'all' },
      locations: locations.map(publicLocation),
      summary: {
        total: findings.length,
        high: findings.filter(finding => finding.severity === 'high').length,
        medium: findings.filter(finding => finding.severity === 'medium').length,
        low: findings.filter(finding => finding.severity === 'low').length,
        sectionsWithFindings: serializedSections.filter(section => section.findings.length).length,
        salesRowsRead,
        purchaseRowsRead: purchaseRows.length,
        ordersRead: orders.length
      },
      sections: serializedSections,
      sources,
      warnings
    };
  }

  function findingFingerprint(sectionKey, finding) {
    const identity = [
      sectionKey,
      normalizeHeader(finding.title),
      String(finding.code || '').trim().toUpperCase(),
      normalizeHeader(finding.location),
      String(finding.date || '')
    ];
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  function publicStoredFinding(record) {
    const { fingerprint, affectedLocationId, scopeLocation, ...finding } = record;
    return finding;
  }

  function persistFindingsPayload(payload) {
    const registry = readFindingsRegistry();
    const now = new Date().toISOString();
    const locationIdsByName = new Map(payload.locations.map(location => [normalizeHeader(location.name), location.id]));
    const generated = payload.sections.flatMap(section => section.findings.map(finding => ({ section, finding })));
    let added = 0;
    let reused = 0;

    for (const { section, finding } of generated) {
      const fingerprint = findingFingerprint(section.key, finding);
      const existing = registry.records.find(record => record.fingerprint === fingerprint
        && record.occurrenceDate >= payload.period.from && record.occurrenceDate <= payload.period.to);
      const common = {
        sectionKey: section.key,
        sourceModel: payload.sourceModel,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        evidence: finding.evidence || [],
        action: finding.action,
        date: finding.date,
        location: finding.location,
        code: finding.code,
        observed: finding.observed,
        lastSeenAt: now,
        lastSeenPeriod: { ...payload.period }
      };
      if (existing) {
        Object.assign(existing, common);
        reused += 1;
        continue;
      }
      registry.lastNumber += 1;
      registry.records.push({
        id: `H-${String(registry.lastNumber).padStart(6, '0')}`,
        number: registry.lastNumber,
        fingerprint,
        affectedLocationId: finding.location ? locationIdsByName.get(normalizeHeader(finding.location)) || null : null,
        scopeLocation: payload.scope.location,
        occurrenceDate: finding.date || payload.period.to,
        observations: '',
        closed: false,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        ...common
      });
      added += 1;
    }

    writeJsonAtomic(findingsRegistryPath, registry);
    const matchesScope = record => payload.scope.location === 'all'
      || record.affectedLocationId === payload.scope.location
      || (!record.affectedLocationId && ['all', payload.scope.location].includes(record.scopeLocation));
    // Retain obsolete findings and their notes on disk, but exclude the retired master comparison.
    const records = registry.records.filter(record => !record.title.startsWith('Costo maestro desalineado:')
      && record.occurrenceDate >= payload.period.from
      && record.occurrenceDate <= payload.period.to && matchesScope(record)
      && (record.sourceModel === payload.sourceModel || record.closed));
    const previousSources = registry.records.filter(record => !record.closed && record.sourceModel !== payload.sourceModel
      && record.occurrenceDate >= payload.period.from && record.occurrenceDate <= payload.period.to && matchesScope(record)).length;
    if(previousSources) payload.warnings.push(`${previousSources} hallazgos históricos de fuentes anteriores no se incluyen en esta revisión; sus registros y observaciones se conservan.`);
    const severityOrder = { high: 0, medium: 1, low: 2 };
    const sections = payload.sections.map(section => ({
      key: section.key,
      label: section.label,
      description: section.description,
      findings: records.filter(record => record.sectionKey === section.key)
        .sort((left, right) => Number(left.closed) - Number(right.closed)
          || severityOrder[left.severity] - severityOrder[right.severity]
          || String(right.occurrenceDate || '').localeCompare(String(left.occurrenceDate || ''))
          || left.number - right.number)
        .map(publicStoredFinding)
    }));
    const visibleFindings = sections.flatMap(section => section.findings);
    return {
      ...payload,
      sections,
      summary: {
        ...payload.summary,
        total: visibleFindings.length,
        open: visibleFindings.filter(finding => !finding.closed).length,
        closed: visibleFindings.filter(finding => finding.closed).length,
        high: visibleFindings.filter(finding => finding.severity === 'high').length,
        medium: visibleFindings.filter(finding => finding.severity === 'medium').length,
        low: visibleFindings.filter(finding => finding.severity === 'low').length,
        sectionsWithFindings: sections.filter(section => section.findings.length).length,
        generated: generated.length,
        added,
        reused
      }
    };
  }

  app.get('/api/findings', (req, res) => {
    try {
      return res.json(persistFindingsPayload(buildFindingsPayload(req.query)));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No fue posible buscar hallazgos.' });
    }
  });

  app.patch('/api/findings/:id', express.json(), (req, res) => {
    try {
      const registry = readFindingsRegistry();
      const finding = registry.records.find(record => record.id === req.params.id);
      if (!finding) return res.status(404).json({ error: 'No se encontró el hallazgo solicitado.' });
      if (Object.hasOwn(req.body || {}, 'observations')) {
        if (typeof req.body.observations !== 'string' || req.body.observations.length > 5000) {
          return res.status(400).json({ error: 'Las observaciones deben contener hasta 5.000 caracteres.' });
        }
        finding.observations = req.body.observations.trim();
      }
      if (Object.hasOwn(req.body || {}, 'closed')) {
        if (typeof req.body.closed !== 'boolean') {
          return res.status(400).json({ error: 'El estado cerrado debe ser verdadero o falso.' });
        }
        finding.closed = req.body.closed;
        finding.closedAt = finding.closed ? new Date().toISOString() : null;
      }
      finding.updatedAt = new Date().toISOString();
      writeJsonAtomic(findingsRegistryPath, registry);
      return res.json({ finding: publicStoredFinding(finding) });
    } catch (error) {
      return res.status(500).json({ error: error.message || 'No se pudo actualizar el hallazgo.' });
    }
  });

  function buildHourlySalesDemand(requestedLocation = 'all', query = {}) {
    const todayKey = projectionToday();
    const automaticModes = new Set([
      'current-week', 'previous-week', 'current-month', 'previous-month',
      'last-30-days', 'last-60-days', 'last-90-days', 'last-180-days', 'last-360-days'
    ]);
    const mode = ['date', 'recent', 'same-weekday', 'weekdays', ...automaticModes].includes(String(query.mode))
      ? String(query.mode)
      : 'recent';
    const automaticPeriod = automaticModes.has(mode);
    const referenceDate = automaticPeriod
      ? todayKey
      : /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || '')) ? String(query.date) : todayKey;
    const intervalHours = Number(query.interval) === 1 ? 1 : 2;
    const requestedDays = Math.min(90, Math.max(1, Math.trunc(Number(query.days) || 7)));
    const activeStores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const selectedStore = requestedLocation === 'all' ? null : activeStores.find(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedStore) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    const stores = selectedStore ? [selectedStore] : activeStores;
    const hierarchyMaster = latestMasterFile('product-hierarchy', referenceDate);
    let hierarchyLookup = null;
    if (hierarchyMaster) {
      try { hierarchyLookup = parseProductHierarchies(hierarchyMaster.filePath); } catch { hierarchyLookup = null; }
    }
    const facts = [];
    const seenRows = new Set();
    const warnings = [];
    let filesRead = 0;
    for (const location of stores) {
      for (const stored of storedSalesFiles(location.id)) {
        try {
          for (const row of readSalesRows(stored.filePath)) {
            const dateTime = salesTransactionDateTime(row);
            const date = dateTime?.slice(0, 10);
            if (!date || date > referenceDate || dateIsExcluded(date, stored.excludedRanges)) continue;
            const canonicalRow = Object.entries(row)
              .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
              .sort(([left], [right]) => left.localeCompare(right));
            const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
            if (seenRows.has(rowKey)) continue;
            seenRows.add(rowKey);
            const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim();
            const name = repairMojibake(rowValue(row, ['Nombre', 'Producto']));
            if (!code && !name) continue;
            const hierarchyId = String(rowValue(row, ['AB.']) ?? '').trim();
            const hierarchyNode = hierarchyLookup?.hierarchyMap.get(hierarchyId);
            const hierarchyPath = hierarchyNode ? hierarchyLookup.pathFor(hierarchyNode.id) : [];
            const fallbackHierarchy = repairMojibake(rowValue(row, ['Categorías de Productos/Platos', 'Categorias de Productos/Platos']))
              || 'Sin jerarquía';
            const time = dateTime.slice(11);
            const hour = Number(time.slice(0, 2)) + Number(time.slice(3, 5)) / 60;
            facts.push({
              date,
              time,
              hour,
              code,
              name: name || code,
              quantity: numericValue(rowValue(row, ['Cantidad'])) || 0,
              netSales: ((numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar', 'Precio Lista'])) || 0)
                + (numericValue(rowValue(row, ['Descuento'])) || 0)) / 1.19,
              hierarchyPath: hierarchyPath.length ? hierarchyPath : [fallbackHierarchy]
            });
          }
          filesRead += 1;
        } catch {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    const openDates = [...new Set(facts.map(fact => fact.date))].sort().reverse();
    const weekdayFor = date => new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const currentWeekStart = mondayContaining(todayKey);
    const currentMonthStart = `${todayKey.slice(0, 7)}-01`;
    const previousMonthEnd = addDays(currentMonthStart, -1);
    const automaticRanges = {
      'current-week': { from: currentWeekStart, to: todayKey },
      'previous-week': { from: addDays(currentWeekStart, -7), to: addDays(currentWeekStart, -1) },
      'current-month': { from: currentMonthStart, to: todayKey },
      'previous-month': { from: `${previousMonthEnd.slice(0, 7)}-01`, to: previousMonthEnd },
      'last-30-days': { from: addDays(todayKey, -29), to: todayKey },
      'last-60-days': { from: addDays(todayKey, -59), to: todayKey },
      'last-90-days': { from: addDays(todayKey, -89), to: todayKey },
      'last-180-days': { from: addDays(todayKey, -179), to: todayKey },
      'last-360-days': { from: addDays(todayKey, -359), to: todayKey }
    };
    const selectedRange = automaticRanges[mode] || null;
    let eligibleDates;
    if (selectedRange) eligibleDates = openDates.filter(date => date >= selectedRange.from && date <= selectedRange.to);
    else if (mode === 'date') eligibleDates = openDates.filter(date => date === referenceDate).slice(0, 1);
    else if (mode === 'same-weekday') {
      const weekday = weekdayFor(referenceDate);
      eligibleDates = openDates.filter(date => weekdayFor(date) === weekday).slice(0, requestedDays);
    } else if (mode === 'weekdays') {
      eligibleDates = openDates.filter(date => {
        const weekday = weekdayFor(date);
        return weekday >= 1 && weekday <= 5;
      }).slice(0, requestedDays);
    } else eligibleDates = openDates.slice(0, requestedDays);
    const selectedDateSet = new Set(eligibleDates);
    const divisor = mode === 'date' ? 1 : Math.max(1, eligibleDates.length);
    const buckets = [];
    for (let fromHour = 7; fromHour < 21; fromHour += intervalHours) {
      const toHour = Math.min(21, fromHour + intervalHours);
      const products = new Map();
      facts.filter(fact => selectedDateSet.has(fact.date) && fact.hour >= fromHour && fact.hour < toHour).forEach(fact => {
        const key = `${fact.code || normalizeHeader(fact.name)}:${fact.hierarchyPath.join('\u001f')}`;
        const product = products.get(key) || {
          code: fact.code,
          name: fact.name,
          hierarchyPath: fact.hierarchyPath,
          quantity: 0,
          netSales: 0,
          dailyUnits: {},
          dailyNetSales: {}
        };
        product.quantity += fact.quantity / divisor;
        product.netSales += fact.netSales / divisor;
        product.dailyUnits[fact.date] = (product.dailyUnits[fact.date] || 0) + fact.quantity;
        product.dailyNetSales[fact.date] = (product.dailyNetSales[fact.date] || 0) + fact.netSales;
        products.set(key, product);
      });
      const values = [...products.values()];
      const dailyQuantities = eligibleDates.slice().sort().map(date => ({
        date,
        quantity: values.reduce((sum, product) => sum + (Number(product.dailyUnits[date]) || 0), 0)
      }));
      const dailyNetSales = eligibleDates.slice().sort().map(date => ({
        date,
        netSales: values.reduce((sum, product) => sum + (Number(product.dailyNetSales[date]) || 0), 0)
      }));
      buckets.push({
        fromHour,
        toHour,
        label: `${String(fromHour).padStart(2, '0')}:00–${String(toHour).padStart(2, '0')}:00`,
        quantity: values.reduce((sum, product) => sum + product.quantity, 0),
        netSales: values.reduce((sum, product) => sum + product.netSales, 0),
        minQuantity: dailyQuantities.length ? Math.min(...dailyQuantities.map(item => item.quantity)) : 0,
        maxQuantity: dailyQuantities.length ? Math.max(...dailyQuantities.map(item => item.quantity)) : 0,
        dailyQuantities,
        minNetSales: dailyNetSales.length ? Math.min(...dailyNetSales.map(item => item.netSales)) : 0,
        maxNetSales: dailyNetSales.length ? Math.max(...dailyNetSales.map(item => item.netSales)) : 0,
        dailyNetSales,
        products: values.sort((left, right) => right.quantity - left.quantity || right.netSales - left.netSales)
      });
    }
    const selectedDates = eligibleDates.slice().sort();
    const dailyTotals = selectedDates.map(date => ({
      date,
      quantity: buckets.reduce((sum, bucket) => sum
        + (bucket.dailyQuantities.find(item => item.date === date)?.quantity || 0), 0),
      netSales: buckets.reduce((sum, bucket) => sum
        + (bucket.dailyNetSales.find(item => item.date === date)?.netSales || 0), 0)
    }));
    return {
      scope: selectedStore
        ? { type: 'location', location: selectedStore.id, label: selectedStore.name }
        : { type: 'all', location: null, label: 'Todas las cafeterías' },
      filters: {
        mode,
        date: automaticPeriod ? null : referenceDate,
        days: automaticPeriod || mode === 'date' ? null : requestedDays,
        intervalHours,
        range: selectedRange
      },
      selectedDates,
      sampleSize: eligibleDates.length,
      isAverage: mode !== 'date',
      openDateCount: openDates.length,
      buckets,
      totals: {
        quantity: buckets.reduce((sum, bucket) => sum + bucket.quantity, 0),
        netSales: buckets.reduce((sum, bucket) => sum + bucket.netSales, 0),
        minQuantity: dailyTotals.length ? Math.min(...dailyTotals.map(item => item.quantity)) : 0,
        maxQuantity: dailyTotals.length ? Math.max(...dailyTotals.map(item => item.quantity)) : 0,
        dailyQuantities: dailyTotals.map(({ date, quantity }) => ({ date, quantity })),
        minNetSales: dailyTotals.length ? Math.min(...dailyTotals.map(item => item.netSales)) : 0,
        maxNetSales: dailyTotals.length ? Math.max(...dailyTotals.map(item => item.netSales)) : 0,
        dailyNetSales: dailyTotals.map(({ date, netSales }) => ({ date, netSales }))
      },
      filesRead,
      warnings
    };
  }

  function buildHourlySalesAnalysis(requestedLocation = 'all', query = {}) {
    const report = buildHourlySalesDemand(requestedLocation, query);
    const analysisLevel = ['general', 'hierarchy', 'product'].includes(String(query.analysisLevel))
      ? String(query.analysisLevel)
      : 'general';
    let hierarchyPath = [];
    try {
      const parsed = JSON.parse(String(query.hierarchyPath || '[]'));
      if (Array.isArray(parsed)) hierarchyPath = parsed.slice(0, 12).map(value => String(value).slice(0, 160));
    } catch {}
    const productKey = String(query.productKey || '').slice(0, 400);
    const productIdentity = product => `${product.code || ''}\u001f${product.name || ''}`;
    const matchesSelection = product => hierarchyPath.every((name, index) => product.hierarchyPath[index] === name)
      && (!productKey || productIdentity(product) === productKey);
    const dates = report.selectedDates.slice().sort();
    const round = (value, decimals = 2) => Number(Number(value || 0).toFixed(decimals));
    const statistics = values => {
      const clean = values.map(Number).filter(Number.isFinite);
      if (!clean.length) return { count: 0, sum: 0, mean: 0, median: 0, min: 0, max: 0, variance: 0, standardDeviation: 0, coefficientOfVariation: null };
      const sum = clean.reduce((total, value) => total + value, 0);
      const mean = sum / clean.length;
      const sorted = clean.slice().sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      const variance = clean.length > 1
        ? clean.reduce((total, value) => total + (value - mean) ** 2, 0) / (clean.length - 1)
        : 0;
      const standardDeviation = Math.sqrt(variance);
      return {
        count: clean.length,
        sum: round(sum),
        mean: round(mean),
        median: round(median),
        min: round(sorted[0]),
        max: round(sorted.at(-1)),
        variance: round(variance),
        standardDeviation: round(standardDeviation),
        coefficientOfVariation: mean ? round(standardDeviation / Math.abs(mean) * 100, 1) : null
      };
    };
    const regression = values => {
      if (values.length < 2) return { slope: 0, rSquared: 0, estimatedChangePercent: 0 };
      const xMean = (values.length - 1) / 2;
      const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const denominator = values.reduce((sum, value, index) => sum + (index - xMean) ** 2, 0);
      const slope = denominator
        ? values.reduce((sum, value, index) => sum + (index - xMean) * (value - yMean), 0) / denominator
        : 0;
      const intercept = yMean - slope * xMean;
      const totalVariation = values.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
      const residualVariation = values.reduce((sum, value, index) => sum + (value - (intercept + slope * index)) ** 2, 0);
      const rSquared = totalVariation ? Math.max(0, 1 - residualVariation / totalVariation) : 0;
      return {
        slope: round(slope),
        rSquared: round(rSquared, 3),
        estimatedChangePercent: yMean ? round(slope * (values.length - 1) / Math.abs(yMean) * 100, 1) : 0
      };
    };
    const bucketRows = report.buckets.map(bucket => {
      const products = bucket.products.filter(matchesSelection);
      const daily = dates.map(date => ({
        date,
        units: products.reduce((sum, product) => sum + (Number(product.dailyUnits?.[date]) || 0), 0),
        netSales: products.reduce((sum, product) => sum + (Number(product.dailyNetSales?.[date]) || 0), 0)
      }));
      return {
        label: bucket.label,
        daily,
        unitStats: statistics(daily.map(item => item.units)),
        salesStats: statistics(daily.map(item => item.netSales))
      };
    });
    const dailyRows = dates.map(date => ({
      date,
      units: bucketRows.reduce((sum, bucket) => sum + (bucket.daily.find(item => item.date === date)?.units || 0), 0),
      netSales: bucketRows.reduce((sum, bucket) => sum + (bucket.daily.find(item => item.date === date)?.netSales || 0), 0)
    }));
    const unitStats = statistics(dailyRows.map(item => item.units));
    const salesStats = statistics(dailyRows.map(item => item.netSales));
    const unitTrend = regression(dailyRows.map(item => item.units));
    const salesTrend = regression(dailyRows.map(item => item.netSales));
    const weekdayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const weekdayGroups = new Map();
    dailyRows.forEach(item => {
      const weekday = new Date(`${item.date}T12:00:00Z`).getUTCDay();
      if (!weekdayGroups.has(weekday)) weekdayGroups.set(weekday, []);
      weekdayGroups.get(weekday).push(item);
    });
    const weekdayRows = [...weekdayGroups].sort(([left], [right]) => ((left + 6) % 7) - ((right + 6) % 7)).map(([weekday, items]) => ({
      weekday,
      label: weekdayNames[weekday],
      sampleSize: items.length,
      units: statistics(items.map(item => item.units)),
      netSales: statistics(items.map(item => item.netSales)),
      revenuePerUnit: round(items.reduce((sum, item) => sum + item.netSales, 0)
        / Math.max(1, items.reduce((sum, item) => sum + item.units, 0)))
    }));
    const totalAverageUnits = bucketRows.reduce((sum, bucket) => sum + bucket.unitStats.mean, 0);
    const totalAverageSales = bucketRows.reduce((sum, bucket) => sum + bucket.salesStats.mean, 0);
    bucketRows.forEach(bucket => {
      bucket.unitShare = round(totalAverageUnits ? bucket.unitStats.mean / totalAverageUnits * 100 : 0, 1);
      bucket.salesShare = round(totalAverageSales ? bucket.salesStats.mean / totalAverageSales * 100 : 0, 1);
      bucket.revenuePerUnit = round(bucket.unitStats.sum ? bucket.salesStats.sum / bucket.unitStats.sum : 0);
    });
    const standardized = (value, stats) => stats.standardDeviation ? (value - stats.mean) / stats.standardDeviation : 0;
    dailyRows.forEach(item => {
      const weekday = new Date(`${item.date}T12:00:00Z`).getUTCDay();
      const weekdayStats = weekdayRows.find(row => row.weekday === weekday);
      const useWeekdayBaseline = weekdayStats?.sampleSize >= 2;
      item.weekday = weekdayNames[weekday];
      item.revenuePerUnit = round(item.units ? item.netSales / item.units : 0);
      item.expectedUnits = useWeekdayBaseline ? weekdayStats.units.mean : unitStats.mean;
      item.expectedNetSales = useWeekdayBaseline ? weekdayStats.netSales.mean : salesStats.mean;
      item.unitResidual = item.units - item.expectedUnits;
      item.salesResidual = item.netSales - item.expectedNetSales;
      item.anomalyBaseline = useWeekdayBaseline ? 'día de semana' : 'promedio general';
    });
    const unitResidualStats = statistics(dailyRows.map(item => item.unitResidual));
    const salesResidualStats = statistics(dailyRows.map(item => item.salesResidual));
    dailyRows.forEach(item => {
      item.unitZScore = round(standardized(item.unitResidual, unitResidualStats));
      item.salesZScore = round(standardized(item.salesResidual, salesResidualStats));
    });
    const anomalies = dailyRows.filter(item => dates.length >= 5
      && (Math.abs(item.unitZScore) >= 2 || Math.abs(item.salesZScore) >= 2));
    const priorityOrder = { high: 0, medium: 1, info: 2 };
    const findings = [];
    const addFinding = finding => findings.push({
      id: `R-${findings.length + 1}`,
      priority: 'info',
      possibleExplanations: [],
      questions: [],
      ...finding
    });
    const formatNumber = value => Number(value || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const formatMoney = value => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
    const peakUnits = bucketRows.slice().sort((left, right) => right.unitStats.mean - left.unitStats.mean)[0];
    const peakSales = bucketRows.slice().sort((left, right) => right.salesStats.mean - left.salesStats.mean)[0];
    if (peakUnits) addFinding({
      category: 'Concentración horaria',
      title: `La mayor demanda se concentra entre ${peakUnits.label}`,
      conclusion: `Esta franja promedia ${formatNumber(peakUnits.unitStats.mean)} unidades y representa ${formatNumber(peakUnits.unitShare)}% de las unidades del día analizado.`,
      evidence: `Rango ${formatNumber(peakUnits.unitStats.min)}–${formatNumber(peakUnits.unitStats.max)} unidades; facturación promedio ${formatMoney(peakUnits.salesStats.mean)}.`,
      questions: ['¿La dotación, preparación previa y disponibilidad de productos están dimensionadas para esta concentración?']
    });
    if (peakSales && peakSales.label !== peakUnits?.label) addFinding({
      category: 'Composición de venta',
      title: `La franja de mayor facturación no coincide con la de más unidades`,
      conclusion: `${peakSales.label} lidera en facturación con ${formatMoney(peakSales.salesStats.mean)}, mientras ${peakUnits.label} lidera en volumen.`,
      evidence: `Venta por unidad: ${formatMoney(peakSales.revenuePerUnit)} en ${peakSales.label} versus ${formatMoney(peakUnits.revenuePerUnit)} en ${peakUnits.label}.`,
      possibleExplanations: ['Mezcla de productos de mayor precio.', 'Mayor incidencia de combos, tamaños grandes o productos complementarios.'],
      questions: ['¿Qué productos explican el mayor valor por unidad en esa franja?']
    });
    const addTrendFinding = (label, trend, stats, formatter) => {
      const magnitude = Math.abs(trend.estimatedChangePercent);
      if (dates.length < 3) return;
      addFinding({
        priority: magnitude >= 20 && trend.rSquared >= 0.25 ? 'medium' : 'info',
        category: 'Tendencia',
        title: magnitude >= 10
          ? `${label} con tendencia ${trend.estimatedChangePercent > 0 ? 'creciente' : 'decreciente'}`
          : `${label} sin una tendencia lineal marcada`,
        conclusion: magnitude >= 10
          ? `La recta de tendencia estima un cambio de ${formatNumber(trend.estimatedChangePercent)}% entre el inicio y el cierre de la muestra.`
          : `El cambio lineal estimado es ${formatNumber(trend.estimatedChangePercent)}%, por lo que domina la variación diaria sobre una dirección sostenida.`,
        evidence: `Pendiente ${formatter(trend.slope)} por día observado; R² ${formatNumber(trend.rSquared)}; promedio ${formatter(stats.mean)}.`,
        possibleExplanations: magnitude >= 10 ? ['Cambios de afluencia, estacionalidad, promociones o disponibilidad.', 'Efecto del calendario y composición de días de semana.'] : [],
        questions: magnitude >= 10 ? ['¿Hubo cambios comerciales, operativos o externos coincidentes con el comienzo de la tendencia?'] : []
      });
    };
    addTrendFinding('Las unidades', unitTrend, unitStats, formatNumber);
    addTrendFinding('La facturación', salesTrend, salesStats, formatMoney);
    if (anomalies.length) addFinding({
      priority: anomalies.some(item => Math.abs(item.unitZScore) >= 2.5 || Math.abs(item.salesZScore) >= 2.5) ? 'high' : 'medium',
      category: 'Anomalías',
      title: `${anomalies.length} día(s) fuera del comportamiento habitual`,
      conclusion: anomalies.map(item => `${item.date}: ${formatNumber(item.units)} unidades y ${formatMoney(item.netSales)}`).join(' · '),
      evidence: `Se marcaron observaciones a dos o más desviaciones estándar después de descontar el patrón del día de semana cuando había al menos dos fechas comparables.`,
      possibleExplanations: ['Promoción o evento excepcional.', 'Feriado, clima, cierre parcial o cambio de horario.', 'Quiebre de stock, error de carga o transacciones atípicas.'],
      questions: ['¿Qué ocurrió operativa o comercialmente en esas fechas?', '¿Los archivos contienen el día completo y sin duplicados?']
    });
    const volatileBucket = bucketRows.slice().sort((left, right) => (right.unitStats.coefficientOfVariation || 0)
      - (left.unitStats.coefficientOfVariation || 0))[0];
    if (volatileBucket) addFinding({
      priority: (volatileBucket.unitStats.coefficientOfVariation || 0) >= 50 ? 'medium' : 'info',
      category: 'Variabilidad',
      title: `${volatileBucket.label} es la franja más variable en unidades`,
      conclusion: `Su coeficiente de variación es ${formatNumber(volatileBucket.unitStats.coefficientOfVariation)}%, con un rango de ${formatNumber(volatileBucket.unitStats.min)} a ${formatNumber(volatileBucket.unitStats.max)} unidades.`,
      evidence: `Varianza ${formatNumber(volatileBucket.unitStats.variance)} y desviación estándar ${formatNumber(volatileBucket.unitStats.standardDeviation)}.`,
      possibleExplanations: ['Dependencia de pedidos puntuales, grupos o mix de días.', 'Diferencias de apertura, promociones o disponibilidad entre jornadas.'],
      questions: ['¿Conviene revisar esta franja separando días de semana, promociones o eventos?']
    });
    if (weekdayRows.length > 1) {
      const highest = weekdayRows.slice().sort((left, right) => right.units.mean - left.units.mean)[0];
      const lowest = weekdayRows.slice().sort((left, right) => left.units.mean - right.units.mean)[0];
      const difference = lowest.units.mean ? (highest.units.mean / lowest.units.mean - 1) * 100 : 0;
      addFinding({
        priority: Math.abs(difference) >= 25 && highest.sampleSize >= 2 && lowest.sampleSize >= 2 ? 'medium' : 'info',
        category: 'Día de semana',
        title: `${highest.label} presenta el mayor promedio diario`,
        conclusion: `${highest.label}: ${formatNumber(highest.units.mean)} unidades; ${lowest.label}: ${formatNumber(lowest.units.mean)} unidades${difference ? `, una diferencia de ${formatNumber(difference)}%` : ''}.`,
        evidence: `${highest.sampleSize} observación(es) para ${highest.label} y ${lowest.sampleSize} para ${lowest.label}.`,
        questions: highest.sampleSize < 2 || lowest.sampleSize < 2
          ? ['¿Conviene ampliar el período para confirmar que la diferencia no proviene de una sola fecha?']
          : ['¿La planificación de personal y producción refleja esta diferencia entre días?']
      });
    }
    const mixGap = bucketRows.slice().sort((left, right) => Math.abs(right.salesShare - right.unitShare)
      - Math.abs(left.salesShare - left.unitShare))[0];
    if (mixGap && Math.abs(mixGap.salesShare - mixGap.unitShare) >= 3) addFinding({
      category: 'Mix de productos',
      title: `${mixGap.label} tiene una composición de valor distinta a su volumen`,
      conclusion: `Concentra ${formatNumber(mixGap.unitShare)}% de las unidades y ${formatNumber(mixGap.salesShare)}% de la facturación.`,
      evidence: `Diferencia de participación ${formatNumber(mixGap.salesShare - mixGap.unitShare)} puntos porcentuales; venta promedio por unidad ${formatMoney(mixGap.revenuePerUnit)}.`,
      possibleExplanations: [mixGap.salesShare > mixGap.unitShare ? 'Mayor peso de productos de precio alto.' : 'Mayor peso de productos económicos o promociones.'],
      questions: ['¿Qué jerarquías y productos explican esta diferencia de mix?']
    });
    if (dates.length < 5) addFinding({
      priority: 'medium',
      category: 'Calidad de la muestra',
      title: 'La muestra es pequeña para concluir sobre anomalías o tendencias',
      conclusion: `El reporte contiene ${dates.length} día(s) con ventas. Los promedios son descriptivos, pero su estabilidad estadística es limitada.`,
      questions: ['¿Es posible ampliar el período a al menos 10–15 días comparables?']
    });
    if (!dates.length) findings.length = 0;
    findings.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);
    const highestDay = dailyRows.slice().sort((left, right) => right.units - left.units)[0] || null;
    const lowestDay = dailyRows.slice().sort((left, right) => left.units - right.units)[0] || null;
    const selectionLabel = productKey
      ? bucketRows.flatMap(bucket => report.buckets.find(source => source.label === bucket.label)?.products || [])
        .find(product => productIdentity(product) === productKey)?.name || 'Producto seleccionado'
      : hierarchyPath.length ? hierarchyPath.join(' › ') : 'Todas las jerarquías';
    const executiveSummary = dates.length ? [
      `Se analizaron ${dates.length} día(s) con ventas entre ${dates[0]} y ${dates.at(-1)} para ${selectionLabel}. El promedio diario fue ${formatNumber(unitStats.mean)} unidades y ${formatMoney(salesStats.mean)} de facturación neta sin IVA.`,
      `La variabilidad diaria alcanzó un CV de ${formatNumber(unitStats.coefficientOfVariation)}% en unidades y ${formatNumber(salesStats.coefficientOfVariation)}% en facturación. ${anomalies.length ? `Se detectaron ${anomalies.length} fecha(s) estadísticamente atípica(s).` : 'No se detectaron fechas a dos desviaciones estándar del comportamiento promedio.'}`,
      highestDay && lowestDay
        ? `El mayor volumen ocurrió el ${highestDay.date} con ${formatNumber(highestDay.units)} unidades; el menor, el ${lowestDay.date} con ${formatNumber(lowestDay.units)} unidades.`
        : ''
    ].filter(Boolean) : ['No hay días con ventas que cumplan los filtros seleccionados; no es posible emitir conclusiones estadísticas.'];
    const buildBreakdown = level => {
      const groups = new Map();
      report.buckets.forEach((bucket, bucketIndex) => {
        bucket.products.filter(matchesSelection).forEach(product => {
          const productHierarchy = product.hierarchyPath?.length ? product.hierarchyPath.join(' › ') : 'Sin jerarquía';
          const key = level === 'hierarchy' ? productHierarchy : productIdentity(product);
          if (!groups.has(key)) groups.set(key, {
            key,
            label: level === 'hierarchy' ? productHierarchy : product.name || product.code || 'Sin nombre',
            code: level === 'product' ? product.code || '' : null,
            hierarchy: level === 'product' ? productHierarchy : null,
            dailyUnits: dates.map(() => 0),
            dailyNetSales: dates.map(() => 0),
            bucketUnits: report.buckets.map(() => 0),
            bucketNetSales: report.buckets.map(() => 0)
          });
          const group = groups.get(key);
          dates.forEach((date, dateIndex) => {
            const units = Number(product.dailyUnits?.[date]) || 0;
            const netSales = Number(product.dailyNetSales?.[date]) || 0;
            group.dailyUnits[dateIndex] += units;
            group.dailyNetSales[dateIndex] += netSales;
            group.bucketUnits[bucketIndex] += units;
            group.bucketNetSales[bucketIndex] += netSales;
          });
        });
      });
      const adjustedZScores = values => {
        const weekdayValues = new Map();
        values.forEach((value, index) => {
          const weekday = new Date(`${dates[index]}T12:00:00Z`).getUTCDay();
          if (!weekdayValues.has(weekday)) weekdayValues.set(weekday, []);
          weekdayValues.get(weekday).push(value);
        });
        const overall = statistics(values);
        const residuals = values.map((value, index) => {
          const weekday = new Date(`${dates[index]}T12:00:00Z`).getUTCDay();
          const comparable = weekdayValues.get(weekday) || [];
          const expected = comparable.length >= 2 ? statistics(comparable).mean : overall.mean;
          return value - expected;
        });
        const residualStats = statistics(residuals);
        return residuals.map(value => round(standardized(value, residualStats)));
      };
      const rows = [...groups.values()].map(group => {
        const groupUnitStats = statistics(group.dailyUnits);
        const groupSalesStats = statistics(group.dailyNetSales);
        const groupUnitTrend = regression(group.dailyUnits);
        const groupSalesTrend = regression(group.dailyNetSales);
        const unitZScores = adjustedZScores(group.dailyUnits);
        const salesZScores = adjustedZScores(group.dailyNetSales);
        const anomalyCount = dates.length >= 5 ? dates.filter((date, index) => (
          Math.abs(unitZScores[index]) >= 2 || Math.abs(salesZScores[index]) >= 2
        )).length : 0;
        const strongestBucketIndex = group.bucketUnits.reduce((best, value, index, values) => value > values[best] ? index : best, 0);
        return {
          key: group.key,
          label: group.label,
          code: group.code,
          hierarchy: group.hierarchy,
          averageUnits: groupUnitStats.mean,
          averageNetSales: groupSalesStats.mean,
          totalUnits: groupUnitStats.sum,
          totalNetSales: groupSalesStats.sum,
          unitShare: round(unitStats.sum ? groupUnitStats.sum / unitStats.sum * 100 : 0, 1),
          salesShare: round(salesStats.sum ? groupSalesStats.sum / salesStats.sum * 100 : 0, 1),
          revenuePerUnit: round(groupUnitStats.sum ? groupSalesStats.sum / groupUnitStats.sum : 0),
          unitCoefficientOfVariation: groupUnitStats.coefficientOfVariation,
          salesCoefficientOfVariation: groupSalesStats.coefficientOfVariation,
          unitTrend: groupUnitTrend,
          salesTrend: groupSalesTrend,
          anomalyCount,
          strongestInterval: report.buckets[strongestBucketIndex]?.label || null
        };
      }).sort((left, right) => right.totalNetSales - left.totalNetSales || right.totalUnits - left.totalUnits);
      const breakdownFindings = [];
      const addBreakdownFinding = finding => breakdownFindings.push({
        priority: 'info',
        possibleExplanations: [],
        questions: [],
        ...finding
      });
      const subjectPlural = level === 'hierarchy' ? 'jerarquías' : 'productos';
      const subjectWithArticle = level === 'hierarchy' ? 'esta jerarquía' : 'este producto';
      const leading = rows[0];
      if (leading) addBreakdownFinding({
        category: 'Participación',
        title: `${leading.label} lidera entre ${subjectPlural}`,
        conclusion: `Representa ${formatNumber(leading.salesShare)}% de la facturación y ${formatNumber(leading.unitShare)}% de las unidades de la selección analizada.`,
        evidence: `Promedio diario ${formatNumber(leading.averageUnits)} unidades y ${formatMoney(leading.averageNetSales)} de facturación.`,
        questions: [`¿La capacidad, disponibilidad y visibilidad comercial de ${subjectWithArticle} reflejan su importancia?`]
      });
      const meaningfulMinimum = Math.max(3, unitStats.sum * 0.005);
      const trendCandidate = rows.filter(row => row.totalUnits >= meaningfulMinimum && row.unitTrend.rSquared >= 0.15)
        .sort((left, right) => Math.abs(right.unitTrend.estimatedChangePercent) - Math.abs(left.unitTrend.estimatedChangePercent))[0];
      if (trendCandidate && Math.abs(trendCandidate.unitTrend.estimatedChangePercent) >= 10) addBreakdownFinding({
        priority: Math.abs(trendCandidate.unitTrend.estimatedChangePercent) >= 25 ? 'medium' : 'info',
        category: 'Tendencia',
        title: `${trendCandidate.label} muestra la tendencia más marcada`,
        conclusion: `Las unidades presentan una trayectoria ${trendCandidate.unitTrend.estimatedChangePercent > 0 ? 'creciente' : 'decreciente'} estimada en ${formatNumber(trendCandidate.unitTrend.estimatedChangePercent)}% durante la muestra.`,
        evidence: `R² ${formatNumber(trendCandidate.unitTrend.rSquared)}; participación ${formatNumber(trendCandidate.unitShare)}% de unidades.`,
        possibleExplanations: ['Cambio de preferencias, disponibilidad, promoción o sustitución dentro del mix.'],
        questions: [`¿Hubo cambios de precio, receta, stock o promoción asociados a ${subjectWithArticle}?`]
      });
      const volatile = rows.filter(row => row.averageUnits >= Math.max(0.5, unitStats.mean * 0.005))
        .sort((left, right) => (right.unitCoefficientOfVariation || 0) - (left.unitCoefficientOfVariation || 0))[0];
      if (volatile) addBreakdownFinding({
        priority: (volatile.unitCoefficientOfVariation || 0) >= 80 ? 'medium' : 'info',
        category: 'Variabilidad',
        title: `${volatile.label} tiene la demanda más variable`,
        conclusion: `Su coeficiente de variación en unidades es ${formatNumber(volatile.unitCoefficientOfVariation)}%.`,
        evidence: `Promedio ${formatNumber(volatile.averageUnits)} unidades diarias; franja principal ${volatile.strongestInterval || 'sin datos'}.`,
        possibleExplanations: ['Demanda ocasional, promociones, quiebres de stock o concentración en pocos días.'],
        questions: ['¿La variabilidad coincide con días específicos, campañas o problemas de disponibilidad?']
      });
      const anomalous = rows.filter(row => row.anomalyCount > 0)
        .sort((left, right) => right.anomalyCount - left.anomalyCount || right.totalNetSales - left.totalNetSales)[0];
      if (anomalous) addBreakdownFinding({
        priority: 'medium',
        category: 'Anomalías',
        title: `${anomalous.label} concentra desviaciones atípicas`,
        conclusion: `Registra ${anomalous.anomalyCount} día(s) fuera de su patrón ajustado por día de semana.`,
        evidence: `Se aplicó el mismo umbral estadístico de dos desviaciones estándar del análisis general.`,
        questions: ['¿Qué eventos, disponibilidad o registros explican esas fechas específicas?']
      });
      const mixDifference = rows.slice().sort((left, right) => Math.abs(right.salesShare - right.unitShare)
        - Math.abs(left.salesShare - left.unitShare))[0];
      if (mixDifference && Math.abs(mixDifference.salesShare - mixDifference.unitShare) >= 3) addBreakdownFinding({
        category: 'Mix de valor',
        title: `${mixDifference.label} se diferencia por valor versus volumen`,
        conclusion: `Aporta ${formatNumber(mixDifference.unitShare)}% de unidades y ${formatNumber(mixDifference.salesShare)}% de facturación.`,
        evidence: `Venta neta por unidad ${formatMoney(mixDifference.revenuePerUnit)}; brecha ${formatNumber(mixDifference.salesShare - mixDifference.unitShare)} puntos porcentuales.`,
        questions: ['¿La diferencia responde a precio, tamaño, descuentos o composición de productos?']
      });
      breakdownFindings.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);
      const leadingCount = Math.min(3, rows.length);
      const leadingGroupLabel = level === 'hierarchy'
        ? `${leadingCount === 1 ? 'La' : 'Las'} ${leadingCount} ${leadingCount === 1 ? 'principal jerarquía' : 'principales jerarquías'}`
        : `${leadingCount === 1 ? 'El' : 'Los'} ${leadingCount} ${leadingCount === 1 ? 'principal producto' : 'principales productos'}`;
      const topThreeShare = round(rows.slice(0, leadingCount).reduce((sum, row) => sum + row.salesShare, 0), 1);
      return {
        level,
        groupCount: rows.length,
        executiveSummary: rows.length ? [
          `Se compararon ${rows.length} ${subjectPlural}. ${leading.label} lidera con ${formatNumber(leading.salesShare)}% de la facturación y ${formatNumber(leading.unitShare)}% de las unidades.`,
          `${leadingGroupLabel} ${leadingCount === 1 ? 'concentra' : 'concentran'} ${formatNumber(topThreeShare)}% de la facturación de la selección.`
        ] : [`No se encontraron ${subjectPlural} con ventas para la selección y período indicados.`],
        findings: breakdownFindings,
        rows
      };
    };
    const hierarchyBreakdown = analysisLevel === 'hierarchy' || analysisLevel === 'product'
      ? buildBreakdown('hierarchy')
      : null;
    const productBreakdown = analysisLevel === 'product' ? buildBreakdown('product') : null;
    return {
      analysisLevel,
      scope: report.scope,
      filters: report.filters,
      selectedDates: dates,
      sampleSize: dates.length,
      selection: { hierarchyPath, productKey: productKey || null, label: selectionLabel },
      executiveSummary,
      metrics: {
        averageUnits: unitStats.mean,
        averageNetSales: salesStats.mean,
        unitCoefficientOfVariation: unitStats.coefficientOfVariation,
        salesCoefficientOfVariation: salesStats.coefficientOfVariation,
        anomalyCount: anomalies.length,
        strongestInterval: peakUnits?.label || null
      },
      findings,
      breakdowns: {
        hierarchies: hierarchyBreakdown,
        products: productBreakdown
      },
      appendix: {
        daily: dailyRows,
        buckets: bucketRows.map(({ daily, ...bucket }) => bucket),
        weekdays: weekdayRows,
        totals: { units: unitStats, netSales: salesStats, unitTrend, salesTrend },
        methodology: [
          'Los promedios consideran únicamente los días con ventas incluidos por el período seleccionado.',
          'La varianza y desviación estándar son muestrales; el CV corresponde a desviación estándar dividida por promedio.',
          'Las anomalías se señalan a dos desviaciones estándar sobre la diferencia respecto del promedio de su mismo día de semana; si no hay dos fechas comparables, se usa el promedio general.',
          'Las tendencias utilizan una regresión lineal sobre la secuencia de días observados; R² indica cuánto explica esa recta.',
          'Las hipótesis son posibilidades para orientar una revisión y no prueban causalidad por sí solas.'
        ]
      },
      warnings: report.warnings
    };
  }

  app.get('/api/sales/hourly-demand', (req, res) => {
    try {
      return res.json(buildHourlySalesDemand(String(req.query.location || 'all'), req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir la demanda por franja horaria.' });
    }
  });

  app.get('/api/sales/hourly-analysis', (req, res) => {
    try {
      return res.json(buildHourlySalesAnalysis(String(req.query.location || 'all'), req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el análisis estadístico por franja horaria.' });
    }
  });

  function toteatStore(locationId) {
    const location = activeLocation(locationId);
    if (!location || location.type !== 'store') {
      const error = new Error('Selecciona una cafetería específica para descargar sus ventas desde Toteat.');
      error.status = 400;
      error.code = 'TOTEAT_LOCATION_REQUIRED';
      throw error;
    }
    return location;
  }

  const toteatDownloadPrefix = (localId, central = false) =>
    central ? '000' : String(localId).padStart(3, '0');

  app.post('/api/integrations/toteat/connect', async (req, res) => {
    try {
      const location = toteatStore(String(req.body?.location || ''));
      await toteatAutomation.connect(location.id, {
        restaurantName: location.toteatRestaurantName || location.name
      });
      return res.json({ opened: true, location: publicLocation(location), reportUrl: TOTEAT_REPORT_URL });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message || 'No se pudo abrir Toteat.',
        code: error.code || 'TOTEAT_CONNECTION_FAILED',
        state: error.state || null,
        diagnosticId: error.diagnosticId || null
      });
    }
  });

  const toteatDownloadError = (res, error, fallback) => res.status(error.status || 500).json({
    error: error.message || fallback,
    code: error.code || 'TOTEAT_DOWNLOAD_FAILED',
    state: error.state || null,
    diagnosticId: error.diagnosticId || null
  });
  const sendToteatDownload = (res, download, fallbackFilename) => {
    const filename = path.basename(download.filename || fallbackFilename).replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(download.buffer);
  };
  const sendToteatDownloadBundle = (res, download) => res.json({
    files: download.files.map(file => ({
      filename: path.basename(file.filename || 'archivo-toteat').replace(/[\r\n"]/g, '_'),
      contentType: file.contentType || 'application/octet-stream',
      data: file.buffer.toString('base64')
    }))
  });
  const toteatMasterBatch = req => {
    const batchId = String(req.query.batchId || req.body?.batchId || '');
    const batch = toteatMasterDownloadBatches.get(batchId);
    return batch && Date.now() - batch.createdAt < STAGING_MAX_AGE_MS ? batch : null;
  };
  const stageToteatMasterDownload = (req, field, download) => {
    const batch = toteatMasterBatch(req);
    if (!batch) return;
    batch.files.set(field, {
      filename: path.basename(download.filename),
      contentType: download.contentType,
      buffer: Buffer.from(download.buffer)
    });
  };

  app.post('/api/integrations/toteat/master-downloads/connect', async (req, res) => {
    try {
      const connection = await toteatAutomation.connectMasterDownloads();
      const batchId = crypto.randomBytes(16).toString('hex');
      toteatMasterDownloadBatches.set(batchId, { createdAt: Date.now(), files: new Map() });
      return res.json({ ...connection, opened: true, loginUrl: TOTEAT_LOGIN_URL, batchId });
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo abrir el inicio de sesión de Toteat.');
    }
  });

  app.post('/api/integrations/toteat/transactional-downloads/connect', express.json(), async (req, res) => {
    try {
      const activeLocations = readLocations().locations.filter(location => location.status === 'active');
      const requestedLocation = String(req.body?.location || 'all');
      const includeCentral = req.body?.includeCentral !== false;
      const stores = activeLocations.filter(location => location.type === 'store'
        && (requestedLocation === 'all' || location.id === requestedLocation));
      if (!stores.length) {
        return res.status(400).json({ code: 'TOTEAT_LOCATION_REQUIRED', error: 'Selecciona una cafetería activa para descargar.' });
      }
      const centralOwner = stores.find(location => Number(location.toteatLocalId) === 1);
      const centralLocation = activeLocations.find(location => location.id === 'main-warehouse');
      if (includeCentral && (!centralOwner || !centralLocation)) {
        return res.status(422).json({
          code: 'TOTEAT_CENTRAL_CONFIGURATION_REQUIRED',
          error: 'Se requiere el local 001 y la Bodega principal activos para descargar los Kardex centrales.'
        });
      }
      const missingConfiguration = stores.filter(location => !location.toteatRestaurantId || !location.toteatLocalId || !location.toteatName || !location.toteatSimpleId);
      if (missingConfiguration.length) {
        return res.status(422).json({
          code: 'TOTEAT_LOCATION_CONFIGURATION_REQUIRED',
          error: `Completa los cuatro identificadores de TotEat en Configuración para: ${missingConfiguration.map(item => item.name).join(', ')}.`
        });
      }
      const connection = await toteatAutomation.connectTransactionalDownloads();
      return res.json({
        ...connection,
        loginUrl: TOTEAT_LOGIN_URL,
        centralWarehouse: includeCentral ? {
          id: centralLocation.id,
          name: centralLocation.name,
          ownerLocationId: centralOwner.id,
          toteatLocalId: centralOwner.toteatLocalId,
          kardexDateFrom: latestKardexAt(centralLocation.id, 'kardex') || FIRST_WEEK,
          wasteDateFrom: latestKardexAt(centralLocation.id, 'waste') || FIRST_WEEK,
          dateTo: projectionToday()
        } : null,
        locations: stores.map(location => {
          const latestTransactionAt = salesHistory(location.id).latestTransactionAt;
          const latestPaymentDetailsAt = latestGenericTransactionAt(location.id, 'payment-details');
          const latestPurchasesAt = latestGenericTransactionAt(location.id, 'purchases');
          return {
            id: location.id,
            name: location.name,
            toteatName: location.toteatName,
            toteatLocalId: location.toteatLocalId,
            latestTransactionAt,
            dateFrom: latestTransactionAt?.slice(0, 10) || FIRST_WEEK,
            paymentDetailsDateFrom: latestPaymentDetailsAt || FIRST_WEEK,
            purchasesDateFrom: latestPurchasesAt || FIRST_WEEK,
            kardexDateFrom: latestKardexAt(location.id, 'kardex') || FIRST_WEEK,
            wasteDateFrom: latestKardexAt(location.id, 'waste') || FIRST_WEEK,
            dateTo: projectionToday()
          };
        })
      });
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo abrir la sesión transaccional de TotEat.');
    }
  });

  function toteatTransactionalRange(body, suggestedFrom) {
    const custom = body?.dateFrom !== undefined || body?.dateTo !== undefined;
    if (!custom) return { dateFrom: suggestedFrom, dateTo: projectionToday() };
    const dateFrom = String(body?.dateFrom || '');
    const dateTo = String(body?.dateTo || '');
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo || dateTo > projectionToday()) {
      const error = new Error('Selecciona fechas inicial y final válidas, sin superar la fecha de hoy.');
      error.status = 400;
      error.code = 'TOTEAT_INVALID_DATE_RANGE';
      throw error;
    }
    return { dateFrom, dateTo };
  }

  app.post('/api/integrations/toteat/transactional-downloads/sales', express.json(), async (req, res) => {
    try {
      const location = toteatStore(String(req.body?.location || ''));
      const latestTransactionAt = salesHistory(location.id).latestTransactionAt;
      const { dateFrom, dateTo } = toteatTransactionalRange(req.body, latestTransactionAt?.slice(0, 10) || FIRST_WEEK);
      const download = await toteatAutomation.downloadTransactionalSales({
        restaurant: {
          restaurantId: location.toteatRestaurantId,
          localId: location.toteatLocalId,
          name: location.toteatName,
          simpleId: location.toteatSimpleId
        },
        dateFrom,
        dateTo
      });
      const downloadedDateFrom = download.dateFrom || dateFrom;
      const extension = path.extname(download.filename || '') || '.xlsx';
      download.filename = `${toteatDownloadPrefix(location.toteatLocalId)}_ventas-totales-${location.id}-${downloadedDateFrom}-${dateTo}${extension}`;
      res.setHeader('X-Brewit-Date-From', downloadedDateFrom);
      res.setHeader('X-Brewit-Date-To', dateTo);
      return sendToteatDownload(res, download, `ventas-toteat-${location.id}-${dateFrom}-${dateTo}.xlsx`);
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudieron descargar las ventas transaccionales desde TotEat.');
    }
  });

  app.post('/api/integrations/toteat/transactional-downloads/select-location', express.json(), async (req, res) => {
    try {
      const location = toteatStore(String(req.body?.location || ''));
      const selected = await toteatAutomation.selectTransactionalRestaurant({
        restaurantId: location.toteatRestaurantId,
        localId: location.toteatLocalId,
        name: location.toteatName,
        simpleId: location.toteatSimpleId
      });
      return res.json({ ok: true, location: location.id, selected });
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo seleccionar el local en TotEat.');
    }
  });

  for (const [field, route, method, fallbackExtension] of [
    ['payment-details', 'payment-details', 'downloadTransactionalPaymentDetails', '.csv'],
    ['purchases', 'purchases', 'downloadTransactionalPurchases', '.xls']
  ]) {
    app.post(`/api/integrations/toteat/transactional-downloads/${route}`, express.json(), async (req, res) => {
      try {
        const location = toteatStore(String(req.body?.location || ''));
        const { dateFrom, dateTo } = toteatTransactionalRange(req.body, latestGenericTransactionAt(location.id, field) || FIRST_WEEK);
        const download = await toteatAutomation[method]({
          restaurant: {
            restaurantId: location.toteatRestaurantId,
            localId: location.toteatLocalId,
            name: location.toteatName,
            simpleId: location.toteatSimpleId
          },
          dateFrom,
          dateTo
        });
        const downloadedDateFrom = download.dateFrom || dateFrom;
        const extension = path.extname(download.filename || '') || fallbackExtension;
        download.filename = `${toteatDownloadPrefix(location.toteatLocalId)}_${route}-toteat-${location.id}-${downloadedDateFrom}-${dateTo}${extension}`;
        res.setHeader('X-Brewit-Date-From', downloadedDateFrom);
        res.setHeader('X-Brewit-Date-To', dateTo);
        return sendToteatDownload(res, download, download.filename);
      } catch (error) {
        return toteatDownloadError(res, error, `No se pudo descargar ${field} desde TotEat.`);
      }
    });
  }

  for (const [kind, field, central] of [
    ['local', 'kardex', false], ['waste', 'waste', false],
    ['central', 'kardex', true], ['central-waste', 'waste', true]
  ]) {
    app.post(`/api/integrations/toteat/transactional-downloads/kardex-${kind}`, express.json(), async (req, res) => {
      try {
        const locations = readLocations().locations.filter(location => location.status === 'active');
        const source = central
          ? locations.find(location => location.id === 'main-warehouse')
          : toteatStore(String(req.body?.location || ''));
        if (!source || (central && req.body?.location !== source.id)) {
          const error = new Error('Selecciona la Bodega principal para descargar el Kardex central.');
          error.status = 400;
          error.code = 'TOTEAT_CENTRAL_LOCATION_REQUIRED';
          throw error;
        }
        const restaurant = central
          ? locations.find(location => location.type === 'store' && Number(location.toteatLocalId) === 1)
          : source;
        if (!restaurant) {
          const error = new Error('No está configurado el local 001 que administra la Bodega principal.');
          error.status = 422;
          error.code = 'TOTEAT_CENTRAL_OWNER_REQUIRED';
          throw error;
        }
        const { dateFrom, dateTo } = toteatTransactionalRange(req.body, latestKardexAt(source.id, field) || FIRST_WEEK);
        const download = await toteatAutomation.downloadTransactionalKardex({
          restaurant: {
            restaurantId: restaurant.toteatRestaurantId,
            localId: restaurant.toteatLocalId,
            name: restaurant.toteatName,
            simpleId: restaurant.toteatSimpleId
          },
          kind,
          dateFrom,
          dateTo
        });
        const downloadedDateFrom = download.dateFrom || dateFrom;
        const extension = path.extname(download.filename || '') || '.xlsx';
        download.filename = `${toteatDownloadPrefix(restaurant.toteatLocalId, central)}_kardex-${kind}-${source.id}-${downloadedDateFrom}-${dateTo}${extension}`;
        res.setHeader('X-Brewit-Date-From', downloadedDateFrom);
        res.setHeader('X-Brewit-Date-To', dateTo);
        res.setHeader('X-Brewit-Warehouse', download.warehouseName || '');
        return sendToteatDownload(res, download, download.filename);
      } catch (error) {
        return toteatDownloadError(res, error, `No se pudo descargar Kardex ${kind} desde TotEat.`);
      }
    });
  }

  app.post('/api/integrations/toteat/master-downloads/suppliers', async (req, res) => {
    try {
      const download = await toteatAutomation.downloadSuppliers();
      stageToteatMasterDownload(req, 'master-suppliers', download);
      return sendToteatDownload(res, download, 'proveedores-toteat.xlsx');
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo descargar Proveedores desde Toteat.');
    }
  });

  app.post('/api/integrations/toteat/master-downloads/products', async (req, res) => {
    try {
      const download = await toteatAutomation.downloadProductsMaster();
      stageToteatMasterDownload(req, 'master-catalog', download);
      return sendToteatDownload(
        res,
        download,
        'productos-ingredientes-extras-toteat.xlsx'
      );
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo descargar el maestro de Productos desde Toteat.');
    }
  });

  const remainingToteatMasterDownloads = [
    ['product-hierarchy', 'downloadProductHierarchy', 'jerarquia-productos-toteat.csv', 'Jerarquía de Productos'],
    ['ingredient-hierarchy', 'downloadIngredientHierarchy', 'jerarquia-ingredientes-toteat.csv', 'Jerarquía de Ingredientes'],
    ['extras-hierarchy', 'downloadExtrasHierarchy', 'jerarquia-extras-toteat.csv', 'Jerarquía de Extras']
  ];
  remainingToteatMasterDownloads.forEach(([route, method, fallbackFilename, label]) => {
    app.post(`/api/integrations/toteat/master-downloads/${route}`, async (req, res) => {
      try {
        const download = await toteatAutomation[method]();
        stageToteatMasterDownload(req, route, download);
        return sendToteatDownload(res, download, fallbackFilename);
      } catch (error) {
        return toteatDownloadError(res, error, `No se pudo descargar ${label} desde Toteat.`);
      }
    });
  });

  app.post('/api/integrations/toteat/master-downloads/recipes', async (req, res) => {
    try {
      const download = await toteatAutomation.downloadRecipes();
      if (!Array.isArray(download?.files) || download.files.length !== 2) {
        const error = new Error('TotEat no entregó los dos archivos esperados del Maestro de Recetas.');
        error.code = 'TOTEAT_INCOMPLETE_DOWNLOAD';
        error.status = 502;
        throw error;
      }
      const recipeFiles = ['HEADERS_RECETAS.txt', 'DETALLE_RECETAS.txt'].map(filename =>
        download.files.find(file => path.basename(file.filename || '').toUpperCase() === filename.toUpperCase())
      );
      if (recipeFiles.some(file => !file)) {
        const error = new Error('TotEat no entregó HEADERS_RECETAS.txt y DETALLE_RECETAS.txt. Revisa la sesión y vuelve a intentar.');
        error.code = 'TOTEAT_UNEXPECTED_RECIPE_FILES';
        error.status = 502;
        throw error;
      }
      stageToteatMasterDownload(req, 'recipe-headers', recipeFiles[0]);
      stageToteatMasterDownload(req, 'master-recipes', recipeFiles[1]);
      return sendToteatDownloadBundle(res, { files: recipeFiles.map((file, index) => ({
        ...file,
        filename: ['HEADERS_RECETAS.txt', 'DETALLE_RECETAS.txt'][index],
        contentType: 'text/plain; charset=utf-8'
      })) });
    } catch (error) {
      return toteatDownloadError(res, error, 'No se pudo descargar el Maestro de Recetas desde TotEat.');
    }
  });

  app.post('/api/integrations/toteat/master-downloads/finalize', express.json(), (req, res) => {
    if (typeof options.toteatMasterBatchFinalizer === 'function') {
      try {
        return res.json(options.toteatMasterBatchFinalizer(req.body?.batchId));
      } catch (error) {
        return res.status(error.status || 500).json({ error: error.message });
      }
    }
    const batchId = String(req.body?.batchId || '');
    const batch = toteatMasterDownloadBatches.get(batchId);
    const requiredFields = [
      'master-suppliers', 'master-catalog', 'product-hierarchy', 'ingredient-hierarchy',
      'extras-hierarchy', 'recipe-headers', 'master-recipes'
    ];
    if (!batch || Date.now() - batch.createdAt >= STAGING_MAX_AGE_MS) {
      return res.status(409).json({ code: 'TOTEAT_MASTER_BATCH_EXPIRED', error: 'La descarga maestra venció. Inicia una nueva descarga desde TotEat.' });
    }
    const missing = requiredFields.filter(field => !batch.files.has(field));
    if (missing.length) {
      return res.status(422).json({
        code: 'TOTEAT_MASTER_FILES_INCOMPLETE',
        error: `No se guardó ningún maestro porque faltan ${missing.length} archivo(s) del lote.`,
        missing
      });
    }
    const batchRoot = path.join(stagingRoot, `toteat-masters-${batchId}`);
    ensureDir(batchRoot);
    const stagedFiles = [];
    const createdMasterFiles = [];
    try {
      for (const field of requiredFields) {
        const source = batch.files.get(field);
        const originalname = source.filename;
        const filePath = path.join(batchRoot, `${field}_${originalname.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
        fs.writeFileSync(filePath, source.buffer);
        stagedFiles.push({ fieldname: field, originalname, path: filePath, size: source.buffer.length, mimetype: source.contentType });
      }
      const mainFiles = stagedFiles.filter(file => file.fieldname !== 'recipe-headers');
      const validations = mainFiles.map(validateUploadStructure);
      const mismatch = validations.find(validation => !validation.ok);
      if (mismatch) {
        return res.status(422).json({ code: 'FILE_STRUCTURE_MISMATCH', error: mismatch.error, mismatch });
      }
      const recipeHeader = stagedFiles.find(file => file.fieldname === 'recipe-headers');
      const headerSheets = workbookStructure(recipeHeader.path);
      if (!structureHasHeader(headerSheets, ['Id Producto', 'Nombre Producto*', 'Cantidad a Producir', 'Unidad de Medida'])) {
        return res.status(422).json({
          code: 'RECIPE_HEADER_STRUCTURE_MISMATCH',
          error: 'HEADERS_RECETAS.txt no contiene la estructura vigente de cabeceras de recetas.'
        });
      }
      const canonicalSchemaHeader = value => {
        const normalized = normalizeHeader(value);
        const aliases = {
          'id jerarquia': 'hierarchy id',
          'hierarchy id': 'hierarchy id',
          'id nodo **': 'node id **',
          'node id **': 'node id **',
          'id nodo padre': 'parent node id',
          'parent node id': 'parent node id',
          'visible a clientes *': 'visible to customers *',
          'visible to customers *': 'visible to customers *',
          fotos: 'photos',
          photos: 'photos',
          orden: 'order',
          order: 'order',
          'sort order': 'order'
        };
        if (/^(?:nombre jerarquia|(?:product|ingredient|extras?) hierarchy name)\b/.test(normalized)) {
          return 'hierarchy name *';
        }
        return aliases[normalized] || normalized;
      };
      const schemaFor = filePath => workbookStructure(filePath).map(sheet => {
        const rows = sheet.rows.slice(0, 5);
        const header = rows.reduce((best, row) => {
          const normalized = row.map(canonicalSchemaHeader).filter(Boolean);
          return normalized.length > best.length ? normalized : best;
        }, []);
        return { name: sheet.normalizedName, header };
      }).filter(sheet => sheet.header.length);
      const sameSchema = (currentPath, incomingPath) => {
        const current = schemaFor(currentPath);
        const incoming = schemaFor(incomingPath);
        if (current.length !== incoming.length) return false;
        return current.every((sheet, index) => {
          const candidate = current.length === 1
            ? incoming[0]
            : incoming.find(item => item.name === sheet.name) || incoming[index];
          return candidate && JSON.stringify(candidate.header) === JSON.stringify(sheet.header);
        });
      };
      const schemaChecks = [];
      for (const file of mainFiles) {
        const current = latestMasterFile(file.fieldname, projectionToday());
        const compatible = Boolean(current && sameSchema(current.filePath, file.path));
        schemaChecks.push({
          field: file.fieldname,
          label: UPLOAD_STRUCTURE_LABELS[file.fieldname],
          compatible,
          comparedWith: current?.originalName || current?.name || null
        });
      }
      const incompatible = schemaChecks.filter(check => !check.compatible);
      if (incompatible.length) {
        return res.status(422).json({
          code: 'MASTER_SCHEMA_CHANGED',
          error: `No se actualizó ningún maestro: ${incompatible.map(item => item.label).join(', ')} no coincide con la estructura vigente guardada.`,
          checks: schemaChecks
        });
      }
      const validFrom = projectionToday();
      const savedAt = new Date().toISOString();
      const saved = {};
      for (const file of mainFiles) {
        const storedName = safeFilename(file);
        const destination = path.join(mastersRoot, storedName);
        fs.copyFileSync(file.path, destination);
        createdMasterFiles.push(destination);
        saved[file.fieldname] = {
          field: file.fieldname,
          name: storedName,
          originalName: file.originalname,
          size: file.size,
          url: `/uploads/masters/${encodeURIComponent(storedName)}`,
          savedAt,
          validFrom
        };
      }
      const storedHeaderName = safeFilename(recipeHeader);
      const storedHeaderPath = path.join(mastersRoot, storedHeaderName);
      fs.copyFileSync(recipeHeader.path, storedHeaderPath);
      createdMasterFiles.push(storedHeaderPath);
      saved['master-recipes'].parts = [{
        name: storedHeaderName,
        originalName: recipeHeader.originalname,
        size: recipeHeader.size,
        url: `/uploads/masters/${encodeURIComponent(storedHeaderName)}`
      }];
      const indexPath = path.join(mastersRoot, 'masters.json');
      const index = readJson(indexPath, {});
      const replacedRecords = [];
      for (const [version, group] of Object.entries(index)) {
        for (const field of Object.keys(saved)) {
          if (group[field]?.validFrom !== validFrom) continue;
          replacedRecords.push(group[field]);
          delete group[field];
        }
        if (!Object.keys(group).length) delete index[version];
      }
      index[savedAt] = saved;
      writeJsonAtomic(indexPath, index);
      replacedRecords.forEach(record => removeStoredRecords(mastersRoot, record));
      toteatMasterDownloadBatches.delete(batchId);
      fs.rmSync(batchRoot, { recursive: true, force: true });
      return res.json({ ok: true, validFrom, saved, checks: schemaChecks, downloadedFiles: requiredFields.length });
    } catch (error) {
      createdMasterFiles.forEach(filePath => fs.rmSync(filePath, { force: true }));
      return res.status(500).json({ error: error.message || 'No se pudieron validar y guardar los maestros descargados.' });
    } finally {
      fs.rmSync(batchRoot, { recursive: true, force: true });
    }
  });

  app.post('/api/integrations/toteat/download-sales', async (req, res) => {
    try {
      const location = toteatStore(String(req.body?.location || ''));
      const download = await toteatAutomation.downloadSales(location.id, {
        restaurantName: location.toteatRestaurantName || location.name
      });
      const filename = path.basename(download.filename || `ventas-toteat-${location.id}.xlsx`).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(download.buffer);
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message || 'No se pudo descargar el reporte de ventas desde Toteat.',
        code: error.code || 'TOTEAT_DOWNLOAD_FAILED',
        state: error.state || null,
        diagnosticId: error.diagnosticId || null
      });
    }
  });

  app.post('/api/integrations/toteat/download-payment-details', async (req, res) => {
    try {
      const location = toteatStore(String(req.body?.location || ''));
      const download = await toteatAutomation.downloadPaymentDetails(location.id, {
        restaurantName: location.toteatRestaurantName || location.name
      });
      const filename = path.basename(download.filename || `detalle-pagos-toteat-${location.id}.csv`).replace(/[\r\n"]/g, '_');
      res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(download.buffer);
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message || 'No se pudo descargar Detalle Pagos desde Toteat.',
        code: error.code || 'TOTEAT_DOWNLOAD_FAILED',
        state: error.state || null,
        diagnosticId: error.diagnosticId || null
      });
    }
  });

  app.get('/api/reports/weekly-sales', (req, res) => {
    const dailySales = {};
    const transactionsByDate = {};
    const seenOrders = new Set();
    const warnings = [];
    let filesRead = 0;
    try {
      const activeStores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
      const requestedLocation = String(req.query.location || 'all');
      const selectedStore = requestedLocation === 'all'
        ? null
        : activeStores.find(location => location.id === requestedLocation);
      if (requestedLocation !== 'all' && !selectedStore) {
        return res.status(400).json({ error: 'Select a valid cafeteria for the report.' });
      }
      const stores = selectedStore ? [selectedStore] : activeStores;
      const storesWithoutSalesFiles = [];
      for (const location of stores) {
        const storedFiles = storedSalesFiles(location.id);
        if (!storedFiles.length) storesWithoutSalesFiles.push(location.name);
        for (const stored of storedFiles) {
          try {
            const rows = readSalesRows(stored.filePath);
            rows.forEach((row, rowIndex) => {
              const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
              if (gross === null) return;
              const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
              if (!date) return;
              if (dateIsExcluded(date, stored.excludedRanges)) return;
              const uniqueOrder = `${location.id}:${salesTransactionKey(row)}`;
              if (seenOrders.has(uniqueOrder)) return;
              seenOrders.add(uniqueOrder);
              const discounts = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
              const net = (gross + discounts) / 1.19;
              if (!dailySales[date]) dailySales[date] = { gross: 0, discounts: 0, net: 0, orders: 0 };
              dailySales[date].gross += gross;
              dailySales[date].discounts += discounts;
              dailySales[date].net += net;
              dailySales[date].orders += 1;
              if (!transactionsByDate[date]) transactionsByDate[date] = [];
              const dateTime = salesTransactionDateTime(row);
              transactionsByDate[date].push({ time: dateTime?.slice(11) || '00:00:00', net });
            });
            filesRead += 1;
          } catch (error) {
            warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
          }
        }
      }

      const todayKey = projectionToday();
      const includeToday = String(req.query.includeToday || '').toLowerCase() === 'true';
      const report = buildSalesReport(dailySales, todayKey, includeToday);
      return res.json({
        ...report,
        intraday: buildIntradayReport(dailySales, transactionsByDate, report.previousDay.date),
        scope: selectedStore
          ? { type: 'location', location: selectedStore.id, label: selectedStore.name }
          : { type: 'all', location: null, label: 'Todas las cafeterías' },
        filesRead,
        sourceCoverage: {
          latestSaleDate: Object.keys(dailySales).filter(date => date <= todayKey).sort().at(-1) || null,
          storesWithoutSalesFiles,
          futureSaleDates: Object.keys(dailySales).filter(date => date > todayKey).length
        },
        warnings
      });
    } catch (error) {
      return res.status(500).json({ error: 'Could not calculate the weekly sales report.' });
    }
  });

  app.get('/api/reports/network-sales', (req, res) => {
    try {
      const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
      const configuredToday = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
      const clock = configuredToday ? { today: configuredToday, cutoff: '23:59:59' } : businessClock();
      const costValuation = req.query.costValuation === 'historical' ? 'historical' : 'period-end';
      const catalogMaster = latestMasterFile('master-catalog', clock.today);
      let costCatalog = new Map();
      if (catalogMaster) costCatalog = parseIngredientCatalog(catalogMaster.filePath);
      const facts = [];
      const warnings = [];
      let filesRead = 0;
      const sourceStores = [];
      for (const location of stores) {
        const resolver = costValuation === 'historical'
          ? buildHistoricalCostResolver(clock.today, [location.id])
          : buildCostResolver(clock.today, [location.id], { catalog: costCatalog });
        const orders = new Map();
        const seenRows = new Set();
        const storedFiles = storedSalesFiles(location.id);
        let locationFilesRead = 0;
        for (const stored of storedFiles) {
          try {
            for (const row of readSalesRows(stored.filePath)) {
              const dateTime = salesTransactionDateTime(row);
              if (!dateTime || dateTime.slice(0, 10) > clock.today || dateIsExcluded(dateTime.slice(0, 10), stored.excludedRanges)) continue;
              const canonical = Object.entries(row)
                .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
                .sort(([left], [right]) => left.localeCompare(right));
              const rowKey = `${location.id}:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
              if (seenRows.has(rowKey)) continue;
              seenRows.add(rowKey);
              const orderKey = salesTransactionKey(row);
              let order = orders.get(orderKey);
              if (!order) {
                order = { locationId: location.id, date: dateTime.slice(0, 10), time: dateTime.slice(11),
                  sales: 0, cost: 0, discounts: 0, grossBeforeDiscount: 0, transactions: 1,
                  costAvailable: true, costBasisEvidence: 'net-field-consistent', target: null, hasLine: false };
                orders.set(orderKey, order);
              }
              const gross = numericValue(rowValue(row, ['Pago total', 'Valor de boleta', 'Total a pagar']));
              if (gross !== null && order.target === null) {
                const signedDiscount = numericValue(rowValue(row, ['Descuentos', 'Descuento'])) || 0;
                order.target = (gross + signedDiscount) / 1.19;
                order.grossBeforeDiscount = gross;
                order.discounts = Math.max(0, -signedDiscount);
              }
              const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
              if (!code) {
                order.costAvailable = false;
                order.costBasisEvidence = 'unverified';
                continue;
              }
              const quantity = numericValue(rowValue(row, ['Cantidad'])) || 0;
              const catalogItem = costCatalog.get(code);
              const costReference = costValuation === 'historical'
                ? resolver.resolve(dateTime.slice(0, 10), code)
                : resolver.resolve(code, catalogItem?.unit, catalogItem);
              const reportedCost = numericValue(rowValue(row, ['Costo']));
              const totalCost = costReference.source !== 'missing' ? quantity * costReference.unitCost
                : reportedCost !== null && (costValuation === 'period-end' || reportedCost > 0) ? reportedCost : null;
              if (totalCost === null) order.costAvailable = false;
              else order.cost += totalCost;
              if (costReference.source === 'missing' || costReference.costBasisEvidence !== 'net-field-consistent') {
                order.costBasisEvidence = 'unverified';
              }
              const paidLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar']));
              const listLine = numericValue(rowValue(row, ['Precio Lista'])) || 0;
              const lineDiscount = numericValue(rowValue(row, ['Descuento'])) || 0;
              order.sales += (paidLine !== null ? paidLine : listLine + lineDiscount) / 1.19;
              order.hasLine = true;
            }
            filesRead += 1;
            locationFilesRead += 1;
          } catch (error) {
            warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
          }
        }
        for (const order of orders.values()) {
          if (order.target !== null) order.sales = order.target;
          if (!order.hasLine) order.costAvailable = false;
          facts.push(order);
        }
        sourceStores.push({ id: location.id, name: location.name, filesRead: locationFilesRead,
          latestSaleDate: [...orders.values()].map(order => order.date).sort().at(-1) || null });
      }
      return res.json({ ...buildNetworkSalesDashboard({ stores, facts, ...clock }), filesRead, warnings,
        sourceCoverage: {
          latestSaleDate: facts.map(fact => fact.date).sort().at(-1) || null,
          ordersWithCost: facts.filter(fact => fact.costAvailable).length,
          ordersWithNetFieldConsistentCost: facts.filter(fact => fact.costAvailable && fact.costBasisEvidence === 'net-field-consistent').length,
          ordersTotal: facts.length,
          costValuationDate: costValuation === 'historical' ? 'sale-date' : 'period-end',
          stores: sourceStores
        },
        coverageNote: stores.some(store => !store.operatingWeekdays?.length)
          ? 'Algunos locales no tienen calendario de apertura: sus promedios diarios consideran solo fechas con ventas registradas. Configura los días de operación en Configuración para incluir días abiertos con venta cero.'
          : 'Los días abiertos con venta cero se incluyen según el calendario configurado. Comprueba que los archivos de ventas estén completos; una fecha sin archivo no puede distinguirse automáticamente de una venta cero.' });
    } catch (error) {
      return res.status(500).json({ error: 'No se pudo calcular la vista consolidada de ventas.' });
    }
  });

  function storedFieldFiles(locationId, field) {
    return field === 'sales' ? storedSalesFiles(locationId) : storedWeeklyFiles(locationId, field);
  }

  function publicStoredFile(stored, locationId, field) {
    const record = stored.record;
    return {
      ...record,
      sourceId: stored.sourceId,
      week: stored.week,
      previewUrl: stored.week
        ? `/api/weeks/${stored.week}/${encodeURIComponent(locationId)}/${field}/preview`
        : `/api/transactions/${encodeURIComponent(locationId)}/${field}/preview?source=${encodeURIComponent(stored.sourceId)}`,
      deleteUrl: stored.week
        ? `/api/weeks/${stored.week}/${encodeURIComponent(locationId)}/${field}`
        : `/api/transactions/${encodeURIComponent(locationId)}/${field}?source=${encodeURIComponent(stored.sourceId)}`
    };
  }

  function deleteStoredSource(locationId, field, stored) {
    if (stored.week) {
      const metadataPath = path.join(stored.destination, 'meta.json');
      const metadata = readJson(metadataPath, null);
      if (!metadata?.files || !Object.hasOwn(metadata.files, field)) return false;
      const fieldRecords = Array.isArray(metadata.files[field]) ? metadata.files[field] : [metadata.files[field]];
      const remaining = fieldRecords.filter(record => record.name !== stored.record.name);
      if (remaining.length) metadata.files[field] = Array.isArray(metadata.files[field]) ? remaining : remaining[0];
      else delete metadata.files[field];
      metadata.savedAt = new Date().toISOString();
      writeJsonAtomic(metadataPath, metadata);
      removeStoredRecords(stored.destination, stored.record);
      return true;
    }
    const index = readTransactionIndex(locationId);
    const files = index.fields?.[field]?.files || [];
    const position = files.findIndex(record => record.id === stored.sourceId);
    if (position < 0) return false;
    const [record] = files.splice(position, 1);
    rebuildTransactionExclusions(index);
    index.updatedAt = new Date().toISOString();
    writeTransactionIndex(locationId, index);
    removeStoredRecords(transactionLocationRoot(locationId), record);
    return true;
  }

  app.get('/api/transactions', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    try {
      const files = {};
      for (const field of fieldsForLocation(location.type)) {
        const stored = storedFieldFiles(location.id, field);
        const sorted = [...stored].sort((left, right) =>
          String(right.record.savedAt || right.week || '').localeCompare(String(left.record.savedAt || left.week || ''))
          || String(right.record.detectedRange?.to || '').localeCompare(String(left.record.detectedRange?.to || '')));
        const ranges = sorted.map(item => item.record.confirmedRange || item.record.detectedRange).filter(Boolean);
        files[field] = {
          field,
          fileCount: sorted.length,
          dataRange: combinedDateRange(ranges.map(detectedRange => ({ detectedRange }))),
          latest: sorted[0] ? publicStoredFile(sorted[0], location.id, field) : null,
          uploads: sorted.map(item => publicStoredFile(item, location.id, field))
        };
      }
      return res.json({ location: publicLocation(location), files });
    } catch (error) {
      return res.status(500).json({ error: 'No se pudieron consultar los datos transaccionales.' });
    }
  });

  app.post('/api/uploads/transactions/inspect', (req, res) => {
    const locationId = String(req.query.location || '');
    const selectedLocation = activeLocation(locationId);
    if (!selectedLocation) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    cleanExpiredStaging(stagingRoot);
    const token = crypto.randomUUID();
    const stagingDirectory = path.join(stagingRoot, token);
    ensureDir(stagingDirectory);
    const storage = multer.diskStorage({
      destination: (uploadReq, file, callback) => callback(null, stagingDirectory),
      filename: (uploadReq, file, callback) => callback(null, safeFilename(file))
    });
    const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE, files: WEEK_FIELDS.length } }).fields(WEEK_FIELDS);
    upload(req, res, error => {
      if (error) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: multerErrorMessage(error) });
      }
      const files = uploadedFiles(req);
      if (!files.length) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: 'Selecciona al menos un archivo para revisar.' });
      }
      const allowedFields = fieldsForLocation(selectedLocation.type);
      const invalidField = files.find(file => !allowedFields.includes(file.fieldname));
      if (invalidField) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: `${selectedLocation.name} no admite archivos de ${invalidField.fieldname}.` });
      }
      const structureValidations = files.map(validateUploadStructure);
      const mismatch = structureValidations.find(validation => !validation.ok);
      if (mismatch) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(422).json({
          code: 'FILE_STRUCTURE_MISMATCH',
          error: mismatch.error,
          mismatch
        });
      }
      try {
        const inspectedFiles = files.map((file, index) => {
          const detectedRange = detectFileDateRange(file);
          const recordDates = transactionRecordDates(file);
          const existingSources = storedFieldFiles(locationId, file.fieldname).flatMap(stored => {
            const existingRange = stored.record.confirmedRange || stored.record.detectedRange;
            const overlap = intersectDateRanges(detectedRange, existingRange);
            return overlap ? [{ sourceId: stored.sourceId, existingRange, overlap }] : [];
          });
          return {
            field: file.fieldname,
            filename: file.filename,
            originalName: file.originalname,
            size: file.size,
            detectedRange,
            recordDates,
            existingRange: combinedDateRange(existingSources.map(source => ({ detectedRange: source.existingRange }))),
            overlapRange: combinedDateRange(existingSources.map(source => ({ detectedRange: source.overlap }))),
            existingSources,
            structure: structureValidations[index]
          };
        });
        const manifest = {
          token,
          location: locationId,
          locationLabel: selectedLocation.name,
          createdAt: new Date().toISOString(),
          files: inspectedFiles,
          detectedRange: combinedDateRange(inspectedFiles),
          hasOverlap: inspectedFiles.some(file => file.existingSources.length)
        };
        writeJsonAtomic(path.join(stagingDirectory, 'manifest.json'), manifest);
        return res.json(manifest);
      } catch (inspectionError) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(500).json({ error: 'No se pudieron inspeccionar los archivos seleccionados.' });
      }
    });
  });

  app.post('/api/uploads/transactions/confirm', (req, res) => {
    const { token, dateFrom, dateTo, confirmed, categoryConfirmed, overlapAction = 'keep', replaceOnlyIncomingDates = false } = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token || '')) {
      return res.status(400).json({ error: 'La revisión de carga es inválida o expiró.' });
    }
    if (confirmed !== true || !isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ error: 'Confirma un rango de fechas válido antes de guardar.' });
    }
    if (!['keep', 'replace'].includes(overlapAction)) {
      return res.status(400).json({ error: 'Selecciona si deseas mantener o reemplazar los días coincidentes.' });
    }
    const stagingDirectory = path.join(stagingRoot, token);
    const manifest = readJson(path.join(stagingDirectory, 'manifest.json'), null);
    const selectedLocation = manifest && activeLocation(manifest.location);
    if (!manifest || !selectedLocation) return res.status(404).json({ error: 'Esta revisión expiró. Selecciona nuevamente los archivos.' });
    const requiresCategoryConfirmation = manifest.files.some(file => ['kardex', 'waste'].includes(file.field));
    if (requiresCategoryConfirmation && categoryConfirmed !== true) {
      return res.status(400).json({ error: 'Confirma que seleccionaste el archivo correcto para Kardex o Merma antes de guardarlo.' });
    }
    if (Date.now() - new Date(manifest.createdAt).getTime() > STAGING_MAX_AGE_MS) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      return res.status(410).json({ error: 'Esta revisión expiró. Selecciona nuevamente los archivos.' });
    }
    if (replaceOnlyIncomingDates && (overlapAction !== 'replace' || manifest.files.length !== 1
      || !manifest.files[0].recordDates?.some(date => date >= dateFrom && date <= dateTo))) {
      return res.status(422).json({ error: 'El archivo no contiene fechas válidas para reemplazar registros.' });
    }
    const destination = transactionLocationRoot(manifest.location);
    ensureDir(destination);
    const index = readTransactionIndex(manifest.location);
    const movedFiles = [];
    const imports = {};
    try {
      for (const staged of manifest.files) {
        const incomingRange = intersectDateRanges(staged.detectedRange, { from: dateFrom, to: dateTo }) || { from: dateFrom, to: dateTo };
        const replacementRanges = replaceOnlyIncomingDates
          ? (staged.recordDates || []).filter(date => date >= dateFrom && date <= dateTo)
            .map(date => ({ from: date, to: date }))
          : [incomingRange];
        const overlaps = storedFieldFiles(manifest.location, staged.field).flatMap(stored => {
          const existingRange = stored.record.confirmedRange || stored.record.detectedRange;
          const overlap = intersectDateRanges(incomingRange, existingRange);
          return overlap ? [{ stored, overlap }] : [];
        });
        const replacementEffects = overlapAction === 'replace'
          ? overlaps.flatMap(({ stored, overlap }) => replacementRanges
            .filter(range => intersectDateRanges(range, overlap))
            .map(range => ({ sourceId: stored.sourceId, range })))
          : [];
        let stagedFile = staged;
        if (staged.field === 'sales') {
          const prepared = prepareIncrementalSales(
            staged,
            manifest.location,
            stagingDirectory,
            overlapAction === 'replace' ? replacementRanges : []
          );
          imports.sales = prepared.stats;
          stagedFile = prepared.staged;
          if (!stagedFile) continue;
        } else if (staged.field === 'mercadopago') {
          const prepared = prepareIncrementalMercadoPago(
            staged,
            manifest.location,
            stagingDirectory,
            overlapAction === 'replace' ? replacementRanges : []
          );
          imports.mercadopago = prepared.stats;
          stagedFile = prepared.staged;
          if (!stagedFile) continue;
        } else if (staged.field === 'payment-details') {
          const prepared = prepareIncrementalPaymentDetails(
            staged,
            manifest.location,
            stagingDirectory,
            overlapAction === 'replace' ? replacementRanges : []
          );
          imports['payment-details'] = prepared.stats;
          stagedFile = prepared.staged;
          if (!stagedFile) continue;
        }
        const id = crypto.randomUUID();
        const source = path.join(stagingDirectory, stagedFile.filename);
        const target = path.join(destination, stagedFile.filename);
        fs.renameSync(source, target);
        movedFiles.push(target);
        const record = {
          id,
          name: stagedFile.filename,
          originalName: stagedFile.originalName,
          size: stagedFile.size,
          detectedRange: stagedFile.detectedRange || staged.detectedRange,
          confirmedRange: { from: dateFrom, to: dateTo },
          transactionCount: stagedFile.transactionCount,
          rowCount: stagedFile.rowCount,
          latestTransactionAt: stagedFile.latestTransactionAt,
          overlapAction,
          replacementEffects,
          savedAt: new Date().toISOString(),
          url: `/uploads/transactions/${manifest.location}/${encodeURIComponent(stagedFile.filename)}`
        };
        index.fields ||= {};
        index.fields[staged.field] ||= { files: [] };
        index.fields[staged.field].files.push(record);
        imports[staged.field] = { ...(imports[staged.field] || {}), saved: true, overlapCount: overlaps.length };
      }
      rebuildTransactionExclusions(index);
      index.updatedAt = new Date().toISOString();
      writeTransactionIndex(manifest.location, index);
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      return res.json({ ok: true, location: manifest.location, overlapAction, imports });
    } catch (confirmationError) {
      movedFiles.forEach(filePath => fs.rmSync(filePath, { force: true }));
      return res.status(500).json({ error: 'No se pudo guardar la carga transaccional confirmada.' });
    }
  });

  app.get('/api/transactions/:location/:field/preview', (req, res) => {
    const location = activeLocation(req.params.location);
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    const stored = storedFieldFiles(location.id, req.params.field).find(item => item.sourceId === req.query.source);
    if (!stored) return res.status(404).json({ error: 'No se encontró la carga transaccional.' });
    try {
      return res.json(buildSpreadsheetPreview(stored.filePath, stored.record.originalName || stored.record.name, {
        field: req.params.field,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo
      }));
    } catch (error) {
      return res.status(422).json({ error: error.message || 'No se pudo previsualizar esta carga.' });
    }
  });

  app.delete('/api/transactions/:location/:field', (req, res) => {
    if (String(req.query.source || '').startsWith('toteat-api:')) return res.status(409).json({ error: 'Esta fuente se actualiza desde Toteat. Administra la sincronización en Configuración.' });
    const location = activeLocation(req.params.location);
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    const index = readTransactionIndex(location.id);
    const files = index.fields?.[req.params.field]?.files || [];
    const position = files.findIndex(record => record.id === req.query.source);
    if (position < 0) return res.status(404).json({ error: 'No se encontró la carga transaccional.' });
    const [record] = files.splice(position, 1);
    rebuildTransactionExclusions(index);
    writeTransactionIndex(location.id, index);
    removeStoredRecords(transactionLocationRoot(location.id), record);
    return res.json({ ok: true, deleted: { location: location.id, field: req.params.field, source: record.id } });
  });

  app.post('/api/transactions/:location/:field/remove', (req, res) => {
    const location = activeLocation(req.params.location);
    const field = String(req.params.field || '');
    const action = String(req.body?.action || '');
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    if (toteatSalesSync.source(location.id, field).length || toteatSalesSync.purchases.source(location.id, field).length) return res.status(409).json({ error: 'Esta categoría incluye datos por API. Administra su sincronización en Configuración; no se eliminaron datos.' });
    if (!fieldsForLocation(location.type).includes(field)) return res.status(400).json({ error: 'La categoría no corresponde a esta ubicación.' });
    if (!['last', 'all'].includes(action)) return res.status(400).json({ error: 'Selecciona si deseas revertir la última carga o eliminar toda la información.' });
    if (req.body?.confirmed !== true || req.body?.confirmationText !== 'ELIMINAR') {
      return res.status(400).json({ error: 'Debes confirmar la eliminación escribiendo ELIMINAR.' });
    }
    try {
      const stored = storedFieldFiles(location.id, field);
      if (!stored.length) return res.status(404).json({ error: 'No hay información guardada para esta categoría.' });
      const targets = action === 'all'
        ? stored
        : [[...stored].sort((left, right) =>
          String(right.record.savedAt || right.week || '').localeCompare(String(left.record.savedAt || left.week || '')))[0]];
      let deletedCount = 0;
      for (const target of targets) {
        if (deleteStoredSource(location.id, field, target)) deletedCount += 1;
      }
      const index = readTransactionIndex(location.id);
      rebuildTransactionExclusions(index);
      index.updatedAt = new Date().toISOString();
      writeTransactionIndex(location.id, index);
      return res.json({
        ok: true,
        action,
        deletedCount,
        remainingCount: storedFieldFiles(location.id, field).length
      });
    } catch (error) {
      return res.status(500).json({ error: 'No se pudo eliminar la información seleccionada.' });
    }
  });

  app.post('/api/uploads/weekly/inspect', (req, res) => {
    const { location, week } = req.query;
    const selectedLocation = activeLocation(location);
    if (!selectedLocation) return res.status(400).json({ error: 'Select a valid location.' });
    if (!isValidWeekKey(week)) return res.status(400).json({ error: `week must be a Monday in YYYY-MM-DD format on or after ${FIRST_WEEK}` });

    cleanExpiredStaging(stagingRoot);
    const token = crypto.randomUUID();
    const stagingDirectory = path.join(stagingRoot, token);
    ensureDir(stagingDirectory);
    const storage = multer.diskStorage({
      destination: (uploadReq, file, callback) => callback(null, stagingDirectory),
      filename: (uploadReq, file, callback) => callback(null, safeFilename(file))
    });
    const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE, files: WEEK_FIELDS.length } }).fields(WEEK_FIELDS);

    upload(req, res, error => {
      if (error) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: multerErrorMessage(error) });
      }
      const files = uploadedFiles(req);
      if (files.length === 0) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: 'Select at least one file to inspect.' });
      }
      const allowedFields = fieldsForLocation(selectedLocation.type);
      const invalidField = files.find(file => !allowedFields.includes(file.fieldname));
      if (invalidField) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(400).json({ error: `${selectedLocation.name} does not accept ${invalidField.fieldname} files.` });
      }

      try {
        const inspectedFiles = files.map(file => ({
          field: file.fieldname,
          filename: file.filename,
          originalName: file.originalname,
          size: file.size,
          detectedRange: detectFileDateRange(file)
        }));
        const manifest = {
          token,
          location,
          locationLabel: selectedLocation.name,
          week,
          createdAt: new Date().toISOString(),
          files: inspectedFiles,
          detectedRange: combinedDateRange(inspectedFiles)
        };
        writeJsonAtomic(path.join(stagingDirectory, 'manifest.json'), manifest);
        return res.json(manifest);
      } catch (inspectionError) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(500).json({ error: 'Could not inspect the selected files.' });
      }
    });
  });

  app.post('/api/uploads/weekly/confirm', (req, res) => {
    const { token, dateFrom, dateTo, confirmed } = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token || '')) {
      return res.status(400).json({ error: 'Invalid or expired upload review.' });
    }
    if (confirmed !== true) return res.status(400).json({ error: 'The detected dates must be confirmed before saving.' });
    if (!isValidDate(dateFrom) || !isValidDate(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ error: 'Enter a valid confirmed date range.' });
    }

    const stagingDirectory = path.join(stagingRoot, token);
    const manifestPath = path.join(stagingDirectory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'This upload review expired. Select the files again.' });

    let movedFiles = [];
    try {
      const manifest = readJson(manifestPath, null);
      const selectedLocation = manifest && activeLocation(manifest.location);
      if (!manifest || !selectedLocation || !isValidWeekKey(manifest.week)) throw new Error('Invalid manifest');
      if (Date.now() - new Date(manifest.createdAt).getTime() > STAGING_MAX_AGE_MS) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        return res.status(410).json({ error: 'This upload review expired. Select the files again.' });
      }
      const destination = path.join(weeksRoot, manifest.week, manifest.location);
      ensureDir(destination);
      const metadataPath = path.join(destination, 'meta.json');
      const previous = readJson(metadataPath, { files: {} });
      const next = {
        week: manifest.week,
        location: manifest.location,
        locationLabel: selectedLocation.name,
        savedAt: new Date().toISOString(),
        detectedRange: manifest.detectedRange,
        confirmedRange: { from: dateFrom, to: dateTo },
        files: { ...(previous.files || {}) }
      };
      const replaced = [];
      let salesImport = null;

      for (const staged of manifest.files) {
        let stagedFile = staged;
        if (staged.field === 'sales') {
          const prepared = prepareIncrementalSales(staged, manifest.location, stagingDirectory);
          salesImport = prepared.stats;
          stagedFile = prepared.staged;
          if (!stagedFile) continue;
        }
        const source = path.join(stagingDirectory, stagedFile.filename);
        const target = path.join(destination, stagedFile.filename);
        fs.renameSync(source, target);
        movedFiles.push(target);
        const record = {
          name: stagedFile.filename,
          originalName: stagedFile.originalName,
          size: stagedFile.size,
          detectedRange: stagedFile.detectedRange,
          confirmedRange: { from: dateFrom, to: dateTo },
          transactionCount: stagedFile.transactionCount,
          rowCount: stagedFile.rowCount,
          latestTransactionAt: stagedFile.latestTransactionAt,
          savedAt: next.savedAt,
          url: `/uploads/weeks/${manifest.week}/${manifest.location}/${encodeURIComponent(stagedFile.filename)}`
        };
        if (staged.field === 'sales') {
          const parts = [...salesRecordParts(next.files.sales), record];
          next.files.sales = {
            ...record,
            originalName: stagedFile.originalName,
            parts,
            uploadCount: parts.length,
            transactionCount: parts.reduce((sum, part) => sum + (part.transactionCount || 0), 0)
          };
        } else {
          if (next.files[staged.field]) replaced.push(next.files[staged.field]);
          next.files[staged.field] = record;
        }
      }

      writeJsonAtomic(metadataPath, next);
      replaced.forEach(record => removeStoredRecords(destination, record));
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      return res.json({ ok: true, week: manifest.week, location: manifest.location, meta: next, salesImport });
    } catch (confirmationError) {
      movedFiles.forEach(filePath => fs.rmSync(filePath, { force: true }));
      return res.status(500).json({ error: 'Could not save the confirmed weekly upload.' });
    }
  });

  app.get('/api/weeks', (req, res) => {
    const { location } = req.query;
    if (!activeLocation(location)) return res.status(400).json({ error: 'Select a valid location.' });
    try {
      const output = {};
      const weeks = fs.readdirSync(weeksRoot)
        .filter(week => isValidWeekKey(week) && fs.statSync(path.join(weeksRoot, week)).isDirectory());
      for (const week of weeks) {
        const metadataPath = path.join(weeksRoot, week, location, 'meta.json');
        if (fs.existsSync(metadataPath)) output[week] = readJson(metadataPath, null);
      }
      return res.json(output);
    } catch (error) {
      return res.status(500).json({ error: 'Could not list weekly uploads.' });
    }
  });

  app.get('/api/weeks/:week', (req, res) => {
    const { week } = req.params;
    const { location } = req.query;
    if (!isValidWeekKey(week)) return res.status(400).json({ error: 'Invalid week.' });
    if (!activeLocation(location)) return res.status(400).json({ error: 'Select a valid location.' });
    try {
      const metadata = readJson(path.join(weeksRoot, week, location, 'meta.json'), null);
      if (!metadata) return res.status(404).json({ error: 'No data for that week and location.' });
      return res.json(metadata);
    } catch (error) {
      return res.status(500).json({ error: 'Could not read weekly upload metadata.' });
    }
  });

  app.get('/api/weeks/:week/:location/:field/preview', (req, res) => {
    const { week, location, field } = req.params;
    if (!isValidWeekKey(week)) return res.status(400).json({ error: 'Invalid week.' });
    if (!activeLocation(location)) return res.status(400).json({ error: 'Select a valid location.' });
    try {
      const destination = path.join(weeksRoot, week, location);
      const metadata = readJson(path.join(destination, 'meta.json'), null);
      if (!metadata?.files || !Object.hasOwn(metadata.files, field)) {
        return res.status(404).json({ error: 'Weekly file not found.' });
      }
      const record = metadata.files[field];
      if (field === 'sales' && salesRecordParts(record).length > 1) {
        return res.json(buildCombinedSalesPreview(destination, record));
      }
      const filePath = path.resolve(destination, record.name);
      if (path.dirname(filePath) !== path.resolve(destination) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Stored weekly file not found.' });
      }
      return res.json(buildSpreadsheetPreview(filePath, record.originalName || record.name, {
        field,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo
      }));
    } catch (error) {
      return res.status(422).json({ error: error.message || 'Could not preview this weekly file.' });
    }
  });

  app.delete('/api/weeks/:week/:location/:field', (req, res) => {
    const { week, location, field } = req.params;
    if (!isValidWeekKey(week)) return res.status(400).json({ error: 'Invalid week.' });
    if (!activeLocation(location)) return res.status(400).json({ error: 'Select a valid location.' });
    try {
      const destination = path.join(weeksRoot, week, location);
      const metadataPath = path.join(destination, 'meta.json');
      const metadata = readJson(metadataPath, null);
      if (!metadata?.files || !Object.hasOwn(metadata.files, field)) {
        return res.status(404).json({ error: 'Weekly file not found.' });
      }
      const record = metadata.files[field];
      delete metadata.files[field];
      metadata.savedAt = new Date().toISOString();
      writeJsonAtomic(metadataPath, metadata);
      removeStoredRecords(destination, record);
      return res.json({ ok: true, deleted: { week, location, field } });
    } catch (error) {
      return res.status(500).json({ error: 'Could not delete the weekly file.' });
    }
  });

  const masterStorage = multer.diskStorage({
    destination: (req, file, callback) => callback(null, mastersRoot),
    filename: (req, file, callback) => callback(null, safeFilename(file))
  });
  const masterUpload = multer({ storage: masterStorage, fileFilter, limits: { fileSize: MAX_FILE_SIZE, files: MASTER_FIELDS.length } }).fields(MASTER_FIELDS);

  app.post('/upload/master', (req, res) => {
    masterUpload(req, res, error => {
      if (error) {
        removeFiles(uploadedFiles(req));
        return res.status(400).json({ error: multerErrorMessage(error) });
      }
      const files = uploadedFiles(req);
      if (files.length === 0) return res.status(400).json({ error: 'Select at least one master file to upload.' });
      const structureValidations = files.map(validateUploadStructure);
      const mismatch = structureValidations.find(validation => !validation.ok);
      if (mismatch) {
        removeFiles(files);
        return res.status(422).json({
          code: 'FILE_STRUCTURE_MISMATCH',
          error: mismatch.error,
          mismatch
        });
      }
      try {
        const saved = {};
        for (const [field, fieldFiles] of Object.entries(req.files)) {
          const validFrom = req.body[`${field}-from`] || null;
          if (!isValidDate(validFrom)) {
            removeFiles(files);
            return res.status(400).json({ error: `A valid start date is required for ${field}.` });
          }
          const file = fieldFiles[0];
          saved[field] = { field, ...describeFile(file, '/uploads/masters'), savedAt: new Date().toISOString(), validFrom };
        }
        const indexPath = path.join(mastersRoot, 'masters.json');
        const index = readJson(indexPath, {});
        const conflicts = [];
        for (const [version, group] of Object.entries(index)) {
          for (const [field, incoming] of Object.entries(saved)) {
            const existing = group[field];
            if (existing?.validFrom === incoming.validFrom) {
              conflicts.push({
                version,
                field,
                validFrom: incoming.validFrom,
                existingOriginalName: existing.originalName || existing.name
              });
            }
          }
        }

        if (conflicts.length && req.query.replace !== 'true') {
          removeFiles(files);
          return res.status(409).json({
            code: 'MASTER_DATE_CONFLICT',
            error: 'A master file of the same kind already exists with that start date.',
            conflicts
          });
        }

        const replacedRecords = [];
        for (const conflict of conflicts) {
          const group = index[conflict.version];
          if (!group?.[conflict.field]) continue;
          replacedRecords.push(group[conflict.field]);
          delete group[conflict.field];
          if (Object.keys(group).length === 0) delete index[conflict.version];
        }
        index[new Date().toISOString()] = saved;
        writeJsonAtomic(indexPath, index);
        replacedRecords.forEach(record => removeStoredRecords(mastersRoot, record));
        return res.json({ ok: true, saved });
      } catch (writeError) {
        removeFiles(files);
        return res.status(500).json({ error: 'Could not save master-file metadata.' });
      }
    });
  });

  app.get('/api/masters', (req, res) => {
    try {
      const index=readJson(path.join(mastersRoot,'masters.json'),{});
      res.json(synchronizedOnly ? Object.fromEntries(Object.entries(index).map(([version,group])=>[version,Object.fromEntries(Object.entries(group).filter(([,record])=>record.source==='toteat-shared-api'))]).filter(([,group])=>Object.keys(group).length)) : index);
    } catch (error) {
      res.status(500).json({ error: 'Could not read master-file metadata.' });
    }
  });

  app.get('/api/masters/:version/:field/preview', (req, res) => {
    try {
      const index = readJson(path.join(mastersRoot, 'masters.json'), {});
      const group = index[req.params.version];
      if (!group || !Object.hasOwn(group, req.params.field)) {
        return res.status(404).json({ error: 'Master file not found.' });
      }
      const record = group[req.params.field];
      const filePath = path.resolve(mastersRoot, record.name);
      if (path.dirname(filePath) !== path.resolve(mastersRoot) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Stored master file not found.' });
      }

      return res.json(buildSpreadsheetPreview(filePath, record.originalName || record.name, { field: req.params.field, complete: true }));
    } catch (error) {
      return res.status(422).json({ error: 'Could not preview this master file.' });
    }
  });

  app.delete('/api/masters/:version/:field', (req, res) => {
    const indexPath = path.join(mastersRoot, 'masters.json');
    try {
      const index = readJson(indexPath, {});
      const group = index[req.params.version];
      if (!group || !Object.hasOwn(group, req.params.field)) {
        return res.status(404).json({ error: 'Master file not found.' });
      }
      const record = group[req.params.field];
      delete group[req.params.field];
      if (Object.keys(group).length === 0) delete index[req.params.version];
      writeJsonAtomic(indexPath, index);
      removeStoredRecords(mastersRoot, record);
      return res.json({ ok: true, deleted: { version: req.params.version, field: req.params.field } });
    } catch (error) {
      return res.status(500).json({ error: 'Could not delete the master file.' });
    }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status || 500).json({ error: error.status === 404 ? 'File not found.' : 'Unexpected server error.' });
  });
  return app;
}

if (require.main === module) {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  createApp({ enableToteatSync: true }).listen(port, () => console.log(`Brewit running at http://localhost:${port}`));
}

module.exports = {
  createApp,
  createToteatAutomation,
  isValidWeekKey,
  detectFileDateRange,
  detectUploadStructure,
  validateUploadStructure,
  DEFAULT_LOCATIONS
};
