const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const { orderMatches } = require('./demand-analysis');

const VERSION = 'sales-clusters-v1.3.0';
const PARAMETER_DEFINITIONS = [
  ['minimumOrders', 'Pedidos mínimos para calcular', 100, 2, null, 1],
  ['dimensionCoverage', 'Cobertura mínima de una dimensión (%)', 50, 0, 100, 1],
  ['observedWeight', 'Peso observado mínimo por pedido (%)', 70, 0, 100, 1],
  ['sharedWeight', 'Peso compartido mínimo con el representante (%)', 50, 0, 100, 1],
  ['minimumClusterOrders', 'Pedidos mínimos por cluster sólido', 30, 1, null, 1],
  ['minimumClusterShare', 'Participación mínima del cluster (%)', 1, 0, 100, 0.1],
  ['minimumDates', 'Fechas distintas mínimas por cluster sólido', 7, 1, null, 1],
  ['globalSilhouette', 'Silhouette global mínimo', 0.2, -1, 1, 0.01],
  ['clusterSilhouette', 'Silhouette medio mínimo por cluster', 0, -1, 1, 0.01],
  ['minimumStability', 'Estabilidad Jaccard mínima', 0.75, 0, 1, 0.01],
  ['minimumDistinctiveDimensions', 'Dimensiones con diferencias materiales', 2, 1, 10, 1],
  ['prevalenceDifference', 'Diferencia mínima de prevalencia (puntos)', 15, 0, 100, 1],
  ['minimumLift', 'Lift mínimo', 1.5, 0, null, 0.1],
  ['numericDifference', 'Diferencia numérica mínima (rangos intercuartílicos)', 0.5, 0, null, 0.1],
  ['nullPercentile', 'Percentil de referencia aleatoria', 95, 0, 100, 1]
].map(([key, label, defaultValue, min, max, step]) => ({ key, label, defaultValue, min, max, step,
  integer: ['minimumOrders', 'minimumClusterOrders', 'minimumDates', 'minimumDistinctiveDimensions'].includes(key) }));
const DEFAULT_PARAMETERS = Object.fromEntries(PARAMETER_DEFINITIONS.map(p => [p.key, p.defaultValue]));
const DIMENSIONS = [
  { key: 'products', label: 'Productos', levels: [['hierarchy', 'Jerarquía principal'], ['category', 'Categoría final'], ['product', 'Producto específico']], defaultLevel: 'hierarchy' },
  { key: 'hour', label: 'Horario', levels: [['band', 'Franja'], ['hour', 'Hora circular']], defaultLevel: 'band' },
  { key: 'calendar', label: 'Calendario', levels: [['weekday', 'Día de semana'], ['month', 'Mes'], ['weekend', 'Laborable / fin de semana']], defaultLevel: 'weekday' },
  { key: 'spend', label: 'Gasto', levels: [['bands', 'Tramos'], ['continuous', 'Importe continuo']], defaultLevel: 'bands' },
  { key: 'price', label: 'Precio relativo', levels: [['relative', 'Respecto del precio habitual del producto']], defaultLevel: 'relative' },
  { key: 'discount', label: 'Descuentos', levels: [['presence', 'Con / sin descuento'], ['percent', 'Porcentaje']], defaultLevel: 'presence' },
  { key: 'mode', label: 'Modalidad', levels: [['mode', 'En local / para llevar']], defaultLevel: 'mode' },
  { key: 'location', label: 'Cafetería', levels: [['location', 'Establecimiento']], defaultLevel: 'location' },
  { key: 'recurrence', label: 'Recurrencia observada', levels: [['transaction', 'Compra anterior observada'], ['observed', 'Compra en una fecha anterior']], defaultLevel: 'transaction', defaultEnabled: false },
  { key: 'gender', label: 'Género estimado por nombre', levels: [['name', 'Estimación por nombre registrado'], ['validated', 'Solo género declarado o validado']], defaultLevel: 'name', defaultEnabled: false }
];
const DEFAULT_DIMENSIONS = Object.fromEntries(DIMENSIONS.map(d => [d.key, { enabled: d.defaultEnabled !== false, level: d.defaultLevel }]));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sumMoney = a => Number(a.reduce((s, v) => s.plus(v || 0), new Decimal(0)).toDecimalPlaces(2));
const percent = (n, d) => d ? n / d * 100 : 0;
const quantile = (a, p) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), index = (s.length - 1) * p;
  return s[Math.floor(index)] + (s[Math.ceil(index)] - s[Math.floor(index)]) * (index % 1);
};
const median = a => quantile(a, 0.5);
const validNumber = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
function invalid(message) { const e = new Error(message); e.status = 400; throw e; }

function normalizeConfig(input = {}) {
  const supplied = input.parameters || {};
  if (Object.keys(supplied).some(k => !(k in DEFAULT_PARAMETERS))) invalid('Hay parámetros de calidad desconocidos.');
  const parameters = {};
  for (const definition of PARAMETER_DEFINITIONS) {
    const value = supplied[definition.key] === undefined ? definition.defaultValue : supplied[definition.key];
    if (!validNumber(value) || !['number', 'string'].includes(typeof value) || Number(value) < definition.min
      || (definition.max !== null && Number(value) > definition.max) || (definition.integer && !Number.isInteger(Number(value)))) {
      invalid(`Valor inválido: ${definition.label}.`);
    }
    parameters[definition.key] = Number(value);
  }
  const dimensions = {};
  if (Object.keys(input.dimensions || {}).some(key => !DIMENSIONS.some(d => d.key === key))) invalid('Hay dimensiones desconocidas.');
  for (const definition of DIMENSIONS) {
    const value = input.dimensions?.[definition.key] || DEFAULT_DIMENSIONS[definition.key];
    if (typeof value.enabled !== 'boolean' || !definition.levels.some(([level]) => level === value.level)) invalid(`Configuración inválida: ${definition.label}.`);
    const threshold = value.minimumCoverage;
    if (threshold !== undefined && threshold !== null && threshold !== '' &&
      (!validNumber(threshold) || !['number', 'string'].includes(typeof threshold) || Number(threshold) < 0 || Number(threshold) > 100)) {
      invalid(`Cobertura mínima inválida: ${definition.label}. Debe estar entre 0 y 100 %.`);
    }
    dimensions[definition.key] = { enabled: value.enabled, level: value.level,
      minimumCoverage: threshold === undefined || threshold === null || threshold === '' ? null : Number(threshold) };
  }
  if (!Object.values(dimensions).some(d => d.enabled)) invalid('Activa al menos una dimensión para agrupar los pedidos.');
  const filters = { ...(input.filters || {}) };
  for (const key of ['minSpend', 'maxSpend', 'hourFrom', 'hourTo', 'minDiscount', 'maxDiscount']) {
    if (filters[key] === undefined || filters[key] === '') { delete filters[key]; continue; }
    if (!validNumber(filters[key]) || Number(filters[key]) < 0) invalid(`Filtro inválido: ${key}.`);
    filters[key] = Number(filters[key]);
  }
  for (const key of ['hourFrom', 'hourTo']) if (filters[key] > 24) invalid('El horario debe estar entre 0 y 24.');
  for (const key of ['minDiscount', 'maxDiscount']) if (filters[key] > 100) invalid('El descuento debe estar entre 0 y 100 %.');
  for (const [a, b] of [['minSpend', 'maxSpend'], ['minDiscount', 'maxDiscount']]) {
    if (filters[a] !== undefined && filters[b] !== undefined && filters[a] > filters[b]) invalid('El mínimo del filtro no puede superar el máximo.');
  }
  return { filters, dimensions, parameters, customParameters: PARAMETER_DEFINITIONS.some(p => parameters[p.key] !== p.defaultValue)
    || Object.values(dimensions).some(d => d.minimumCoverage !== null) };
}

