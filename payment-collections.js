const { localTimestamp } = require('./toteat-sales');

// TotEat identifies cash as 1000 and MercadoPago POS as 5008. Use each
// payment form's tip so cash tips never get subtracted from MercadoPago.
function toteatPaymentCollections(sources, dateFrom, dateTo) {
  let mercadoPagoTips = 0, cashSales = 0, coveredLocations = 0, complete = sources.length > 0;
  const warnings = [];
  for (const { location, state } of sources) {
    if (!state) {
      complete = false;
      warnings.push(`No hay detalle de pagos sincronizado de TotEat para ${location.name}; falta validar propinas y efectivo.`);
      continue;
    }
    coveredLocations++;
    if (!state.from || !state.through || state.from > dateFrom || state.through < dateTo) {
      complete = false;
      warnings.push(`El detalle de pagos de TotEat para ${location.name} no cubre todo el período ${dateFrom} al ${dateTo}.`);
    }
    const seen = new Set();
    for (const payment of state.payments || []) {
      let date;
      try { date = localTimestamp(payment.dateClosed).date; }
      catch { complete = false; continue; }
      if (date < dateFrom || date > dateTo) continue;
      const id = String(payment.paymentId ?? '').trim().replace(/^'+/, '');
      if (!id) { complete = false; continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      if (!Array.isArray(payment.paymentForms) || !Number.isFinite(payment.change)
        || payment.paymentForms.some(form => !Number.isFinite(form.amount) || !Number.isFinite(form.tip))) {
        complete = false;
        warnings.push(`Un pago de TotEat en ${location.name} no permite separar propinas y efectivo.`);
        continue;
      }
      let hasCash = false;
      for (const form of payment.paymentForms) {
        if (Number(form.id) === 5008) mercadoPagoTips += form.tip;
        if (Number(form.id) === 1000) {
          hasCash = true;
          cashSales += form.amount - form.tip;
        }
      }
      if (hasCash) cashSales -= payment.change;
    }
  }
  const coverage = { available: coveredLocations > 0, complete, coveredLocations, totalLocations: sources.length };
  return {
    mercadoPagoTips: { amount: mercadoPagoTips, ...coverage },
    cashSales: { amount: cashSales, ...coverage },
    warnings
  };
}

module.exports = { toteatPaymentCollections };
