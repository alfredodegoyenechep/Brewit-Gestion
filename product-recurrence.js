const recurrence = require('./recurrence');
const { addDays } = require('./network-sales');
const { daysBetween } = require('./transaction-linkage');

const VERSION = 'product-recurrence-exclusive-v1';
const WINDOWS = [15, 30, 60, 90];
const { selection, productOptions, selectOrders, aggregateProductReport } = require('./product-report');
// Strictly earlier local dates: the current purchase and later purchases cannot establish recurrence.
function previousDate(dates, date) {
  let low = 0, high = dates.length;
  while (low < high) { const mid = (low + high) >>> 1; if (dates[mid] < date) low = mid + 1; else high = mid; }
  return low ? dates[low - 1] : null;
}
function buildProductRecurrence(state, orders, coverage = [], query = {}, warnings = []) {
  const filters = selection(query), { report, histories } = state;
  const asOf = report.period.to < report.today ? `${report.period.to}T23:59:59` : `${report.today}T${query.serverCutoff || '23:59:59'}`;
  const selectedOrders = selectOrders(orders, report.locationIds, report.period, asOf);
  // Resolve against the whole basket and all orders, before filtering products or hierarchies.
  const purchases = recurrence.buildPurchases(state, selectedOrders, coverage);
  const links = new Map(purchases.details.map(row => [row.orderKey, row]));
  const historyByAlias = new Map([...histories.values()].map(item => [item.alias, item.dates]));
  const aggregated = aggregateProductReport(selectedOrders, filters, [...WINDOWS, 'withoutRecent', 'unclassified'], order => {
    const linked = links.get(order.orderKey);
    const dates = linked && linked.classification !== 'unclassified' ? historyByAlias.get(linked.alias) : null;
    const prior = dates ? previousDate(dates, order.date) : null;
    const age = prior ? daysBetween(prior, order.date) : null;
    return !dates ? 'unclassified' : WINDOWS.find(days => age !== null && age >= 1 && age <= days) || 'withoutRecent';
  }, (buckets, metric) => ({
    windows: Object.fromEntries(WINDOWS.map(days => [days, { days, ...metric(buckets[days]) }])),
    recurring: metric(WINDOWS.reduce((sum, days) => sum + buckets[days], 0)),
    withoutRecent: metric(buckets.withoutRecent), unclassified: metric(buckets.unclassified)
  }));
  const salesCoverage = recurrence.coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'sales');
  const historyCoverage = recurrence.coverageFor(coverage, report.locationIds, addDays(report.period.from, -90), report.period.to);
  const paymentCoverage = recurrence.coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'payment-details');
  return { definitionVersion: VERSION, identityDefinitionVersion: recurrence.VERSION, scope: report.scope, period: report.period,
    asOf, identityAsOf: report.asOf, filters, windows: WINDOWS, ...aggregated,
    status: !aggregated.rows.length ? salesCoverage.complete ? 'no_activity' : 'no_data' : warnings.length || report.eligibilityPartial || aggregated.totals.missingSales || !salesCoverage.complete || !historyCoverage.complete || !paymentCoverage.complete ? 'partial' : 'complete',
    coverage: { sales: salesCoverage, history: historyCoverage, payments: paymentCoverage }, linkage: purchases.linkage,
    monetaryBasis: 'Venta neta de las líneas TotEat después de descuentos, sin IVA, con la misma base del análisis de ventas. No se usa el importe MercadoPago como venta de producto.',
    definition: 'Cada venta se asigna una sola vez según la compra anterior más reciente del mismo medio de pago en otra fecha local: 1–15, 16–30, 31–60 o 61–90 días. El antecedente puede ser de cualquier producto y monto, dentro de la cafetería seleccionada; Todas considera la red.',
    denominator: 'Venta neta total de cada fila, incluida la venta sin vínculo identificable. Los tramos son excluyentes y se pueden sumar.',
    warnings: [...new Set([...report.warnings, ...warnings,
      ...(!historyCoverage.complete ? ['Historial de 90 días incompleto: los tramos reflejan antecedentes observados y son provisionales. Sin antecedente observado no significa cliente nuevo.'] : []),
      ...(aggregated.totals.missingSales ? ['Hay líneas sin venta neta disponible; su cantidad se incluye y los totales afectados se muestran sin importe.'] : [])])] };
}
module.exports = { VERSION, WINDOWS, selection, productOptions, previousDate, buildProductRecurrence };
