const { daysBetween } = require('./transaction-linkage');

const round = (value, digits = 1) => Number((Number(value) || 0).toFixed(digits));
const sum = values => values.reduce((total, value) => total + (Number(value) || 0), 0);
const median = values => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))];
};

function basicMetrics(orders) {
  const netSales = sum(orders.map(order => order.netSales));
  const tickets = orders.map(order => order.netSales * 1.19);
  const items = sum(orders.flatMap(order => order.lines).filter(line => !line.isExtra).map(line => line.quantity));
  const costComplete = orders.filter(order => order.costAvailable);
  const cost = sum(costComplete.map(order => order.cost));
  const costSales = sum(costComplete.map(order => order.netSales));
  return { orders: orders.length, netSales: round(netSales, 2), salesSharePercent: null,
    averageTicketGross: orders.length ? round(sum(tickets) / orders.length, 2) : null,
    medianTicketGross: median(tickets), productsPerOrder: orders.length ? round(items / orders.length, 2) : null,
    takeawayPercent: orders.length ? round(orders.filter(order => order.mode === 'takeaway').length / orders.length * 100, 1) : null,
    dineInPercent: orders.length ? round(orders.filter(order => order.mode === 'dineIn').length / orders.length * 100, 1) : null,
    marginPercent: costComplete.length === orders.length && costSales > 0 ? round((costSales - cost) / costSales * 100, 1) : null,
    costCoveredOrders: costComplete.length };
}

function topMix(orders, limit = 5) {
  const products = new Map();
  const categories = new Map();
  for (const order of orders) {
    const orderCategories = new Set();
    for (const line of order.lines.filter(item => !item.isExtra)) {
      const product = products.get(line.code) || { key: line.code, name: line.name, units: 0, orders: new Set(), netSales: 0 };
      product.units += Number(line.quantity) || 0;
      product.netSales += Number(line.netSales) || 0;
      product.orders.add(order.orderKey);
      products.set(line.code, product);
      orderCategories.add(line.categoryId || line.categoryName || 'Sin categoría');
      const categoryKey = line.categoryId || line.categoryName || 'Sin categoría';
      const category = categories.get(categoryKey) || { key: categoryKey, name: line.categoryName || 'Sin categoría', units: 0, orders: new Set(), netSales: 0 };
      category.units += Number(line.quantity) || 0;
      category.netSales += Number(line.netSales) || 0;
      category.orders.add(order.orderKey);
      categories.set(categoryKey, category);
    }
  }
  const rows = map => [...map.values()].map(item => ({ ...item, orders: item.orders.size,
    penetrationPercent: orders.length ? round(item.orders.size / orders.length * 100, 1) : null,
    unitsPer100Orders: orders.length ? round(item.units / orders.length * 100, 1) : null,
    spendingSharePercent: sum(orders.map(order => order.netSales)) ? round(item.netSales / sum(orders.map(order => order.netSales)) * 100, 1) : null }))
    .sort((a, b) => b.orders - a.orders || b.netSales - a.netSales);
  const productRows = rows(products);
  const categoryRows = rows(categories);
  return { products: productRows.slice(0, limit), categories: categoryRows.slice(0, limit),
    focusCategories: categoryRows.filter(item => /sandwich|sándwich|bolleria|bollería/.test(item.name.toLowerCase())) };
}

function aggregateNameSegments(orders) {
  const definitions = [
    ['feminine-associated', 'Asociación femenina'], ['masculine-associated', 'Asociación masculina'],
    ['indeterminate', 'Indeterminado/no clasificable'], ['unavailable', 'Sin nombre utilizable']
  ];
  const totalSales = sum(orders.map(order => order.netSales));
  const segments = definitions.map(([key, label]) => {
    const values = orders.filter(order => order.nameGenderSegment === key);
    const metrics = basicMetrics(values);
    metrics.salesSharePercent = totalSales ? round(metrics.netSales / totalSales * 100, 1) : null;
    return { key, label, ...metrics, mix: topMix(values) };
  });
  const classifiable = segments.filter(item => ['feminine-associated', 'masculine-associated'].includes(item.key))
    .reduce((total, item) => total + item.orders, 0);
  return { segments, classifiableOrders: classifiable,
    classifiedPercent: orders.length ? round(classifiable / orders.length * 100, 1) : 0,
    scope: `${orders.length} pedidos del período; la unidad analizada es el pedido, no una persona.`,
    limitations: '“Género estimado por nombre” es una asociación lingüística orientativa y agregada. Un nombre no confirma identidad ni género, puede corresponder a quien retira o paga, y no permite contar clientes únicos. Entradas ambiguas, genéricas o fuera del diccionario quedan indeterminadas. No se generan recomendaciones basadas solo en este segmento.' };
}

