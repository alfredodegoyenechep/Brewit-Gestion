const recurrence = require('./recurrence');
const { addDays } = require('./network-sales');
const { daysBetween } = require('./transaction-linkage');

const VERSION = 'product-recurrence-exclusive-v1';
const WINDOWS = [15, 30, 60, 90];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const round = value => Number(value.toFixed(2));
const pathFor = line => line.categoryPath?.length ? line.categoryPath : [line.categoryName || line.hierarchyName || 'Sin jerarquía'];
const eligible = line => !line.isExtra && !line.extraHierarchyId && !line.isComponent && !line.parentLineId;
const lineSales = line => Object.hasOwn(line, 'productNetSales') ? line.productNetSales : line.netSales;
function productIdentity(line, groupFormats) {
  const name = line.name || line.code || 'Sin nombre';
  const match = groupFormats ? name.match(/\s*\(\s*(CL|GR|XTR)\s*\)\s*$/i) : null;
  const baseName = match ? name.slice(0, match.index).trim() : name;
  const normalizedName = baseName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es')
    .replace(/\(\s*ice(?:d)?\s*\)/g, '(iced)').replace(/\s+/g, ' ').replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').trim();
  return { key: match ? JSON.stringify(['formats', pathFor(line), normalizedName]) : String(line.code || name),
    name: baseName, format: match ? match[1].toUpperCase() : null };
}
function selection(query = {}) {
  const parse = (value, name) => {
    if (value === undefined || value === '') return [];
    let result;
    try { result = Array.isArray(value) ? value : JSON.parse(value); } catch { fail(`La selección de ${name} no es válida.`); }
    if (!Array.isArray(result) || result.length > 500 || result.some(v => typeof v !== 'string' || !v || v.length > 300)) fail(`La selección de ${name} no es válida.`);
    return result;
  };
  const groupBy = query.groupBy || 'hierarchy', level = Number(query.level || 1);
  if (!['hierarchy', 'product'].includes(groupBy) || !Number.isInteger(level) || level < 1 || level > 20) fail('Selecciona una agrupación válida.');
  if (query.groupFormats !== undefined && ![true, false, 'true', 'false'].includes(query.groupFormats)) fail('Selecciona una opción válida para agrupar formatos.');
  return { groupBy, level, groupFormats: query.groupFormats === true || query.groupFormats === 'true', products: parse(query.products, 'productos'), hierarchy: parse(query.hierarchy, 'jerarquía') };
}
function productOptions(orders) {
  const products = new Map(), productLines = new Map(), hierarchies = new Map();
  for (const order of orders) for (const line of order.lines || []) {
    if (!eligible(line)) continue;
    const path = pathFor(line);
    if (line.code) {
      products.set(String(line.code), { code: String(line.code), name: line.name || String(line.code) });
      productLines.set(String(line.code), line);
    }
    for (let depth = 1; depth <= path.length; depth++) {
      const prefix = path.slice(0, depth), key = JSON.stringify(prefix);
      hierarchies.set(key, { path: prefix, label: prefix.join(' / ') });
    }
  }
  const grouped = new Map();
  for (const [code, line] of productLines) {
    const identity = productIdentity(line, true);
    if (!grouped.has(identity.key)) grouped.set(identity.key, { name: identity.name, codes: [], formats: [] });
    const group = grouped.get(identity.key);
    group.codes.push(code);
    if (identity.format && !group.formats.includes(identity.format)) group.formats.push(identity.format);
  }
  const groupedProducts = [...grouped.values()].map(group => ({ ...group, code: group.codes.sort()[0],
    formats: ['CL', 'GR', 'XTR'].filter(format => group.formats.includes(format)) }));
  return { products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    groupedProducts: groupedProducts.sort((a, b) => a.name.localeCompare(b.name, 'es')),
    hierarchies: [...hierarchies.values()].sort((a, b) => a.label.localeCompare(b.label, 'es')) };
}
// Strictly earlier local dates: the current purchase and later purchases cannot establish recurrence.
function previousDate(dates, date) {
  let low = 0, high = dates.length;
  while (low < high) { const mid = (low + high) >>> 1; if (dates[mid] < date) low = mid + 1; else high = mid; }
  return low ? dates[low - 1] : null;
}
function buildProductRecurrence(state, orders, coverage = [], query = {}, warnings = []) {
  const filters = selection(query), { report, histories } = state;
  const asOf = report.period.to < report.today ? `${report.period.to}T23:59:59` : `${report.today}T${query.serverCutoff || '23:59:59'}`;
  const selectedOrders = orders.filter(o => report.locationIds.includes(o.locationId) && o.date >= report.period.from && o.date <= report.period.to && (!o.dateTime || o.dateTime <= asOf));
  // Resolve against the whole basket and all orders, before filtering products or hierarchies.
  const purchases = recurrence.buildPurchases(state, selectedOrders, coverage);
  const links = new Map(purchases.details.map(row => [row.orderKey, row]));
  const historyByAlias = new Map([...histories.values()].map(item => [item.alias, item.dates]));
  const productCodes = new Set(filters.products);
  const blank = (key, label, path = []) => ({ key, label, path, netSales: 0, units: 0, missingSales: 0,
    windows: Object.fromEntries(WINDOWS.map(days => [days, { days, netSales: 0 }])), withoutRecent: { netSales: 0 }, unclassified: { netSales: 0 } });
  const totals = blank('total', 'Total selección'), groups = new Map();
  const nodeFor = path => ({ ...blank(JSON.stringify(path), path.at(-1) || 'Total selección', path), children: new Map(), products: new Map() });
  const hierarchyTree = filters.groupBy === 'hierarchy' ? nodeFor([]) : null;
  function add(row, line, category) {
    const amount = lineSales(line);
    row.units += Number.isFinite(line.quantity) ? line.quantity : 0;
    if (!Number.isFinite(amount)) { row.missingSales++; return; }
    row.netSales += amount;
    if (typeof category === 'number') row.windows[category].netSales += amount;
    else row[category].netSales += amount;
  }
  for (const order of selectedOrders) {
    const linked = links.get(order.orderKey);
    const dates = linked && linked.classification !== 'unclassified' ? historyByAlias.get(linked.alias) : null;
    const prior = dates ? previousDate(dates, order.date) : null;
    const age = prior ? daysBetween(prior, order.date) : null;
    const category = !dates ? 'unclassified' : WINDOWS.find(days => age !== null && age >= 1 && age <= days) || 'withoutRecent';
    for (const line of order.lines || []) {
      if (!eligible(line)) continue;
      const path = pathFor(line);
      if (productCodes.size && !productCodes.has(String(line.code))) continue;
      if (!filters.hierarchy.every((part, index) => path[index] === part)) continue;
      if (!line.quantity && !lineSales(line)) continue;
      const groupedPath = path.slice(0, filters.level);
      const identity = productIdentity(line, filters.groupFormats);
      const formatGrouped = filters.groupBy === 'product' && identity.format !== null;
      const key = filters.groupBy === 'product' ? identity.key : JSON.stringify(groupedPath);
      const label = filters.groupBy === 'product' ? formatGrouped ? identity.name : `${identity.name}${line.code ? ` · ${line.code}` : ''}` : groupedPath.join(' / ');
      if (!groups.has(key)) groups.set(key, blank(key, label, groupedPath));
      if (formatGrouped) {
        const group = groups.get(key);
        group.codes ||= [];
        if (line.code && !group.codes.includes(String(line.code))) group.codes.push(String(line.code));
      }
      add(groups.get(key), line, category); add(totals, line, category);
      if (hierarchyTree) {
        let node = hierarchyTree; add(node, line, category);
        for (let depth = 1; depth <= path.length; depth++) {
          const name = path[depth - 1];
          if (!node.children.has(name)) node.children.set(name, nodeFor(path.slice(0, depth)));
          node = node.children.get(name); add(node, line, category);
        }
        if (!node.products.has(identity.key)) node.products.set(identity.key, { ...blank(identity.key,
          identity.format ? identity.name : `${identity.name}${line.code ? ` · ${line.code}` : ''}`, path), kind: 'product' });
        const product = node.products.get(identity.key);
        if (identity.format) {
          product.codes ||= [];
          if (line.code && !product.codes.includes(String(line.code))) product.codes.push(String(line.code));
        }
        add(product, line, category);
      }
    }
  }
  function serializeNode(node) {
    const { children, products, ...values } = node;
    return { ...finish(values), kind: 'hierarchy', children: [...children.values()].map(serializeNode), products: [...products.values()].map(finish) };
  }
  function finish(row) {
    const denominator = row.missingSales ? null : row.netSales;
    const metric = value => ({ netSales: round(value), percent: denominator > 0 ? round(value / denominator * 100) : null });
    const recurring = WINDOWS.reduce((n, days) => n + row.windows[days].netSales, 0);
    return { ...row, ...(row.codes ? { codes: row.codes.sort(), label: `${row.label} · ${row.codes.join(' / ')}` } : {}), netSales: denominator === null ? null : round(denominator), units: round(row.units),
      windows: Object.fromEntries(WINDOWS.map(days => [days, { days, ...metric(row.windows[days].netSales) }])),
      recurring: metric(recurring), withoutRecent: metric(row.withoutRecent.netSales), unclassified: metric(row.unclassified.netSales) };
  }
  const salesCoverage = recurrence.coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'sales');
  const historyCoverage = recurrence.coverageFor(coverage, report.locationIds, addDays(report.period.from, -90), report.period.to);
  const paymentCoverage = recurrence.coverageFor(coverage, report.locationIds, report.period.from, report.period.to, 'payment-details');
  return { definitionVersion: VERSION, identityDefinitionVersion: recurrence.VERSION, scope: report.scope, period: report.period,
    asOf, identityAsOf: report.asOf, filters, windows: WINDOWS, totals: finish(totals),
    rows: [...groups.values()].map(row => ({ ...finish(row), kind: filters.groupBy })).sort((a, b) => (b.netSales || 0) - (a.netSales || 0) || a.label.localeCompare(b.label, 'es')),
    ...(hierarchyTree ? { hierarchyTree: serializeNode(hierarchyTree) } : {}),
    status: !groups.size ? salesCoverage.complete ? 'no_activity' : 'no_data' : warnings.length || report.eligibilityPartial || totals.missingSales || !salesCoverage.complete || !historyCoverage.complete || !paymentCoverage.complete ? 'partial' : 'complete',
    coverage: { sales: salesCoverage, history: historyCoverage, payments: paymentCoverage }, linkage: purchases.linkage,
    monetaryBasis: 'Venta neta de las líneas TotEat después de descuentos, sin IVA, con la misma base del análisis de ventas. No se usa el importe MercadoPago como venta de producto.',
    definition: 'Cada venta se asigna una sola vez según la compra anterior más reciente del mismo medio de pago en otra fecha local: 1–15, 16–30, 31–60 o 61–90 días. El antecedente puede ser de cualquier producto y monto, dentro de la cafetería seleccionada; Todas considera la red.',
    denominator: 'Venta neta total de cada fila, incluida la venta sin vínculo identificable. Los tramos son excluyentes y se pueden sumar.',
    warnings: [...new Set([...report.warnings, ...warnings,
      ...(!historyCoverage.complete ? ['Historial de 90 días incompleto: los tramos reflejan antecedentes observados y son provisionales. Sin antecedente observado no significa cliente nuevo.'] : []),
      ...(totals.missingSales ? ['Hay líneas sin venta neta disponible; su cantidad se incluye y los totales afectados se muestran sin importe.'] : [])])] };
}
module.exports = { VERSION, WINDOWS, selection, productOptions, previousDate, buildProductRecurrence };
