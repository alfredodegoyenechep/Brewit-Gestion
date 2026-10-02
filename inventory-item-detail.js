const labels = {
  purchase: 'Compra', use: 'Consumo de ventas', count: 'Toma física',
  transfer_local_in: 'Transferencia entre locales · entrada', transfer_local_out: 'Transferencia entre locales · salida',
  transfer_warehouse_in: 'Transferencia entre bodegas · entrada', transfer_warehouse_out: 'Transferencia entre bodegas · salida',
  transformed_in: 'Transformación · entrada', transformed_out: 'Transformación · salida'
};
function buildItemDetail(state, location, report, item, { consumption = {}, convertQuantity = (quantity,from,to) => from === to ? quantity : null } = {}) {
  const warehouse = state?.warehouses?.find(w => Number(w.custom_id) === (location.type === 'warehouse' ? 1 : 2));
  const warehouses = new Map((state?.warehouses || []).map(w => [w.id, w.name || String(w.custom_id)]));
  const documents = new Map((state?.documents || []).map(d => [d.key, d]));
  const sameItem = line => line.code === item.code && String(line.unit).toUpperCase() === String(item.unit).toUpperCase();
  const from = report.dateFrom, to = report.dateTo, final = report.selection?.finalDate || to;
  const operations = state?.operationLines || [];
  // Active operations also occur in movements. Deduplicate by line identity,
  // never by date/quantity: identical lines can be legitimate distinct records.
  const lines = new Map();
  for (const line of [...operations, ...(state?.movements || [])]) {
    if (!warehouse || line.warehouse !== warehouse.id || !sameItem(line)) continue;
    const count = line.column === 'count';
    if (count ? !(line.date >= from && line.date <= final || line.date === item.anchorDate) : !(line.date >= from && line.date <= to)) continue;
    lines.set(line.id, line);
  }
  const movements = [...lines.values()].map(line => {
    const doc = documents.get(line.document) || {};
    const outgoing = /_out$/.test(line.column), incoming = /_in$/.test(line.column);
    const counterpart = line.column.startsWith('transfer_warehouse') && (!doc.origin || !doc.destination) ? operations.find(other => other.document === line.document && sameItem(other) && other.warehouse !== line.warehouse
      && other.column === (outgoing ? 'transfer_warehouse_in' : 'transfer_warehouse_out')) : null;
    const origin = doc.origin || (line.column.startsWith('transfer_warehouse') ? warehouses.get(outgoing ? line.warehouse : counterpart?.warehouse) : null);
    const destination = doc.destination || (line.column.startsWith('transfer_warehouse') ? warehouses.get(incoming ? line.warehouse : counterpart?.warehouse) : null);
    const effect = line.column === 'count' || line.active === false ? null : (line.column === 'use' || outgoing ? -1 : 1) * line.quantity;
    return {
      id: line.id, date: line.date, type: labels[line.column] || line.column, source: line.source,
      document: String(doc.id ?? line.document ?? ''), status: line.status || doc.status || 'APPROVED',
      active: line.active !== false, warehouse: warehouses.get(line.warehouse), origin, destination,
      quantity: line.quantity, unit: line.unit, effect, exactQuantity: line.exactQuantity ?? line.quantity,
      originalQuantity: line.originalQuantity ?? line.quantity, originalUnit: line.originalUnit || line.unit,
      createdAt: doc.createdAt || null, approvedAt: doc.approvedAt || null, observation: doc.observation || '',
      estimated: !!line.estimated, transfer: line.source === 'transfers', count: line.column === 'count'
    };
  }).sort((a,b) => a.date.localeCompare(b.date) || a.document.localeCompare(b.document, 'es', { numeric: true }) || String(a.id).localeCompare(String(b.id)));
  const daily = (state?.daily || []).filter(row => warehouse && row.warehouse === warehouse.id && sameItem(row) && row.date >= from && row.date <= final)
    .map(row => ({ date: row.date, opening: row.opening, closing: row.closing, physicalCount: row.physicalCount, adjustment: row.adjustment,
      ...Object.fromEntries(Object.keys(labels).filter(key => key !== 'count').map(key => [key, row[key] ?? 0])) }));
  const consumptionMovements = [];
  for (const value of Object.values(consumption)) {
    if (!value?.available || value.error) continue;
    for (const row of [...(value.products?.products || []), ...(value.ingredients?.items || [])].filter(row => row.code === item.code)) {
      for (const day of row.dailyQuantities || []) {
        const quantity = convertQuantity(day.quantity, row.unit, item.unit);
        if (quantity == null || quantity === 0 || day.date < from || day.date > to) continue;
        consumptionMovements.push({date:day.date,type:value.label,quantity,unit:item.unit,effect:-quantity,originalQuantity:day.quantity,originalUnit:row.unit,source:day.source,product:day.productCode ? `${day.productCode} · ${day.productName}` : `${row.code} · ${row.name}`});
      }
    }
  }
  consumptionMovements.sort((a,b)=>a.date.localeCompare(b.date));
  return { code: item.code, name: item.name, unit: item.unit, location: location.name, warehouse: warehouse?.name || null,
    from, to, finalDate: final, capturedAt: state?.sourceCapturedAt || null, documentsAvailable: !!warehouse && state?.sourceKind === 'native-documents',
    movements, daily, consumptionMovements, issues: (state?.issues || []).filter(issue => issue.code === item.code || ['coverage', 'local-transfer-coverage'].includes(issue.kind)).map(issue => issue.message) };
}
module.exports = { buildItemDetail };
