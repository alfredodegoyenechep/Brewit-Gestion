const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductAnalytics, inferFamily, priorPeriod } = require('../product-analytics');

function order(orderKey, date, mode, lines, netSales = 10000) {
  return { orderKey, date, hour: 10, mode, netSales, lines };
}

function line(code, name, quantity, netSales, hierarchyIds = ['H1'], isExtra = false) {
  return { code, name, quantity, netSales, hierarchyIds, hierarchyPath: ['Bebidas'], isExtra };
}

test('builds product analytics from base products and keeps extras as modifiers', () => {
  const snapshot = {
    products: [
      { code: 'P1', name: 'Latte (CL)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], unitCost: 1000, costSource: 'purchase', costSourceDate: '2026-08-20' },
      { code: 'P2', name: 'Cookie', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], unitCost: 500, costSource: 'master', costSourceDate: null }
    ],
    orders: [
      order('o1', '2026-08-01', 'dineIn', [line('P1', 'Latte (CL)', 1, 3000), line('P2', 'Cookie', 1, 2000), line('E1', 'Vainilla', 1, 500, [], true)], 5500),
      order('o2', '2026-08-02', 'takeaway', [line('P1', 'Latte (CL)', 2, 6000)], 6000),
      order('p1', '2026-07-30', 'unknown', [line('P1', 'Latte (CL)', 1, 3000)], 3000)
    ],
    recipes: {
      P1: [{ ingredientId: 'I1', ingredientName: 'Leche', effectiveQuantity: 0.2, unitCost: 900 }],
      P2: [{ ingredientId: 'I2', ingredientName: 'Harina', effectiveQuantity: 0.1, unitCost: 500 }]
    },
    hierarchies: [{ id: 'H1', pathLabel: 'Bebidas' }],
    coverage: { paymentMatchPercent: 100 },
    warnings: []
  };
  const report = buildProductAnalytics(snapshot, {
    from: '2026-08-01', to: '2026-08-02', location: 'all', locationLabel: 'Todas', hierarchyId: 'all'
  });

  assert.equal(report.summary.orders, 2);
  assert.equal(report.summary.productCount, 2);
  assert.equal(report.summary.units, 4);
  assert.equal(report.summary.netSales, 11000);
  assert.equal(report.portfolio.products.some(product => product.code === 'E1'), false);
  assert.equal(report.baskets.modifiers[0].code, 'E1');
  assert.equal(report.serviceModes.find(mode => mode.key === 'dineIn').orders, 1);
  assert.equal(report.ingredients[0].name, 'Leche');
  assert.equal(report.priceDistribution.bands[0].label, 'Hasta $1.500');
  assert.equal(report.priceDistribution.bands.reduce((total, band) => total + band.units, 0), 4);
  assert.ok(report.priceDistribution.insights.length >= 2);
  assert.deepEqual(report.priceSensitivity.definitions.map(item => item.term), [
    'Observaciones', 'Niveles de precio', 'Rango', 'Coef. observado', 'R²', 'Confianza'
  ]);
  assert.ok(report.priceSensitivity.interpretation.length >= 1);
  assert.deepEqual(report.trends.previousPeriod, { from: '2026-07-30', to: '2026-07-31', days: 2 });
  assert.ok(report.appendix.methodology.some(item => /MercadoPago/.test(item)));
});

test('infers product families conservatively and computes equivalent prior periods', () => {
  const family = inferFamily({ name: 'Latte Vainilla (GR)', hierarchyPath: ['Barra', 'Café'] });
  assert.equal(family.family, 'latte vainilla');
  assert.equal(family.format, 'gr');
  assert.equal(family.confidence, 'media');
  assert.deepEqual(priorPeriod('2026-08-01', '2026-08-30'), { from: '2026-07-02', to: '2026-07-31', days: 30 });
});
