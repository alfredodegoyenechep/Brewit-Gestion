'use strict';

const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function round(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function statistics(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return { count: 0, sum: 0, mean: 0, median: 0, min: 0, max: 0, standardDeviation: 0, coefficientOfVariation: null };
  const average = mean(clean);
  const variance = clean.length > 1 ? sum(clean.map(value => (value - average) ** 2)) / (clean.length - 1) : 0;
  const deviation = Math.sqrt(variance);
  return {
    count: clean.length,
    sum: round(sum(clean)),
    mean: round(average),
    median: round(median(clean)),
    min: round(Math.min(...clean)),
    max: round(Math.max(...clean)),
    standardDeviation: round(deviation),
    coefficientOfVariation: average ? round(deviation / Math.abs(average) * 100, 1) : null
  };
}

function linearRegression(points) {
  if (points.length < 3) return { slope: 0, intercept: 0, rSquared: 0 };
  const xMean = mean(points.map(point => point.x));
  const yMean = mean(points.map(point => point.y));
  const denominator = sum(points.map(point => (point.x - xMean) ** 2));
  if (!denominator) return { slope: 0, intercept: yMean, rSquared: 0 };
  const slope = sum(points.map(point => (point.x - xMean) * (point.y - yMean))) / denominator;
  const intercept = yMean - slope * xMean;
  const total = sum(points.map(point => (point.y - yMean) ** 2));
  const residual = sum(points.map(point => (point.y - (intercept + slope * point.x)) ** 2));
  return { slope, intercept, rSquared: total ? Math.max(0, 1 - residual / total) : 0 };
}

function pearson(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = sum(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
  const denominator = Math.sqrt(sum(left.map(value => (value - leftMean) ** 2)) * sum(right.map(value => (value - rightMean) ** 2)));
  return denominator ? numerator / denominator : null;
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function dateRange(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function priorPeriod(from, to) {
  const days = Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000) + 1;
  const previousTo = new Date(`${from}T12:00:00Z`);
  previousTo.setUTCDate(previousTo.getUTCDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - days + 1);
  return { from: previousFrom.toISOString().slice(0, 10), to: previousTo.toISOString().slice(0, 10), days };
}

function inferFamily(product) {
  const normalized = normalizeText(product.name);
  const parenthetical = [...normalized.matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  const formatTokens = parenthetical.flatMap(value => value.split(/[,/\s-]+/)).filter(Boolean);
  const knownTokens = new Set(['cl', 'gr', 'xtr', 'hot', 'iced', 'frio', 'caliente', 'ch', 'md', 'gd', 'small', 'medium', 'large']);
  const format = formatTokens.filter(token => knownTokens.has(token) || /^\d+(?:oz|ml|g)$/.test(token)).join(' / ') || 'sin formato explícito';
  let family = normalized.replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:small|medium|large|chico|mediano|grande|caliente|frio|iced|hot|xtr|extra)\b/g, ' ')
    .replace(/\b\d+(?:\s*(?:oz|ml|g))?\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!family) family = normalized;
  return {
    key: `${(product.hierarchyPath || []).join('>')}|${family}`,
    family,
    format,
    confidence: parenthetical.length ? 'media' : 'baja'
  };
}

function impactForShare(share, growth = 0) {
  if (share >= 10 || Math.abs(growth) >= 40) return 'alto';
  if (share >= 3 || Math.abs(growth) >= 20) return 'medio';
  return 'bajo';
}

function reconcileOrderLineSales(order, productMap) {
  const lines = (order.lines || []).map(line => ({
    ...line,
    reportedNetSales: Number(line.netSales) || 0,
    salesAllocation: 'reported'
  }));
  const target = Number(order.netSales) || 0;
  const reportedTotal = sum(lines.map(line => line.reportedNetSales));
  if (!lines.length || target <= 0 || Math.abs(target - reportedTotal) < 0.01) return { ...order, lines };

  const zeroLines = lines.filter(line => !(line.reportedNetSales > 0));
  if (target > reportedTotal && zeroLines.length) {
    const residual = target - reportedTotal;
    const weights = zeroLines.map(line => {
      const quantity = Math.max(0, Number(line.quantity) || 0);
      const catalogValue = (Number(productMap.get(line.code)?.listPrice) || 0) * quantity;
      const reportedListValue = Math.max(0, Number(line.listGross) || 0);
      return reportedListValue || catalogValue || quantity || 1;
    });
    const totalWeight = sum(weights) || zeroLines.length;
    zeroLines.forEach((line, index) => {
      line.netSales = residual * weights[index] / totalWeight;
      line.salesAllocation = 'catalog_share';
    });
  } else {
    const weights = lines.map(line => {
      if (line.reportedNetSales > 0) return line.reportedNetSales;
      const quantity = Math.max(0, Number(line.quantity) || 0);
      const catalogValue = (Number(productMap.get(line.code)?.listPrice) || 0) * quantity;
      const reportedListValue = Math.max(0, Number(line.listGross) || 0);
      return reportedListValue || catalogValue || quantity || 1;
    });
    const totalWeight = sum(weights) || lines.length;
    lines.forEach((line, index) => {
      line.netSales = target * weights[index] / totalWeight;
      line.salesAllocation = 'scaled_to_order';
    });
  }

  const allocatedTotal = sum(lines.map(line => Number(line.netSales) || 0));
  let adjustmentLine = lines.at(-1);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].salesAllocation !== 'reported') { adjustmentLine = lines[index]; break; }
  }
  if (adjustmentLine) adjustmentLine.netSales += target - allocatedTotal;
  return { ...order, lines };
}

