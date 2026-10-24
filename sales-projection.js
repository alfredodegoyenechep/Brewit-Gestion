// Shared calculation for the saved sales calendar and its closure preview.
(function (root) {
  const REFERENCE_DAYS = [2, 4, 6, 8];
  const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
  const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const shiftMonth = (date, count) => {
    const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + count);
    return value.toISOString().slice(0, 10);
  };
  const nextMonth = date => shiftMonth(date, 1);
  const variation = (value, previous) => previous > 0 ? (value - previous) / previous * 100 : null;

  function applyClosures(projection, closures = {}) {
    const closedByStore = new Map(projection.stores.map(store => [store.id, new Set(closures.locations?.[store.id] || [])]));
    const months = [];
    for (const month of projection.months) {
      const days = month.days.map(day => {
        if (day.isActual) return day;
        const locations = projection.stores.map(store => ({
          id: store.id, name: store.name,
          estimate: projection.baselines[store.id][weekday(day.date)].average,
          closed: closedByStore.get(store.id).has(day.date)
        }));
        const sum = rows => rows.reduce((total, item) => total + (item.estimate ?? 0), 0);
        const open = locations.filter(item => !item.closed);
        return { ...day, locations, forecast: sum(locations), includedForecast: sum(open),
          excludedForecast: sum(locations.filter(item => item.closed)),
          closedAll: locations.length > 0 && !open.length };
      });
      const realAccumulated = days.reduce((sum, day) => sum + (day.isActual ? day.actualSales : 0), 0);
      const projectedRemaining = days.reduce((sum, day) => sum + (day.isActual ? 0 : day.includedForecast), 0);
      const projectedTotal = realAccumulated + projectedRemaining;
      const previousProjection = months.find(item => item.key === month.previousMonthKey);
      const projectedComparisonValue = previousProjection ? previousProjection.projectedTotal : month.previousMonthClose;
      months.push({ ...month, days, realAccumulated, projectedRemaining, projectedTotal,
        realVariationPercent: month.previousPeriodTo ? variation(realAccumulated, month.previousPeriodSales) : null,
        projectedComparisonValue, projectedComparisonIsForecast: Boolean(previousProjection),
        projectedVariationPercent: variation(projectedTotal, projectedComparisonValue) });
    }
    return { ...projection, months, closures };
  }

  function applyReferenceDays(projection, referenceDays, closures = projection.closures || {}) {
    if (!REFERENCE_DAYS.includes(referenceDays)) throw new RangeError('Selecciona 2, 4, 6 u 8 días equivalentes.');
    const baselines = Object.fromEntries(Object.entries(projection.baselines).map(([id, weekdays]) => [id,
      weekdays.map(reference => {
        const usedSamples = reference.samples.slice(0, referenceDays).filter(sample => sample.netSales > 0);
        return { ...reference, usedSamples,
          average: usedSamples.length ? usedSamples.reduce((sum, sample) => sum + sample.netSales, 0) / usedSamples.length : 0 };
      })]));
    return applyClosures({ ...projection, baselines, referenceDays }, closures);
  }

  function buildSalesProjection({ stores, dailySales, today, closures = {}, referenceDays = 4 }) {
    const storeIds = new Set(stores.map(store => store.id));
    const byStore = new Map(stores.map(store => [store.id, new Map()]));
    for (const item of dailySales) {
      // Today's partial sales and future rows must never become historical references.
      if (!storeIds.has(item.locationId) || item.date >= today || !Number.isFinite(item.netSales)) continue;
      const days = byStore.get(item.locationId);
      days.set(item.date, (days.get(item.date) || 0) + item.netSales);
    }
    const baselines = Object.fromEntries(stores.map(store => [store.id, Array.from({ length: 7 }, (_, day) => {
      const distance = (weekday(today) - day + 7) % 7 || 7;
      const latest = addDays(today, -distance);
      // Keep eight exact calendar dates so changing the selector needs no new sales read.
      const samples = Array.from({ length: 8 }, (_, index) => {
        const date = addDays(latest, -index * 7);
        return { date, netSales: byStore.get(store.id).get(date) || 0 };
      });
      return { samples };
    })]));
    const sumSales = (from, to) => {
      let sum = 0;
      for (let date = from; date <= to; date = addDays(date, 1)) {
        for (const store of stores) sum += byStore.get(store.id).get(date) || 0;
      }
      return sum;
    };
    const first = `${today.slice(0, 7)}-01`;
    const months = [first, nextMonth(first)].map(from => {
      const to = addDays(nextMonth(from), -1), days = [];
      for (let date = from; date <= to; date = addDays(date, 1)) {
        days.push({ date, isActual: date < today,
          actualSales: date < today ? stores.reduce((sum, store) => sum + (byStore.get(store.id).get(date) || 0), 0) : null });
      }
      const previousFrom = shiftMonth(from, -1), previousTo = addDays(from, -1);
      const realDays = days.filter(day => day.isActual).length;
      const previousPeriodTo = realDays ? addDays(previousFrom, Math.min(realDays, Number(previousTo.slice(-2))) - 1) : null;
      return { key: from.slice(0, 7), from, to, days,
        previousMonthKey: previousFrom.slice(0, 7), previousMonthClose: sumSales(previousFrom, previousTo),
        previousPeriodFrom: previousFrom, previousPeriodTo,
        previousPeriodSales: previousPeriodTo ? sumSales(previousFrom, previousPeriodTo) : 0 };
    });
    return applyReferenceDays({ today, stores: stores.map(({ id, name }) => ({ id, name })), baselines, months }, referenceDays, closures);
  }

  const api = { buildSalesProjection, applyClosures, applyReferenceDays, REFERENCE_DAYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrewitSalesProjectionModel = api;
})(typeof window === 'object' ? window : globalThis);
