const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, DEFAULT_DIMENSIONS, DEFAULT_PARAMETERS, optionsFor, recurrenceAsOf, prepareCohort,
  runAnalysis, compareWithModel, distance, fastPam, buildFeatures, refinementConfigurations } = require('../sales-clusters');

const dimensions = (...keys) => Object.fromEntries(Object.entries(DEFAULT_DIMENSIONS).map(([k, value]) => [k, { ...value, enabled: keys.includes(k), ...(k === 'products' ? { level: 'product' } : {}) }]));
const order = (index, group = index % 2) => ({ orderKey: `order-${index}`, orderReference: `${index}`, locationId: 'store-1', locationName: 'Cafetería',
  date: `2026-09-${String(1 + Math.floor(index / 2) % 10).padStart(2, '0')}`, time: group ? '18:00' : '09:00',
  netSales: group ? 8000 : 2000, orderDiscount: 0, mode: group ? 'dineIn' : 'takeaway', reversalSignals: [],
  paymentLinkStatus: 'unlinked', lines: [{ code: group ? 'B' : 'A', name: group ? 'Almuerzo' : 'Café', quantity: 1,
    netSales: group ? 8000 : 2000, unit: 'UN', categoryId: group ? 'FOOD.1' : 'DRINK.1',
    categoryPath: [group ? 'Comida' : 'Bebida'], rootHierarchyId: group ? 'FOOD' : 'DRINK' }] });
const input = (orders, config = {}) => ({ orders, period: { from: '2026-09-01', to: '2026-09-10' }, sourceFingerprint: 'test-source', config });
let fitted;
const fit = () => fitted ||= runAnalysis(input(Array.from({ length: 120 }, (_, i) => order(i)), { dimensions: dimensions('products', 'hour', 'spend') }));

test('umbrales por variable prevalecen sobre el general y validan el rango', () => {
  const dims = dimensions('gender', 'mode'); dims.gender.minimumCoverage = 40;
  const orders = Array.from({ length: 10 }, (_, i) => ({ ...order(i),
    mode: i < 4 ? i % 2 ? 'dineIn' : 'takeaway' : 'unknown',
    nameGenderSegment: i < 4 ? i % 2 ? 'feminine-associated' : 'masculine-associated' : 'unavailable' }));
  const config = normalizeConfig({ dimensions: dims });
  const coverage = optionsFor(input(orders), config).coverage;
  assert.equal(coverage.find(d => d.key === 'gender').available, true);
  assert.equal(coverage.find(d => d.key === 'gender').minimumCoverage, 40);
  assert.equal(coverage.find(d => d.key === 'mode').available, false);
  assert.equal(coverage.find(d => d.key === 'mode').minimumCoverage, 50);
  assert.equal(config.customParameters, true);
  dims.gender.minimumCoverage = ''; assert.equal(normalizeConfig({ dimensions: dims }).dimensions.gender.minimumCoverage, null);
  dims.gender.minimumCoverage = 0; assert.equal(normalizeConfig({ dimensions: dims }).dimensions.gender.minimumCoverage, 0);
  for (const value of [-1, 101, 'bad', true]) {
    dims.gender.minimumCoverage = value; assert.throws(() => normalizeConfig({ dimensions: dims }), /Cobertura mínima inválida/);
  }
});

test('cobertura inicial 50 %, parámetros parciales y validación de rangos', () => {
  assert.equal(normalizeConfig().parameters.dimensionCoverage, 50);
  assert.equal(normalizeConfig({ parameters: { dimensionCoverage: 25 } }).parameters.minimumOrders, 100);
  for (const parameters of [{ dimensionCoverage: 101 }, { observedWeight: -1 }, { minimumOrders: 2.2 }, { minimumStability: 1.1 }, { globalSilhouette: -2 }, { minimumDates: null }, { dimensionCoverage: true }, { unknown: 1 }]) {
    assert.throws(() => normalizeConfig({ parameters }), e => e.status === 400);
  }
  assert.throws(() => normalizeConfig({ dimensions: dimensions() }), /Activa al menos/);
  assert.throws(() => normalizeConfig({ filters: { minSpend: 100, maxSpend: 50 } }), /mínimo/);
});

test('cobertura 50 % permite una dimensión parcial; cambiarla cambia su elegibilidad', () => {
  const orders = Array.from({ length: 100 }, (_, i) => ({ ...order(i), mode: i < 50 ? i % 2 ? 'dineIn' : 'takeaway' : 'unknown' }));
  const defaults = optionsFor(input(orders), normalizeConfig({ dimensions: dimensions('mode') }));
  assert.equal(defaults.coverage.find(d => d.key === 'mode').coverage, 50);
  assert.equal(defaults.coverage.find(d => d.key === 'mode').available, true);
  assert.equal(defaults.eligibleOrders, 50);
  const stricter = optionsFor(input(orders), normalizeConfig({ dimensions: dimensions('mode'), parameters: { dimensionCoverage: 51 } }));
  assert.equal(stricter.coverage.find(d => d.key === 'mode').available, false);
  assert.equal(stricter.eligibleOrders, 0);
});

