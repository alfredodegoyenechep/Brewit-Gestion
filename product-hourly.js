const { identity, selection } = require('./product-timeline');

const BLOCKS = Array.from({ length: 8 }, (_, index) => {
  const start = 7 + 2 * index;
  return { start, label: `${String(start).padStart(2, '0')}:00–${String(start + 2).padStart(2, '0')}:00` };
});
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const eligible = line => !line.isExtra && !line.extraHierarchyId && !line.isComponent && !line.parentLineId;
const round = value => Number(value.toFixed(2));

function buildReport({ orders, period, scope, locationIds, locations, coverage, query = {}, barFor }) {
  const filters = selection(query);
  const stores = locations.filter(store => locationIds.includes(store.id));
  const cells = new Map();
  for (const store of stores) for (const block of BLOCKS) cells.set(`${store.id}:${block.start}`, new Map());
  let missingSales = 0;
  for (const order of orders) {
    if (!locationIds.includes(order.locationId) || order.date < period.from || order.date > period.to) continue;
    if (query.serverToday === order.date && order.dateTime > `${order.date}T${query.serverCutoff || '23:59:59'}`) continue;
    const hour = Number((order.time || order.dateTime?.slice(11, 16) || '').slice(0, 2));
    const block = BLOCKS.find(item => hour >= item.start && hour < item.start + 2);
    if (!block) continue;
    const products = cells.get(`${order.locationId}:${block.start}`);
    if (!products) continue;
    for (const original of order.lines || []) {
      if (!eligible(original)) continue;
      const line = { ...original, bar: barFor(original, order.date) || 'other' };
      if (filters.bar !== 'all' && filters.bar !== line.bar) continue;
      const product = identity(line, filters.groupFormats);
      const amount = Object.hasOwn(line, 'productNetSales') ? line.productNetSales : line.netSales;
      if (!line.quantity && !amount) continue;
      let row = products.get(product.key);
      if (!row) { row = { key: product.key, name: product.label, units: 0, netSales: 0, missingSales: 0 }; products.set(product.key, row); }
      row.units += Number.isFinite(line.quantity) ? line.quantity : 0;
      if (Number.isFinite(amount)) row.netSales += amount;
      else { row.missingSales++; missingSales++; }
    }
  }
  if (stores.length > 100) fail('Hay demasiadas cafeterías para mostrar en una sola matriz.');
  return { period, scope, filters: { bar: filters.bar, groupFormats: filters.groupFormats },
    stores, blocks: BLOCKS.map(block => ({ label: block.label, start: block.start,
      stores: stores.map(store => ({ locationId: store.id, products: [...cells.get(`${store.id}:${block.start}`).values()]
        .map(row => ({ ...row, units: round(row.units), netSales: row.missingSales ? null : round(row.netSales) })) })) })),
    coverage,
    warnings: missingSales ? [`${missingSales} línea(s) sin importe: se muestran sus unidades, pero la venta de sus productos queda sin dato.`] : [],
    definition: 'Productos principales vendidos entre las 07:00 y las 23:00, en bloques de dos horas. Unidades y venta neta sin IVA después de descuentos. El top 5 se calcula por cafetería y franja; los formatos agrupados suman sus variantes.' };
}
module.exports = { BLOCKS, buildReport };