// Only dates strictly before a purchase count as an earlier observation. No future leakage.
function recurrenceAsOf(orders, history = [], { sameDay = false } = {}) {
  const firstDates = new Map();
  for (const row of [...history, ...orders]) {
    if (!row.instrumentKey || !row.date) continue;
    const observedAt = sameDay ? row.linkedPaymentDateTime || row.dateTime : row.date;
    if (!observedAt) continue;
    const date = firstDates.get(row.instrumentKey);
    if (!date || observedAt < date) firstDates.set(row.instrumentKey, observedAt);
  }
  return orders.map(order => ({ ...order, recurrenceGroup: order.instrumentKey && order.paymentLinkStatus === 'estimated-high'
    && (!sameDay || order.linkedPaymentDateTime || order.dateTime)
    ? firstDates.get(order.instrumentKey) < (sameDay ? order.linkedPaymentDateTime || order.dateTime : order.date)
      ? 'returning-instrument' : 'single-observed-date' : 'unlinked' }));
}

function hourOf(order) {
  const match = /^(\d{2}):(\d{2})/.exec(order.time || '');
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) + Number(match[2]) / 60 : null;
}
const ticket = order => validNumber(order.ticketGross) ? Number(order.ticketGross) : Number(order.netSales) * 1.19;
function discountOf(order) {
  if (!validNumber(order.orderDiscount)) return null;
  const amount = Math.abs(Number(order.orderDiscount)), paid = ticket(order);
  return paid + amount > 0 ? amount / (paid + amount) * 100 : null;
}
function cohortMatches(order, filters) {
  if (!orderMatches(order, filters)) return false;
  const h = hourOf(order), spend = ticket(order), discount = discountOf(order);
  if (filters.minSpend !== undefined && spend < filters.minSpend) return false;
  if (filters.maxSpend !== undefined && spend > filters.maxSpend) return false;
  if (filters.minDiscount !== undefined && (discount === null || discount < filters.minDiscount)) return false;
  if (filters.maxDiscount !== undefined && (discount === null || discount > filters.maxDiscount)) return false;
  if (filters.hourFrom !== undefined || filters.hourTo !== undefined) {
    if (h === null) return false;
    const from = filters.hourFrom ?? 0, to = filters.hourTo ?? 24;
    if (from <= to ? h < from || h >= to : h < from && h >= to) return false;
  }
  return true;
}

function prepareCohort(input, config) {
  const exclusions = { duplicates: 0, reversals: 0, nonPositive: 0, insufficient: 0 };
  const period = input.period;
  const seen = new Set(), orders = [];
  for (const original of input.recurrenceResolved ? input.orders : recurrenceAsOf(input.orders, input.history)) {
    const order = { ...original, recurrenceDateGroup: original.recurrenceDateGroup ?? original.recurrenceGroup,
      recurrenceGroup: config.dimensions.recurrence.level === 'transaction'
        ? original.recurrenceTransactionGroup ?? original.recurrenceGroup : original.recurrenceDateGroup ?? original.recurrenceGroup };
    if (order.date < period.from || order.date > period.to || !cohortMatches(order, config.filters)) continue;
    if (seen.has(order.orderKey)) { exclusions.duplicates++; continue; }
    seen.add(order.orderKey);
    if (order.reversalSignals?.length || order.lines?.some(l => Number(l.quantity) < 0 || Number(l.netSales) < 0)) { exclusions.reversals++; continue; }
    if (!validNumber(order.netSales) || !order.orderKey || !/^\d{4}-\d{2}-\d{2}$/.test(order.date || '') || !order.lines?.length) { exclusions.insufficient++; continue; }
    if (Number(order.netSales) <= 0) { exclusions.nonPositive++; continue; }
    orders.push(order);
  }
  orders.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.orderKey.localeCompare(b.orderKey));
  return { orders, exclusions };
}

