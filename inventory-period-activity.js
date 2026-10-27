const { consumptionStockRows } = require('./consumption-quantities');
const nonzero = value => value != null && Number.isFinite(Number(value)) && Number(value) !== 0;
const movementFields = ['purchase', 'use', 'transfer_local_in', 'transfer_local_out', 'transfer_warehouse_in', 'transfer_warehouse_out', 'transformed_in', 'transformed_out'];

// Preserve evidence of gross activity even when signed period totals cancel out.
function markPeriodMovementActivity(report, { stock, parsed, consumption = {}, location, convertQuantity, numericValue = Number }) {
  const byCode = new Map();
  for (const item of report.items) {
    if (!byCode.has(item.code)) byCode.set(item.code, []);
    byCode.get(item.code).push(item);
  }
  const add = (code, unit, quantity) => {
    if (!nonzero(quantity)) return;
    for (const item of byCode.get(code) || []) {
      const converted = convertQuantity ? convertQuantity(Number(quantity), unit, item.unit)
        : String(unit).toUpperCase() === String(item.unit).toUpperCase() ? Number(quantity) : null;
      if (nonzero(converted)) item.hasPeriodMovements = true;
    }
  };
  const inPeriod = row => row.date >= report.dateFrom && row.date <= report.dateTo;
  const warehouse = stock?.warehouses?.find(row => Number(row.custom_id) === (location.type === 'warehouse' ? 1 : 2));
  if (warehouse) {
    for (const row of [...(stock.operationLines || []), ...(stock.movements || [])]) {
      if (row.warehouse === warehouse.id && inPeriod(row) && row.active !== false && row.column !== 'count') add(row.code, row.unit, row.quantity);
    }
    for (const row of stock.daily || []) {
      if (row.warehouse !== warehouse.id || !inPeriod(row)) continue;
      for (const field of movementFields) add(row.code, row.unit, row[field]);
    }
  }
  if (parsed) {
    for (const product of parsed.products) for (const group of parsed.groups.filter(inPeriod)) {
      for (const metric of group.metrics) {
        if (!/^(ii\s*-|if\s*-|costo$)/i.test(metric.normalized)) add(product.code, product.unit, numericValue(product.row[metric.column]));
      }
    }
  }
  for (const entry of Object.values(consumption)) {
    if (!entry?.available || entry.error) continue;
    for (const row of consumptionStockRows(entry)) for (const day of row.dailyQuantities || []) {
      if (inPeriod(day)) add(row.code, row.unit, day.quantity);
    }
  }
}
module.exports = { markPeriodMovementActivity };
