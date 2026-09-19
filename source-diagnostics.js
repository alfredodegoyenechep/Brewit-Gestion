function buildSourceDiagnostics({ stores, transactions, settlements, fileCoverage }) {
  const rows = new Map();
  const storeById = new Map(stores.map(store => [store.id, store]));
  const rowFor = (locationId, date) => {
    const key = `${locationId}:${date}`;
    if (!rows.has(key)) rows.set(key, {
      locationId,
      locationName: storeById.get(locationId)?.name || locationId,
      date,
      salesOrders: 0,
      paymentLinked: 0,
      paymentMatched: 0,
      paymentDifference: 0,
      paymentUncertain: 0,
      paymentPartialDue: 0,
      reversalReviewRequired: 0,
      mpSettlements: 0,
      mpAmount: 0,
      mpFeesGross: 0,
      mpWithoutAmount: 0,
      mpWithoutFee: 0
    });
    return rows.get(key);
  };
  for (const transaction of transactions) {
    const row = rowFor(transaction.locationId, transaction.date);
    row.salesOrders += 1;
    if (transaction.paymentMatched) row.paymentLinked += 1;
    if (transaction.paymentDuePartial) row.paymentPartialDue += 1;
    if (transaction.reversalSignals?.length) row.reversalReviewRequired += 1;
    if (transaction.paymentReconciliation?.status === 'matched') row.paymentMatched += 1;
    else if (transaction.paymentReconciliation?.status === 'difference') row.paymentDifference += 1;
    else row.paymentUncertain += 1;
  }
  for (const settlement of settlements) {
    const row = rowFor(settlement.locationId, settlement.date);
    row.mpSettlements += 1;
    if (settlement.amount === null) row.mpWithoutAmount += 1;
    else row.mpAmount += settlement.amount;
    if (settlement.fee === null) row.mpWithoutFee += 1;
    else row.mpFeesGross += Math.abs(settlement.fee);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.locationName.localeCompare(b.locationName, 'es') || b.date.localeCompare(a.date)),
    filesByStore: stores.map(store => ({
      locationId: store.id,
      locationName: store.name,
      sales: fileCoverage[store.id]?.sales || 0,
      paymentDetails: fileCoverage[store.id]?.paymentDetails || 0,
      mercadoPago: fileCoverage[store.id]?.mercadoPago || 0
    })),
    note: 'Las señales de reversión indican importes/cantidades negativos o una etiqueta explícita; no confirman devolución física ni corrigen ventas. Los movimientos MercadoPago se agrupan por fecha de transacción/liquidación, que puede diferir de la fecha de venta. Sus IDs no se vinculan aquí con pedidos de TotEat; los importes y comisiones se muestran como cobertura de fuente, no como ventas conciliadas.'
  };
}

module.exports = { buildSourceDiagnostics };
