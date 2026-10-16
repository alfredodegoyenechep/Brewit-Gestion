const crypto = require('node:crypto');

const labels = Object.fromEntries(require('./weekly-results').metrics);
const column = (key, label, type = 'text') => ({ key, label, type });
const identity = [column('code', 'Código'), column('name', 'Producto / artículo')];
const quantity = [column('quantity', 'Cantidad', 'number'), column('unit', 'Unidad')];
const cost = [column('unitCost', 'Costo unitario', 'unitCost'), column('amount', 'Importe', 'currency'), column('status', 'Estado')];
const priced = item => item.costAvailable !== false && !item.costIncomplete && item.costSource !== 'missing';

function sales(facts) {
  const groups = new Map();
  for (const fact of facts) {
    const key = JSON.stringify([fact.code, fact.name]);
    const row = groups.get(key) || { code: fact.code, name: fact.name, quantity: 0, amount: 0 };
    row.quantity += fact.quantity; row.amount += fact.netSales; groups.set(key, row);
  }
  return { columns: [...identity, column('quantity', 'Unidades', 'number'), column('amount', 'Venta neta sin IVA', 'currency')],
    rows: [...groups.values()], notes: ['Venta neta sin IVA, después de descuentos. Incluye productos y extras; conserva devoluciones y ajustes.'] };
}

function tips(rows) {
  return { columns: [column('date', 'Fecha', 'date'), column('method', 'Medio de pago'),
    column('payments', 'Pagos', 'number'), column('amount', 'Propinas', 'currency')], rows,
    notes: ['Propinas registradas por fecha de cierre y medio de pago. Los pagos repetidos se cuentan una sola vez.'] };
}

function expense(items, { waste = false } = {}) {
  // Preserve reversals: the summary applies -abs to the total, not each line.
  const total = items.reduce((sum, item) => sum + item.totalCost, 0), sign = total < 0 ? 1 : -1;
  return { columns: [...identity, ...quantity, ...cost], rows: items.map(item => ({
    code: item.code, name: item.name, quantity: waste ? item.total : item.quantity, unit: item.unit,
    unitCost: item.costSource === 'missing' ? null : item.unitCost,
    amount: item.costSource === 'missing' ? null : sign * item.totalCost,
    status: priced(item) ? 'Valorizado' : item.costSource === 'missing' ? 'Sin costo' : 'Costo parcial'
  })), notes: [waste ? 'Entradas a la bodega de merma dentro del período calendario.'
    : 'Consumo del período calendario, valorizado con los mismos costos del reporte.', 'Los gastos se presentan con signo negativo; los reversos conservan su efecto en el total.'] };
}

function differences(report, { consumables = false } = {}) {
  const items = report.items || [];
  const total = items.reduce((sum, item) => sum + (priced(item) && Number.isFinite(item.totalCost) ? item.totalCost : 0), 0);
  const sign = consumables && total > 0 ? -1 : 1;
  return { columns: [...identity, column('unit', 'Unidad'), column('opening', 'Inventario inicial', 'number'),
    column('theoretical', 'Final teórico ajustado', 'number'), column('physical', 'Final físico', 'number'),
    column('difference', 'Diferencia', 'number'), ...cost],
    rows: items.map(item => ({ code: item.code, name: item.name, unit: item.unit,
      opening: item.initialInventory, theoretical: item.adjustedTheoreticalFinal, physical: item.finalInventory,
      difference: item.difference, unitCost: priced(item) ? item.unitCost : null,
      amount: priced(item) && Number.isFinite(item.totalCost) ? item.totalCost * sign : null,
      status: !item.finalIsPhysical ? 'Sin toma final' : !priced(item) ? 'Sin costo completo' : 'Valorizado'
    })), excluded: (report.excluded || []).map(item => ({ code: item.code, name: item.name, reason: item.reason })),
    notes: ['Diferencia = inventario físico − inventario teórico ajustado. El teórico incluye consumos y compensaciones del Kardex.',
      consumables ? 'Consumibles separados del faltante; el total conserva la presentación de gasto del reporte.'
        : 'Conserva el signo del Kardex: positivo indica sobrante y negativo, faltante. Los consumibles se presentan en su propio reporte.'] };
}

function balances(items, excluded = []) {
  const { isOther } = require('./other-consumables');
  const rows = items.map(item => ({
    code: item.code, name: item.name, quantity: item.quantity, unit: item.unit,
    group: isOther(item.code) ? 'Otros consumibles' : 'Inventario sin consumibles',
    unitCost: item.costAvailable ? item.unitCost : null,
    amount: item.costAvailable && Number.isFinite(item.quantity) ? item.quantity * item.unitCost : null,
    status: !Number.isFinite(item.quantity) ? 'Sin saldo físico' : !item.costAvailable ? 'Sin costo completo' : 'Valorizado'
  }));
  return { columns: [...identity, column('group', 'Grupo'), ...quantity, ...cost], rows,
    groups: ['Inventario sin consumibles', 'Otros consumibles'].map(label => ({ label,
      amount: rows.filter(row => row.group === label).reduce((sum, row) => sum + (row.amount ?? 0), 0) })),
    excluded: excluded.map(item => ({ code: item.code, name: item.name, reason: item.reason })),
    notes: ['Valor del inventario = cantidad × costo unitario. Incluye los consumibles; los artículos sin saldo o costo completo no se suman.'] };
}

function createDetailStore({ limit = 512, ttl = 3600000, clock = Date.now } = {}) {
  const snapshots = new Map();
  return {
    put(key, detail, metric, location, period, queryDate, metadata = {}) {
      if (!detail || !metric?.available) return null;
      const report = { key, title: labels[key], location: { id: location.id, name: location.name },
        period: { from: period.from, through: period.through }, queryDate, total: metric.amount,
        partial: !metric.complete, ...detail, ...metadata };
      const id = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
      for (const [token, entry] of snapshots) if (entry.expires <= clock()) snapshots.delete(token);
      snapshots.delete(id);
      while (snapshots.size >= limit) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(id, { expires: clock() + ttl, report });
      return id;
    },
    get(id) {
      const entry = snapshots.get(id);
      if (!entry || entry.expires <= clock()) { snapshots.delete(id); return null; }
      return entry.report;
    }
  };
}

module.exports = { sales, tips, expense, differences, balances, createDetailStore };
