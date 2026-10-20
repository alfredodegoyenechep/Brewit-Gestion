const { buildItemDetail } = require('./inventory-item-detail');

const fields = {
  purchase: ['Compras', 1], use: ['Consumo de ventas', -1],
  transfer_local_in: ['Transferencia local entrada', 1], transfer_local_out: ['Transferencia local salida', -1],
  transfer_warehouse_in: ['Transferencia bodega entrada', 1], transfer_warehouse_out: ['Transferencia bodega salida', -1],
  transformed_in: ['Transformación entrada', 1], transformed_out: ['Transformación salida', -1]
};
const identity = item => JSON.stringify([item.code, String(item.unit).toUpperCase()]);
const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { numeric: true });
const metricKey = label => label.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Export the saved report, so refreshing sources cannot change an open report.
function buildMovementReport(snapshot, { convertQuantity = (quantity, from, to) => from === to ? quantity : null, numericValue = Number } = {}) {
  const { report, location, stock, consumption, parsed } = snapshot;
  const dates = [];
  for (let day = Date.parse(`${report.dateFrom}T00:00:00Z`), end = Date.parse(`${report.dateTo}T00:00:00Z`); day <= end; day += 86400000) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  const inPeriod = row => row.date >= report.dateFrom && row.date <= report.dateTo;
  const index = rows => {
    const map = new Map();
    for (const row of rows || []) {
      const key = identity(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };
  const warehouse = stock?.warehouses?.find(w => Number(w.custom_id) === (location.type === 'warehouse' ? 1 : 2));
  const scoped = rows => (rows || []).filter(row => warehouse && row.warehouse === warehouse.id && inPeriod(row));
  const operations = index(scoped(stock?.operationLines));
  const movements = index(scoped(stock?.movements));
  const daily = index(scoped(stock?.daily));
  const products = index(parsed?.products);
  const documents = new Map((stock?.documents || []).map(doc => [doc.key, doc]));
  const items = snapshot.items.map(item => {
    const key = identity(item), lines = [...(operations.get(key) || []), ...(movements.get(key) || [])];
    const detail = buildItemDetail(stock ? {
      ...stock, operationLines: operations.get(key) || [], movements: movements.get(key) || [], daily: daily.get(key) || [],
      documents: [...new Set(lines.map(line => line.document))].map(key => documents.get(key)).filter(Boolean)
    } : null, location, report, item, { consumption, convertQuantity });
    // Public API movements are daily aggregates without line identities. Read
    // them from daily rows, rather than treating them as individual documents.
    const entries = (stock?.sourceKind === 'public-inventory' ? [] : detail.movements).filter(row => row.active && !row.count && Number.isFinite(row.effect) && row.effect !== 0 && inPeriod(row))
      .map(row => ({ date: row.date, type: row.type, document: row.document, effect: row.effect, column: row.column }));
    // Daily aggregates fill movements without individual documents. Conflicting
    // totals must not become invented entries or exits in the exported ledger.
    const documented = new Map();
    for (const row of entries) {
      const key = `${row.date}|${row.column}`;
      documented.set(key, (documented.get(key) || 0) + row.effect);
    }
    for (const row of detail.daily.filter(inPeriod)) {
      for (const [field, [label, direction]] of Object.entries(fields)) {
        const cell = `${row.date}|${field}`;
        const effect = direction * (row[field] || 0);
        if (documented.has(cell)) {
          if (Math.abs(effect - documented.get(cell)) > 1e-6) throw Object.assign(new Error(`Los documentos y el total diario de ${item.code} (${row.date}, ${label}) no coinciden. Vuelve a procesar el inventario antes de exportar.`), { status: 409 });
        } else if (effect) entries.push({ date: row.date, type: label, document: 'Total diario sin documento individual', effect });
      }
    }
    if (!stock && parsed) {
      for (const product of products.get(key) || []) {
        for (const group of parsed.groups.filter(inPeriod)) {
          for (const metric of group.metrics) {
            const key = metricKey(metric.normalized);
            if (/^(ii-|if-|aju-)|^costo$/.test(key)) continue;
            const direction = /^(uso-|trl-out-|mov-out-|trn-out-)/.test(key) ? -1 : 1;
            const effect = direction * (numericValue(product.row[metric.column]) || 0);
            if (effect) entries.push({ date: group.date, type: metric.label, document: 'Total diario del archivo Kardex', effect });
          }
        }
      }
    }
    for (const row of detail.consumptionMovements) {
      if (row.effect) entries.push({ date: row.date, type: row.type, document: row.source || row.product || '', effect: row.effect });
    }
    entries.sort((a, b) => compare(a.date, b.date) || compare(a.document, b.document) || compare(a.type, b.type));
    const days = Object.fromEntries(dates.map(date => [date, { incoming: 0, outgoing: 0 }]));
    for (const row of entries) {
      if (row.effect > 0) days[row.date].incoming += row.effect;
      else days[row.date].outgoing -= row.effect;
    }
    return {
      code: item.code, name: item.name, unit: item.unit, hierarchyPath: item.hierarchyPath?.length ? item.hierarchyPath : ['Sin jerarquía'],
      initialInventory: item.initialInventory ?? null,
      finalInventory: (report.boundaryMode ? item.adjustedTheoreticalFinal : item.theoreticalFinal) ?? null,
      physicalInventory: (report.selection ? item.finalInventory : item.physicalFinal) ?? null,
      adjustments: Object.entries(item.movements || {}).filter(([key]) => key.startsWith('aju-')).reduce((sum, [, quantity]) => sum + quantity, 0),
      compensation: item.compensationQuantity || 0,
      incoming: entries.reduce((sum, row) => sum + Math.max(0, row.effect), 0),
      outgoing: entries.reduce((sum, row) => sum + Math.max(0, -row.effect), 0),
      entries, days, hasIncoming: entries.some(row => row.effect > 0), hasOutgoing: entries.some(row => row.effect < 0)
    };
  });
  items.sort((a, b) => {
    const length = Math.max(a.hierarchyPath.length, b.hierarchyPath.length);
    for (let i = 0; i < length; i++) {
      const order = compare(a.hierarchyPath[i], b.hierarchyPath[i]);
      if (order) return order;
    }
    return compare(a.name, b.name) || compare(a.code, b.code) || compare(a.unit, b.unit);
  });
  return {
    location: location.name, dateFrom: report.dateFrom, dateTo: report.dateTo, dates, items,
    initialDate: report.selection?.initialDate || report.dateFrom,
    finalDate: report.selection?.finalDate || report.physicalInventoryDate || report.dateTo,
    notes: [
      'Cantidades en la unidad de cada producto. Incluye todos los productos del informe procesado y los consumibles separados, sin aplicar los filtros de la tabla.',
      'Inventario final teórico: saldo calculado del consolidado, incluidas sus compensaciones. Inventario final físico: saldo de la toma final; vacío cuando no está disponible. Las entradas y salidas incluyen compras, ventas, transferencias, transformaciones y consumos internos contabilizados.',
      'Las tomas físicas fijan saldos; sus ajustes y las compensaciones del período no son entradas ni salidas. Pueden explicar diferencias entre saldo inicial + entradas − salidas y saldo final. No se asignan compensaciones a días sin evidencia.',
      'Los movimientos sin documento individual se identifican como totales diarios. Se excluyen documentos pendientes, anulados y movimientos fuera del período.'
    ]
  };
}
module.exports = { buildMovementReport };