function basketKey(line, level) {
  if (level === 'product') return line.code ? `product:${line.code}` : null;
  if (level === 'category') return line.categoryId || line.hierarchyId ? `category:${line.categoryId || line.hierarchyId}` : null;
  // The root identifier is taken from the master, never inferred from the product name.
  const id = line.rootHierarchyId || String(line.categoryId || line.hierarchyId || '').split('.').filter(Boolean)[0];
  return id ? `hierarchy:${id}` : null;
}
function basket(order, level) {
  const values = {};
  for (const line of order.lines) {
    if (line.isExtra || !(Number(line.quantity) > 0)) continue;
    const key = basketKey(line, level);
    if (key) values[key] = (values[key] || 0) + Number(line.quantity);
  }
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  return total ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v / total])) : null;
}
const priceKey = line => `${line.code}|${line.unit || 'selling-unit'}`;
function fitTransform(orders, config) {
  const prices = {}, frequencies = {};
  for (const order of orders) {
    for (const line of order.lines) {
      if (line.isExtra || !line.code || !(Number(line.quantity) > 0) || !validNumber(line.netSales)) continue;
      (prices[priceKey(line)] ||= []).push(Number(line.netSales) * 1.19 / Number(line.quantity));
    }
    for (const key of Object.keys(basket(order, config.dimensions.products.level) || {})) frequencies[key] = (frequencies[key] || 0) + 1;
  }
  return { priceReferences: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, median(v)])),
    frequentProducts: Object.keys(frequencies).filter(k => frequencies[k] >= Math.max(5, Math.ceil(orders.length * 0.005))),
    spendCuts: [quantile(orders.map(ticket), 1 / 3), quantile(orders.map(ticket), 2 / 3)],
    scales: {}, morningEnd: Number(config.filters.morningEnd) || 12,
    middayEnd: Number(config.filters.middayEnd) || 16, afternoonEnd: Number(config.filters.afternoonEnd) || 20 };
}
function rawFeature(order, key, level, transform) {
  const hour = hourOf(order);
  if (key === 'products') {
    const value = basket(order, level);
    if (!value) return null;
    const frequent = new Set(transform.frequentProducts), result = {};
    for (const [k, v] of Object.entries(value)) { const token = frequent.has(k) ? k : 'other'; result[token] = (result[token] || 0) + v; }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (key === 'hour') return hour === null ? null : level === 'hour' ? hour :
    hour < 6 ? 'Madrugada' : hour < transform.morningEnd ? 'Mañana' : hour < transform.middayEnd ? 'Mediodía' : hour < transform.afternoonEnd ? 'Tarde' : 'Noche';
  if (key === 'calendar') {
    const day = new Date(`${order.date}T12:00:00Z`).getUTCDay();
    return level === 'month' ? order.date.slice(0, 7) : level === 'weekend' ? [0, 6].includes(day) ? 'Fin de semana' : 'Laborable' : ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][day];
  }
  if (key === 'spend') return level === 'continuous' ? ticket(order) : ticket(order) <= transform.spendCuts[0] ? 'Gasto bajo' : ticket(order) <= transform.spendCuts[1] ? 'Gasto medio' : 'Gasto alto';
  if (key === 'price') {
    const values = order.lines.filter(l => !l.isExtra && Number(l.quantity) > 0 && Number(l.netSales) > 0 && transform.priceReferences[priceKey(l)] > 0)
      .map(l => ({ value: Number(l.netSales) * 1.19 / Number(l.quantity) / transform.priceReferences[priceKey(l)], weight: Number(l.netSales) }));
    const total = values.reduce((s, v) => s + v.weight, 0);
    return total ? values.reduce((s, v) => s + v.value * v.weight, 0) / total : null;
  }
  if (key === 'discount') { const discount = discountOf(order); return discount === null ? null : level === 'presence' ? discount > 0 ? 'Con descuento' : 'Sin descuento' : discount; }
  if (key === 'mode') return ['dineIn', 'takeaway'].includes(order.mode) ? order.mode : null;
  if (key === 'location') return order.locationId || null;
  if (key === 'recurrence') {
    const value = level === 'transaction' ? order.recurrenceTransactionGroup ?? order.recurrenceGroup : order.recurrenceDateGroup ?? order.recurrenceGroup;
    return ['returning-instrument', 'single-observed-date'].includes(value) ? value : null;
  }
  if (key === 'gender') {
    if (level === 'name') return ['feminine-associated', 'masculine-associated'].includes(order.nameGenderSegment) ? order.nameGenderSegment : null;
    return order.validatedGender && (order.genderBasis === 'explicit' || order.genderBasis === 'calibrated' && order.genderConfidence >= 0.9) ? order.validatedGender : null;
  }
  return null;
}
function featureType(key, level) {
  return key === 'products' ? 'basket' : key === 'hour' && level === 'hour' ? 'circular' :
    key === 'price' || key === 'spend' && level === 'continuous' || key === 'discount' && level === 'percent' ? 'numeric' : 'categorical';
}
function buildFeatures(orders, config, suppliedTransform, suppliedActive) {
  const transform = suppliedTransform || fitTransform(orders, config), raw = orders.map(order => ({})), coverage = [];
  for (const definition of DIMENSIONS) {
    const level = config.dimensions[definition.key].level, type = featureType(definition.key, level);
    const values = orders.map((order, i) => raw[i][definition.key] = rawFeature(order, definition.key, level, transform));
    const known = values.filter(v => v !== null), variability = new Set(known.map(v => JSON.stringify(v))).size;
    const share = percent(known.length, orders.length);
    const minimumCoverage = config.dimensions[definition.key].minimumCoverage ?? config.parameters.dimensionCoverage;
    const available = share >= minimumCoverage && known.length > 0 && variability > 1;
    const reason = !known.length ? definition.key === 'gender' ? level === 'name' ? 'Sin nombres clasificables en el diccionario.' : 'Sin género explícito o inferencia calibrada; la asociación por nombre no lo acredita.' : 'Sin valores conocidos.' :
      share < minimumCoverage ? `Cobertura ${share.toFixed(1)} % inferior al umbral ${minimumCoverage} %.` : variability < 2 ? 'Sin variación suficiente.' : '';
    coverage.push({ key: definition.key, label: definition.label, level, type, known: known.length, coverage: share, variability, available,
      requested: config.dimensions[definition.key].enabled, minimumCoverage, reason,
      ...(definition.key === 'gender' && level === 'name' ? { basis: 'Asociación lingüística por nombre; no confirma el género de la persona.' } : {}) });
    if (definition.key === 'gender') {
      const named = orders.filter(order => ['feminine-associated', 'masculine-associated'].includes(order.nameGenderSegment)).length;
      coverage.at(-1).nameCoverage = percent(named, orders.length);
      coverage.at(-1).nameKnown = named;
    }
    if (type === 'numeric' && !suppliedTransform) {
      const numbers = known.map(v => Math.log1p(v));
      transform.scales[definition.key] = { from: quantile(numbers, 0.05) || 0, to: quantile(numbers, 0.95) || 0 };
    }
  }
  const active = suppliedActive || coverage.filter(d => d.requested && d.available);
  const rows = raw.map((values, i) => {
    const features = {};
    for (const d of active) {
      let v = values[d.key];
      if (v !== null && d.type === 'numeric') {
        const scale = transform.scales[d.key];
        v = scale && scale.to > scale.from ? Math.max(0, Math.min(1, (Math.log1p(v) - scale.from) / (scale.to - scale.from))) : 0;
      }
      features[d.key] = v;
    }
    return { index: i, features, observed: percent(Object.values(features).filter(v => v !== null).length, active.length) };
  });
  return { rows, raw, coverage, active, transform };
}