test('asociación de nombre no habilita género aunque se reduzca la cobertura', () => {
  const orders = [order(0), order(1)].map((o, i) => ({ ...o, nameGenderSegment: i ? 'feminine-associated' : 'masculine-associated' }));
  const config = dimensions('gender'); config.gender.level = 'validated';
  const options = optionsFor(input(orders), normalizeConfig({ dimensions: config, parameters: { dimensionCoverage: 0 } }));
  assert.equal(options.coverage.find(d => d.key === 'gender').known, 0);
  assert.equal(options.eligibleOrders, 0);
});

test('estimación por nombre mide cobertura y omite nombres indeterminados o ausentes', () => {
  const orders = [order(0), order(1), order(2), order(3)].map((o, i) => ({ ...o,
    nameGenderSegment: ['feminine-associated', 'masculine-associated', 'indeterminate', 'unavailable'][i] }));
  const options = optionsFor(input(orders), normalizeConfig({ dimensions: dimensions('gender') }));
  const gender = options.coverage.find(d => d.key === 'gender');
  assert.equal(gender.known, 2); assert.equal(gender.coverage, 50);
  assert.equal(gender.available, true); assert.match(gender.basis, /no confirma/);
});

test('recurrencia usa historia anterior; repetición futura y mismo día no alteran primera observación', () => {
  const purchases = [order(0), order(1), order(2)].map((o, i) => ({ ...o, date: i === 2 ? '2026-09-02' : '2026-09-01',
    instrumentKey: 'instrument', paymentLinkStatus: 'estimated-high' }));
  const values = recurrenceAsOf(purchases, [{ instrumentKey: 'instrument', date: '2026-09-10' }]);
  assert.deepEqual(values.map(o => o.recurrenceGroup), ['single-observed-date', 'single-observed-date', 'returning-instrument']);
  const prior = recurrenceAsOf(purchases, [{ instrumentKey: 'instrument', date: '2026-08-01' }]);
  assert.ok(prior.every(o => o.recurrenceGroup === 'returning-instrument'));
});

test('criterio por compra incluye repetición el mismo día sin usar compras futuras ni vínculos ambiguos', () => {
  const purchases = [order(0), order(1), order(2)].map((o, i) => ({ ...o, date: '2026-09-01',
    dateTime: `2026-09-01T${i === 0 ? '09' : i === 1 ? '10' : '11'}:00:00`,
    instrumentKey: 'instrument', paymentLinkStatus: i === 2 ? 'ambiguous' : 'estimated-high' }));
  const values = recurrenceAsOf(purchases, [{ instrumentKey: 'instrument', date: '2026-09-02', dateTime: '2026-09-02T08:00:00' }], { sameDay: true });
  assert.deepEqual(values.map(o => o.recurrenceGroup), ['single-observed-date', 'returning-instrument', 'unlinked']);
  const resolved = purchases.slice(0, 2).map((o, i) => ({ ...o, recurrenceGroup: 'single-observed-date',
    recurrenceTransactionGroup: values[i].recurrenceGroup }));
  const source = { ...input(resolved), recurrenceResolved: true };
  const config = normalizeConfig({ filters: { recurrence: 'returning-instrument' } });
  assert.equal(prepareCohort(source, config).orders.length, 1);
  config.dimensions.recurrence.level = 'observed';
  assert.equal(prepareCohort(source, config).orders.length, 0);
});

test('filtros conservan el pedido completo y separan duplicados, reversos y datos incompletos', () => {
  const complete = { ...order(0), lines: [...order(0).lines, ...order(1).lines] };
  const cohort = prepareCohort(input([complete, complete, { ...order(2), reversalSignals: ['cancelled'] },
    { ...order(4), netSales: 0 }, { ...order(6), netSales: null }]), normalizeConfig({ filters: { product: 'A' } }));
  assert.equal(cohort.orders.length, 1);
  assert.equal(cohort.orders[0].lines.length, 2);
  assert.deepEqual(cohort.exclusions, { duplicates: 1, reversals: 1, nonPositive: 1, insufficient: 1 });
  assert.equal(prepareCohort(input([order(0), order(1)]), normalizeConfig({ filters: { hourFrom: 17, hourTo: 10 } })).orders.length, 2);
});

