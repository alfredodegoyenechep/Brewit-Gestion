const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductGender: build, genderForOrder } = require('../product-gender');
const { createRecurrenceService } = require('../recurrence-service');
const coverage = ['sales', 'payment-details'].map(source => ({ source, locationId: 'a', from: '2026-01-01', to: '2026-10-31', complete: true }));
const context = { today: '2026-10-31', cutoff: '12:00:00', period: { from: '2026-10-01', to: '2026-10-30' },
  locationIds: ['a'], scope: { location: 'a', label: 'Tienda A' }, coverage };
const line = (code, name, quantity, netSales, categoryPath = ['Barra', 'Café']) => ({ code, name, quantity, netSales, categoryPath });
const order = (key, gender, lines, extra = {}) => ({ orderKey: key, locationId: 'a', date: '2026-10-28', dateTime: '2026-10-28T10:00:00', declaredGender: gender, lines, ...extra });
const fixture = [
  order('m', 'Masculino', [line('CL', 'Cappuccino (CL)', 1, 1000)]),
  order('f', 'Femenino', [line('GR', 'Cappuccino (GR)', 2, 2000)]),
  order('u', null, [line('XTR', 'Cappuccino (XTR)', 3, 3000)], { paymentComment: 'María', nameGenderSegment: 'feminine-associated' })
];
test('gender segments partition selected product sales and calculate weighted percentages after grouping cup sizes', () => {
  const report = build(context, fixture, { groupBy: 'product', groupFormats: true });
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].label, 'Cappuccino · CL / GR / XTR');
  assert.equal(report.totals.netSales, 6000); assert.equal(report.totals.units, 6);
  assert.deepEqual(Object.values(report.totals.genders).map(g => g.netSales), [1000, 2000, 3000]);
  assert.deepEqual(Object.values(report.totals.genders).map(g => g.percent), [16.67, 33.33, 50]);
  assert.deepEqual(report.totals.relativeGender, { masculinePercent: 33.3, femininePercent: 66.7 });
  assert.ok(!JSON.stringify(report).includes('María')); assert.ok(!JSON.stringify(report).includes('paymentComment'));
  const selected = build(context, fixture, { groupBy: 'product', products: '["GR"]' });
  assert.equal(selected.totals.genders.feminine.percent, 100); assert.equal(selected.status, 'complete');
  assert.equal(selected.warnings.length, 0);
});
test('relative M/F uses known sales before rounding and sums to 100 at every hierarchy level', () => {
  const report = build(context, [order('m', 'male', [line('A', 'A', 1, 4291794)]),
    order('f', 'female', [line('B', 'B', 2, 6398387)]), order('u', null, [line('U', 'U', 10, 2237311)])]);
  assert.deepEqual(report.totals.relativeGender, { masculinePercent: 40.1, femininePercent: 59.9 });
  const visit = node => { const r = node.relativeGender;
    assert.equal(r.masculinePercent == null ? r.femininePercent : Number((r.masculinePercent + r.femininePercent).toFixed(1)), r.masculinePercent == null ? null : 100);
    (node.children || []).forEach(visit); (node.products || []).forEach(visit);
  }; visit(report.hierarchyTree);
  const known = build(context, [order('m', 'male', [line('A', 'A', 1, .014)]), order('f', 'female', [line('B', 'B', 1, .026)])]);
  assert.deepEqual(known.totals.relativeGender, { masculinePercent: 35, femininePercent: 65 });
  for (const orders of [[], [fixture[2]], [order('zero', 'male', [line('Z', 'Zero', 1, 0)])],
    [order('missing', 'female', [{ ...line('A', 'A', 1, 0), productNetSales: null }])]]) {
    assert.deepEqual(build(context, orders).totals.relativeGender, { masculinePercent: null, femininePercent: null });
  }
});
test('only declared or explicitly validated gender is used; names, inferred labels and ambiguous declarations remain unknown', () => {
  assert.equal(genderForOrder({ validatedGender: 'female', genderBasis: 'explicit' }), 'feminine');
  assert.equal(genderForOrder({ validatedGender: 'male', genderBasis: 'validated' }), 'masculine');
  assert.equal(genderForOrder({ declaredGender: 'male', validatedGender: 'female', genderBasis: 'manual' }), 'feminine');
  assert.equal(genderForOrder({ declaredGender: 'male', validatedGender: null, genderBasis: 'manual' }), 'unknown');
  for (const data of [
    { paymentComment: 'Pedro', nameGenderSegment: 'masculine-associated' },
    { validatedGender: 'female', genderBasis: 'calibrated', genderConfidence: 1 },
    { declaredGender: 'male', genderAmbiguous: true }, { declaredGender: 'no binario' }, { validatedGender: 'male' }
  ]) assert.equal(genderForOrder(data), 'unknown');
  const report = build(context, [fixture[2]], { groupBy: 'product' });
  assert.equal(report.totals.genders.unknown.percent, 100); assert.equal(report.status, 'partial');
  assert.ok(report.warnings.some(w => w.includes('no aportan género registrado o revisado')));
});
test('every hierarchy includes directly assigned products and reconciles its three segments down to grouped products', () => {
  const report = build(context, [...fixture,
    order('direct', 'female', [line('D', 'Directo', 1, 500, ['Barra'])]),
    order('retail', 'male', [line('R', 'Bolsa', 1, 1500, ['Retail'])])], { groupFormats: true });
  function check(node) {
    const rows = [...node.children, ...node.products];
    assert.equal(rows.reduce((sum, row) => sum + row.netSales, 0), node.netSales);
    assert.equal(rows.reduce((sum, row) => sum + row.units, 0), node.units);
    for (const key of ['masculine', 'feminine', 'unknown']) assert.equal(rows.reduce((sum, row) => sum + row.genders[key].netSales, 0), node.genders[key].netSales);
    node.children.forEach(check);
  }
  check(report.hierarchyTree);
  const barra = report.hierarchyTree.children.find(row => row.label === 'Barra');
  assert.equal(barra.products.length, 1); assert.equal(barra.children[0].products.length, 1);
  assert.equal(barra.children[0].products[0].units, 6);
  const branch = build(context, fixture, { hierarchy: '["Barra","Café"]' }); assert.equal(branch.totals.netSales, 6000);
});
test('gender totals preserve credits, include extras separately, honor location and cutoff, and distinguish missing amounts from zero', () => {
  const orders = [...fixture,
    order('credit', 'masculino', [line('CL', 'Cappuccino (CL)', -1, -500)]),
    order('extra', 'female', [{ ...line('EX', 'Extra', 5, 500), isExtra: true }]),
    order('other-store', 'female', [line('CL', 'Café', 4, 400)], { locationId: 'b' }),
    order('future', 'female', [line('CL', 'Café', 4, 400)], { date: '2026-10-31', dateTime: '2026-10-31T10:00:00' })];
  const report = build(context, orders); assert.equal(report.totals.netSales, 6000); assert.equal(report.totals.units, 5); assert.equal(report.totals.extraUnits, 5);
  assert.equal(report.totals.genders.masculine.netSales, 500);
  const missing = build(context, [order('x', null, [{ ...line('CL', 'Café', 1, 0), productNetSales: null }])]);
  assert.equal(missing.totals.netSales, null); assert.equal(missing.totals.units, 1); assert.equal(missing.totals.genders.unknown.percent, null);
  assert.equal(build(context, []).status, 'no_activity'); assert.equal(build({ ...context, coverage: [] }, []).status, 'no_data');
  assert.equal(build({ ...context, period: { from: '2026-10-31', to: '2026-10-31' } }, [orders.at(-1)], { serverCutoff: '09:00:00' }).rows.length, 0);
});
test('extras reconcile by gender and hierarchy without adding beverage units or leaking into filtered products', () => {
  const extra = { ...line('EX', 'Leche de avena', 2, 600), extraHierarchyId: 'BA.001' };
  const orders = [order('f', 'female', require('../recurrence').eligibleOrderLines([line('CL', 'Café', 1, 1000), extra],
    [{ id: 'CL', quantity: 1 }, { id: 'EX', quantity: 2, lineReference: 'CL' }])),
    order('m', 'male', [{ ...extra, quantity: 1, netSales: 300 }]),
    order('u', null, [{ ...extra, quantity: -1, netSales: -300 }]),
    order('free', 'female', [{ ...extra, code: 'FREE', quantity: 1, netSales: 0 }]),
    order('child', 'male', [{ ...extra, code: 'CHILD', isComponent: true }])];
  const report = build(context, orders);
  assert.equal(report.totals.netSales, 1600); assert.equal(report.totals.units, 1); assert.equal(report.totals.extraUnits, 3);
  const extras = report.rows.find(r => r.label === 'Extras y adicionales');
  assert.equal(extras.netSales, 600); assert.equal(extras.units, 0); assert.equal(extras.extraUnits, 3);
  assert.deepEqual(Object.values(extras.genders).map(g => g.netSales), [300, 600, -300]);
  const branch = report.hierarchyTree.children.find(r => r.label === extras.label);
  assert.equal(branch.products.length, 2); assert.equal(branch.products.reduce((n, p) => n + p.extraUnits, 0), extras.extraUnits);
  assert.equal(branch.products.reduce((n, p) => n + p.netSales, 0), extras.netSales);
  assert.equal(build(context, orders, { products: '["CL"]', groupBy: 'product' }).totals.netSales, 1000);
  assert.equal(build(context, orders, { hierarchy: '["Barra"]' }).totals.extraUnits, 0);
  assert.equal(build(context, orders, { hierarchy: '["Extras y adicionales"]' }).totals.netSales, 600);
  const missing = build(context, [order('missing', null, [{ ...extra, productNetSales: null }])]);
  assert.equal(missing.totals.netSales, null); assert.equal(missing.totals.extraUnits, 2);
});
test('gender report does not read MercadoPago and rejects changed sales versions while keeping the full current month', async () => {
  let version = 1, mutate = false;
  const service = createRecurrenceService({ fingerprint: () => ({ mp: Math.random(), purchases: version }), readProductContext: () => context,
    readSource() { throw new Error('MP must not be read'); }, readOrders(query, period) { if (mutate) version++; return { orders: fixture }; } });
  const report = await service.request('gender-generate', { period: 'current-month' });
  assert.equal(report.period.from, '2026-10-01'); assert.equal(report.period.to, '2026-10-31'); assert.equal(report.totals.netSales, 6000);
  assert.deepEqual(report.sourceVersions, { purchases: 1 });
  mutate = true; await assert.rejects(service.request('gender-generate', { period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-30' }), { status: 409 });
  await assert.rejects(service.request('gender-generate', { period: 'custom', dateFrom: '2026-11-01', dateTo: '2026-11-02' }), { status: 400 });
});
