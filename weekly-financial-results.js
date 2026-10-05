const inventoryMetrics = [
  ['marketingConsumption', 'Costo consumo marketing'],
  ['employeeConsumption', 'Costo consumo colaboradores'],
  ['calibrationConsumption', 'Calibraciones y bebidas desechadas'],
  ['waste', 'Costo de merma'], ['otherConsumables', 'Otros Consumibles'],
  ['adjustedKardexTotalCost', 'Costo Total Kardex ajustado por sustit. y vasos no ut.']
];
const metrics = [
  ['grossSales', 'Venta Bruta'],
  ['mercadoPagoCollection', 'Recaudación MercadoPago'],
  ['mercadoPagoTips', 'Propinas recaudadas (MercadoPago)'],
  ['mercadoPagoNet', 'MercadoPago menos propinas'],
  ['mercadoPagoDifference', 'Diferencia MercadoPago vs. Venta Bruta'],
  ['cashSales', 'Venta en efectivo (TotEat)'],
  ['collectedSales', 'Recaudación sin propinas (MercadoPago + efectivo)'],
  ['collectionDifference', 'Diferencia final vs. Venta Bruta'],
  ['netSales', 'Venta Neta'], ['discounts', 'Total Descuentos'],
  ...inventoryMetrics, ['combined', 'Total Costos (sin descuentos)']
];
const iso = date => date.toISOString().slice(0, 10);
function currentWeeks(today) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 - 28);
  return Array.from({ length: 5 }, () => {
    const from = iso(date); date.setUTCDate(date.getUTCDate() + 6);
    const to = iso(date); date.setUTCDate(date.getUTCDate() + 1);
    return { from, to };
  });
}
function extract(payload) {
  const collection = key => ({
    amount: payload.statement?.[key]?.amount ?? 0,
    available: payload.statement?.[key]?.available === true,
    complete: payload.statement?.[key]?.complete === true
  });
  const values = {
    netSales: { amount: payload.revenue.total.netSales || 0, complete: payload.revenue.filesRead > 0 },
    mercadoPagoCollection: collection('mercadoPagoCollection'),
    mercadoPagoTips: collection('mercadoPagoTips'),
    cashSales: collection('cashSales'),
    discounts: { amount: payload.revenue.discountsNet || 0, complete: payload.revenue.filesRead > 0 }
  };
  values.grossSales = { amount: Math.round(values.netSales.amount * 1.19), available: values.netSales.complete, complete: values.netSales.complete };
  const derived = (amount, sources) => ({ amount, available: sources.every(value => value.available), complete: sources.every(value => value.complete) });
  values.mercadoPagoNet = derived(values.mercadoPagoCollection.amount - values.mercadoPagoTips.amount, [values.mercadoPagoCollection, values.mercadoPagoTips]);
  values.mercadoPagoDifference = derived(values.mercadoPagoNet.amount - values.grossSales.amount, [values.mercadoPagoNet, values.grossSales]);
  values.collectedSales = derived(values.mercadoPagoNet.amount + values.cashSales.amount, [values.mercadoPagoNet, values.cashSales]);
  values.collectionDifference = derived(values.collectedSales.amount - values.grossSales.amount, [values.collectedSales, values.grossSales]);
  const summaries = payload.inventorySummaries || [];
  for (const [key] of inventoryMetrics) {
    const cells = summaries.map(summary => summary?.metrics?.[key]);
    values[key] = {
      amount: cells.reduce((sum, cell) => sum + (cell?.available ? -Math.round(Math.abs(cell.amount || 0)) : 0), 0),
      complete: cells.length > 0 && cells.every(cell => cell?.available && !cell.partial)
    };
  }
  values.combined = {
    amount: inventoryMetrics.reduce((sum, [key]) => sum + values[key].amount, 0),
    complete: inventoryMetrics.every(([key]) => values[key].complete)
  };
  return percentages(values);
}
function percentages(values) {
  const base = values.netSales.amount;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    ...value, percent: base ? value.amount / base * 100 : 0
  }]));
}
function report(weeks, scope, warnings) {
  const total = percentages(Object.fromEntries(metrics.map(([key]) => [key, {
    amount: weeks.reduce((sum, week) => sum + week.values[key].amount, 0),
    ...(weeks.some(week => 'available' in week.values[key]) ? { available: weeks.some(week => week.values[key].available) } : {}),
    complete: weeks.every(week => week.values[key].complete)
  }])));
  return { period: { from: weeks[0].period.from, to: weeks.at(-1).period.to }, scope, metrics, weeks, total, warnings: [...warnings] };
}
function buildWeeklyResults(query, build) {
  const warnings = new Set(); let scope;
  const weeks = currentWeeks(query.today).map(period => {
    const data = build({ ...query, dateFrom: period.from, dateTo: period.to < query.today ? period.to : query.today });
    scope = data.scope; data.warnings.forEach(warning => warnings.add(warning));
    return { period, values: extract(data) };
  });
  return report(weeks, scope, warnings);
}
async function buildWeeklyResultsWithProgress(query, build, progress, cancelled = () => false) {
  const periods = currentWeeks(query.today), weeks = [], warnings = new Set(); let scope;
  for (const [index, period] of periods.entries()) {
    if (cancelled()) return null;
    progress({ completed: index, total: 5, week: index + 1, period });
    await new Promise(resolve => setImmediate(resolve));
    if (cancelled()) return null;
    const data = build({ ...query, dateFrom: period.from, dateTo: period.to < query.today ? period.to : query.today });
    scope = data.scope; data.warnings.forEach(warning => warnings.add(warning));
    weeks.push({ period, values: extract(data) });
    progress({ completed: index + 1, total: 5, week: index + 1, period });
    await new Promise(resolve => setImmediate(resolve));
  }
  return report(weeks, scope, warnings);
}
module.exports = { currentWeeks, buildWeeklyResults, buildWeeklyResultsWithProgress };