function parseTimeBands(filters = {}) {
  const points = [Number(filters.morningEnd), Number(filters.middayEnd), Number(filters.afternoonEnd)]
    .map((value, index) => Number.isFinite(value) ? value : [12, 16, 20][index]);
  const [morningEnd, middayEnd, afternoonEnd] = points;
  if (!(morningEnd >= 1 && morningEnd < middayEnd && middayEnd < afternoonEnd && afternoonEnd <= 23)) {
    return [{ key: 'morning', label: 'Mañana', from: 0, to: 12 }, { key: 'midday', label: 'Mediodía', from: 12, to: 16 },
      { key: 'afternoon', label: 'Tarde', from: 16, to: 20 }, { key: 'night', label: 'Noche', from: 20, to: 24 }];
  }
  return [{ key: 'morning', label: 'Mañana', from: 0, to: morningEnd },
    { key: 'midday', label: 'Mediodía', from: morningEnd, to: middayEnd },
    { key: 'afternoon', label: 'Tarde', from: middayEnd, to: afternoonEnd },
    { key: 'night', label: 'Noche', from: afternoonEnd, to: 24 }];
}

function aggregateOccasions(orders, filters) {
  const bands = parseTimeBands(filters);
  const totalSales = sum(orders.map(order => order.netSales));
  const byBand = bands.map(band => {
    const values = orders.filter(order => Number(order.hour) >= band.from && Number(order.hour) < band.to);
    const metrics = basicMetrics(values);
    return { ...band, evidenceKey: `${band.from}-${band.to}`, ...metrics, orderSharePercent: orders.length ? round(values.length / orders.length * 100, 1) : 0,
      salesSharePercent: totalSales ? round(metrics.netSales / totalSales * 100, 1) : 0, mix: topMix(values, 6) };
  });
  const weekday = orders.filter(order => ![0, 6].includes(new Date(`${order.date}T12:00:00Z`).getUTCDay()));
  const saturday = orders.filter(order => new Date(`${order.date}T12:00:00Z`).getUTCDay() === 6);
  return { bands: byBand, weekday: { ...basicMetrics(weekday), mix: topMix(weekday) },
    saturday: { ...basicMetrics(saturday), mix: topMix(saturday) },
    scope: `${orders.length} pedidos, clasificados por la hora registrada en la venta y las franjas configuradas.`,
    limitations: 'Las ventas son demanda atendida. Horas sin pedidos no prueban que el local estuviera abierto; sin calendario histórico completo no se normalizan todavía todas las cifras por hora operada. La modalidad depende de Detalle Pagos y puede quedar sin clasificar.' };
}

function recurrenceGroup(order, histories, periodEnd) {
  if (!order.instrumentKey) return 'unlinked';
  const dates = [...(histories.get(order.instrumentKey) || [])].filter(date => date <= periodEnd).sort();
  return dates.length >= 2 ? 'returning-instrument' : 'single-observed-date';
}

function aggregateRecurrence(selected, allOrders, period, linkageCoverage = {}) {
  const histories = new Map();
  for (const order of allOrders) {
    if (!order.instrumentKey || order.date > period.to) continue;
    const dates = histories.get(order.instrumentKey) || new Set();
    dates.add(order.date);
    histories.set(order.instrumentKey, dates);
  }
  const annotated = selected.map(order => ({ ...order, recurrenceGroup: recurrenceGroup(order, histories, period.to) }));
  const definitions = [['returning-instrument', 'Instrumento recurrente'], ['single-observed-date', 'Una fecha observada'], ['unlinked', 'Sin vínculo confiable']];
  const totalSales = sum(annotated.map(order => order.netSales));
  const groups = definitions.map(([key, label]) => {
    const values = annotated.filter(order => order.recurrenceGroup === key);
    const metrics = basicMetrics(values);
    return { key, label, ...metrics, salesSharePercent: totalSales ? round(metrics.netSales / totalSales * 100, 1) : null, mix: topMix(values) };
  });
  const selectedKeys = new Set(annotated.map(order => order.instrumentKey).filter(Boolean));
  const returningKeys = [...selectedKeys].filter(key => (histories.get(key)?.size || 0) >= 2);
  const gaps = [];
  for (const key of selectedKeys) {
    const dates = [...histories.get(key)].sort();
    for (let index = 1; index < dates.length; index++) gaps.push(daysBetween(dates[index - 1], dates[index]));
  }
  const cohorts = new Map();
  for (const key of selectedKeys) {
    const dates = [...histories.get(key)].sort();
    if (!dates.length) continue;
    const month = dates[0].slice(0, 7);
    const cohort = cohorts.get(month) || { month, instruments: 0, returned30: 0, eligible30: 0 };
    cohort.instruments += 1;
    if (daysBetween(dates[0], period.to) >= 30) {
      cohort.eligible30 += 1;
      if (dates.slice(1).some(date => daysBetween(dates[0], date) <= 30)) cohort.returned30 += 1;
    }
    cohorts.set(month, cohort);
  }
  return { groups, identifiableInstruments: selectedKeys.size, returningInstruments: returningKeys.length,
    returningInstrumentPercent: selectedKeys.size ? round(returningKeys.length / selectedKeys.size * 100, 1) : null,
    medianGapDays: median(gaps), p25GapDays: percentile(gaps, .25), p75GapDays: percentile(gaps, .75),
    multiLocationInstruments: [...selectedKeys].filter(key => new Set(allOrders.filter(order => order.instrumentKey === key).map(order => order.locationId)).size > 1).length,
    cohorts: [...cohorts.values()].sort((a, b) => a.month.localeCompare(b.month)).map(item => ({ ...item,
      return30Percent: item.eligible30 ? round(item.returned30 / item.eligible30 * 100, 1) : null })),
    linkageCoverage,
    scope: `${selectedKeys.size} instrumentos pseudonimizados vinculados a pedidos del período; recurrencia = compras en dos o más fechas observadas hasta ${period.to}.`,
    limitations: 'Un instrumento de pago no equivale a una persona: puede ser compartido, reemplazado o pagar para terceros. El vínculo con MercadoPago es estimado por local, fecha, monto y hora; se excluyen coincidencias ambiguas. “Primera compra observada” no significa cliente nuevo y las cohortes recientes tienen menos tiempo para volver.' };
}

