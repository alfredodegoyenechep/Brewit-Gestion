const XLSX = require('xlsx');

const DEFAULT_STORE_IDS = { 'store-1': '82010740', 'store-2': '81555097' };

function storeId(value) {
  return String(value ?? '').trim().replace(/^'+/, '');
}

function validateStoreId(value, location, locations) {
  const id = storeId(value);
  if (id && !/^\d{1,40}$/.test(id)) throw new Error('El STORE_ID de MercadoPago debe contener solo números.');
  if (id && location.type !== 'store') throw new Error('El STORE_ID de MercadoPago corresponde a una cafetería.');
  if (id && locations.some(other => other.id !== location.id && storeId(other.mercadoPagoStoreId) === id)) {
    throw new Error('Este STORE_ID de MercadoPago ya está asignado a otra ubicación.');
  }
  return id;
}

function splitByStore(sheets, locations) {
  const stores = new Map();
  for (const location of locations.filter(item => item.status === 'active' && item.type === 'store')) {
    const id = storeId(location.mercadoPagoStoreId);
    if (!id) continue;
    if (stores.has(id)) throw new Error(`El STORE_ID ${id} está asignado a más de una cafetería. Corrige la configuración antes de cargar.`);
    stores.set(id, location);
  }
  const groups = new Map(), unassociated = new Map();
  let totalRows = 0;
  for (const sheet of sheets) {
    if (sheet.rows.length < 2) continue;
    const header = sheet.rows[0];
    const column = header.findIndex(value => String(value ?? '').trim().toUpperCase().replace(/[\s_]+/g, '_') === 'STORE_ID');
    if (column < 0) throw new Error(`La hoja “${sheet.name}” no contiene la columna STORE_ID. Exporta el archivo de MercadoPago con ese identificador.`);
    for (const row of sheet.rows.slice(1)) {
      if (!row.some(value => value !== null && value !== undefined && value !== '')) continue;
      totalRows++;
      const id = storeId(row[column]);
      const location = stores.get(id);
      if (!location) { unassociated.set(id, (unassociated.get(id) || 0) + 1); continue; }
      if (!groups.has(location.id)) groups.set(location.id, { location, rowCount: 0, sheets: new Map() });
      const group = groups.get(location.id);
      if (!group.sheets.has(sheet.name)) group.sheets.set(sheet.name, [header]);
      const storedRow = [...row];
      storedRow[column] = id;
      group.sheets.get(sheet.name).push(storedRow);
      group.rowCount++;
    }
  }
  if (!totalRows) throw new Error('El archivo no contiene registros de MercadoPago.');
  const unassociatedRows = [...unassociated].map(([storeId, rowCount]) => ({ storeId, rowCount }));
  const unassociatedCount = unassociatedRows.reduce((sum, item) => sum + item.rowCount, 0);
  return {
    groups: [...groups.values()].map(group => ({ ...group, sheets: [...group.sheets].map(([name, rows]) => ({ name, rows })) })),
    summary: {
      totalRows, associatedCount: totalRows - unassociatedCount, unassociatedCount,
      stores: locations.filter(location => location.status === 'active' && location.type === 'store').map(location => ({
        location: location.id, name: location.name, storeId: storeId(location.mercadoPagoStoreId), rowCount: groups.get(location.id)?.rowCount || 0
      })),
      unassociated: unassociatedRows
    }
  };
}

function writeStoreWorkbook(filename, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31));
  XLSX.writeFile(workbook, filename);
}

module.exports = { DEFAULT_STORE_IDS, storeId, validateStoreId, splitByStore, writeStoreWorkbook };
