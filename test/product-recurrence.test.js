const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../recurrence');
const { addDays } = require('../network-sales');
const { buildProductRecurrence: build, productOptions, selection } = require('../product-recurrence');
const { createRecurrenceService } = require('../recurrence-service');

const coverage = ['mercadopago', 'sales', 'payment-details'].map(source => ({ source, locationId: 'a', from: '2026-01-01', to: '2026-10-31', complete: true }));
const mp = (id, date, card = '1111', locationId = 'a', amount = 1190) => ({ locationId, data: { SOURCE_ID: id, TRANSACTION_DATE: `${date}T10:00:00`, TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: amount,
  CARD_INITIAL_NUMBER: card ? '123456' : null, LAST_FOUR_DIGITS: card, STATUS: 'approved', REFUNDED_AMOUNT: 0 } });
const line = (code = 'P1', amount = 1000, quantity = 1, path = ['Barra Cafe', 'Calientes']) => ({ code, name: code === 'P1' ? 'Café' : 'Sandwich', categoryPath: path, quantity, netSales: amount });
const order = (id, date = '2026-10-31', lines = [line()], extra = {}) => ({ orderKey: id, locationId: 'a', date, dateTime: `${date}T10:00:00`, time: '10:00', paymentPaid: 1190,
  netSales: lines.reduce((n, l) => n + (l.netSales || 0), 0), explicitPaymentIds: [id], lines, ...extra });
