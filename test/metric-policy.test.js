const test = require('node:test');
const assert = require('node:assert/strict');
const { grossSalesWithVat, averageTicketWithVat } = require('../metric-policy');

test('keeps management sales net but presents the customer ticket with IVA', () => {
  assert.equal(grossSalesWithVat(1000), 1190);
  assert.equal(averageTicketWithVat(1000, 2), 595);
  assert.equal(averageTicketWithVat(1000, 0), null);
});
