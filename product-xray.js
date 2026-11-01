const crypto = require('node:crypto');
const { productIdentity } = require('./product-report');
const { genderForOrder } = require('./product-gender');
const { coverageFor, resolvePeriod } = require('./recurrence');
const { classifySalesBar } = require('./sales-insight-filters');

const VERSION = 'product-xray-v6-automatic-clusters';
const INGREDIENT_VERSION = 'brewit-main-ingredients-v1';
// Codes checked against the ingredient master; product names never assign these tags.
const INGREDIENTS = { CAF001: 'coffee', CAF002: 'coffee', SUB005: 'coffee', CAF008: 'matcha', CAF009: 'chai',
  CAF010: 'tea', CAF011: 'tea', CAF012: 'tea', CAF014: 'tea' };
const LABELS = { coffee: 'Café', matcha: 'Matcha', chai: 'Chai', tea: 'Otro té' };
const GENDERS = { masculine: 'Masculino', feminine: 'Femenino', unattributable: 'No atribuible', missing: 'Sin información' };
const BANDS = [['early', 'Antes de las 07'], ['07', '07–09'], ['09', '09–11'], ['11', '11–13'], ['13', '13–15'],
  ['15', '15–17'], ['17', '17–19'], ['19', '19–cierre'], ['unknown', 'Hora sin información']];
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const round = n => Number.isFinite(n) ? Number(n.toFixed(2)) : null;
const pct = (n, d) => d > 0 ? round(n / d * 100) : null;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const eligible = l => !l.isExtra && !l.extraHierarchyId && !l.isComponent && !l.parentLineId;
const sales = l => Object.hasOwn(l, 'productNetSales') ? l.productNetSales : l.netSales;
const normalize = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function accompanimentCategory(line, classifications) {
  const id = String(line.hierarchyId || '');
  if (classifications?.has(id)) return classifications.get(id);
  // Known branch IDs are authoritative; the common parent is never a match.
  if (id.startsWith('AB.140150')) return 'bakery';
  if (id.startsWith('AB.140160')) return 'sandwich';
  // Only a specific hierarchy label (not a combined parent) may be fallback evidence.
  const names = [...(line.categoryPath || []), line.hierarchyName || ''];
  for (const name of names.slice().reverse()) {
    const value = normalize(name).trim();
    if (/^(bolleria|pasteleria)$/.test(value)) return 'bakery';
    if (/^sandwich(?:es)?$/.test(value)) return 'sandwich';
  }
  return null;
}

