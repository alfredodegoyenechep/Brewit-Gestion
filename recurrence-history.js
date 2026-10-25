/* Rolling purchase history. Same-day payments never establish a previous visit. */
const r = require('./recurrence');
const { addDays } = require('./network-sales');
const { daysBetween } = require('./transaction-linkage');
const WINDOWS = [30, 60, 90, 180];
const VERSION = 'mp-rolling-purchase-history-v1';
const round = value => Number(value.toFixed(1));
const bucket = (period, extra = {}) => ({ ...period, ...extra, amount: 0, identifiedAmount: 0, payments: 0,
  windows: Object.fromEntries(WINDOWS.map(h => [h, { days: h, numerator: 0 }])) });
function monthPeriods(asOf) {
  const end = asOf.slice(0, 10);
  return Array.from({ length: 12 }, (_, i) => {
    const from = r.monthOffset(end, i - 11), calendarEnd = addDays(r.monthOffset(from, 1), -1);
    return { month: from.slice(0, 7), from, to: calendarEnd < end ? calendarEnd : end,
      partialMonth: calendarEnd >= end && (calendarEnd > end || asOf.slice(11) < '23:59:59') };
  });
}
function metric(row, horizon, coverage, ids, partial) {
  const from = addDays(row.from, -horizon), current = r.coverageFor(coverage, ids, row.from, row.to);
  const lookback = r.coverageFor(coverage, ids, from, row.to);
  const denominator = row.amount;
  const status = !denominator ? current.complete ? 'no_activity' : 'no_data'
    : partial || row.partialMonth || !lookback.complete ? 'partial' : 'complete';
  return { ...row.windows[horizon], denominator, value: denominator ? round(row.windows[horizon].numerator / denominator * 100) : null,
    status, population: 'Importe total MP observado en el destino, incluidos pagos no identificables',
    historyFrom: from, historyTo: row.to, coveredDays: lookback.coveredDays, expectedDays: lookback.expectedDays,
    reason: !denominator ? current.complete ? 'Sin operaciones' : 'Sin datos acreditados' : !lookback.complete ? 'Historial incompleto: porcentaje observado provisional' : partial ? 'Validación de pagos o identidad parcial' : row.partialMonth ? 'Mes hasta el corte del reporte' : null };
}
function finish(row, coverage, ids, partial) {
  return { ...row, windows: Object.fromEntries(WINDOWS.map(h => [h, metric(row, h, coverage, ids, partial)])) };
}
function aggregate(rows, period, coverage, ids, partial, extra = {}) {
  const row = bucket(period, extra);
  for (const item of rows) {
    row.amount += item.amount; row.identifiedAmount += item.identifiedAmount; row.payments += item.payments;
    for (const h of WINDOWS) row.windows[h].numerator += item.windows[h].numerator;
  }
  return finish(row, coverage, ids, partial);
}
function buildHistory({ payments, coverage, locations, destinationIds, asOf, partial = false, network = false, warnings = [] }) {
  const periods = monthPeriods(asOf), byMonth = new Map(periods.map(p => [p.month, bucket(p)]));
  const destinations = locations.filter(l => destinationIds.includes(l.id));
  const destinationRows = new Map(destinations.map(l => [l.id, new Map(periods.map(p => [p.month, bucket(p, { destinationId: l.id, destination: l.name })]))]));
  const origins = new Map();
  if (network) for (const destination of destinations) for (const origin of locations.filter(l => l.id !== destination.id)) for (const period of periods) {
    origins.set(`${period.month}|${destination.id}|${origin.id}`, bucket(period, { destinationId: destination.id, destination: destination.name, originId: origin.id, origin: origin.name }));
  }
  const latest = new Map(), sorted = payments.filter(p => p.dateTime <= asOf).sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].date === sorted[start].date) end++;
    // Read yesterday's history for the entire local date before updating any location.
    for (let i = start; i < end; i++) {
      const p = sorted[i], monthly = byMonth.get(p.date.slice(0, 7)), local = destinationRows.get(p.locationId)?.get(p.date.slice(0, 7));
      if (!monthly || !local) continue;
      const previous = p.instrumentKey ? latest.get(p.instrumentKey) : null;
      const ages = previous ? [...previous].filter(([location]) => !network || location !== p.locationId).map(([location, day]) => ({ location, age: daysBetween(day, p.date) })) : [];
      for (const row of [monthly, local]) {
        row.amount += p.amount; row.payments++; if (p.instrumentKey) row.identifiedAmount += p.amount;
        for (const h of WINDOWS) if (ages.some(a => a.age >= 1 && a.age <= h)) row.windows[h].numerator += p.amount;
      }
      if (network) for (const origin of locations.filter(l => l.id !== p.locationId)) {
        const row = origins.get(`${p.date.slice(0, 7)}|${p.locationId}|${origin.id}`); if (!row) continue;
        row.amount += p.amount; row.payments++; if (p.instrumentKey) row.identifiedAmount += p.amount;
        const age = ages.find(a => a.location === origin.id)?.age;
        for (const h of WINDOWS) if (age >= 1 && age <= h) row.windows[h].numerator += p.amount;
      }
    }
    for (let i = start; i < end; i++) {
      const p = sorted[i]; if (!p.instrumentKey) continue;
      const entry = latest.get(p.instrumentKey) || new Map(); entry.set(p.locationId, p.date); latest.set(p.instrumentKey, entry);
    }
    start = end;
  }
  const ids = network ? locations.map(l => l.id) : destinationIds;
  const period = { from: periods[0].from, to: asOf.slice(0, 10), partialMonth: periods.at(-1).partialMonth };
  const rows = [...byMonth.values()].map(row => finish(row, coverage, ids, partial));
  return { kind: network ? 'network' : 'monthly', definitionVersion: VERSION, keyVersion: r.KEY_VERSION,
    asOf, period, windows: WINDOWS, denominator: 'total-mp', locations, destinationIds,
    monetaryBasis: 'Importe cobrado MP observado; no equivale a toda la venta ni a venta neta sin IVA.',
    definition: 'Para cada pago, buscar al menos una fecha anterior, desde fecha−h hasta fecha−1 inclusive. Las ventanas son acumulativas y no se suman.',
    warnings: [...new Set(warnings)], coverage,
    rows, totals: aggregate(rows, period, coverage, ids, partial),
    destinations: network ? destinations.map(location => {
      const values = [...destinationRows.get(location.id).values()].map(row => finish(row, coverage, ids, partial));
      return { ...location, rows: values, totals: aggregate(values, period, coverage, ids, partial) };
    }) : [],
    origins: [...origins.values()].map(row => finish(row, coverage, ids, partial)),
    originTotals: network ? destinations.flatMap(destination => locations.filter(l => l.id !== destination.id).map(origin => {
      const selected = [...origins.values()].filter(row => row.destinationId === destination.id && row.originId === origin.id);
      return aggregate(selected, period, coverage, ids, partial, { destinationId: destination.id, destination: destination.name, originId: origin.id, origin: origin.name });
    })) : [] };
}
function monthlyHistory(state, coverage) {
  return buildHistory({ payments: state.payments, coverage, locations: state.report.scope.locations,
    destinationIds: state.report.locationIds, asOf: state.report.asOf, partial: state.report.eligibilityPartial,
    warnings: state.report.warnings });
}
function networkHistory(source, report) {
  // Freeze the destination's cutoff and use the same normalization/secret in every branch.
  const asOf = r.effectiveCutoff(source.coverage, source.locationIds, report.asOf);
  const normalized = r.normalizePayments(source.records, { secret: source.secret, locationIds: source.locationIds, until: asOf.slice(0, 10) });
  const accounts = new Set(normalized.payments.map(p => p.namespace));
  const identityPartial = normalized.diagnostics.missingAccount > 0 || accounts.size > 1;
  const partial = identityPartial || normalized.diagnostics.missingStatus > 0 || normalized.diagnostics.unknownRefunds > 0
    || Boolean(normalized.diagnostics.excluded['missing-identity-date-or-amount']) || Boolean(source.warnings?.length);
  return buildHistory({ payments: normalized.payments, coverage: source.coverage, locations: source.scope.locations,
    destinationIds: report.locationIds, asOf, partial, network: true,
    warnings: [...(source.warnings || []), 'Cruce aproximado por instrumento de pago; no representa personas únicas.',
      ...(identityPartial ? ['La identidad entre cuentas no está acreditada. Los cruces entre cafeterías son provisionales.'] : [])] });
}
module.exports = { WINDOWS, VERSION, monthPeriods, monthlyHistory, networkHistory };
