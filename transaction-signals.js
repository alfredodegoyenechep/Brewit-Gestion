function reversalSignals({ orderAmount, quantity, lineAmount, status, documentType }) {
  const signals = [];
  if (Number.isFinite(orderAmount) && orderAmount < 0) signals.push('negative-order-amount');
  if (Number.isFinite(quantity) && quantity < 0) signals.push('negative-quantity');
  if (Number.isFinite(lineAmount) && lineAmount < 0) signals.push('negative-line-amount');
  const normalized = `${status || ''} ${documentType || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(anulad[oa]?|cancelad[oa]?|cancelled|canceled|refund|reembolso|devolucion|nota de credito|credit note)\b/.test(normalized)
    || /^(nc|nce|ncd)$/.test(String(documentType || '').trim().toLowerCase())) {
    signals.push('explicit-reversal-label');
  }
  return signals;
}

module.exports = { reversalSignals };
