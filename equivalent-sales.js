const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();

function salesCalendar(stores, facts) {
  const observed = new Map(stores.map(store => [store.id, new Set()]));
  for (const fact of facts) observed.get(fact.locationId)?.add(fact.date);
  const firstObserved = new Map(stores.map(store => [store.id, [...observed.get(store.id)].sort()[0] || null]));
  const storeById = new Map(stores.map(store => [store.id, store]));
  function operates(store, date) {
    if (store.openingDate && date < store.openingDate) return false;
    if (!store.openingDate && firstObserved.get(store.id) && date < firstObserved.get(store.id)) return false;
    if (Array.isArray(store.operatingWeekdays) && store.operatingWeekdays.length) return store.operatingWeekdays.includes(weekday(date));
    return observed.get(store.id)?.has(date) || false;
  }
  return { operates, eligible: (ids, date) => ids.some(id => operates(storeById.get(id), date)),
    knownDay: (ids, date) => ids.some(id => observed.get(id)?.has(date) || operates(storeById.get(id), date)) };
}

function equivalentDayComparison({ date, storeIds, calendar, salesAt, cutoff = null }) {
  const dates = Array.from({ length: 8 }, (_, index) => addDays(date, -(index + 1) * 7));
  const availableDates = dates.filter(day => calendar.eligible(storeIds, day));
  const complete = availableDates.length === 8;
  const samples = dates.map(day => ({ date: day, sales: availableDates.includes(day) ? salesAt(day, cutoff) : null }));
  return { dates, availableDates, sampleSize: availableDates.length, complete, referenceAvailable: calendar.knownDay(storeIds, date), cutoff: cutoff || '23:59:59',
    samples, average: complete ? samples.reduce((sum, sample) => sum + sample.sales, 0) / 8 : null };
}

module.exports = { salesCalendar, equivalentDayComparison };