function state(records, extra = {}, query = {}) {
  return r.buildReport({ records, locationIds: ['a'], scope: { label: 'Tienda A', locations: [{ id: 'a', name: 'Tienda A' }] }, today: '2026-10-31', cutoff: '23:59:59', coverage, secret: 'fixture', ...extra },
    { period: 'custom', dateFrom: '2026-10-31', dateTo: '2026-10-31', ...query });
}
test('exclusive recurrence buckets include all boundaries and partition total product sales', () => {
  const records = [], orders = [];
  for (const age of [1, 15, 16, 30, 31, 60, 61, 90, 91]) {
    const card = String(age).padStart(4, '1'), id = `now-${age}`;
    records.push(mp(`old-${age}`, addDays('2026-10-31', -age), card, 'a', 1), mp(id, '2026-10-31', card));
    orders.push(order(id));
  }
  const result = build(state(records), orders, coverage);
  assert.equal(result.totals.netSales, 9000); assert.equal(result.totals.units, 9);
  assert.deepEqual(result.windows.map(h => result.totals.windows[h].netSales), [2000, 2000, 2000, 2000]);
  assert.equal(result.totals.withoutRecent.netSales, 1000); assert.equal(result.totals.unclassified.netSales, 0);
  assert.equal(result.totals.recurring.netSales, 8000); assert.equal(result.totals.recurring.percent, 88.89);
  assert.equal(result.status, 'complete'); assert.equal(result.rows.length, 1);
  assert.ok(!JSON.stringify(result).includes('123456')); assert.ok(!JSON.stringify(result).includes('instrumentKey'));
});
test('the latest earlier date wins; same-day and future purchases cannot establish a previous visit', () => {
  const records = [mp('older', '2026-09-01'), mp('recent', '2026-10-30'), mp('current', '2026-10-31'),
    mp('same1', '2026-10-31', '2222'), mp('same2', '2026-10-31', '2222'), mp('future', '2026-11-01', '2222')];
  const result = build(state(records), [order('current'), order('same1'), order('same2')], coverage);
  assert.equal(result.totals.windows[15].netSales, 1000); assert.equal(result.totals.windows[60].netSales, 0);
  assert.equal(result.totals.withoutRecent.netSales, 2000);
});
test('cup sizes aggregate sales and units before calculating recurrence, preserving selection and distinct recipes', () => {
  const sized = (code, size, amount, quantity = 1, name = 'Cappuccino', path) => ({ ...line(code, amount, quantity, path), name: `${name} (${size})` });
  const records = [mp('prior', '2026-10-01'), mp('cl', '2026-10-31'), mp('gr', '2026-10-31', '2222'), mp('xtr', '2026-10-31', null)];
  const orders = [order('cl', undefined, [sized('CL', 'CL', 1000)]), order('gr', undefined, [sized('GR', 'GR', 2000, 2)]), order('xtr', undefined, [sized('XTR', 'XTR', 3000, 3)])];
  const snapshot = state(records), separate = build(snapshot, orders, coverage, { groupBy: 'product' });
  const options = productOptions(orders);
  assert.equal(options.products.length, 3); assert.equal(options.groupedProducts.length, 1);
  assert.deepEqual(options.groupedProducts[0], { name: 'Cappuccino', codes: ['CL', 'GR', 'XTR'], formats: ['CL', 'GR', 'XTR'], code: 'CL' });
  const grouped = build(snapshot, orders, coverage, { groupBy: 'product', groupFormats: 'true' });
  assert.equal(separate.rows.length, 3); assert.equal(grouped.rows.length, 1);
  assert.equal(grouped.rows[0].label, 'Cappuccino · CL / GR / XTR');
  assert.equal(grouped.rows[0].netSales, 6000); assert.equal(grouped.rows[0].units, 6);
  assert.equal(grouped.rows[0].windows[30].netSales, 1000); assert.equal(grouped.rows[0].windows[30].percent, 16.67);
  assert.equal(grouped.rows[0].withoutRecent.netSales, 2000); assert.equal(grouped.rows[0].unclassified.netSales, 3000);
  assert.deepEqual(grouped.totals, separate.totals);
  const selected = build(snapshot, orders, coverage, { groupBy: 'product', groupFormats: true, products: '["CL","GR"]' });
  assert.equal(selected.rows[0].netSales, 3000); assert.equal(selected.rows[0].units, 3); assert.deepEqual(selected.rows[0].codes, ['CL', 'GR']);
  const distinct = build(snapshot, [order('cl', undefined, [sized('A', 'CL', 1000, 1, 'Matcha (hot)'), sized('B', 'GR', 1000, 1, 'Matcha (iced)'), sized('C', 'XTR', 1000, 1, 'Matcha (iced)', ['Retail'])])], coverage, { groupBy: 'product', groupFormats: true });
  assert.equal(distinct.rows.length, 3);
  const hierarchy = build(snapshot, orders, coverage, { groupFormats: true });
  assert.equal(hierarchy.totals.netSales, 6000); assert.equal(hierarchy.rows.length, 1);
});
test('history ignores product, hierarchy and amount filters; percentages use all selected sales including unknown identity', () => {
  const records = [mp('prior', '2026-10-01', '1111', 'a', 1), mp('current', '2026-10-31'), mp('unknown', '2026-10-31', null)];
  const orders = [order('current', undefined, [line(), line('P2', 2000, 2, ['Retail'])]), order('unknown')];
  const result = build(state(records), orders, coverage, { groupBy: 'product', products: '["P1"]', hierarchy: '["Barra Cafe"]' });
  assert.equal(result.rows.length, 1); assert.equal(result.totals.units, 2); assert.equal(result.totals.netSales, 2000);
  assert.equal(result.totals.windows[30].netSales, 1000); assert.equal(result.totals.windows[30].percent, 50);
  assert.equal(result.totals.unclassified.netSales, 1000); assert.equal(result.totals.unclassified.percent, 50);
});
test('filtering products cannot resolve ambiguous whole-order links or divided payments', () => {
  const records = [mp('p', '2026-10-31')];
  const orders = [order('o1', undefined, [line()], { explicitPaymentIds: [] }), order('o2', undefined, [line('P2')], { explicitPaymentIds: [] })];
  const result = build(state(records), orders, coverage, { groupBy: 'product', products: '["P1"]' });
  assert.equal(result.totals.unclassified.netSales, 1000); assert.equal(result.totals.withoutRecent.netSales, 0);
  const split = build(state(records), [order('split', undefined, [line()], { explicitPaymentIds: [], paymentDuePartial: true })], coverage);
  assert.equal(split.totals.unclassified.netSales, 1000);
});
test('hierarchy detail partitions each parent into subhierarchies and directly assigned products from the same classification', () => {
  const lines = [
    { ...line('CL', 1000, 1, ['Barra', 'Calientes', 'Café']), name: 'Cappuccino (CL)' },
    { ...line('GR', 2000, 2, ['Barra', 'Calientes', 'Café']), name: 'Cappuccino (GR)' },
    line('DIRECT', 500, 1, ['Barra']), line('ICED', 1500, 1, ['Barra', 'Frías'])
  ];
  const snapshot = state([mp('prior', '2026-10-01'), mp('sale', '2026-10-31')]);
  const orders = [order('sale', undefined, lines), order('unknown', undefined, [line('RETAIL', 2000, 1, ['Retail'])])];
  const report = build(snapshot, orders, coverage, { groupFormats: true });
  assert.equal(report.totals.netSales, 7000); assert.equal(report.hierarchyTree.netSales, 7000);
  const barra = report.hierarchyTree.children.find(node => node.label === 'Barra');
  assert.equal(barra.netSales, 5000); assert.equal(barra.units, 5); assert.equal(barra.windows[30].percent, 100);
  assert.equal(barra.children.length, 2); assert.equal(barra.products.length, 1); assert.equal(barra.products[0].netSales, 500);
  const leaf = barra.children.find(node => node.label === 'Calientes').children[0];
  assert.deepEqual(leaf.path, ['Barra', 'Calientes', 'Café']); assert.equal(leaf.children.length, 0); assert.equal(leaf.products.length, 1);
  assert.equal(leaf.products[0].label, 'Cappuccino · CL / GR'); assert.equal(leaf.products[0].netSales, 3000); assert.equal(leaf.products[0].units, 3);
  function reconciles(node) {
    const rows = [...node.children, ...node.products];
    assert.ok(Math.abs(node.netSales - rows.reduce((n, row) => n + row.netSales, 0)) < 0.01);
    for (const days of [15, 30, 60, 90]) assert.ok(Math.abs(node.windows[days].netSales - rows.reduce((n, row) => n + row.windows[days].netSales, 0)) < 0.01);
    assert.equal(node.units, rows.reduce((n, row) => n + row.units, 0)); node.children.forEach(reconciles);
  }
  reconciles(report.hierarchyTree);
  const filtered = build(snapshot, orders, coverage, { level: 2, hierarchy: '["Barra","Calientes"]', groupFormats: true });
  assert.equal(filtered.hierarchyTree.netSales, 3000); assert.equal(filtered.hierarchyTree.children.length, 1);
  assert.equal(filtered.hierarchyTree.children[0].children.length, 1); assert.equal(filtered.rows[0].kind, 'hierarchy');
});
test('selected location controls the entire history, while all locations combine previous purchases', () => {
  const records = [mp('previous', '2026-10-30', '1111', 'b', 1), mp('current', '2026-10-31')];
  const local = build(state(records), [order('current')], coverage);
  assert.equal(local.totals.withoutRecent.netSales, 1000);
  const bothCoverage = [...coverage, ...coverage.map(c => ({ ...c, locationId: 'b' }))];
  const network = build(state(records, { locationIds: ['a', 'b'], coverage: bothCoverage }), [order('current')], bothCoverage);
  assert.equal(network.totals.windows[15].netSales, 1000);
});
test('sales beyond the MP cutoff stay in total sales and remain unclassified; gaps mark observed percentages provisional', () => {
  const limited = coverage.map(c => c.source === 'mercadopago' ? { ...c, to: '2026-10-30', through: '2026-10-30T23:59:59' } : c);
  const result = build(state([mp('old', '2026-10-01'), mp('new', '2026-10-31')], { coverage: limited }), [order('new')], limited);
  assert.equal(result.totals.netSales, 1000); assert.equal(result.totals.unclassified.netSales, 1000);
  assert.equal(result.identityAsOf, '2026-10-30T23:59:59'); assert.equal(result.asOf, '2026-10-31T23:59:59'); assert.equal(result.status, 'partial');
  assert.ok(result.warnings.some(w => w.includes('Historial de 90 días incompleto')));
});
test('extras and component quantities are excluded; credit adjustments retain signed totals without invented recurrence', () => {
  const lines = [line(), { ...line('EX', 100, 3), isExtra: true }, { ...line('CHILD', 0, 5), isComponent: true }];
  const result = build(state([mp('sale', '2026-10-31')]), [order('sale', undefined, lines), order('credit', undefined, [line('P1', -200, -0.5)], { reversalSignals: ['credit'] })], coverage);
  assert.equal(result.totals.netSales, 800); assert.equal(result.totals.units, 0.5);
  assert.equal(result.totals.withoutRecent.netSales, 1000); assert.equal(result.totals.unclassified.netSales, -200);
});
test('unavailable product amounts are not represented as zero sales, and grouping preserves hierarchy prefixes', () => {
  const orders = [order('a', undefined, [{ ...line(), productNetSales: null }]), order('b', undefined, [line('P2', 1000, 2, ['Barra Cafe', 'Frías'])])];
  const result = build(state([]), orders, coverage, { level: 2 });
  assert.equal(result.totals.netSales, null); assert.equal(result.totals.units, 3); assert.equal(result.totals.unclassified.percent, null);
  assert.equal(result.rows.length, 2); assert.equal(result.rows.find(row => row.path[1] === 'Calientes').netSales, null);
  const options = productOptions(orders); assert.equal(options.products.length, 2); assert.equal(options.hierarchies.length, 3);
  assert.throws(() => selection({ products: 'broken' }), { status: 400 }); assert.throws(() => selection({ level: 0.5 }), { status: 400 });
});
test('service rejects sources changed during product generation and uses both versions without changing the customer snapshot', async () => {
  let version = 1;
  const source = { records: [mp('sale', '2026-10-31')], today: '2026-10-31', cutoff: '12:00:00', coverage, locationIds: ['a'], scope: { locations: [] } };
  const service = createRecurrenceService({ readSource: () => source, fingerprint: () => ({ mp: 1, purchases: version }), readOrders: () => { version++; return { orders: [order('sale')] }; } });
  await assert.rejects(service.request('product-generate', { period: 'custom', dateFrom: '2026-10-31', dateTo: '2026-10-31' }), { status: 409 });
  await assert.rejects(service.request('product-options'), { status: 409 });
});
