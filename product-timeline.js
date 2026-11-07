const { addDays } = require('./network-sales');
const { validDate, coverageFor } = require('./recurrence');
const { classifySalesBar } = require('./sales-insight-filters');
const VERSION = 'product-timeline-v1';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const eligible = line => !line.isExtra && !line.extraHierarchyId && !line.isComponent && !line.parentLineId;
const pathFor = line => line.categoryPath?.length ? line.categoryPath : [line.categoryName || line.hierarchyName || 'Sin jerarquía'];
const prefix = (path, selected) => selected.every((part, i) => path[i] === part);
const round = number => Number(number.toFixed(2));
function periodFor(query, today) {
  const mode = query.period || 'last-30-days';
  let from = today, to = today;
  if (mode === 'last-30-days') { to = addDays(today, -1); from = addDays(to, -29); }
  else if (mode === 'current-week') from = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  else if (mode === 'current-month') from = `${today.slice(0, 7)}-01`;
  else if (mode === 'custom') { from = query.dateFrom; to = query.dateTo; }
  else if (mode !== 'today') fail('Selecciona un período válido.');
  if (!validDate(from) || !validDate(to) || from > to || to > today || (Date.parse(to) - Date.parse(from)) / 86400000 > 3660) {
    fail('Selecciona fechas válidas, en orden, no futuras y con un máximo de diez años.');
  }
  return { from, to, mode };
}
function selection(query = {}) {
  const list = (value, name, limit = 1000) => {
    let items;
    try { items = Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch { fail(`La selección de ${name} no es válida.`); }
    if (!Array.isArray(items) || items.length > limit || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)) fail(`La selección de ${name} no es válida.`);
    return [...new Set(items)];
  };
  const mode = query.mode || 'all', grain = query.grain || 'daily', bar = query.bar || 'all';
  if (!['all', 'products', 'product-hierarchy', 'ingredients', 'ingredient-hierarchy'].includes(mode)
    || !['daily', 'weekly', 'monthly'].includes(grain) || !['all', 'hot', 'cold', 'other'].includes(bar)) fail('Selecciona filtros válidos para el reporte.');
  if (query.groupFormats !== undefined && ![true, false, 'true', 'false'].includes(query.groupFormats)) fail('La agrupación de tamaños no es válida.');
  const products = list(query.products, 'productos'), ingredients = list(query.ingredients, 'ingredientes');
  const hierarchy = list(query.hierarchy, 'jerarquía', 20);
  if (mode === 'products' && !products.length) fail('Selecciona al menos un producto.');
  if (mode === 'ingredients' && !ingredients.length) fail('Selecciona al menos un ingrediente.');
  if (mode === 'ingredient-hierarchy' && !hierarchy.length) fail('Selecciona una jerarquía de ingredientes.');
  return { mode, grain, bar, products, ingredients, hierarchy, groupFormats: query.groupFormats === true || query.groupFormats === 'true' };
}
function identity(line, groupFormats) {
  const path = pathFor(line), bar = line.bar || classifySalesBar({ name: line.name, hierarchyPath: path });
  const beverage = ['hot', 'cold'].includes(bar) || path.some(part => normalize(part) === 'barra cafe');
  const name = line.name || line.code || 'Sin nombre';
  const match = groupFormats && beverage ? name.match(/\s*\(\s*(CL|GR|XTR|M|G|X)\s*\)\s*$/i) : null;
  const label = match ? name.slice(0, match.index).trim() : name;
  return { key: match ? JSON.stringify([bar, path, normalize(label).replace(/\(iced?\)/g, '(iced)')]) : String(line.code || name),
    label, format: match?.[1].toUpperCase() || null };
}
function optionsFor(products, ingredients) {
  const hierarchies = values => {
    const result = new Map();
    for (const item of values) for (const path of item.hierarchyPaths || [item.categoryPath || []]) {
      for (let depth = 1; depth <= path.length; depth++) {
        const selected = path.slice(0, depth); result.set(JSON.stringify(selected), { path: selected, label: selected.join(' / ') });
      }
    }
    return [...result.values()].sort((a, b) => a.label.localeCompare(b.label, 'es'));
  };
  const groups = new Map();
  for (const product of products) {
    const key = identity(product, true), group = groups.get(key.key) || { code: product.code, name: key.label, codes: [], formats: [] };
    group.codes.push(product.code); if (key.format && !group.formats.includes(key.format)) group.formats.push(key.format);
    groups.set(key.key, group);
  }
  const sort = items => items.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { products: sort([...products]), groupedProducts: sort([...groups.values()]), ingredients: sort([...ingredients]),
    productHierarchies: hierarchies(products), ingredientHierarchies: hierarchies(ingredients) };
}
function bucketsFor(period, grain) {
  const buckets = [], byDate = new Map();
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
    const key = grain === 'monthly' ? `${date.slice(0, 7)}-01` : grain === 'weekly'
      ? addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)) : date;
    if (buckets.at(-1)?.key !== key) buckets.push({ key, from: date, to: date });
    else buckets.at(-1).to = date;
    byDate.set(date, buckets.length - 1);
  }
  return { buckets, byDate };
}
function buildReport({ orders, period, scope, locationIds, coverage = [], ingredientsFor = () => [], barFor = line => line.bar,
  referenceFor = () => null, query = {}, warnings = [], bucketConfig = null }) {
  const filters = selection(query), selectedProducts = new Set(filters.products.map(code => code.toUpperCase()));
  const selectedIngredients = new Set(filters.ingredients.map(code => code.toUpperCase()));
  const { buckets, byDate } = bucketConfig || bucketsFor(period, filters.grain), groups = new Map();
  const blank = () => ({ units: 0, netSales: 0, missingSales: 0 });
  const referenceBlank = () => ({ referenceUnits: 0, referenceNetPrice: 0, referenceNetCost: 0,
    referencePriceMin: null, referencePriceMax: null, referencePriceComplete: true, referenceCostComplete: true,
    referenceIssues: [], referenceFallbacks: [] });
  const totals = { ...blank(), ...referenceBlank() }, periods = buckets.map(bucket => ({ ...bucket, ...blank() }));
  const add = (target, line, amount) => {
    target.units += Number.isFinite(line.quantity) ? line.quantity : 0;
    if (Number.isFinite(amount)) target.netSales += amount; else target.missingSales++;
  };
  const addReference = (target, line, reference) => {
    const quantity = Number(line.quantity);
    if (!(quantity > 0)) return;
    target.referenceUnits += quantity;
    if (!(reference?.priceGross > 0)) target.referencePriceComplete = false;
    else {
      target.referencePriceMin = Math.min(target.referencePriceMin ?? reference.priceGross, reference.priceGross);
      target.referencePriceMax = Math.max(target.referencePriceMax ?? reference.priceGross, reference.priceGross);
      target.referenceNetPrice += quantity * reference.priceGross / 1.19;
    }
    if (!Number.isFinite(reference?.costNet)) {
      target.referenceCostComplete = false;
      const issue = reference?.costReason || 'Costo neto no disponible';
      if (!target.referenceIssues.includes(issue)) target.referenceIssues.push(issue);
    }
    else {
      target.referenceNetCost += quantity * reference.costNet;
      for (const code of reference.costFallbacks || []) if (!target.referenceFallbacks.includes(code)) target.referenceFallbacks.push(code);
    }
  };
  for (const order of orders) {
    if (!locationIds.includes(order.locationId) || !byDate.has(order.date)) continue;
    if (query.serverToday === order.date && order.dateTime && order.dateTime > `${order.date}T${query.serverCutoff || '23:59:59'}`) continue;
    const index = byDate.get(order.date);
    for (const original of order.lines || []) {
      if (!eligible(original)) continue;
      const line = { ...original, bar: barFor(original, order.date) || 'other' }, code = String(line.code || '').toUpperCase();
      if (filters.bar !== 'all' && filters.bar !== line.bar) continue;
      if (filters.mode === 'products' && !selectedProducts.has(code)) continue;
      if (filters.mode === 'product-hierarchy' && !prefix(pathFor(line), filters.hierarchy)) continue;
      if (['ingredients', 'ingredient-hierarchy'].includes(filters.mode)) {
        const ingredients = ingredientsFor(code, order.date);
        if (!ingredients.some(item => filters.mode === 'ingredients' ? selectedIngredients.has(item.code.toUpperCase())
          : (item.hierarchyPaths || []).some(path => prefix(path, filters.hierarchy)))) continue;
      }
      const amount = Object.hasOwn(line, 'productNetSales') ? line.productNetSales : line.netSales;
      if (!line.quantity && !amount) continue;
      const product = identity(line, filters.groupFormats);
      if (!groups.has(product.key)) {
        if ((groups.size + 1) * buckets.length > 500000) fail('La tabla es demasiado grande. Reduce el período o selecciona menos productos.');
        groups.set(product.key, { key: product.key, label: product.label, codes: [], ...blank(), ...referenceBlank(), points: buckets.map(blank) });
      }
      const row = groups.get(product.key); if (code && !row.codes.includes(code)) row.codes.push(code);
      add(row, line, amount); add(row.points[index], line, amount); add(periods[index], line, amount); add(totals, line, amount);
      const reference = referenceFor(line, order.locationId);
      addReference(row, line, reference); addReference(totals, line, reference);
    }
  }
  const finish = value => ({ ...value, units: round(value.units), netSales: value.missingSales ? null : round(value.netSales) });
  const finishReference = value => ({
    priceGrossMin: value.referenceUnits > 0 && value.referencePriceComplete ? value.referencePriceMin : null,
    priceGrossMax: value.referenceUnits > 0 && value.referencePriceComplete ? value.referencePriceMax : null,
    marginPercent: value.referenceUnits > 0 && value.referencePriceComplete && value.referenceCostComplete && value.referenceNetPrice > 0
      ? round((value.referenceNetPrice - value.referenceNetCost) / value.referenceNetPrice * 100) : null,
    referenceIssues: value.referenceIssues, referenceFallbacks: value.referenceFallbacks
  });
  const finishSeries = value => {
    const { referenceUnits, referenceNetPrice, referenceNetCost, referencePriceMin, referencePriceMax,
      referencePriceComplete, referenceCostComplete, referenceIssues, referenceFallbacks, ...publicValues } = value;
    return { ...finish(publicValues), ...finishReference(value) };
  };
  const salesCoverage = coverageFor(coverage, locationIds, period.from, period.to, 'sales');
  return { definitionVersion: VERSION, period, scope, filters,
    referenceDate: query.serverToday || period.to,
    series: [...groups.values()].map(row => ({ ...finishSeries(row), codes: row.codes.sort(), points: row.points.map(finish) }))
      .sort((a, b) => (b.netSales || 0) - (a.netSales || 0) || a.label.localeCompare(b.label, 'es')),
    periods: periods.map(finish), totals: finishSeries(totals), coverage: salesCoverage,
    definition: `Unidades y venta neta de los productos vendidos, después de descuentos y sin IVA. Precio público con IVA y costo neto vigentes al ${query.serverToday || period.to}; precio neto = precio público / 1,19; margen = (precio neto − costo neto) / precio neto. En formatos agrupados y varias cafeterías, el margen pondera las unidades positivas observadas en el período. Si falta un precio o costo comparable, el margen se muestra sin dato. Las selecciones de ingredientes incluyen la venta completa del producto una sola vez, según las recetas vigentes en la fecha de venta, incluidas subrecetas; no representan consumo de ingredientes. Semanas de lunes a domingo y meses calendario, recortados al período consultado.`,
    warnings: [...new Set([...warnings, ...(totals.referenceFallbacks.length ? [`${totals.referenceFallbacks.length} insumos sin compra compatible usan el costo neto del maestro vigente para estimar el margen: ${totals.referenceFallbacks.slice(0, 12).join(', ')}${totals.referenceFallbacks.length > 12 ? ' y otros' : ''}.`] : []),
      ...(!salesCoverage.complete ? ['La cobertura de ventas no está confirmada para todo el período. Los ceros indican ausencia de ventas registradas, no certifican que el local estuvo sin actividad.'] : []),
      ...(totals.missingSales ? ['Hay líneas sin importe disponible: sus unidades se incluyen y el importe afectado se muestra sin dato.'] : [])])] };
}
module.exports = { VERSION, periodFor, selection, identity, optionsFor, bucketsFor, buildReport };
