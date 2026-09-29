const test = require('node:test');
const assert = require('node:assert/strict');
const { warningDetails, unverifiedProducts } = require('../financial-warning-details');
test('unverified costs group actual amounts without mixing locations or cost dates', () => {
  const fact = { locationId: 'a', locationName: 'Café A', code: 'X', name: 'Café', costAvailable: true, costSource: 'master', costSourceDate: '2026-09-01', quantity: 2, netSales: 200, totalCost: 40 };
  const rows = unverifiedProducts([fact, fact, { ...fact, locationId: 'b' }, { ...fact, costBasisEvidence: 'net-field-consistent' }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].Líneas, 2); assert.equal(rows[0]['Costo usado (estimado)'], 80); assert.equal(rows[0]['Venta neta afectada'], 400);
});
test('same consumption warning retains affected items for every location and unknown costs', () => {
  const message = 'Consumo de colaboradores: subtotal parcial';
  const payload = { inventoryByLocation: ['A', 'B'].map(name => ({ reviewDetails: [{ message, rows: [{ Ubicación: name, Código: 'X', 'Subtotal conocido': null }] }] })) };
  const detail = warningDetails(message, payload);
  assert.equal(detail.rows.length, 2); assert.equal(detail.rows[0]['Subtotal conocido'], null); assert.match(detail.action, /receta/);
});
test('coverage warning explains missing period without inventing item amounts', () => {
  const detail = warningDetails('Ventas (Portal Lyon): la cobertura comienza el 2026-09-14; el período solicitado empieza antes.', { period: { from: '2026-09-01', to: '2026-09-28' } });
  assert.equal(detail.rows[0].Ubicación, 'Portal Lyon'); assert.equal(detail.rows[0]['Inicio de cobertura'], '2026-09-14'); assert.match(detail.action, /Actualización de fuentes/); assert.match(detail.note, /no identifica importes/);
});