function identityDiagnostics(orders, sourceDiagnostics = {}) {
  const count = reason => orders.filter(order => order.recurrenceUnavailableReason === reason).length;
  return { gender: { source: 'Comentarios de Detalle Pagos de Toteat',
    named: orders.filter(order => ['feminine-associated', 'masculine-associated'].includes(order.nameGenderSegment)).length },
    recurrence: { orders: orders.length,
      classified: orders.filter(order => ['returning-instrument', 'single-observed-date'].includes(order.recurrenceGroup)).length,
      noPaymentData: count('no-payment-data'), ambiguous: count('ambiguous'),
      unmatched: count('unmatched'), missingInstrument: count('missing-instrument'),
      paymentPeriods: sourceDiagnostics.paymentPeriods || [] } };
}

function optionsFor(input, config, referenceModel) {
  const cohort = prepareCohort(input, config), features = buildFeatures(cohort.orders, config, referenceModel?.transform, referenceModel?.active);
  return { version: VERSION, parameters: config.parameters, parameterDefinitions: PARAMETER_DEFINITIONS,
    dimensions: DIMENSIONS, defaultDimensions: DEFAULT_DIMENSIONS, defaultParameters: DEFAULT_PARAMETERS,
    coverage: features.coverage, orders: cohort.orders.length, eligibleOrders: features.rows.filter(r => r.observed > 0 && r.observed >= config.parameters.observedWeight).length,
    netSales: sumMoney(cohort.orders.map(o => o.netSales)), exclusions: cohort.exclusions,
    period: input.period, sourceFingerprint: input.sourceFingerprint, sourceUpdatedAt: input.sourceUpdatedAt,
    warnings: input.warnings || [], identityDiagnostics: identityDiagnostics(cohort.orders, input.sourceDiagnostics), fixedDefinitions: Boolean(referenceModel) };
}

function distance(a, b, active, sharedWeight) {
  let total = 0, known = 0;
  for (const d of active) {
    const x = a[d.key], y = b[d.key];
    if (x === null || x === undefined || y === null || y === undefined) continue;
    known++;
    if (d.type === 'basket') {
      let intersection = 0, union = 0;
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) { intersection += Math.min(x[key] || 0, y[key] || 0); union += Math.max(x[key] || 0, y[key] || 0); }
      total += union ? 1 - intersection / union : 0;
    } else if (d.type === 'numeric') total += Math.abs(x - y);
    else if (d.type === 'circular') { const diff = Math.abs(x - y); total += Math.min(diff, 24 - diff) / 12; }
    else total += x === y ? 0 : 1;
  }
  return known && percent(known, active.length) >= sharedWeight ? total / known : null;
}

function seededRandom(seed) {
  let state = Number.parseInt(crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16);
  return () => { state += 0x6D2B79F5; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function sample(values, size, random) {
  const indices = values.slice();
  for (let i = 0; i < Math.min(size, indices.length); i++) { const j = i + Math.floor(random() * (indices.length - i)); [indices[i], indices[j]] = [indices[j], indices[i]]; }
  return indices.slice(0, size);
}

// FastPAM SWAP: cache nearest/second-nearest distances and accumulate each removal's correction.
function fastPam(matrix, n, k, checkpoint = () => {}) {
  const at = (i, j) => matrix[i * n + j];
  let first = 0, firstCost = Infinity;
  for (let j = 0; j < n; j++) { let cost = 0; for (let i = 0; i < n; i++) cost += at(i, j); if (cost < firstCost) { first = j; firstCost = cost; } }
  const medoids = [first];
  let nearest = Float64Array.from({ length: n }, (_, i) => at(i, first));
  while (medoids.length < k) {
    let best = -1, gain = -Infinity;
    for (let j = 0; j < n; j++) {
      if (medoids.includes(j)) continue;
      let improvement = 0;
      for (let i = 0; i < n; i++) improvement += Math.max(0, nearest[i] - at(i, j));
      if (improvement > gain) { best = j; gain = improvement; }
    }
    medoids.push(best);
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], at(i, best));
  }
  for (let iteration = 0; iteration < 25; iteration++) {
    checkpoint();
    const owner = new Int32Array(n), second = new Float64Array(n), removal = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      let d1 = Infinity, d2 = Infinity, best = 0;
      for (let m = 0; m < k; m++) { const d = at(i, medoids[m]); if (d < d1) { d2 = d1; d1 = d; best = m; } else if (d < d2) d2 = d; }
      nearest[i] = d1; second[i] = d2; owner[i] = best; removal[best] += d2 - d1;
    }
    let bestDelta = -1e-10, replace = -1, candidate = -1;
    for (let h = 0; h < n; h++) {
      if (medoids.includes(h)) continue;
      const correction = new Float64Array(k); let common = 0;
      for (let i = 0; i < n; i++) {
        const dh = at(i, h), improvement = Math.min(0, dh - nearest[i]);
        common += improvement;
        correction[owner[i]] += Math.min(dh, second[i]) - second[i] - improvement;
      }
      for (let m = 0; m < k; m++) {
        const delta = removal[m] + common + correction[m];
        if (delta < bestDelta) { bestDelta = delta; replace = m; candidate = h; }
      }
    }
    if (replace < 0) break;
    medoids[replace] = candidate;
  }
  return medoids;
}