test('desactivar horario lo retira del cálculo, y la distancia circular conecta medianoche', () => {
  const config = normalizeConfig({ dimensions: dimensions('products') });
  const feature = buildFeatures([order(0), order(1)], config);
  assert.equal(feature.active.some(d => d.key === 'hour'), false);
  assert.equal(Object.hasOwn(feature.rows[0].features, 'hour'), false);
  const circular = [{ key: 'hour', type: 'circular' }];
  assert.ok(distance({ hour: 23.5 }, { hour: 0.5 }, circular, 50) < 0.1);
  assert.equal(distance({ hour: null }, { hour: 1 }, circular, 50), null);
});

test('FastPAM identifica representantes que minimizan una distancia no euclidiana conocida', () => {
  const values = [0, 1, 2, 20, 21, 22];
  const matrix = Float64Array.from(values.flatMap(a => values.map(b => Math.abs(a - b))));
  const medoids = fastPam(matrix, values.length, 2).map(i => values[i]).sort((a, b) => a - b);
  assert.deepEqual(medoids, [1, 21]);
});

test('grupos conocidos superan estabilidad y referencias; concilian pedidos y ventas', () => {
  const output = fit(), result = output.result;
  assert.equal(result.clusters.length, 2);
  assert.equal(result.summary.solidClusters, 2);
  assert.equal(result.validation.bootstrapRuns, 20);
  assert.equal(result.validation.nullRuns, 20);
  assert.ok(result.validation.silhouette > 0.9);
  assert.ok(result.clusters.every(c => c.stability > 0.9));
  assert.equal(result.clusters.reduce((s, c) => s + c.orders, 0) + result.unassigned.orders, 120);
  assert.equal(result.clusters.reduce((s, c) => s + c.netSales, 0) + result.unassigned.netSales, result.summary.netSales);
  assert.equal(output.orders.some(o => Object.hasOwn(o, 'instrumentKey') || Object.hasOwn(o, 'paymentComment')), false);
});

test('datos homogéneos o pocos pedidos explican insuficiencia; umbrales cambian solidez', () => {
  const same = Array.from({ length: 120 }, (_, i) => ({ ...order(i, 0), date: '2026-09-01' }));
  const homogeneous = runAnalysis(input(same, { dimensions: dimensions('products', 'hour') }));
  assert.equal(homogeneous.result.status, 'insufficient');
  assert.match(homogeneous.result.message, /variación/);
  const small = runAnalysis(input([order(0), order(1)], { dimensions: dimensions('hour') }));
  assert.match(small.result.message, /mínimo configurado/);
  const strict = runAnalysis(input(Array.from({ length: 120 }, (_, i) => order(i)), { dimensions: dimensions('products', 'hour', 'spend'), parameters: { minimumDates: 20 } }));
  assert.equal(strict.result.summary.solidClusters, 0);
  assert.ok(strict.result.clusters.every(c => c.checks.find(check => check.key === 'dates').passed === false));
  assert.equal(strict.result.customParameters, true);
  assert.deepEqual(strict.membership, fit().membership);
});

test('comparación conserva grupos y transformaciones aunque una dimensión sea constante en el nuevo período', () => {
  const original = fit();
  const next = input(Array.from({ length: 20 }, (_, i) => order(i, 1)), { dimensions: dimensions('products', 'hour', 'spend') });
  const comparison = compareWithModel({ ...next, referenceJobId: 'base' }, original);
  assert.equal(comparison.result.validation.method, 'fixed-definitions');
  assert.equal(comparison.result.effectiveDimensions.length, original.result.effectiveDimensions.length);
  assert.equal(comparison.result.comparison.clusters.filter(c => c.orders === 20).length, 1);
  assert.equal(comparison.result.comparison.clusters.filter(c => c.orders === 0).length, 1);
  assert.ok(comparison.result.clusters.every(c => c.status === 'exploratory'));
});

test('límite de tiempo no produce clusters sólidos ni validación completa', () => {
  const output = runAnalysis(input(Array.from({ length: 120 }, (_, i) => order(i)), { dimensions: dimensions('products', 'hour') }), () => {}, { deadline: Date.now() - 1 });
  assert.equal(output.result.validation.complete, false);
  assert.equal(output.result.summary.solidClusters, 0);
});

test('refinamientos respetan dimensiones desactivadas y no exceden doce configuraciones', () => {
  const config = normalizeConfig();
  const candidates = refinementConfigurations(config);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(c => JSON.stringify(c.parameters) === JSON.stringify(DEFAULT_PARAMETERS)));
  assert.equal(refinementConfigurations(normalizeConfig({ dimensions: dimensions('spend') })).length, 0);
});
