const cleanId = value => String(value ?? '').trim().replace(/^'+/, '');
const money = value => Number((value || 0).toFixed(6));
const sum = (rows, key) => money(rows.reduce((total, row) => total + (row[key] || 0), 0));
const minute = value => Date.parse(String(value).slice(0, 19) + 'Z') / 60000;

function buildCollectionReconciliation({ sales, payments, settlements, totals, maximumMinutes = 2 }) {
  const orders = new Map();
  const order = id => {
    if (!orders.has(id)) orders.set(id, { orderId: id, sales: 0, tips: 0, cash: 0, nonCash: 0, dateTime: null });
    return orders.get(id);
  };
  for (const sale of sales) {
    const id = sale.orderKey.replace(/^.*?:order:/, '');
    const group = order(id); group.sales += sale.netSales * 1.19; group.dateTime ||= sale.date;
  }
  const toteat = [];
  for (const payment of payments) {
    const group = order(payment.orderId); group.dateTime = payment.dateTime;
    let changeAssigned = false;
    payment.forms.forEach((form, index) => {
      const cash = Number(form.id) === 1000;
      const cashChange = cash && !changeAssigned ? payment.change : 0;
      if (cash) changeAssigned = true;
      const amount = form.amount - cashChange;
      group.tips += form.tip;
      if (cash) group.cash += amount; else group.nonCash += amount;
      toteat.push({ key: `${payment.paymentId}:${index}`, orderId: payment.orderId, paymentId: payment.paymentId,
        documentType: payment.documentType, referencedPaymentId: payment.referencedPaymentId,
        toteatTime: payment.dateTime, method: cash ? 'Efectivo' : Number(form.id) === 5008 ? 'MercadoPago' : form.name || `Medio ${form.id}`,
        toteatAmount: amount, expected: cash ? 0 : amount, cash, reference: form.reference,
        eligible: Number(form.id) === 5008 || /mercado.?pago/i.test(form.method) });
    });
  }
  const candidates = new Map(), reverse = new Map(), bySourceId = new Map();
  for (const mp of settlements) {
    const id = cleanId(mp.sourceId);
    if (!id) continue;
    if (!bySourceId.has(id)) bySourceId.set(id, []);
    bySourceId.get(id).push(mp);
  }
  const addCandidates = (payment, matches, explicit) => {
    candidates.set(payment.key, { matches, explicit });
    for (const mp of matches) {
      if (!reverse.has(mp.key)) reverse.set(mp.key, []);
      reverse.get(mp.key).push(payment.key);
    }
  };
  const eligible = toteat.filter(row => row.eligible && !row.cash);
  for (const payment of eligible) {
    const tokens = new Set(String(payment.reference || '').split(/[^a-zA-Z0-9_-]+/).filter(token => token.length >= 6));
    const matches = [...new Map([...tokens].flatMap(token => bySourceId.get(token) || []).map(mp => [mp.key, mp])).values()];
    if (matches.length) addCandidates(payment, matches, true);
  }
  // An explicit, unique reference wins over an estimated amount/time candidate.
  const reserved = new Set();
  for (const { matches } of candidates.values()) if (matches.length === 1 && reverse.get(matches[0].key)?.length === 1) reserved.add(matches[0].key);
  for (const payment of eligible.filter(row => !candidates.has(row.key))) {
    const matches = settlements.filter(mp => !reserved.has(mp.key) && Number.isFinite(mp.transactionAmount)
      && Math.abs(mp.transactionAmount - payment.expected) <= .01
      && mp.dateTime?.slice(0, 10) === payment.toteatTime.slice(0, 10)
      && Math.abs(minute(mp.dateTime) - minute(payment.toteatTime)) <= maximumMinutes);
    addCandidates(payment, matches, false);
  }
  const used = new Set(), rows = [];
  for (const payment of toteat) {
    const { matches = [], explicit = false } = candidates.get(payment.key) || {};
    const mp = matches.length === 1 && reverse.get(matches[0].key)?.length === 1 ? matches[0] : null;
    if (mp) used.add(mp.key);
    const amount = money((mp?.collectedAmount ?? 0) + (mp?.fee ?? 0) - payment.expected);
    const status = payment.cash ? 'cash' : mp ? Math.abs(amount) > .000001 ? 'difference' : 'matched'
      : matches.length ? 'ambiguous' : 'toteat-only';
    rows.push({ orderId: payment.orderId, paymentId: payment.paymentId, toteatTime: payment.toteatTime,
      documentType: payment.documentType || '', referencedPaymentId: payment.referencedPaymentId || '',
      method: payment.method, toteatAmount: payment.toteatAmount,
      mpId: mp?.sourceId || (mp ? mp.key : null), mpTime: mp?.dateTime || null,
      mpGross: mp?.transactionAmount ?? null, mpNet: mp?.collectedAmount ?? null, mpFee: mp?.fee ?? null,
      amount, status, matching: mp ? explicit ? 'Referencia explícita MercadoPago' : `Estimado: monto, fecha y hora (±${maximumMinutes} min)` : '',
      reason: payment.cash ? 'Efectivo descontado del MP teórico; no requiere pareo.'
        : mp ? Math.abs(amount) > .000001 ? 'El abono neto más la comisión difiere del cobro TotEat.' : ''
          : matches.length ? `${matches.length} candidato(s); no existe una asociación única en ambos sistemas.`
            : payment.documentType === 'NC' ? `Nota de crédito TotEat sin movimiento asociado entre los SETTLEMENT del reporte.${payment.referencedPaymentId ? ` Pago original: ${payment.referencedPaymentId}.` : ''} Revisa la devolución y su fecha en MercadoPago.`
              : payment.eligible ? 'No se encontró un movimiento MercadoPago asociado.' : 'Medio distinto de MercadoPago incluido en el saldo no efectivo.' });
  }
  for (const mp of settlements.filter(item => !used.has(item.key))) rows.push({
    mpId: mp.sourceId || mp.key, mpTime: mp.dateTime, mpGross: mp.transactionAmount,
    mpNet: mp.collectedAmount, mpFee: mp.fee, amount: money((mp.collectedAmount ?? 0) + (mp.fee ?? 0)),
    status: reverse.has(mp.key) ? 'ambiguous' : 'mp-only',
    reason: reverse.has(mp.key) ? 'El movimiento tiene candidatos TotEat sin asociación única.' : 'No se encontró un pago TotEat asociado.'
  });
  for (const group of orders.values()) {
    const gap = money(group.sales + group.tips - group.cash - group.nonCash);
    if (Math.abs(gap) <= .000001) continue;
    rows.push({ orderId: group.orderId, toteatTime: group.dateTime, toteatAmount: gap, amount: -gap,
      status: 'sales-payment-gap', method: 'Ventas / pagos TotEat',
      reason: `Venta con IVA ${money(group.sales)} + propinas ${money(group.tips)} − efectivo ${money(group.cash)} − otros cobros ${money(group.nonCash)}. Revisa ventas sin detalle de pago, anulaciones y cierres en fechas distintas.` });
  }
  rows.sort((a, b) => String(a.toteatTime || a.mpTime || '').localeCompare(String(b.toteatTime || b.mpTime || '')));
  const exceptions = rows.filter(row => !['matched', 'cash'].includes(row.status));
  const creditNotes = exceptions.filter(row => row.documentType === 'NC');
  const explained = sum(rows, 'amount'), difference = totals.collectionDifference;
  const reportGap = money(difference - explained);
  return { rows, exceptions, totals: { ...totals, explained, exceptionTotal: sum(exceptions, 'amount'),
    reportGap, reconciled: Math.abs(reportGap) <= .01,
    creditNoteCount: creditNotes.length, creditNoteContribution: sum(creditNotes, 'amount'),
    matched: rows.filter(row => row.status === 'matched').length,
    unmatched: rows.filter(row => ['toteat-only', 'mp-only', 'ambiguous'].includes(row.status)).length },
    notes: [
      'Control de diferencias = MercadoPago neto − (venta bruta − descuentos + propinas − comisión MercadoPago − efectivo).',
      'Cada aporte = abono neto MercadoPago + comisión − cobro no efectivo esperado en TotEat. Los importes sin pareja conservan su signo.',
      'Las referencias explícitas se buscan en el comentario del medio de pago TotEat. Sin referencia, solo se asocian coincidencias únicas por monto y cercanía horaria; los casos ambiguos quedan pendientes.',
      'La sección de diferencias incluye ventas y pagos TotEat que no coinciden entre sí. No se crean pareos para forzar el cuadre.',
      'Fechas en America/Santiago. Se utilizan los SETTLEMENT, fuentes y subtotales conocidos del mismo reporte; las anulaciones y ajustes conservan el criterio del reporte.'
    ] };
}
module.exports = { buildCollectionReconciliation };
