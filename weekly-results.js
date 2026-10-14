const { advance } = require('./inventory-boundaries');

const metrics = [
  ['netSales', 'Venta neta'], ['grossSales', 'Venta bruta'], ['discounts', 'Descuentos'],
  ['grossSalesAfterDiscounts', 'Venta Bruta post Dsctos'], ['margin', 'Margen'], ['tips', 'Propinas'],
  ['mercadoPagoTips', 'MercadoPago'], ['cashTips', 'Efectivo'],
  ['mercadoPagoFee', 'Comision Mercadopago'], ['cashCollection', 'Efectivo'], ['mercadoPagoTheoretical', 'MP Teorico'],
  ['mercadoPagoCollection', 'Mercado Pago'],
  ['collectionDifference', 'Control de diferencias'], ['inventoryShortage', 'Inventario faltante'],
  ['waste', 'Merma'], ['marketing', 'Marketing'], ['employees', 'Consumo personal'],
  ['otherConsumables', 'Otros gastos / consumibles'],
  ['inventoryConsumptionTotal', 'Total inventario faltante, merma, marketing, consumo personal y otros gastos / consumibles'],
  ['expenseIncome', 'Ingreso gastos'],
  ['headOfficeSupplyIncome', 'Ingreso insumos casa matriz']
];
const percentlessMetrics = new Set(['grossSales', 'grossSalesAfterDiscounts', 'mercadoPagoTheoretical', 'mercadoPagoCollection', 'mercadoPagoTips', 'cashTips']);

function reportOptions({ weeks = 4, includeInventory = true } = {}) {
  const count = Number(weeks);
  if (!['number', 'string'].includes(typeof weeks) || ![2, 3, 4].includes(count)) {
    throw Object.assign(Error('Selecciona 2, 3 o 4 semanas.'), { status: 400 });
  }
  const include = includeInventory === true || includeInventory === 'true' ? true
    : includeInventory === false || includeInventory === 'false' ? false : null;
  if (include === null) throw Object.assign(Error('Selecciona si deseas incluir el cálculo de inventario.'), { status: 400 });
  return { weeks: count, includeInventory: include };
}

function currentWeeks(today, count = 4) {
  const date = new Date(`${today}T00:00:00Z`);
  const monday = advance(today, -(date.getUTCDay() + 6) % 7);
  return Array.from({ length: count }, (_, index) => {
    const from = advance(monday, -index * 7), to = advance(from, 6);
    return { from, to, through: to < today ? to : today };
  });
}

function selectInventoryDates(countDates, period) {
  const dates = [...new Set(countDates)].sort();
  const finalDate = dates.filter(date => date >= period.from && date <= period.through).at(-1);
  if (!finalDate) return { status: 'no-physical-count', initialDate: null, finalDate: null, movements: null };
  const initialDate = dates.filter(date => date < finalDate).at(-1);
  if (!initialDate) return { status: 'no-opening-inventory', initialDate: null, finalDate, movements: null };
  return { status: 'complete', initialDate, finalDate, movements: { from: initialDate, to: advance(finalDate, -1) } };
}

function value(amount = null, status = 'no-data', detail = {}) {
  const available = Number.isFinite(amount);
  return { amount: available ? amount : null, percent: null, available,
    complete: available && status === 'complete', status, ...detail };
}

function fromMetric(metric, { expense = false } = {}) {
  if (!metric?.available || !Number.isFinite(metric.amount)) return value();
  return value(expense ? -Math.abs(metric.amount) : metric.amount,
    metric.partial || metric.complete === false ? 'partial' : 'complete');
}

function derived(values, keys, calculate, requireComplete = false) {
  const inputs = keys.map(key => values[key]);
  if (inputs.some(input => !input?.available) || (requireComplete && inputs.some(input => !input.complete))) {
    return value(null, 'incomplete');
  }
  return value(calculate(...inputs.map(input => input.amount)), inputs.every(input => input.complete) ? 'complete' : 'partial');
}

