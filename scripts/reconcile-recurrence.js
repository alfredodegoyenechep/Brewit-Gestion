/* Read-only reconciliation against the local server. No provider requests. */
const fs = require('node:fs');
const base = process.env.BREWIT_LOCAL_URL || 'http://127.0.0.1:3000';
const output = process.argv[2];
async function get(route) {
  const start = performance.now(), response = await fetch(`${base}${route}`), data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${data.error}`);
  return { data, milliseconds: Math.round(performance.now() - start) };
}
(async () => {
  const result = { measuredAt: new Date().toISOString(), period: { from: '2026-10-01', to: '2026-10-25' }, scopes: {} };
  for (const location of ['store-2', 'store-1', 'all']) {
    const query = new URLSearchParams({ location, period: 'custom', dateFrom: result.period.from, dateTo: result.period.to });
    const legacy = await get(`/api/sales/dashboard?${new URLSearchParams({ location, customerDateFrom: result.period.from, customerDateTo: result.period.to })}`);
    const current = await get(`/api/sales/recurrence?${query}`), d = current.data, s = d.summary;
    const cached = await get(`/api/sales/recurrence?${query}`);
    const purchases = await get(`/api/sales/recurrence/${d.id}/purchases`), p = purchases.data;
    const exported = await get(`/api/sales/recurrence/${d.id}/export`);
    const payments = exported.data.paymentDetails, identifiable = payments.filter(p => p.classification !== 'unidentified');
    const sameDateRepeatPayments = identifiable.length - new Set(identifiable.map(p => `${p.alias}|${p.date}`)).size;
    const old = legacy.data.mercadoPago.metrics.custom;
    const firstDatesSeen = new Set(), repeatsOnFirstDate = identifiable.filter(p => { if (p.classification !== 'first') return false; const key = `${p.alias}|${p.date}`; if (firstDatesSeen.has(key)) return true; firstDatesSeen.add(key); return false; });
    result.scopes[location] = {
      label: d.scope.label, legacy: { ...old, previous: undefined },
      current: { payments: s.payments, identifiedPayments: s.identifiedPayments, active: s.active.value, returningInstruments: s.returning,
        purchaseDays: s.days, returnDays: s.returnDaysRate, returnAmount: s.returnAmountRate, totalAmount: s.totalAmount, identifiedAmount: s.identifiedAmount,
        unidentifiedAmount: s.unidentifiedAmount, firstAmount: s.firstAmount, firstObserved: s.firstObserved, knownBefore: s.knownBefore,
        sameDateRepeatPayments, repeatedPaymentsOnFirstDate: repeatsOnFirstDate.length, repeatedAmountOnFirstDate: repeatsOnFirstDate.reduce((n, p) => n + p.amount, 0), returnPayments: payments.filter(p => p.classification === 'return').length,
        return30: d.return30, lastCompleteDay: d.lastCompleteDay, asOf: d.asOf, status: s.status,
        coverage: { expectedDays: s.coverage.expectedDays, allLocationsCoveredDays: s.coverage.coveredDays, locals: s.coverage.locations.map(l => ({ location: l.locationId, coveredDays: l.coveredDays, missing: l.missing })) },
        diagnostics: d.quality.diagnostics, refunds: d.quality.refunds, warnings: d.warnings },
      purchases: { rows: p.rows, quality: p.quality, linkage: p.linkage, reasons: p.reasons, status: p.status,
        sample: p.details.filter(o => o.classification !== 'unclassified').slice(0, 3).map(o => ({ classification: o.classification, date: o.date, netSales: o.netSales, ticketGross: o.ticketGross, units: o.units, linkMethod: o.linkMethod, monetaryVerified: o.monetaryVerified })) },
      performance: { legacyMs: legacy.milliseconds, summaryMs: current.milliseconds, warmMs: cached.milliseconds, sameSnapshot: d.id === cached.data.id, purchasesMs: purchases.milliseconds, exportPayloadMs: exported.milliseconds }
    };
  }
  const a = result.scopes['store-1'].current, b = result.scopes['store-2'].current, chain = result.scopes.all.current;
  result.consolidation = { localActiveSum: a.active + b.active, chainActive: chain.active, overlapApproximateKeys: a.active + b.active - chain.active,
    localAmountsSum: a.totalAmount + b.totalAmount, chainAmount: chain.totalAmount };
  const json = JSON.stringify(result, null, 2);
  if (output) fs.writeFileSync(output, `${json}\n`); else process.stdout.write(`${json}\n`);
})().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
