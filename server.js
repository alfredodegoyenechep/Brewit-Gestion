const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 3000;
const FIRST_WEEK = '2026-05-18';
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PREVIEW_MAX_ROWS = 200;
const PREVIEW_MAX_COLUMNS = 300;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set(['.csv', '.xls', '.xlsx', '.txt']);
const DEFAULT_LOCATIONS = [
  { id: 'store-1', name: 'Tienda 1', type: 'store' },
  { id: 'store-2', name: 'Tienda 2', type: 'store' },
  { id: 'main-warehouse', name: 'Bodega principal', type: 'warehouse' }
];
const WEEK_FIELDS = ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales', 'mercadopago'].map(name => ({ name, maxCount: 1 }));
const MASTER_FIELDS = [
  { name: 'master-catalog', maxCount: 1 },
  { name: 'product-hierarchy', maxCount: 1 },
  { name: 'ingredient-hierarchy', maxCount: 1 },
  { name: 'extras-hierarchy', maxCount: 1 },
  { name: 'master-recipes', maxCount: 1 },
  { name: 'master-suppliers', maxCount: 1 }
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
  return type === 'warehouse' ? ['kardex'] : ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales', 'mercadopago'];
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

function datesInText(value) {
  const text = String(value || '');
  const dates = [];
  for (const match of text.matchAll(/(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) {
    const parsed = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (parsed) dates.push(parsed);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)/g)) {
    const parsed = toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
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
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith('!')) continue;
        if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
          const parsed = toIsoDate(cell.v.getUTCFullYear(), cell.v.getUTCMonth() + 1, cell.v.getUTCDate());
          if (parsed) dates.add(parsed);
        } else if (typeof cell.v === 'string') {
          datesInText(cell.v).forEach(date => dates.add(date));
        }
        if (typeof cell.w === 'string') datesInText(cell.w).forEach(date => dates.add(date));
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
    return { field: 'unknown', reason: 'El archivo no pudo leerse como CSV, XLS, XLSX o TXT.' };
  }
  if (!sheets.length || !sheets.some(sheet => sheet.rows.length)) {
    return { field: 'unknown', reason: 'El archivo está vacío.' };
  }
  if (structureHasHeader(sheets, ['ID de orden', 'Fecha de creacion', 'Pago total'])) {
    return { field: 'sales', reason: 'Se detectaron columnas de órdenes, fecha de creación y pago total.' };
  }
  if (structureHasHeader(sheets, ['Fecha emisión', 'Documento', 'Proveedor/Para', 'PRODUCTO'])) {
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
  const hierarchySheet = sheets.find(sheet => structureHasHeader([sheet], ['ID Jerarquia', 'ID Nodo **', 'ID nodo padre']));
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
  if (expected === 'mercadopago') {
    return {
      ok: true,
      permissive: true,
      expected,
      detected: detected.field,
      reason: 'Aceptado sin validación estructural porque aún no existe un archivo MercadoPago de referencia.'
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
      rows: allRows.slice(0, PREVIEW_MAX_ROWS).map(row => row.slice(0, PREVIEW_MAX_COLUMNS)),
      totalRows: allRows.length,
      truncated: allRows.length > PREVIEW_MAX_ROWS || allRows.some(row => row.length > PREVIEW_MAX_COLUMNS)
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
  if (groups.length < 2) throw new Error('Kardex must contain at least two dated inventory groups.');
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

function buildWasteSummary(parsed, dateFrom, dateTo, catalog = null) {
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
    const catalogUnitCost = unitCostForRecipeUnit(catalogItem, product.unit);
    const unitCost = catalogUnitCost ?? 0;
    const total = Object.values(additions).reduce((sum, value) => sum + value, 0);
    return {
      code: product.code,
      name: product.name,
      unit: product.unit,
      additions,
      total,
      unitCost,
      totalCost: total * unitCost,
      costAvailable: catalogUnitCost !== null
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

function parseConsumptionProducts(filePath, dateFrom, dateTo) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
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
      .filter(item => item.date && item.date >= dateFrom && item.date <= dateTo);
    const score = dateColumns.length * 100 + (/prod|producto/i.test(sheetName) ? 10 : 0);
    candidates.push({ sheetName, rows, codeColumn, nameColumn, costColumn, dateColumns, score });
  }
  const selected = candidates.sort((left, right) => right.score - left.score)[0];
  if (!selected || !selected.dateColumns.length) {
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
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true, blankrows: false });
    const headerIndex = rows.slice(0, 5).findIndex(row => findHeaderColumn(row, ['ID Producto **', 'ID Producto']) >= 0);
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    const codeColumn = findHeaderColumn(headers, ['ID Producto **', 'ID Producto']);
    const nameColumn = findHeaderColumn(headers, ['Nombre Producto *', 'Nombre Producto']);
    const costColumn = findHeaderColumn(headers, ['Costo']);
    const unitColumn = findHeaderColumn(headers, ['Medida Base', 'Unidad Base', 'Unidad de Reportes']);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code) continue;
      catalog.set(code, {
        code,
        name: String(row[nameColumn] ?? '').trim(),
        unit: String(row[unitColumn] ?? '').trim(),
        unitCost: numericValue(row[costColumn]) || 0
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
        if (!purchaseUnit || numerator === null || denominator === null || denominator === 0) continue;
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

function applyCatalogProductCosts(result, catalog) {
  const productsWithoutMasterCost = [];
  const products = result.products.map(product => {
    const catalogItem = catalog.get(product.code);
    const catalogUnitCost = unitCostForRecipeUnit(catalogItem, product.unit);
    if (catalogUnitCost === null) productsWithoutMasterCost.push(product.code || product.name);
    const unitCost = catalogUnitCost ?? product.unitCost;
    return { ...product, unitCost, totalCost: product.quantity * unitCost };
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
  if (!catalogItem?.unitCost) return null;
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

function enrichKardexReport(report, consumption, catalog) {
  const itemsWithoutCost = new Set();
  const items = report.items.map(item => {
    const employeeConsumption = consumptionQuantityForKardex(consumption.employees, item.code, item.unit);
    const marketingConsumption = consumptionQuantityForKardex(consumption.marketing, item.code, item.unit);
    const baseTheoreticalFinal = Number(item.theoreticalFinal) || 0;
    const theoreticalFinal = baseTheoreticalFinal - employeeConsumption - marketingConsumption;
    const finalInventory = report.selection ? Number(item.finalInventory) || 0 : Number(item.physicalFinal) || 0;
    const difference = finalInventory - theoreticalFinal;
    const catalogUnitCost = unitCostForRecipeUnit(catalog?.get(item.code), item.unit);
    if (catalogUnitCost === null) itemsWithoutCost.add(item.code || item.name);
    const unitCost = catalogUnitCost ?? 0;
    return {
      ...item,
      employeeConsumption,
      marketingConsumption,
      baseTheoreticalFinal,
      theoreticalFinal,
      difference,
      unitCost,
      costAvailable: catalogUnitCost !== null,
      totalCost: difference * unitCost
    };
  });
  return {
    ...report,
    items,
    itemsWithoutCost: [...itemsWithoutCost],
    totalCost: items.reduce((sum, item) => sum + item.totalCost, 0)
  };
}

function buildIngredientConsumption(products, recipes, catalog) {
  const ingredients = new Map();
  const productsWithoutRecipe = new Set();
  const ingredientsWithoutCost = new Set();
  const ingredientsWithoutConversion = new Set();
  for (const product of products) {
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
      const unitCost = unitCostForRecipeUnit(catalogItem, canonical.unit);
      if (!catalogItem || !catalogItem.unitCost) ingredientsWithoutCost.add(recipe.ingredientId);
      else if (unitCost === null) ingredientsWithoutConversion.add(recipe.ingredientId);
      const key = `${recipe.ingredientId}:${canonical.unit}`;
      const current = ingredients.get(key) || {
        code: recipe.ingredientId,
        name: catalogItem?.name || recipe.ingredientName,
        unit: canonical.unit || catalogItem?.unit || '',
        quantity: 0,
        unitCost: unitCost || 0,
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
      marginPercent: netPrice ? ((netPrice - cost) / netPrice) * 100 : null,
      active: activeColumn < 0 || Boolean(numericValue(row[activeColumn])),
      hierarchyId: hierarchyIds[0] || null
    }];
  });
}

function parseIngredientsCatalog(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = workbook.SheetNames.filter(name => /^ingr|ingred/i.test(name));
  if (!sheetNames.length) throw new Error('El maestro no contiene una hoja de ingredientes.');
  const ingredients = new Map();
  for (const sheetName of sheetNames) {
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
      if (!code) continue;
      ingredients.set(code.toUpperCase(), {
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
    const ingredientHierarchyColumn = findHeaderColumn(headers, ['Jerarquías de Ingredientes *', 'Jerarquía de Ingredientes']);
    const extrasHierarchyColumn = findHeaderColumn(headers, ['Jerarquías de Extras *', 'Jerarquía de Extras']);
    for (const row of rows.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? '').trim();
      if (!code || (activeColumn >= 0 && !Boolean(numericValue(row[activeColumn])))) continue;
      const item = {
        code,
        name: repairMojibake(row[nameColumn]) || code,
        unit: String(row[unitColumn] ?? '').trim(),
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

function parseNamedHierarchies(filePath, nameHeaders) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null, raw: true });
  const hierarchyMap = new Map();
  for (const row of rows) {
    const id = String(rowValue(row, ['ID Jerarquia', 'ID Jerarquía']) ?? '').trim();
    if (!id) continue;
    hierarchyMap.set(id, {
      id,
      name: repairMojibake(rowValue(row, nameHeaders)) || id,
      parentId: String(rowValue(row, ['ID nodo padre']) ?? '').trim() || null,
      order: numericValue(rowValue(row, ['Orden'])) || 0
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
    const id = String(rowValue(row, ['ID Jerarquia', 'ID Jerarquía']) ?? '').trim();
    if (!id) continue;
    hierarchyMap.set(id, {
      id,
      name: repairMojibake(rowValue(row, ['Nombre Jerarquía Producto *', 'Nombre Jerarquia Producto *'])) || id,
      parentId: String(rowValue(row, ['ID nodo padre']) ?? '').trim() || null,
      order: numericValue(rowValue(row, ['Orden'])) || 0
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

function cellDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toIsoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? toIsoDate(parsed.y, parsed.m, parsed.d) : null;
  }
  return datesInText(value)[0] || null;
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
  const date = cellDate(rowValue(row, ['Fecha emisión', 'Fecha de emisión', 'Fecha']));
  if (!date) return null;
  const supplierTaxId = String(rowValue(row, ['Número identificador fiscal', 'RUT/Fiscal ID', 'RUT']) || '')
    .replace(/[^0-9kK]/g, '').toUpperCase();
  const sourceSupplier = String(rowValue(row, ['Proveedor/Para', 'Proveedor']) || '').trim() || 'Proveedor sin identificar';
  const supplier = supplierNames.get(supplierTaxId) || sourceSupplier;
  const billedQuantity = numericValue(rowValue(row, ['Q.Fac', 'Cantidad facturada']));
  const receivedQuantity = numericValue(rowValue(row, ['Q.Rec', 'Cantidad recibida']));
  const quantity = billedQuantity ?? receivedQuantity ?? 0;
  const unit = String(rowValue(row, ['Um.Fac', 'Unidad facturada', 'Um.Rec', 'Unidad recibida']) || '').trim();
  const listedUnitPrice = numericValue(rowValue(row, ['Costo'])) || 0;
  const negotiatedUnitPrice = numericValue(rowValue(row, ['Costo negociado'])) || 0;
  const netAmount = numericValue(rowValue(row, ['Monto neto'])) || 0;
  const discount = numericValue(rowValue(row, ['Descuento'])) || 0;
  const totalAmount = numericValue(rowValue(row, ['Monto total'])) ?? netAmount - discount;
  const effectiveUnitPrice = quantity ? totalAmount / quantity : listedUnitPrice;
  const document = String(rowValue(row, ['Documento', 'Número documento']) || '').trim();
  const line = String(rowValue(row, ['Lin', 'Línea']) || '').trim();
  const code = String(rowValue(row, ['Cod', 'Código', 'Código producto']) || '').trim();
  const product = String(rowValue(row, ['PRODUCTO', 'Producto', 'Insumo']) || '').trim();
  const supplierKey = supplierTaxId || normalizeHeader(supplier);
  return {
    date,
    locationId: location.id,
    locationName: location.name,
    supplierKey,
    supplier,
    supplierTaxId,
    documentType: String(rowValue(row, ['Tipo Documento', 'Tipo de documento']) || '').trim(),
    document,
    line,
    code,
    product,
    quantity,
    unit,
    listedUnitPrice,
    negotiatedUnitPrice,
    effectiveUnitPrice,
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
  const reference = dailySales[referenceDate] || { gross: 0, discounts: 0, net: 0 };
  const sameWeekdayDates = historicalDates.filter(date => new Date(`${date}T00:00:00.000Z`).getUTCDay() === referenceDayNumber);
  const priorEight = sameWeekdayDates.filter(date => date < referenceDate).sort().reverse().slice(0, 8);
  const sameWeekdayAverage = priorEight.length
    ? priorEight.reduce((sum, date) => sum + dailySales[date].net, 0) / priorEight.length
    : 0;
  const rank = dates => ({
    position: hasReferenceDay && dates.length ? 1 + dates.filter(date => dailySales[date].net > reference.net).length : null,
    total: dates.length
  });
  const sumRange = (from, to) => historicalDates
    .filter(date => date >= from && date <= to)
    .reduce((sum, date) => sum + dailySales[date].net, 0);
  const variationPercent = (current, previous) => {
    if (!previous) return current ? 100 : 0;
    return ((current / previous) - 1) * 100;
  };
  const addSequentialVariation = rows => rows.map((item, index) => ({
    ...item,
    variationPercent: index === rows.length - 1
      ? null
      : variationPercent(item.netSales, rows[index + 1].netSales)
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
    week: { from: weekStart, to: referenceDate, netSales: sumRange(weekStart, referenceDate) },
    month: { from: monthStart, to: referenceDate, netSales: sumRange(monthStart, referenceDate) },
    statistics: { months, weeks, days, equivalentDays },
    coverage: historicalDates.length ? { from: historicalDates[0], to: historicalDates.at(-1) } : null
  };
}

function buildIntradayReport(dailySales, transactionsByDate, todayKey) {
  const todayWeekday = new Date(`${todayKey}T00:00:00.000Z`).getUTCDay();
  const completedDates = Object.keys(dailySales).filter(date => date < todayKey);
  const bestDate = dates => dates.sort((left, right) => {
    const difference = dailySales[right].net - dailySales[left].net;
    return difference || right.localeCompare(left);
  })[0] || null;
  const sameWeekdayDate = bestDate(completedDates.filter(date =>
    new Date(`${date}T00:00:00.000Z`).getUTCDay() === todayWeekday));
  const monthDate = bestDate(completedDates.filter(date => date.startsWith(todayKey.slice(0, 7))));
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
  const todayTransactions = transactionsByDate[todayKey] || [];
  const cutoffTime = todayTransactions.reduce((latest, transaction) =>
    !latest || transaction.time > latest ? transaction.time : latest, null);
  const todayNetSales = cutoffTime ? cumulativeAt(todayKey, cutoffTime) : 0;
  const rankingAtCutoff = dates => ({
    position: cutoffTime
      ? 1 + dates.filter(date => date !== todayKey && cumulativeAt(date, cutoffTime) > todayNetSales).length
      : null,
    total: cutoffTime ? dates.length : 0
  });
  const priorSameWeekdays = completedDates
    .filter(date => new Date(`${date}T00:00:00.000Z`).getUTCDay() === todayWeekday)
    .sort()
    .reverse();
  const priorEight = priorSameWeekdays.slice(0, 8);
  const sameWeekdayAverage = cutoffTime && priorEight.length
    ? priorEight.reduce((sum, date) => sum + cumulativeAt(date, cutoffTime), 0) / priorEight.length
    : 0;
  return {
    today: {
      date: todayKey,
      cutoffTime,
      netSales: todayNetSales,
      generalRank: rankingAtCutoff([...completedDates, ...(cutoffTime ? [todayKey] : [])]),
      sameWeekdayRank: rankingAtCutoff([...priorSameWeekdays, ...(cutoffTime ? [todayKey] : [])]),
      sameWeekdayAverage,
      comparisonToAveragePercent: cutoffTime && sameWeekdayAverage
        ? ((todayNetSales / sameWeekdayAverage) - 1) * 100
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
      today: cumulativeAt(todayKey, block.end),
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

function createApp(options = {}) {
  const app = express();
  const uploadsRoot = options.uploadsRoot || process.env.BREWIT_UPLOADS_ROOT || path.join(__dirname, 'uploads');
  const weeksRoot = path.join(uploadsRoot, 'weeks');
  const mastersRoot = path.join(uploadsRoot, 'masters');
  const stagingRoot = path.join(uploadsRoot, '.staging');
  const configRoot = path.join(uploadsRoot, 'config');
  const transactionsRoot = path.join(uploadsRoot, 'transactions');
  const productReportsRoot = path.join(uploadsRoot, 'reports', 'products');
  const purchaseOrdersRoot = path.join(uploadsRoot, 'reports', 'purchase-orders');
  const trashLocationsRoot = path.join(uploadsRoot, 'trash', 'locations');
  const locationsPath = path.join(configRoot, 'locations.json');
  const companyProfilePath = path.join(configRoot, 'company-profile.json');
  const purchaseOrderCounterPath = path.join(configRoot, 'purchase-order-counter.json');
  const purchaseProjectionPoliciesPath = path.join(configRoot, 'purchase-projection-policies.json');
  ensureDir(weeksRoot);
  ensureDir(mastersRoot);
  ensureDir(stagingRoot);
  ensureDir(configRoot);
  ensureDir(transactionsRoot);
  ensureDir(productReportsRoot);
  ensureDir(purchaseOrdersRoot);
  ensureDir(trashLocationsRoot);
  migrateLegacySundayWeeks(weeksRoot);
  if (!fs.existsSync(locationsPath)) {
    const createdAt = new Date().toISOString();
    writeJsonAtomic(locationsPath, {
      locations: DEFAULT_LOCATIONS.map(location => ({ ...location, status: 'active', createdAt }))
    });
  }
  if (!fs.existsSync(companyProfilePath)) {
    writeJsonAtomic(companyProfilePath, { name: 'CODE SPA', taxId: '', logoUrl: 'docs/brewit-final-01.jpg' });
  }

  function readLocations() {
    return readJson(locationsPath, { locations: [] });
  }

  function activeLocation(id) {
    return readLocations().locations.find(location => location.id === id && location.status === 'active') || null;
  }

  function publicLocation(location) {
    return { ...location, label: location.name, fields: fieldsForLocation(location.type) };
  }

  function readCompanyProfile() {
    return readJson(companyProfilePath, { name: 'CODE SPA', taxId: '', logoUrl: 'docs/brewit-final-01.jpg' });
  }

  function readPurchaseProjectionPolicies() {
    return readJson(purchaseProjectionPoliciesPath, { locations: {} });
  }

  function projectionToday() {
    const configured = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
    const now = configured ? new Date(`${configured}T12:00:00.000Z`) : new Date();
    return configured || toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
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
    const index = readTransactionIndex(locationId);
    const root = transactionLocationRoot(locationId);
    return (index.fields?.[field]?.files || []).flatMap(record => {
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
  }

  function storedSalesFiles(locationId) {
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
    return [...output, ...storedTransactionFiles(locationId, 'sales')];
  }

  function lac001SubstitutionSummary(locationId, dateFrom, dateTo, recipes, catalog) {
    const targetCodes = ['BX1010', 'BX1020', 'BX1030'];
    const targetCodeSet = new Set(targetCodes);
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
    const seenRows = new Set();
    const warnings = [];

    for (const stored of storedSalesFiles(locationId)) {
      try {
        const currentBaseByOrder = new Map();
        for (const row of readSalesRows(stored.filePath)) {
          const date = cellDate(rowValue(row, ['Fecha de creacion', 'Fecha de creación', 'Fecha de cierre']));
          if (!date || date < dateFrom || date > dateTo || dateIsExcluded(date, stored.excludedRanges)) continue;
          const canonicalRow = Object.entries(row)
            .map(([key, value]) => [normalizeHeader(key), value instanceof Date ? value.toISOString() : String(value ?? '').trim()])
            .sort(([left], [right]) => left.localeCompare(right));
          const rowKey = `${locationId}:${crypto.createHash('sha256').update(JSON.stringify(canonicalRow)).digest('hex')}`;
          if (seenRows.has(rowKey)) continue;
          seenRows.add(rowKey);

          const orderKey = `${locationId}:${salesTransactionKey(row)}`;
          const code = String(rowValue(row, ['ID Producto', 'ID de Producto']) ?? '').trim().toUpperCase();
          if (!code) continue;
          if (!code.startsWith('BX')) currentBaseByOrder.set(orderKey, code);
          if (!targetCodeSet.has(code)) continue;

          const quantity = Math.max(0, numericValue(rowValue(row, ['Cantidad'])) ?? 1);
          if (!quantity) continue;
          const detail = rowsByCode.get(code);
          detail.orderKeys.add(orderKey);
          detail.substitutionCount += quantity;
          allOrderKeys.add(orderKey);

          const baseProductCode = currentBaseByOrder.get(orderKey);
          const lac001Lines = (recipes?.get(baseProductCode) || [])
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
      } catch {
        warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name}.`);
      }
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
        unresolvedSubstitutionCount: item.unresolvedSubstitutionCount
      };
    });
    return {
      dateFrom,
      dateTo,
      salesCount: allOrderKeys.size,
      substitutionCount: items.reduce((sum, item) => sum + item.substitutionCount, 0),
      matchedSubstitutionCount: items.reduce((sum, item) => sum + item.matchedSubstitutionCount, 0),
      lac001VolumeLiters: items.reduce((sum, item) => sum + item.lac001VolumeLiters, 0),
      unresolvedSubstitutionCount: items.reduce((sum, item) => sum + item.unresolvedSubstitutionCount, 0),
      warnings,
      items
    };
  }

  function storedWeeklyFiles(locationId, field) {
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
          if (!metrics.has(key)) metrics.set(key, metric.label);
        });
        for (const product of parsed.products) {
          const productKey = product.code || normalizeHeader(product.name);
          if (!productMap.has(productKey)) {
            productMap.set(productKey, { code: product.code, name: product.name, unit: product.unit, values: new Map() });
          }
          const target = productMap.get(productKey);
          for (const metric of group.metrics) {
            const valueKey = `${group.date}|${metric.normalized}`;
            if (!target.values.has(valueKey)) target.values.set(valueKey, numericValue(product.row[metric.column]) || 0);
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
      for (let date = dateFrom; date <= dateTo; date = addDays(date, 1)) {
        if (dateIsExcluded(date, source.excludedRanges)) continue;
        try {
          const parsed = parseConsumptionProducts(source.filePath, date, date);
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

  function latestMasterFile(field, effectiveDate) {
    const index = readJson(path.join(mastersRoot, 'masters.json'), {});
    const candidates = [];
    for (const [version, group] of Object.entries(index)) {
      const record = group[field];
      if (!record || !record.name || !isValidDate(record.validFrom) || record.validFrom > effectiveDate) continue;
      const filePath = path.resolve(mastersRoot, record.name);
      if (path.dirname(filePath) !== path.resolve(mastersRoot) || !fs.existsSync(filePath)) continue;
      candidates.push({ ...record, version, filePath });
    }
    return candidates.sort((left, right) =>
      right.validFrom.localeCompare(left.validFrom)
      || String(right.savedAt || right.version).localeCompare(String(left.savedAt || left.version)))[0] || null;
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
    row.forEach((value, column) => {
      const isDateColumn = /\b(fecha|date)\b/.test(normalizeHeader(header[column]));
      const parsed = value instanceof Date || typeof value === 'string' || isDateColumn ? cellDate(value) : null;
      if (parsed) dates.push(parsed);
      if (typeof value === 'string') datesInText(value).forEach(date => dates.push(date));
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

  function mercadoPagoHistory(locationId, additionalExcludedRanges = []) {
    const keys = new Set();
    for (const stored of storedTransactionFiles(locationId, 'mercadopago')) {
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

  function prepareIncrementalMercadoPago(staged, locationId, stagingDirectory, additionalExcludedRanges = []) {
    const source = path.join(stagingDirectory, staged.filename);
    const sheets = readGenericTransactionSheets(source);
    const historyKeys = mercadoPagoHistory(locationId, additionalExcludedRanges);
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
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31) || 'MercadoPago');
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

  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/uploads/weeks', express.static(weeksRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/transactions', express.static(transactionsRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/masters', express.static(mastersRoot, { fallthrough: false, dotfiles: 'deny' }));

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
  app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
  app.get('/vendor/xlsx.full.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')));
  app.get('/docs/brewit-final-01.jpg', (req, res) => res.sendFile(path.join(__dirname, 'docs', 'brewit-final-01.jpg')));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
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

  app.patch('/api/config/company', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const taxId = String(req.body?.taxId || '').trim();
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'La razón social debe tener entre 2 y 100 caracteres.' });
    if (taxId.length > 30) return res.status(400).json({ error: 'El RUT no puede superar 30 caracteres.' });
    const profile = { ...readCompanyProfile(), name, taxId, updatedAt: new Date().toISOString() };
    writeJsonAtomic(companyProfilePath, profile);
    return res.json(profile);
  });

  app.post('/api/config/locations', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const address = String(req.body?.address || '').trim();
    const type = req.body?.type;
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Location name must be between 2 and 80 characters.' });
    if (address.length > 200) return res.status(400).json({ error: 'La dirección no puede superar 200 caracteres.' });
    if (!['store', 'warehouse'].includes(type)) return res.status(400).json({ error: 'Select a valid location type.' });
    const registry = readLocations();
    if (registry.locations.some(location => location.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'A location with this name already exists, including locations in trash.' });
    }
    const location = { id: `location-${crypto.randomUUID()}`, name, address, type, status: 'active', createdAt: new Date().toISOString() };
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
    location.name = name;
    location.address = address;
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
      ? activeStores
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
      if (location.type === 'warehouse') {
        if (latestWeeklyFile(location.id, 'kardex')) {
          sourceFileCount += 1;
          for (const purchase of kardexPurchaseRows(location)) {
            const key = [location.id, purchase.date, purchase.code, purchase.quantity].join('|');
            if (!unique.has(key)) unique.set(key, purchase);
          }
        }
        continue;
      }
      for (const stored of storedWeeklyFiles(location.id, 'purchases')) {
        sourceFileCount += 1;
        for (const row of readPurchaseRows(stored.filePath)) {
          const purchase = purchaseRecord(row, location, supplierNames);
          if (!purchase) continue;
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
      row.unitsPerPurchaseUnit = conversion?.unitsPerPurchaseUnit ?? (sameAsBase ? 1 : null);
      row.baseUnitCost = row.unitsPerPurchaseUnit
        ? row.listedUnitPrice / row.unitsPerPurchaseUnit
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

    const previousPrices = new Map();
    const previousUnitCosts = new Map();
    allRows.sort((left, right) => left.date.localeCompare(right.date)
      || left.document.localeCompare(right.document, 'es', { numeric: true })
      || left.line.localeCompare(right.line, 'es', { numeric: true }));
    allRows.forEach(row => {
      const historyKey = [row.locationId, row.supplierKey, row.code || normalizeHeader(row.product), row.unit].join('|');
      row.previousEffectiveUnitPrice = previousPrices.get(historyKey) ?? null;
      row.priceChangePercent = row.previousEffectiveUnitPrice
        ? ((row.effectiveUnitPrice / row.previousEffectiveUnitPrice) - 1) * 100
        : null;
      previousPrices.set(historyKey, row.effectiveUnitPrice);
      row.comparisonUnitCost = row.baseUnitCost ?? row.listedUnitPrice;
      row.comparisonUnit = row.baseUnit || row.purchaseUnit || row.unit || '';
      row.previousComparisonUnitCost = previousUnitCosts.get(historyKey) ?? null;
      row.unitCostChangePercent = row.previousComparisonUnitCost
        ? ((row.comparisonUnitCost / row.previousComparisonUnitCost) - 1) * 100
        : null;
      previousUnitCosts.set(historyKey, row.comparisonUnitCost);
    });

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
      const key = [
        row.supplierKey,
        row.locationId,
        row.code || normalizeHeader(row.product),
        row.purchaseUnit || row.unit,
        row.comparisonUnit
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
        purchaseUnit: first.purchaseUnit || first.unit,
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

  app.get('/api/purchase-cost-variations', (req, res) => {
    try {
      return res.json(buildPurchaseCostVariationsPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo generar el reporte de variaciones de costo.' });
    }
  });

  function projectionPurchaseReferences(locationId) {
    const stores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const supplierMaster = latestMasterFile('master-suppliers', projectionToday());
    const supplierDirectory = supplierNamesByTaxId(supplierMaster?.filePath);
    const suppliers = new Map([...supplierDirectory].map(([key, name]) => [key, { key, name, taxId: key }]));
    const local = new Map();
    const global = new Map();
    const bySupplier = new Map();
    for (const store of stores) {
      for (const stored of storedWeeklyFiles(store.id, 'purchases')) {
        for (const sourceRow of readPurchaseRows(stored.filePath)) {
          const row = purchaseRecord(sourceRow, store, supplierDirectory);
          if (!row || !row.code || dateIsExcluded(row.date, stored.excludedRanges)) continue;
          suppliers.set(row.supplierKey, { key: row.supplierKey, name: row.supplier, taxId: row.supplierTaxId });
          const key = row.code.toUpperCase();
          if (!global.has(key) || global.get(key).date < row.date) global.set(key, row);
          if (store.id === locationId && (!local.has(key) || local.get(key).date < row.date)) local.set(key, row);
          const supplierItemKey = `${key}|${row.supplierKey}`;
          if (!bySupplier.has(supplierItemKey) || bySupplier.get(supplierItemKey).date < row.date) {
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

  function buildPurchaseProjection(locationId, selectedBranchLocationIds = null, selectedPurchaseOrderIds = null) {
    const location = activeLocation(locationId);
    if (!location) {
      const error = new Error('Selecciona una cafetería o bodega válida.');
      error.status = 400;
      throw error;
    }
    const parsed = mergedKardexData(location.id, 'kardex');
    if (!parsed?.groups.length) {
      const error = new Error('La ubicación no tiene un Kardex disponible para proyectar compras.');
      error.status = 404;
      throw error;
    }
    const today = projectionToday();
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
    const references = projectionPurchaseReferences(location.id);
    const branchOrders = location.type === 'warehouse'
      ? branchPurchaseOrderConsolidation(selectedBranchLocationIds)
      : null;
    const purchaseOrders = projectionPurchaseOrderSelection(location.id, selectedPurchaseOrderIds);
    const catalogMaster = latestMasterFile('master-catalog', today);
    const conversions = catalogMaster ? parsePurchaseUnitConversions(catalogMaster.filePath) : new Map();
    const supplierOptions = new Map(references.suppliers);
    supplierOptions.set('unassigned', { key: 'unassigned', name: 'Proveedor no asignado', taxId: '' });
    const items = parsed.products.filter(product => product.code || product.name).map(product => {
      const key = (product.code || normalizeHeader(product.name)).toUpperCase();
      const policy = policies[key] || {};
      const minDays = Number.isFinite(Number(policy.minDays)) ? Number(policy.minDays) : 7;
      const maxDays = Number.isFinite(Number(policy.maxDays)) ? Number(policy.maxDays) : 14;
      const managed = policy.managed === true;
      const metricMatcher = metric => metric.startsWith('uso -') || metric.startsWith('trl-out -')
        || metric.startsWith('mov-out -') || metric.startsWith('trn-out -');
      const consumption30 = consumptionGroups.reduce((sum, group) =>
        sum + kardexMetricTotal(product, group, metricMatcher), 0);
      const averageDailyConsumption = consumption30 / 30;
      const hasFinal = latestGroup.metrics.some(metric => metric.normalized.startsWith('if -'));
      const currentInventory = kardexMetricValue(product, latestGroup,
        metric => metric.startsWith(hasFinal ? 'if -' : 'ii -'));
      const supplierSpecificPurchase = policy.supplierKey
        ? references.bySupplier.get(`${key}|${policy.supplierKey}`)
        : null;
      const latestPurchase = supplierSpecificPurchase || references.local.get(key) || references.global.get(key) || null;
      const catalogItem = conversions.get(key);
      let conversion = latestPurchase ? catalogItem?.conversions.get(normalizedUnit(latestPurchase.unit)) : null;
      if (!conversion && catalogItem) {
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
      const needsPurchase = ownNeedsPurchase || branchOrderInternalQuantity > 0;
      const suggestedInternalQuantity = ownSuggestedInternalQuantity + branchOrderInternalQuantity;
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
      const suggestedPurchaseUnits = suggestedInternalQuantity > 0 && unitsPerPurchaseUnit > 0
        ? Math.ceil(suggestedInternalQuantity / unitsPerPurchaseUnit)
        : null;
      const projectedInternalQuantity = suggestedPurchaseUnits === null
        ? suggestedInternalQuantity
        : suggestedPurchaseUnits * unitsPerPurchaseUnit;
      const estimatedPurchaseUnitCost = latestPurchase
        ? latestPurchase.effectiveUnitPrice || latestPurchase.listedUnitPrice || 0
        : null;
      return {
        key,
        code: product.code,
        name: product.name,
        internalUnit: product.unit,
        currentInventory,
        currentInventoryBasis: hasFinal ? 'Inventario Final' : 'Inventario Inicial',
        consumption30,
        averageDailyConsumption,
        currentCoverageDays: averageDailyConsumption > 0 ? currentInventory / averageDailyConsumption : null,
        minDays,
        maxDays,
        managed,
        minimumStock,
        maximumStock,
        ownNeedsPurchase,
        ownSuggestedInternalQuantity,
        branchOrderInternalQuantity,
        branchOrderConversionMissing,
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
      period: { from: periodFrom, to: today, dataThrough: latestGroup.date, days: 30 },
      consumptionCriteria: location.type === 'warehouse'
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
      const managed = item.managed === true;
      const supplierKey = String(item.supplierKey || 'unassigned').trim();
      if (!key || !Number.isFinite(minDays) || !Number.isFinite(maxDays)
        || minDays < 0 || maxDays < minDays || maxDays > 365) {
        return res.status(400).json({ error: 'Cada ítem debe tener días mínimos y máximos válidos; el máximo no puede ser menor que el mínimo.' });
      }
      registry.locations[location.id].items[key] = { minDays, maxDays, supplierKey, managed, updatedAt: new Date().toISOString() };
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
      total: order.total
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
    const allowed = existingItems
      ? new Map(existingItems.map(item => [item.key, item]))
      : new Map(availableItems.map(item => [item.key, item]));
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
      return {
        key,
        code: source.code || '',
        name: source.name,
        internalUnit: source.internalUnit || '',
        purchaseUnit: source.purchaseUnit || '',
        unitsPerPurchaseUnit: Number.isFinite(unitsPerPurchaseUnit) ? unitsPerPurchaseUnit : null,
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
      const items = normalizedPurchaseOrderItems(req.body?.items, [], existing.items);
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
      const configuredToday = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
      const now = configuredToday ? new Date(`${configuredToday}T12:00:00.000Z`) : new Date();
      const todayKey = configuredToday || toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
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
      const products = parseProductCatalog(catalogMaster.filePath);
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
    const recipesMaster = latestMasterFile('master-recipes', dateTo);
    if (!catalogMaster || !recipesMaster) {
      const error = new Error('Se requiere un maestro de ingredientes y un maestro de recetas vigentes para el período.');
      error.status = 404;
      throw error;
    }
    const ingredientCatalog = parseIngredientsCatalog(catalogMaster.filePath);
    const fullCatalog = parseIngredientCatalog(catalogMaster.filePath);
    const products = new Map(parseProductCatalog(catalogMaster.filePath).map(product => [product.code, product]));
    const recipes = parseRecipes(recipesMaster.filePath);
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
        fullCatalog
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
        const unitCost = unitCostForRecipeUnit(catalogItem, canonical.unit) || 0;
        usageByIngredient.set(key, { quantity, unit: canonical.unit, totalCost: quantity * unitCost });
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
        const sourceUnit = row.baseUnit || row.unit;
        return unitCostForRecipeUnit({ unitCost: rawCost, unit: sourceUnit }, ingredient.unit);
      };
      const firstCost = periodHistory.length ? purchaseCost(periodHistory[0]) : null;
      const lastCost = periodHistory.length ? purchaseCost(periodHistory.at(-1)) : null;
      const usage = usageByIngredient.get(key) || { quantity: 0, unit: canonicalConsumptionUnit(ingredient.unit).unit, totalCost: 0 };
      const catalogCostForUsage = unitCostForRecipeUnit(ingredient, usage.unit) || 0;
      const usageCost = usage.quantity * catalogCostForUsage;
      return {
        ...ingredient,
        supplierKey: latest?.supplierKey || 'unassigned',
        supplier: latest?.supplier || 'Proveedor no identificado',
        latestPurchaseDate: latest?.date || null,
        latestPurchaseCost: latest ? purchaseCost(latest) : null,
        firstPeriodCost: firstCost,
        lastPeriodCost: lastCost,
        costChangePercent: firstCost && lastCost ? ((lastCost / firstCost) - 1) * 100 : null,
        purchaseCount: periodHistory.length,
        usageQuantity: usage.quantity,
        usageUnit: usage.unit,
        usageCost,
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
    const recipesMaster = latestMasterFile('master-recipes', dateTo);
    if (!catalogMaster || !recipesMaster) {
      const error = new Error('Se requiere el maestro de productos e ingredientes y el maestro de recetas vigentes para el período.');
      error.status = 404;
      throw error;
    }
    const ingredientHierarchyMaster = latestMasterFile('ingredient-hierarchy', dateTo);
    const extrasHierarchyMaster = latestMasterFile('extras-hierarchy', dateTo);
    const catalog = parseSalesAnalysisCatalog(catalogMaster.filePath);
    const recipes = parseRecipes(recipesMaster.filePath);
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
            const grossLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar', 'Precio Lista'])) || 0;
            const discount = numericValue(rowValue(row, ['Descuento'])) || 0;
            const totalCost = numericValue(rowValue(row, ['Costo'])) || 0;
            if (code || name) facts.push({
              locationId: location.id,
              code,
              name,
              quantity,
              netSales: (grossLine + discount) / 1.19,
              totalCost
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
      const current = productsSold.get(key) || { code: fact.code, name: fact.name, quantity: 0, netSales: 0, totalCost: 0 };
      current.quantity += fact.quantity;
      current.netSales += fact.netSales;
      current.totalCost += fact.totalCost;
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
          contributionMarginPercent: netSales ? (netSales - totalCost) / netSales * 100 : null
        },
        shareOfPeriodSales: facts.reduce((sum, fact) => sum + fact.netSales, 0) ? netSales / facts.reduce((sum, fact) => sum + fact.netSales, 0) * 100 : 0
      };
    });
    const uniqueProducts = [...matchedProductKeys].map(key => productsSold.get(key)).filter(Boolean);
    const periodNetSales = facts.reduce((sum, fact) => sum + fact.netSales, 0);
    const uniqueNetSales = uniqueProducts.reduce((sum, item) => sum + item.netSales, 0);
    const uniqueTotalCost = uniqueProducts.reduce((sum, item) => sum + item.totalCost, 0);
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
        contributionMarginPercent: uniqueNetSales ? (uniqueNetSales - uniqueTotalCost) / uniqueNetSales * 100 : null,
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

  app.get('/api/inventory/sources', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location) return res.status(400).json({ error: 'Select a valid active location.' });
    const definitions = [
      { field: 'kardex', label: 'Kardex / tarjeta de inventario', applicable: true },
      { field: 'waste', label: 'Merma', applicable: location.type === 'store' },
      { field: 'marketing', label: 'Consumo de marketing', applicable: location.type === 'store' },
      { field: 'employees', label: 'Consumo de colaboradores', applicable: location.type === 'store' }
    ];
    try {
      const sources = definitions.map(definition => {
        const latest = latestWeeklyFile(location.id, definition.field);
        if (!latest) return { ...definition, available: false, file: null };
        const { filePath, ...publicFile } = latest;
        const stored = chronologicalSources(location.id, definition.field);
        const dataRange = combinedDateRange(stored.map(item => ({ detectedRange: item.record.confirmedRange || item.record.detectedRange })));
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

  app.get('/api/inventory/waste-summary', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location || location.type !== 'store') {
      return res.status(400).json({ error: 'Selecciona una cafetería activa.' });
    }
    const waste = latestWeeklyFile(location.id, 'waste');
    if (!waste) return res.status(404).json({ error: 'No hay un archivo de Merma disponible para esta cafetería.' });
    try {
      const catalogMaster = latestMasterFile('master-catalog', req.query.dateTo);
      const report = buildWasteSummary(
        mergedKardexData(location.id, 'waste'),
        req.query.dateFrom,
        req.query.dateTo,
        catalogMaster ? parseIngredientCatalog(catalogMaster.filePath) : null
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
      const recipeMaster = latestMasterFile('master-recipes', req.query.dateTo);
      const catalogMaster = latestMasterFile('master-catalog', req.query.dateTo);
      if (!recipeMaster) throw new Error('No hay un maestro de recetas vigente para la fecha final seleccionada.');
      if (!catalogMaster) throw new Error('No hay un maestro de productos / ingredientes / extras vigente para la fecha final seleccionada.');
      const catalog = parseIngredientCatalog(catalogMaster.filePath);
      const products = applyCatalogProductCosts(
        mergedConsumptionProducts(location.id, field, req.query.dateFrom, req.query.dateTo),
        catalog
      );
      const ingredients = buildIngredientConsumption(products.products, parseRecipes(recipeMaster.filePath), catalog);
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

  app.post('/api/inventory/process', (req, res) => {
    const location = activeLocation(req.body?.location);
    if (!location) return res.status(400).json({ error: 'Select a valid active location.' });
    const kardex = latestWeeklyFile(location.id, 'kardex');
    if (!kardex) return res.status(404).json({ error: 'No Kardex file is available for this location.' });
    try {
      const movementDateFrom = req.body?.movementDateFrom || req.body?.dateFrom;
      const movementDateTo = req.body?.movementDateTo || req.body?.dateTo;
      const recipeMaster = latestMasterFile('master-recipes', movementDateTo);
      const catalogMaster = latestMasterFile('master-catalog', movementDateTo);
      let recipes = null;
      let ingredientCatalog = null;
      const masterErrors = [];
      try {
        if (!recipeMaster) throw new Error('No recipe master is valid for the selected final date.');
        recipes = parseRecipes(recipeMaster.filePath);
      } catch (error) {
        masterErrors.push(error.message);
      }
      try {
        if (!catalogMaster) throw new Error('No product / ingredient / extras master is valid for the selected final date.');
        ingredientCatalog = parseIngredientCatalog(catalogMaster.filePath);
      } catch (error) {
        masterErrors.push(error.message);
      }
      const masterError = masterErrors.join(' ');
      const consumption = {};
      for (const [field, label] of [['marketing', 'Consumo de marketing'], ['employees', 'Consumo de colaboradores']]) {
        const stored = latestWeeklyFile(location.id, field);
        if (!stored) {
          consumption[field] = { label, available: false, error: 'No hay un archivo disponible.' };
          continue;
        }
        try {
          const parsedProducts = mergedConsumptionProducts(location.id, field, movementDateFrom, movementDateTo);
          const products = ingredientCatalog ? applyCatalogProductCosts(parsedProducts, ingredientCatalog) : parsedProducts;
          const ingredients = recipes && ingredientCatalog
            ? buildIngredientConsumption(products.products, recipes, ingredientCatalog)
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
      if (storedWaste) {
        try {
          const { filePath, ...publicSource } = storedWaste;
          waste = {
            label: 'Merma',
            available: true,
            source: publicSource,
            report: buildWasteSummary(mergedKardexData(location.id, 'waste'), movementDateFrom, movementDateTo, ingredientCatalog)
          };
        } catch (error) {
          waste = { label: 'Merma', available: true, error: error.message };
        }
      }
      const parsed = mergedKardexData(location.id, 'kardex');
      const hasCustomSelection = req.body?.initialInventoryDate || req.body?.finalInventoryDate;
      const selection = hasCustomSelection ? {
        initialDate: req.body?.initialInventoryDate,
        initialBasis: req.body?.initialInventoryBasis,
        finalDate: req.body?.finalInventoryDate,
        finalBasis: req.body?.finalInventoryBasis
      } : null;
      const report = enrichKardexReport(
        buildKardexInventoryReport(parsed, movementDateFrom, movementDateTo, selection),
        consumption,
        ingredientCatalog
      );
      const lac001Substitutions = lac001SubstitutionSummary(
        location.id,
        movementDateFrom,
        movementDateTo,
        recipes,
        ingredientCatalog
      );
      const { filePath, ...source } = kardex;
      const publicMaster = record => record ? (({ filePath, ...value }) => value)(record) : null;
      return res.json({
        location: publicLocation(location),
        source,
        waste,
        consumption,
        lac001Substitutions,
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

  function buildSalesDashboard(requestedLocation = 'all') {
    const configuredToday = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
    const now = configuredToday ? new Date(`${configuredToday}T12:00:00.000Z`) : new Date();
    const todayKey = configuredToday || toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
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
        label: 'Semana', current: { from: weekStart, to: todayKey },
        previous: { from: addDays(weekStart, -7), to: addDays(todayKey, -7), label: 'Mismo tramo semana anterior' }
      },
      month: {
        label: 'Mes', current: { from: monthStart, to: todayKey },
        previous: { ...previousMonthPeriod(todayKey), label: 'Mismo tramo mes anterior' }
      }
    };
    const hierarchyMaster = latestMasterFile('product-hierarchy', todayKey);
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
                orderMap.set(orderKey, { locationId: location.id, date, net: (gross + discounts) / 1.19 });
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
            const grossLine = numericValue(rowValue(row, ['Precio a Pagar', 'Precio a pagar', 'Precio Lista'])) || 0;
            const lineDiscount = numericValue(rowValue(row, ['Descuento'])) || 0;
            const lineCost = numericValue(rowValue(row, ['Costo'])) || 0;
            const hierarchyId = String(rowValue(row, ['AB.']) ?? '').trim();
            const hierarchyNode = hierarchyLookup?.hierarchyMap.get(hierarchyId);
            const hierarchyPath = hierarchyNode ? hierarchyLookup.pathFor(hierarchyNode.id) : [];
            const fallbackHierarchy = repairMojibake(rowValue(row, ['Categorías de Productos/Platos', 'Categorias de Productos/Platos']))
              || 'Sin jerarquía';
            const resolvedHierarchyPath = hierarchyPath.length ? hierarchyPath : [fallbackHierarchy];
            const hierarchy = resolvedHierarchyPath.join(' / ');
            if (code || name) productFacts.push({
              locationId: location.id, date, code, name: name || code, quantity,
              net: (grossLine + lineDiscount) / 1.19, cost: lineCost, hierarchy, hierarchyPath: resolvedHierarchyPath
            });
          }
          salesFilesRead += 1;
        } catch {
          warnings.push(`No se pudo leer ${stored.record.originalName || stored.record.name} (${location.name}).`);
        }
      }
    }
    const orderFacts = [...orderMap.values()];
    const salesMetrics = Object.fromEntries(Object.entries(periods).map(([key, period]) => [
      key, periodSalesMetric(orderFacts, { ...period.current, label: period.label }, period.previous)
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
    const productInsights = {};
    for (const key of ['day', 'week', 'month']) {
      const period = periods[key].current;
      const selected = productFacts.filter(fact => fact.date >= period.from && fact.date <= period.to);
      const products = new Map();
      const hierarchies = new Map();
      selected.forEach(fact => {
        const productKey = fact.code || normalizeHeader(fact.name);
        const product = products.get(productKey) || { code: fact.code, name: fact.name, quantity: 0, netSales: 0 };
        product.quantity += fact.quantity;
        product.netSales += fact.net;
        products.set(productKey, product);
        hierarchies.set(fact.hierarchy, (hierarchies.get(fact.hierarchy) || 0) + fact.net);
      });
      const totalHierarchySales = [...hierarchies.values()].reduce((sum, value) => sum + value, 0);
      const hierarchyRoot = { name: 'Todas las jerarquías', path: [], netSales: 0, totalCost: 0, children: new Map(), products: new Map() };
      const addProductToNode = (node, fact) => {
        const productKey = fact.code || normalizeHeader(fact.name);
        const product = node.products.get(productKey) || { code: fact.code, name: fact.name, quantity: 0, netSales: 0, totalCost: 0 };
        product.quantity += fact.quantity;
        product.netSales += fact.net;
        product.totalCost += fact.cost;
        node.products.set(productKey, product);
      };
      selected.forEach(fact => {
        hierarchyRoot.netSales += fact.net;
        hierarchyRoot.totalCost += fact.cost;
        addProductToNode(hierarchyRoot, fact);
        let node = hierarchyRoot;
        fact.hierarchyPath.forEach((name, index) => {
          if (!node.children.has(name)) {
            node.children.set(name, { name, path: fact.hierarchyPath.slice(0, index + 1), netSales: 0, totalCost: 0, children: new Map(), products: new Map() });
          }
          node = node.children.get(name);
          node.netSales += fact.net;
          node.totalCost += fact.cost;
          addProductToNode(node, fact);
        });
      });
      const serializeHierarchyNode = node => ({
        name: node.name,
        path: node.path,
        netSales: node.netSales,
        totalCost: node.totalCost,
        contributionMarginPercent: node.netSales
          ? (node.netSales - node.totalCost) / node.netSales * 100
          : null,
        children: [...node.children.values()]
          .sort((left, right) => right.netSales - left.netSales)
          .map(serializeHierarchyNode),
        products: [...node.products.values()]
          .map(product => ({
            ...product,
            contributionMarginPercent: product.netSales
              ? (product.netSales - product.totalCost) / product.netSales * 100
              : null
          }))
          .sort((left, right) => right.netSales - left.netSales || right.quantity - left.quantity)
      });
      productInsights[key] = {
        period,
        topProducts: [...products.values()].sort((left, right) => right.quantity - left.quantity || right.netSales - left.netSales).slice(0, 10),
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
      sales: { metrics: salesMetrics, locations, productInsights, filesRead: salesFilesRead },
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
      return res.json(buildSalesDashboard(String(req.query.location || 'all')));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir el panel de ventas.' });
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
      for (const location of stores) {
        for (const stored of storedSalesFiles(location.id)) {
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
              if (!dailySales[date]) dailySales[date] = { gross: 0, discounts: 0, net: 0 };
              dailySales[date].gross += gross;
              dailySales[date].discounts += discounts;
              dailySales[date].net += net;
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

      const configuredToday = typeof options.reportToday === 'function' ? options.reportToday() : options.reportToday;
      const now = configuredToday ? new Date(`${configuredToday}T12:00:00.000Z`) : new Date();
      const todayKey = configuredToday || toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
      const includeToday = String(req.query.includeToday || '').toLowerCase() === 'true';
      return res.json({
        ...buildSalesReport(dailySales, todayKey, includeToday),
        intraday: buildIntradayReport(dailySales, transactionsByDate, todayKey),
        scope: selectedStore
          ? { type: 'location', location: selectedStore.id, label: selectedStore.name }
          : { type: 'all', location: null, label: 'Todas las cafeterías' },
        filesRead,
        warnings
      });
    } catch (error) {
      return res.status(500).json({ error: 'Could not calculate the weekly sales report.' });
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
    const { token, dateFrom, dateTo, confirmed, categoryConfirmed, overlapAction = 'keep' } = req.body || {};
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
    const destination = transactionLocationRoot(manifest.location);
    ensureDir(destination);
    const index = readTransactionIndex(manifest.location);
    const movedFiles = [];
    const imports = {};
    try {
      for (const staged of manifest.files) {
        const incomingRange = intersectDateRanges(staged.detectedRange, { from: dateFrom, to: dateTo }) || { from: dateFrom, to: dateTo };
        const overlaps = storedFieldFiles(manifest.location, staged.field).flatMap(stored => {
          const existingRange = stored.record.confirmedRange || stored.record.detectedRange;
          const overlap = intersectDateRanges(incomingRange, existingRange);
          return overlap ? [{ stored, overlap }] : [];
        });
        const replacementEffects = overlapAction === 'replace'
          ? overlaps.map(({ stored, overlap }) => ({ sourceId: stored.sourceId, range: overlap }))
          : [];
        let stagedFile = staged;
        if (staged.field === 'sales') {
          const prepared = prepareIncrementalSales(
            staged,
            manifest.location,
            stagingDirectory,
            overlapAction === 'replace' ? [incomingRange] : []
          );
          imports.sales = prepared.stats;
          stagedFile = prepared.staged;
          if (!stagedFile) continue;
        } else if (staged.field === 'mercadopago') {
          const prepared = prepareIncrementalMercadoPago(
            staged,
            manifest.location,
            stagingDirectory,
            overlapAction === 'replace' ? [incomingRange] : []
          );
          imports.mercadopago = prepared.stats;
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
    const stored = storedTransactionFiles(location.id, req.params.field).find(item => item.sourceId === req.query.source);
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
      res.json(readJson(path.join(mastersRoot, 'masters.json'), {}));
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

      return res.json(buildSpreadsheetPreview(filePath, record.originalName || record.name));
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
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  createApp().listen(port, () => console.log(`Brewit running at http://localhost:${port}`));
}

module.exports = { createApp, isValidWeekKey, detectFileDateRange, detectUploadStructure, validateUploadStructure, DEFAULT_LOCATIONS };
