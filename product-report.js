const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const round = value => Number(value.toFixed(2));
const pathFor = line => line.categoryPath?.length ? line.categoryPath : [line.categoryName || line.hierarchyName || 'Sin jerarquía'];
const eligible = line => !line.isExtra && !line.extraHierarchyId && !line.isComponent && !line.parentLineId;
const lineSales = line => Object.hasOwn(line, 'productNetSales') ? line.productNetSales : line.netSales;
function reportLine(line, includeExtras) {
  if (eligible(line)) return line;
  if (!includeExtras || line.isComponent || line.parentLineId || !(line.isExtra || line.extraHierarchyId)) return null;
  return { ...line, quantity: 0, extraUnits: line.quantity, categoryPath: ['Extras y adicionales'] };
}
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
function productOptions(orders, { includeExtras = false } = {}) {
  const products = new Map(), productLines = new Map(), hierarchies = new Map();
  for (const order of orders) for (const original of order.lines || []) {
    const line = reportLine(original, includeExtras); if (!line) continue;
    const path = pathFor(line);
    if (line.code) { products.set(String(line.code), { code: String(line.code), name: line.name || String(line.code) }); productLines.set(String(line.code), line); }
    for (let depth = 1; depth <= path.length; depth++) { const prefix = path.slice(0, depth); hierarchies.set(JSON.stringify(prefix), { path: prefix, label: prefix.join(' / ') }); }
  }
  const grouped = new Map();
  for (const [code, line] of productLines) {
    const identity = productIdentity(line, true);
    if (!grouped.has(identity.key)) grouped.set(identity.key, { name: identity.name, codes: [], formats: [] });
    const group = grouped.get(identity.key); group.codes.push(code);
    if (identity.format && !group.formats.includes(identity.format)) group.formats.push(identity.format);
  }
  const groupedProducts = [...grouped.values()].map(group => ({ ...group, code: group.codes.sort()[0], formats: ['CL', 'GR', 'XTR'].filter(format => group.formats.includes(format)) }));
  return { products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    groupedProducts: groupedProducts.sort((a, b) => a.name.localeCompare(b.name, 'es')),
    hierarchies: [...hierarchies.values()].sort((a, b) => a.label.localeCompare(b.label, 'es')) };
}
function selectOrders(orders, locationIds, period, asOf) {
  return orders.filter(order => locationIds.includes(order.locationId) && order.date >= period.from && order.date <= period.to && (!order.dateTime || order.dateTime <= asOf));
}
function aggregateProductReport(orders, filters, categories, classify, metricFields, { includeExtras = false } = {}) {
  const productCodes = new Set(filters.products);
  const blank = (key, label, path = []) => ({ key, label, path, netSales: 0, units: 0, ...(includeExtras ? { extraUnits: 0 } : {}), missingSales: 0, buckets: Object.fromEntries(categories.map(key => [key, 0])) });
  const totals = blank('total', 'Total selección'), groups = new Map();
  const nodeFor = path => ({ ...blank(JSON.stringify(path), path.at(-1) || 'Total selección', path), children: new Map(), products: new Map() });
  const hierarchyTree = filters.groupBy === 'hierarchy' ? nodeFor([]) : null;
  function add(row, line, category) {
    const amount = lineSales(line); row.units += Number.isFinite(line.quantity) ? line.quantity : 0;
    if (includeExtras) row.extraUnits += Number.isFinite(line.extraUnits) ? line.extraUnits : 0;
    if (!Number.isFinite(amount)) { row.missingSales++; return; }
    row.netSales += amount; row.buckets[category] += amount;
  }
  function codesFor(row, line) { row.codes ||= []; if (line.code && !row.codes.includes(String(line.code))) row.codes.push(String(line.code)); }
  for (const order of orders) {
    const category = classify(order);
    for (const original of order.lines || []) {
      const line = reportLine(original, includeExtras); if (!line) continue;
      const path = pathFor(line);
      if (productCodes.size && !productCodes.has(String(line.code))) continue;
      if (!filters.hierarchy.every((part, index) => path[index] === part)) continue;
      if (!line.quantity && !line.extraUnits && !lineSales(line)) continue;
      const groupedPath = path.slice(0, filters.level), identity = productIdentity(line, filters.groupFormats);
      const productLabel = identity.format ? identity.name : `${identity.name}${line.code ? ` · ${line.code}` : ''}`;
      const key = filters.groupBy === 'product' ? identity.key : JSON.stringify(groupedPath);
      if (!groups.has(key)) groups.set(key, blank(key, filters.groupBy === 'product' ? productLabel : groupedPath.join(' / '), groupedPath));
      if (filters.groupBy === 'product' && identity.format) codesFor(groups.get(key), line);
      add(groups.get(key), line, category); add(totals, line, category);
      if (hierarchyTree) {
        let node = hierarchyTree; add(node, line, category);
        for (let depth = 1; depth <= path.length; depth++) {
          const name = path[depth - 1]; if (!node.children.has(name)) node.children.set(name, nodeFor(path.slice(0, depth)));
          node = node.children.get(name); add(node, line, category);
        }
        if (!node.products.has(identity.key)) node.products.set(identity.key, { ...blank(identity.key, productLabel, path), kind: 'product' });
        const product = node.products.get(identity.key); if (identity.format) codesFor(product, line); add(product, line, category);
      }
    }
  }
  function finish(row) {
    const { buckets, ...values } = row, denominator = row.missingSales ? null : row.netSales;
    const metric = value => ({ netSales: round(value), percent: denominator > 0 ? round(value / denominator * 100) : null });
    return { ...values, ...(row.codes ? { codes: row.codes.sort(), label: `${row.label} · ${row.codes.join(' / ')}` } : {}),
      netSales: denominator === null ? null : round(denominator), units: round(row.units), ...(includeExtras ? { extraUnits: round(row.extraUnits) } : {}), ...metricFields(buckets, metric, { missingSales: row.missingSales }) };
  }
  function serialize(node) { const { children, products, ...values } = node; return { ...finish(values), kind: 'hierarchy', children: [...children.values()].map(serialize), products: [...products.values()].map(finish) }; }
  return { totals: finish(totals), rows: [...groups.values()].map(row => ({ ...finish(row), kind: filters.groupBy }))
    .sort((a, b) => (b.netSales || 0) - (a.netSales || 0) || a.label.localeCompare(b.label, 'es')),
  ...(hierarchyTree ? { hierarchyTree: serialize(hierarchyTree) } : {}) };
}
module.exports = { selection, productOptions, productIdentity, selectOrders, aggregateProductReport };
