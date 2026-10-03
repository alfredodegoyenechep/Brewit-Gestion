/* Pedidos, filtros y dimensiones son independientes. El motor se ejecuta en el servidor. */
(() => {
  const storageKey = 'brewit.salesClusters.preferences.v1', savedKey = 'brewit.salesClusters.saved.v1';
  const state = { options: null, job: null, starting: false, controller: null, result: null, resultJobId: null, parent: null, referenceJobId: null,
    timer: null, page: 1, detailClusterId: null, generation: 0, controlsReady: false };
  const byId = suffix => document.getElementById(`sales-clusters-${suffix}`);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  const writeStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const button = (text, action, cls = 'icon-button') => { const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node; };
  const status = (message, type = '') => setStatus(byId('status'), message, type);
  const table = (headers, rows) => {
    const wrap = el('div', null, 'demand-scroll'), node = el('table', null, 'demand-table sales-clusters-table');
    const head = node.createTHead().insertRow(); headers.forEach(h => { const cell = el('th', h); cell.scope = 'col'; head.append(cell); });
    const body = node.createTBody();
    for (const values of rows) { const row = body.insertRow(); for (const value of values) { const cell = row.insertCell(); cell.append(value instanceof Node ? value : el('span', value)); } }
    wrap.append(node); return wrap;
  };
  const fields = { category: 'category', product: 'product', modeOfService: 'mode', recurrence: 'recurrence',
    hourFrom: 'hour-from', hourTo: 'hour-to', minSpend: 'min-spend', maxSpend: 'max-spend', minDiscount: 'min-discount', maxDiscount: 'max-discount' };
  function filters() {
    const result = { locations: byId('location').value, mode: 'custom', dateFrom: byId('from').value, dateTo: byId('to').value,
      nameGender: 'all', morningEnd: document.getElementById('demand-morning-end').value,
      middayEnd: document.getElementById('demand-midday-end').value, afternoonEnd: document.getElementById('demand-afternoon-end').value };
    for (const [key, suffix] of Object.entries(fields)) if (byId(suffix).value !== '') result[key] = byId(suffix).value;
    if (!result.dateFrom || !result.dateTo || result.dateFrom > result.dateTo) throw new Error('Selecciona un período válido y en orden.');
    if (state.options && result.dateTo > state.options.today) throw new Error('El período no puede incluir fechas futuras.');
    return result;
  }
  function configuration() {
    if (!state.controlsReady) return readStorage(storageKey, {});
    return {
      dimensions: Object.fromEntries(state.options.dimensions.map(d => [d.key, {
        enabled: byId(`dimension-${d.key}`).checked,
        level: byId(`level-${d.key}`).value,
        minimumCoverage: byId(`minimum-coverage-${d.key}`).value === '' ? null : Number(byId(`minimum-coverage-${d.key}`).value) }])),
      parameters: Object.fromEntries(state.options.parameterDefinitions.map(p => [p.key, Number(byId(`parameter-${p.key}`).value)]))
    };
  }
  function updateCustomBadge() {
    if (!state.controlsReady) return;
    const config = configuration();
    byId('custom').hidden = !state.options.parameterDefinitions.some(p => config.parameters[p.key] !== p.defaultValue)
      && !Object.values(config.dimensions).some(d => d.minimumCoverage !== null);
  }
  function markDirty() {
    if (state.controlsReady) { writeStorage(storageKey, configuration()); updateCustomBadge(); }
    if (state.result) status('Configuración modificada. Los resultados visibles conservan los parámetros del cálculo anterior.');
  }
  function fillSelect(suffix, options, firstLabel, selected = '') {
    const node = byId(suffix);
    node.replaceChildren(new Option(firstLabel, ''), ...options.map(o => new Option(o.name || o.code, o.id || o.code)));
    if ([...node.options].some(o => o.value === selected)) node.value = selected;
  }
  function buildControls(options) {
    const preferences = readStorage(storageKey, {}), dims = byId('dimensions'), params = byId('parameters');
    dims.replaceChildren(); params.replaceChildren();
    for (const definition of options.dimensions) {
      const card = el('div', null, 'sales-clusters-dimension'), label = el('label', null, 'sales-clusters-check');
      const input = el('input'); input.type = 'checkbox'; input.id = `sales-clusters-dimension-${definition.key}`;
      input.checked = preferences.dimensions?.[definition.key]?.enabled ?? options.defaultDimensions[definition.key].enabled;
      label.append(input, document.createTextNode(definition.label));
      const levelLabel = el('label', 'Nivel de detalle'), select = el('select'); select.id = `sales-clusters-level-${definition.key}`;
      select.replaceChildren(...definition.levels.map(([key, value]) => new Option(value, key)));
      select.value = preferences.dimensions?.[definition.key]?.level || definition.defaultLevel;
      if (!select.value) select.value = definition.defaultLevel;
      levelLabel.append(select);
      const note = el('small'); note.id = `sales-clusters-dimension-note-${definition.key}`;
      input.setAttribute('aria-describedby', note.id); select.setAttribute('aria-describedby', note.id);
      const coverageLabel = el('label', 'Cobertura mínima (%)'), coverageInput = el('input');
      coverageInput.id = `sales-clusters-minimum-coverage-${definition.key}`;
      coverageInput.type = 'number'; coverageInput.min = 0; coverageInput.max = 100; coverageInput.step = 'any';
      coverageInput.value = preferences.dimensions?.[definition.key]?.minimumCoverage ?? '';
      coverageInput.placeholder = 'Usar umbral general';
      coverageInput.setAttribute('aria-describedby', note.id);
      coverageLabel.append(coverageInput);
      card.append(label, levelLabel, coverageLabel, note); dims.append(card);
    }
    for (const definition of options.parameterDefinitions) {
      const label = el('label', definition.label), input = el('input');
      input.id = `sales-clusters-parameter-${definition.key}`; input.type = 'number'; input.required = true;
      input.min = definition.min; if (definition.max !== null) input.max = definition.max;
      input.step = definition.integer ? 1 : 'any'; input.value = preferences.parameters?.[definition.key] ?? definition.defaultValue;
      label.append(input); params.append(label);
    }
    state.controlsReady = true;
  }
  function renderCoverage(options) {
    const root = byId('coverage'); root.replaceChildren();
    root.append(el('p', `${demandNumber(options.orders)} pedidos válidos · ${demandNumber(options.eligibleOrders)} elegibles · Venta neta ${demandMoney(options.netSales)}.`));
    root.append(el('p', `Período: ${options.period.from} a ${options.period.to}. Cobertura mínima: ${options.parameters.dimensionCoverage} %.`));
    if (options.parent) root.append(el('p', `Cobertura del grupo seleccionado: ${options.parent.name}.`));
    if (options.fixedDefinitions) root.append(el('p', 'Las dimensiones y referencias se conservan desde el período base, incluso si en este período no presentan variación.'));
    const notes = el('div', null, 'sales-clusters-coverage-grid');
    for (const item of options.coverage) {
      const text = `${item.label}: ${demandPercent(item.coverage)} conocida · ${item.variability} valores distintos${item.reason ? ` · ${item.reason}` : ''}`;
      notes.append(el('small', text));
      const input = byId(`dimension-${item.key}`), select = byId(`level-${item.key}`);
      if (!input) continue;
      const unavailableGender = item.key === 'gender' && !item.known;
      const singleLocation = item.key === 'location' && item.variability <= 1;
      input.disabled = unavailableGender || singleLocation || Boolean(state.referenceJobId);
      select.disabled = singleLocation || Boolean(state.referenceJobId);
      byId(`minimum-coverage-${item.key}`).disabled = Boolean(state.referenceJobId);
      byId(`minimum-coverage-${item.key}`).placeholder = `General: ${options.parameters.dimensionCoverage} %`;
      byId(`dimension-note-${item.key}`).textContent = `${demandPercent(item.coverage)} conocida · Mínimo ${demandPercent(item.minimumCoverage)}${item.reason ? ` · ${item.reason}` : ''}${item.basis ? ` · ${item.basis}` : ''}`;
      if (item.key === 'gender' && item.level === 'validated') {
        byId(`dimension-note-${item.key}`).append(document.createTextNode(` · Estimación por nombre disponible: ${demandPercent(item.nameCoverage)} (${demandNumber(item.nameKnown)} pedidos).`));
        if (item.nameKnown && !state.referenceJobId) {
          byId(`dimension-note-${item.key}`).append(button('Usar estimación por nombre', () => {
            select.value = 'name'; markDirty(); reviewCoverage();
          }));
        }
      }
    }
    root.append(notes);
    const recurrence = options.identityDiagnostics?.recurrence;
    if (recurrence) {
      root.append(el('p', `Recurrencia: ${demandNumber(recurrence.classified)} de ${demandNumber(recurrence.orders)} pedidos clasificables. `
        + `Sin pagos MercadoPago en la fecha/local: ${demandNumber(recurrence.noPaymentData)}; vínculos ambiguos: ${demandNumber(recurrence.ambiguous)}; `
        + `sin coincidencia de pedido y pago: ${demandNumber(recurrence.unmatched)}; pagos sin identificador de tarjeta: ${demandNumber(recurrence.missingInstrument)}.`));
      for (const period of recurrence.paymentPeriods) root.append(el('small', period.from
        ? `MercadoPago · ${period.locationName}: ${period.from} a ${period.to}.`
        : `MercadoPago · ${period.locationName}: sin pagos disponibles.`));
      root.append(el('small', 'La cobertura indica pedidos clasificables como primera observación o repetición. El porcentaje de venta recurrente utiliza otro denominador. Los pedidos sin evidencia permanecen sin clasificar.'));
    }
    const exclusions = options.exclusions;
    root.append(el('small', `Exclusiones: ${exclusions.duplicates} pedidos duplicados, ${exclusions.reversals} anulados/devoluciones, ${exclusions.nonPositive} sin venta positiva, ${exclusions.insufficient} incompletos.`));
    if (options.sourceDiagnostics?.duplicateSalesRows) root.append(el('small', `${options.sourceDiagnostics.duplicateSalesRows} filas duplicadas eliminadas en la fuente, antes de los filtros de atributos.`));
    updateCustomBadge();
  }
  async function loadCoverage() {
    const generation = ++state.generation;
    const current = filters(), config = configuration();
    const query = new URLSearchParams(current); query.set('configuration', JSON.stringify(config));
    if (state.parent) { query.set('parentJobId', state.parent.jobId); query.set('parentClusterId', state.parent.clusterId); }
    if (state.referenceJobId) query.set('referenceJobId', state.referenceJobId);
    const options = await apiRequest(`/api/sales-clusters/options?${query}`);
    if (generation !== state.generation) return null;
    state.options = options;
    if (!state.controlsReady) buildControls(options);
    renderCoverage(options); return options;
  }
  async function reviewCoverage() {
    try { status('Revisando cobertura y dimensiones…'); await loadCoverage(); status('Cobertura actualizada.'); }
    catch (error) { status(error.message, 'error'); }
  }
  function setBusy(busy) {
    byId('calculate').disabled = busy; byId('cancel').hidden = !busy; byId('progress').hidden = !busy;
    byId('coverage-button').disabled = busy; byId('save').disabled = busy; byId('load').disabled = busy;
    // A running calculation keeps its input snapshot even if this dialog is closed.
    byId('form').querySelectorAll('input, select, #sales-clusters-reset').forEach(node => {
      if (busy) { node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else if (node.dataset.wasDisabled !== undefined) { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    });
    for (const suffix of ['results', 'detail', 'context']) byId(suffix).querySelectorAll('button').forEach(n => n.disabled = busy);
  }
  function renderContext() {
    const root = byId('context'); root.replaceChildren(); root.hidden = !state.parent && !state.referenceJobId;
    if (state.parent) {
      root.append(el('p', `Profundizar: ${state.parent.name}. Se utilizarán solamente los pedidos de este grupo; ajusta las dimensiones y calcula.`));
      root.append(button('Volver al resultado padre', async () => {
        try {
          const result = await apiRequest(`/api/sales-clusters/jobs/${state.parent.jobId}/result`);
          state.parent = result.parent; state.result = result; state.resultJobId = result.jobId;
          applyResultConfiguration(result); applyResultFilters(result); renderContext(); renderResults(result); reviewCoverage();
        } catch (error) { status(error.message, 'error'); }
      }));
    } else if (state.referenceJobId) {
      root.append(el('p', 'Comparación entre períodos: se conservarán las definiciones, dimensiones y parámetros del resultado base. Cambia las fechas y calcula.'));
      root.append(button('Volver al descubrimiento de clusters', () => {
        state.referenceJobId = null; unlockReference(); renderContext(); reviewCoverage();
      }));
    }
    for (const suffix of ['location', 'from', 'to', ...Object.values(fields)]) byId(suffix).disabled = Boolean(state.parent);
  }
  function unlockReference() {
    byId('dimensions').querySelectorAll('input, select').forEach(n => n.disabled = false);
    byId('parameters').querySelectorAll('input').forEach(n => n.disabled = false);
    byId('reset').disabled = false;
  }
  function applyResultConfiguration(result) {
    for (const [key, value] of Object.entries(result.dimensions)) {
      byId(`dimension-${key}`).checked = value.enabled; byId(`level-${key}`).value = value.level;
      byId(`minimum-coverage-${key}`).value = value.minimumCoverage ?? '';
    }
    for (const [key, value] of Object.entries(result.parameters)) byId(`parameter-${key}`).value = value;
    updateCustomBadge();
  }
  function applyResultFilters(result) {
    byId('location').value = result.filters.locations || 'all'; byId('from').value = result.period.from; byId('to').value = result.period.to;
    for (const [key, suffix] of Object.entries(fields)) byId(suffix).value = result.filters[key] ?? (['modeOfService', 'recurrence'].includes(key) ? 'all' : '');
  }
  async function open() {
    const dialog = byId('dialog'); if (!dialog.open) dialog.showModal();
    if (state.job || state.starting) return;
    try {
      if (!state.parent && !state.referenceJobId) {
        const selected = [...document.querySelectorAll('#demand-location-options input:checked')].map(i => i.value);
        const options = demandView.options;
        byId('location').replaceChildren(new Option('Todas las cafeterías', 'all'), ...(options?.locations || []).map(l => new Option(l.name, l.id)));
        byId('location').value = selected.length === 1 ? selected[0] : 'all';
        const period = demandView.report?.period;
        byId('from').value = period?.from || document.getElementById('demand-from').value;
        byId('to').value = period?.to || document.getElementById('demand-to').value;
        if (!state.options) {
          byId('category').replaceChildren(new Option('Todas', ''), ...(options?.categories || []).map(o => new Option(o.name, o.id)));
          byId('product').replaceChildren(new Option('Todos', ''), ...(options?.products || []).map(o => new Option(o.name, o.code)));
        }
        byId('category').value = document.getElementById('demand-category').value;
        byId('product').value = document.getElementById('demand-product').value;
        byId('mode').value = document.getElementById('demand-mode').value;
        byId('recurrence').value = document.getElementById('demand-recurrence').value;
      }
      status('Preparando cobertura y parámetros…');
      const options = await loadCoverage();
      if (!options) return;
      if (!byId('location').options.length || byId('location').options.length === 1) {
        byId('location').replaceChildren(new Option('Todas las cafeterías', 'all'), ...options.locations.map(l => new Option(l.name, l.id)));
      }
      byId('from').max = options.today; byId('to').max = options.today;
      fillSelect('category', options.categories, 'Todas', byId('category').value);
      fillSelect('product', options.products, 'Todos', byId('product').value);
      refreshSaved(); renderContext(); status('Selecciona filtros y dimensiones y calcula los clusters.');
    } catch (error) { status(error.status === 404 ? 'El servidor todavía no dispone del análisis de clusters. Reinicia Brewit y recarga la página.' : error.message, 'error'); }
  }
  async function startCalculation(extra = {}) {
    if (state.job || state.starting) return;
    try {
      if (!byId('form').reportValidity()) return;
      const config = configuration();
      const body = { filters: filters(), ...config, ...extra };
      if (state.parent && !extra.parent) body.parent = state.parent;
      if (state.referenceJobId) body.referenceJobId = state.referenceJobId;
      if (!Object.values(config.dimensions || {}).some(d => d.enabled) && !state.referenceJobId) throw new Error('Activa al menos una dimensión.');
      writeStorage(storageKey, config);
      state.starting = true; state.controller = new AbortController(); setBusy(true);
      byId('progress-bar').value = 0; byId('progress-text').textContent = 'Preparando pedidos desde las fuentes locales…';
      status('Iniciando cálculo sobre los datos sincronizados…');
      const job = await apiRequest('/api/sales-clusters/jobs', { method: 'POST', signal: state.controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.starting = false; state.controller = null; state.job = job; await poll();
    } catch (error) {
      const aborted = state.controller?.signal.aborted; state.starting = false; state.controller = null;
      status(aborted ? 'Preparación cancelada. Se conserva el último resultado disponible.' : error.message, aborted ? '' : 'error');
      if (!state.job) setBusy(false);
    }
  }
  async function poll() {
    if (!state.job) return;
    const jobId = state.job.id;
    try {
      const job = await apiRequest(`/api/sales-clusters/jobs/${jobId}`);
      if (state.job?.id !== jobId) return;
      byId('progress-bar').value = job.progress; byId('progress-text').textContent = job.message;
      status(job.message);
      if (job.status === 'completed') {
        const result = await apiRequest(`/api/sales-clusters/jobs/${jobId}/result`);
        state.job = null; setBusy(false);
        if (result.kind === 'refinements') renderRefinements(result);
        else if (result.depth > 1 && result.status === 'insufficient' && state.result) {
          // An unsupported subdivision must not replace the last usable parent result.
          renderResults(state.result);
          const detail = byId('detail'); detail.hidden = false;
          detail.replaceChildren(el('h4', 'No fue posible subdividir el grupo'), el('p', result.message, 'sales-clusters-warning'),
            el('p', `Se conserva el resultado anterior. Pedidos elegibles del grupo: ${result.summary.eligibleOrders}. Ajusta los parámetros o vuelve al resultado padre.`));
        }
        else {
          state.result = result; state.resultJobId = jobId; byId('detail').hidden = true;
          applyResultConfiguration(result); renderResults(result);
        }
        status(result.message, result.status === 'solid' ? 'success' : '');
      } else if (['failed', 'cancelled'].includes(job.status)) {
        state.job = null; setBusy(false); status(job.error || job.message, job.status === 'failed' ? 'error' : '');
      } else state.timer = setTimeout(poll, 1000);
    } catch (error) {
      if (state.job?.id !== jobId) return;
      if ([400, 404].includes(error.status)) { state.job = null; setBusy(false); status(error.message, 'error'); return; }
      status(`${error.message} Se reintentará consultar el cálculo.`, 'error');
      state.timer = setTimeout(poll, 3000);
    }
  }
  function renderResults(result) {
    const root = byId('results'); root.hidden = false; root.replaceChildren();
    const head = el('div', null, 'demand-section-head');
    head.append(el('h4', `Resultados · ${result.period.from} a ${result.period.to}`));
    if (result.clusters.length && !result.comparison) head.append(button('Comparar otro período con estos grupos', () => {
      state.referenceJobId = state.resultJobId; state.parent = null;
      applyResultConfiguration(result);
      byId('dimensions').querySelectorAll('input, select').forEach(n => n.disabled = true);
      byId('parameters').querySelectorAll('input').forEach(n => n.disabled = true); byId('reset').disabled = true;
      renderContext(); status('Cambia el período para comparar usando las mismas definiciones.'); byId('from').focus();
    }));
    root.append(head);
    const summary = el('div', null, 'demand-kpis');
    summary.append(demandKpi('Pedidos válidos', demandNumber(result.summary.orders), `${demandNumber(result.summary.eligibleOrders)} elegibles`),
      demandKpi('Venta neta', demandMoney(result.summary.netSales), 'Sin IVA'),
      demandKpi('Clusters sólidos', demandNumber(result.summary.solidClusters), 'Según los parámetros utilizados'),
      demandKpi('Exploratorios', demandNumber(result.summary.exploratoryClusters), 'Criterios pendientes'),
      demandKpi('Sin asignar', demandNumber(result.unassigned.orders), demandPercent(result.unassigned.orderShare)));
    root.append(summary, el('p', result.message));
    if (result.stale) root.append(el('p', 'Los datos sincronizados cambiaron desde este cálculo. Calcula nuevamente para incorporar la actualización.', 'sales-clusters-warning'));
    if (result.customParameters) root.append(el('span', 'Parámetros personalizados', 'sales-clusters-badge'));
    const context = el('details'); context.append(el('summary', 'Datos, dimensiones y parámetros utilizados'));
    context.append(el('p', `Nivel ${result.depth} de 3. Dimensiones efectivas: ${result.effectiveDimensions.map(d => d.label).join(', ') || 'Ninguna'}.`));
    context.append(el('p', `Fuente: ${result.sourceUpdatedAt || 'sin fecha de sincronización registrada'} · Versión ${result.version}.`));
    context.append(table(['Parámetro', 'Valor'], state.options.parameterDefinitions.map(p => [p.label, demandNumber(result.parameters[p.key])])));
    context.append(table(['Variable', 'Cobertura mínima (%)'], state.options.dimensions.map(d => [d.label,
      demandNumber(result.dimensions[d.key].minimumCoverage ?? result.parameters.dimensionCoverage)])));
    for (const warning of result.warnings) context.append(el('p', warning, 'sales-clusters-note'));
    const ex = result.exclusions; context.append(el('p', `Excluidos: ${ex.duplicates} pedidos duplicados, ${ex.reversals} anulados/devoluciones, ${ex.nonPositive} sin venta positiva y ${ex.insufficient} incompletos.`));
    if (result.sourceDiagnostics?.duplicateSalesRows) context.append(el('p', `${result.sourceDiagnostics.duplicateSalesRows} filas duplicadas eliminadas antes de filtros.`));
    root.append(context);
    if (result.comparison) {
      root.append(el('h4', `Comparación con ${result.comparison.period.from} a ${result.comparison.period.to}`));
      root.append(table(['Cluster', 'Pedidos base', 'Pedidos actuales', '% pedidos base', '% pedidos actuales', 'Cambio (puntos)', 'Venta base', 'Venta actual'], result.comparison.clusters.map(c =>
        [c.name, demandNumber(c.baseOrders), demandNumber(c.orders), demandPercent(c.baseOrderShare), demandPercent(c.orderShare), demandNumber(c.changePoints), demandMoney(c.baseNetSales), demandMoney(c.netSales)])));
    }
    for (const label of result.comparison ? ['exploratory'] : ['solid', 'exploratory']) {
      const groups = result.clusters.filter(c => c.status === label); if (!groups.length) continue;
      root.append(el('h4', result.comparison ? 'Composición del período comparado' : label === 'solid' ? 'Clusters sólidos' : 'Clusters exploratorios'));
      const grid = el('div', null, 'sales-clusters-card-grid');
      for (const cluster of groups) {
        const card = el('article', null, `sales-clusters-card ${cluster.status}`);
        const name = button(cluster.name, () => showDetail(cluster.id), 'sales-clusters-card-title');
        card.append(name, el('span', result.comparison ? `Definición base: ${cluster.definitionStatus === 'solid' ? 'sólida' : 'exploratoria'}` : label === 'solid' ? 'Sólido' : 'Exploratorio', 'sales-clusters-badge'));
        card.append(el('p', `${demandNumber(cluster.orders)} pedidos · ${demandPercent(cluster.orderShare)} de pedidos · ${demandMoney(cluster.netSales)} · ${demandPercent(cluster.salesShare)} de venta.`));
        if (result.parent) card.append(el('small', `Sobre el total original: ${demandPercent(cluster.rootOrderShare)} de pedidos y ${demandPercent(cluster.rootSalesShare)} de venta.`));
        card.append(el('p', `Ticket mediano: ${demandMoney(cluster.profile.medianTicketGross)} · ${cluster.distinctDates} fechas de venta.`));
        card.append(el('small', `Silhouette ${demandNumber(cluster.silhouette)} · Estabilidad ${demandNumber(cluster.stability)} · Cobertura ${demandPercent(cluster.observedCoverage)}.`));
        const missing = cluster.checks.filter(c => !c.passed).map(c => c.label);
        if (missing.length && !result.comparison) card.append(el('p', `Pendiente: ${missing.join(', ')}.`, 'sales-clusters-note'));
        const actions = el('div', null, 'sales-clusters-actions'); actions.append(button('Ver detalle y pedidos', () => showDetail(cluster.id)));
        if (result.depth < 3 && !result.comparison) {
          actions.append(button('Profundizar', () => prepareChild(cluster)));
          actions.append(button('Buscar refinamientos', () => searchRefinements(cluster)));
        }
        card.append(actions); grid.append(card);
      }
      root.append(grid);
    }
    if (result.clusters.length) {
      root.append(el('h4', 'Comparación de características'));
      root.append(table(['Cluster', 'Pedidos', '% pedidos', 'Venta neta', '% venta', 'Ticket mediano', 'Productos predominantes', 'Horario', 'Descuento mediano', 'Modalidad', 'Cafeterías'],
        [...result.clusters.map(c => [button(c.name, () => showDetail(c.id)), demandNumber(c.orders), demandPercent(c.orderShare), demandMoney(c.netSales), demandPercent(c.salesShare),
          demandMoney(c.profile.medianTicketGross), c.profile.products.slice(0, 3).map(p => p.name).join(', '), c.profile.hours.slice(0, 3).map(p => `${p.key} (${demandPercent(p.percent)})`).join(', '),
          demandPercent(c.profile.medianDiscountPercent), c.profile.modes.map(p => `${p.label}: ${demandPercent(p.percent)}`).join(', '), c.profile.locations.map(p => `${p.label}: ${demandPercent(p.percent)}`).join(', ')]),
          [button('Sin asignar', () => showDetail('unassigned')), demandNumber(result.unassigned.orders), demandPercent(result.unassigned.orderShare), demandMoney(result.unassigned.netSales), demandPercent(result.unassigned.salesShare), '—', '—', '—', '—', '—', '—'],
          ['TOTAL', demandNumber(result.summary.orders), result.summary.orders ? '100 %' : '0 %', demandMoney(result.summary.netSales), result.summary.netSales ? '100 %' : '0 %', '—', '—', '—', '—', '—', '—']]));
    }
    if (result.unassigned.orders) root.append(el('p', `Sin asignar: ${result.unassigned.reasons.map(r => `${r.key} (${r.count})`).join(' · ')}`, 'sales-clusters-warning'));
  }
  function prepareChild(cluster) {
    if (state.job || state.starting) return;
    state.parent = { jobId: state.resultJobId, clusterId: cluster.id, name: cluster.name }; state.referenceJobId = null;
    applyResultConfiguration(state.result);
    const product = byId('level-products'); if (product.value === 'hierarchy') product.value = 'category'; else if (product.value === 'category') product.value = 'product';
    renderContext(); reviewCoverage(); byId('dimensions').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function searchRefinements(cluster) {
    if (state.job || state.starting) return;
    const parent = { jobId: state.resultJobId, clusterId: cluster.id, name: cluster.name };
    await startCalculation({ parent, searchRefinements: true, dimensions: state.result.dimensions, parameters: state.result.parameters });
  }
  function renderRefinements(result) {
    const root = byId('detail'); root.hidden = false; root.replaceChildren(el('h4', 'Refinamientos recomendados'), el('p', `${result.message} Configuraciones evaluadas: ${result.evaluated}.`));
    for (const recommendation of result.recommendations) {
      const label = state.options.dimensions.filter(d => recommendation.dimensions[d.key].level !== state.result.dimensions[d.key].level).map(d => `${d.label}: ${d.levels.find(([level]) => level === recommendation.dimensions[d.key].level)?.[1]}`).join(' · ');
      root.append(button(`${label} · ${recommendation.solidClusters} grupos sólidos · Aplicar`, () => {
        state.parent = result.parent; state.referenceJobId = null;
        for (const [key, value] of Object.entries(recommendation.dimensions)) { byId(`dimension-${key}`).checked = value.enabled; byId(`level-${key}`).value = value.level; }
        renderContext(); status('Refinamiento aplicado. Calcula para abrir los resultados.');
      }));
    }
    if (!result.complete) root.append(el('p', 'La búsqueda alcanzó el límite de tiempo; no se evaluaron todas las configuraciones.', 'sales-clusters-warning'));
  }
  function distribution(title, values, nameKey = 'label') {
    const root = el('section', null, 'sales-clusters-distribution'); root.append(el('h5', title));
    for (const value of values.slice(0, 10)) {
      const row = el('div', null, 'sales-clusters-bar'); const fraction = value.percent ?? value.prevalence ?? 0;
      row.append(el('span', value[nameKey] || value.key || value.name)); const meter = el('meter'); meter.min = 0; meter.max = 100; meter.value = fraction;
      meter.setAttribute('aria-label', `${value[nameKey] || value.key}: ${demandPercent(fraction)}`); row.append(meter, el('span', demandPercent(fraction))); root.append(row);
    }
    return root;
  }
  async function showDetail(clusterId, page = 1) {
    state.detailClusterId = clusterId; state.page = page;
    const jobId = state.resultJobId, cluster = state.result.clusters.find(c => c.id === clusterId), root = byId('detail');
    root.hidden = false; root.replaceChildren(el('h4', cluster?.name || 'Pedidos sin asignar'));
    if (cluster) {
      const descriptions = el('div', null, 'sales-clusters-actions');
      descriptions.append(distribution('Productos predominantes', cluster.profile.products, 'name'), distribution('Horario', cluster.profile.hours, 'key'),
        distribution('Días de semana', cluster.profile.weekdays, 'key'), distribution('Modalidad', cluster.profile.modes),
        distribution('Cafeterías', cluster.profile.locations), distribution('Recurrencia observada del instrumento', cluster.profile.recurrence));
      root.append(descriptions);
      root.append(el('p', `Ticket mediano con IVA: ${demandMoney(cluster.profile.medianTicketGross)}. El 50 % central está entre ${demandMoney(cluster.profile.q25TicketGross)} y ${demandMoney(cluster.profile.q75TicketGross)}. Descuento mediano: ${demandPercent(cluster.profile.medianDiscountPercent)}.`));
      if (cluster.distributions.price) root.append(el('p', `Precio relativo mediano: ${demandNumber(cluster.distributions.price.median)} veces el precio habitual del producto y unidad. Cobertura: ${demandPercent(cluster.distributions.price.coverage)}.`));
      root.append(table(['Característica distintiva', 'Este grupo', 'Resto', 'Diferencia'], cluster.differences.map(d => [d.dimensionLabel || d.label,
        d.type === 'categorical' ? `${d.label}: ${demandPercent(d.prevalence)}` : demandNumber(d.value),
        d.type === 'categorical' ? demandPercent(d.rest) : demandNumber(d.rest), d.type === 'categorical' ? `${demandNumber(d.difference)} puntos · lift ${d.lift === null ? 'sin presencia en el resto' : demandNumber(d.lift)}` : `${demandNumber(d.effect)} rangos intercuartílicos`])));
      root.append(table(['Criterio', 'Resultado'], cluster.checks.map(c => [c.label, c.passed ? 'Cumple' : 'Pendiente'])));
      const representative = el('details'); representative.append(el('summary', 'Pedido representativo'));
      representative.append(el('p', `${cluster.representative.date} ${cluster.representative.time} · ${cluster.representative.locationName} · ${demandMoney(cluster.representative.ticketGross)}`));
      representative.append(table(['Producto', 'Cantidad', 'Venta neta'], cluster.representative.lines.map(l => [l.name, demandNumber(l.quantity), demandMoney(l.netSales)]))); root.append(representative);
    }
    const loading = el('p', 'Cargando pedidos…'); root.append(loading); root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await apiRequest(`/api/sales-clusters/jobs/${jobId}/clusters/${clusterId}/orders?page=${page}&limit=25`);
      if (state.detailClusterId !== clusterId || state.page !== page || state.resultJobId !== jobId) return;
      loading.remove(); root.append(el('h5', `${data.total} pedidos · Página ${page}`));
      const rows = data.orders.map(o => {
        const detail = el('details'); detail.append(el('summary', `${o.lines.length} líneas · Abrir pedido`));
        detail.append(table(['Código', 'Producto', 'Cantidad', 'Venta neta'], o.lines.map(l => [l.code, l.name, demandNumber(l.quantity), demandMoney(l.netSales)])));
        if (o.unassignedReason) detail.append(el('p', o.unassignedReason));
        return [o.orderReference, `${o.date} ${o.time}`, o.locationName, demandMoney(o.ticketGross), demandMoney(o.netSales), demandPercent(o.discountPercent), detail];
      });
      root.append(table(['Pedido', 'Fecha y hora', 'Cafetería', 'Ticket con IVA', 'Venta neta', 'Descuento', 'Productos'], rows));
      const pages = el('div', null, 'sales-clusters-actions'), previous = button('Anterior', () => showDetail(clusterId, page - 1)), next = button('Siguiente', () => showDetail(clusterId, page + 1));
      previous.disabled = page <= 1; next.disabled = page * data.limit >= data.total; pages.append(previous, next); root.append(pages);
    } catch (error) { loading.textContent = error.message; loading.className = 'sales-clusters-warning'; }
  }
  function refreshSaved() {
    const saved = readStorage(savedKey, []); byId('saved').replaceChildren(new Option('Seleccionar…', ''), ...saved.map((s, i) => new Option(s.name, String(i))));
  }
  function initialize() {
    byId('open').addEventListener('click', open); byId('close').addEventListener('click', () => byId('dialog').close());
    byId('coverage-button').addEventListener('click', reviewCoverage);
    byId('form').addEventListener('submit', event => { event.preventDefault(); startCalculation(); });
    byId('form').addEventListener('change', markDirty);
    byId('cancel').addEventListener('click', async () => {
      if (state.starting) { state.controller?.abort(); return; }
      if (!state.job) return;
      try {
        const cancelled = await apiRequest(`/api/sales-clusters/jobs/${state.job.id}`, { method: 'DELETE' });
        if (cancelled.status === 'completed') { await poll(); return; }
        clearTimeout(state.timer); state.job = null; setBusy(false); status('Cálculo cancelado. Se conserva el último resultado disponible.');
      } catch (error) { status(error.message, 'error'); }
    });
    byId('reset').addEventListener('click', () => {
      if (!state.controlsReady) return;
      for (const p of state.options.parameterDefinitions) byId(`parameter-${p.key}`).value = p.defaultValue;
      for (const d of state.options.dimensions) byId(`minimum-coverage-${d.key}`).value = '';
      markDirty(); reviewCoverage();
    });
    byId('save').addEventListener('click', () => {
      try {
        const name = byId('config-name').value.trim(); if (!name) throw new Error('Escribe un nombre para guardar la configuración.');
        const saved = readStorage(savedKey, []).filter(s => s.name !== name);
        saved.push({ name, configuration: configuration(), filters: filters() });
        if (!writeStorage(savedKey, saved.slice(-30))) throw new Error('Este navegador no permite guardar configuraciones. Revisa sus opciones de almacenamiento.');
        refreshSaved(); status('Configuración guardada en este navegador.', 'success');
      } catch (error) { status(error.message, 'error'); }
    });
    byId('load').addEventListener('click', () => {
      const selected = byId('saved').value; if (selected === '') { status('Selecciona una configuración guardada.'); return; }
      const saved = readStorage(savedKey, [])[Number(selected)]; if (!saved) return;
      state.parent = null; state.referenceJobId = null; unlockReference(); renderContext();
      applyResultConfiguration({ ...saved.configuration });
      byId('location').value = saved.filters.locations; byId('from').value = saved.filters.dateFrom; byId('to').value = saved.filters.dateTo;
      for (const [key, suffix] of Object.entries(fields)) byId(suffix).value = saved.filters[key] ?? (['modeOfService', 'recurrence'].includes(key) ? 'all' : '');
      markDirty(); reviewCoverage();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize); else initialize();
})();
