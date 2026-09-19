const DAY = 86400000;
const { averageTicketWithVat } = require('./metric-policy');

function addDays(key, count) {
  return new Date(Date.parse(`${key}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10);
}

function weekday(key) { return new Date(`${key}T12:00:00Z`).getUTCDay(); }
function monthStart(key) { return `${key.slice(0, 7)}-01`; }
function previousMonthStart(key) { return monthStart(addDays(monthStart(key), -1)); }
function previousMonthEnd(key) { return addDays(monthStart(key), -1); }
function weekStart(key) { return addDays(key, -((weekday(key) + 6) % 7)); }
function daysBetween(from, to) {
  const output = [];
  for (let key = from; key <= to; key = addDays(key, 1)) output.push(key);
  return output;
}

function businessClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, cutoff: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function percentageChange(value, benchmark) {
  return Number.isFinite(value) && Number.isFinite(benchmark) && benchmark > 0
    ? (value - benchmark) / benchmark * 100 : null;
}

function emptyTotals() {
  return { sales: 0, cost: 0, discounts: 0, grossBeforeDiscount: 0, transactions: 0, costAvailable: true };
}

function aggregateNetworkMetrics(facts) {
  const totals = emptyTotals();
  for (const fact of facts) {
    totals.sales += fact.sales || 0;
    totals.cost += fact.cost || 0;
    totals.discounts += fact.discounts || 0;
    totals.grossBeforeDiscount += fact.grossBeforeDiscount || 0;
    totals.transactions += fact.transactions || 0;
    if (!fact.costAvailable) totals.costAvailable = false;
  }
  return {
    ...totals,
    marginPercent: totals.sales > 0 && totals.costAvailable ? (totals.sales - totals.cost) / totals.sales * 100 : null,
    discountPercent: totals.grossBeforeDiscount > 0 ? totals.discounts / totals.grossBeforeDiscount * 100 : null,
    averageTicket: averageTicketWithVat(totals.sales, totals.transactions)
  };
}

function buildNetworkSalesDashboard({ stores, facts, today, cutoff = '23:59:59' }) {
  const yesterday = addDays(today, -1);
  const currentMonday = weekStart(today);
  const previousMonday = addDays(currentMonday, -7);
  const previousSunday = addDays(currentMonday, -1);
  const currentMonthStart = monthStart(today);
  const previousMonthFirst = previousMonthStart(today);
  const previousMonthLast = previousMonthEnd(today);
  const byStore = new Map(stores.map(store => [store.id, []]));
  for (const fact of facts) if (byStore.has(fact.locationId)) byStore.get(fact.locationId).push(fact);
  const observedDates = new Map(stores.map(store => [store.id, new Set((byStore.get(store.id) || []).map(fact => fact.date))]));
  const firstObserved = new Map(stores.map(store => [store.id, [...observedDates.get(store.id)].sort()[0] || null]));
  const storeById = new Map(stores.map(store => [store.id, store]));
  function operates(store, date) {
    if (store.openingDate && date < store.openingDate) return false;
    if (!store.openingDate && firstObserved.get(store.id) && date < firstObserved.get(store.id)) return false;
    if (Array.isArray(store.operatingWeekdays) && store.operatingWeekdays.length) {
      return store.operatingWeekdays.includes(weekday(date));
    }
    return observedDates.get(store.id)?.has(date) || false;
  }
  function eligible(storeIds, date) { return storeIds.some(id => operates(storeById.get(id), date)); }
  function metrics(storeIds, dates, timeCutoff = null) {
    const dateSet = new Set(dates);
    return aggregateNetworkMetrics(storeIds.flatMap(id => (byStore.get(id) || []).filter(fact =>
      dateSet.has(fact.date) && (!timeCutoff || fact.date !== dates[dates.length - 1] || fact.time <= timeCutoff))));
  }
  function singleDate(storeIds, date, timeCutoff = null) { return metrics(storeIds, [date], timeCutoff); }
  function weekdayAverage(storeIds, date, timeCutoff = null) {
    const dates = Array.from({ length: 8 }, (_, index) => addDays(date, -(index + 1) * 7));
    if (!dates.every(key => eligible(storeIds, key))) return null;
    return dates.reduce((sum, key) => sum + singleDate(storeIds, key, timeCutoff).sales, 0) / 8;
  }
  function priorFourWeeksDailyAverage(storeIds) {
    const dates = daysBetween(addDays(yesterday, -28), addDays(yesterday, -1)).filter(date => eligible(storeIds, date));
    return dates.length ? dates.reduce((sum, date) => sum + singleDate(storeIds, date).sales, 0) / dates.length : null;
  }
  function priorEightWeeksAverage(storeIds) {
    const weeks = Array.from({ length: 8 }, (_, index) => addDays(previousMonday, -(index + 1) * 7));
    const dateGroups = weeks.map(monday => daysBetween(monday, addDays(monday, 6)));
    if (!dateGroups.every(dates => dates.some(date => eligible(storeIds, date)))) return null;
    return dateGroups.reduce((sum, dates) => sum + metrics(storeIds, dates).sales, 0) / 8;
  }
  function equivalentPreviousMonth(storeIds) {
    const lastDay = Number(previousMonthLast.slice(-2));
    const calendarEnd = `${previousMonthFirst.slice(0, 8)}${String(Math.min(Number(today.slice(-2)), lastDay)).padStart(2, '0')}`;
    const selected = [];
    for (const id of storeIds) {
      const store = storeById.get(id);
      const currentDays = daysBetween(currentMonthStart, today).filter(date => operates(store, date)).length;
      const priorDates = daysBetween(previousMonthFirst, previousMonthLast).filter(date => operates(store, date));
      const end = Array.isArray(store.operatingWeekdays) && store.operatingWeekdays.length && currentDays
        ? priorDates[Math.min(currentDays, priorDates.length) - 1] : calendarEnd;
      if (end) selected.push(...(byStore.get(id) || []).filter(fact => fact.date >= previousMonthFirst
        && fact.date <= end && (fact.date !== end || fact.time <= cutoff)));
    }
    return aggregateNetworkMetrics(selected).sales;
  }
  function row(storeIds, id, name) {
    const currentDay = singleDate(storeIds, today, cutoff);
    const previousDay = singleDate(storeIds, yesterday);
    const currentWeek = metrics(storeIds, daysBetween(currentMonday, today), cutoff);
    const previousWeek = metrics(storeIds, daysBetween(previousMonday, previousSunday));
    const previousWeekEquivalent = metrics(storeIds,
      daysBetween(previousMonday, addDays(previousMonday, (weekday(today) + 6) % 7)), cutoff);
    const currentMonth = metrics(storeIds, daysBetween(currentMonthStart, today), cutoff);
    const previousMonth = metrics(storeIds, daysBetween(previousMonthFirst, previousMonthLast));
    return {
      id, name,
      today: { ...currentDay,
        vsYesterday: percentageChange(currentDay.sales, singleDate(storeIds, yesterday, cutoff).sales),
        vsEquivalentDays: percentageChange(currentDay.sales, weekdayAverage(storeIds, today, cutoff)) },
      yesterday: { ...previousDay,
        vsEquivalentDays: percentageChange(previousDay.sales, weekdayAverage(storeIds, yesterday)),
        vsFourWeeks: percentageChange(previousDay.sales, priorFourWeeksDailyAverage(storeIds)) },
      currentWeek: { ...currentWeek,
        vsPreviousWeek: percentageChange(currentWeek.sales, previousWeekEquivalent.sales) },
      previousWeek: { ...previousWeek,
        vsEightWeeks: percentageChange(previousWeek.sales, priorEightWeeksAverage(storeIds)) },
      currentMonth: { ...currentMonth,
        vsPreviousMonth: percentageChange(currentMonth.sales, equivalentPreviousMonth(storeIds)) },
      previousMonth
    };
  }
  const rows = stores.map(store => row([store.id], store.id, store.name));
  return { today, cutoff, rows, total: row(stores.map(store => store.id), 'network', 'TOTAL RED') };
}

module.exports = { addDays, businessClock, percentageChange, aggregateNetworkMetrics, buildNetworkSalesDashboard };
