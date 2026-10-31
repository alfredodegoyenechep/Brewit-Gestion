/* Independent report: product filters never constrain the customer's purchase history. */
(() => {
  const byId = id => document.getElementById(`product-recurrence-${id}`);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const count = value => value == null ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(value);
  const money = value => value == null ? '—' : formatClp(value);
  const percent = value => value == null ? '—' : `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`;
  const state = { report: null, generation: 0, controller: null, optionsController: null, optionsLocation: null, products: [], groupedProducts: [], selected: new Set() };
  const status = (message, type = 'muted') => setStatus(byId('status'), message, type);
  const runButton = byId('filters').querySelector('[type=submit]');
  function syncDates() {
    const mode = byId('period').value, today = browserIsoToday();
    for (const field of ['from', 'to']) { byId(field).disabled = mode !== 'custom'; byId(field).max = today; }
    if (mode === 'custom') return;
    let from = today, to = today;
    if (mode === 'last-28-days') { to = offsetIsoDate(today, -1); from = offsetIsoDate(to, -27); }
    if (mode === 'current-week') from = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (mode === 'current-month') from = `${today.slice(0, 7)}-01`;
    byId('from').value = from; byId('to').value = to;
  }
  function dirty() {
    state.generation++; state.controller?.abort(); byId('progress').hidden = true;
    byId('filters').setAttribute('aria-busy', 'false'); runButton.disabled = false;
    status(state.report ? 'Los filtros cambiaron. El resultado visible conserva la consulta anterior; pulsa Generar reporte para aplicar la selección.' : 'Selecciona los filtros y pulsa Generar reporte.');
  }
  function syncGrouping() {
    const products = byId('group').value === 'product';
    byId('picker').hidden = !products; byId('level-field').hidden = products;
  }
  const productChoices = () => byId('formats').checked ? state.groupedProducts : state.products.map(product => ({ ...product, codes: [product.code], formats: [] }));
  function expandGroupedSelection() {
    if (!byId('formats').checked) return;
    for (const group of state.groupedProducts) if (group.codes.some(code => state.selected.has(code))) group.codes.forEach(code => state.selected.add(code));
  }
  function updateSelectionCount() {
    const selected = productChoices().filter(product => product.codes.some(code => state.selected.has(code))).length;
    byId('selection-count').textContent = selected ? `${count(selected)} producto(s) seleccionado(s)` : 'Todos los productos';
  }
  function renderProducts() {
    const search = byId('search').value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const matching = productChoices().filter(p => `${p.name} ${p.codes.join(' ')} ${p.formats.join(' ')}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(search));
    byId('products').replaceChildren(...matching.map(product => {
      const label = el('label'), input = el('input'); input.type = 'checkbox'; input.value = product.code; input.dataset.codes = JSON.stringify(product.codes);
      input.checked = product.codes.every(code => state.selected.has(code));
      input.indeterminate = !input.checked && product.codes.some(code => state.selected.has(code));
      const caption = product.formats.length ? `${product.name} (${product.formats.join(', ')})` : `${product.name} · ${product.code}`;
      label.title = `${product.name} · ${product.codes.join(' / ')}`;
      label.append(input, el('span', caption)); return label;
    }));
    if (!matching.length) byId('products').append(el('p', 'No hay productos que coincidan con la búsqueda.', 'panel-description'));
    updateSelectionCount();
  }
  async function loadOptions(force = false) {
    const location = byId('location').value;
    if (!force && state.optionsLocation === location) return;
    state.optionsController?.abort();
    const controller = new AbortController(); state.optionsController = controller;
    setStatus(byId('options-status'), 'Cargando jerarquías y productos…', 'muted');
    try {
      const data = await apiRequest(`/api/sales/product-recurrence/options?${new URLSearchParams({ location })}`, { signal: controller.signal });
      if (controller.signal.aborted || byId('location').value !== location) return;
      state.optionsLocation = location; state.products = data.products;
      state.groupedProducts = data.groupedProducts || data.products.map(product => ({ ...product, codes: [product.code], formats: [] }));
      expandGroupedSelection();
      const previous = byId('hierarchy').value, level = byId('level').value;
      byId('hierarchy').replaceChildren(new Option('Todas las jerarquías', '[]'), ...data.hierarchies.map(h => new Option(h.label, JSON.stringify(h.path))));
      if ([...byId('hierarchy').options].some(o => o.value === previous)) byId('hierarchy').value = previous;
      const depth = Math.max(1, ...data.hierarchies.map(h => h.path.length));
      byId('level').replaceChildren(...Array.from({ length: depth }, (_, i) => new Option(`Nivel ${i + 1}`, String(i + 1))));
      byId('level').value = Number(level) <= depth ? level : '1';
      renderProducts(); setStatus(byId('options-status'), data.warnings?.join(' ') || '', data.warnings?.length ? 'warning' : 'muted');
    } catch (error) {
      if (controller.signal.aborted) return;
      const retry = el('button', 'Reintentar carga', 'icon-button small'); retry.type = 'button'; retry.addEventListener('click', () => loadOptions(true));
      setStatus(byId('options-status'), error.message, 'error'); byId('options-status').append(' ', retry);
    }
  }
  const headers = ['Jerarquía / Producto', 'Venta neta', 'Unidades', '1–15 días', '16–30 días', '31–60 días', '61–90 días', 'Sin antecedente ≤90 d', 'Sin vínculo identificable'];
  function appendRow(parent, row, total = false) {
    const tr = el('tr'); if (total) tr.className = 'product-recurrence-total';
    const title = el('th', row.label); title.scope = 'row'; tr.append(title, el('td', money(row.netSales)), el('td', count(row.units)));
    for (const metric of [...[15, 30, 60, 90].map(days => row.windows[days]), row.withoutRecent, row.unclassified]) {
      const cell = el('td'); cell.append(el('strong', percent(metric.percent)), el('small', money(metric.netSales))); tr.append(cell);
    }
    parent.append(tr);
  }
  function render(data) {
    const root = byId('results'); root.replaceChildren();
    const kpis = el('div', undefined, 'recurrence-kpis product-recurrence-kpis');
    for (const [title, value, note] of [
      ['Venta neta', money(data.totals.netSales), 'Total de la selección'], ['Unidades vendidas', count(data.totals.units), 'Total de la selección'],
      ['Venta recurrente ≤90 días', percent(data.totals.recurring.percent), money(data.totals.recurring.netSales)],
      ['Sin vínculo identificable', percent(data.totals.unclassified.percent), money(data.totals.unclassified.netSales)]
    ]) { const card = el('article', undefined, 'recurrence-kpi'); card.append(el('h4', title), el('strong', value), el('p', note)); kpis.append(card); }
    root.append(kpis);
    const wrap = el('div', undefined, 'recurrence-scroll'), table = el('table', undefined, 'sales-dashboard-table recurrence-table product-recurrence-table');
    const head = table.createTHead().insertRow(); headers.forEach(title => { const cell = el('th', title); cell.scope = 'col'; head.append(cell); });
    const body = table.createTBody(); data.rows.forEach(row => appendRow(body, row));
    if (!data.rows.length) { const cell = body.insertRow().insertCell(); cell.colSpan = headers.length; cell.className = 'empty-state'; cell.textContent = 'No hay ventas para los filtros seleccionados.'; }
    appendRow(table.createTFoot(), data.totals, true); wrap.append(table); root.append(wrap);
    root.append(el('p', data.denominator, 'panel-description'));
    const notes = el('details', undefined, 'recurrence-notices'); notes.append(el('summary', 'Alcance y calidad del reporte'), el('p', data.monetaryBasis), el('p', data.definition));
    for (const [label, coverage] of [['Ventas', data.coverage.sales], ['Historial MP de 90 días', data.coverage.history], ['Detalle de pagos', data.coverage.payments]]) notes.append(el('p', `${label}: ${coverage.coveredDays} de ${coverage.expectedDays} días con cobertura acreditada.`));
    data.warnings.forEach(warning => notes.append(el('p', warning))); root.append(notes);
    byId('context').textContent = `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · ${data.filters.groupBy === 'product' ? 'Por producto' : `Jerarquías, nivel ${data.filters.level}`}${data.filters.groupFormats ? ' · Formatos CL, GR y XTR agrupados' : ''} · Corte de ventas ${data.asOf.replace('T', ' ')} · Corte de identidad ${data.identityAsOf.replace('T', ' ')}`;
  }
  byId('filters').addEventListener('submit', async event => {
    event.preventDefault(); dirty();
    const generation = state.generation, controller = new AbortController(); state.controller = controller;
    const query = new URLSearchParams({ location: byId('location').value, period: 'custom', dateFrom: byId('from').value, dateTo: byId('to').value,
      groupBy: byId('group').value, level: byId('level').value, hierarchy: byId('hierarchy').value, groupFormats: String(byId('formats').checked),
      products: JSON.stringify(byId('group').value === 'product' ? [...state.selected] : []) });
    byId('progress').hidden = false; runButton.disabled = true; byId('filters').setAttribute('aria-busy', 'true'); status('Preparando ventas y antecedentes de compra…');
    try {
      const data = await apiRequest(`/api/sales/product-recurrence?${query}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== state.generation) return;
      state.report = data; render(data); byId('export').disabled = false;
      status(data.status === 'complete' ? 'Reporte generado.' : data.status === 'partial' ? 'Reporte generado con datos provisionales. Revisa la cobertura y calidad.' : 'Sin ventas acreditadas para esta selección.', data.status === 'complete' ? 'success' : 'warning');
    } catch (error) { if (!controller.signal.aborted && generation === state.generation) status(error.message, 'error'); }
    finally { if (generation === state.generation) { byId('progress').hidden = true; runButton.disabled = false; byId('filters').setAttribute('aria-busy', 'false'); } }
  });
  byId('filters').addEventListener('change', event => {
    if (event.target === byId('period')) syncDates();
    if (event.target === byId('group')) syncGrouping();
    if (event.target === byId('formats')) { expandGroupedSelection(); renderProducts(); }
    if (event.target === byId('location')) {
      state.optionsLocation = null; state.selected.clear(); state.products = []; state.groupedProducts = [];
      byId('hierarchy').replaceChildren(new Option('Todas las jerarquías', '[]')); renderProducts(); loadOptions();
    }
    dirty();
  });
  byId('products').addEventListener('change', event => {
    if (!event.target.matches('input[type=checkbox]')) return;
    const codes = JSON.parse(event.target.dataset.codes);
    for (const code of codes) if (event.target.checked) state.selected.add(code); else state.selected.delete(code);
    updateSelectionCount(); dirty();
  });
  byId('search').addEventListener('input', renderProducts);
  byId('clear').addEventListener('click', () => { state.selected.clear(); renderProducts(); dirty(); });
  byId('export').addEventListener('click', () => {
    const data = state.report; if (!data) return;
    const book = XLSX.utils.book_new();
    const exportHeaders = ['Jerarquía / Producto', 'Venta neta', 'Unidades', ...['1–15 días', '16–30 días', '31–60 días', '61–90 días', 'Sin antecedente ≤90 d', 'Sin vínculo identificable'].flatMap(title => [`${title} ($)`, `${title} (%)`])];
    const exportRow = row => [row.label, row.netSales, row.units, ...[...[15, 30, 60, 90].map(days => row.windows[days]), row.withoutRecent, row.unclassified].flatMap(m => [m.netSales, m.percent == null ? null : Number(m.percent.toFixed(1))])];
    const sheet = XLSX.utils.aoa_to_sheet([exportHeaders, ...data.rows.map(exportRow), exportRow(data.totals)]);
    for (let row = 1; row <= data.rows.length + 1; row++) for (let column = 4; column < exportHeaders.length; column += 2) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell?.t === 'n') cell.z = '0.0"%"';
    }
    XLSX.utils.book_append_sheet(book, sheet, 'Producto-Recurrencia');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['Cafetería', data.scope.label], ['Desde', data.period.from], ['Hasta', data.period.to], ['Corte ventas', data.asOf], ['Corte identidad', data.identityAsOf],
      ['Filtros', JSON.stringify(data.filters)], ['Definición', data.definition], ['Base', data.denominator], ['Importes', data.monetaryBasis],
      ['Estado', data.status], ['Versión', data.definitionVersion], ['Identidad', data.identityDefinitionVersion], ['Versiones de fuentes', JSON.stringify(data.sourceVersions)],
      ['Cobertura', JSON.stringify(data.coverage)], ...data.warnings.map(warning => ['Observación', warning])
    ]), 'Consulta y criterios');
    XLSX.writeFile(book, `Producto-Recurrencia_${data.period.from}_${data.period.to}.xlsx`);
  });
  window.openProductRecurrence = () => loadOptions();
  syncDates(); syncGrouping(); renderProducts();
})();
