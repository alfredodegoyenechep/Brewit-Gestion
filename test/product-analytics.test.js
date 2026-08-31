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
      { code: 'P1', name: 'Latte (CL)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], listPrice: 3570, unitCost: 1000, costSource: 'purchase', costSourceDate: '2026-08-20' },
      { code: 'P2', name: 'Latte (GR)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], listPrice: 4200, unitCost: 500, costSource: 'master', costSourceDate: null }
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
  assert.ok(report.baskets.definitions.some(item => item.term === 'Confianza B→A'));
  assert.ok(report.baskets.interpretation.some(item => /muestra mínima/.test(item.title)));
  assert.equal(report.serviceModes.find(mode => mode.key === 'dineIn').orders, 1);
  assert.equal(report.serviceModes.reduce((total, mode) => total + mode.salesShare, 0), 100);
  assert.equal(report.ingredients[0].name, 'Leche');
  assert.equal(report.ingredients[0].productCount, 1);
  assert.equal(report.ingredients[0].products[0].orderCount, 2);
  assert.equal(report.ingredients[0].products[0].ingredientUnitSharePercent, 100);
  assert.equal(report.ingredients[0].products[0].ingredientSalesSharePercent, 100);
  assert.equal(report.priceDistribution.bands[0].label, 'Hasta $1.500');
  assert.equal(report.priceDistribution.bands.reduce((total, band) => total + band.units, 0), 4);
  assert.ok(report.priceDistribution.insights.length >= 2);
  assert.deepEqual(report.priceSensitivity.definitions.map(item => item.term), [
    'Observaciones', 'Niveles de precio', 'Rango', 'Coef. observado', 'R²', 'Confianza'
  ]);
  assert.ok(report.priceSensitivity.interpretation.length >= 1);
  assert.equal(report.formats.families[0].formats.find(item => item.code === 'P1').listPrice, 3570);
  assert.equal(report.formats.families[0].formats.find(item => item.code === 'P1').netListPrice, 3000);
  assert.equal(report.formats.families[0].formats.find(item => item.code === 'P1').implicitDiscountPercent, 0);
  assert.equal(report.formats.families[0].formats.find(item => item.code === 'P2').implicitDiscountPercent, 43.3);
  const latteTransactions = report.formats.families[0].formats.find(item => item.code === 'P1').transactions;
  assert.equal(latteTransactions.length, 2);
  assert.equal(latteTransactions[0].date, '2026-08-02');
  assert.equal(latteTransactions[0].quantity, 2);
  assert.equal(latteTransactions[0].averageGrossPrice, 3570);
  assert.equal(latteTransactions[0].implicitDiscountPercent, 0);
  assert.equal(latteTransactions[0].orderLines.length, 1);
  assert.equal(latteTransactions[0].orderLines[0].code, 'P1');
  assert.equal(latteTransactions[0].orderLines[0].type, 'Producto');
  assert.equal(report.formats.families[0].formats.reduce((total, item) => total + item.familyUnitSharePercent, 0), 100);
  assert.equal(report.formats.families[0].formats.reduce((total, item) => total + item.familySalesSharePercent, 0), 100);
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

test('retains the daily observations used by price sensitivity', () => {
  const orders = Array.from({ length: 12 }, (_, index) => {
    const date = `2026-08-${String(index + 1).padStart(2, '0')}`;
    const unitPrice = [1000, 1100, 1200][index % 3];
    const quantity = (index % 4) + 1;
    return order(`price-${index}`, date, 'takeaway', [line('PX1', 'Producto prueba (CL)', quantity, unitPrice * quantity)], unitPrice * quantity);
  });
  const report = buildProductAnalytics({
    products: [{ code: 'PX1', name: 'Producto prueba (CL)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], listPrice: 1428, unitCost: 400, costSource: 'master', costSourceDate: null }],
    orders,
    recipes: {},
    hierarchies: [{ id: 'H1', pathLabel: 'Bebidas' }],
    coverage: { paymentMatchPercent: 100 },
    warnings: []
  }, { from: '2026-08-01', to: '2026-08-12', location: 'all', locationLabel: 'Todas', hierarchyId: 'all' });

  const sensitivity = report.priceSensitivity.items[0];
  assert.equal(sensitivity.observations, 12);
  assert.equal(sensitivity.observationDetails.length, 12);
  assert.equal(sensitivity.observationDetails[0].date, '2026-08-01');
  assert.equal(sensitivity.observationDetails[0].units, 1);
  assert.equal(sensitivity.observationDetails[0].netSales, 1000);
  assert.equal(sensitivity.observationDetails[0].averageNetPrice, 1000);
  assert.equal(sensitivity.observationDetails[0].averageGrossPrice, 1190);
  assert.equal(sensitivity.observationDetails[0].implicitDiscountPercent, 16.7);
  assert.equal(sensitivity.observationDetails[0].transactions.length, 1);
  assert.equal(sensitivity.observationDetails[0].transactions[0].orderKey, 'price-0');
  assert.equal(sensitivity.observationDetails[11].date, '2026-08-12');
});

test('allocates a nonzero order total across zero-value product lines using list prices', () => {
  const report = buildProductAnalytics({
    products: [
      { code: 'C1', name: 'Combo (CL)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], listPrice: 5600, unitCost: 0 },
      { code: 'C2', name: 'Combo (GR)', hierarchyIds: ['H1'], hierarchyPath: ['Bebidas'], listPrice: 5600, unitCost: 0 }
    ],
    orders: [order('combo-order', '2026-08-01', 'takeaway', [
      line('C1', 'Combo (CL)', 1, 0),
      line('C2', 'Combo (GR)', 1, 0)
    ], 4705.88)],
    recipes: {},
    hierarchies: [{ id: 'H1', pathLabel: 'Bebidas' }],
    coverage: {},
    warnings: []
  }, { from: '2026-08-01', to: '2026-08-01', location: 'all', locationLabel: 'Todas', hierarchyId: 'all' });

  const transactions = report.formats.families[0].formats.flatMap(format => format.transactions);
  assert.equal(report.summary.netSales, 4705.88);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].netSales, 2352.94);
  assert.equal(transactions[1].netSales, 2352.94);
  assert.equal(transactions[0].orderLines.reduce((total, item) => total + item.netSales, 0), 4705.88);
  assert.ok(transactions[0].orderLines.every(item => item.netSales > 0 && item.salesAllocation === 'catalog_share'));
});
