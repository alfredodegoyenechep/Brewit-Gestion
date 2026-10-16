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
  ['finalInventory', 'Inventario Final'],
  ['centralWarehouseInbound', 'Entradas Bodega Central'],
  ['directSupplierInbound', 'Entradas Proveedores Directos']
];
const percentlessMetrics = new Set(['grossSales', 'grossSalesAfterDiscounts', 'mercadoPagoTheoretical', 'mercadoPagoCollection', 'mercadoPagoTips', 'cashTips', 'finalInventory']);

function reportOptions({ weeks = 2, count = weeks, period = 'week', includeCurrent = false, includeInventory = true } = {}) {
  if (!['week', 'month'].includes(period)) throw Object.assign(Error('Selecciona semanas o meses.'), { status: 400 });
  const selectedCount = Number(count);
  if (!['number', 'string'].includes(typeof count) || ![2, 3, 4].includes(selectedCount)) {
    throw Object.assign(Error('Selecciona 2, 3 o 4 períodos.'), { status: 400 });
  }
  const include = includeInventory === true || includeInventory === 'true' ? true
    : includeInventory === false || includeInventory === 'false' ? false : null;
  if (include === null) throw Object.assign(Error('Selecciona si deseas incluir el cálculo de inventario.'), { status: 400 });
  const current = includeCurrent === true || includeCurrent === 'true' ? true
    : includeCurrent === false || includeCurrent === 'false' ? false : null;
  if (current === null) throw Object.assign(Error('Selecciona si deseas incluir el período actual.'), { status: 400 });
  return { weeks: selectedCount, includeInventory: include, period, includeCurrent: current };
}

function currentWeeks(today, count = 4, includeCurrent = true) {
  const date = new Date(`${today}T00:00:00Z`);
  const monday = advance(today, -(date.getUTCDay() + 6) % 7);
  return Array.from({ length: count }, (_, index) => {
    const from = advance(monday, -(index + (includeCurrent ? 0 : 1)) * 7), to = advance(from, 6);
    return { from, to, through: to < today ? to : today };
  });
}

function currentPeriods(today, { weeks = 4, period = 'week', includeCurrent = true } = {}) {
  if (period === 'week') return currentWeeks(today, weeks, includeCurrent);
  const [year, month] = today.split('-').map(Number);
  const iso = date => date.toISOString().slice(0, 10);
  return Array.from({ length: weeks }, (_, index) => {
    const offset = index + (includeCurrent ? 0 : 1);
    const from = iso(new Date(Date.UTC(year, month - 1 - offset, 1)));
    const to = iso(new Date(Date.UTC(year, month - offset, 0)));
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
    weeks: currentPeriods(today, options).map(period => ({ period, locations: [] })), warnings: [] };
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

async function buildDailyResultsWithProgress({ today, period, location, periodType = 'week' }, build, progress, cancelled = () => false) {
  const data = { date: today, period, periodType, location, metrics, days: [] };
  const total = Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1;
  progress({ completed: 0, total });
  for (let index = 0; index < total; index++) {
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
    for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal', 'finalInventory']) {
      result.values[key] = value(null, periodType === 'month' ? 'monthly-only' : 'weekly-only', { showPercent: false });
    }
    data.days.push({ ...result, date, locationId: location.id });
    progress({ completed: index + 1, total, date });
  }
  return cancelled() ? null : data;
}

module.exports = { metrics, reportOptions, currentWeeks, currentPeriods, selectInventoryDates, value, fromMetric, derived,
  finalizeCell, buildWeeklyResults, buildWeeklyResultsWithProgress, buildDailyResultsWithProgress };
