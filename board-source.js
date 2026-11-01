'use strict';
const core = require('./board-report');
const recurrence = require('./recurrence');
const { previousDate } = require('./product-recurrence');
const { addDays } = require('./network-sales');
function createSource(io) {
  function options() {
    const locations = io.locations(); const today = io.today();
    const first = locations.filter(l => l.type === 'store').map(l => l.openingDate).filter(Boolean).sort()[0] || `${today.slice(0, 4)}-01-01`;
    const months = []; let month = first.slice(0, 7);
    while (month <= today.slice(0, 7) && months.length < 240) { months.push(month); const [y, m] = month.split('-').map(Number); month = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); }
    return { months: months.reverse(), today, locations: locations.filter(l => l.type === 'store').map(({ id, name, openingDate }) => ({ id, name, openingDate })), formula: '16 + 2 × cafeterías incluidas', rules: core.RULES };
  }
  async function generate(query, progress = () => {}) {
    const p = core.period(query.month), today = io.today();
    if (p.from > today) throw Object.assign(Error('El mes seleccionado todavía no comienza.'), { status: 400 });
    const fingerprint = io.fingerprint(), warnings = [], sources = [];
    const earliest = io.locations().filter(l => l.type === 'store').map(l => l.openingDate).filter(Boolean).sort()[0];
    const months = core.monthsThrough(p.month).filter(m => !earliest || m.to >= earliest);
    if (!months.some(m => m.month === p.previous)) months.unshift(core.period(p.previous));
    if (!months.some(m => m.month === p.month)) months.push(p);
    const from = months.map(m => m.from).sort()[0];
    progress('Leyendo ventas y asignaciones de género vigentes', 5);
    const sales = io.orders({ from, to: p.to });
    warnings.push(...sales.warnings); sources.push(...sales.sources);
    const coverage = io.coverage();
    const byMonth = []; let allFacts = [];
    for (let i = 0; i < months.length; i++) {
      const m = months[i]; progress(`Conciliando resultados de ${m.month}`, 10 + i / months.length * 28);
      let facts = [], financial = null;
      try { financial = io.financial(m, 'all', rows => { facts = rows; }, core.includedStores(io.locations(), m, sales.orders, io.expenses()).map(l => l.id)); warnings.push(...financial.warnings.map(w => `${m.month}: ${w}`)); }
      catch (e) { warnings.push(`${m.month}: resultados financieros no disponibles: ${e.message}`); }
      allFacts.push(...facts); byMonth.push({ m, facts, financial });
    }
    const locations = core.includedStores(io.locations(), p, allFacts, io.expenses());
    if (!locations.length) throw Object.assign(Error('No hay cafeterías operativas, ventas ni gastos en ese mes.'), { status: 400 });
    const currentOrders = sales.orders.filter(o => o.date >= from && o.date <= p.to);
    const recurrenceByScope = new Map();
    for (const [i, id] of ['all', ...locations.map(l => l.id)].entries()) {
      progress(`Identificando recurrencia ${id === 'all' ? 'de compañía' : locations.find(l => l.id === id).name}`, 40 + i / (locations.length + 1) * 10);
      try {
        const source = io.recurrence.readSource({ location: id });
        const state = recurrence.buildReport(source, { period: 'custom', dateFrom: from, dateTo: p.to });
        const orders = currentOrders.filter(o => id === 'all' || o.locationId === id);
        const purchase = recurrence.buildPurchases(state, orders, source.coverage);
        const links = new Map(purchase.details.map(r => [r.orderKey, r]));
        const histories = new Map([...state.histories.values()].map(h => [h.alias, h.dates]));
        const ages = new Map();
        for (const o of orders) { const linked = links.get(o.orderKey); const dates = linked && linked.classification !== 'unclassified' ? histories.get(linked.alias) : null;
          const prior = dates ? previousDate(dates, o.date) : null; ages.set(o.orderKey, { linked: !!dates, age: prior ? (Date.parse(o.date) - Date.parse(prior)) / 86400000 : null }); }
        recurrenceByScope.set(id, { ages, coverage: source.coverage, ids: source.locationIds });
        sources.push({ kind: 'Recurrencia', name: source.scope.label, version: io.recurrence.fingerprint({ location: id }).mp });
      } catch (e) { warnings.push(`Recurrencia ${id}: ${e.message}`); }
    }
    function recurrent(id, m, facts) {
      const data = recurrenceByScope.get(id); if (!data) return null;
      const net = core.sum(facts, 'netSales'); let linked = 0; const amounts = { 30: 0, 60: 0, 90: 0 };
      for (const f of facts) { const item = data.ages.get(f.orderKey); if (item?.linked) linked += f.netSales; for (const d of [30, 60, 90]) if (item?.age >= 1 && item.age <= d) amounts[d] += f.netSales; }
      const ids = id === 'all' ? core.includedStores(io.locations(), m, allFacts, io.expenses()).map(l => l.id) : data.ids;
      const history = recurrence.coverageFor(data.coverage, ids, addDays(m.from, -90), m.to);
      const payments = recurrence.coverageFor(data.coverage, ids, m.from, m.to, 'payment-details');
      return { amounts, p30: core.pct(amounts[30], net), p60: core.pct(amounts[60], net), p90: core.pct(amounts[90], net), denominator: net, linkedSales: linked, coverage: core.pct(linked, net), complete: history.complete && payments.complete, history, payments };
    }
    function summary(id, data, financial = data.financial) {
      const facts = data.facts.filter(f => id === 'all' || f.locationId === id);
      const ids = id === 'all' ? core.includedStores(io.locations(), data.m, data.facts, io.expenses()).map(l => l.id) : [id];
      const result = core.summarize(data.m, facts, currentOrders.filter(o => id === 'all' || o.locationId === id), financial, recurrent(id, data.m, facts), recurrence.coverageFor(coverage, ids, data.m.from, data.m.to, 'sales'));
      if (!facts.length && !result.salesCoverage.complete) { result.netSales = null; result.units = null; result.extraUnits = null; result.metrics.netSales.value = null; }
      if (financial && Math.abs((financial.statement.netSales || 0) - (result.netSales || 0)) > .01) throw Error(`No concilia venta financiera ${id} / ${data.m.month}.`);
      return result;
    }
    const summaries = byMonth.map(d => summary('all', d)); const storeReports = [];
    for (const [i, l] of locations.entries()) {
      progress(`Preparando las dos fichas de ${l.name}`, 52 + i / locations.length * 15);
      const values = [];
      for (const m of [p.month, p.previous]) {
        const data = byMonth.find(d => d.m.month === m) || { m: core.period(m), facts: [] }; let financial = null;
        try { financial = io.financial(data.m, l.id); } catch (e) { warnings.push(`${l.name} / ${m}: ${e.message}`); }
        values.push(summary(l.id, data, financial));
      }
      storeReports.push({ id: l.id, name: l.name, openingDate: l.openingDate, current: values[0], previous: values[1], comparable: (!l.openingDate || l.openingDate <= `${p.previous}-01`) && values.every(v => v.salesCoverage.complete), newOpening: l.openingDate?.slice(0, 7) === p.month });
    }
    progress('Valorando inventario y referencias de compras al cierre', 68);
    const inventory = io.inventory(locations, p, warnings), purchaseRows = io.purchases(from, p.to, warnings);
    const purchases = [...new Set(purchaseRows.map(r => r.code))].map(code => {
      const rows = purchaseRows.filter(r => r.code === code), current = rows.filter(r => r.date >= p.from), previous = rows.filter(r => r.date < p.from && r.date >= `${p.previous}-01`);
      // Compare like-for-like base units and locations; never average percentage changes.
      const refs = new Map(); for (const r of rows.filter(r => r.baseUnitCost > 0).sort((a, b) => a.date.localeCompare(b.date))) { const key = `${r.locationId}|${r.baseUnit}`; const ref = refs.get(key) || {}; if (r.date <= core.period(p.previous).to) ref.previous = r; if (r.date <= p.to) ref.current = r; refs.set(key, ref); }
      return { code, name: rows[0]?.product || code, amount: core.sum(current, 'totalAmount'), previousAmount: core.sum(previous, 'totalAmount'), references: [...refs.values()].map(r => ({ location: r.current?.locationName || r.current?.locationId, unit: r.current?.baseUnit, current: r.current?.baseUnitCost, date: r.current?.date, previous: r.previous?.baseUnitCost ?? null, changePercent: r.previous && r.current ? core.delta(r.current.baseUnitCost, r.previous.baseUnitCost) : null })) };
    }).sort((a, b) => b.amount - a.amount || a.code.localeCompare(b.code));
    const currentFacts = byMonth.find(d => d.m.month === p.month)?.facts || [];
    const { ingredients, theoretical } = io.recipeEvidence(p, locations, currentFacts, warnings);
    const clusters = {};
    for (const [i, id] of ['all', ...locations.map(l => l.id)].entries()) {
      progress(`Analizando clusters ${id === 'all' ? 'de compañía' : locations.find(l => l.id === id).name}`, 75 + i / (locations.length + 1) * 18);
      try { const engine = require('./sales-clusters'); const dimensions = Object.fromEntries(Object.entries(engine.DEFAULT_DIMENSIONS).map(([k, v]) => [k, { ...v, ...(k === 'gender' ? { enabled: true } : {}) }]));
        const orders = currentOrders.filter(o => o.date >= p.from && o.date <= p.to && (id === 'all' || o.locationId === id)).map(o => ({ ...o, time: o.timeKnown === false ? '' : o.time, orderDiscount: o.orderDiscountKnown === false ? null : o.orderDiscount }));
        const { result } = engine.runAnalysis({ orders, period: p, sourceFingerprint: fingerprint, seed: `${fingerprint}:${id}:${p.month}`, recurrenceResolved: true, config: { filters: { locations: id, mode: 'custom', dateFrom: p.from, dateTo: p.to }, dimensions } }, e => progress(`${id}: ${e.message}`, 75 + i / (locations.length + 1) * 18));
        clusters[id] = { summary: result.summary, validation: result.validation, coverage: result.coverage, clusters: result.clusters.map(({ representative, examples, ...r }) => r), version: engine.VERSION };
      } catch (e) { clusters[id] = { error: e.message, clusters: [] }; warnings.push(`Clusters ${id}: ${e.message}`); }
    }
    if (io.fingerprint() !== fingerprint) throw Object.assign(Error('Las fuentes cambiaron durante el cálculo. Genera otra vez para guardar un cierre coherente.'), { status: 409 });
    const result = core.assemble({ month: p.month, locations: locations.map(({ id, name, openingDate }) => ({ id, name, openingDate })), months: summaries, stores: storeReports, inventory, purchases, ingredients, theoretical, clusters, sourceVersion: fingerprint, sources, warnings });
    progress('Diseñando diapositivas y archivos del cierre', 95); return result;
  }
  return { options, generate, fingerprint: io.fingerprint };
}
module.exports = { createSource };