function finalizeCell(data = {}, includeInventory = true) {
  const values = Object.fromEntries(metrics.map(([key]) => [key, data.values?.[key] || value()]));
  if (!includeInventory) {
    values.inventoryShortage = value(null, 'not-included');
    values.otherConsumables = value(null, 'not-included');
    data = { ...data, inventory: { status: 'not-included', initialDate: null, finalDate: null, movements: null } };
  }
  values.grossSalesAfterDiscounts = derived(values, ['grossSales', 'discounts'], (gross, discounts) => gross - discounts);
  values.mercadoPagoTheoretical = derived(values, ['grossSales', 'discounts', 'tips', 'mercadoPagoFee', 'cashCollection'],
    (gross, discounts, tips, fee, cash) => gross - discounts + tips - fee - cash);
  values.collectionDifference = derived(values, ['mercadoPagoCollection', 'mercadoPagoTheoretical'],
    (mp, theoretical) => mp - theoretical);
  values.inventoryConsumptionTotal = derived(values, ['inventoryShortage', 'waste', 'marketing', 'employees', 'otherConsumables'],
    (...amounts) => amounts.reduce((sum, amount) => sum + amount, 0));
  if (values.inventoryShortage.status === 'not-included') values.inventoryConsumptionTotal = value(null, 'not-included');
  values.expenseIncome = value(null, 'pending');
  values.headOfficeSupplyIncome = value(null, 'pending');
  const base = values.netSales;
  for (const [key, metric] of Object.entries(values)) {
    metric.showPercent = !percentlessMetrics.has(key);
    if (metric.showPercent && metric.available && base.available && base.amount !== 0) {
      metric.percent = metric.amount / base.amount * 100;
      metric.percentPartial = !metric.complete || !base.complete;
    }
  }
  return { ...data, values };
}

function report(today, locations, options) {
  return { date: today, locations, metrics, options,
    weeks: currentWeeks(today, options.weeks).map(period => ({ period, locations: [] })), warnings: [] };
}
function append(data, week, location, build) {
  let cell;
  try { cell = build(location, week.period); }
  catch (error) { cell = { warnings: [error.message] }; }
  const result = { ...finalizeCell(cell, data.options.includeInventory), locationId: location.id };
  week.locations.push(result);
  for (const warning of result.warnings || []) data.warnings.push(`${location.name} (${week.period.from} al ${week.period.through}): ${warning}`);
}
function buildWeeklyResults({ today, locations, ...options }, build) {
  const data = report(today, locations, reportOptions(options));
  for (const week of data.weeks) for (const location of locations) append(data, week, location, build);
  return data;
}
async function buildWeeklyResultsWithProgress({ today, locations, ...options }, build, progress, cancelled = () => false) {
  const data = report(today, locations, reportOptions(options)), total = data.weeks.length * locations.length;
  let completed = 0;
  progress({ completed, total });
  for (const week of data.weeks) for (const location of locations) {
    await new Promise(resolve => setImmediate(resolve));
    if (cancelled()) return null;
    append(data, week, location, build);
    progress({ completed: ++completed, total, location: location.name, period: week.period });
  }
  return cancelled() ? null : data;
}

async function buildDailyResultsWithProgress({ today, period, location }, build, progress, cancelled = () => false) {
  const data = { date: today, period, location, metrics, days: [] };
  progress({ completed: 0, total: 7 });
  for (let index = 0; index < 7; index++) {
    await new Promise(resolve => setImmediate(resolve));
    if (cancelled()) return null;
    const date = advance(period.from, index);
    let cell = {};
    if (date <= period.through) {
      try { cell = build(location, { from: date, to: date, through: date, valuationThrough: period.through }); }
      catch (error) { cell = { warnings: [error.message] }; }
    }
    const result = finalizeCell(cell, false);
    if (date > period.through) for (const [key, metric] of Object.entries(result.values)) {
      result.values[key] = value(null, 'future', { showPercent: metric.showPercent });
    }
    for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
      result.values[key] = value(null, 'weekly-only', { showPercent: false });
    }
    data.days.push({ ...result, date, locationId: location.id });
    progress({ completed: index + 1, total: 7, date });
  }
  return cancelled() ? null : data;
}

module.exports = { metrics, reportOptions, currentWeeks, selectInventoryDates, value, fromMetric, derived,
  finalizeCell, buildWeeklyResults, buildWeeklyResultsWithProgress, buildDailyResultsWithProgress };