function bandRows(observations, width) {
  const map = new Map();
  for (const observation of observations) {
    if (!(observation.value >= 0)) continue;
    const normalizedValue = Math.round(observation.value);
    const from = Math.floor(normalizedValue / width) * width;
    const row = map.get(from) || { from, to: from + width, observations: 0, units: 0, netSales: 0 };
    row.observations += 1;
    row.units += Number(observation.units) || 1;
    row.netSales += Number(observation.netSales) || 0;
    map.set(from, row);
  }
  return [...map.values()].sort((a, b) => a.from - b.from).map(row => ({ ...row, netSales: round(row.netSales, 2) }));
}

function aggregatePriceSignals(orders, filters = {}) {
  const width = Math.min(10000, Math.max(100, Math.round(Number(filters.priceBand) || 500)));
  const ticketObservations = orders.map(order => ({ value: order.netSales * 1.19, netSales: order.netSales }));
  const lineObservations = [];
  const pricesByProduct = new Map();
  for (const order of orders) for (const line of order.lines.filter(item => !item.isExtra && item.quantity > 0 && item.netSales >= 0)) {
    const paidUnitGross = line.netSales * 1.19 / line.quantity;
    // TotEat informa Precio Base a nivel unitario y Precio a Pagar como total de la línea.
    const baseUnitGross = Number(line.baseGross) > 0 ? Number(line.baseGross) : null;
    const observation = { value: paidUnitGross, units: line.quantity, netSales: line.netSales, code: line.code, name: line.name,
      date: order.date, orderKey: order.orderKey, locationId: order.locationId, categoryId: line.categoryId,
      categoryName: line.categoryName, cost: line.costAvailable ? line.cost : null,
      baseUnitGross, discounted: baseUnitGross != null && paidUnitGross < baseUnitGross - 1 };
    lineObservations.push(observation);
    const product = pricesByProduct.get(line.code) || { code: line.code, name: line.name, values: [], rows: [], units: 0, discountedLines: 0 };
    product.values.push(paidUnitGross); product.units += line.quantity;
    product.rows.push(observation);
    if (observation.discounted) product.discountedLines += 1;
    pricesByProduct.set(line.code, product);
  }
  const productVariation = [...pricesByProduct.values()].map(product => ({ code: product.code, name: product.name,
    observations: product.values.length, units: round(product.units, 1), minimumPaidGross: Math.min(...product.values),
    medianPaidGross: median(product.values), maximumPaidGross: Math.max(...product.values), distinctPrices: new Set(product.values.map(value => Math.round(value / 10) * 10)).size,
    discountedLinePercent: product.values.length ? round(product.discountedLines / product.values.length * 100, 1) : null }))
    .filter(product => product.observations >= 5 && product.distinctPrices >= 2)
    .sort((a, b) => b.observations - a.observations).slice(0, 50);
  const thresholds = [4500, 5000].map(value => ({ value,
    below: lineObservations.filter(item => item.value < value).length,
    atOrAbove: lineObservations.filter(item => item.value >= value).length }));
  const mondayFor = date => {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - ((day + 6) % 7));
    return value.toISOString().slice(0, 10);
  };
  const weeklyByProduct = new Map();
  for (const item of lineObservations) {
    const key = `${item.code}|${mondayFor(item.date)}`;
    const group = weeklyByProduct.get(key) || { code: item.code, name: item.name, week: mondayFor(item.date), prices: [], observations: 0 };
    group.prices.push(item.value); group.observations += 1; weeklyByProduct.set(key, group);
  }
  const weeksByProduct = new Map();
  for (const group of weeklyByProduct.values()) {
    group.medianPrice = median(group.prices);
    const rows = weeksByProduct.get(group.code) || []; rows.push(group); weeksByProduct.set(group.code, rows);
  }
  const shiftDate = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
  const priceEvents = [];
  for (const [code, weeks] of weeksByProduct) {
    weeks.sort((a, b) => a.week.localeCompare(b.week));
    for (let index = 1; index < weeks.length; index++) {
      const beforeWeek = weeks[index - 1]; const eventWeek = weeks[index];
      const difference = eventWeek.medianPrice - beforeWeek.medianPrice;
      if (beforeWeek.observations < 5 || eventWeek.observations < 5 || Math.abs(difference) < Math.max(100, beforeWeek.medianPrice * .02)) continue;
      const beforeFrom = shiftDate(eventWeek.week, -28); const beforeTo = shiftDate(eventWeek.week, -1);
      const afterFrom = eventWeek.week; const afterTo = shiftDate(eventWeek.week, 27);
      const productRows = pricesByProduct.get(code)?.rows || [];
      const beforeRows = productRows.filter(item => item.date >= beforeFrom && item.date <= beforeTo);
      const afterRows = productRows.filter(item => item.date >= afterFrom && item.date <= afterTo);
      if (beforeRows.length < 10 || afterRows.length < 10) continue;
      const beforeUnits = sum(beforeRows.map(item => item.units)); const afterUnits = sum(afterRows.map(item => item.units));
      priceEvents.push({ key: `${code}|${eventWeek.week}`, code, name: eventWeek.name, eventDate: eventWeek.week,
        previousMedianGross: round(beforeWeek.medianPrice, 0), newMedianGross: round(eventWeek.medianPrice, 0),
        priceChangePercent: beforeWeek.medianPrice ? round(difference / beforeWeek.medianPrice * 100, 1) : null,
        beforeObservations: beforeRows.length, afterObservations: afterRows.length,
        beforeUnits: round(beforeUnits, 1), afterUnits: round(afterUnits, 1),
        unitChangePercent: beforeUnits ? round((afterUnits - beforeUnits) / beforeUnits * 100, 1) : null,
        beforeNetSales: round(sum(beforeRows.map(item => item.netSales)), 2), afterNetSales: round(sum(afterRows.map(item => item.netSales)), 2),
        comparison: `${beforeFrom}–${beforeTo} vs ${afterFrom}–${afterTo}`,
        caveat: 'Ventanas descriptivas de 28 días; no controlan promociones, stock, exposición, estacionalidad ni cambios de horario.' });
    }
  }
  priceEvents.sort((a, b) => b.eventDate.localeCompare(a.eventDate) || b.afterObservations - a.afterObservations);
  return { bandSize: width, ticketBands: bandRows(ticketObservations, width), productPriceBands: bandRows(lineObservations, width),
    productVariation, thresholds,
    priceEvents: priceEvents.slice(0, 50),
    paidPriceObservations: lineObservations.length,
    explicitBasePriceObservations: lineObservations.filter(item => item.baseUnitGross != null).length,
    discountedObservations: lineObservations.filter(item => item.discounted).length,
    scope: `${lineObservations.length} líneas de producto y ${orders.length} tickets; intervalos configurables de $${width.toLocaleString('es-CL')}, con IVA.`,
    limitations: 'Se muestra precio efectivamente pagado, separado del precio base cuando existe. La concentración cerca de un valor no demuestra una barrera: depende del surtido, exposición, descuentos, stock y mezcla de productos. La variación histórica es una señal exploratoria; sin promociones y disponibilidad completas no se estima elasticidad causal.' };
}

function buildDemandIntelligence({ selected, allOrders, period, filters, linkageCoverage }) {
  return { nameSegments: aggregateNameSegments(selected), occasions: aggregateOccasions(selected, filters),
    recurrence: aggregateRecurrence(selected, allOrders, period, linkageCoverage),
    priceSignals: aggregatePriceSignals(selected, filters) };
}

module.exports = { basicMetrics, topMix, parseTimeBands, aggregateNameSegments, aggregateOccasions,
  aggregateRecurrence, aggregatePriceSignals, buildDemandIntelligence };
