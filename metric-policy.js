'use strict';

// Management amounts are net of sales VAT. The customer-facing average ticket
// and observed selling prices are the deliberate gross (VAT-inclusive) exceptions.
const SALES_VAT_FACTOR = 1.19;

function grossSalesWithVat(netSales) {
  return Number(netSales) * SALES_VAT_FACTOR;
}

function averageTicketWithVat(netSales, transactions) {
  return Number.isFinite(Number(netSales)) && Number(transactions) > 0
    ? grossSalesWithVat(netSales) / Number(transactions)
    : null;
}

module.exports = { SALES_VAT_FACTOR, grossSalesWithVat, averageTicketWithVat };
