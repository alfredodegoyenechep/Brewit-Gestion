function reconcilePaymentDetail({ saleWithDiscount, paymentTotal, paymentTotalAmbiguous, paymentDue, paymentMatched, paymentAmountAmbiguous, paymentFilesRead, reversalReviewRequired = false }) {
  const unavailable = status => ({ status, difference: null, basis: null, comparedAmount: null });
  if (reversalReviewRequired) return unavailable('review-reversal');
  if (!paymentFilesRead) return unavailable('no-source');
  if (!paymentMatched) return unavailable('not-linked');
  if (paymentTotalAmbiguous) return unavailable('ambiguous');
  const hasTotal = Number.isFinite(paymentTotal);
  if (!hasTotal && paymentAmountAmbiguous) return unavailable('ambiguous');
  const comparedAmount = hasTotal ? paymentTotal : paymentDue;
  const basis = hasTotal ? 'total' : 'due';
  if (!Number.isFinite(comparedAmount)) return unavailable('no-amount');
  if (!Number.isFinite(saleWithDiscount)) return unavailable('no-sale-amount');
  const difference = Math.round((saleWithDiscount - comparedAmount) * 100) / 100;
  const tolerance = Math.max(2, Math.abs(saleWithDiscount) * 0.005);
  return { status: Math.abs(difference) <= tolerance ? 'matched' : 'difference', difference, basis, comparedAmount };
}

module.exports = { reconcilePaymentDetail };
