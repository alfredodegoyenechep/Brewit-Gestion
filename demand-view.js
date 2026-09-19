/* Análisis de la demanda: presentación. Los cálculos viven en demand-analysis.js. */
const demandView = { options: null, report: null, tab: 'products', query: '', detail: { kind: 'all', key: '', page: 1 } };
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
  const today = browserIsoToday();
  for (const id of ['demand-anchor', 'demand-to']) document.getElementById(id).value = today;
  document.getElementById('demand-from').value = `${today.slice(0, 7)}-01`;
  document.getElementById('demand-period').addEventListener('change', () => {
    const custom = document.getElementById('demand-period').value === 'custom';
    document.querySelectorAll('.demand-custom-date').forEach(label => { label.hidden = !custom; });
    document.getElementById('demand-anchor-label').hidden = custom || document.getElementById('demand-period').value === 'all';
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
    capabilities: { channel: false, size: false }, loading: true });
}

function renderDemandFilterOptions(options) {
  const container = document.getElementById('demand-location-options');
  const previous = [...container.querySelectorAll('input')];
  const checked = new Set(previous.filter(input => input.checked).map(input => input.value));
  const allPreviouslySelected = previous.length > 0 && checked.size === previous.length;
  container.replaceChildren();
  for (const location of options.locations) {
    const label = demandEl('label');
    const input = demandEl('input');
    input.type = 'checkbox'; input.value = location.id;
    input.checked = !previous.length || allPreviouslySelected || checked.has(location.id);
    label.append(input, document.createTextNode(location.name));
    container.append(label);
  }
  const hasCategories = Boolean(options.categories?.length);
  const hasProducts = Boolean(options.products?.length);
  demandOptionsSelect('demand-category', options.categories || [], options.loading ? 'Cargando categorías…' : hasCategories ? 'Todas' : 'Sin categorías con ventas');
  demandOptionsSelect('demand-product', options.products || [], options.loading ? 'Cargando productos…' : hasProducts ? 'Todos' : 'Sin productos con ventas');
  document.getElementById('demand-category').disabled = Boolean(options.loading) || !hasCategories;
  document.getElementById('demand-product').disabled = Boolean(options.loading) || !hasProducts;
  const channel = document.getElementById('demand-channel');
  if (options.capabilities?.channel) demandOptionsSelect('demand-channel', options.channels, 'Todos');
  channel.disabled = !options.capabilities?.channel;
  const size = document.getElementById('demand-size');
  if (options.capabilities?.size) demandOptionsSelect('demand-size', options.sizes, 'Todos');
  size.disabled = !options.capabilities?.size;
}

function demandQuery() {
  const locations = [...document.querySelectorAll('#demand-location-options input:checked')].map(input => input.value);
  if (!locations.length) throw new Error('Selecciona al menos una cafetería.');
  const params = new URLSearchParams({
    locations: locations.join(','), mode: document.getElementById('demand-period').value,
    anchor: document.getElementById('demand-anchor').value, dateFrom: document.getElementById('demand-from').value,
    dateTo: document.getElementById('demand-to').value,
    category: document.getElementById('demand-category').value, product: document.getElementById('demand-product').value,
    modeOfService: document.getElementById('demand-mode').value,
    nameGender: document.getElementById('demand-name-gender').value,
    recurrence: document.getElementById('demand-recurrence').value,
    priceBand: document.getElementById('demand-price-band').value,
    morningEnd: document.getElementById('demand-morning-end').value,
    middayEnd: document.getElementById('demand-midday-end').value,
    afternoonEnd: document.getElementById('demand-afternoon-end').value
  });
  if (!document.getElementById('demand-channel').disabled) params.set('channel', document.getElementById('demand-channel').value);
  if (!document.getElementById('demand-size').disabled) params.set('size', document.getElementById('demand-size').value);
  return params.toString();
}

