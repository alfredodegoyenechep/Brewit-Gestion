'use strict';
// Deterministic aggregates. Amounts remain unrounded until presentation.
const { productIdentity } = require('./product-report');
const { genderForOrder } = require('./product-gender');
const { accompanimentCategory } = require('./product-xray');
const VERSION = 'board-monthly-v1';
const RULES = Object.freeze({ version: 'board-rules-v1', productChange: 10, productImpact: .5, productUnits: 20, costChange: 5, points: 2, recurrencePoints: 3, genderCoverage: 50, genderOrders: 100 });
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const pct = (n, d) => Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d * 100 : null;
const delta = (n, d) => d > 0 ? (n - d) / d * 100 : null;
function period(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(Error('Selecciona un mes válido.'), { status: 400 });
  const [y, m] = month.split('-').map(Number);
  return { month, from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), previous: new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7) };
}
function monthsThrough(month) { const p = period(month); return Array.from({ length: Number(month.slice(5)) }, (_, i) => `${month.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`).map(period); }
function includedStores(locations, p, facts, expenses = []) {
  return locations.filter(l => l.type === 'store' && ((l.openingDate && l.openingDate <= p.to && (!l.closingDate || l.closingDate >= p.from)) || facts.some(f => f.locationId === l.id && f.date >= p.from && f.date <= p.to) || expenses.some(e => e.locationId === l.id && e.month === p.month && (e.values ? Object.values(e.values).some(v => Number.isFinite(Number(v)) && Number(v) !== 0) : Number(e.amount) !== 0 && e.amount != null)))).sort((a, b) => (a.openingDate || '9999').localeCompare(b.openingDate || '9999') || a.id.localeCompare(b.id));
}
function band(order) {
  if (order.timeKnown === false || !Number.isFinite(order.hour)) return 'Sin hora';
  const h = order.hour; if (h < 7) return 'Antes de 07';
  const from = 7 + 2 * Math.floor((h - 7) / 2); return `${String(from).padStart(2, '0')}–${String((from + 2) % 24).padStart(2, '0')}`;
}
function metric(value, unit, denominator, coverage, evidence) { return { value: Number.isFinite(value) ? value : null, unit, denominator, coverage, evidence }; }
function groups(facts, keyFn) {
  const map = new Map(); for (const f of facts) { const key = keyFn(f); const row = map.get(key) || { key, name: key, netSales: 0, units: 0, cost: 0, costComplete: true }; row.netSales += f.netSales; row.units += f.quantity; row.cost += f.totalCost || 0; row.costComplete &&= f.costAvailable !== false; map.set(key, row); }
  return [...map.values()].map(r => ({ ...r, cost: r.costComplete ? r.cost : null, margin: r.costComplete ? r.netSales - r.cost : null, marginPercent: r.costComplete ? pct(r.netSales - r.cost, r.netSales) : null, unitCost: r.costComplete && r.units > 0 ? r.cost / r.units : null })).sort((a, b) => b.netSales - a.netSales || a.key.localeCompare(b.key));
}
function compare(rows, previous) { const map = new Map(previous.map(r => [r.key, r])); const now = new Map(rows.map(r => [r.key, r])); return [...new Set([...now.keys(), ...map.keys()])].map(key => { const a = now.get(key) || { key, name: key, netSales: 0, units: 0 }, b = map.get(key); return { ...a, previous: b?.netSales ?? 0, previousUnits: b?.units || 0, change: a.netSales - (b?.netSales || 0), changePercent: delta(a.netSales, b?.netSales || 0), new: !b || b.netSales === 0, previousCost: b?.unitCost ?? null, costChangePercent: a.unitCost != null && b?.unitCost > 0 ? delta(a.unitCost, b.unitCost) : null }; }); }
function summarize(p, facts, orders, financial, recurrence, salesCoverage) {
  const net = sum(facts, 'netSales'), orderFacts = new Map();
  for (const f of facts) { const rows = orderFacts.get(f.orderKey) || []; rows.push(f); orderFacts.set(f.orderKey, rows); }
  const matched = orders.filter(o => orderFacts.has(o.orderKey));
  const positive = matched.filter(o => sum(orderFacts.get(o.orderKey), 'netSales') > 0 && o.lines.some(l => l.quantity > 0 && l.netSales > 0));
  const tickets = positive.map(o => sum(orderFacts.get(o.orderKey), 'netSales') * 1.19).sort((a, b) => a - b);
  const gross = tickets.reduce((a, b) => a + b, 0), median = tickets.length ? (tickets[Math.floor((tickets.length - 1) / 2)] + tickets[Math.floor(tickets.length / 2)]) / 2 : null;
  const gender = ['masculine', 'feminine', 'unattributable', 'missing'].map(key => ({ key, name: { masculine: 'Masculino', feminine: 'Femenino', unattributable: 'No atribuible', missing: 'Sin información' }[key], netSales: 0, units: 0, orders: 0 }));
  const gmap = new Map(gender.map(r => [r.key, r])); let knownOrders = 0, units = 0, bakery = 0, sandwich = 0, both = 0, either = 0;
  const hours = new Map(), days = new Map(), heat = new Map(), productPrices = new Map(), ticketPrices = new Map();
  let discounts = 0, discountedOrders = 0, discountCovered = 0, coveredGross = 0;
  for (const o of matched) { const g = genderForOrder(o); gmap.get(g === 'unknown' ? o.genderAmbiguous ? 'unattributable' : 'missing' : g).netSales += sum(orderFacts.get(o.orderKey), 'netSales'); }
  const matchedKeys = new Set(matched.map(o => o.orderKey));
  gmap.get('missing').netSales += sum(facts.filter(f => !matchedKeys.has(f.orderKey)), 'netSales');
  for (const o of positive) {
    const fs = orderFacts.get(o.orderKey), g = genderForOrder(o), row = gmap.get(g === 'unknown' ? o.genderAmbiguous ? 'unattributable' : 'missing' : g);
    const valid = o.lines.filter(l => l.quantity > 0 && l.netSales > 0), count = sum(valid.filter(l => !l.isExtra && !l.extraHierarchyId), 'quantity');
    row.units += count; row.orders++; units += count; if (g !== 'unknown') knownOrders++;
    const hasB = valid.some(l => !l.isExtra && accompanimentCategory(l) === 'bakery'), hasS = valid.some(l => !l.isExtra && accompanimentCategory(l) === 'sandwich');
    bakery += Number(hasB); sandwich += Number(hasS); both += Number(hasB && hasS); either += Number(hasB || hasS);
    const amount = sum(fs, 'netSales'), h = band(o), day = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][new Date(`${o.date}T12:00:00Z`).getUTCDay()];
    for (const [map, key] of [[hours, h], [days, day], [heat, `${day}|${h}`]]) map.set(key, (map.get(key) || 0) + amount);
    const ticketBin = Math.floor(amount * 1.19 / 500) * 500; ticketPrices.set(ticketBin, (ticketPrices.get(ticketBin) || 0) + 1);
    for (const l of fs.filter(l => l.quantity > 0 && l.netSales > 0 && !l.extraHierarchyId && !l.code?.startsWith('BX'))) { const bin = Math.floor(l.netSales * 1.19 / l.quantity / 500) * 500; productPrices.set(bin, (productPrices.get(bin) || 0) + l.quantity); }
    if (o.orderDiscountKnown !== false && Number.isFinite(o.orderDiscount)) { const d = Math.abs(o.orderDiscount); discounts += d; discountedOrders += Number(d > .01); discountCovered++; coveredGross += amount * 1.19; }
  }
  const costComplete = facts.length > 0 && facts.every(f => f.costAvailable), cost = costComplete ? sum(facts, 'totalCost') : null;
  const margin = cost == null ? null : net - cost, knownSales = gender[0].netSales + gender[1].netSales;
  const evidence = `Resultados financieros / ${p.month}`, coverage = salesCoverage?.complete ? 'complete' : 'partial';
  const distribution = map => [...map].map(([key, value]) => ({ key, name: key, netSales: value, percent: pct(value, gross / 1.19) }));
  const histogram = map => [...map].sort((a, b) => a[0] - b[0]).map(([from, count]) => ({ from, to: from + 500, count, percent: pct(count, [...map.values()].reduce((a, b) => a + b, 0)) }));
  const products = groups(facts.filter(f => !f.extraHierarchyId && !f.code?.startsWith('BX')), f => productIdentity({ ...f, categoryPath: f.hierarchyPath }, true).name);
  const hierarchies = groups(facts, f => f.extraHierarchyId || f.code?.startsWith('BX') ? 'Extras y adicionales' : (f.hierarchyPath?.filter(n => !/^(todos|todas las jerarquías)$/i.test(n)).slice(0, 2).join(' / ') || 'Sin jerarquía'));
  const metricCatalog = { netSales: metric(net, 'CLP neto', null, coverage, evidence), cost: metric(cost, 'CLP neto', null, costComplete ? coverage : 'missing-cost', evidence), margin: metric(margin, 'CLP neto', net, costComplete ? coverage : 'missing-cost', evidence), marginPercent: metric(pct(margin, net), '%', net, costComplete ? coverage : 'missing-cost', evidence), gender: gender.map(g => ({ key: g.key, sales: metric(g.netSales, 'CLP neto', net, coverage, 'Asignación vigente del pedido'), percent: metric(pct(g.netSales, net), '%', net, coverage, 'Asignación vigente del pedido') })), hours: distribution(hours).map(r => ({ key: r.key, sales: metric(r.netSales, 'CLP neto', gross / 1.19, coverage, 'Fecha/hora local Santiago; pedidos positivos') })), expenses: (financial?.statement?.expenses || []).map(e => ({ key: e.key, value: metric(e.available ? e.amount : null, 'CLP neto', net, e.complete ? 'complete' : e.available ? 'partial' : 'missing', e.label) })) };
  return { metricCatalog, period: p, netSales: net, cost, margin, marginPercent: pct(margin, net), units: sum(facts.filter(f => !f.extraHierarchyId && !f.code?.startsWith('BX')), 'quantity'), extraUnits: sum(facts.filter(f => f.extraHierarchyId || f.code?.startsWith('BX')), 'quantity'), orders: positive.length,
    ticket: tickets.length ? gross / tickets.length : null, medianTicket: median, positiveGross: gross, adjustmentsNet: net - gross / 1.19, dates: new Set(positive.map(o => o.date)).size,
    discounts: { amount: discounts, rate: pct(discounts, coveredGross + discounts), incidence: pct(discountedOrders, discountCovered), orders: discountedOrders, coveredOrders: discountCovered, coverage: pct(discountCovered, positive.length) },
    gender: gender.map(r => ({ ...r, percent: pct(r.netSales, net) })), genderCoverage: pct(knownSales, net), genderOrderCoverage: pct(knownOrders, positive.length), relativeM: pct(gender[0].netSales, knownSales), relativeF: pct(gender[1].netSales, knownSales),
    basket: { units, perOrder: positive.length ? units / positive.length : null, orders: positive.length, bakery, sandwich, both, either, bakeryPercent: pct(bakery, positive.length), sandwichPercent: pct(sandwich, positive.length), eitherPercent: pct(either, positive.length) },
    hours: distribution(hours), days: distribution(days), heat: distribution(heat), productPrices: histogram(productPrices), ticketPrices: histogram(ticketPrices), products, hierarchies, formats: groups(facts.filter(f => !f.extraHierarchyId), f => `${f.code} · ${f.name}`),
    financial, recurrence, salesCoverage, metrics: { netSales: metric(net, 'CLP neto', null, coverage, evidence), margin: metric(margin, 'CLP neto', net, costComplete ? coverage : 'missing-cost', evidence), orders: metric(positive.length, 'pedidos positivos únicos', null, coverage, evidence), ticket: metric(tickets.length ? gross / tickets.length : null, 'CLP con IVA', positive.length, coverage, evidence) } };
}
function findings(current, previous, scope = 'Compañía') {
  const rows = []; const add = (id, title, evidence, action, indicator, impact, quality = 1) => rows.push({ id: `${scope}:${id}`, scope, title, evidence, action, indicator, impact: Math.abs(impact || 0), quality, ruleVersion: RULES.version });
  for (const r of compare(current.products, previous.products)) if (r.units >= RULES.productUnits && r.previousUnits >= RULES.productUnits && Math.abs(r.changePercent) >= RULES.productChange && pct(Math.abs(r.change), current.netSales) >= RULES.productImpact) add(`product:${r.key}`, `${r.name}: ${r.change > 0 ? 'aumenta' : 'disminuye'} su aporte`, `${r.changePercent.toFixed(1)}%; diferencia neta $${Math.round(r.change)}; ${r.previousUnits} → ${r.units} unidades.`, 'Revisar disponibilidad, mezcla y ejecución comercial del producto.', 'Venta neta y unidades por producto', r.change);
  for (const r of compare(current.formats, previous.formats)) if (r.costChangePercent != null && Math.abs(r.costChangePercent) >= RULES.costChange) add(`cost:${r.key}`, `Cambio de costo: ${r.name}`, `Costo histórico unitario ${r.costChangePercent.toFixed(1)}% vs. mes anterior.`, 'Revisar facturas y receta por formato; contrastar última compra.', 'Costo neto por unidad del mismo código', (r.unitCost - r.previousCost) * r.units);
  if (current.marginPercent != null && previous.marginPercent != null && Math.abs(current.marginPercent - previous.marginPercent) >= RULES.points) add('margin', 'Cambió el margen de contribución', `${(current.marginPercent - previous.marginPercent).toFixed(1)} puntos porcentuales.`, 'Revisar descuentos, costos y mezcla por separado.', 'Margen sobre venta neta', (current.marginPercent - previous.marginPercent) / 100 * current.netSales);
  for (const r of current.hierarchies) { const old = previous.hierarchies.find(p => p.key === r.key); const change = pct(r.netSales, current.netSales) - (pct(old?.netSales || 0, previous.netSales) || 0); if (previous.netSales > 0 && Math.abs(change) >= RULES.points) add(`mix:${r.key}`, `Cambio de mezcla: ${r.name}`, `${change.toFixed(1)} puntos de participación.`, 'Revisar surtido, disponibilidad y exposición.', 'Participación en venta neta', change / 100 * current.netSales); }
  if (current.recurrence?.complete && previous.recurrence?.complete && current.recurrence.coverage != null && previous.recurrence.coverage != null && Math.abs(current.recurrence.coverage - previous.recurrence.coverage) <= 5 && Math.abs(current.recurrence.p90 - previous.recurrence.p90) >= RULES.recurrencePoints) add('recurrence', 'Cambió la venta recurrente a 90 días', `${(current.recurrence.p90 - previous.recurrence.p90).toFixed(1)} puntos; misma definición.`, 'Revisar la evolución por local y continuidad de identificación.', 'Venta recurrente / venta neta total', (current.recurrence.p90 - previous.recurrence.p90) / 100 * current.netSales);
  if (current.orders >= RULES.genderOrders && current.genderCoverage >= RULES.genderCoverage && current.relativeM != null && current.relativeF != null && Math.max(current.relativeM, current.relativeF) > 50) add('gender', 'Composición del género informado', `${current.relativeM >= current.relativeF ? 'Masculino' : 'Femenino'}: ${Math.max(current.relativeM, current.relativeF).toFixed(1)}% de la venta con género informado; cobertura ${current.genderCoverage.toFixed(1)}%; ${current.orders} pedidos.`, 'Contrastar preferencias con productos y horarios antes de orientar acciones.', 'Participación y cobertura de género registrado', 0);
  if (!current.financial?.statement?.dataCoverageComplete || !current.salesCoverage?.complete) add('coverage', 'Completar evidencia del cierre', 'Existen fuentes de ventas, costos o gastos con cobertura parcial.', 'Completar y revisar las fuentes; generar una nueva versión del cierre.', 'Cobertura de fuentes y conciliación', current.netSales, 0.5);
  return rows.sort((a, b) => b.quality - a.quality || b.impact - a.impact || a.id.localeCompare(b.id));
}
function assemble(input) {
  const { month, locations, months, stores, inventory = [], purchases = [], ingredients = [], theoretical = [], clusters = {}, sourceVersion, sources = [], warnings = [] } = input;
  const current = months.find(m => m.period.month === month), previous = months.find(m => m.period.month === period(month).previous) || summarize(period(period(month).previous), [], [], null, null, null);
  const priorities = [...findings(current, previous), ...stores.flatMap(s => findings(s.current, s.previous, s.name))].sort((a, b) => b.quality - a.quality || b.impact - a.impact || a.id.localeCompare(b.id));
  const comparable = stores.filter(s => s.comparable);
  const comparableCurrent = sum(comparable.map(s => s.current), 'netSales'), comparablePrevious = sum(comparable.map(s => s.previous), 'netSales');
  const comparison = { comparableLocations: comparable.map(s => s.id), comparableSales: comparableCurrent, comparablePreviousSales: comparablePrevious, comparableChange: delta(comparableCurrent, comparablePrevious), newOpeningSales: sum(stores.filter(s => s.newOpening).map(s => s.current), 'netSales'), nonComparableSales: sum(stores.filter(s => !s.comparable && !s.newOpening).map(s => s.current), 'netSales'), operatingDates: stores.map(s => ({ id: s.id, current: s.current.dates, previous: s.previous.dates })) };
  return { comparison, version: VERSION, rules: RULES, month, period: period(month), sourceVersion, generatedAt: input.generatedAt || new Date().toISOString(), locations, expectedPages: 16 + 2 * locations.length, current, previous, months: months.filter(m => m.period.month.startsWith(month.slice(0, 4)) && (m.netSales !== 0 || m.salesCoverage?.complete)), stores, inventory, purchases, ingredients, theoretical, clusters, sources, warnings: [...new Set(warnings)], priorities, criteria: [
    'Ventas netas sin IVA, después de descuentos, con extras y ajustes. Tickets y puntos de precio con IVA.',
    'Costo real histórico por fecha de venta. Margen calculado desde importes agregados; faltantes no equivalen a cero. Resultado parcial no es EBITDA ni utilidad neta.',
    'Género asignado vigente del pedido; M/F relativo excluye no atribuible y sin información. Los pedidos no equivalen a personas.',
    'Recurrencia acumulada 30/60/90: compra anterior en otra fecha local, cualquier producto, ámbito local o red. Denominador: toda la venta neta. No se suman ventanas.',
    'Canastas, tickets y precios usan pedidos y compras positivas; los ajustes se muestran separados. Franjas de dos horas; antes de 07 y hora desconocida se conservan.',
    'Costos teóricos: receta y últimas compras compatibles disponibles al cierre, sin compras futuras. Inventario identifica fecha, origen y faltantes. Cobertura exige 28 días completos.',
    'Reglas deterministas versionadas, sin modelos de lenguaje. Prioridades describen asociaciones, no causalidad. Fuentes y archivos archivados no se reemplazan.' ] };
}
module.exports = { VERSION, RULES, period, monthsThrough, includedStores, band, metric, summarize, assemble, findings, compare, pct, delta, sum };
