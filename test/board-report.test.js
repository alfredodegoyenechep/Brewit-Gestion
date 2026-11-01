const { test } = require('node:test'); const assert = require('node:assert/strict');
const core = require('../board-report'); const deck = require('../board-deck');
function sample() {
  const p = core.period('2026-10');
  const orders = [{ orderKey: 's:1', locationId: 's', date: '2026-10-02', hour: 9, timeKnown: true, genderBasis: 'manual', validatedGender: 'Femenino', orderDiscountKnown: true, orderDiscount: -119, lines: [{ code: 'P', name: 'Latte (CL)', quantity: 2, netSales: 1800 }, { code: 'B', quantity: 1, netSales: 500, hierarchyId: 'AB.140150' }, { code: 'S', quantity: 1, netSales: 700, hierarchyId: 'AB.140160' }] }, { orderKey: 's:2', locationId: 's', date: '2026-10-03', hour: 21.5, genderAmbiguous: true, orderDiscountKnown: false, lines: [{ code: 'P', name: 'Latte (GR)', quantity: 1, netSales: 2000 }] }];
  const facts = orders.flatMap(o => o.lines.map(l => ({ ...l, locationId: 's', orderKey: o.orderKey, date: o.date, costAvailable: true, totalCost: l.quantity * 100, hierarchyPath: ['Barra', 'Caliente'] })));
  facts.push({ code: 'BX1', name: 'Extra', extraHierarchyId: 'BA.1', quantity: 1, netSales: 200, totalCost: 50, costAvailable: true, orderKey: 's:1', locationId: 's', date: '2026-10-02' });
  facts.push({ code: 'P', name: 'Latte (CL)', quantity: -1, netSales: -900, totalCost: -100, costAvailable: true, orderKey: 's:return', locationId: 's', date: '2026-10-04', hierarchyPath: ['Barra', 'Caliente'] });
  const current = core.summarize(p, facts, orders, { statement: { dataCoverageComplete: false, partial: true, expenses: [] } }, null, { complete: true });
  const previous = core.summarize(core.period('2026-09'), [], [], null, null, { complete: false });
  return { current, previous, facts, orders };
}
test('calendario cruza años y franjas tienen límites exclusivos de dos horas', () => {
  assert.equal(core.period('2026-01').previous, '2025-12'); assert.equal(core.period('2024-02').to, '2024-02-29');
  assert.equal(core.band({ hour: 8.999 }), '07–09'); assert.equal(core.band({ hour: 9 }), '09–11'); assert.equal(core.band({ hour: 19 }), '19–21'); assert.equal(core.band({ hour: 23.9 }), '23–01'); assert.equal(core.band({ hour: 6.9 }), 'Antes de 07'); assert.equal(core.band({ hour: 9, timeKnown: false }), 'Sin hora');
});
test('extras y ajustes concilian, descuentos ponderados, género vigente y unión de canastas', () => {
  const { current: r } = sample(); assert.equal(r.netSales, 4300); assert.equal(r.units, 4); assert.equal(r.extraUnits, 1); assert.equal(r.orders, 2); assert.equal(r.adjustmentsNet, -900);
  assert.equal(r.basket.bakery, 1); assert.equal(r.basket.sandwich, 1); assert.equal(r.basket.either, 1); assert.equal(r.basket.both, 1);
  assert.equal(r.relativeM, 0); assert.equal(r.relativeF, 100); assert.equal(r.discounts.coverage, 50); assert.equal(r.discounts.amount, 119);
  assert.ok(Math.abs(r.discounts.rate - 119 / (3200 * 1.19 + 119) * 100) < 1e-8);
  assert.equal(r.hierarchies.find(r => r.key === 'Extras y adicionales').netSales, 200);
});
test('sin costo no se calcula margen; base cero nunca crea crecimiento ficticio', () => {
  const { facts, orders } = sample(); facts[0].costAvailable = false; const r = core.summarize(core.period('2026-10'), facts, orders, null, null, null);
  assert.equal(r.margin, null); assert.equal(r.marginPercent, null); assert.equal(core.delta(10, 0), null);
});
test('cafeterías nuevas, con gastos o cerradas: inclusión por mes sin bodega comercial', () => {
  const ls = [{ id: 'old', type: 'store', openingDate: '2026-05-01' }, { id: 'new', type: 'store', openingDate: '2026-11-01' }, { id: 'expense', type: 'store' }, { id: 'closed', type: 'store', openingDate: '2026-01-01', closingDate: '2026-08-31' }, { id: 'main-warehouse', type: 'warehouse', openingDate: '2026-01-01' }];
  assert.deepEqual(core.includedStores(ls, core.period('2026-10'), [], [{ locationId: 'expense', month: '2026-10', amount: 100 }]).map(l => l.id), ['old', 'expense']);
});
function report(n) { const { current, previous } = sample(); const locations = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Cafetería ${i}` })); return core.assemble({ month: '2026-10', locations, months: [previous, current], stores: locations.map(l => ({ ...l, current, previous })), sourceVersion: 'fixture' }); }
test('20/22/24 páginas sin desbordamiento y modelo determinista común', () => {
  for (const n of [1, 2, 3, 4, 8]) { const r = report(n); const a = deck.build(r); assert.equal(a.pages.length, 16 + 2 * n); assert.deepEqual(a, deck.build(r)); assert.equal(a.pages.at(-1).section, 'Decisiones'); for (const p of a.pages) for (const e of p.elements) { assert.ok(e.x >= 0 && e.y >= 0); assert.ok(e.x + e.w <= 1281 && e.y + e.h <= 721, JSON.stringify(e)); } }
});
test('PDF y PowerPoint tienen el número fijo de páginas y textos nativos editables', async () => {
  const r = report(2); r.id = 'test'; r.deck = deck.build(r); const out = await require('../board-export').exportFiles(r);
  assert.match(out.pdf.toString('latin1'), /\/Count 20\b/); assert.equal(out.pptx.subarray(0, 2).toString(), 'PK');
  const JSZip = require('jszip'); const zip = await JSZip.loadAsync(out.pptx); const slides = Object.keys(zip.files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)); assert.equal(slides.length, 20);
  const xml = await zip.file('ppt/slides/slide2.xml').async('string'); assert.match(xml, /<a:t>Venta neta<\/a:t>/); assert.doesNotMatch(xml, /<p:pic>/); assert.ok(out.pdf.length > 10000);
});
test('las reglas exigen evidencia y volumen; priorización estable', () => {
  const { current, previous } = sample();
  const a = { ...current, orders: 120, genderCoverage: 80, relativeM: 70, relativeF: 30, products: [{ key: 'A', name: 'A', units: 30, netSales: 2000 }], formats: [], hierarchies: [] };
  const b = { ...previous, products: [{ key: 'A', name: 'A', units: 25, netSales: 1000 }], formats: [], hierarchies: [] };
  const rows = core.findings(a, b); assert.ok(rows.some(r => r.id.endsWith('product:A'))); assert.ok(rows.some(r => r.id.endsWith('gender')));
  assert.deepEqual(rows, core.findings(a, b));
  const sparse = core.findings({ ...a, orders: 80, products: [{ ...a.products[0], units: 10 }] }, b); assert.ok(!sparse.some(r => r.id.endsWith('product:A') || r.id.endsWith('gender')));
});
test('la nueva configuración vacía no incorpora locales futuros por plantillas sin gasto', () => {
  const stores = [{ id: 'future', type: 'store', openingDate: '2027-01-01' }];
  assert.equal(core.includedStores(stores, core.period('2026-10'), [], [{ locationId: 'future', month: '2026-10', values: { rent: 0, salaries: null } }]).length, 0);
});
test('captura rechaza cambios de fuente antes de publicar', async () => {
  const { createSource } = require('../board-source'); let version = 'before';
  const io = { today: () => '2026-10-31', locations: () => [{ id: 's', name: 'S', type: 'store', openingDate: '2026-10-01' }], expenses: () => [], fingerprint: () => version,
    orders: () => ({ orders: [], sources: [], warnings: [] }), coverage: () => [], recurrence: { readSource() { throw Error('Sin evidencia MP'); } },
    financial(p, id, callback) { callback?.([]); return { warnings: [], statement: { netSales: 0, partial: true, expenses: [] } }; }, inventory: () => [], purchases: () => [],
    recipeEvidence() { version = 'after'; return { ingredients: [], theoretical: [] }; } };
  await assert.rejects(createSource(io).generate({ month: '2026-10' }), /fuentes cambiaron/);
  assert.throws(() => core.period(['2026-10']), /mes válido/);
});