function assign(rows, medoids, active, sharedWeight) {
  return rows.map(row => {
    let group = -1, best = Infinity;
    for (let m = 0; m < medoids.length; m++) { const d = distance(row.features, medoids[m].features, active, sharedWeight); if (d !== null && d < best) { best = d; group = m; } }
    return { group, distance: group < 0 ? null : best };
  });
}
function evaluationDistances(rows, active, sharedWeight) {
  const indices = sample(rows.map((_, i) => i), 500, seededRandom('evaluation')), n = indices.length, matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
    const d = distance(rows[indices[i]].features, rows[indices[j]].features, active, sharedWeight) ?? -1;
    matrix[i * n + j] = d; matrix[j * n + i] = d;
  }
  return { indices, matrix };
}
function silhouettes(rows, assignments, active, sharedWeight, random, evaluation) {
  const cache = evaluation || evaluationDistances(rows, active, sharedWeight), indices = cache.indices, n = indices.length, groups = new Set(), scores = [];
  for (const i of indices) if (assignments[i].group >= 0) groups.add(assignments[i].group);
  for (let position = 0; position < n; position++) {
    const i = indices[position], own = assignments[i].group;
    if (own < 0) continue;
    let a = null, b = Infinity;
    const sums = new Float64Array(8), counts = new Int32Array(8);
    for (let other = 0; other < n; other++) {
      if (other === position) continue;
      const group = assignments[indices[other]].group, d = cache.matrix[position * n + other];
      if (group < 0 || d < 0) continue;
      sums[group] += d; counts[group]++;
    }
    for (const group of groups) {
      const average = counts[group] ? sums[group] / counts[group] : null;
      if (group === own) a = average;
      else if (average !== null) b = Math.min(b, average);
    }
    scores.push({ group: own, value: a === null || !Number.isFinite(b) || Math.max(a, b) === 0 ? 0 : (b - a) / Math.max(a, b) });
  }
  return { global: mean(scores.map(s => s.value)) ?? 0,
    byCluster: Object.fromEntries([...groups].map(g => [g, mean(scores.filter(s => s.group === g).map(s => s.value)) ?? 0])) };
}
function fitClara(rows, active, parameters, random, checkpoint, fixedK) {
  const minimum = Math.max(parameters.minimumClusterOrders, Math.ceil(rows.length * parameters.minimumClusterShare / 100));
  const maxK = Math.min(8, Math.floor(rows.length / Math.max(2, minimum)));
  const ks = fixedK ? [fixedK] : Array.from({ length: Math.max(0, maxK - 1) }, (_, i) => i + 2);
  let best = null;
  const candidates = new Map();
  for (let repeat = 0; repeat < 5; repeat++) {
    checkpoint();
    const subset = sample(rows, Math.min(500, rows.length), random), n = subset.length, matrix = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
      const value = distance(subset[i].features, subset[j].features, active, parameters.sharedWeight) ?? 1;
      matrix[i * n + j] = value; matrix[j * n + i] = value;
    }
    for (const k of ks) {
      if (k > n) continue;
      checkpoint();
      const medoids = fastPam(matrix, n, k, checkpoint).map(i => subset[i]), assignments = assign(rows, medoids, active, parameters.sharedWeight);
      const cost = mean(assignments.filter(a => a.distance !== null).map(a => a.distance)) ?? 1;
      const candidate = { medoids, assignments, k, cost };
      if (!candidates.has(k) || cost < candidates.get(k).cost) candidates.set(k, candidate);
    }
  }
  const evaluation = evaluationDistances(rows, active, parameters.sharedWeight);
  for (const candidate of candidates.values()) {
    checkpoint();
    const score = silhouettes(rows, candidate.assignments, active, parameters.sharedWeight, random, evaluation);
    candidate.silhouette = score;
    if (!best || score.global > best.silhouette.global + 0.02
      || Math.abs(score.global - best.silhouette.global) <= 0.02 && (candidate.k < best.k || candidate.k === best.k && candidate.cost < best.cost)) best = candidate;
  }
  return best;
}

