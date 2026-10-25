/* Caracterización de la Venta: presentación. Los cálculos viven en demand-analysis.js. */
const demandView = { generation: 0, controller: null, options: null, report: null, tab: 'products', query: '', detail: { kind: 'all', key: '', page: 1 } };
const demandMoney = value => value == null ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(value);
const demandNumber = value => value == null ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value);
const demandPercent = value => value == null ? '—' : `${demandNumber(value)}%`;
const demandEl = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const demandCell = (row, text, tag = 'td') => row.appendChild(demandEl(tag, text));
const demandOptionsSelect = (id, options, firstLabel) => {
  const select = document.getElementById(id);
  const previous = select.value;
  const rows = [new Option(firstLabel, ''), ...options.map(item => new Option(item.name || item, item.id || item.code || item))];
  select.replaceChildren(...rows);
  if (rows.some(row => row.value === previous)) select.value = previous;
};

async function initializeDemandView(initialLocations = []) {
  document.body.appendChild(document.getElementById('demand-detail-dialog'));
  const today = browserIsoToday();
  document.getElementById('demand-to').value = today;
  document.getElementById('demand-from').value = `${today.slice(0, 7)}-01`;
  document.getElementById('demand-period').addEventListener('change', () => {
    const custom = document.getElementById('demand-period').value === 'custom';
    document.querySelectorAll('.demand-custom-date').forEach(label => { label.hidden = !custom; });
  });
  document.getElementById('demand-filters').addEventListener('submit', event => { event.preventDefault(); loadDemandAnalysis(); });
  document.querySelectorAll('[data-demand-tab]').forEach(button => button.addEventListener('click', () => {
    demandView.tab = button.dataset.demandTab;
    document.querySelectorAll('[data-demand-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
    renderDemandExploration();
  }));
  document.getElementById('demand-report').addEventListener('click', event => {
    const advanced = event.target.closest('.demand-advanced-card');
    if (advanced) openDemandAdvanced(advanced.dataset.moduleKey);
    const detail = event.target.closest('.demand-detail');
    if (detail) openDemandDetail(detail.dataset.kind || 'all', detail.dataset.key || '', detail.dataset.title || 'Pedidos que sustentan el resultado');
    const jump = event.target.closest('[data-demand-jump]');
    if (jump) {
      if (jump.dataset.demandJump === 'recurrence') {
        setView('sales');
        document.getElementById('sales-workspace-tab-customers').click();
        document.getElementById('sales-observable-recurrence').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      demandView.tab = jump.dataset.demandJump;
      document.querySelector(`[data-demand-tab="${demandView.tab}"]`)?.click();
      document.getElementById('demand-exploration').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  document.getElementById('demand-detail-close').addEventListener('click', () => document.getElementById('demand-detail-dialog').close());
  document.getElementById('demand-advanced-close').addEventListener('click', () => document.getElementById('demand-advanced-dialog').close());
  document.getElementById('demand-detail-prev').addEventListener('click', () => { if (demandView.detail.page > 1) { demandView.detail.page--; loadDemandDetail(); } });
  document.getElementById('demand-detail-next').addEventListener('click', () => { demandView.detail.page++; loadDemandDetail(); });
  renderDemandFilterOptions({ locations: initialLocations, categories: [], products: [],
    capabilities: { channel: false, size: false }, pending: true });
}

function renderDemandFilterOptions(options) {
  const location = document.getElementById('demand-location'), previousLocation = location.value;
  location.replaceChildren(new Option('Todas las cafeterías', 'all'), ...(options.locations || []).map(item => new Option(item.name, item.id)));
  location.value = [...location.options].some(item => item.value === previousLocation) ? previousLocation : 'all';
  const hasCategories = Boolean(options.categories?.length);
  const hasProducts = Boolean(options.products?.length);
  demandOptionsSelect('demand-category', options.categories || [], options.pending ? 'Analiza para cargar categorías' : hasCategories ? 'Todas' : 'Sin categorías con ventas');
  demandOptionsSelect('demand-product', options.products || [], options.pending ? 'Analiza para cargar productos' : hasProducts ? 'Todos' : 'Sin productos con ventas');
  document.getElementById('demand-category').disabled = Boolean(options.pending) || !hasCategories;
  document.getElementById('demand-product').disabled = Boolean(options.pending) || !hasProducts;
  const size = document.getElementById('demand-size');
  demandOptionsSelect('demand-size', options.sizes || [], options.pending ? 'Analiza para cargar formatos' : options.capabilities?.size ? 'Todos' : 'Sin formatos identificados');
  size.disabled = Boolean(options.pending) || !options.capabilities?.size;
}

function demandQuery() {
  const params = new URLSearchParams({
    locations: document.getElementById('demand-location').value || 'all',
    mode: document.getElementById('demand-period').value,
    dateFrom: document.getElementById('demand-from').value,
    dateTo: document.getElementById('demand-to').value,
    category: document.getElementById('demand-category').value,
    product: document.getElementById('demand-product').value,
    modeOfService: document.getElementById('demand-mode').value,
    nameGender: document.getElementById('demand-name-gender').value,
    priceBand: document.getElementById('demand-price-band').value
  });
  if (!document.getElementById('demand-size').disabled) params.set('size', document.getElementById('demand-size').value);
  return params.toString();
}

async function readDemandReport(query, signal, onProgress) {
  const response = await fetch(`/api/demand-analysis?${query}&progress=1`, { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json();
    throw Object.assign(new Error(body.error || 'No se pudo calcular la venta.'), { status: response.status });
  }
  // Older running servers can still return their normal JSON response.
  if (!response.headers.get('Content-Type')?.includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', report;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'progress') onProgress(event);
    if (event.type === 'result') report = event.data;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(consume);
      if (done) { consume(pending); break; }
    }
    if (!report) throw new Error('El cálculo terminó sin entregar un reporte. Vuelve a analizar.');
    return report;
  } finally { await reader.cancel().catch(() => {}); }
}

async function loadDemandAnalysis() {
  demandView.controller?.abort();
  const controller = new AbortController(), generation = ++demandView.generation;
  demandView.controller = controller;
  const current = () => generation === demandView.generation;
  const status = document.getElementById('demand-status');
  const reportElement = document.getElementById('demand-report');
  const form = document.getElementById('demand-filters');
  const progress = document.getElementById('demand-progress');
  const bar = document.getElementById('demand-progress-bar');
  const label = document.getElementById('demand-progress-label');
  const submit = form.querySelector('[type=submit]');
  const controls = demandView.restoreControls || [...form.elements].map(element => [element, element.disabled]);
  demandView.restoreControls = controls;
  const started = performance.now();
  const elapsed = () => { if (current()) document.getElementById('demand-progress-time').textContent = `${Math.floor((performance.now() - started) / 1000)} s`; };
  const advance = event => { if (!current()) return; bar.value = event.completed; label.textContent = event.message; setStatus(status, event.message); };
  progress.hidden = false; bar.removeAttribute('value'); form.setAttribute('aria-busy', 'true');
  label.textContent = 'Paso 1 de 5 · Preparando cafeterías, productos y formatos…';
  elapsed(); const timer = setInterval(elapsed, 1000);
  [...form.elements].forEach(element => { element.disabled = true; });
  submit.textContent = 'Procesando…';
  try {
    setStatus(status, label.textContent);
    const selectedLocation = document.getElementById('demand-location').value || 'all';
    const options = await apiRequest(`/api/demand-analysis/options?locations=${encodeURIComponent(selectedLocation)}`, { signal: controller.signal });
    if (!current()) return;
    if (!demandView.options && options.today && document.getElementById('demand-period').value !== 'custom') {
      document.getElementById('demand-to').value = options.today;
      document.getElementById('demand-from').value = `${options.today.slice(0, 7)}-01`;
    }
    demandView.options = options;
    renderDemandFilterOptions(options);
    const query = demandQuery();
    // Freeze the submitted filters until their result arrives.
    [...form.elements].forEach(element => { element.disabled = true; });
    const report = await readDemandReport(query, controller.signal, advance);
    if (!current()) return;
    advance({ completed: 4, message: 'Paso 5 de 5 · Preparando tablas y resultados…' });
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (!current()) return;
    demandView.query = query; demandView.report = report;
    renderDemandReport(report);
    reportElement.hidden = false; bar.value = 5;
    setStatus(status, 'Análisis actualizado.', 'success');
  } catch (error) {
    if (!current() || error.name === 'AbortError') return;
    reportElement.hidden = true;
    setStatus(status, error.status === 404
      ? 'La API de venta no está disponible en este servidor. Reinicia Brewit y recarga la página.' : error.message, 'error');
  } finally {
    clearInterval(timer);
    if (current()) {
      controls.forEach(([element, disabled]) => { element.disabled = disabled; });
      if (demandView.options) renderDemandFilterOptions(demandView.options);
      submit.disabled = false; submit.textContent = 'Analizar';
      progress.hidden = true; form.setAttribute('aria-busy', 'false');
      demandView.controller = null; demandView.restoreControls = null;
    }
  }
}

function demandKpi(label, value, note) {
  const card = demandEl('article', null, 'demand-kpi');
  card.append(demandEl('span', label), demandEl('strong', value), demandEl('small', note));
  return card;
}

function renderDemandReport(report) {
  const { summary, coverage, comparisons } = report;
  document.getElementById('demand-updated').textContent = `Actualizado: ${report.options.sourceUpdatedAt ? new Date(report.options.sourceUpdatedAt).toLocaleString('es-CL') : 'sin archivo fechado'}`;
  document.getElementById('demand-context').textContent = `${report.period.from} – ${report.period.to} · ${report.scope.label} · ${summary.orders} pedidos observados · ${coverage.lines} líneas`;
  document.getElementById('demand-summary').replaceChildren(
    demandKpi('Venta neta sin IVA', demandMoney(summary.netSales), `${summary.orders} pedidos`),
    demandKpi('Ticket promedio con IVA', demandMoney(summary.averageTicketGross), 'Venta con IVA / pedidos'),
    demandKpi('Ticket mediano con IVA', demandMoney(summary.medianTicketGross), 'Pedido central'),
    demandKpi('Descuento sobre venta bruta', demandPercent(summary.discountPercent), 'Descuentos / antes de descuentos'),
    demandKpi('Margen neto', demandPercent(summary.marginPercent), `${summary.costCoveredOrders} de ${summary.orders} pedidos con costo`)
  );
  document.getElementById('demand-comparison').textContent = comparisons.available
    ? `Comparación: ${comparisons.period.label} (${comparisons.period.from} – ${comparisons.period.to}), ${comparisons.currentOrders} vs ${comparisons.previousOrders} pedidos · variación de venta ${demandPercent(comparisons.netSalesChangePercent)}.`
    : `Comparación no publicada: ${comparisons.reason} No se interpreta un día sin archivos como venta cero.`;
  const paymentLink = report.recurrence?.linkageCoverage;
  document.getElementById('demand-coverage').textContent = `Cobertura: historial ${coverage.firstSaleDate || 'sin ventas'} – ${coverage.lastSaleDate || 'sin ventas'} · ${coverage.observedSalesDays} fechas con ventas en el período · ${coverage.sourceFiles} archivo(s) de venta del historial leído · pedidos con Detalle Pagos vinculado ${coverage.paymentMatchedOrders}/${coverage.orders} · modalidad sin clasificar ${coverage.unknownModeOrders}/${coverage.orders} · costos completos ${coverage.costCoveredOrders}/${coverage.orders}${paymentLink?.orders ? ` · cruce pedido–MercadoPago de alta confianza ${paymentLink.linkedHigh}/${paymentLink.orders} (${demandPercent(paymentLink.linkedPercent)}), ${paymentLink.ambiguous} ambiguos, ${paymentLink.unlinked} sin vínculo y ${paymentLink.potentialSplitOrders || 0} pagos potencialmente divididos · ${paymentLink.paymentSource?.duplicatesIgnored || 0} filas duplicadas de pago omitidas` : ''}. ${coverage.scheduledDays == null ? 'Calendario operativo incompleto.' : `${coverage.coveredScheduledDays}/${coverage.scheduledDays} días programados con rango de archivo declarado.`}`;
  document.getElementById('demand-quality').replaceChildren(
    demandKpi('Modalidad clasificada', coverage.orders ? demandPercent((coverage.orders - coverage.unknownModeOrders) / coverage.orders * 100) : '—', 'En local / para llevar desde Detalle Pagos'),
    demandKpi('Costo completo', coverage.orders ? demandPercent(coverage.costCoveredOrders / coverage.orders * 100) : '—', 'Pedidos con margen calculable'),
    demandKpi('Vínculo MercadoPago', paymentLink?.orders ? demandPercent(paymentLink.linkedPercent) : '—', 'Solo coincidencias uno-a-uno de alta confianza'),
    demandKpi('Género estimado por nombre', demandPercent(report.nameSegments?.classifiedPercent), 'Cobertura orientativa; no identidad confirmada')
  );
  const body = document.getElementById('demand-locations-body'); body.replaceChildren();
  for (const location of report.locations) {
    const row = demandEl('tr');
    [location.name, location.orders, demandMoney(location.netSales), demandMoney(location.medianTicketGross), demandPercent(location.discountPercent), demandPercent(location.marginPercent), demandPercent(location.salesChangePercent)].forEach(value => demandCell(row, value));
    if (!location.comparisonAvailable) row.cells[6].title = location.comparisonReason || 'Sin período comparable';
    const cell = demandEl('td'); cell.append(demandDetailButton('location', location.id, 'Ver pedidos del local')); row.append(cell); body.append(row);
  }
  if (report.locations.length > 1) {
    const row = demandEl('tr', null, 'demand-total');
    ['TOTAL RED', summary.orders, demandMoney(summary.netSales), demandMoney(summary.medianTicketGross), demandPercent(summary.discountPercent), demandPercent(summary.marginPercent), demandPercent(comparisons.netSalesChangePercent)].forEach(value => demandCell(row, value));
    const cell = demandEl('td'); cell.append(demandDetailButton('all', '', 'Ver pedidos de la red')); row.append(cell); body.append(row);
  }
  renderDemandExploration();
  renderDemandHypotheses(report);
  renderDemandActions(report);
  const advanced = document.getElementById('demand-advanced'); advanced.replaceChildren();
  for (const module of report.advanced.filter(item => item.key !== 'customers')) {
    const card = demandEl('article', null, 'demand-insight demand-advanced-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.moduleKey = module.key;
    card.setAttribute('aria-label', `Abrir análisis: ${module.title}`);
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDemandAdvanced(module.key);
      }
    });
    card.append(demandEl('strong', module.title),
      demandEl('span', module.status === 'exploratory' ? 'Exploratorio' : 'Evidencia insuficiente', `demand-badge ${module.status}`),
      demandEl('p', module.detail), demandEl('span', 'Abrir análisis →', 'demand-card-link'));
    advanced.append(card);
  }
  document.getElementById('demand-methodology').textContent = Object.values(report.methodology).join(' ');
}

function demandDetailButton(kind, key, title = 'Ver pedidos') {
  const button = demandEl('button', title, 'icon-button demand-detail'); button.type = 'button';
  button.dataset.kind = kind; button.dataset.key = key; button.dataset.title = title;
  return button;
}

function demandTable(headers, rows, detailKind, keyField = 'key') {
  const wrap = demandEl('div', null, 'demand-scroll'); const table = demandEl('table', null, 'demand-table');
  const head = demandEl('thead'); const headRow = demandEl('tr');
  headers.forEach(item => demandCell(headRow, item.label, 'th'));
  if (detailKind) demandCell(headRow, 'Detalle', 'th');
  head.append(headRow); table.append(head);
  const body = demandEl('tbody');
  rows.forEach(item => {
    const row = demandEl('tr'); headers.forEach(header => demandCell(row, header.value(item)));
    if (detailKind) {
      const detail = demandEl('td');
      detail.append(demandDetailButton(detailKind, String(item[keyField] ?? ''), 'Ver pedidos'));
      row.append(detail);
    }
    body.append(row);
  });
  table.append(body); wrap.append(table); return wrap;
}

function demandScopeAndLimits(scope, limitations) {
  const note = demandEl('div', null, 'demand-note');
  note.append(demandEl('strong', 'Alcance: '), document.createTextNode(scope || 'Sin observaciones.'), document.createElement('br'),
    demandEl('strong', 'Limitaciones: '), document.createTextNode(limitations || 'No se informaron limitaciones adicionales.'));
  return note;
}

function demandRecurrenceDefinitions(note = demandEl('div', null, 'demand-note')) {
  const list = demandEl('ul');
  for (const [label, description] of [
    ['Instrumento recurrente', 'Pedidos vinculados a un mismo instrumento de pago registrado en dos o más fechas distintas del historial disponible, hasta el cierre del período seleccionado.'],
    ['Una fecha observada', 'Pedidos vinculados a un instrumento de pago registrado en una sola fecha del historial disponible. Puede incluir varias compras ese día; no significa que sea su primera compra real.'],
    ['Sin vínculo confiable', 'Pedidos que no pudieron asociarse con alta confianza a un instrumento de pago, por datos insuficientes o coincidencias ambiguas. No se puede determinar su recurrencia.']
  ]) {
    const item = demandEl('li');
    item.append(demandEl('strong', `${label}: `), document.createTextNode(description));
    list.append(item);
  }
  note.append(list);
  return note;
}

function renderObservableRecurrence(root, recurrence) {
  root.replaceChildren();
  root.append(demandRecurrenceDefinitions(demandScopeAndLimits(recurrence.scope, recurrence.limitations)),
    demandEl('p', `${recurrence.identifiableInstruments} instrumentos identificables; ${recurrence.returningInstruments} con dos o más fechas (${demandPercent(recurrence.returningInstrumentPercent)}). Mediana entre compras: ${recurrence.medianGapDays == null ? '—' : `${demandNumber(recurrence.medianGapDays)} días`} (P25 ${demandNumber(recurrence.p25GapDays)} · P75 ${demandNumber(recurrence.p75GapDays)}).`, 'demand-meta'));
  root.append(demandTable([
    { label: 'Segmento observable', value: item => item.label }, { label: 'Pedidos', value: item => item.orders },
    { label: 'Venta neta', value: item => demandMoney(item.netSales) }, { label: 'Part. venta', value: item => demandPercent(item.salesSharePercent) },
    { label: 'Ticket mediano', value: item => demandMoney(item.medianTicketGross) }, { label: 'Productos / pedido', value: item => demandNumber(item.productsPerOrder) },
    { label: 'Para llevar', value: item => demandPercent(item.takeawayPercent) }, { label: 'Categorías: penetración y un./100', value: demandCategoryMixText },
    { label: 'Productos predominantes', value: demandMixText }
  ], recurrence.groups, 'recurrence'));
  root.append(demandEl('h4', 'Retorno por mes de primera compra observada'));
  root.append(demandTable([
    { label: 'Mes observado', value: item => item.month }, { label: 'Instrumentos', value: item => item.instruments },
    { label: 'Elegibles a 30 días', value: item => item.eligible30 }, { label: 'Retornaron ≤30 días', value: item => item.returned30 },
    { label: 'Tasa observada', value: item => demandPercent(item.return30Percent) }
  ], recurrence.cohorts, null, 'month'));
}

function demandMixText(item) {
  return (item?.mix?.products || []).slice(0, 3).map(product => `${product.name} (${demandPercent(product.penetrationPercent)} pedidos)`).join(' · ') || '—';
}

function demandCategoryMixText(item) {
  return (item?.mix?.categories || []).slice(0, 3).map(category => `${category.name}: ${demandPercent(category.penetrationPercent)} pedidos · ${demandNumber(category.unitsPer100Orders)} un./100`).join(' · ') || '—';
}

function renderDemandExploration() {
  const report = demandView.report; if (!report) return;
  const root = document.getElementById('demand-exploration'); root.replaceChildren();
  if (demandView.tab === 'products' || demandView.tab === 'categories') {
    const rows = report.portfolio[demandView.tab];
    root.append(demandScopeAndLimits(`Base: ${report.summary.orders} pedidos filtrados; venta neta y unidades observadas.`, 'El margen solo aparece con costo completo y el crecimiento solo con períodos operativos comparables. Venta observada no mide quiebres ni venta perdida.'));
    root.append(demandTable([
      { label: demandView.tab === 'products' ? 'Producto' : 'Categoría', value: item => item.name },
      { label: 'Unidades', value: item => demandNumber(item.units) }, { label: 'Pedidos', value: item => item.orders },
      { label: 'Venta neta', value: item => demandMoney(item.netSales) }, { label: 'Participación', value: item => demandPercent(item.salesSharePercent) },
      { label: 'Margen neto', value: item => demandPercent(item.marginPercent) }, { label: 'vs período equivalente', value: item => demandPercent(item.salesChangePercent) }
    ], rows.slice(0, 100), demandView.tab === 'products' ? 'product' : 'category'));
  } else if (demandView.tab === 'baskets') {
    const basket = report.baskets;
    root.append(demandScopeAndLimits(`${basket.ordersAnalyzed} canastas; mínimo ${basket.minimumPairOrders} pedidos por combinación. Café + bollería: ${basket.coffeeBakery.togetherOrders}/${basket.coffeeBakery.coffeeOrders} (${demandPercent(basket.coffeeBakery.attachRatePercent)}).`, `Lift >1 controla popularidad individual, pero no prueba causalidad ni una oportunidad comercial. ${basket.coffeeBakery.definition}`));
    root.append(demandTable([
      { label: 'Combinación', value: item => `${item.leftName} + ${item.rightName}` }, { label: 'Pedidos juntos', value: item => item.orders },
      { label: 'Soporte', value: item => demandPercent(item.supportPercent) }, { label: 'Confianza A→B', value: item => demandPercent(item.confidenceLeftToRightPercent) },
      { label: 'Confianza B→A', value: item => demandPercent(item.confidenceRightToLeftPercent) }, { label: 'Lift', value: item => demandNumber(item.lift) }
    ], basket.pairs, 'pair'));
  } else if (demandView.tab === 'occasions') {
    const occasion = report.occasions;
    root.append(demandScopeAndLimits(occasion.scope, occasion.limitations));
    root.append(demandTable([
      { label: 'Franja', value: item => `${item.label} · ${String(item.from).padStart(2, '0')}:00–${String(item.to).padStart(2, '0')}:00` },
      { label: 'Pedidos', value: item => item.orders }, { label: '% pedidos', value: item => demandPercent(item.orderSharePercent) },
      { label: 'Venta neta', value: item => demandMoney(item.netSales) }, { label: 'Ticket mediano', value: item => demandMoney(item.medianTicketGross) },
      { label: 'Para llevar', value: item => demandPercent(item.takeawayPercent) }, { label: 'Productos / pedido', value: item => demandNumber(item.productsPerOrder) },
      { label: 'Categorías: penetración y un./100', value: demandCategoryMixText }, { label: 'Productos predominantes', value: demandMixText }
    ], occasion.bands, 'occasion', 'evidenceKey'));
    root.append(demandEl('h4', 'Días hábiles versus sábado'));
    root.append(demandTable([
      { label: 'Grupo', value: item => item.label }, { label: 'Pedidos', value: item => item.orders },
      { label: 'Venta neta', value: item => demandMoney(item.netSales) }, { label: 'Ticket mediano', value: item => demandMoney(item.medianTicketGross) },
      { label: 'Para llevar', value: item => demandPercent(item.takeawayPercent) }, { label: 'Productos predominantes', value: demandMixText }
    ], [{ key: 'weekday', label: 'Lunes a viernes', ...occasion.weekday }, { key: 'saturday', label: 'Sábado', ...occasion.saturday }], null));
  } else if (demandView.tab === 'segments') {
    const segments = report.nameSegments;
    root.append(demandScopeAndLimits(segments.scope, segments.limitations),
      demandEl('p', `Cobertura clasificable: ${segments.classifiableOrders}/${report.summary.orders} pedidos (${demandPercent(segments.classifiedPercent)}). Por diccionario: ${segments.dictionaryOrders ?? 0}; por inferencia de menor certeza: ${segments.inferredOrders ?? 0}. Los porcentajes de penetración usan como denominador los pedidos de cada segmento y pueden sumar más de 100% entre categorías.`, 'demand-meta'));
    root.append(demandTable([
      { label: 'Género estimado por nombre', value: item => item.label }, { label: 'Pedidos', value: item => item.orders },
      { label: 'Por diccionario', value: item => item.dictionaryOrders ?? 0 },
      { label: 'Por inferencia', value: item => item.inferredOrders ?? 0 },
      { label: 'Venta neta', value: item => demandMoney(item.netSales) }, { label: 'Part. venta', value: item => demandPercent(item.salesSharePercent) },
      { label: 'Ticket promedio', value: item => demandMoney(item.averageTicketGross) }, { label: 'Ticket mediano', value: item => demandMoney(item.medianTicketGross) },
      { label: 'Productos / pedido', value: item => demandNumber(item.productsPerOrder) }, { label: 'Para llevar', value: item => demandPercent(item.takeawayPercent) },
      { label: 'Margen neto', value: item => demandPercent(item.marginPercent) }, { label: 'Categorías: penetración y un./100', value: demandCategoryMixText },
      { label: 'Productos predominantes', value: demandMixText }
    ], segments.segments, 'name-segment'));
    const focusRows = segments.segments.flatMap(segment => (segment.mix.focusCategories || []).map(category => ({
      key: segment.key, segment: segment.label, ...category
    })));
    root.append(demandEl('h4', 'Sándwiches y bollería dentro de cada segmento'));
    if (focusRows.length) root.append(demandTable([
      { label: 'Segmento', value: item => item.segment }, { label: 'Categoría', value: item => item.name },
      { label: '% pedidos del segmento', value: item => demandPercent(item.penetrationPercent) },
      { label: 'Unidades / 100 pedidos', value: item => demandNumber(item.unitsPer100Orders) },
      { label: '% gasto del segmento', value: item => demandPercent(item.spendingSharePercent) }
    ], focusRows, 'name-segment'));
    else root.append(demandEl('p', 'No se encontraron categorías explícitamente clasificadas como sándwiches o bollería bajo los filtros activos.', 'demand-meta'));
  } else if (demandView.tab === 'spending') {
    root.append(demandScopeAndLimits(report.priceSignals.scope, report.priceSignals.limitations),
      demandEl('p', `Precio base explícito en ${report.priceSignals.explicitBasePriceObservations}/${report.priceSignals.paidPriceObservations} líneas; ${report.priceSignals.discountedObservations} muestran precio pagado inferior al base.`, 'demand-meta'));
    for (const [label, rows, kind] of [['Ticket por pedido', report.spending.ticketBands, 'ticket'], ['Precio pagado por producto', report.spending.productPriceBands, null]]) {
      const block = demandEl('div', null, 'demand-chart-block'); block.append(demandEl('h4', label));
      const maximum = Math.max(1, ...rows.map(item => item.observations));
      for (const item of rows) {
        const line = demandEl('div', null, 'demand-bar-row'); line.append(demandEl('span', `${demandMoney(item.from)}–${demandMoney(item.to)}`));
        const bar = demandEl('div', null, 'demand-bar'); bar.style.width = `${Math.max(2, item.observations / maximum * 100)}%`; bar.title = `${item.observations} observaciones`;
        line.append(bar, demandEl('strong', item.observations));
        line.append(demandDetailButton(kind || 'product-price', String(item.from), 'Ver pedidos'));
        block.append(line);
      }
      root.append(block);
    }
    root.append(demandEl('h4', 'Productos con variación de precio pagado'));
    root.append(demandTable([
      { label: 'Producto', value: item => item.name }, { label: 'Observaciones', value: item => item.observations },
      { label: 'Mínimo', value: item => demandMoney(item.minimumPaidGross) }, { label: 'Mediana', value: item => demandMoney(item.medianPaidGross) },
      { label: 'Máximo', value: item => demandMoney(item.maximumPaidGross) }, { label: 'Precios distintos', value: item => item.distinctPrices },
      { label: 'Líneas con descuento', value: item => demandPercent(item.discountedLinePercent) }
    ], report.priceSignals.productVariation, 'product', 'code'));
    root.append(demandEl('h4', 'Señales exploratorias alrededor de cambios de precio'));
    if (report.priceSignals.priceEvents.length) root.append(demandTable([
      { label: 'Producto', value: item => item.name }, { label: 'Semana del cambio', value: item => item.eventDate },
      { label: 'Precio anterior', value: item => demandMoney(item.previousMedianGross) }, { label: 'Precio nuevo', value: item => demandMoney(item.newMedianGross) },
      { label: 'Cambio precio', value: item => demandPercent(item.priceChangePercent) }, { label: 'Unidades antes', value: item => demandNumber(item.beforeUnits) },
      { label: 'Unidades después', value: item => demandNumber(item.afterUnits) }, { label: 'Cambio unidades', value: item => demandPercent(item.unitChangePercent) },
      { label: 'Ventanas', value: item => item.comparison }, { label: 'Precaución', value: item => item.caveat }
    ], report.priceSignals.priceEvents, 'product', 'code'));
    else root.append(demandEl('p', 'No hay cambios persistentes con al menos 10 observaciones en cada ventana de 28 días bajo los filtros activos.', 'demand-meta'));
  } else if (demandView.tab === 'time') {
    const supportsUnits = report.time.heatmap.every(item => Number.isFinite(item.units));
    const hasLineFilter = Boolean(report.filters?.category || report.filters?.product || report.filters?.size);
    const metric = supportsUnits ? demandView.timeMetric || (hasLineFilter ? 'units' : 'orders') : 'orders';
    const isAverage = demandView.timeAggregation === 'average' && Boolean(report.time.averages);
    const averages = report.time.averages;
    const cells = isAverage ? averages.heatmap : report.time.heatmap;
    const format = isAverage ? value => new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value) : demandNumber;
    const formatPercent = isAverage ? value => `${format(value)}%` : demandPercent;
    const measure = metric === 'units' ? 'unidades' : 'pedidos';
    const valueOf = item => Number(item?.[metric]) || 0;
    const measureLabel = demandEl('label', 'Mostrar ', 'demand-time-metric');
    const selector = demandEl('select'); selector.id = 'demand-time-metric';
    selector.append(new Option('Pedidos', 'orders'), new Option('Unidades vendidas', 'units'));
    selector.querySelector('[value="units"]').disabled = !supportsUnits;
    selector.value = metric;
    selector.onchange = () => { demandView.timeMetric = selector.value; renderDemandExploration(); document.getElementById('demand-time-metric').focus(); };
    const aggregationLabel = demandEl('label', 'Cálculo ', 'demand-time-metric');
    const aggregation = demandEl('select'); aggregation.id = 'demand-time-aggregation';
    aggregation.append(new Option('Total', 'total'), new Option('Promedio diario', 'average'));
    aggregation.querySelector('[value="average"]').disabled = !averages;
    aggregation.value = isAverage ? 'average' : 'total';
    aggregation.onchange = () => { demandView.timeAggregation = aggregation.value; renderDemandExploration(); document.getElementById('demand-time-aggregation').focus(); };
    aggregationLabel.append(aggregation);
    const controls = demandEl('div', null, 'demand-time-controls');
    measureLabel.append(selector); controls.append(measureLabel, aggregationLabel); root.append(controls);
    const heat = demandEl('div', null, 'demand-heatmap');
    const maximum = Math.max(1, ...cells.map(valueOf));
    const hours = [...new Set(report.time.heatmap.filter(item => item.orders).map(item => item.hour))].sort((left, right) => left - right);
    const hourHeader = demandEl('div', null, 'demand-heatmap-row demand-heatmap-hours');
    hourHeader.append(demandEl('strong', 'Hora'));
    hours.forEach(hour => hourHeader.append(demandEl('span', `${String(hour).padStart(2, '0')}:00`, 'demand-heat-hour')));
    hourHeader.append(demandEl('span', isAverage ? 'Promedio del día' : 'Total del día', 'demand-heat-hour demand-heat-day-total'));
    heat.append(hourHeader);
    for (let day = 0; day < 7; day++) {
      const hasSample = !isAverage || averages.dayCounts[day] > 0;
      const row = demandEl('div', null, 'demand-heatmap-row'); row.append(demandEl('strong', report.time.weekdays[day]));
      for (const hour of hours) {
        const item = cells.find(cell => cell.day === day && cell.hour === hour);
        const button = demandEl('button', hasSample ? format(valueOf(item)) : '—', 'demand-detail demand-heat-cell'); button.type = 'button';
        button.dataset.kind = 'heatmap'; button.dataset.key = `${day}-${hour}`; button.dataset.title = `${report.time.weekdays[day]} ${hour}:00 · ${measure} y pedidos asociados`;
        button.title = `${report.time.weekdays[day]} ${hour}:00 · ${hasSample ? format(valueOf(item)) : 'Sin muestra'} ${measure}${isAverage ? `/día · ${averages.dayCounts[day]} día(s) con venta` : metric === 'units' ? ` en ${item?.orders || 0} pedidos` : ''}`;
        button.style.setProperty('--heat', String(Math.max(0, valueOf(item)) / maximum)); row.append(button);
      }
      const dayTotal = cells.filter(item => item.day === day)
        .reduce((total, item) => total + valueOf(item), 0);
      const totalCell = demandEl('span', hasSample ? format(dayTotal) : '—', 'demand-heat-summary-cell demand-heat-day-total');
      totalCell.title = `${report.time.weekdays[day]} · ${hasSample ? format(dayTotal) : 'Sin muestra'} ${measure}${isAverage ? `/día · ${averages.dayCounts[day]} día(s) con venta` : ' en el período seleccionado'}`;
      row.append(totalCell);
      heat.append(row);
    }
    const totals = hours.map(hour => isAverage ? valueOf(averages.hourlyTotals.find(item => item.hour === hour))
      : cells.filter(item => item.hour === hour).reduce((total, item) => total + valueOf(item), 0));
    const grandTotal = totals.reduce((total, value) => total + value, 0);
    const totalRow = demandEl('div', null, 'demand-heatmap-row demand-heatmap-summary demand-heatmap-total');
    totalRow.append(demandEl('strong', isAverage ? 'Prom. diario' : 'Total'));
    totals.forEach((total, index) => {
      const cell = demandEl('span', format(total), 'demand-heat-summary-cell');
      cell.title = `${String(hours[index]).padStart(2, '0')}:00 · ${format(total)} ${measure}`;
      totalRow.append(cell);
    });
    const grandTotalCell = demandEl('span', format(grandTotal), 'demand-heat-summary-cell demand-heat-day-total');
    grandTotalCell.title = `${isAverage ? 'Promedio diario general' : 'Total general'} · ${format(grandTotal)} ${measure}${isAverage ? '/día' : ''}`;
    totalRow.append(grandTotalCell);
    const percentageRow = demandEl('div', null, 'demand-heatmap-row demand-heatmap-summary demand-heatmap-percentage');
    percentageRow.append(demandEl('strong', '% total'));
    totals.forEach((total, index) => {
      const percent = grandTotal ? total / grandTotal * 100 : 0;
      const cell = demandEl('span', formatPercent(percent), 'demand-heat-summary-cell');
      cell.title = `${String(hours[index]).padStart(2, '0')}:00 · ${formatPercent(percent)} de ${format(grandTotal)} ${measure}`;
      percentageRow.append(cell);
    });
    percentageRow.append(demandEl('span', formatPercent(grandTotal ? 100 : 0), 'demand-heat-summary-cell demand-heat-day-total'));
    heat.append(totalRow, percentageRow);
    const averageNote = isAverage
      ? ` Cada fila promedia las fechas de ese día de la semana con venta total distinta de cero. Las horas y productos sin venta aportan cero dentro de esas fechas. Muestra: ${averages.totalDays} día(s) (${report.time.weekdays.map((day, i) => `${day}: ${averages.dayCounts[i]}`).join(' · ')}). La fila inferior promedia toda la muestra. — indica que no hay fechas válidas.` : '';
    root.append(demandScopeAndLimits(metric === 'units'
      ? `${isAverage ? 'Promedio diario de unidades por día y hora' : 'Unidades vendidas por día y hora'} · ${format(grandTotal)} ${isAverage ? 'unidades/día' : `unidades en ${report.summary.orders} pedidos`}. Solo productos que cumplen los filtros de categoría, producto y formato; no incluye extras.`
      : `${isAverage ? 'Promedio diario de pedidos por día y hora' : 'Pedidos por día y hora'} · ${isAverage ? `${format(grandTotal)} pedidos/día` : `${report.summary.orders} pedidos`}. Un pedido puede contener varias unidades del producto o categoría seleccionados.`,
      'Las horas sin registros no prueban que el local estuviera abierto. Sin calendario histórico completo no se atribuye el patrón a preferencia, disponibilidad o estacionalidad.' + averageNote), heat);
    for (const [label, rows] of [['Evolución diaria', report.time.daily], ['Semanal', report.time.weekly], ['Mensual', report.time.monthly]]) {
      const block = demandEl('div', null, 'demand-chart-block'); block.append(demandEl('h4', label));
      const maximumSales = Math.max(1, ...rows.map(item => item.netSales));
      for (const item of rows.slice(-35)) {
        const line = demandEl('div', null, 'demand-bar-row'); line.append(demandEl('span', item.key));
        const bar = demandEl('div', null, 'demand-bar'); bar.style.width = `${Math.max(2, item.netSales / maximumSales * 100)}%`;
        line.append(bar, demandEl('strong', `${demandMoney(item.netSales)} · ${item.orders} pedidos`));
        line.append(demandDetailButton(label === 'Evolución diaria' ? 'day' : label === 'Semanal' ? 'week' : 'month', item.key, 'Ver pedidos'));
        block.append(line);
      }
      root.append(block);
    }
  }
}

function renderDemandHypotheses(report) {
  const root = document.getElementById('demand-hypotheses'); root.replaceChildren();
  if (!report.hypotheses.length) root.append(demandEl('p', 'Aún no hay hipótesis con la evidencia mínima definida; revisa los hechos descriptivos.', 'demand-meta'));
  for (const hypothesis of report.hypotheses) {
    const card = demandEl('article', null, 'demand-insight');
    card.append(demandEl('span', 'Hipótesis · no causal', 'demand-badge'), demandEl('h4', hypothesis.title),
      demandEl('p', `Evidencia: ${hypothesis.evidence}`), demandEl('p', `Otras explicaciones: ${hypothesis.alternatives}`),
      demandEl('p', `Falta: ${hypothesis.missing}`), demandEl('p', `Validar: ${hypothesis.validation}`));
    if (hypothesis.evidenceRef) {
      const jump = demandEl('button', 'Ir al análisis', 'icon-button'); jump.type = 'button';
      jump.dataset.demandJump = hypothesis.evidenceRef.kind === 'pair' ? 'baskets'
        : hypothesis.evidenceRef.kind === 'recurrence' ? 'recurrence' : 'products'; card.append(jump);
      card.append(demandDetailButton(hypothesis.evidenceRef.kind, hypothesis.evidenceRef.key, 'Ver pedidos de la evidencia'));
    }
    root.append(card);
  }
}

function renderDemandActions(report) {
  const root = document.getElementById('demand-actions'); root.replaceChildren();
  if (!report.actions.length) root.append(demandEl('p', 'No se proponen acciones sin un fundamento observable.', 'demand-meta'));
  for (const action of report.actions) {
    const card = demandEl('article', null, 'demand-insight');
    card.append(demandEl('span', `Prioridad ${action.priorityScore} · ${action.priorityRule}`, 'demand-badge'), demandEl('h4', action.title),
      demandEl('p', `Objetivo: ${action.goal}`), demandEl('p', `Base: ${action.impactBasis}`),
      demandEl('p', `Prueba: ${action.test}`), demandEl('p', `Medida de éxito: ${action.metric}`));
    if (action.evidenceId) card.append(demandEl('small', `Vinculada a ${action.evidenceId}`));
    root.append(card);
  }
}

function demandAdvancedExplanation(label, value) {
  const block = demandEl('div', null, 'demand-advanced-explanation');
  block.append(demandEl('strong', label), demandEl('p', value || 'Sin información adicional disponible.'));
  return block;
}

function openDemandAdvanced(moduleKey) {
  const report = demandView.report;
  const module = report?.advanced?.find(item => item.key === moduleKey);
  if (!module) return;
  document.getElementById('demand-advanced-title').textContent = module.title;
  const root = document.getElementById('demand-advanced-content'); root.replaceChildren();
  root.append(demandEl('span', module.status === 'exploratory' ? 'Exploratorio' : 'Evidencia insuficiente', `demand-badge ${module.status}`),
    demandEl('p', module.detail, 'demand-advanced-summary'));
  const definitions = demandEl('section', null, 'demand-advanced-definitions');
  definitions.append(demandAdvancedExplanation('Alcance', module.scope),
    demandAdvancedExplanation('Datos disponibles', module.availableData),
    demandAdvancedExplanation('Limitaciones', module.limitations),
    demandAdvancedExplanation('Información necesaria para fortalecerlo', module.requirements));
  root.append(definitions);

  if (moduleKey === 'seasonality') renderDemandSeasonalityDetail(root, report);
  else if (moduleKey === 'elasticity') renderDemandElasticityDetail(root, report);
  else if (moduleKey === 'price-barrier') renderDemandPriceBarrierDetail(root, report);
  else if (moduleKey === 'channel') renderDemandCapabilityDetail(root, 'Canales encontrados', report.options?.channels || [], report.filters?.channel);
  else if (moduleKey === 'size') renderDemandCapabilityDetail(root, 'Tamaños encontrados', report.options?.sizes || [], report.filters?.size);
  else if (moduleKey === 'lost-demand') {
    root.append(demandEl('h4', 'Qué sí podemos observar hoy'),
      demandEl('p', 'Ventas atendidas, mezcla de productos, horarios de compra y movimientos diarios de inventario. Estos datos sirven para formular una investigación, pero no para cuantificar clientes que desistieron.', 'demand-meta'));
  }
  document.getElementById('demand-advanced-dialog').showModal();
}

function renderDemandSeasonalityDetail(root, report) {
  const seasonality = report.annualSeasonality;
  root.append(demandEl('h4', 'Índice mensual observado'));
  if (!seasonality?.available) {
    root.append(demandEl('p', 'El índice permanece bloqueado para evitar atribuir estacionalidad anual a unos pocos meses de historia.', 'demand-meta'));
    return;
  }
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  root.append(demandEl('p', `Locales elegibles: ${seasonality.eligibleStores.map(store => `${store.name} (${store.years.join(', ')})`).join(' · ')}`, 'demand-meta'),
    demandTable([
      { label: 'Mes', value: item => monthNames[item.month - 1] },
      { label: 'Índice', value: item => demandPercent(item.indexPercent) },
      { label: 'Observaciones local-año', value: item => item.observations }
    ], seasonality.months, null), demandEl('p', seasonality.method, 'demand-meta'));
}

function renderDemandElasticityDetail(root, report) {
  const price = report.priceSignals;
  const kpis = demandEl('div', null, 'demand-kpis');
  kpis.append(demandKpi('Líneas con precio', demandNumber(price.paidPriceObservations), 'Precio efectivamente pagado'),
    demandKpi('Productos variables', demandNumber(price.productVariation.length), 'Mínimo 5 observaciones'),
    demandKpi('Señales antes/después', demandNumber(price.priceEvents.length), 'Mínimo 10 observaciones por ventana'));
  root.append(demandEl('h4', 'Evidencia descriptiva disponible'), kpis);
  if (price.priceEvents.length) root.append(demandTable([
    { label: 'Producto', value: item => item.name }, { label: 'Fecha señal', value: item => item.eventDate },
    { label: 'Precio anterior', value: item => demandMoney(item.previousMedianGross) },
    { label: 'Precio nuevo', value: item => demandMoney(item.newMedianGross) },
    { label: 'Δ precio', value: item => demandPercent(item.priceChangePercent) },
    { label: 'Unidades antes', value: item => demandNumber(item.beforeUnits) },
    { label: 'Unidades después', value: item => demandNumber(item.afterUnits) },
    { label: 'Δ unidades', value: item => demandPercent(item.unitChangePercent) },
    { label: 'Ventanas', value: item => item.comparison }
  ], price.priceEvents, null));
  else root.append(demandEl('p', 'No hay señales que cumplan la base mínima en ambos lados del cambio bajo los filtros activos.', 'demand-meta'));
  root.append(demandEl('p', 'Interpretación: estos cambios son asociaciones temporales. No constituyen un coeficiente de elasticidad ni demuestran que el precio haya causado la variación de unidades.', 'demand-note'));
}

function renderDemandPriceBarrierDetail(root, report) {
  const price = report.priceSignals;
  root.append(demandEl('h4', 'Cortes exploratorios'));
  root.append(demandTable([
    { label: 'Punto de precio', value: item => demandMoney(item.value) },
    { label: 'Observaciones inferiores', value: item => item.below },
    { label: 'Observaciones en/sobre el punto', value: item => item.atOrAbove },
    { label: '% en/sobre el punto', value: item => demandPercent(item.below + item.atOrAbove ? item.atOrAbove / (item.below + item.atOrAbove) * 100 : null) }
  ], price.thresholds, null));
  root.append(demandEl('h4', `Distribución del precio pagado · intervalos de ${demandMoney(price.bandSize)}`),
    demandTable([
      { label: 'Intervalo', value: item => `${demandMoney(item.from)}–${demandMoney(item.to)}` },
      { label: 'Observaciones', value: item => item.observations },
      { label: 'Unidades', value: item => demandNumber(item.units) },
      { label: 'Venta neta asociada', value: item => demandMoney(item.netSales) }
    ], price.productPriceBands, null),
    demandEl('p', 'Interpretación: la tabla muestra dónde se realizaron compras. No observa productos que no estaban disponibles ni decisiones de no compra.', 'demand-note'));
}

function renderDemandCapabilityDetail(root, title, values, selected) {
  root.append(demandEl('h4', title));
  if (!values.length) root.append(demandEl('p', 'No existen valores utilizables en las fuentes cargadas.', 'demand-meta'));
  else {
    const list = demandEl('div', null, 'demand-capability-values');
    values.forEach(value => list.append(demandEl('span', value, 'demand-badge')));
    root.append(list, demandEl('p', `Filtro activo: ${selected || 'Todos los valores disponibles'}.`, 'demand-meta'));
  }
}

function openDemandDetail(kind, key, title, query = demandView.query) {
  demandView.detail = { kind, key, title, query, page: 1 };
  document.getElementById('demand-detail-title').textContent = title;
  document.getElementById('demand-detail-dialog').showModal();
  loadDemandDetail();
}

async function loadDemandDetail() {
  const { kind, key, page, query } = demandView.detail;
  const status = document.getElementById('demand-detail-status'); status.textContent = 'Cargando pedidos…';
  try {
    const response = await apiRequest(`/api/demand-analysis/orders?${query}&kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&page=${page}&limit=50`);
    status.textContent = `${response.total} pedidos · período ${response.period.from} – ${response.period.to}`;
    const root = document.getElementById('demand-detail-content'); root.replaceChildren();
    const table = demandEl('table', null, 'demand-table'); const head = demandEl('thead'); const header = demandEl('tr');
    ['Fecha y hora', 'Local', 'Pedido', 'Venta neta', 'Ticket con IVA', 'Descuento con IVA', 'Costo neto', 'Productos y origen del costo'].forEach(label => demandCell(header, label, 'th')); head.append(header); table.append(head);
    const body = demandEl('tbody');
    for (const order of response.orders) {
      const row = demandEl('tr');
      [order.date + ' ' + order.time, order.locationName, order.orderReference || order.orderKey,
        demandMoney(order.netSales), demandMoney(order.ticketGross), demandMoney(order.discountGross), demandMoney(order.cost),
        order.lines.map(line => `${line.name} (${line.code}) ×${demandNumber(line.quantity)} · venta ${demandMoney(line.netSales)} · costo ${demandMoney(line.cost)} [${line.costSource || 'sin fuente'}]`).join(' · ')].forEach(value => demandCell(row, value));
      body.append(row);
    }
    table.append(body); root.append(table);
    document.getElementById('demand-detail-page').textContent = `Página ${page} de ${Math.max(1, Math.ceil(response.total / response.limit))}`;
    document.getElementById('demand-detail-prev').disabled = page <= 1;
    document.getElementById('demand-detail-next').disabled = page * response.limit >= response.total;
  } catch (error) { status.textContent = error.message; }
}
