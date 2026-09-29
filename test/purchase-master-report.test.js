const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMasterReport } = require('../purchase-master-report');
const period = { from: '2026-09-01', to: '2026-09-28' };
const row = (extra = {}) => ({ date: '2026-09-23', supplierKey: '123', supplier: 'Proveedor', supplierTaxId: '123', document: '001', documentType: 'Factura Normal', totalAmount: 100, reportNet: 100, reportGross: 119, receivedQuantity: 2, receivedUnit: 'KG', ...extra });
const payload = (id, type, rows) => ({ scope: { location: id, label: id, type }, rows });
test('groups invoice lines, orders warehouse last, and reconciles supplier and location totals', () => {
  const report = buildMasterReport([
    payload('Bodega', 'warehouse', [row()]),
    payload('Café B', 'store', [row({ supplierKey: '456', supplier: 'Otro' })]),
    payload('Café A', 'store', [row(), row({ document: '1' }), row({ document: 'NC1', documentType: 'Nota de Crédito', totalAmount: -10, reportNet: -10, reportGross: -11.9 })])
  ], period, true);
  assert.deepEqual(report.locations.map(l => l.name), ['Café A', 'Café B', 'Bodega']);
  assert.equal(report.invoiceCount, 3);
  assert.equal(report.documentCount, 4);
  assert.equal(report.net, 390);
  assert.equal(report.locations[0].suppliers[0].documents[0].products.length, 2);
  assert.equal(report.suppliers.find(s => s.key === '123').net, 290);
  assert.equal(report.locations.reduce((n, l) => n + l.recorded, 0), report.recorded);
});
test('missing tax amounts propagate without turning into zero and product detail is optional', () => {
  const report = buildMasterReport([payload('Café', 'store', [row({ reportNet: null, reportGross: null }), row({ document: '2' })]), payload('Vacío', 'store', [])], period);
  assert.equal(report.net, null); assert.equal(report.gross, null); assert.equal(report.recorded, 200);
  assert.equal(report.locations[0].suppliers[0].documents[0].products, undefined);
  assert.equal(report.locations[1].documentCount, 0);
});
test('same number from different suppliers or document types is not merged; unidentified movements are not invoices', () => {
  const report = buildMasterReport([payload('Café', 'store', [row(), row({ supplierKey: '456' }), row({ documentType: 'Boleta Electrónica' }), row({ document: '', documentType: '' })])], period);
  assert.equal(report.documentCount, 4); assert.equal(report.invoiceCount, 2);
});