async function loadDemandAnalysis() {
  const status = document.getElementById('demand-status');
  const reportElement = document.getElementById('demand-report');
  try {
    setStatus(status, 'Actualizando opciones y calculando demanda…');
    const selectedLocations = [...document.querySelectorAll('#demand-location-options input:checked')].map(input => input.value);
    if (document.querySelector('#demand-location-options input') && !selectedLocations.length) {
      throw new Error('Selecciona al menos una cafetería.');
    }
    const options = await apiRequest(`/api/demand-analysis/options${selectedLocations.length ? `?locations=${encodeURIComponent(selectedLocations.join(','))}` : ''}`);
    if (!demandView.options && options.today) {
      document.getElementById('demand-anchor').value = options.today;
      document.getElementById('demand-to').value = options.today;
      document.getElementById('demand-from').value = `${options.today.slice(0, 7)}-01`;
    }
    demandView.options = options;
    renderDemandFilterOptions(options);
    demandView.query = demandQuery();
    setStatus(status, 'Calculando pedidos, ocasiones, precios, segmentos, recurrencia y cobertura…');
    const report = await apiRequest(`/api/demand-analysis?${demandView.query}`);
    demandView.report = report;
    renderDemandReport(report);
    reportElement.hidden = false;
    setStatus(status, 'Análisis actualizado.', 'success');
  } catch (error) {
    reportElement.hidden = true;
    if (error.status === 404) {
      setStatus(status, 'La API de demanda no está disponible en este servidor. Reinicia Brewit y recarga la página.', 'error');
    } else {
      setStatus(status, error.message, 'error');
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
  for (const module of report.advanced) {
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
    root.append(demandScopeAndLimits(`Base: ${report.summary.orders} pedidos filtrados; venta neta y unidades observadas.`, 'El margen solo aparece con costo completo y el crecimiento solo con períodos operativos comparables. Venta observada no mide quiebres ni demanda perdida.'));
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
      demandEl('p', `Cobertura clasificable: ${segments.classifiableOrders}/${report.summary.orders} pedidos (${demandPercent(segments.classifiedPercent)}). Los porcentajes de penetración usan como denominador los pedidos de cada segmento y pueden sumar más de 100% entre categorías.`, 'demand-meta'));
    root.append(demandTable([
      { label: 'Género estimado por nombre', value: item => item.label }, { label: 'Pedidos', value: item => item.orders },
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
  } else if (demandView.tab === 'recurrence') {
    const recurrence = report.recurrence;
    root.append(demandScopeAndLimits(recurrence.scope, recurrence.limitations),
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
    const heat = demandEl('div', null, 'demand-heatmap');
    const maximum = Math.max(1, ...report.time.heatmap.map(item => item.orders));
    const hours = [...new Set(report.time.heatmap.filter(item => item.orders).map(item => item.hour))].sort((left, right) => left - right);
    const hourHeader = demandEl('div', null, 'demand-heatmap-row demand-heatmap-hours');
    hourHeader.append(demandEl('strong', 'Hora'));
    hours.forEach(hour => hourHeader.append(demandEl('span', `${String(hour).padStart(2, '0')}:00`, 'demand-heat-hour')));
    heat.append(hourHeader);
    for (let day = 0; day < 7; day++) {
      const row = demandEl('div', null, 'demand-heatmap-row'); row.append(demandEl('strong', report.time.weekdays[day]));
      for (const hour of hours) {
        const item = report.time.heatmap.find(cell => cell.day === day && cell.hour === hour);
        const button = demandEl('button', String(item?.orders || 0), 'demand-detail demand-heat-cell'); button.type = 'button';
        button.dataset.kind = 'heatmap'; button.dataset.key = `${day}-${hour}`; button.dataset.title = `${report.time.weekdays[day]} ${hour}:00 · pedidos`;
        button.title = `${report.time.weekdays[day]} ${hour}:00 · ${item?.orders || 0} pedidos · ${demandMoney(item?.netSales || 0)} netos`;
        button.style.setProperty('--heat', String((item?.orders || 0) / maximum)); row.append(button);
      }
      heat.append(row);
    }
    const totals = hours.map(hour => report.time.heatmap.filter(item => item.hour === hour)
      .reduce((total, item) => total + (Number(item.orders) || 0), 0));
    const grandTotal = totals.reduce((total, value) => total + value, 0);
    const totalRow = demandEl('div', null, 'demand-heatmap-row demand-heatmap-summary demand-heatmap-total');
    totalRow.append(demandEl('strong', 'Total'));
    totals.forEach((total, index) => {
      const cell = demandEl('span', demandNumber(total), 'demand-heat-summary-cell');
      cell.title = `${String(hours[index]).padStart(2, '0')}:00 · ${total} pedidos`;
      totalRow.append(cell);
    });
    const percentageRow = demandEl('div', null, 'demand-heatmap-row demand-heatmap-summary demand-heatmap-percentage');
    percentageRow.append(demandEl('strong', '% total'));
    totals.forEach((total, index) => {
      const percent = grandTotal ? total / grandTotal * 100 : 0;
      const cell = demandEl('span', demandPercent(percent), 'demand-heat-summary-cell');
      cell.title = `${String(hours[index]).padStart(2, '0')}:00 · ${demandPercent(percent)} de ${grandTotal} pedidos`;
      percentageRow.append(cell);
    });
    heat.append(totalRow, percentageRow);
    root.append(demandScopeAndLimits(`Pedidos por día y hora · ${report.summary.orders} observaciones.`, 'Las horas sin registros no prueban que el local estuviera abierto. Sin calendario histórico completo no se atribuye el patrón a preferencia, disponibilidad o estacionalidad.'), heat);
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
  } else if (moduleKey === 'customers') renderDemandRecurrenceDetail(root, report);
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

function renderDemandRecurrenceDetail(root, report) {
  const recurrence = report.recurrence;
  const link = recurrence.linkageCoverage || {};
  const kpis = demandEl('div', null, 'demand-kpis');
  kpis.append(demandKpi('Vínculo de alta confianza', demandPercent(link.linkedPercent), `${link.linkedHigh || 0}/${link.orders || 0} pedidos`),
    demandKpi('Instrumentos observables', demandNumber(recurrence.identifiableInstruments), 'Pseudonimizados'),
    demandKpi('Instrumentos recurrentes', demandNumber(recurrence.returningInstruments), demandPercent(recurrence.returningInstrumentPercent)),
    demandKpi('Mediana entre compras', recurrence.medianGapDays == null ? '—' : `${demandNumber(recurrence.medianGapDays)} días`, 'Solo instrumentos con más de una fecha'));
  root.append(demandEl('h4', 'Cobertura y comportamiento observable'), kpis,
    demandTable([
      { label: 'Segmento', value: item => item.label }, { label: 'Pedidos', value: item => item.orders },
      { label: 'Venta neta', value: item => demandMoney(item.netSales) },
      { label: 'Participación venta', value: item => demandPercent(item.salesSharePercent) },
      { label: 'Ticket mediano', value: item => demandMoney(item.medianTicketGross) },
      { label: 'Productos / pedido', value: item => demandNumber(item.productsPerOrder) }
    ], recurrence.groups, null));
  if (recurrence.cohorts.length) root.append(demandEl('h4', 'Cohortes por primera compra observada'), demandTable([
    { label: 'Mes', value: item => item.month }, { label: 'Instrumentos', value: item => item.instruments },
    { label: 'Elegibles 30 días', value: item => item.eligible30 }, { label: 'Retornaron ≤30 días', value: item => item.returned30 },
    { label: 'Retorno observado', value: item => demandPercent(item.return30Percent) }
  ], recurrence.cohorts, null));
}

function openDemandDetail(kind, key, title) {
  demandView.detail = { kind, key, title, page: 1 };
  document.getElementById('demand-detail-title').textContent = title;
  document.getElementById('demand-detail-dialog').showModal();
  loadDemandDetail();
}

async function loadDemandDetail() {
  const { kind, key, page } = demandView.detail;
  const status = document.getElementById('demand-detail-status'); status.textContent = 'Cargando pedidos…';
  try {
    const response = await apiRequest(`/api/demand-analysis/orders?${demandView.query}&kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}&page=${page}&limit=50`);
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
