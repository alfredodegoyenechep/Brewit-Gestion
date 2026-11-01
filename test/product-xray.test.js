const test = require('node:test'), assert = require('node:assert/strict');
const { familiesFor, selectFamilies, inspectRecipe, previousMonths, buildProductXray, periodFor } = require('../product-xray');
const path = ['Barra Cafe', 'Café Caliente'];
const products = ['CL', 'GR', 'XTR'].map((format, i) => ({ code: `P${i}`, name: `Latte (${format})`, categoryPath: path, listPrice: 1190 * (i + 1) }));
const line = (code, quantity, netSales, extra = {}) => ({ code, quantity, netSales, ...extra });
const order = (id, lines, extra = {}) => ({ orderKey: `store-1:${id}`, locationId: 'store-1', date: '2026-10-03', time: '09:00:00', netSales: lines.reduce((n, l) => n + (l.netSales || 0), 0), lines, ...extra });
const recipeLine = (code, quantity = 1) => ({ ingredientId: code, ingredientName: code, quantity, unit: 'g', yieldRate: 100 });
const cost = { unitCost: 200, source: 'purchase', sourceDate: '2026-10-01', costBasisEvidence: 'net-field-consistent' };
function input(orders = []) { return { family: familiesFor(products)[0], period: { from: '2026-10-01', to: '2026-10-30' }, today: '2026-10-31', cutoff: '23:59:59',
  orders, coverage: [{ locationId: 'store-1', source: 'sales', from: '2026-04-01', to: '2026-10-30', complete: true }], locationIds: ['store-1'],
  stores: [{ id: 'store-1', name: 'Local' }], scope: { location: 'store-1', label: 'Local', locations: [{ id: 'store-1', name: 'Local' }] },
  recipes: new Map(products.map(p => [p.code, [recipeLine('CAF001')]])), catalog: new Map([['CAF001', { name: 'Café' }]]),
  cutoffCosts: () => cost, historicalCost: () => cost, version: 'v1' }; }