function publicOrder(order) {
  return { orderKey: order.orderKey, orderReference: order.orderReference || order.orderKey,
    locationId: order.locationId, locationName: order.locationName || order.locationId,
    date: order.date, time: order.time || '', netSales: Number(order.netSales), ticketGross: ticket(order),
    discountPercent: discountOf(order), mode: order.mode || 'unknown', recurrenceGroup: order.recurrenceGroup || 'unlinked',
    lines: order.lines.map(l => ({ code: l.code, name: l.name || l.code, quantity: Number(l.quantity),
      unit: l.unit || null, netSales: Number(l.netSales) || 0, isExtra: Boolean(l.isExtra) })) };
}
function frequency(values) {
  const result = {};
  for (const value of values) result[value ?? 'unknown'] = (result[value ?? 'unknown'] || 0) + 1;
  return Object.entries(result).map(([key, count]) => ({ key, count, percent: percent(count, values.length) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
function tokenLabel(key, orders) {
  if (key === 'other') return 'Otros productos infrecuentes';
  for (const order of orders) for (const line of order.lines) {
    if (key === `product:${line.code}`) return line.name || line.code;
    if (key === `category:${line.categoryId || line.hierarchyId}`) return line.categoryName || line.hierarchyName || key;
    if (key === basketKey(line, 'hierarchy')) return line.categoryPath?.[0] || line.hierarchyName || key;
  }
  return key;
}
function valueLabel(key, value, orders) {
  if (key === 'products') return tokenLabel(value, orders);
  if (key === 'mode') return { takeaway: 'Para llevar', dineIn: 'En local', unknown: 'Sin clasificar' }[value] || value;
  if (key === 'recurrence') return { 'returning-instrument': 'Repetición observada', 'single-observed-date': 'Primera observación', unknown: 'Sin vínculo confiable' }[value] || value;
  if (key === 'location') return orders.find(o => o.locationId === value)?.locationName || value;
  if (key === 'gender') return { 'feminine-associated': 'Nombre asociado a femenino', 'masculine-associated': 'Nombre asociado a masculino' }[value] || value;
  return value;
}
function characterize(indices, otherIndices, features, orders, parameters) {
  const differences = [], distributions = {};
  for (const d of features.active) {
    const own = indices.map(i => features.raw[i][d.key]).filter(v => v !== null), rest = otherIndices.map(i => features.raw[i][d.key]).filter(v => v !== null);
    if (d.type === 'numeric' || d.type === 'circular') {
      const all = orders.map((_, i) => features.raw[i][d.key]).filter(v => v !== null);
      const iqr = (quantile(all, 0.75) ?? 0) - (quantile(all, 0.25) ?? 0), ownMedian = median(own), restMedian = median(rest);
      distributions[d.key] = { type: d.type, median: ownMedian, q25: quantile(own, 0.25), q75: quantile(own, 0.75), coverage: percent(own.length, indices.length) };
      // Circular hours use categorical hourly prevalence for material differences (midnight has no linear median).
      if (d.type === 'numeric' && ownMedian !== null && restMedian !== null && iqr > 0) {
        const effect = Math.abs(ownMedian - restMedian) / iqr;
        if (effect >= parameters.numericDifference) differences.push({ key: d.key, label: d.label,
          type: 'numeric', value: ownMedian, rest: restMedian, effect, direction: ownMedian >= restMedian ? 'Mayor' : 'Menor' });
        continue;
      }
      if (d.type === 'numeric') continue;
    }
    const tokens = d.type === 'basket' ? [...new Set(own.flatMap(v => Object.keys(v)))] : d.type === 'circular' ? [...new Set(own.map(v => String(Math.floor(v))))] : [...new Set(own)];
    const has = (v, t) => d.type === 'basket' ? (v[t] || 0) > 0 : d.type === 'circular' ? String(Math.floor(v)) === t : v === t;
    const rows = tokens.map(token => {
      const prevalence = percent(own.filter(v => has(v, token)).length, own.length), other = percent(rest.filter(v => has(v, token)).length, rest.length), lift = other ? prevalence / other : prevalence ? null : 0;
      return { key: token, label: d.type === 'circular' ? `${token}:00` : valueLabel(d.key, token, orders), prevalence, rest: other, difference: prevalence - other, lift };
    }).sort((a, b) => b.prevalence - a.prevalence);
    distributions[d.key] = { type: d.type, coverage: percent(own.length, indices.length), values: rows.slice(0, 12) };
    const distinctive = rows.filter(v => rest.length && v.prevalence > 0 && v.difference >= parameters.prevalenceDifference && (v.lift === null || v.lift >= parameters.minimumLift));
    if (distinctive.length) differences.push({ key: d.key, label: d.label, type: 'categorical', ...distinctive.sort((a, b) => b.difference - a.difference)[0], dimensionLabel: d.label });
  }
  return { differences, distributions };
}
function orderProfile(orders) {
  const products = new Map();
  for (const order of orders) for (const line of order.lines) {
    if (line.isExtra) continue;
    const item = products.get(line.code) || { code: line.code, name: line.name || line.code, orders: 0, netSales: 0 };
    item.netSales += Number(line.netSales) || 0; products.set(line.code, item);
  }
  for (const order of orders) for (const code of new Set(order.lines.filter(l => !l.isExtra).map(l => l.code))) products.get(code).orders++;
  return { medianTicketGross: median(orders.map(ticket)), q25TicketGross: quantile(orders.map(ticket), 0.25), q75TicketGross: quantile(orders.map(ticket), 0.75),
    medianDiscountPercent: median(orders.map(discountOf).filter(v => v !== null)),
    products: [...products.values()].sort((a, b) => b.orders - a.orders || b.netSales - a.netSales).slice(0, 10).map(p => ({ ...p, percent: percent(p.orders, orders.length) })),
    modes: frequency(orders.map(o => o.mode || 'unknown')).map(v => ({ ...v, label: valueLabel('mode', v.key, orders) })),
    locations: frequency(orders.map(o => o.locationId)).map(v => ({ ...v, label: valueLabel('location', v.key, orders) })),
    hours: frequency(orders.map(o => { const h = hourOf(o); return h === null ? null : String(Math.floor(h)).padStart(2, '0') + ':00'; })),
    weekdays: frequency(orders.map(o => ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][new Date(`${o.date}T12:00:00Z`).getUTCDay()])),
    recurrence: frequency(orders.map(o => o.recurrenceGroup || 'unlinked')).map(v => ({ ...v, label: valueLabel('recurrence', v.key, orders) })) };
}

function buildResult(input, config, cohort, features, rows, solution, validation, reason) {
  const totalSales = sumMoney(cohort.orders.map(o => o.netSales)), rootTotals = input.rootTotals || { orders: cohort.orders.length, netSales: totalSales };
  const assignedByIndex = new Map(rows.map((row, i) => [row.index, solution?.assignments[i]?.group ?? -1]));
  const clusters = [];
  for (let g = 0; g < (solution?.k || 0); g++) {
    const indices = cohort.orders.map((_, i) => i).filter(i => assignedByIndex.get(i) === g);
    if (!indices.length) continue;
    const ownIndices = new Set(indices);
    const others = cohort.orders.map((_, i) => i).filter(i => !ownIndices.has(i)), orders = indices.map(i => cohort.orders[i]);
    const profile = characterize(indices, others, features, cohort.orders, config.parameters), netSales = sumMoney(orders.map(o => o.netSales));
    const distinctDates = new Set(orders.map(o => o.date)).size, silhouette = solution.silhouette.byCluster[g] ?? 0, stability = validation.stability[g] ?? null;
    const minimumSize = Math.max(config.parameters.minimumClusterOrders, Math.ceil(rows.length * config.parameters.minimumClusterShare / 100));
    const checks = [
      ['size', 'Tamaño suficiente', indices.length >= minimumSize],
      ['dates', 'Fechas suficientes', distinctDates >= config.parameters.minimumDates],
      ['globalSeparation', 'Separación global', solution.silhouette.global >= config.parameters.globalSilhouette],
      ['separation', 'Separación del cluster', silhouette > config.parameters.clusterSilhouette],
      ['stability', 'Estabilidad', stability !== null && stability >= config.parameters.minimumStability],
      ['differences', 'Diferencias materiales', profile.differences.length >= config.parameters.minimumDistinctiveDimensions],
      ['nullReference', 'Supera referencias aleatorias', validation.nullThreshold !== null && solution.silhouette.global > validation.nullThreshold],
      ['multidimensional', 'Agrupación multidimensional', features.active.length > 1],
      ['complete', 'Validación completa', validation.complete]
    ].map(([key, label, passed]) => ({ key, label, passed }));
    const descriptions = profile.differences.slice(0, 3).map(d => d.type === 'categorical' ? d.label : `${d.direction.toLowerCase()} ${d.label.toLowerCase()}`);
    const medoid = solution.medoids[g];
    clusters.push({ id: `cluster-${g + 1}`, name: descriptions.join(' · ') || `Grupo ${g + 1}`, group: g, status: checks.every(c => c.passed) ? 'solid' : 'exploratory',
      orders: indices.length, orderShare: percent(indices.length, cohort.orders.length), rootOrderShare: percent(indices.length, rootTotals.orders),
      netSales, salesShare: percent(netSales, totalSales), rootSalesShare: percent(netSales, rootTotals.netSales),
      distinctDates, silhouette, stability, checks, differences: profile.differences, distributions: profile.distributions,
      profile: orderProfile(orders), representative: publicOrder(cohort.orders[medoid.index]),
      observedCoverage: mean(indices.map(i => features.rows[i].observed)),
      examples: orders.slice(0, 3).map(publicOrder) });
  }
  const unassignedIndices = cohort.orders.map((_, i) => i).filter(i => !assignedByIndex.has(i) || assignedByIndex.get(i) < 0);
  const unassignedSales = sumMoney(unassignedIndices.map(i => cohort.orders[i].netSales));
  const warnings = [...(input.warnings || []), ...features.coverage.filter(d => d.requested && !features.active.some(a => a.key === d.key)).map(d => `${d.label}: ${d.reason}`)];
  if (!validation.complete) warnings.push('Validación incompleta: los resultados son exploratorios.');
  if (features.active.length === 1) warnings.push('Una sola dimensión: segmentación exploratoria.');
  if (cohort.exclusions.reversals || cohort.exclusions.nonPositive) warnings.push('Los totales corresponden a compras positivas válidas; anulaciones y devoluciones se informan aparte.');
  const membership = cohort.orders.map((order, i) => ({ orderKey: order.orderKey, clusterId: assignedByIndex.get(i) >= 0 ? `cluster-${assignedByIndex.get(i) + 1}` : 'unassigned',
    reason: assignedByIndex.get(i) >= 0 ? null : features.rows[i].observed < config.parameters.observedWeight ? 'Información observada insuficiente.' : reason || 'Sin representante suficientemente comparable.' }));
  return { result: { version: VERSION, period: input.period, depth: input.depth || 1, parent: input.parent || null,
    filters: config.filters, dimensions: config.dimensions, parameters: config.parameters, customParameters: config.customParameters,
    effectiveDimensions: features.active, coverage: features.coverage, sourceFingerprint: input.sourceFingerprint,
    identityDiagnostics: identityDiagnostics(cohort.orders, input.sourceDiagnostics),
    sourceUpdatedAt: input.sourceUpdatedAt || null, seed: input.seed || input.sourceFingerprint || VERSION,
    summary: { orders: cohort.orders.length, eligibleOrders: rows.length, netSales: totalSales, rootTotals,
      assignedOrders: cohort.orders.length - unassignedIndices.length, solidClusters: clusters.filter(c => c.status === 'solid').length,
      exploratoryClusters: clusters.filter(c => c.status === 'exploratory').length },
    exclusions: cohort.exclusions, clusters, unassigned: { orders: unassignedIndices.length, netSales: unassignedSales,
      orderShare: percent(unassignedIndices.length, cohort.orders.length), salesShare: percent(unassignedSales, totalSales),
      reasons: frequency(membership.filter(m => m.clusterId === 'unassigned').map(m => m.reason)) },
    validation: { ...validation, silhouette: solution?.silhouette.global ?? null },
    warnings, sourceDiagnostics: input.sourceDiagnostics || {}, status: !clusters.length ? 'insufficient' : clusters.some(c => c.status === 'solid') ? 'solid' : 'exploratory',
    message: reason || (!clusters.length ? 'No se encontraron agrupaciones suficientemente sustentadas.' : !clusters.some(c => c.status === 'solid') ? 'Se encontraron agrupaciones exploratorias; consulta los criterios pendientes.' : 'Agrupaciones sólidas y exploratorias según los parámetros utilizados.') },
    membership, orders: cohort.orders.map(publicOrder), model: solution ? { version: VERSION, dimensions: config.dimensions, parameters: config.parameters,
      active: features.active, transform: features.transform, medoids: solution.medoids.map(m => ({ features: m.features })),
      clusters: clusters.map(c => ({ id: c.id, group: c.group, name: c.name, status: c.status, orderShare: c.orderShare, salesShare: c.salesShare,
        orders: c.orders, netSales: c.netSales, silhouette: c.silhouette, stability: c.stability })), period: input.period } : null };
}

function runAnalysis(input, progress = () => {}, runtime = {}) {
  const started = Date.now(), deadline = runtime.deadline || started + 180000;
  const checkpoint = () => { if (Date.now() >= deadline) { const e = new Error('Se alcanzó el límite de cálculo.'); e.code = 'CLUSTER_TIMEOUT'; throw e; } };
  const config = normalizeConfig(input.config), cohort = prepareCohort(input, config);
  const features = buildFeatures(cohort.orders, config), rows = features.rows.filter(r => r.observed > 0 && r.observed >= config.parameters.observedWeight);
  let solution = null;
  const validation = { complete: false, bootstrapRuns: 0, nullRuns: 0, stability: {}, nullThreshold: null, elapsedMs: 0 };
  const finish = reason => { validation.elapsedMs = Date.now() - started; return buildResult(input, config, cohort, features, rows, solution, validation, reason); };
  progress({ percent: 5, message: 'Preparando pedidos y dimensiones.' });
  if (!features.active.length) { validation.complete = true; return finish('No hay dimensiones con cobertura y variación suficientes para el umbral seleccionado.'); }
  if (rows.length < config.parameters.minimumOrders) { validation.complete = true; return finish(`Hay ${rows.length} pedidos elegibles; el mínimo configurado es ${config.parameters.minimumOrders}.`); }
  if (Math.floor(rows.length / Math.max(2, config.parameters.minimumClusterOrders, Math.ceil(rows.length * config.parameters.minimumClusterShare / 100))) < 2) {
    validation.complete = true; return finish('El volumen no permite dos clusters con el tamaño mínimo configurado. Reduce ese umbral o amplía el período.');
  }
  const random = seededRandom(`${input.seed || input.sourceFingerprint || VERSION}:fit`);
  try {
    progress({ percent: 10, message: 'Buscando agrupaciones generales.' });
    solution = fitClara(rows, features.active, config.parameters, random, checkpoint);
    if (!solution) { validation.complete = true; return finish('No fue posible formar grupos comparables.'); }
    // Publish an explicitly exploratory checkpoint so the supervisor can retain it on a hard timeout.
    progress({ percent: 35, message: 'Validando estabilidad por días.', provisional: finish('Validación en curso; resultado provisional exploratorio.') });
    const dayRows = new Map();
    rows.forEach(row => { const date = cohort.orders[row.index].date; if (!dayRows.has(date)) dayRows.set(date, []); dayRows.get(date).push(row); });
    const dates = [...dayRows.keys()], stability = Array.from({ length: solution.k }, () => []);
    for (let repeat = 0; repeat < 20; repeat++) {
      checkpoint();
      const resampled = dates.flatMap(() => dayRows.get(dates[Math.floor(random() * dates.length)]));
      const fit = fitClara(resampled, features.active, config.parameters, random, checkpoint, solution.k);
      const reassigned = assign(rows, fit.medoids, features.active, config.parameters.sharedWeight);
      for (let g = 0; g < solution.k; g++) {
        let best = 0;
        for (let h = 0; h < solution.k; h++) {
          let intersection = 0, union = 0;
          for (let i = 0; i < rows.length; i++) { const a = solution.assignments[i].group === g, b = reassigned[i].group === h; if (a && b) intersection++; if (a || b) union++; }
          best = Math.max(best, union ? intersection / union : 0);
        }
        stability[g].push(best);
      }
      validation.bootstrapRuns++;
      validation.stability = Object.fromEntries(stability.map((values, g) => [g, mean(values)]));
      progress({ percent: 35 + (repeat + 1), message: `Estabilidad: ${repeat + 1} de 20 remuestreos.` });
    }
    const nullScores = [];
    for (let repeat = 0; repeat < 20; repeat++) {
      checkpoint();
      const shuffled = rows.map(r => ({ ...r, features: {} }));
      for (const d of features.active) {
        const values = sample(rows.map(r => r.features[d.key]), rows.length, random);
        shuffled.forEach((r, i) => r.features[d.key] = values[i]);
      }
      const reference = fitClara(shuffled, features.active, config.parameters, random, checkpoint);
      nullScores.push(reference?.silhouette.global ?? 0); validation.nullRuns++;
      progress({ percent: 55 + (repeat + 1) * 2, message: `Referencias aleatorias: ${repeat + 1} de 20.` });
    }
    validation.nullThreshold = quantile(nullScores, config.parameters.nullPercentile / 100);
    validation.complete = true;
    progress({ percent: 98, message: 'Preparando perfiles y conciliación.' });
    return finish();
  } catch (error) {
    if (error.code !== 'CLUSTER_TIMEOUT') throw error;
    return finish('Se alcanzó el límite de tres minutos. Los resultados disponibles son exploratorios con validación incompleta.');
  }
}

function compareWithModel(input, reference, progress = () => {}) {
  if (!reference.model) invalid('El resultado base no tiene definiciones de clusters para comparar.');
  if (reference.model.version !== VERSION) invalid('La versión del motor cambió. Calcula nuevamente el período base antes de comparar.');
  const config = normalizeConfig({ ...input.config, dimensions: reference.model.dimensions, parameters: reference.model.parameters });
  const cohort = prepareCohort(input, config), features = buildFeatures(cohort.orders, config, reference.model.transform, reference.model.active);
  const rows = features.rows.filter(r => r.observed > 0 && r.observed >= config.parameters.observedWeight);
  progress({ percent: 30, message: 'Asignando pedidos a las definiciones del período base.' });
  const assignments = assign(rows, reference.model.medoids, features.active, config.parameters.sharedWeight);
  const silhouette = silhouettes(rows, assignments, features.active, config.parameters.sharedWeight, seededRandom('comparison'));
  const solution = { k: reference.model.medoids.length, assignments, silhouette,
    medoids: reference.model.medoids.map((m, group) => rows.reduce((best, row, i) => assignments[i].group === group && (!best || assignments[i].distance < best.distance)
      ? { ...row, distance: assignments[i].distance } : best, null) || { index: 0, features: m.features }) };
  // buildResult only iterates nonempty clusters, so an empty cohort never reads a representative.
  const output = buildResult(input, config, cohort, features, rows, solution, { complete: false, bootstrapRuns: 0, nullRuns: 0, stability: {}, nullThreshold: null },
    'Comparación con definiciones conservadas del período base; no se recalcularon los clusters.');
  output.result.comparison = { period: reference.model.period, referenceJobId: input.referenceJobId,
    clusters: reference.model.clusters.map(base => {
      const current = output.result.clusters.find(c => c.group === base.group);
      if (current) { current.name = base.name; current.definitionStatus = base.status; }
      return { id: base.id, name: base.name, definitionStatus: base.status, baseOrders: base.orders, orders: current?.orders || 0,
        baseNetSales: base.netSales, netSales: current?.netSales || 0, baseOrderShare: base.orderShare, orderShare: current?.orderShare || 0,
        changePoints: (current?.orderShare || 0) - base.orderShare, baseSalesShare: base.salesShare, salesShare: current?.salesShare || 0 };
    }) };
  output.result.validation = { complete: true, method: 'fixed-definitions', silhouette: silhouette.global };
  output.result.warnings = output.result.warnings.filter(w => !w.startsWith('Validación incompleta'));
  output.result.warnings.push('La solidez pertenece a la definición base; este período no tiene una nueva validación de estabilidad.');
  output.model = reference.model;
  return output;
}

function refinementConfigurations(config) {
  const candidates = [], productLevel = config.dimensions.products.level;
  const next = productLevel === 'hierarchy' ? 'category' : productLevel === 'category' ? 'product' : null;
  const variants = [];
  if (next && config.dimensions.products.enabled) variants.push(['products', next]);
  if (config.dimensions.hour.enabled && config.dimensions.hour.level === 'band') variants.push(['hour', 'hour']);
  for (const changes of [...variants.map(v => [v]), ...(variants.length > 1 ? [variants] : [])]) {
    const value = JSON.parse(JSON.stringify(config));
    for (const [key, level] of changes) value.dimensions[key].level = level;
    candidates.push(value);
  }
  return candidates.slice(0, 12);
}
function recommendRefinements(input, progress = () => {}) {
  const deadline = Date.now() + 180000, config = normalizeConfig(input.config), recommendations = [];
  const candidates = refinementConfigurations(config); let evaluated = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const result = runAnalysis({ ...input, config: candidate }, update => progress({ percent: Math.round((evaluated + update.percent / 100) / Math.max(1, candidates.length) * 100),
      message: `Refinamiento ${evaluated + 1} de ${candidates.length}: ${update.message}` }), { deadline });
    evaluated++;
    if (result.result.validation.complete && result.result.summary.solidClusters >= 2 && result.result.validation.silhouette >= (input.parentSilhouette ?? 0) + 0.02) {
      recommendations.push({ dimensions: candidate.dimensions, clusters: result.result.clusters.length,
        silhouette: result.result.validation.silhouette, solidClusters: result.result.summary.solidClusters,
        labels: result.result.clusters.map(c => c.name) });
    }
  }
  return { result: { kind: 'refinements', evaluated, recommendations, parent: input.parent,
    complete: evaluated === candidates.length, message: recommendations.length ? 'Refinamientos con mejor separación y soporte suficiente.' : 'No se encontraron refinamientos con mejor separación y soporte suficiente.' }, membership: [], orders: [], model: null };
}

module.exports = { VERSION, DIMENSIONS, PARAMETER_DEFINITIONS, DEFAULT_PARAMETERS, DEFAULT_DIMENSIONS,
  normalizeConfig, recurrenceAsOf, prepareCohort, buildFeatures, optionsFor, distance, fastPam, seededRandom,
  sample, fitClara, assign, silhouettes, mean, median, quantile, sumMoney, percent, rawFeature, ticket, discountOf,
  runAnalysis, compareWithModel, recommendRefinements, refinementConfigurations, publicOrder };
