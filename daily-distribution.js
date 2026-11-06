const timeline = require('./product-timeline');
const { addDays } = require('./network-sales');
const VERSION = 'daily-distribution-v1';
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const weekday = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const round = value => Number(value.toFixed(2));
function buildReport(input) {
  const { period, locationIds, query = {} } = input;
  // Establish opening dates from the whole selected cafeteria/network, before
  // applying product, ingredient, hierarchy, bar or format filters.
  const orders = input.orders.filter(order => locationIds.includes(order.locationId) && order.date >= period.from && order.date <= period.to
    && !(query.serverToday === order.date && order.dateTime && order.dateTime > `${order.date}T${query.serverCutoff || '23:59:59'}`));
  const dailySales = new Map();
  for (const order of orders) {
    let amount = order.netSales;
    if (!Number.isFinite(amount)) {
      const lines = (order.lines || []).filter(line => !line.isComponent && !line.parentLineId);
      const amounts = lines.map(line => Object.hasOwn(line, 'productNetSales') ? line.productNetSales : line.netSales);
      amount = amounts.length && amounts.every(Number.isFinite) ? amounts.reduce((sum, value) => sum + value, 0) : null;
    }
    const day = dailySales.get(order.date) || { netSales: 0, missing: false };
    if (Number.isFinite(amount)) day.netSales += amount; else day.missing = true;
    dailySales.set(order.date, day);
  }
  const activeDates = new Set([...dailySales].filter(([, value]) => !value.missing && Math.round(value.netSales * 100) !== 0).map(([date]) => date));
  const unknownDates = new Set([...dailySales].filter(([, value]) => value.missing).map(([date]) => date));
  const sample = { calendarDays: 0, observedDays: activeDates.size, excludedDays: 0, unknownDays: unknownDates.size, dates: [...activeDates].sort() };
  const days = DAYS.map((label, index) => ({ key: String(index), weekday: index, label, calendarDays: 0, observedDays: 0, excludedDays: 0, unknownDays: 0, dates: [], units: 0, netSales: 0, missingSales: 0 }));
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
    const day = days[weekday(date)]; day.calendarDays++; sample.calendarDays++;
    if (activeDates.has(date)) { day.observedDays++; day.dates.push(date); }
    else if (unknownDates.has(date)) day.unknownDays++;
    else { day.excludedDays++; sample.excludedDays++; }
  }
  const report = timeline.buildReport({ ...input, orders: orders.filter(order => activeDates.has(order.date)), query: { ...query, grain: 'daily' },
    bucketConfig: { buckets: days, byDate: new Map([...activeDates].map(date => [date, weekday(date)])) } });
  const average = (totals, count) => ({ ...totals, totalUnits: totals.units, totalNetSales: totals.netSales,
    units: count ? round(totals.units / count) : null, netSales: count && totals.netSales !== null ? round(totals.netSales / count) : null });
  const accumulate = points => points.map((point, index) => average({ ...point, observedDays: days[index].observedDays }, days[index].observedDays));
  const { grain, ...filters } = report.filters;
  return { ...report, definitionVersion: VERSION, filters,
    periods: accumulate(report.periods),
    series: report.series.map(series => ({ ...average(series, sample.observedDays), points: accumulate(series.points) })),
    totals: average(report.totals, sample.observedDays), sample,
    definition: 'Promedio diario de lunes a domingo: venta neta o unidades de la selección, divididas por las fechas de ese día de la semana con venta total registrada distinta de cero en la cafetería elegida. Todas las cafeterías suma la red por fecha y cuenta cada fecha una sola vez. La muestra se determina antes de filtrar productos, ingredientes, jerarquías o barra: un día con venta del local y sin venta del producto seleccionado aporta cero. Las fechas sin venta total se excluyen; un día de la semana sin fechas válidas se muestra sin promedio (—). El promedio del período divide por todas las fechas válidas, sin sumar ni promediar los siete promedios. Venta neta después de descuentos, sin IVA; las recetas y subrecetas se resuelven en la fecha de venta, sin duplicar coincidencias.',
    warnings: [...report.warnings, ...(sample.unknownDays ? [`${sample.unknownDays} fecha(s) con importe total incompleto se excluyeron de la base del promedio; no se clasifican como días sin venta.`] : [])] };
}
module.exports = { VERSION, DAYS, weekday, buildReport };