test('family unites formats, retains unused sizes and separates cold beverages', () => {
  const families = familiesFor([...products, { ...products[0], code: 'ICE', name: 'Iced Latte (CL)' }]);
  assert.equal(families.length, 2); assert.equal(families.find(f => f.name === 'Latte').products.length, 3);
  const report = buildProductXray(input([order('a', [line('P0', 2, 1800), line('P1', 1, 2000)])]));
  assert.equal(report.selected.total.units, 3); assert.equal(report.selected.total.netSales, 3800); assert.equal(report.selected.total.orders, 1);
  assert.equal(report.formats.find(f => f.code === 'P2').actual.units, 0);
  assert.equal(report.formats[0].actual.priceGross, 1071); assert.equal(report.formats[0].actual.margin, 1400);
  assert.equal(report.formats[0].references[0].margin, 800); assert.equal(report.formats[0].references[0].marginPercent, 80);
  assert.deepEqual(report.sizeMix.rows.map(r => [r.format, r.units, r.percent]), [['CL', 2, 66.67], ['GR', 1, 33.33], ['XTR', 0, 0]]);
});
test('collection selection is optional, ordered by each hierarchy level and excludes other branches', () => {
  const families = familiesFor([...products, { code: 'ICE', name: 'Iced Latte (CL)', categoryPath: ['Barra Cafe', 'Iced Coffee'] }, { code: 'BREAD', name: 'Pan', categoryPath: ['Retail'] }]);
  assert.deepEqual(selectFamilies(families).families.map(f => f.name), ['Latte', 'Iced Latte', 'Pan']);
  assert.deepEqual(selectFamilies(families, { hierarchy: '["Barra Cafe"]' }).families.map(f => f.name), ['Latte', 'Iced Latte']);
  assert.equal(selectFamilies(families, { hierarchy: '["Barra Cafe","Café Caliente"]' }).families.length, 1);
  assert.throws(() => selectFamilies(families, { family: families.find(f => f.name === 'Pan').id, hierarchy: '["Barra Cafe"]' }), { status: 400 });
  assert.throws(() => selectFamilies(families, { hierarchy: '{}' }), { status: 400 });
  const i = input([order('sale', [line('P0', 3, 3000), line('P1', 1, 1000)]), order('refund', [line('P0', -2, -2000)])]);
  const r = buildProductXray(i); assert.equal(r.selected.total.units, 2); assert.equal(r.sizeMix.units, 4); assert.deepEqual(r.sizeMix.rows.map(s => s.percent), [75, 25, 0]);
  assert.equal(buildProductXray({ ...i, family: { ...i.family, codes: ['P0'], products: [products[0]] } }).sizeMix, null);
  assert.ok(buildProductXray(input()).sizeMix.rows.every(s => s.percent === null));
});
test('last complete month weights paid prices and ingredient costs by real quantities, independently of selection', () => {
  const i = input([order('early', [line('P0', 1, 1000)], { date: '2026-09-03' }), order('late', [line('P0', 3, 2400)], { date: '2026-09-20' })]);
  const reference = unitCost => ({ ...cost, source: 'recipe', unitCost: 20 * unitCost, recipeConversionFactor: 1,
    components: [{ code: 'CAF001', quantity: 20, effectiveQuantity: 20, yieldRate: 100, unit: 'g', unitCost, totalCost: 20 * unitCost, costSource: 'purchase' }] });
  i.historicalCost = date => reference(date < '2026-09-15' ? 10 : 20); i.cutoffCosts = () => reference(20);
  const r = buildProductXray(i), p = r.formats[0], monthly = p.lastMonthActual;
  assert.equal(p.actual.units, 0); assert.equal(monthly.units, 4); assert.equal(monthly.netSales, 3400); assert.equal(monthly.priceGross, 1011.5);
  assert.equal(monthly.unitCost, 350); assert.equal(monthly.cost, 1400);
  const c = p.references[0].ingredientComparison.find(c => c.code === 'CAF001');
  assert.equal(c.realUnitCost, 17.5); assert.equal(c.realCostPerProduct, 350); assert.equal(c.theoreticalUnitCost, 20); assert.equal(c.theoreticalCost, 400);
});
test('nested recipes provide multiple ingredient tags, unknown recipes never mean none, and cups exclude lid capacities', () => {
  const recipes = new Map([['P', [recipeLine('SUB'), recipeLine('CAF008'), recipeLine('PAC001'), recipeLine('PAC002')]], ['SUB', [recipeLine('CAF001')]]]);
  const catalog = new Map([['PAC001', { name: 'Vaso 12 oz' }], ['PAC002', { name: 'Tapa Vaso 12-20 oz' }]]);
  const result = inspectRecipe('P', recipes, catalog);
  assert.equal(result.complete, true); assert.deepEqual(result.categories.sort(), ['coffee', 'matcha']); assert.deepEqual(result.capacity, ['12 oz']);
  assert.equal(inspectRecipe('MISSING', recipes, catalog).complete, false);
  recipes.set('SUB', [recipeLine('P')]); assert.equal(inspectRecipe('P', recipes, catalog).complete, false);
  recipes.set('NONE', [recipeLine('SUGAR')]); catalog.set('SUGAR', { name: 'Azúcar' });
  const none = inspectRecipe('NONE', recipes, catalog); assert.equal(none.complete, true); assert.deepEqual(none.categories, []);
});
test('six previous calendar months cross years; missing coverage is distinct from a verified zero', () => {
  assert.deepEqual(previousMonths('2026-01-20').map(m => m.from), ['2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01']);
  assert.equal(previousMonths('2026-03-01').at(-1).to, '2026-02-28');
  const base = input([order('old', [line('P0', 1, 1000)], { date: '2026-05-03' })]);
  base.coverage = [{ locationId: 'store-1', source: 'sales', from: '2026-06-01', to: '2026-06-30', complete: true }];
  const report = buildProductXray(base);
  assert.equal(report.history[0].status, 'no_data'); assert.equal(report.history[0].total.units, null);
  assert.equal(report.history[1].status, 'partial'); assert.equal(report.history[1].total.units, 1);
  assert.equal(report.history[2].status, 'complete'); assert.equal(report.history[2].total.units, 0);
  assert.equal(periodFor({ period: 'current-month' }, '2026-10-31').to, '2026-10-31');
});
test('unit distributions and unique-order attachments reconcile, including refunds and missing hours', () => {
  const a = order('a', [line('P0', 2, 2000), line('P1', 1, 2000), line('BAK', 2, 1000, { hierarchyId: 'AB.140150' }), line('SAND', 1, 1000, { hierarchyId: 'AB.140160' })], { validatedGender: 'feminine', genderBasis: 'manual', time: '08:59:59' });
  const b = order('b', [line('P0', 1, 1000)], { time: '09:00:00', genderAmbiguous: true });
  const c = order('c', [line('P1', 2, 4000)], { timeKnown: false });
  const credit = order('credit', [line('P0', -1, -1000)], { reversalSignals: ['credit'] });
  const report = buildProductXray(input([a, a, b, c, credit]));
  assert.equal(report.selected.total.units, 5); assert.equal(report.selected.total.netSales, 8000);
  assert.equal(report.consumption.units, 6); assert.equal(report.consumption.orders, 3); assert.equal(report.consumption.excludedAdjustments.units, -1);
  assert.equal(report.consumption.gender.find(g => g.key === 'feminine').percent, 50);
  assert.equal(report.consumption.gender.find(g => g.key === 'unattributable').units, 1);
  assert.equal(report.consumption.hours.find(h => h.key === '07').units, 3); assert.equal(report.consumption.hours.find(h => h.key === '09').units, 1);
  assert.equal(report.consumption.hours.find(h => h.key === 'unknown').units, 2);
  assert.equal(report.accompanies.either.orders, 1); assert.equal(report.accompanies.either.percent, 33.33);
  assert.equal(report.conclusion.status, 'Perfil exploratorio');
});
test('unverified or incomplete cost suppresses margins and local references are not averaged', () => {
  const base = input([order('a', [line('P0', 1, 1000)])]); base.stores.push({ id: 'store-2', name: 'Otro local' });
  base.cutoffCosts = store => ({ ...cost, unitCost: store === 'store-1' ? 200 : 600 });
  base.historicalCost = () => ({ ...cost, costBasisEvidence: 'unverified' });
  let report = buildProductXray(base);
  assert.deepEqual(report.formats[0].references.map(r => r.margin), [800, 400]); assert.equal(report.formats[0].actual.margin, null);
  base.cutoffCosts = () => ({ ...cost, costIncomplete: true }); report = buildProductXray(base); assert.equal(report.formats[0].references[0].margin, null);
  const missing = buildProductXray(input([order('missing', [line('P0', 1, null)])]));
  assert.equal(missing.formats[0].actual.priceGross, null); assert.equal(missing.selected.total.netSales, null);
});
test('profile requires sufficient orders, dates, coverage and two independently concentrated dimensions', () => {
  const orders = Array.from({ length: 100 }, (_, i) => order(i, [line('P0', 1, 1000)], { date: `2026-10-${String(1 + i % 7).padStart(2, '0')}`, validatedGender: 'feminine', genderBasis: 'manual' }));
  const report = buildProductXray(input(orders)); assert.equal(report.conclusion.status, 'Perfil concentrado');
  const scarce = buildProductXray(input(orders.map(o => ({ ...o, validatedGender: null })))); assert.equal(scarce.conclusion.status, 'Sin predominio claro');
});