function buildProductAnalytics(snapshot, filters) {
  const period = { from: filters.from, to: filters.to };
  const previous = priorPeriod(period.from, period.to);
  const hierarchyId = String(filters.hierarchyId || 'all');
  const hierarchyLabel = hierarchyId === 'all'
    ? 'Todas las jerarquías'
    : snapshot.hierarchies.find(item => item.id === hierarchyId)?.pathLabel || 'Jerarquía seleccionada';
  const matchesHierarchy = line => hierarchyId === 'all' || (line.hierarchyIds || []).includes(hierarchyId);
  const inPeriod = (date, selected) => date >= selected.from && date <= selected.to;
  const productMap = new Map(snapshot.products.map(product => [product.code, product]));
  const reconciledOrders = snapshot.orders.map(order => reconcileOrderLineSales(order, productMap));
  const currentOrders = reconciledOrders.filter(order => inPeriod(order.date, period));
  const previousOrders = reconciledOrders.filter(order => inPeriod(order.date, previous));
  const scopedOrder = order => order.lines.some(line => !line.isExtra && matchesHierarchy(line));
  const currentScopedOrders = currentOrders.filter(scopedOrder);
  const previousScopedOrders = previousOrders.filter(scopedOrder);
  const currentLines = currentScopedOrders.flatMap(order => order.lines.filter(line => !line.isExtra && matchesHierarchy(line)).map(line => ({ ...line, order })));
  const previousLines = previousScopedOrders.flatMap(order => order.lines.filter(line => !line.isExtra && matchesHierarchy(line)).map(line => ({ ...line, order })));
  const openDates = [...new Set(currentScopedOrders.map(order => order.date))].sort();
  const allDates = dateRange(period.from, period.to);
  const priorDates = dateRange(previous.from, previous.to);

  const aggregateProducts = (lines, dates) => {
    const map = new Map();
    for (const item of lines) {
      const product = productMap.get(item.code) || { code: item.code, name: item.name, hierarchyPath: item.hierarchyPath || [], unitCost: 0, costSource: 'missing' };
      const value = map.get(item.code) || {
        code: item.code, name: product.name || item.name, hierarchyPath: product.hierarchyPath || item.hierarchyPath || [],
        units: 0, netSales: 0, cost: 0, orders: new Set(), dailyUnits: {}, dailySales: {},
        weekdayUnits: Array(7).fill(0), hourUnits: Array(24).fill(0), modes: {}, prices: [],
        listPrice: product.listPrice || 0, unitCost: product.unitCost || 0,
        costSource: product.costSource || 'missing', costSourceDate: product.costSourceDate || null
      };
      value.units += item.quantity;
      value.netSales += item.netSales;
      value.cost += item.quantity * (product.unitCost || 0);
      value.orders.add(item.order.orderKey);
      value.dailyUnits[item.order.date] = (value.dailyUnits[item.order.date] || 0) + item.quantity;
      value.dailySales[item.order.date] = (value.dailySales[item.order.date] || 0) + item.netSales;
      const weekday = new Date(`${item.order.date}T12:00:00Z`).getUTCDay();
      value.weekdayUnits[weekday] += item.quantity;
      value.hourUnits[Math.max(0, Math.min(23, Math.trunc(item.order.hour || 0)))] += item.quantity;
      const mode = item.order.mode || 'unknown';
      value.modes[mode] = (value.modes[mode] || 0) + item.quantity;
      if (item.quantity > 0 && item.netSales > 0) value.prices.push(item.netSales / item.quantity);
      map.set(item.code, value);
    }
    return new Map([...map].map(([code, value]) => {
      const daily = dates.map(date => value.dailyUnits[date] || 0);
      const regression = linearRegression(daily.map((units, index) => ({ x: index, y: units })));
      return [code, {
        ...value,
        orders: value.orders.size,
        averagePrice: value.units ? value.netSales / value.units : 0,
        margin: value.netSales ? (value.netSales - value.cost) / value.netSales * 100 : null,
        dailyStatistics: statistics(daily),
        trendPercent: mean(daily) ? regression.slope * Math.max(1, dates.length - 1) / mean(daily) * 100 : 0,
        trendStrength: regression.rSquared
      }];
    }));
  };

  const currentProducts = aggregateProducts(currentLines, allDates);
  const priorProducts = aggregateProducts(previousLines, priorDates);
  const totalNetSales = sum([...currentProducts.values()].map(product => product.netSales));
  const totalUnits = sum([...currentProducts.values()].map(product => product.units));
  const totalCost = sum([...currentProducts.values()].map(product => product.cost));
  const currentExtraLines = currentScopedOrders.flatMap(order => order.lines
    .filter(line => line.isExtra)
    .map(line => ({ ...line, order })));
  const orderNetSales = sum(currentScopedOrders.map(order => Number(order.netSales) || 0));
  const extraUnits = sum(currentExtraLines.map(line => Number(line.quantity) || 0));
  const extraNetSales = sum(currentExtraLines.map(line => Number(line.netSales) || 0));
  const roundedOrderNetSales = round(orderNetSales);
  const roundedProductNetSales = round(totalNetSales);
  const roundedExtraNetSales = round(extraNetSales);
  const roundedOtherNetSales = round(roundedOrderNetSales - roundedProductNetSales - roundedExtraNetSales);
  const productRows = [...currentProducts.values()].map(product => {
    const prior = priorProducts.get(product.code);
    const salesGrowth = prior?.netSales ? (product.netSales / prior.netSales - 1) * 100 : null;
    const unitGrowth = prior?.units ? (product.units / prior.units - 1) * 100 : null;
    return {
      code: product.code, name: product.name, hierarchyPath: product.hierarchyPath,
      hierarchy: product.hierarchyPath.join(' › ') || 'Sin jerarquía',
      units: round(product.units, 2), netSales: round(product.netSales), orderCount: product.orders,
      salesShare: totalNetSales ? round(product.netSales / totalNetSales * 100, 1) : 0,
      unitShare: totalUnits ? round(product.units / totalUnits * 100, 1) : 0,
      averagePrice: round(product.averagePrice), unitCost: round(product.unitCost), cost: round(product.cost),
      listPrice: round(product.listPrice),
      marginPercent: product.margin === null ? null : round(product.margin, 1), costSource: product.costSource,
      costSourceDate: product.costSourceDate, salesGrowthPercent: salesGrowth === null ? null : round(salesGrowth, 1),
      unitGrowthPercent: unitGrowth === null ? null : round(unitGrowth, 1), trendPercent: round(product.trendPercent, 1),
      trendStrength: round(product.trendStrength, 2), variabilityPercent: product.dailyStatistics.coefficientOfVariation,
      minDailyUnits: product.dailyStatistics.min, maxDailyUnits: product.dailyStatistics.max,
      weekdayUnits: product.weekdayUnits.map(value => round(value, 2)),
      hourUnits: product.hourUnits.map(value => round(value, 2)), modes: product.modes
    };
  }).sort((a, b) => b.netSales - a.netSales);
  let cumulativeShare = 0;
  productRows.forEach(product => {
    cumulativeShare += product.salesShare;
    product.abc = cumulativeShare <= 80 ? 'A' : cumulativeShare <= 95 ? 'B' : 'C';
    product.cumulativeShare = round(cumulativeShare, 1);
  });

  const dailyTotals = allDates.map(date => ({
    date,
    units: round(sum(currentLines.filter(item => item.order.date === date).map(item => item.quantity)), 2),
    netSales: round(sum(currentLines.filter(item => item.order.date === date).map(item => item.netSales)))
  }));
  const dailyUnitStats = statistics(dailyTotals.map(item => item.units));
  const anomalyThreshold = dailyUnitStats.mean + 2 * dailyUnitStats.standardDeviation;
  const lowThreshold = Math.max(0, dailyUnitStats.mean - 2 * dailyUnitStats.standardDeviation);
  const anomalies = dailyTotals.filter(item => item.units > anomalyThreshold || (item.units < lowThreshold && item.units > 0)).map(item => ({
    date: item.date, units: item.units, netSales: item.netSales,
    direction: item.units > dailyUnitStats.mean ? 'alta' : 'baja',
    deviationPercent: dailyUnitStats.mean ? round((item.units / dailyUnitStats.mean - 1) * 100, 1) : 0
  }));

  const modeKeys = ['takeaway', 'dineIn', 'unknown'];
  const serviceModeTotalNetSales = sum(currentScopedOrders.map(order => order.netSales));
  const serviceModes = modeKeys.map(key => {
    const orders = currentScopedOrders.filter(order => (order.mode || 'unknown') === key);
    const netSales = sum(orders.map(order => order.netSales));
    return {
      key, label: key === 'takeaway' ? 'Para llevar' : key === 'dineIn' ? 'Servir en el local' : 'Sin información',
      orders: orders.length, netSales: round(netSales), averageTicket: round(orders.length ? netSales / orders.length : 0),
      orderShare: currentScopedOrders.length ? round(orders.length / currentScopedOrders.length * 100, 1) : 0,
      salesShare: serviceModeTotalNetSales ? round(netSales / serviceModeTotalNetSales * 100, 1) : 0,
      coverage: round(snapshot.coverage.paymentMatchPercent || 0, 1)
    };
  });

  const weekday = Array.from({ length: 7 }, (_, index) => {
    const dates = openDates.filter(date => new Date(`${date}T12:00:00Z`).getUTCDay() === index);
    const units = sum(currentLines.filter(item => new Date(`${item.order.date}T12:00:00Z`).getUTCDay() === index).map(item => item.quantity));
    const sales = sum(currentLines.filter(item => new Date(`${item.order.date}T12:00:00Z`).getUTCDay() === index).map(item => item.netSales));
    return { weekday: index, label: WEEKDAY_NAMES[index], days: dates.length, averageUnits: round(dates.length ? units / dates.length : 0, 1), averageNetSales: round(dates.length ? sales / dates.length : 0) };
  });
  const hourly = Array.from({ length: 14 }, (_, offset) => {
    const hour = 7 + offset;
    const selected = currentLines.filter(item => Math.trunc(item.order.hour || 0) === hour);
    return { hour, label: `${String(hour).padStart(2, '0')}:00`, units: round(sum(selected.map(item => item.quantity)), 1), netSales: round(sum(selected.map(item => item.netSales))) };
  });

  const orderProductSets = currentScopedOrders.map(order => ({
    order,
    products: [...new Set(order.lines.filter(line => !line.isExtra && matchesHierarchy(line)).map(line => line.code))]
  })).filter(item => item.products.length);
  const productOrderCounts = new Map();
  const pairCounts = new Map();
  for (const item of orderProductSets) {
    item.products.forEach(code => productOrderCounts.set(code, (productOrderCounts.get(code) || 0) + 1));
    for (let left = 0; left < item.products.length; left += 1) {
      for (let right = left + 1; right < item.products.length; right += 1) {
        const codes = [item.products[left], item.products[right]].sort();
        const key = codes.join('|');
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const minimumPairOrders = Math.max(5, Math.ceil(orderProductSets.length * 0.005));
  const pairs = [...pairCounts].filter(([, count]) => count >= minimumPairOrders).map(([key, count]) => {
    const [leftCode, rightCode] = key.split('|');
    const leftCount = productOrderCounts.get(leftCode) || 0;
    const rightCount = productOrderCounts.get(rightCode) || 0;
    const support = orderProductSets.length ? count / orderProductSets.length : 0;
    return {
      leftCode, leftName: productMap.get(leftCode)?.name || leftCode,
      rightCode, rightName: productMap.get(rightCode)?.name || rightCode,
      orders: count, supportPercent: round(support * 100, 1),
      confidenceLeftToRightPercent: leftCount ? round(count / leftCount * 100, 1) : 0,
      confidenceRightToLeftPercent: rightCount ? round(count / rightCount * 100, 1) : 0,
      lift: leftCount && rightCount ? round(support / ((leftCount / orderProductSets.length) * (rightCount / orderProductSets.length)), 2) : null
    };
  }).sort((a, b) => (b.lift || 0) - (a.lift || 0) || b.orders - a.orders).slice(0, 50);

  const modifierCounts = new Map();
  currentScopedOrders.forEach(order => order.lines.filter(line => line.isExtra).forEach(line => {
    const value = modifierCounts.get(line.code) || { code: line.code, name: line.name, orders: new Set(), units: 0 };
    value.orders.add(order.orderKey); value.units += line.quantity; modifierCounts.set(line.code, value);
  }));
  const modifiers = [...modifierCounts.values()].map(item => ({ code: item.code, name: item.name, orders: item.orders.size, units: round(item.units, 1), orderShare: currentScopedOrders.length ? round(item.orders.size / currentScopedOrders.length * 100, 1) : 0 })).sort((a, b) => b.orders - a.orders).slice(0, 30);
  const basketDefinitions = [
    { term: 'Producto A / Producto B', detail: 'Dos productos base distintos que aparecen dentro de un mismo pedido. El orden A–B no implica que uno se haya agregado antes que el otro.' },
    { term: 'Pedidos', detail: 'Cantidad de pedidos que contienen ambos productos al menos una vez.' },
    { term: 'Soporte', detail: 'Porcentaje de todos los pedidos analizados que contienen el par. Mide su importancia o alcance dentro del total.' },
    { term: 'Confianza A→B', detail: 'Entre los pedidos que contienen A, porcentaje que también contiene B. Sirve para evaluar una recomendación de B cuando se elige A.' },
    { term: 'Confianza B→A', detail: 'Entre los pedidos que contienen B, porcentaje que también contiene A. Puede diferir de A→B porque los productos tienen distintas frecuencias de venta.' },
    { term: 'Lift', detail: 'Compara la coincidencia observada con la esperada si ambos productos fueran independientes. Mayor que 1 indica afinidad positiva; igual a 1, ausencia de asociación; menor que 1, coincidencia inferior a la esperada.' },
    { term: 'Código / Extra', detail: 'Identificador y nombre del extra o modificador registrado en la venta.' },
    { term: 'Pedidos (extras)', detail: 'Pedidos distintos en los que aparece el extra, sin duplicar un pedido aunque el extra se repita.' },
    { term: 'Unidades (extras)', detail: 'Cantidad total del extra vendido; puede superar los pedidos si una orden incluye más de una unidad.' },
    { term: 'Part. pedidos', detail: 'Porcentaje de pedidos analizados que incluyen el extra.' }
  ];
  const basketInterpretation = [];
  if (pairs.length) {
    const strongestLift = pairs.slice().sort((left, right) => (right.lift || 0) - (left.lift || 0))[0];
    const mostFrequent = pairs.slice().sort((left, right) => right.orders - left.orders || right.supportPercent - left.supportPercent)[0];
    const directional = pairs.flatMap(pair => [
      { source: pair.leftName, target: pair.rightName, confidence: pair.confidenceLeftToRightPercent, pair },
      { source: pair.rightName, target: pair.leftName, confidence: pair.confidenceRightToLeftPercent, pair }
    ]).sort((left, right) => right.confidence - left.confidence)[0];
    basketInterpretation.push({
      level: 'informativo',
      title: 'Par con mayor presencia en los pedidos',
      detail: `${mostFrequent.leftName} + ${mostFrequent.rightName}: ${mostFrequent.orders} pedidos, equivalentes a ${mostFrequent.supportPercent}% del total analizado.`
    });
    basketInterpretation.push({
      level: strongestLift.lift >= 2 ? 'atención' : 'informativo',
      title: 'Asociación relativa más intensa',
      detail: `${strongestLift.leftName} + ${strongestLift.rightName} alcanza lift ${strongestLift.lift}. Aparecen juntos ${strongestLift.lift} veces lo esperado bajo independencia, sobre una base de ${strongestLift.orders} pedidos.`
    });
    basketInterpretation.push({
      level: 'acción',
      title: 'Oportunidad direccional de recomendación',
      detail: `Cuando se compra ${directional.source}, ${directional.target} también aparece en ${directional.confidence}% de esos pedidos. Conviene probar la recomendación solo si el soporte y el margen justifican la intervención.`
    });
    const maximumSupport = Math.max(...pairs.map(pair => pair.supportPercent));
    if (maximumSupport < 2) basketInterpretation.push({
      level: 'revisión',
      title: 'Las afinidades tienen alcance reducido',
      detail: `Ningún par supera ${maximumSupport}% de soporte. Los lifts pueden ser altos porque el par es relativamente inusual; deben leerse junto con pedidos y soporte antes de diseñar un combo.`
    });
  } else basketInterpretation.push({
    level: 'informativo',
    title: 'No hay pares con muestra mínima suficiente',
    detail: `Ninguna combinación alcanzó el mínimo de ${minimumPairOrders} pedidos dentro del período y alcance seleccionados.`
  });
  if (modifiers.length) {
    const topModifier = modifiers[0];
    basketInterpretation.push({
      level: 'informativo',
      title: 'Extra o modificador más utilizado',
      detail: `${topModifier.name} aparece en ${topModifier.orders} pedidos (${topModifier.orderShare}% del total) y suma ${topModifier.units} unidades.`
    });
  }

  const familyMap = new Map();
  const productTransactions = new Map();
  currentLines.filter(item => item.quantity > 0).forEach(item => {
    const byOrder = productTransactions.get(item.code) || new Map();
    const transaction = byOrder.get(item.order.orderKey) || {
      orderKey: item.order.orderKey,
      orderReference: item.order.orderReference || null,
      date: item.order.date,
      hour: item.order.hour,
      locationName: item.order.locationName || filters.locationLabel || '',
      mode: item.order.mode || 'unknown',
      clients: item.order.clients || 0,
      paymentDue: item.order.paymentDue ?? null,
      paymentComment: item.order.paymentComment || '',
      quantity: 0,
      netSales: 0,
      orderNetSales: item.order.netSales || 0,
      orderLines: (item.order.lines || []).map(line => {
        const catalogProduct = productMap.get(line.code);
        const lineUnitNetPrice = line.quantity ? line.netSales / line.quantity : 0;
        const netListPrice = catalogProduct?.listPrice > 0 ? catalogProduct.listPrice / 1.19 : null;
        return {
          code: line.code,
          name: catalogProduct?.name || line.name,
          type: line.isExtra ? 'Extra' : 'Producto',
          hierarchy: (line.hierarchyPath || []).join(' › ') || line.hierarchyName || line.extraHierarchyName || '',
          quantity: round(line.quantity, 1),
          netSales: round(line.netSales),
          averageNetPrice: round(lineUnitNetPrice),
          averageGrossPrice: round(lineUnitNetPrice * 1.19),
          implicitDiscountPercent: netListPrice ? round((1 - lineUnitNetPrice / netListPrice) * 100, 1) : null,
          salesAllocation: line.salesAllocation || 'reported'
        };
      })
    };
    transaction.quantity += item.quantity;
    transaction.netSales += item.netSales;
    byOrder.set(item.order.orderKey, transaction);
    productTransactions.set(item.code, byOrder);
  });
  const finalizedProductTransaction = (transaction, listPrice) => {
    const averageNetPrice = transaction.quantity ? transaction.netSales / transaction.quantity : 0;
    const netListPrice = listPrice > 0 ? listPrice / 1.19 : null;
    return {
      ...transaction,
      quantity: round(transaction.quantity, 1),
      netSales: round(transaction.netSales),
      orderNetSales: round(transaction.orderNetSales),
      averageNetPrice: round(averageNetPrice),
      averageGrossPrice: round(averageNetPrice * 1.19),
      implicitDiscountPercent: netListPrice ? round((1 - averageNetPrice / netListPrice) * 100, 1) : null
    };
  };
  productRows.forEach(product => {
    const inferred = inferFamily(product);
    const value = familyMap.get(inferred.key) || { family: inferred.family, hierarchy: product.hierarchy, confidence: inferred.confidence, formats: [] };
    value.formats.push({
      code: product.code,
      name: product.name,
      format: inferred.format,
      listPrice: product.listPrice,
      units: product.units,
      netSales: product.netSales,
      averagePrice: product.averagePrice,
      share: product.salesShare,
      transactions: [...(productTransactions.get(product.code)?.values() || [])]
        .map(transaction => finalizedProductTransaction(transaction, product.listPrice))
        .sort((left, right) => right.date.localeCompare(left.date) || (right.hour || 0) - (left.hour || 0))
    });
    familyMap.set(inferred.key, value);
  });
  const families = [...familyMap.values()].filter(item => item.formats.length >= 2).map(item => {
    const totalUnits = sum(item.formats.map(format => format.units));
    const totalNetSales = sum(item.formats.map(format => format.netSales));
    return {
      ...item,
      totalUnits: round(totalUnits, 1),
      totalNetSales: round(totalNetSales),
      formats: item.formats.map(format => ({
        ...format,
        netListPrice: round(format.listPrice / 1.19),
        implicitDiscountPercent: format.listPrice > 0
          ? round((1 - format.averagePrice / (format.listPrice / 1.19)) * 100, 1)
          : null,
        familyUnitSharePercent: totalUnits ? round(format.units / totalUnits * 100, 1) : 0,
        familySalesSharePercent: totalNetSales ? round(format.netSales / totalNetSales * 100, 1) : 0
      })).sort((a, b) => b.netSales - a.netSales)
    };
  }).sort((a, b) => b.totalNetSales - a.totalNetSales).slice(0, 30);

  const priceSensitivity = [];
  for (const product of currentProducts.values()) {
    const pointsByDate = new Map();
    currentLines.filter(line => line.code === product.code && line.quantity > 0 && line.netSales > 0).forEach(line => {
      const value = pointsByDate.get(line.order.date) || { units: 0, sales: 0 };
      value.units += line.quantity; value.sales += line.netSales; pointsByDate.set(line.order.date, value);
    });
    const points = [...pointsByDate].map(([date, value]) => ({
      date,
      units: value.units,
      netSales: value.sales,
      price: value.sales / value.units
    })).sort((left, right) => left.date.localeCompare(right.date));
    const pricePoints = new Set(points.map(point => Math.round(point.price / 10) * 10));
    const priceRange = points.length ? (Math.max(...points.map(point => point.price)) / Math.max(1, Math.min(...points.map(point => point.price))) - 1) * 100 : 0;
    if (points.length < 12 || pricePoints.size < 3 || priceRange < 5) continue;
    const regression = linearRegression(points.map(point => ({ x: Math.log(point.price), y: Math.log(point.units + 0.5) })));
    const correlation = pearson(points.map(point => point.price), points.map(point => point.units));
    priceSensitivity.push({
      code: product.code, name: product.name, observations: points.length, pricePoints: pricePoints.size,
      priceRangePercent: round(priceRange, 1), observedElasticity: round(regression.slope, 2),
      correlation: correlation === null ? null : round(correlation, 2), rSquared: round(regression.rSquared, 2),
      confidence: points.length >= 25 && regression.rSquared >= 0.25 ? 'media' : 'baja',
      note: 'Asociación observada; no demuestra causalidad del precio.',
      observationDetails: points.map(point => {
        const netListPrice = product.listPrice > 0 ? product.listPrice / 1.19 : null;
        return {
          date: point.date,
          units: round(point.units, 1),
          netSales: round(point.netSales),
          averageNetPrice: round(point.price),
          averageGrossPrice: round(point.price * 1.19),
          implicitDiscountPercent: netListPrice
            ? round((1 - point.price / netListPrice) * 100, 1)
            : null,
          transactions: [...(productTransactions.get(product.code)?.values() || [])]
            .filter(transaction => transaction.date === point.date)
            .map(transaction => finalizedProductTransaction(transaction, product.listPrice))
            .sort((left, right) => (right.hour || 0) - (left.hour || 0))
        };
      })
    });
  }
  priceSensitivity.sort((a, b) => Math.abs(b.observedElasticity) * b.rSquared - Math.abs(a.observedElasticity) * a.rSquared);

  const pricedLines = currentLines.filter(item => item.quantity > 0 && item.netSales >= 0).map(item => ({
    quantity: item.quantity,
    netSales: item.netSales,
    grossSales: item.netSales * 1.19,
    grossUnitPrice: item.netSales * 1.19 / item.quantity
  }));
  const maximumGrossUnitPrice = pricedLines.length ? Math.max(...pricedLines.map(item => item.grossUnitPrice)) : 0;
  const maximumBand = Math.max(1500, Math.ceil(maximumGrossUnitPrice / 500) * 500);
  const priceBands = [];
  for (let upper = 1500; upper <= maximumBand; upper += 500) {
    const lowerExclusive = upper === 1500 ? -Infinity : upper - 500;
    const selected = pricedLines.filter(item => item.grossUnitPrice > lowerExclusive && item.grossUnitPrice <= upper);
    const units = sum(selected.map(item => item.quantity));
    const netSales = sum(selected.map(item => item.netSales));
    const grossSales = sum(selected.map(item => item.grossSales));
    priceBands.push({
      fromExclusive: upper === 1500 ? null : upper - 500,
      toInclusive: upper,
      label: upper === 1500 ? 'Hasta $1.500' : `$${(upper - 499).toLocaleString('es-CL')} – $${upper.toLocaleString('es-CL')}`,
      units: round(units, 1),
      unitSharePercent: totalUnits ? round(units / totalUnits * 100, 1) : 0,
      netSales: round(netSales),
      grossSales: round(grossSales),
      salesSharePercent: totalNetSales ? round(netSales / totalNetSales * 100, 1) : 0
    });
  }
  const nonEmptyPriceBands = priceBands.filter(item => item.units > 0 || item.netSales > 0);
  const strongestPriceBandByUnits = nonEmptyPriceBands.slice().sort((left, right) => right.units - left.units)[0] || null;
  const strongestPriceBandBySales = nonEmptyPriceBands.slice().sort((left, right) => right.netSales - left.netSales)[0] || null;
  const priceDistributionInsights = [];
  if (strongestPriceBandByUnits) priceDistributionInsights.push(
    `${strongestPriceBandByUnits.label} concentra la mayor cantidad: ${strongestPriceBandByUnits.units.toLocaleString('es-CL')} unidades (${strongestPriceBandByUnits.unitSharePercent.toLocaleString('es-CL')}%).`
  );
  if (strongestPriceBandBySales) priceDistributionInsights.push(
    `${strongestPriceBandBySales.label} aporta el mayor valor: ${strongestPriceBandBySales.netSales.toLocaleString('es-CL')} de venta neta (${strongestPriceBandBySales.salesSharePercent.toLocaleString('es-CL')}%).`
  );
  const lowerBandSales = sum(priceBands.filter(item => item.toInclusive <= 3000).map(item => item.netSales));
  const lowerBandUnits = sum(priceBands.filter(item => item.toInclusive <= 3000).map(item => item.units));
  if (totalUnits && totalNetSales) priceDistributionInsights.push(
    `Los productos vendidos a un precio efectivo de hasta $3.000 representan ${round(lowerBandUnits / totalUnits * 100, 1).toLocaleString('es-CL')}% de las unidades y ${round(lowerBandSales / totalNetSales * 100, 1).toLocaleString('es-CL')}% de la venta neta.`
  );

  const priceDefinitions = [
    { term: 'Observaciones', detail: 'Cantidad de días con venta y precio efectivo utilizable para ese producto.' },
    { term: 'Niveles de precio', detail: 'Cantidad de precios diarios distintos observados, agrupados al múltiplo de $10 más cercano para evitar diferencias de redondeo.' },
    { term: 'Rango', detail: 'Diferencia porcentual entre el menor y el mayor precio efectivo observado. Rangos muy altos suelen reflejar descuentos, promociones, cortesías o datos atípicos.' },
    { term: 'Coef. observado', detail: 'Asociación log-log: aproxima cuánto cambia porcentualmente la cantidad vendida cuando el precio cambia 1%. Un valor negativo indica que precio y unidades se movieron en sentidos opuestos; no prueba causalidad.' },
    { term: 'R²', detail: 'Proporción del comportamiento de unidades explicada por la relación lineal con el precio, entre 0 y 1. Cerca de 0 indica que el precio por sí solo explica muy poco.' },
    { term: 'Confianza', detail: 'Calificación basada en cantidad de observaciones, variedad de precios y R². Incluso una confianza media representa evidencia observacional, no experimental.' }
  ];
  const mediumConfidencePrices = priceSensitivity.filter(item => item.confidence === 'media');
  const meaningfulNegativePrices = priceSensitivity.filter(item => item.observedElasticity <= -0.5 && item.rSquared >= 0.2);
  const meaningfulPositivePrices = priceSensitivity.filter(item => item.observedElasticity >= 0.5 && item.rSquared >= 0.2);
  const medianPriceRSquared = median(priceSensitivity.map(item => item.rSquared));
  const extremePriceRanges = priceSensitivity.filter(item => item.priceRangePercent >= 100);
  const priceInterpretation = [];
  priceInterpretation.push({
    level: mediumConfidencePrices.length ? 'atención' : 'informativo',
    title: mediumConfidencePrices.length ? `${mediumConfidencePrices.length} producto(s) presentan una señal de confianza media` : 'No hay señales suficientemente firmes para atribuir la demanda al precio',
    detail: mediumConfidencePrices.length
      ? 'Estas señales merecen revisión individual, controlando promociones, disponibilidad, día de semana, canal y cambios de mix.'
      : `El R² mediano es ${round(medianPriceRSquared, 2)} y todas las señales quedan en confianza baja; los datos actuales muestran asociación débil, no una base para modificar precios por sí sola.`
  });
  if (meaningfulNegativePrices.length) priceInterpretation.push({
    level: 'atención',
    title: 'Productos con relación negativa que merece revisión',
    detail: meaningfulNegativePrices.slice(0, 5).map(item => `${item.name} (${item.observedElasticity}; R² ${item.rSquared})`).join(' · ')
  });
  if (meaningfulPositivePrices.length) priceInterpretation.push({
    level: 'informativo',
    title: 'Una asociación positiva suele indicar factores simultáneos',
    detail: `${meaningfulPositivePrices.slice(0, 5).map(item => item.name).join(', ')} muestran precio y unidades moviéndose juntos; promociones, estacionalidad, mix o disponibilidad pueden estar detrás de ambos movimientos.`
  });
  if (extremePriceRanges.length) priceInterpretation.push({
    level: 'revisión',
    title: `${extremePriceRanges.length} producto(s) tienen un rango de precio superior a 100%`,
    detail: 'Conviene revisar descuentos extremos, cortesías, cantidades, devoluciones o precios unitarios atípicos antes de interpretar su coeficiente.'
  });

  const ingredientExposure = new Map();
  for (const product of productRows) {
    const recipe = snapshot.recipes[product.code] || [];
    const candidates = recipe.filter(line => !/\b(?:vaso|tapa|servilleta|packaging)\b/.test(normalizeText(line.ingredientName)));
    const ranked = candidates.map(line => ({ ...line, contribution: (line.effectiveQuantity || 0) * (line.unitCost || 0) })).sort((a, b) => b.contribution - a.contribution || b.effectiveQuantity - a.effectiveQuantity);
    const main = ranked[0];
    if (!main) continue;
    const value = ingredientExposure.get(main.ingredientId) || { code: main.ingredientId, name: main.ingredientName, netSales: 0, units: 0, products: [] };
    value.netSales += product.netSales; value.units += product.units;
    value.products.push({
      code: product.code,
      name: product.name,
      units: product.units,
      netSales: product.netSales,
      averagePrice: product.averagePrice,
      orderCount: product.orderCount
    });
    ingredientExposure.set(main.ingredientId, value);
  }
  const ingredients = [...ingredientExposure.values()].map(item => ({
    ...item,
    productCount: item.products.length,
    netSales: round(item.netSales),
    units: round(item.units, 1),
    salesShare: totalNetSales ? round(item.netSales / totalNetSales * 100, 1) : 0,
    products: item.products.map(product => ({
      ...product,
      units: round(product.units, 1),
      netSales: round(product.netSales),
      averagePrice: round(product.averagePrice),
      ingredientUnitSharePercent: item.units ? round(product.units / item.units * 100, 1) : 0,
      ingredientSalesSharePercent: item.netSales ? round(product.netSales / item.netSales * 100, 1) : 0
    })).sort((a, b) => b.netSales - a.netSales)
  })).sort((a, b) => b.netSales - a.netSales).slice(0, 30);

  const findings = [];
  const addFinding = finding => findings.push({ id: `PA-${String(findings.length + 1).padStart(3, '0')}`, ...finding });
  const top = productRows[0];
  if (top) addFinding({ impact: top.salesShare >= 15 ? 'alto' : 'medio', confidence: 'alta', section: 'portafolio', title: `La venta se concentra en ${top.name}`, detail: `${top.salesShare}% de la venta neta del alcance corresponde a este producto.`, evidence: [`${top.netSales} venta neta`, `${top.orderCount} pedidos`], action: 'Revisar disponibilidad, receta, margen y capacidad operativa para proteger esta fuente de venta.' });
  const growing = productRows.filter(item => item.salesGrowthPercent !== null && item.salesGrowthPercent >= 25 && item.netSales >= totalNetSales * 0.01).sort((a, b) => b.salesGrowthPercent - a.salesGrowthPercent)[0];
  if (growing) addFinding({ impact: impactForShare(growing.salesShare, growing.salesGrowthPercent), confidence: growing.orderCount >= 20 ? 'alta' : 'media', section: 'tendencia', title: `${growing.name} crece frente al período equivalente`, detail: `La venta neta aumenta ${growing.salesGrowthPercent}% y representa ${growing.salesShare}% del total.`, evidence: [`${growing.units} unidades`, `${growing.orderCount} pedidos`], action: 'Confirmar si el crecimiento responde a promoción, disponibilidad, estacionalidad o cambio de preferencia.' });
  const falling = productRows.filter(item => item.salesGrowthPercent !== null && item.salesGrowthPercent <= -25 && (priorProducts.get(item.code)?.netSales || 0) >= totalNetSales * 0.01).sort((a, b) => a.salesGrowthPercent - b.salesGrowthPercent)[0];
  if (falling) addFinding({ impact: impactForShare(falling.salesShare, falling.salesGrowthPercent), confidence: falling.orderCount >= 15 ? 'alta' : 'media', section: 'tendencia', title: `${falling.name} cae frente al período equivalente`, detail: `La venta neta cambia ${falling.salesGrowthPercent}% respecto del período anterior comparable.`, evidence: [`${falling.units} unidades actuales`, `tendencia interna ${falling.trendPercent}%`], action: 'Revisar quiebres de stock, visibilidad en carta, sustitución por productos similares y cambios de precio.' });
  if (anomalies.length) addFinding({ impact: anomalies.length >= 3 ? 'medio' : 'bajo', confidence: openDates.length >= 14 ? 'media' : 'baja', section: 'anomalías', title: `${anomalies.length} día(s) se apartan del comportamiento diario`, detail: 'Se detectaron días fuera de dos desviaciones estándar del promedio de unidades.', evidence: anomalies.slice(0, 4).map(item => `${item.date}: ${item.units} unidades (${item.deviationPercent}%)`), action: 'Contrastar con feriados, promociones, clima, cierres parciales, stock y dotación.' });
  if (pairs[0]?.lift >= 1.5) addFinding({ impact: pairs[0].supportPercent >= 5 ? 'medio' : 'bajo', confidence: pairs[0].orders >= 20 ? 'alta' : 'media', section: 'canasta', title: `${pairs[0].leftName} y ${pairs[0].rightName} aparecen juntos más de lo esperado`, detail: `Lift ${pairs[0].lift} en ${pairs[0].orders} pedidos (${pairs[0].supportPercent}% de soporte).`, evidence: [`Confianza ${pairs[0].confidenceLeftToRightPercent}% / ${pairs[0].confidenceRightToLeftPercent}%`], action: 'Evaluar combo, recomendación cruzada, disposición en menú y capacidad conjunta.' });
  if (priceSensitivity[0]) addFinding({ impact: 'informativo', confidence: priceSensitivity[0].confidence, section: 'precio', title: `Señal de sensibilidad observada en ${priceSensitivity[0].name}`, detail: `Coeficiente log-log ${priceSensitivity[0].observedElasticity}, R² ${priceSensitivity[0].rSquared}, con ${priceSensitivity[0].observations} observaciones. No prueba causalidad.`, evidence: [`Rango de precio ${priceSensitivity[0].priceRangePercent}%`, `${priceSensitivity[0].pricePoints} niveles observados`], action: 'Antes de decidir precios, controlar promociones, mix de canal, día de semana, disponibilidad y cambios simultáneos.' });
  const lowMargin = productRows.filter(item => item.marginPercent !== null && item.marginPercent < 25 && item.netSales >= totalNetSales * 0.005).sort((a, b) => a.marginPercent - b.marginPercent)[0];
  if (lowMargin) addFinding({ impact: lowMargin.salesShare >= 3 ? 'alto' : 'medio', confidence: lowMargin.costSource === 'purchase' ? 'alta' : 'media', section: 'margen', title: `Margen reducido en ${lowMargin.name}`, detail: `Margen estimado ${lowMargin.marginPercent}% usando costo ${lowMargin.costSource === 'purchase' ? 'de compra vigente' : 'maestro'}.`, evidence: [`Venta neta ${lowMargin.netSales}`, `Costo unitario ${lowMargin.unitCost}`], action: 'Confirmar receta, rendimiento, último costo y precio neto antes de intervenir.' });
  findings.sort((a, b) => ['alto', 'medio', 'bajo', 'informativo'].indexOf(a.impact) - ['alto', 'medio', 'bajo', 'informativo'].indexOf(b.impact));

  const recipeCoverage = productRows.length ? productRows.filter(product => (snapshot.recipes[product.code] || []).length).length / productRows.length * 100 : 0;
  const purchaseCostCoverage = productRows.length ? productRows.filter(product => product.costSource === 'purchase').length / productRows.length * 100 : 0;
  const reportCoverage = {
    orders: currentScopedOrders.length, orderLines: currentLines.length, products: productRows.length, openDays: openDates.length,
    paymentMatchPercent: round(snapshot.coverage.paymentMatchPercent || 0, 1), recipeCoveragePercent: round(recipeCoverage, 1),
    purchaseCostCoveragePercent: round(purchaseCostCoverage, 1), unknownModePercent: currentScopedOrders.length ? round(currentScopedOrders.filter(order => order.mode === 'unknown').length / currentScopedOrders.length * 100, 1) : 0,
    priceAnalysisEligibleProducts: priceSensitivity.length
  };

  return {
    generatedAt: new Date().toISOString(),
    scope: { location: filters.location || 'all', locationLabel: filters.locationLabel || 'Todas las cafeterías', hierarchyId, hierarchyLabel },
    period: { ...period, previousFrom: previous.from, previousTo: previous.to, days: previous.days },
    coverage: reportCoverage,
    summary: {
      netSales: roundedOrderNetSales,
      productNetSales: roundedProductNetSales,
      extraNetSales: roundedExtraNetSales,
      otherNetSales: roundedOtherNetSales,
      units: round(totalUnits, 1),
      productUnits: round(totalUnits, 1),
      extraUnits: round(extraUnits, 1),
      orders: currentScopedOrders.length,
      averageTicket: round(currentScopedOrders.length ? orderNetSales / currentScopedOrders.length : 0),
      cost: round(totalCost), grossMarginPercent: totalNetSales ? round((totalNetSales - totalCost) / totalNetSales * 100, 1) : null,
      productCount: productRows.length, anomalyCount: anomalies.length, findingCount: findings.length,
      highImpactCount: findings.filter(item => item.impact === 'alto').length
    },
    reconciliation: {
      productNetSales: roundedProductNetSales,
      extraNetSales: roundedExtraNetSales,
      otherNetSales: roundedOtherNetSales,
      totalNetSales: roundedOrderNetSales,
      productUnits: round(totalUnits, 1),
      extraUnits: round(extraUnits, 1),
      reconciles: round(roundedProductNetSales + roundedExtraNetSales + roundedOtherNetSales) === roundedOrderNetSales
    },
    executiveSummary: findings.slice(0, 4).map(item => item.detail),
    findings,
    portfolio: { products: productRows, topProducts: productRows.slice(0, 20), abc: ['A', 'B', 'C'].map(key => ({ key, products: productRows.filter(item => item.abc === key).length, netSales: round(sum(productRows.filter(item => item.abc === key).map(item => item.netSales))) })) },
    trends: { daily: dailyTotals, anomalies, previousPeriod: previous },
    temporal: { weekdays: weekday, hours: hourly },
    serviceModes,
    baskets: {
      ordersAnalyzed: orderProductSets.length,
      minimumPairOrders,
      pairs,
      modifiers,
      definitions: basketDefinitions,
      interpretation: basketInterpretation
    },
    formats: { families, methodology: 'Familias inferidas por jerarquía, nombre y marcadores de formato; revisar las de confianza baja.' },
    priceDistribution: {
      basis: 'Precio unitario efectivo con IVA; el valor vendido se muestra neto, sin IVA, para mantener consistencia con el resto del reporte.',
      bands: priceBands,
      insights: priceDistributionInsights
    },
    priceSensitivity: {
      items: priceSensitivity.slice(0, 30),
      caveat: 'Las asociaciones observadas no estiman causalidad ni una elasticidad experimental. Se omiten productos sin variación o muestra suficiente.',
      definitions: priceDefinitions,
      interpretation: priceInterpretation
    },
    ingredients,
    appendix: {
      products: productRows,
      methodology: [
        'La venta neta del resumen usa el total completo de los pedidos y se concilia entre productos base, extras y, cuando se filtra una jerarquía, otras líneas fuera del alcance.',
        'Las unidades y los análisis de portafolio, formatos, precios, tendencias e ingredientes consideran solo productos base; los extras se informan por separado como modificadores.',
        'La comparación utiliza el período inmediatamente anterior de igual duración.',
        'Los costos usan la compra más reciente registrada hasta la fecha final y recurren al maestro solo si no existe compra compatible.',
        'Soporte es la proporción de pedidos con el par; confianza es la probabilidad condicional; lift compara lo observado con independencia.',
        'Las anomalías diarias usan dos desviaciones estándar y deben investigarse, no interpretarse automáticamente como errores.',
        'MercadoPago no se usa para atribuir preferencias de producto a clientes porque no existe una llave determinística suficiente.'
      ],
      warnings: snapshot.warnings || []
    }
  };
}

module.exports = { buildProductAnalytics, statistics, linearRegression, inferFamily, priorPeriod, reconcileOrderLineSales };
