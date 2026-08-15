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
const WEEK_FIELDS = ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales'].map(name => ({ name, maxCount: 1 }));
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
  return type === 'warehouse' ? ['kardex'] : ['kardex', 'waste', 'marketing', 'employees', 'purchases', 'sales'];
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
  for (const match of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const parsed = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (parsed) dates.push(parsed);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/g)) {
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
    const adjustedDifference = (Number(item.difference) || 0) + employeeConsumption + marketingConsumption;
    const catalogUnitCost = unitCostForRecipeUnit(catalog?.get(item.code), item.unit);
    if (catalogUnitCost === null) itemsWithoutCost.add(item.code || item.name);
    const unitCost = catalogUnitCost ?? 0;
    return {
      ...item,
      employeeConsumption,
      marketingConsumption,
      adjustedDifference,
      unitCost,
      costAvailable: catalogUnitCost !== null,
      totalCost: adjustedDifference * unitCost
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

function buildSalesReport(dailySales, todayKey) {
  const previousDate = addDays(todayKey, -1);
  const previousDayNumber = new Date(`${previousDate}T00:00:00.000Z`).getUTCDay();
  const weekStart = addDays(previousDate, -((previousDayNumber + 6) % 7));
  const monthStart = `${previousDate.slice(0, 7)}-01`;
  const historicalDates = Object.keys(dailySales).filter(date => date <= previousDate).sort();
  const hasPreviousDay = Object.hasOwn(dailySales, previousDate);
  const previous = dailySales[previousDate] || { gross: 0, discounts: 0, net: 0 };
  const sameWeekdayDates = historicalDates.filter(date => new Date(`${date}T00:00:00.000Z`).getUTCDay() === previousDayNumber);
  const priorEight = sameWeekdayDates.filter(date => date < previousDate).sort().reverse().slice(0, 8);
  const sameWeekdayAverage = priorEight.length
    ? priorEight.reduce((sum, date) => sum + dailySales[date].net, 0) / priorEight.length
    : 0;
  const rank = dates => ({
    position: hasPreviousDay && dates.length ? 1 + dates.filter(date => dailySales[date].net > previous.net).length : null,
    total: dates.length
  });
  const sumRange = (from, to) => historicalDates
    .filter(date => date >= from && date <= to)
    .reduce((sum, date) => sum + dailySales[date].net, 0);

  return {
    basis: 'gross-plus-signed-discounts-divided-by-1.19',
    currency: 'CLP',
    previousDay: {
      date: previousDate,
      grossSales: previous.gross,
      discounts: previous.discounts,
      netSales: previous.net,
      generalRank: rank(historicalDates),
      sameWeekdayRank: rank(sameWeekdayDates),
      sameWeekdayAverage,
      comparisonToAveragePercent: hasPreviousDay && sameWeekdayAverage
        ? ((previous.net / sameWeekdayAverage) - 1) * 100
        : null,
      averageSampleSize: priorEight.length
    },
    week: { from: weekStart, to: previousDate, netSales: sumRange(weekStart, previousDate) },
    month: { from: monthStart, to: previousDate, netSales: sumRange(monthStart, previousDate) },
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
  const trashLocationsRoot = path.join(uploadsRoot, 'trash', 'locations');
  const locationsPath = path.join(configRoot, 'locations.json');
  ensureDir(weeksRoot);
  ensureDir(mastersRoot);
  ensureDir(stagingRoot);
  ensureDir(configRoot);
  ensureDir(transactionsRoot);
  ensureDir(productReportsRoot);
  ensureDir(trashLocationsRoot);
  migrateLegacySundayWeeks(weeksRoot);
  if (!fs.existsSync(locationsPath)) {
    const createdAt = new Date().toISOString();
    writeJsonAtomic(locationsPath, {
      locations: DEFAULT_LOCATIONS.map(location => ({ ...location, status: 'active', createdAt }))
    });
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

  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/uploads/weeks', express.static(weeksRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/transactions', express.static(transactionsRoot, { fallthrough: false, dotfiles: 'deny' }));
  app.use('/uploads/masters', express.static(mastersRoot, { fallthrough: false, dotfiles: 'deny' }));

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
  app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
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

  app.post('/api/config/locations', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const type = req.body?.type;
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Location name must be between 2 and 80 characters.' });
    if (!['store', 'warehouse'].includes(type)) return res.status(400).json({ error: 'Select a valid location type.' });
    const registry = readLocations();
    if (registry.locations.some(location => location.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'A location with this name already exists, including locations in trash.' });
    }
    const location = { id: `location-${crypto.randomUUID()}`, name, type, status: 'active', createdAt: new Date().toISOString() };
    registry.locations.push(location);
    writeJsonAtomic(locationsPath, registry);
    return res.status(201).json(publicLocation(location));
  });

  app.patch('/api/config/locations/:id', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Location name must be between 2 and 80 characters.' });
    const registry = readLocations();
    const location = registry.locations.find(item => item.id === req.params.id && item.status === 'active');
    if (!location) return res.status(404).json({ error: 'Active location not found.' });
    if (registry.locations.some(item => item.id !== location.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'A location with this name already exists, including locations in trash.' });
    }
    location.name = name;
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

  function buildPurchasesPayload(query = {}) {
    const activeStores = readLocations().locations.filter(location => location.status === 'active' && location.type === 'store');
    const requestedLocation = query.location || 'all';
    const selectedLocations = requestedLocation === 'all'
      ? activeStores
      : activeStores.filter(location => location.id === requestedLocation);
    if (requestedLocation !== 'all' && !selectedLocations.length) {
      const error = new Error('Selecciona una cafetería válida.');
      error.status = 400;
      throw error;
    }
    const supplierMaster = latestMasterFile('master-suppliers', '2100-01-01');
    const supplierNames = supplierNamesByTaxId(supplierMaster?.filePath);
    const unique = new Map();
    let sourceFileCount = 0;
    for (const location of selectedLocations) {
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

    const previousPrices = new Map();
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
    });

    const rows = allRows.filter(row => (!dateFrom || row.date >= dateFrom)
      && (!dateTo || row.date <= dateTo)
      && (requestedSupplier === 'all' || row.supplierKey === requestedSupplier));
    rows.sort((left, right) => left.supplier.localeCompare(right.supplier, 'es')
      || right.date.localeCompare(left.date)
      || left.product.localeCompare(right.product, 'es')
      || left.document.localeCompare(right.document, 'es', { numeric: true }));
    return {
      scope: requestedLocation === 'all'
        ? { location: 'all', label: 'Todas las cafeterías' }
        : { location: requestedLocation, label: selectedLocations[0].name },
      locations: activeStores.map(publicLocation),
      suppliers,
      filters: { location: requestedLocation, supplier: requestedSupplier, dateFrom, dateTo },
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

  app.get('/api/purchases', (req, res) => {
    try {
      return res.json(buildPurchasesPayload(req.query));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudieron procesar las compras.' });
    }
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

  app.get('/api/products', (req, res) => {
    try {
      return res.json(buildProductsPayload(String(req.query.location || 'all')));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || 'No se pudo construir la vista de productos.' });
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
      const { filePath, ...source } = kardex;
      const publicMaster = record => record ? (({ filePath, ...value }) => value)(record) : null;
      return res.json({
        location: publicLocation(location),
        source,
        waste,
        consumption,
        masterSources: { recipes: publicMaster(recipeMaster), catalog: publicMaster(catalogMaster), error: masterError },
        report
      });
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Could not process the Kardex.' });
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
      return res.json({
        ...buildSalesReport(dailySales, todayKey),
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

  app.get('/api/transactions', (req, res) => {
    const location = activeLocation(req.query.location);
    if (!location) return res.status(400).json({ error: 'Selecciona una ubicación válida.' });
    try {
      const files = {};
      for (const field of fieldsForLocation(location.type)) {
        const stored = storedFieldFiles(location.id, field);
        const sorted = [...stored].sort((left, right) =>
          String(right.record.detectedRange?.to || '').localeCompare(String(left.record.detectedRange?.to || ''))
          || String(right.record.savedAt || '').localeCompare(String(left.record.savedAt || '')));
        const ranges = sorted.map(item => item.record.confirmedRange || item.record.detectedRange).filter(Boolean);
        files[field] = {
          field,
          fileCount: sorted.length,
          dataRange: combinedDateRange(ranges.map(detectedRange => ({ detectedRange }))),
          latest: sorted[0] ? publicStoredFile(sorted[0], location.id, field) : null
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
      try {
        const inspectedFiles = files.map(file => {
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
            existingSources
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
    const { token, dateFrom, dateTo, confirmed, overlapAction = 'keep' } = req.body || {};
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

module.exports = { createApp, isValidWeekKey, detectFileDateRange, DEFAULT_LOCATIONS };