test('attachments distinguish the two children of a shared parent, descendants and overlap without double counts', () => {
  const parent = 'Bolleria, Sandwich, Bebidas - Retail';
  const bakery = line('BAK', 1, 500, { hierarchyId: 'CUSTOM.BAK.CHILD', categoryPath: [parent, 'Bollería', 'Croissants'] });
  const sandwich = line('SAND', 1, 1500, { hierarchyId: 'AB.140160', categoryPath: [parent, 'Sandwich'] });
  const drink = line('DRINK', 1, 500, { hierarchyId: 'AB.140170', categoryPath: [parent, 'Bebidas'] });
  const orders = [order('bak', [line('P0', 1, 1000), bakery]), order('sand', [line('P1', 1, 2000), sandwich]),
    order('both', [line('P0', 1, 1000), bakery, bakery, sandwich]), order('other', [line('P0', 1, 1000), drink, { ...bakery, isExtra: true }])];
  const i = input([...orders, orders[2]]); i.accompanimentClassifications = new Map([['CUSTOM.BAK.CHILD', 'bakery'], ['AB.140170', null]]);
  const r = buildProductXray(i); assert.equal(r.consumption.orders, 4);
  assert.deepEqual(Object.fromEntries(Object.entries(r.accompanies).map(([k, v]) => [k, v.orders])), { bakery: 2, sandwich: 2, both: 1, either: 3 });
  assert.equal(r.accompanies.bakery.percent, 50); assert.equal(r.accompanies.both.percent, 25); assert.equal(r.accompanies.either.percent, 75);
  delete i.accompanimentClassifications; assert.equal(buildProductXray(i).accompanies.bakery.orders, 2);
  const self = buildProductXray({ ...i, family: { ...i.family, codes: ['BAK'], products: [{ ...products[0], code: 'BAK' }] } });
  assert.equal(self.accompanies.bakery.orders, 0); assert.equal(self.accompanies.sandwich.orders, 1);
});