function periodFor(query, today) {
  if (query.period === 'current-month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return resolvePeriod(query, today, null);
}
function previousMonths(from) {
  const [y, m] = from.split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => ({ from: new Date(Date.UTC(y, m - 7 + i, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m - 6 + i, 0)).toISOString().slice(0, 10) }));
}
function familiesFor(products) {
  const groups = new Map();
  for (const p of products) {
    const identity = productIdentity(p, true), bar = p.bar || classifySalesBar({ name: p.name, hierarchyPath: p.categoryPath || [] });
    const key = JSON.stringify([identity.key, bar]);
    if (!groups.has(key)) groups.set(key, { id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 24),
      name: identity.name, path: p.categoryPath || [], bar, products: [] });
    groups.get(key).products.push({ ...p, format: identity.format || 'Único' });
  }
  return [...groups.values()].map(g => ({ ...g, codes: g.products.map(p => p.code).sort(),
    products: g.products.sort((a, b) => ['CL', 'GR', 'XTR', 'Único'].indexOf(a.format) - ['CL', 'GR', 'XTR', 'Único'].indexOf(b.format) || a.code.localeCompare(b.code)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
function selectFamilies(families, query = {}) {
  let hierarchy;
  try { hierarchy = Array.isArray(query.hierarchy) ? query.hierarchy : JSON.parse(query.hierarchy || '[]'); } catch { fail('Selecciona una jerarquía válida.'); }
  if (!Array.isArray(hierarchy) || hierarchy.length > 20 || hierarchy.some(p => typeof p !== 'string' || !p || p.length > 300)) fail('Selecciona una jerarquía válida.');
  const selected = families.filter(f => hierarchy.every((p, i) => f.path[i] === p) && (!query.family || f.id === query.family));
  if (!selected.length) fail('No hay productos disponibles para estos filtros.');
  const compare = (a, b) => { const ap = a.path.length ? a.path : ['Sin jerarquía'], bp = b.path.length ? b.path : ['Sin jerarquía'];
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) { if (ap[i] == null) return -1; if (bp[i] == null) return 1; const c = ap[i].localeCompare(bp[i], 'es'); if (c) return c; }
    return a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id); };
  return { families: selected.sort(compare), hierarchy };
}
function inspectRecipe(code, recipes, catalog) {
  const ingredients = [], evidence = [], problems = [];
  function walk(key, ancestors, depth) {
    if (ancestors.has(key) || depth > 12) { problems.push(`Receta circular o demasiado profunda: ${key}`); return; }
    const lines = recipes.get(key);
    if (!lines?.length) { problems.push(`Sin receta: ${key}`); return; }
    const visited = new Set([...ancestors, key]);
    for (const line of lines) {
      const id = String(line.ingredientId).toUpperCase(), item = catalog.get(id);
      const name = item?.name || line.ingredientName || id;
      const packaging = /^PAC/.test(id) || item?.hierarchyIds?.some(h => h.startsWith('IC.100')) || id === 'CAF013';
      const effectiveQuantity = Number(line.quantity) / (Number(line.yieldRate) / 100);
      if (!(effectiveQuantity >= 0) || !Number.isFinite(effectiveQuantity) || !line.unit) problems.push(`Cantidad, rendimiento o unidad incompleta: ${id}`);
      if (!item && !recipes.has(id) && !INGREDIENTS[id]) problems.push(`Ingrediente sin maestro: ${id}`);
      const entry = { code: id, name, quantity: round(Number(line.quantity)), unit: line.unit, yieldRate: line.yieldRate,
        effectiveQuantity: round(effectiveQuantity), depth, packaging, parentCode: key };
      ingredients.push(entry);
      if (INGREDIENTS[id] && line.quantity > 0) evidence.push({ code: id, name, category: INGREDIENTS[id], label: LABELS[INGREDIENTS[id]] });
      if (recipes.has(id) && line.quantity > 0) walk(id, visited, depth + 1);
      else if (!INGREDIENTS[id] && !packaging && (id.startsWith('SUB') || item?.hierarchyIds?.some(h => h.startsWith('IC.010')))) problems.push(`Subreceta o clasificación pendiente: ${id}`);
    }
  }
  walk(code, new Set(), 0);
  const uniqueEvidence = [...new Map(evidence.map(e => [e.code, e])).values()];
  const categories = [...new Set(uniqueEvidence.map(e => e.category))];
  return { ingredients, evidence: uniqueEvidence, categories, complete: !problems.length, problems: [...new Set(problems)],
    labels: categories.map(k => LABELS[k]), capacity: [...new Set(ingredients.filter(i => i.packaging && /^vaso\b/i.test(i.name)).flatMap(i => i.name.match(/\d+(?:[.,]\d+)?\s*(?:oz|ml)\b/gi) || []))] };
}
function costInfo(reference) {
  const complete = reference && reference.source !== 'missing' && !reference.costIncomplete && Number.isFinite(reference.unitCost)
    && reference.unitCost >= 0;
  const comparable = complete && ['net-field-consistent', 'net-source-declared'].includes(reference.costBasisEvidence);
  return { cost: complete ? round(reference.unitCost) : null, comparable, source: reference?.source || 'missing', date: reference?.sourceDate || null,
    sourceLocation: reference?.sourceLocationName || reference?.sourceLocationId || null,
    reason: !complete ? reference?.reason === 'no-compatible-purchase' || reference?.costPolicy === 'latest-purchase'
      ? 'Falta una última compra compatible, una conversión o un componente válido de la receta' : 'Costo o conversión de unidad incompleto'
      : !comparable ? 'Base neta del costo sin cotejo' : null };
}
function costBreakdown(reference, code, catalog) {
  const rows = [];
  function walk(components, factor, parentCode, depth) {
    for (const c of components) {
      const item = catalog.get(c.code), children = c.components || [], missing = c.costSource === 'missing';
      rows.push({ code: c.code, name: c.name || item?.name || c.code, parentCode, depth,
        packaging: /^PAC/.test(c.code) || c.code === 'CAF013' || item?.hierarchyIds?.some(h => h.startsWith('IC.100')) || false,
        quantity: Number.isFinite(c.quantity) ? c.quantity * factor : null, yieldRate: c.yieldRate ?? null,
        effectiveQuantity: Number.isFinite(c.effectiveQuantity) ? c.effectiveQuantity * factor : null,
        unit: c.unit, unitCost: !missing && Number.isFinite(c.unitCost) ? c.unitCost : null,
        totalCost: !missing && Number.isFinite(c.totalCost) ? c.totalCost * factor : null,
        includedInTotal: !children.length, source: c.costSource, date: c.costSourceDate || null,
        location: c.sourceLocationName || c.sourceLocationId || null, supplier: c.supplier || null,
        reason: c.reason || (missing ? 'Sin costo o conversión disponible' : c.costIncomplete ? 'Subreceta incompleta' : null) });
      if (children.length) walk(children, factor * c.effectiveQuantity * (c.recipeConversionFactor ?? 1), c.code, depth + 1);
    }
  }
  if (reference?.components?.length) walk(reference.components, reference.recipeConversionFactor ?? 1, code, 0);
  else {
    const valid = reference?.source !== 'missing' && Number.isFinite(reference?.unitCost);
    rows.push({ code, name: catalog.get(code)?.name || code, parentCode: code, depth: 0, packaging: false, quantity: 1, effectiveQuantity: 1,
      yieldRate: 100, unit: reference?.unit || catalog.get(code)?.unit || 'UN', unitCost: valid ? reference.unitCost : null,
      totalCost: valid ? reference.unitCost : null, includedInTotal: true, source: reference?.source || 'missing', date: reference?.sourceDate || null,
      location: reference?.sourceLocationName || reference?.sourceLocationId || null, supplier: reference?.supplier || null, reason: reference?.reason || null });
  }
  const info = costInfo(reference), leaves = rows.filter(r => r.includedInTotal), observedNet = leaves.reduce((sum, r) => sum + (r.totalCost || 0), 0);
  const complete = info.cost !== null && !leaves.some(r => r.totalCost == null), reconciled = complete && Math.abs(observedNet - reference.unitCost) <= .000001;
  return { basis: 'net', rows, totalNet: complete && reconciled ? info.cost : null, observedNet: round(observedNet), complete: complete && reconciled,
    reason: !complete ? info.reason || 'Faltan costos en la receta' : !reconciled ? 'El desglose no concilia con el costo disponible' : null };
}
function profit(net, cost, available) {
  return { margin: available && Number.isFinite(net) && Number.isFinite(cost) ? round(net - cost) : null,
    marginPercent: available && net > 0 && Number.isFinite(cost) ? pct(net - cost, net) : null };
}
const blank = () => ({ units: 0, netSales: 0, missingSales: 0, orders: new Set() });
function add(m, line, order) { m.units += Number(line.quantity) || 0; if (Number.isFinite(sales(line))) m.netSales += sales(line); else m.missingSales++; m.orders.add(order.orderKey); }
function finish(m) { return { units: round(m.units), netSales: m.missingSales ? null : round(m.netSales), observedNetSales: round(m.netSales), missingSales: m.missingSales, orders: m.orders.size }; }
function band(order) {
  if (order.timeKnown === false || !/^\d{2}:\d{2}/.test(order.time || '')) return 'unknown';
  const hour = Number(order.time.slice(0, 2));
  if (hour > 23) return 'unknown';
  return hour < 7 ? 'early' : hour >= 19 ? '19' : String(7 + Math.floor((hour - 7) / 2) * 2).padStart(2, '0');
}
function conclusion(consumption, accompanies) {
  const dominant = rows => rows.filter(r => r.key !== 'unknown' && r.key !== 'missing' && r.key !== 'unattributable').slice().sort((a, b) => b.units - a.units);
  const gender = dominant(consumption.gender), hours = dominant(consumption.hours), days = dominant(consumption.weekdays);
  const concentrated = rows => rows[0]?.percent >= 50 && rows[0].percent - (rows[1]?.percent || 0) >= 15;
  const known = gender.map(r => ({ ...r, percent: pct(r.units, consumption.knownGenderUnits) }));
  const sufficient = consumption.orders >= 100 && consumption.dates >= 7;
  const dimensions = [consumption.genderCoverageUnits >= 50 && concentrated(known), concentrated(hours), concentrated(days)].filter(Boolean).length;
  const status = !sufficient ? 'Perfil exploratorio' : dimensions >= 2 ? 'Perfil concentrado' : 'Sin predominio claro';
  const describe = (rows, scope) => !rows[0]?.units ? `Sin datos suficientes de ${scope}.` :
    rows.length > 1 && rows[0].units === rows[1].units ? `No hay un predominio único de ${scope}.` : `${scope}: ${rows[0].label} (${rows[0].percent?.toFixed(1).replace('.', ',')}% de unidades).`;
  return { status, sufficient, concentratedDimensions: dimensions, rules: { minimumOrders: 100, minimumDates: 7, genderCoverage: 50, leadingShare: 50, gapPoints: 15 },
    statements: [describe(known, 'Entre unidades con género informado'), describe(hours, 'Franja principal'), describe(days, 'Día principal'),
      `Bollería: ${accompanies.bakery.percent?.toFixed(1).replace('.', ',') ?? '—'}% de pedidos; sándwiches: ${accompanies.sandwich.percent?.toFixed(1).replace('.', ',') ?? '—'}%; cualquiera: ${accompanies.either.percent?.toFixed(1).replace('.', ',') ?? '—'}%.`,
      `Ambas categorías en el mismo pedido: ${accompanies.both.percent?.toFixed(1).replace('.', ',') ?? '—'}%.`,
      `${consumption.orders} pedidos, ${consumption.units} unidades y ${consumption.dates} fechas con actividad. Cobertura de género: ${consumption.genderCoverageUnits?.toFixed(1).replace('.', ',') ?? '—'}% de unidades y ${consumption.genderCoverageOrders?.toFixed(1).replace('.', ',') ?? '—'}% de pedidos.`,
      'Perfil descriptivo de compras registradas; los pedidos no equivalen a personas únicas. Los clusters calculados automáticamente se presentan con su validación estadística.'] };
}
function actualBucket() { return { units: 0, netSales: 0, missingSales: 0, cost: 0, complete: true, ingredientComplete: true, reasons: new Set(), sources: new Map(), ingredients: new Map() }; }
function canonicalCostUnit(unit) {
  const u = normalize(unit).replace(/\s/g, '');
  if (['kg', 'kilo', 'kilos'].includes(u)) return { unit: 'g', factor: 1000 };
  if (['g', 'gr', 'grs', 'gramo', 'gramos'].includes(u)) return { unit: 'g', factor: 1 };
  if (['l', 'lt', 'litro', 'litros'].includes(u)) return { unit: 'ml', factor: 1000 };
  if (['ml', 'cc'].includes(u)) return { unit: 'ml', factor: 1 };
  return { unit: ['un', 'und', 'unidad', 'unidades'].includes(u) ? 'UN' : unit, factor: 1 };
}
function addActual(a, line, order, ref, breakdown) {
  const info = costInfo(ref); a.units += Number(line.quantity) || 0;
  if (Number.isFinite(sales(line))) a.netSales += sales(line); else a.missingSales++;
  if (!info.comparable || !Number.isFinite(sales(line)) || !Number.isFinite(line.quantity)) { a.complete = false; a.reasons.add(info.reason || 'Venta o unidades incompletas'); }
  else a.cost += line.quantity * ref.unitCost;
  a.sources.set(JSON.stringify([order.locationId, info.source, info.date, info.reason]), { locationId: order.locationId, ...info });
  if (breakdown && ref.source === 'sales-export') a.ingredientComplete = false;
  if (breakdown) for (const row of breakdown.rows.filter(r => r.includedInTotal)) {
    const c = canonicalCostUnit(row.unit), key = JSON.stringify([row.code, c.unit]), value = a.ingredients.get(key) || { code: row.code, name: row.name, unit: c.unit, packaging: row.packaging, quantity: 0, cost: 0, complete: true, dates: new Set() };
    if (row.totalCost == null || row.effectiveQuantity == null) value.complete = false;
    else { value.quantity += row.effectiveQuantity * c.factor * line.quantity; value.cost += row.totalCost * line.quantity; }
    if (row.date) value.dates.add(row.date); a.ingredients.set(key, value);
  }
}
function ingredientComparison(breakdown, real) {
  const rows = new Map();
  for (const r of breakdown.rows.filter(r => r.includedInTotal)) {
    const c = canonicalCostUnit(r.unit), key = JSON.stringify([r.code, c.unit]), value = rows.get(key) || { code: r.code, name: r.name, unit: c.unit, theoreticalQuantity: 0, theoreticalCost: 0, complete: true };
    if (r.totalCost == null || r.effectiveQuantity == null) value.complete = false;
    else { value.theoreticalQuantity += r.effectiveQuantity * c.factor; value.theoreticalCost += r.totalCost; }
    rows.set(key, value);
  }
  for (const r of real.ingredientCosts) {
    const key = JSON.stringify([r.code, r.unit]), value = rows.get(key) || { code: r.code, name: r.name, unit: r.unit, theoreticalQuantity: null, theoreticalCost: null, complete: false };
    Object.assign(value, { realQuantityPerProduct: r.quantityPerProduct, realUnitCost: r.unitCost, realCostPerProduct: r.costPerProduct, dates: r.dates }); rows.set(key, value);
  }
  return [...rows.values()].map(r => ({ ...r, theoreticalQuantity: r.complete ? r.theoreticalQuantity : null, theoreticalCost: r.complete ? r.theoreticalCost : null,
    theoreticalUnitCost: r.complete && r.theoreticalQuantity > 0 ? r.theoreticalCost / r.theoreticalQuantity : null,
    realQuantityPerProduct: r.realQuantityPerProduct ?? null, realUnitCost: r.realUnitCost ?? null, realCostPerProduct: r.realCostPerProduct ?? null }));
}
function finishActual(a) {
  const valid = a.complete && a.units > 0, available = !a.missingSales;
  return { units: round(a.units), netSales: available ? round(a.netSales) : null, missingSales: a.missingSales,
    priceGross: a.units > 0 && available ? round(a.netSales * 1.19 / a.units) : null,
    priceNet: a.units > 0 && available ? round(a.netSales / a.units) : null,
    cost: valid ? round(a.cost) : null, unitCost: valid ? round(a.cost / a.units) : null,
    ...profit(a.netSales, a.cost, valid), unitMargin: valid ? round((a.netSales - a.cost) / a.units) : null,
    ingredientBreakdownComplete: a.complete && a.ingredientComplete, reasons: [...a.reasons], sources: [...a.sources.values()], ingredientCosts: [...a.ingredients.values()].map(r => ({
      code: r.code, name: r.name, unit: r.unit, packaging: r.packaging, totalQuantity: r.complete ? r.quantity : null,
      quantityPerProduct: a.complete && a.ingredientComplete && r.complete && a.units > 0 ? r.quantity / a.units : null,
      unitCost: a.complete && a.ingredientComplete && r.complete && r.quantity > 0 ? r.cost / r.quantity : null,
      totalCost: r.complete ? r.cost : null, costPerProduct: a.complete && a.ingredientComplete && r.complete && a.units > 0 ? r.cost / a.units : null,
      dates: [...r.dates].sort(), complete: r.complete
    })) };
}
function buildProductXray(input) {
  const { family, period, orders, coverage, locationIds, stores, recipes, catalog, cutoffCosts, historicalCost, version, today, cutoff } = input;
  if (!family) fail('Selecciona un producto.');
  const codes = new Set(family.codes), months = previousMonths(period.from), amounts = [period, ...months].map(() => ({ total: blank(), formats: new Map(family.codes.map(c => [c, blank()])) }));
  const gender = new Map(Object.entries(GENDERS).map(([key, label]) => [key, { key, label, ...blank() }]));
  const hours = new Map(BANDS.map(([key, label]) => [key, { key, label, ...blank() }]));
  const weekdays = DAYS.map((label, key) => ({ key: String(key), label, ...blank() }));
  const consumed = blank(), dates = new Set(), knownOrders = new Set(), excluded = blank(), accomp = { bakery: new Set(), sandwich: new Set(), both: new Set(), either: new Set() };
  const sizeUnits = new Map(family.codes.map(code => [code, 0]));
  const lastMonth = input.lastMonth || previousMonths(today).at(-1), readFrom = [months[0].from, lastMonth.from].sort()[0], readTo = [period.to, lastMonth.to].sort().at(-1);
  const actual = new Map(family.codes.map(code => [code, actualBucket()])), monthly = new Map(family.codes.map(code => [code, actualBucket()]));
  const monthlyLocal = new Map(family.codes.flatMap(code => stores.map(store => [`${code}|${store.id}`, actualBucket()])));
  const seen = new Set();
  for (const order of orders) {
    if (seen.has(order.orderKey) || !locationIds.includes(order.locationId) || order.date > readTo || order.date < readFrom
      || order.date === today && order.dateTime > `${today}T${cutoff}`) continue;
    seen.add(order.orderKey);
    const lines = order.lines.filter(l => eligible(l) && codes.has(l.code));
    if (!lines.length) continue;
    for (const [i, window] of [period, ...months].entries()) if (order.date >= window.from && order.date <= window.to) for (const line of lines) {
      add(amounts[i].total, line, order); add(amounts[i].formats.get(line.code), line, order);
    }
    const inSelection = order.date >= period.from && order.date <= period.to, inLastMonth = order.date >= lastMonth.from && order.date <= lastMonth.to;
    if (inSelection || inLastMonth) for (const line of lines) {
      const ref = historicalCost(order.date, order.locationId, line.code, line);
      if (inSelection) addActual(actual.get(line.code), line, order, ref);
      if (inLastMonth) { const b = costBreakdown(ref, line.code, catalog); addActual(monthly.get(line.code), line, order, ref, b); addActual(monthlyLocal.get(`${line.code}|${order.locationId}`), line, order, ref, b); }
    }
    if (!inSelection) continue;
    const g = genderForOrder(order), genderKey = g !== 'unknown' ? g : order.genderAmbiguous ? 'unattributable' : 'missing';
    const positive = !order.reversalSignals?.length && order.netSales > 0;
    const validLines = lines.filter(l => positive && l.quantity > 0 && Number.isFinite(sales(l)) && sales(l) >= 0);
    for (const l of lines) {
      if (!validLines.includes(l)) add(excluded, l, order);
    }
    if (!validLines.length) continue;
    dates.add(order.date); if (g !== 'unknown') knownOrders.add(order.orderKey);
    for (const l of validLines) { sizeUnits.set(l.code, sizeUnits.get(l.code) + l.quantity); add(consumed, l, order); add(gender.get(genderKey), l, order); add(hours.get(band(order)), l, order);
      add(weekdays[(new Date(`${order.date}T12:00:00Z`).getUTCDay() + 6) % 7], l, order); }
    const other = order.lines.filter(l => eligible(l) && !codes.has(l.code) && l.quantity > 0);
    const bakery = other.some(l => accompanimentCategory(l, input.accompanimentClassifications) === 'bakery');
    const sandwich = other.some(l => accompanimentCategory(l, input.accompanimentClassifications) === 'sandwich');
    if (bakery) accomp.bakery.add(order.orderKey); if (sandwich) accomp.sandwich.add(order.orderKey); if (bakery && sandwich) accomp.both.add(order.orderKey); if (bakery || sandwich) accomp.either.add(order.orderKey);
  }
  const distribution = rows => rows.map(r => ({ key: r.key, label: r.label, ...finish(r), percent: pct(r.units, consumed.units) }));
  const consumption = { ...finish(consumed), dates: dates.size, gender: distribution([...gender.values()]), hours: distribution([...hours.values()]), weekdays: distribution(weekdays),
    knownGenderUnits: gender.get('masculine').units + gender.get('feminine').units, knownGenderOrders: knownOrders.size, excludedAdjustments: finish(excluded) };
  consumption.genderCoverageUnits = pct(consumption.knownGenderUnits, consumption.units); consumption.genderCoverageOrders = pct(knownOrders.size, consumption.orders);
  const accompanies = Object.fromEntries(Object.entries(accomp).map(([key, set]) => [key, { orders: set.size, percent: pct(set.size, consumption.orders) }]));
  const monthActual = (a, ids) => { const cov = coverageFor(coverage, ids, lastMonth.from, lastMonth.to, 'sales');
    const status = cov.complete ? 'complete' : a.sources.size || cov.coveredDays ? 'partial' : 'no_data';
    return { ...finishActual(a), status, ...(status === 'no_data' ? { netSales: null } : {}) };
  };
  const formats = family.products.map(p => {
    const recipe = inspectRecipe(p.code, recipes, catalog), a = actual.get(p.code);
    const references = stores.map(store => { const ref = cutoffCosts(store.id, p.code), cost = costInfo(ref), breakdown = costBreakdown(ref, p.code, catalog), net = p.listPrice > 0 ? p.listPrice / 1.19 : null;
      const lastReal = monthActual(monthlyLocal.get(`${p.code}|${store.id}`), [store.id]);
      return { locationId: store.id, location: store.name, priceGross: p.listPrice > 0 ? p.listPrice : null, priceNet: round(net), ...cost,
        breakdown, ingredientComparison: ingredientComparison(breakdown, lastReal), basis: 'net', referenceDate: today, lastMonth: { ...lastReal, period: lastMonth }, reason: cost.reason || breakdown.reason,
        ...profit(net, ref?.unitCost, cost.comparable && breakdown.complete) }; });
    return { code: p.code, name: p.name, format: p.format, recipe, references,
      lastMonthActual: monthActual(monthly.get(p.code), locationIds), actual: { ...finish(amounts[0].formats.get(p.code)), ...finishActual(a) } };
  });
  const windows = [period, ...months].map((window, i) => { const cov = coverageFor(coverage, locationIds, window.from, window.to, 'sales');
    const hasData = amounts[i].total.orders.size > 0, status = cov.complete ? 'complete' : hasData || cov.coveredDays ? 'partial' : 'no_data';
    const metric = m => ({ ...finish(m), ...(status === 'no_data' ? { units: null, netSales: null } : {}) });
    return { ...window, status, coverage: cov, total: metric(amounts[i].total), formats: family.products.map(p => ({ code: p.code, format: p.format, ...metric(amounts[i].formats.get(p.code)) })) }; });
  const tags = [...new Set(formats.flatMap(p => p.recipe.categories))], classificationComplete = formats.every(p => p.recipe.complete);
  const sizes = new Map();
  for (const p of family.products) { const r = sizes.get(p.format) || { format: p.format, codes: [], units: 0 }; r.codes.push(p.code); r.units += sizeUnits.get(p.code); sizes.set(p.format, r); }
  const sizeMix = sizes.size > 1 ? { basis: 'Unidades de compras positivas válidas del período seleccionado; ajustes excluidos, igual que el análisis de consumo.',
    units: consumption.units, rows: [...sizes.values()].map(r => ({ ...r, units: round(r.units), percent: pct(r.units, consumption.units) })) } : null;
  return { version: VERSION, sourceVersion: version, generatedAt: new Date().toISOString(), asOf: `${period.to}T${period.to === today ? cutoff : '23:59:59'}`, period, scope: input.scope, family: { id: family.id, name: family.name, codes: family.codes,
    path: family.path, bar: family.bar, tags: tags.map(k => LABELS[k]), classificationComplete,
    classificationLabel: classificationComplete ? tags.length ? tags.map(k => LABELS[k]).join(' · ') : 'Ninguno de los anteriores' : 'Clasificación incompleta' },
    referenceDate: today, lastMonth: { ...lastMonth, coverage: coverageFor(coverage, locationIds, lastMonth.from, lastMonth.to, 'sales') },
    formats, sizeMix, selected: windows[0], history: windows.slice(1), consumption, accompanies, conclusion: conclusion(consumption, accompanies),
    sources: input.sources || [], warnings: [...(input.warnings || []), ...(windows[0].total.missingSales ? [`${windows[0].total.missingSales} líneas sin importe completo; venta neta y promedios afectados no calculables.`] : [])],
    methodology: ['Importes vendidos sin IVA, después de descuentos. Precio de lista y precio efectivo con IVA.',
      'Porcentajes de género, horario y día sobre unidades de compras positivas válidas. Acompañamientos sobre pedidos únicos con el producto.',
      'Seis meses calendario anteriores al mes de inicio; ausencia de cobertura no equivale a ventas cero.',
      'Los costos de ingredientes, envases y compras se usan netos, conforme a la base declarada del sistema; no se les agrega ni se les vuelve a descontar IVA. Precio neto = precio con IVA / 1,19. Margen = precio neto menos costo neto.',
      'Los subtotales de subrecetas no se suman nuevamente al total: se computan sus componentes finales, escalados a la cantidad usada en el producto. Se calculan importes sin redondeos intermedios. Faltantes o conversiones inválidas dejan el margen sin calcular.',
      `Margen real: precio cobrado después de descuentos y costo vigente a fecha de venta. Teórico vigente al ${today}: precio de lista actual y receta vigente con últimas compras compatibles, sin sustitución por costo fijo de maestro.`,
      `Último mes calendario completo: ${lastMonth.from} a ${lastMonth.to}; independiente del período seleccionado. Sus importes y costos por ingrediente son promedios ponderados de las ventas observadas.`,
      'La receta teórica vigente no reconstruye sustituciones o personalizaciones individuales. Si se usa un costo total registrado en la venta sin receta histórica completa, se conserva ese total real y el desglose mensual por ingrediente se identifica como incompleto.'],
    clusterContext: { location: input.scope.location, period, productCodes: family.codes, sourceVersion: version } };
}
module.exports = { VERSION, INGREDIENT_VERSION, familiesFor, selectFamilies, inspectRecipe, costInfo, costBreakdown, accompanimentCategory, previousMonths, periodFor, buildProductXray };
