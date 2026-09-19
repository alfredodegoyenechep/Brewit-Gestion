const DAY_MS = 86400000;

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 1) => Number((Number(value) || 0).toFixed(digits));

function timestampMinutes(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`) / 60000;
}

function orderPaymentAmounts(order) {
  const values = [order.paymentPaid, order.paymentTotal, order.paymentDue,
    number(order.netSales) == null ? null : number(order.netSales) * 1.19];
  return [...new Set(values.filter(value => value != null && value > 0).map(value => Math.round(value)))];
}

function amountMatches(order, settlement, tolerance = 2) {
  const amount = Math.abs(number(settlement.amount) || 0);
  return orderPaymentAmounts(order).some(candidate => Math.abs(candidate - amount) <= Math.max(tolerance, candidate * 0.001));
}

function linkOrdersToSettlements(orders, settlements, options = {}) {
  const maximumMinutes = Math.max(1, Number(options.maximumMinutes) || 2);
  const candidatesByOrder = new Map();
  const candidatesBySettlement = new Map();
  const eligibleOrders = orders.filter(order => order.dateTime && orderPaymentAmounts(order).length);
  const eligibleSettlements = settlements.filter(item => item.dateTime && number(item.amount) > 0);
  const settlementsByLocationDate = new Map();
  for (const settlement of eligibleSettlements) {
    const key = `${settlement.locationId}|${settlement.date}`;
    const bucket = settlementsByLocationDate.get(key) || [];
    bucket.push(settlement);
    settlementsByLocationDate.set(key, bucket);
  }
  for (const order of eligibleOrders) {
    const orderMinute = timestampMinutes(order.dateTime);
    const candidates = (settlementsByLocationDate.get(`${order.locationId}|${order.date}`) || [])
      .filter(settlement => {
        const settlementMinute = timestampMinutes(settlement.dateTime);
        return settlementMinute != null && orderMinute != null
          && Math.abs(settlementMinute - orderMinute) <= maximumMinutes
          && amountMatches(order, settlement, options.amountTolerance);
      })
      .sort((left, right) => Math.abs(timestampMinutes(left.dateTime) - orderMinute)
        - Math.abs(timestampMinutes(right.dateTime) - orderMinute));
    candidatesByOrder.set(order.orderKey, candidates);
    for (const settlement of candidates) {
      const bucket = candidatesBySettlement.get(settlement.key) || [];
      bucket.push(order);
      candidatesBySettlement.set(settlement.key, bucket);
    }
  }
  const links = new Map();
  for (const order of orders) {
    const candidates = candidatesByOrder.get(order.orderKey) || [];
    if (!candidates.length) {
      links.set(order.orderKey, { status: 'unlinked', confidence: null, candidateCount: 0 });
      continue;
    }
    const settlement = candidates[0];
    const reverse = candidatesBySettlement.get(settlement.key) || [];
    if (candidates.length === 1 && reverse.length === 1) {
      links.set(order.orderKey, { status: 'estimated-high', confidence: 'high', candidateCount: 1,
        settlementKey: settlement.key, instrumentKey: settlement.instrumentKey || null,
        minuteDifference: Math.abs(timestampMinutes(settlement.dateTime) - timestampMinutes(order.dateTime)),
        amount: Math.abs(number(settlement.amount) || 0) });
    } else {
      links.set(order.orderKey, { status: 'ambiguous', confidence: 'low', candidateCount: candidates.length,
        competingOrders: reverse.length });
    }
  }
  const values = [...links.values()];
  const counts = status => values.filter(item => item.status === status).length;
  return { links, coverage: {
    orders: orders.length,
    linkedHigh: counts('estimated-high'),
    ambiguous: counts('ambiguous'),
    unlinked: counts('unlinked'),
    linkedPercent: orders.length ? round(counts('estimated-high') / orders.length * 100, 1) : 0,
    method: `Coincidencia estimada uno-a-uno por local, fecha, monto pagado y cercanía máxima de ${maximumMinutes} minuto(s). No es un identificador explícito de TotEat.`
  } };
}

function instrumentHistory(settlements) {
  const histories = new Map();
  for (const settlement of settlements) {
    if (!settlement.instrumentKey || !settlement.date) continue;
    const history = histories.get(settlement.instrumentKey) || { dates: new Set(), transactions: 0, locations: new Set() };
    history.dates.add(settlement.date);
    history.transactions += 1;
    if (settlement.locationId) history.locations.add(settlement.locationId);
    histories.set(settlement.instrumentKey, history);
  }
  return histories;
}

function recurrenceForOrder(order, histories, untilDate) {
  if (!order.instrumentKey) return 'unlinked';
  const history = histories.get(order.instrumentKey);
  if (!history) return 'unlinked';
  const dates = [...history.dates].filter(date => !untilDate || date <= untilDate).sort();
  return dates.length >= 2 ? 'returning-instrument' : 'single-observed-date';
}

function daysBetween(left, right) {
  return Math.round((Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) / DAY_MS);
}

module.exports = { linkOrdersToSettlements, instrumentHistory, recurrenceForOrder, daysBetween, orderPaymentAmounts };
