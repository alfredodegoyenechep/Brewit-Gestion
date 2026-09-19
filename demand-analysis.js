const { addDays, businessClock, percentageChange } = require('./network-sales');
const { buildDemandIntelligence } = require('./demand-intelligence');

const DAY = 86400000;
const WEEKDAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const round = (value, digits = 0) => Number((Number(value) || 0).toFixed(digits));
const sum = values => values.reduce((total, value) => total + (Number(value) || 0), 0);
const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
const dayCount = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY) + 1;
const datesBetween = (from, to) => {
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
};
const median = values => {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function resolveDemandPeriod(filters, today, firstSaleDate) {
  const mode = filters.mode || 'month';
  const anchor = filters.anchor || today;
  if (mode === 'custom') return { from: filters.dateFrom, to: filters.dateTo, mode };
  if (mode === 'day') return { from: anchor, to: anchor, mode };
  if (mode === 'week') {
    const from = addDays(anchor, -((weekday(anchor) + 6) % 7));
    return { from, to: addDays(from, 6) < today ? addDays(from, 6) : today, mode };
  }
  if (mode === 'month') {
    const from = `${anchor.slice(0, 7)}-01`;
    const nextMonth = new Date(`${from}T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const end = addDays(nextMonth.toISOString().slice(0, 10), -1);
    return { from, to: end < today ? end : today, mode };
  }
  if (mode === 'ytd') return { from: `${anchor.slice(0, 4)}-01-01`, to: anchor < today ? anchor : today, mode };
  return { from: firstSaleDate || today, to: today, mode: 'all' };
}

function previousPeriod(period) {
  const days = dayCount(period.from, period.to);
  if (period.mode === 'day') return { from: addDays(period.from, -7), to: addDays(period.to, -7), label: 'Mismo día de la semana anterior' };
  if (period.mode === 'week') return { from: addDays(period.from, -7), to: addDays(period.to, -7), label: 'Semana anterior equivalente' };
  if (period.mode === 'month') {
    const previousMonthEnd = addDays(period.from, -1);
    const previousMonthStart = `${previousMonthEnd.slice(0, 7)}-01`;
    return { from: previousMonthStart, to: previousMonthEnd, label: 'Mes anterior, días operados equivalentes' };
  }
  if (period.mode === 'ytd') {
    const previousYear = Number(period.from.slice(0, 4)) - 1;
    return { from: `${previousYear}-01-01`, to: `${previousYear}-12-31`, label: 'Año anterior equivalente' };
  }
  return { from: addDays(period.from, -days), to: addDays(period.from, -1), label: 'Período anterior de igual duración' };
}

function scheduledDay(store, date) {
  if (!store.openingDate || !Array.isArray(store.operatingWeekdays) || !store.operatingWeekdays.length) return null;
  if (date < store.openingDate) return false;
  if (Array.isArray(store.closedDates) && store.closedDates.includes(date)) return false;
  return store.operatingWeekdays.includes(weekday(date));
}

function sourceCovers(store, date) {
  return (store.salesRanges || []).some(range => date >= range.from && date <= range.to
    && !(range.excludedRanges || []).some(excluded => date >= excluded.from && date <= excluded.to));
}

function comparableDatePairs(store, period, previous, today, cutoff = businessClock().cutoff) {
  if (!store.openingDate || !Array.isArray(store.operatingWeekdays) || !store.operatingWeekdays.length) {
    return { valid: false, reason: 'Configura apertura y días de operación para comparar períodos equivalentes.' };
  }
  if (!store.operatingWeekdays.every(day => store.operatingHours?.[day]?.open && store.operatingHours?.[day]?.close)) {
    return { valid: false, reason: 'Configura horarios de apertura y cierre por día para comparar horas efectivamente operadas.' };
  }
  const currentDates = datesBetween(period.from, period.to).filter(date => scheduledDay(store, date));
  const previousDates = datesBetween(previous.from, previous.to).filter(date => scheduledDay(store, date));
  if (!currentDates.length || previousDates.length < currentDates.length) {
    return { valid: false, reason: 'No existen suficientes días operados en el período anterior.' };
  }
  const matchedPrevious = previousDates.slice(0, currentDates.length);
  const incompatibleHours = currentDates.some((date, index) => {
    const currentHours = store.operatingHours[weekday(date)];
    const priorHours = store.operatingHours[weekday(matchedPrevious[index])];
    return currentHours.open !== priorHours.open || currentHours.close !== priorHours.close;
  });
  if (incompatibleHours) return { valid: false, reason: 'Los días equivalentes tienen horarios distintos; falta una comparación de horas homogénea.' };
  const uncovered = [...currentDates, ...matchedPrevious].filter(date => !sourceCovers(store, date));
  if (uncovered.length) {
    return { valid: false, reason: `Falta cobertura de archivos en ${uncovered.length} día(s) programado(s).` };
  }
  return { valid: true, currentDates, previousDates: matchedPrevious,
    cutoff: currentDates.includes(today) ? cutoff : null };
}

function summarizeOrders(orders) {
  const tickets = orders.map(order => (Number(order.netSales) || 0) * 1.19);
  const netSales = sum(orders.map(order => order.netSales));
  const discountGross = sum(orders.map(order => Math.abs(Number(order.orderDiscount) || 0)));
  const grossAfterDiscount = netSales * 1.19;
  const costAvailable = orders.every(order => order.costAvailable);
  const costCoveredSales = sum(orders.filter(order => order.costAvailable).map(order => order.netSales));
  const cost = sum(orders.map(order => order.cost));
  return {
    orders: orders.length,
    netSales: round(netSales, 2),
    averageTicketGross: orders.length ? round(grossAfterDiscount / orders.length, 2) : null,
    medianTicketGross: median(tickets),
    discountPercent: grossAfterDiscount + discountGross > 0
      ? round(discountGross / (grossAfterDiscount + discountGross) * 100, 1) : null,
    cost: costAvailable && orders.length ? round(cost, 2) : null,
    marginPercent: costAvailable && netSales > 0 ? round((netSales - cost) / netSales * 100, 1) : null,
    costCoveredOrders: orders.filter(order => order.costAvailable).length,
    costCoveredSales: round(costCoveredSales, 2)
  };
}

function orderMatches(order, filters) {
  if (filters.modeOfService && filters.modeOfService !== 'all' && order.mode !== filters.modeOfService) return false;
  if (filters.channel && order.channel !== filters.channel) return false;
  if (filters.size && !order.lines.some(line => line.size === filters.size)) return false;
  if (filters.product && !order.lines.some(line => !line.isExtra && line.code === filters.product)) return false;
  if (filters.category && !order.lines.some(line => !line.isExtra && String(line.categoryId || line.hierarchyId || '').startsWith(filters.category))) return false;
  if (filters.nameGender && filters.nameGender !== 'all' && order.nameGenderSegment !== filters.nameGender) return false;
  if (filters.recurrence && filters.recurrence !== 'all' && order.recurrenceGroup !== filters.recurrence) return false;
  return true;
}

function aggregatePortfolio(orders, previousOrders) {
  const group = (values, keyOf) => {
    const map = new Map();
    for (const order of values) for (const line of order.lines.filter(item => !item.isExtra)) {
      const key = keyOf(line);
      const current = map.get(key) || { key, name: key === line.code ? line.name : line.categoryName || 'Sin categoría',
        units: 0, netSales: 0, cost: 0, costMissing: false, orders: new Set() };
      current.units += Number(line.quantity) || 0;
      current.netSales += Number(line.netSales) || 0;
      current.cost += Number(line.cost) || 0;
      if (!line.costAvailable) current.costMissing = true;
      current.orders.add(order.orderKey);
      map.set(key, current);
    }
    return map;
  };
  const build = keyOf => {
    const current = group(orders, keyOf);
    const prior = group(previousOrders, keyOf);
    const totalSales = sum([...current.values()].map(item => item.netSales));
    return [...current.values()].map(item => ({
      key: item.key, name: item.name, units: round(item.units, 2), netSales: round(item.netSales, 2),
      orders: item.orders.size, salesSharePercent: totalSales ? round(item.netSales / totalSales * 100, 1) : 0,
      marginPercent: item.costMissing || !item.netSales ? null : round((item.netSales - item.cost) / item.netSales * 100, 1),
      previousSales: round(prior.get(item.key)?.netSales || 0, 2),
      salesChangePercent: percentageChange(item.netSales, prior.get(item.key)?.netSales || 0)
    })).sort((left, right) => right.netSales - left.netSales || left.name.localeCompare(right.name, 'es'));
  };
  return { products: build(line => line.code || line.name), categories: build(line => line.categoryId || line.categoryName || 'Sin categoría') };
}

function aggregateBaskets(orders) {
  const baseOrders = orders.map(order => ({ order, codes: [...new Set(order.lines.filter(line => !line.isExtra && line.code).map(line => line.code))] }))
    .filter(item => item.codes.length);
  const productNames = new Map(orders.flatMap(order => order.lines.map(line => [line.code, line.name])));
  const singles = new Map();
  const pairs = new Map();
  for (const item of baseOrders) {
    item.codes.forEach(code => singles.set(code, (singles.get(code) || 0) + 1));
    for (let left = 0; left < item.codes.length; left++) for (let right = left + 1; right < item.codes.length; right++) {
      const [first, second] = [item.codes[left], item.codes[right]].sort();
      const key = `${first}|${second}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  const minimumOrders = Math.max(5, Math.ceil(baseOrders.length * 0.005));
  const pairRows = [...pairs].filter(([, count]) => count >= minimumOrders).map(([key, count]) => {
    const [leftCode, rightCode] = key.split('|');
    const leftOrders = singles.get(leftCode) || 0;
    const rightOrders = singles.get(rightCode) || 0;
    const support = count / baseOrders.length;
    return {
      key, leftCode, rightCode, leftName: productNames.get(leftCode) || leftCode,
      rightName: productNames.get(rightCode) || rightCode, orders: count,
      supportPercent: round(support * 100, 1),
      confidenceLeftToRightPercent: round(count / leftOrders * 100, 1),
      confidenceRightToLeftPercent: round(count / rightOrders * 100, 1),
      lift: round(support / ((leftOrders / baseOrders.length) * (rightOrders / baseOrders.length)), 2)
    };
  }).sort((left, right) => right.orders - left.orders || right.lift - left.lift).slice(0, 50);
  const coffeeOrders = baseOrders.filter(item => item.order.lines.some(line => !line.isExtra
    && line.categoryPath.some(label => /barra cafe/.test(normalized(label)))));
  const coffeeWithBakery = coffeeOrders.filter(item => item.order.lines.some(line => !line.isExtra
    && line.categoryPath.some(label => /bolleria/.test(normalized(label)))));
  return { ordersAnalyzed: baseOrders.length, minimumPairOrders: minimumOrders, pairs: pairRows,
    coffeeBakery: { coffeeOrders: coffeeOrders.length, togetherOrders: coffeeWithBakery.length,
      attachRatePercent: coffeeOrders.length ? round(coffeeWithBakery.length / coffeeOrders.length * 100, 1) : null,
      definition: 'Pedidos con producto en «Barra Cafe» que también contienen producto en «Bolleria»; categorías del maestro vigente.' } };
}

function aggregateTime(orders) {
  const cells = Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => ({ day, hour, orders: 0, netSales: 0 })));
  const daily = new Map();
  const weekly = new Map();
  const monthly = new Map();
  for (const order of orders) {
    const day = weekday(order.date);
    const hour = Math.max(0, Math.min(23, Number(String(order.time || '').slice(0, 2)) || 0));
    cells[day][hour].orders++;
    cells[day][hour].netSales += Number(order.netSales) || 0;
    const monday = addDays(order.date, -((day + 6) % 7));
    for (const [map, key] of [[daily, order.date], [weekly, monday], [monthly, order.date.slice(0, 7)]]) {
      const item = map.get(key) || { key, orders: 0, netSales: 0 };
      item.orders++;
      item.netSales += Number(order.netSales) || 0;
      map.set(key, item);
    }
  }
  const series = map => [...map.values()].sort((left, right) => left.key.localeCompare(right.key))
    .map(item => ({ ...item, netSales: round(item.netSales, 2) }));
  return { weekdays: WEEKDAYS, heatmap: cells.flat().map(item => ({ ...item, netSales: round(item.netSales, 2) })),
    daily: series(daily), weekly: series(weekly), monthly: series(monthly) };
}

function aggregateSpending(orders, width = 500) {
  const ticketBands = new Map();
  const priceBands = new Map();
  const addBand = (map, amount, width, units = 1) => {
    const from = Math.floor(Math.max(0, amount) / width) * width;
    const item = map.get(from) || { from, to: from + width, observations: 0, units: 0 };
    item.observations++;
    item.units += units;
    map.set(from, item);
  };
  for (const order of orders) {
    addBand(ticketBands, order.netSales * 1.19, width);
    for (const line of order.lines.filter(item => !item.isExtra && item.quantity > 0 && item.netSales >= 0)) {
      addBand(priceBands, line.netSales * 1.19 / line.quantity, width, line.quantity);
    }
  }
  const rows = map => [...map.values()].sort((left, right) => left.from - right.from);
  return { ticketBands: rows(ticketBands), productPriceBands: rows(priceBands) };
}

function buildEvidenceAndActions({ summary, baskets, portfolio, time, coverage, comparisons, intelligence }) {
  const hypotheses = [];
  const actions = [];
  const strongPair = baskets.pairs.find(pair => pair.lift >= 1.3 && pair.supportPercent >= 1 && pair.orders >= 20);
  if (strongPair) {
    hypotheses.push({ id: 'H-CANASTA', title: `${strongPair.leftName} y ${strongPair.rightName} aparecen juntos más de lo esperado`,
      evidence: `En ${strongPair.orders} pedidos: soporte ${strongPair.supportPercent}%, lift ${strongPair.lift}.`,
      alternatives: 'Su ubicación en la carta, una promoción, el horario o el local pueden explicar parte de la coincidencia.',
      missing: 'Exposición de la oferta y registro de promociones.',
      validation: 'Probar una recomendación en un local o franja y comparar la tasa de inclusión con un control equivalente.',
      evidenceRef: { kind: 'pair', key: strongPair.key, section: 'demand-baskets' } });
    actions.push({ id: 'A-CANASTA', title: 'Probar una recomendación de acompañamiento', goal: 'Aumentar la proporción de pedidos con ambos productos sin reducir margen.',
      test: 'Mostrar la sugerencia en una franja o local y conservar otro equivalente sin intervención.',
      metric: 'Pedidos con ambos / pedidos con el producto inicial; ticket mediano y margen con cobertura.',
      evidenceId: 'H-CANASTA', impactBasis: `${strongPair.orders} pedidos observados`, impactScore: strongPair.supportPercent >= 5 ? 3 : 2,
      evidenceScore: strongPair.orders >= 50 ? 2 : 1, effortScore: 1 });
  }
  const topProduct = portfolio.products[0];
  if (topProduct && topProduct.salesSharePercent >= 10) {
    hypotheses.push({ id: 'H-PORTAFOLIO', title: `La venta está concentrada en ${topProduct.name}`,
      evidence: `${topProduct.salesSharePercent}% de la venta de líneas base y ${topProduct.orders} pedidos.`,
      alternatives: 'El surtido ofrecido y la disponibilidad de sustitutos también pueden generar esta concentración.',
      missing: 'Exposición de carta, quiebres de stock y oportunidades perdidas.',
      validation: 'Revisar disponibilidad y comparar el mix en períodos equivalentes antes y después de cualquier cambio.',
      evidenceRef: { kind: 'product', key: topProduct.key, section: 'demand-products' } });
    actions.push({ id: 'A-PORTAFOLIO', title: 'Proteger la disponibilidad del producto principal', goal: 'Evitar pérdida de ventas atendibles.',
      test: 'Registrar quiebres y tiempos de reposición durante dos períodos comparables.',
      metric: 'Pedidos y unidades por día y hora abiertos; quiebres registrados.', evidenceId: 'H-PORTAFOLIO',
      impactBasis: `${topProduct.orders} pedidos observados`, impactScore: topProduct.salesSharePercent >= 20 ? 3 : 2,
      evidenceScore: 2, effortScore: 2 });
  }
  if (!comparisons.available) {
    actions.push({ id: 'A-COBERTURA', title: 'Completar el calendario y la cobertura de ventas',
      goal: 'Habilitar comparaciones justas entre días, meses y locales.',
      test: 'Configurar fecha de apertura, días y horas de operación y revisar fechas sin archivos.',
      metric: 'Porcentaje de días programados con cobertura verificada.', evidenceId: null,
      impactBasis: comparisons.reason, impactScore: 2, evidenceScore: 3, effortScore: 1,
      evidenceRef: { section: 'demand-coverage' } });
  }
  if (summary.costCoveredOrders < summary.orders) {
    actions.push({ id: 'A-COSTOS', title: 'Completar costos de los pedidos sin valoración',
      goal: 'Poder interpretar márgenes sin imputar costo cero.',
      test: 'Revisar productos y recetas faltantes en Costos por Revisar.',
      metric: 'Pedidos y venta neta con costo calculable.', evidenceId: null,
      impactBasis: `${summary.orders - summary.costCoveredOrders} pedidos sin costo completo`,
      impactScore: 2, evidenceScore: 3, effortScore: 2, evidenceRef: { section: 'demand-coverage' } });
  }
  const recurring = intelligence?.recurrence;
  if (recurring?.identifiableInstruments >= 30 && (recurring.linkageCoverage?.linkedPercent || 0) >= 70) {
    const returningGroup = recurring.groups.find(item => item.key === 'returning-instrument');
    hypotheses.push({ id: 'H-RECURRENCIA', title: 'Los instrumentos recurrentes representan una parte medible de la demanda vinculada',
      evidence: `${recurring.returningInstruments}/${recurring.identifiableInstruments} instrumentos tienen compras en al menos dos fechas; ${returningGroup?.orders || 0} pedidos observados en el segmento recurrente.`,
      alternatives: 'Un instrumento puede ser compartido y una misma persona puede usar varios; el pagador puede no ser quien consume.',
      missing: 'Identificador de cliente consentido y explícito, además de mayor cobertura de otros medios de pago.',
      validation: 'Implementar identificación voluntaria y comparar recurrencia observada con la señal del instrumento sin unir perfiles automáticamente.',
      evidenceRef: { kind: 'recurrence', key: 'returning-instrument', section: 'demand-recurrence' } });
    actions.push({ id: 'A-RECURRENCIA', title: 'Medir fidelización con identificación voluntaria', goal: 'Distinguir clientes de instrumentos y medir retorno de manera defendible.',
      test: 'Piloto opt-in en un local, sin alterar el servicio, contrastando cobertura y retorno a 30 días.',
      metric: 'Cobertura consentida, tasa de retorno a 30 días y diferencia frente a instrumentos observados.', evidenceId: 'H-RECURRENCIA',
      impactBasis: `${recurring.identifiableInstruments} instrumentos vinculados`, impactScore: 2, evidenceScore: 2, effortScore: 2 });
  }
  const priceCandidate = intelligence?.priceSignals?.priceEvents?.[0];
  if (priceCandidate) {
    hypotheses.push({ id: 'H-PRECIO', title: `${priceCandidate.name} muestra una señal alrededor de un cambio de precio pagado`,
      evidence: `La mediana semanal pasó de $${Math.round(priceCandidate.previousMedianGross).toLocaleString('es-CL')} a $${Math.round(priceCandidate.newMedianGross).toLocaleString('es-CL')}; las unidades variaron ${priceCandidate.unitChangePercent}% entre ventanas de 28 días (${priceCandidate.beforeObservations} y ${priceCandidate.afterObservations} observaciones).`,
      alternatives: 'Descuentos, tamaños, extras, errores de maestro, surtido y horarios pueden explicar la variación.',
      missing: 'Historial completo de precio de lista, promociones, disponibilidad y exposición.',
      validation: 'Auditar los cambios y, solo si son comparables, contrastar unidades por día y hora operados antes/después con un producto o local control.',
      evidenceRef: { kind: 'product', key: priceCandidate.code, section: 'demand-prices' } });
  }
  actions.forEach(action => {
    action.priorityScore = action.impactScore * 2 + action.evidenceScore - action.effortScore;
    action.priorityRule = 'Alcance observado × 2 + solidez de la fuente − esfuerzo; escala ordinal 1–3, no estimación monetaria.';
  });
  actions.sort((left, right) => right.priorityScore - left.priorityScore);
  return { hypotheses, actions };
}

function buildAnnualSeasonality(orders, stores, today) {
  const lastCompleteYear = Number(today.slice(0, 4)) - 1;
  const observations = [];
  const eligibleStores = [];
  for (const store of stores) {
    if (!store.openingDate || !store.operatingWeekdays?.length
      || !store.operatingWeekdays.every(day => store.operatingHours?.[day]?.open && store.operatingHours?.[day]?.close)) continue;
    const completeYears = [];
    for (let year = lastCompleteYear; year >= lastCompleteYear - 5; year--) {
      const from = `${year}-01-01`;
      if (store.openingDate > from) continue;
      const monthly = [];
      let complete = true;
      for (let month = 1; month <= 12; month++) {
        const monthText = String(month).padStart(2, '0');
        const monthFrom = `${year}-${monthText}-01`;
        const nextMonth = new Date(`${monthFrom}T12:00:00Z`);
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        const monthTo = addDays(nextMonth.toISOString().slice(0, 10), -1);
        const openDates = datesBetween(monthFrom, monthTo).filter(date => scheduledDay(store, date));
        if (!openDates.length || openDates.some(date => !sourceCovers(store, date))) { complete = false; break; }
        const netSales = sum(orders.filter(order => order.locationId === store.id && order.date >= monthFrom && order.date <= monthTo
          && !order.reversalSignals?.length).map(order => order.netSales));
        monthly.push({ month, salesPerOpenDay: netSales / openDates.length });
      }
      if (complete) completeYears.push({ year, monthly });
      if (completeYears.length === 2) break;
    }
    if (completeYears.length < 2) continue;
    eligibleStores.push({ id: store.id, name: store.name, years: completeYears.map(item => item.year) });
    for (const item of completeYears) {
      const mean = sum(item.monthly.map(month => month.salesPerOpenDay)) / 12;
      if (!(mean > 0)) continue;
      item.monthly.forEach(month => observations.push({ storeId: store.id, year: item.year, month: month.month,
        index: month.salesPerOpenDay / mean * 100 }));
    }
  }
  return { available: eligibleStores.length > 0 && observations.length >= 24, eligibleStores,
    months: Array.from({ length: 12 }, (_, index) => {
      const values = observations.filter(item => item.month === index + 1);
      return { month: index + 1, observations: values.length,
        indexPercent: values.length ? round(sum(values.map(item => item.index)) / values.length, 1) : null };
    }),
    method: 'Índice descriptivo de venta neta por día programado abierto, dividido por el promedio mensual de cada local-año completo. Se requieren dos años completos del mismo local con cobertura declarada diaria; no prueba causalidad estacional.' };
}

function buildDemandAnalysis(input) {
  const { orders: allOrders, stores, filters, today } = input;
  const selectedIds = new Set(stores.map(store => store.id));
  const firstSaleDate = allOrders.filter(order => selectedIds.has(order.locationId) && order.date <= today)
    .map(order => order.date).sort()[0] || null;
  const period = resolveDemandPeriod(filters, today, firstSaleDate);
  const previous = previousPeriod(period);
  const annotateRecurrenceAt = endDate => {
    const histories = new Map();
    for (const order of allOrders) {
      if (!order.instrumentKey || order.date > endDate) continue;
      const dates = histories.get(order.instrumentKey) || new Set(); dates.add(order.date); histories.set(order.instrumentKey, dates);
    }
    return allOrders.map(order => ({ ...order, recurrenceGroup: order.instrumentKey
      ? ((histories.get(order.instrumentKey)?.size || 0) >= 2 ? 'returning-instrument' : 'single-observed-date') : 'unlinked' }));
  };
  const currentAnnotated = annotateRecurrenceAt(period.to);
  const previousAnnotated = annotateRecurrenceAt(previous.to);
  const selected = currentAnnotated.filter(order => selectedIds.has(order.locationId) && order.date >= period.from
    && order.date <= period.to && orderMatches(order, filters) && !order.reversalSignals?.length);
  const priorRaw = previousAnnotated.filter(order => selectedIds.has(order.locationId) && order.date >= previous.from
    && order.date <= previous.to && orderMatches(order, filters) && !order.reversalSignals?.length);
  const comparable = stores.map(store => ({ id: store.id, name: store.name,
    ...comparableDatePairs(store, period, previous, today, input.cutoff) }));
  const comparisonsAvailable = comparable.length > 0 && comparable.every(item => item.valid);
  const matchedDates = new Map(comparable.filter(item => item.valid).map(item => [item.id, item]));
  const currentComparable = comparisonsAvailable ? selected.filter(order => matchedDates.get(order.locationId).currentDates.includes(order.date)
    && (order.date !== today || order.time <= matchedDates.get(order.locationId).cutoff)) : [];
  const previousComparable = comparisonsAvailable ? priorRaw.filter(order => {
    const matching = matchedDates.get(order.locationId);
    return matching.previousDates.includes(order.date)
      && (order.date !== matching.previousDates.at(-1) || !matching.cutoff || order.time <= matching.cutoff);
  }) : [];
  const summary = summarizeOrders(selected);
  const previousSummary = comparisonsAvailable ? summarizeOrders(previousComparable) : null;
  const comparedSummary = comparisonsAvailable ? summarizeOrders(currentComparable) : null;
  const comparisons = { available: comparisonsAvailable, period: previous,
    reason: comparisonsAvailable ? null : comparable.find(item => !item.valid)?.reason || 'Sin historial comparable.',
    currentOrders: comparedSummary?.orders ?? null, previousOrders: previousSummary?.orders ?? null,
    netSalesChangePercent: comparisonsAvailable ? percentageChange(comparedSummary.netSales, previousSummary.netSales) : null };
  const portfolio = aggregatePortfolio(selected, comparisonsAvailable ? previousComparable : []);
  if (!comparisonsAvailable) for (const row of [...portfolio.products, ...portfolio.categories]) row.salesChangePercent = null;
  const baskets = aggregateBaskets(selected);
  const time = aggregateTime(selected);
  const intelligence = buildDemandIntelligence({ selected, allOrders, period, filters,
    linkageCoverage: input.linkageCoverage || {} });
  const spending = intelligence.priceSignals;
  const locations = stores.map(store => {
    const matching = comparable.find(item => item.id === store.id);
    const currentOrders = matching?.valid ? selected.filter(order => order.locationId === store.id
      && matching.currentDates.includes(order.date) && (order.date !== today || !matching.cutoff || order.time <= matching.cutoff)) : [];
    const previousOrders = matching?.valid ? priorRaw.filter(order => order.locationId === store.id
      && matching.previousDates.includes(order.date)
      && (order.date !== matching.previousDates.at(-1) || !matching.cutoff || order.time <= matching.cutoff)) : [];
    return { id: store.id, name: store.name,
      ...summarizeOrders(selected.filter(order => order.locationId === store.id)),
      firstSaleDate: allOrders.filter(order => order.locationId === store.id).map(order => order.date).sort()[0] || null,
      comparisonAvailable: Boolean(matching?.valid), comparisonReason: matching?.valid ? null : matching?.reason,
      salesChangePercent: matching?.valid ? percentageChange(sum(currentOrders.map(order => order.netSales)),
        sum(previousOrders.map(order => order.netSales))) : null };
  });
  const sourceDates = new Set(selected.map(order => order.date));
  const scheduledDays = stores.every(store => store.openingDate && store.operatingWeekdays?.length)
    ? stores.reduce((count, store) => count + datesBetween(period.from, period.to).filter(date => scheduledDay(store, date)).length, 0) : null;
  const coveredScheduledDays = scheduledDays === null ? null : stores.reduce((count, store) => count
    + datesBetween(period.from, period.to).filter(date => scheduledDay(store, date) && sourceCovers(store, date)).length, 0);
  const coverage = { orders: selected.length, lines: sum(selected.map(order => order.lines.length)),
    observedSalesDays: sourceDates.size, scheduledDays, coveredScheduledDays,
    paymentMatchedOrders: selected.filter(order => order.paymentMatched).length,
    unknownModeOrders: selected.filter(order => order.mode === 'unknown').length,
    costCoveredOrders: summary.costCoveredOrders, costCoveredSales: summary.costCoveredSales,
    firstSaleDate, lastSaleDate: allOrders.filter(order => selectedIds.has(order.locationId) && order.date <= today)
      .map(order => order.date).sort().at(-1) || null,
    calendarConfigured: scheduledDays !== null,
    operatingHoursConfigured: stores.every(store => store.operatingHours && Object.keys(store.operatingHours).length > 0) };
  const { hypotheses, actions } = buildEvidenceAndActions({ summary, baskets, portfolio, time, coverage, comparisons, intelligence });
  const monthsObserved = new Set(allOrders.filter(order => selectedIds.has(order.locationId) && order.date <= today)
    .map(order => order.date.slice(0, 7))).size;
  const annualSeasonality = buildAnnualSeasonality(allOrders.filter(order => orderMatches(order, filters)), stores, today);
  const advanced = [
    { key: 'seasonality', title: 'Estacionalidad anual', status: annualSeasonality.available ? 'exploratory' : 'insufficient',
      detail: annualSeasonality.available ? `${annualSeasonality.eligibleStores.length} local(es) con dos años completos comparables. Índice descriptivo, no efecto estacional aislado.` : `Hay ${monthsObserved} mes(es) con ventas observadas; se requieren dos años completos del mismo local, horarios y cobertura de archivos.`,
      scope: `${monthsObserved} mes(es) observados en ${stores.length} local(es) seleccionado(s).`,
      availableData: `${coverage.observedSalesDays} fechas con ventas y ${coverage.orders} pedidos en el período filtrado.`,
      limitations: 'Un patrón mensual puede responder a crecimiento, promociones, cierres o cambios operativos; no se atribuye automáticamente a estacionalidad.',
      requirements: 'Dos años completos del mismo local, calendario y horarios históricos, y cobertura continua de archivos.' },
    { key: 'elasticity', title: 'Elasticidad de precio', status: intelligence.priceSignals.productVariation.length ? 'exploratory' : 'insufficient',
      detail: intelligence.priceSignals.productVariation.length ? `${intelligence.priceSignals.productVariation.length} producto(s) tienen precios pagados variables y evidencia descriptiva. Se muestran señales; faltan promociones y disponibilidad para una elasticidad causal.` : 'Faltan variaciones verificables de precio, promociones y disponibilidad; la correlación precio–unidades no identifica causalidad.',
      scope: `${intelligence.priceSignals.paidPriceObservations} líneas con precio pagado; ${intelligence.priceSignals.priceEvents.length} señales con base mínima antes/después.`,
      availableData: 'Precio efectivamente pagado, unidades, venta, fecha, hora, local y costo cuando está disponible.',
      limitations: intelligence.priceSignals.limitations,
      requirements: 'Precio de lista histórico, promociones, disponibilidad, exposición y períodos de control comparables.' },
    { key: 'price-barrier', title: 'Posibles barreras de precio', status: intelligence.priceSignals.paidPriceObservations ? 'exploratory' : 'insufficient',
      detail: intelligence.priceSignals.paidPriceObservations ? `Distribución disponible en intervalos de $${intelligence.priceSignals.bandSize.toLocaleString('es-CL')} editables. Describe compras atendidas, no resistencia causal.` : 'No hay líneas con precio efectivamente pagado para explorar.',
      scope: `${intelligence.priceSignals.paidPriceObservations} precios pagados y ${summary.orders} tickets observados.`,
      availableData: `Distribuciones con IVA en intervalos de $${intelligence.priceSignals.bandSize.toLocaleString('es-CL')}; cortes exploratorios en $4.500 y $5.000.`,
      limitations: 'Una menor frecuencia sobre un precio puede deberse al surtido disponible, categorías distintas, descuentos o exposición; no demuestra desistimiento.',
      requirements: 'Surtido ofrecido, stock, exposición, promociones y pruebas controladas alrededor del umbral.' },
    { key: 'channel', title: 'Canal de venta', status: input.capabilities?.channel ? 'exploratory' : 'insufficient',
      detail: input.capabilities?.channel ? 'Origen informado en algunas ventas: filtra por canal y comprueba su cobertura antes de interpretar diferencias.' : 'El campo Origen de las exportaciones disponibles no contiene valores utilizables.',
      scope: input.capabilities?.channel ? 'Pedidos con canal explícito bajo los filtros activos.' : 'No hay observaciones clasificables por canal.',
      availableData: input.capabilities?.channel ? 'Canales explícitos de la exportación de ventas.' : 'Ventas, productos, modalidad y horarios; el campo de canal está vacío.',
      limitations: 'No se infiere canal desde el medio de pago, comentario o modalidad.',
      requirements: 'Completar y mantener un campo de canal explícito y estable en la fuente de ventas.' },
    { key: 'size', title: 'Tamaño o formato', status: input.capabilities?.size ? 'exploratory' : 'insufficient',
      detail: input.capabilities?.size ? 'Campo Tamaño informado en algunas ventas; compara solo líneas con clasificación explícita.' : 'Los nombres sugieren formatos, pero falta un mapeo explícito y validado por producto.',
      scope: input.capabilities?.size ? 'Líneas con tamaño explícito bajo los filtros activos.' : 'No hay líneas con tamaño validado.',
      availableData: 'Código, nombre, categoría, precio y cantidad de cada línea vendida.',
      limitations: 'No se deduce tamaño desde el nombre porque puede confundir formato, receta o descripción comercial.',
      requirements: 'Campo Tamaño poblado o maestro versionado código–formato validado.' },
    { key: 'lost-demand', title: 'Demanda perdida', status: 'insufficient', detail: 'Kardex diario no demuestra quiebres de vitrina ni clientes que desistieron; se necesita registro de disponibilidad.',
      scope: 'Solo demanda atendida registrada como venta.',
      availableData: 'Ventas y Kardex diario, útiles para inventario pero no para observar intentos de compra fallidos.',
      limitations: 'Venta cero no distingue local cerrado, producto no ofrecido, quiebre, falta técnica o ausencia de demanda.',
      requirements: 'Registro horario de disponibilidad/quiebres, cancelaciones, productos no ofrecidos y, si es posible, intentos de compra.' },
    { key: 'customers', title: 'Recurrencia observable', status: intelligence.recurrence.identifiableInstruments ? 'exploratory' : 'insufficient',
      detail: intelligence.recurrence.identifiableInstruments ? `${intelligence.recurrence.identifiableInstruments} instrumentos de pago pseudonimizados vinculados; no equivalen a clientes únicos y el vínculo es estimado.` : 'No hay vínculos de alta confianza entre pedidos e instrumentos de pago.',
      scope: intelligence.recurrence.scope,
      availableData: `${input.linkageCoverage?.linkedHigh || 0} pedidos vinculados con alta confianza; ${intelligence.recurrence.returningInstruments} instrumentos con dos o más fechas observadas.`,
      limitations: intelligence.recurrence.limitations,
      requirements: 'Identificador de cliente explícito y consentido para medir personas, hogares y recurrencia real.' }
  ];
  return { generatedAt: input.generatedAt || new Date().toISOString(), period, filters,
    scope: { locations: stores.map(store => ({ id: store.id, name: store.name })), label: stores.length === 1 ? stores[0].name : `${stores.length} cafeterías` },
    summary, comparisons, portfolio, baskets, time, spending, locations, coverage,
    occasions: intelligence.occasions, nameSegments: intelligence.nameSegments,
    recurrence: intelligence.recurrence, priceSignals: intelligence.priceSignals,
    hypotheses, actions, advanced, annualSeasonality,
    methodology: {
      sales: 'Venta neta sin IVA; ticket y precio pagado con IVA. Pedidos distintos, no personas.',
      cost: 'Costo de la última compra comparable disponible a la fecha de venta; receta y maestro como respaldo. Sin costo completo, margen no calculable.',
      comparisons: 'Solo se publican variaciones cuando apertura, horario habitual, cierres declarados y rangos de archivos del período comparado están cubiertos. Los rangos indican cobertura declarada, no garantizan integridad del archivo ni reconstruyen cambios históricos de horario.',
      demand: 'Las ventas registran demanda atendida, no quiebres ni clientes que no compraron.',
      basket: 'Soporte, confianza condicional y lift; un lift alto sin suficiente soporte no justifica un combo.',
      identity: 'El nombre se segmenta solo de forma agregada y orientativa. La recurrencia corresponde a instrumentos de pago pseudonimizados vinculados por coincidencia de local, fecha, monto y hora; no a personas confirmadas.',
      limitations: 'Cada bloque publica su alcance, denominador y limitaciones. Dato ausente no se interpreta como cero y las ventas observadas representan demanda atendida.'
    }
  };
}

module.exports = { resolveDemandPeriod, previousPeriod, comparableDatePairs, summarizeOrders, aggregateBaskets, orderMatches, buildDemandAnalysis };
