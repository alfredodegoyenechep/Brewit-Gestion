/* Shared controls and presentation for independent time series and weekday averages. */
window.initializeProductTimeline = config => {
  const weekdayReport = config.weekday === true;
  const $ = id => document.getElementById(`${config.prefix}-${id}`);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const state = { today: browserIsoToday(), report: null, options: null, optionsKey: null, selectedProducts: new Set(), selectedIngredients: new Set(),
    chartSeries: new Set(['total']), controller: null, optionsController: null, optionsRequest: null, optionsTimer: null, optionsNotice: '', hierarchyUnavailable: false, generation: 0 };
  const number = value => value == null ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(value);
  const money = value => value == null ? '—' : formatClp(value);
  const date = value => new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  const label = point => weekdayReport ? point.label : point.from === point.to ? date(point.from) : `${date(point.from)} – ${date(point.to)}`;
  const status = (message, type = 'muted') => setStatus($('status'), message, type);
  const metric = () => $('metric').value;
  const format = value => metric() === 'netSales' ? money(value) : number(value);
  function syncDates() {
    const mode = $('period').value, today = state.today;
    for (const name of ['from', 'to']) { $(name).disabled = mode !== 'custom'; $(name).max = today; }
    if (mode === 'custom') return;
    let from = today, to = today;
    if (mode === 'last-30-days') { to = offsetIsoDate(today, -1); from = offsetIsoDate(to, -29); }
    if (mode === 'current-week') from = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (mode === 'current-month') from = `${today.slice(0, 7)}-01`;
    $('from').value = from; $('to').value = to;
  }
  function baseQuery() { return new URLSearchParams({ location: $('location').value, period: $('period').value, dateFrom: $('from').value, dateTo: $('to').value }); }
  function busy(value) { $('run').disabled = value; $('cancel').hidden = !value; $('progress').hidden = !value; $('filters').setAttribute('aria-busy', String(value)); }
  function dirty(message) {
    state.generation++; state.controller?.abort(); state.controller = null; busy(false);
    status(message || (state.report ? 'Cambiaste los filtros. Pulsa Generar reporte para actualizar los resultados.' : 'Selecciona los filtros y pulsa Generar reporte.'));
  }
  const choices = () => $('mode').value === 'ingredients' ? state.options?.ingredients || []
    : $('formats').checked ? state.options?.groupedProducts || [] : (state.options?.products || []).map(item => ({ ...item, codes: [item.code] }));
  const selectedSet = () => $('mode').value === 'ingredients' ? state.selectedIngredients : state.selectedProducts;
  function renderChoices() {
    const selected = selectedSet(), normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const search = normalize($('search').value), options = choices();
    $('choices').replaceChildren(...options.filter(item => normalize(`${item.name} ${(item.codes || [item.code]).join(' ')}`).includes(search)).map(item => {
      const codes = item.codes || [item.code], node = el('label'), input = el('input'); input.type = 'checkbox'; input.value = item.code; input.dataset.codes = JSON.stringify(codes);
      input.checked = codes.every(code => selected.has(code)); input.indeterminate = !input.checked && codes.some(code => selected.has(code));
      const caption = item.formats?.length ? `${item.name} (${item.formats.join(', ')})` : `${item.name} · ${item.code}`;
      node.title = `${item.name} · ${codes.join(' / ')}`; node.append(input, el('span', caption)); return node;
    }));
    if (!$('choices').children.length) $('choices').append(el('p', state.options ? 'No hay coincidencias.' : 'Cargando opciones…', 'panel-description'));
    $('selection-count').textContent = `${options.filter(item => (item.codes || [item.code]).some(code => selected.has(code))).length} seleccionados`;
  }
  function syncMode() {
    const mode = $('mode').value, hierarchy = mode.endsWith('hierarchy');
    $('picker').hidden = !['products', 'ingredients'].includes(mode); $('hierarchy-field').hidden = !hierarchy;
    $('picker-title').textContent = mode === 'ingredients' ? 'Ingredientes de las recetas' : 'Productos';
    const previous = $('hierarchy').value;
    const options = mode === 'ingredient-hierarchy' ? state.options?.ingredientHierarchies || [] : state.options?.productHierarchies || [];
    $('hierarchy').replaceChildren(new Option(mode === 'ingredient-hierarchy' ? 'Selecciona una jerarquía' : 'Todas las jerarquías', '[]'), ...options.map(item => new Option(item.label, JSON.stringify(item.path))));
    if ([...$('hierarchy').options].some(item => item.value === previous)) $('hierarchy').value = previous;
    else if (previous !== '[]' && hierarchy) {
      state.hierarchyUnavailable = true;
      const placeholder = new Option('Selecciona una jerarquía disponible', '', true, true); placeholder.disabled = true;
      $('hierarchy').prepend(placeholder); $('hierarchy').value = '';
    }
    renderChoices();
  }
  function optionsStatus(message, type = 'muted') {
    setStatus($('options-status'), message, type); $('options-status').hidden = !message;
  }
  function optionsBusy(value) { $('picker').disabled = value; $('hierarchy').disabled = value; }
  function expandFormats() {
    if ($('formats').checked) for (const group of state.options?.groupedProducts || []) {
      if (group.codes.some(code => state.selectedProducts.has(code))) group.codes.forEach(code => state.selectedProducts.add(code));
    }
  }
  function loadOptions() {
    const query = baseQuery(), key = query.toString();
    if (state.optionsKey === key) { state.optionsController?.abort(); optionsBusy(false); optionsStatus(state.optionsNotice); return Promise.resolve(true); }
    if (state.optionsRequest?.key === key && !state.optionsController?.signal.aborted) return state.optionsRequest.promise;
    state.optionsController?.abort(); const controller = new AbortController(); state.optionsController = controller;
    optionsBusy(true); optionsStatus('Actualizando opciones…');
    const promise = (async () => { try {
      const response = await fetch(`${config.endpoint}/options?${query}`, { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'No se pudieron cargar las opciones.');
      if (controller.signal.aborted || key !== baseQuery().toString()) return false;
      state.options = data; state.today = data.today; syncDates(); state.optionsKey = baseQuery().toString();
      const selectedLocation = $('location').value;
      $('location').replaceChildren(new Option('Todas las cafeterías', 'all'), ...data.locations.map(item => new Option(item.name, item.id)));
      $('location').value = selectedLocation;
      let removed = 0;
      for (const [selected, available] of [[state.selectedProducts, data.products], [state.selectedIngredients, data.ingredients]]) {
        const valid = new Set(available.map(item => item.code));
        for (const code of selected) if (!valid.has(code)) { selected.delete(code); removed++; }
      }
      expandFormats(); syncMode();
      state.optionsNotice = state.hierarchyUnavailable ? 'La jerarquía seleccionada no está disponible en este período. Elige otra.'
        : removed ? 'Se quitaron selecciones que no están disponibles con estos filtros. Revisa la lista antes de generar.' : '';
      optionsStatus(state.optionsNotice);
      return true;
    } catch (error) {
      if (!controller.signal.aborted) optionsStatus(`${error.message} Pulsa Generar reporte para reintentar.`, 'error');
      return false;
    } finally { if (state.optionsController === controller) { state.optionsController = null; state.optionsRequest = null; optionsBusy(state.optionsKey !== baseQuery().toString()); } }
    })();
    state.optionsRequest = { key, promise }; return promise;
  }
  function queueOptions() {
    clearTimeout(state.optionsTimer);
    const key = baseQuery().toString();
    if (state.optionsKey === key || state.optionsRequest?.key === key && !state.optionsController?.signal.aborted) { loadOptions(); return; }
    state.optionsController?.abort(); optionsBusy(true);
    if (!$('from').value || !$('to').value || $('from').value > $('to').value) {
      optionsStatus('Completa un rango de fechas válido para cargar las opciones.'); return;
    }
    optionsStatus('Actualizando opciones…');
    state.optionsTimer = setTimeout(() => { state.optionsTimer = null; loadOptions(); }, 250);
  }
  function renderTable() {
    const data = state.report, value = metric(), table = $('table'); table.replaceChildren();
    const caption = table.createCaption(); caption.textContent = weekdayReport
      ? value === 'units' ? 'Promedio diario de unidades vendidas' : 'Promedio diario de venta neta ($)'
      : value === 'units' ? 'Evolución de unidades vendidas' : 'Evolución de venta neta ($)';
    const head = table.createTHead().insertRow();
    for (const text of [weekdayReport ? 'Día de la semana' : 'Período', ...(weekdayReport ? ['Días con venta', 'Días sin venta excluidos'] : []), ...data.series.map(item => `${item.label} · ${item.codes.join(' / ')}`), weekdayReport ? 'Promedio selección' : 'Total selección']) { const cell = el('th', text); cell.scope = 'col'; head.append(cell); }
    const body = table.createTBody();
    data.periods.forEach((point, index) => {
      const row = body.insertRow(), heading = el('th', label(point)); heading.scope = 'row'; row.append(heading);
      if (weekdayReport) row.append(el('td', number(point.observedDays)), el('td', number(point.excludedDays)));
      for (const item of data.series) row.append(el('td', format(item.points[index][value])));
      row.append(el('td', format(point[value]), 'product-timeline-total'));
    });
    const foot = table.createTFoot().insertRow(), heading = el('th', weekdayReport ? 'Promedio diario del período' : 'Total del período'); heading.scope = 'row'; foot.append(heading);
    if (weekdayReport) foot.append(el('td', number(data.sample.observedDays)), el('td', number(data.sample.excludedDays)));
    for (const item of data.series) foot.append(el('td', format(item[value])));
    foot.append(el('td', format(data.totals[value])));
  }
  const colors = ['#a85d37', '#397a8d', '#688943', '#a34f78', '#6c62ac', '#9b791e', '#29856e', '#b34d4d', '#4d72ab', '#8d6c4e', '#895989', '#527b69'];
  const graphChoices = () => [{ key: 'total', label: weekdayReport ? 'Promedio de la selección' : 'Total selección', points: state.report.periods }, ...state.report.series];
  function renderSeriesPicker() {
    $('series').replaceChildren(...graphChoices().map(item => {
      const node = el('label'), input = el('input'); input.type = 'checkbox'; input.value = item.key; input.checked = state.chartSeries.has(item.key);
      node.append(input, el('span', item.label)); return node;
    }));
  }
  function renderChart() {
    const data = state.report, selected = graphChoices().filter(item => state.chartSeries.has(item.key)), value = metric();
    $('chart').replaceChildren(); $('legend').replaceChildren();
    $('chart-status').textContent = 'Pasa sobre un punto o selecciónalo con el teclado para ver su valor.';
    if (!selected.length) { $('chart').append(el('p', 'Selecciona al menos una serie para graficar.', 'panel-description')); return; }
    const values = selected.flatMap(item => item.points.map(point => point[value])).filter(Number.isFinite);
    if (!values.length) { $('chart').append(el('p', weekdayReport ? 'No hay días con venta e información suficiente para calcular el promedio de esta selección.' : 'No hay importes disponibles para graficar esta selección.', 'panel-description')); return; }
    const ns = 'http://www.w3.org/2000/svg';
    const svgNode = (tag, attributes, text) => { const node = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attributes || {})) node.setAttribute(key, String(val)); if (text !== undefined) node.textContent = text; return node; };
    const titleId = `${config.prefix}-chart-title`;
    const svg = svgNode('svg', { viewBox: '0 0 1000 390', role: 'img', 'aria-labelledby': titleId });
    svg.append(svgNode('title', { id: titleId }, weekdayReport
      ? `Distribución diaria: promedio de ${value === 'units' ? 'unidades vendidas' : 'venta neta en pesos'}`
      : value === 'units' ? 'Evolución de unidades vendidas' : 'Evolución de venta neta en pesos'));
    const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    const x = i => weekdayReport ? 115 + (i + .5) / 7 * 850 : data.periods.length === 1 ? 550 : 115 + i / (data.periods.length - 1) * 850;
    const y = val => 320 - (val - min) / span * 290;
    for (let step = 0; step <= 4; step++) {
      const amount = min + span * step / 4;
      svg.append(svgNode('line', { x1: 115, y1: y(amount), x2: 965, y2: y(amount), stroke: 'var(--border)' }));
      svg.append(svgNode('text', { x: 105, y: y(amount) + 4, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 12 }, format(amount)));
    }
    const ticks = new Set(Array.from({ length: Math.min(7, data.periods.length) }, (_, i) => Math.round(i * (data.periods.length - 1) / Math.max(1, Math.min(6, data.periods.length - 1)))));
    for (const i of ticks) svg.append(svgNode('text', { x: x(i), y: 345, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 12 }, weekdayReport ? data.periods[i].label : data.periods[i].from.split('-').reverse().join('-')));
    selected.forEach((item, seriesIndex) => {
      const color = colors[seriesIndex % colors.length]; let path = '', connected = false;
      if (!weekdayReport) {
        item.points.forEach((point, i) => { const amount = point[value]; if (!Number.isFinite(amount)) { connected = false; return; } path += `${connected ? 'L' : 'M'}${x(i)},${y(amount)} `; connected = true; });
        svg.append(svgNode('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.5 }));
      }
      item.points.forEach((point, i) => {
        if (!Number.isFinite(point[value])) return;
        const caption = `${item.label}: ${label(data.periods[i])} · ${format(point[value])}${value === 'units' ? ' unidades' : ''}${weekdayReport ? ` por día · ${point.observedDays} fecha(s) con venta` : ''}`;
        const barWidth = Math.min(48, 850 / 7 * .8 / selected.length);
        const dot = weekdayReport ? svgNode('rect', { x: x(i) + (seriesIndex - selected.length / 2) * barWidth, y: Math.min(y(point[value]), y(0)), width: barWidth - 1, height: Math.max(2, Math.abs(y(point[value]) - y(0))), fill: color, tabindex: 0, 'aria-label': caption })
          : svgNode('circle', { cx: x(i), cy: y(point[value]), r: data.periods.length > 100 ? 2 : 4, fill: color, tabindex: 0, 'aria-label': caption });
        dot.append(svgNode('title', {}, caption));
        dot.addEventListener('focus', () => { $('chart-status').textContent = caption; });
        dot.addEventListener('pointerenter', () => { $('chart-status').textContent = caption; }); svg.append(dot);
        if (weekdayReport && selected.length === 1) svg.append(svgNode('text', { x: x(i), y: point[value] >= 0 ? y(point[value]) - 7 : y(point[value]) + 16, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 12 }, format(point[value])));
      });
      const legend = el('span', item.label); legend.style.setProperty('--series-color', color); $('legend').append(legend);
    });
    if (weekdayReport) data.periods.forEach((point, i) => { if (!point.observedDays) svg.append(svgNode('text', { x: x(i), y: y(0) - 7, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 11 }, 'Sin días')); });
    $('chart').append(svg);
  }
  function presentation() {
    if (!state.report) return;
    $('table-wrap').hidden = $('presentation').value === 'chart'; $('chart-panel').hidden = $('presentation').value === 'table';
    renderTable(); if (!$('chart-panel').hidden) renderChart();
  }
  async function generate(event) {
    event.preventDefault(); dirty(); const generation = state.generation, controller = new AbortController(); state.controller = controller;
    clearTimeout(state.optionsTimer); state.optionsTimer = null;
    busy(true); status('Preparando reporte…');
    try {
      const ready = await loadOptions();
      if (controller.signal.aborted || generation !== state.generation) return;
      if (!ready) throw new Error('No se pudieron actualizar las opciones. Pulsa Generar reporte para reintentar.');
      if (state.hierarchyUnavailable) throw new Error('Selecciona una jerarquía disponible para generar el reporte.');
      const query = baseQuery();
      for (const [key, val] of Object.entries({ mode: $('mode').value, ...(!weekdayReport ? { grain: $('grain').value } : {}), bar: $('bar').value, groupFormats: String($('formats').checked),
        products: JSON.stringify([...state.selectedProducts]), ingredients: JSON.stringify([...state.selectedIngredients]), hierarchy: $('hierarchy').value })) query.set(key, val);
      status(weekdayReport ? 'Calculando promedios y fechas con venta de lunes a domingo…' : 'Preparando ventas y evolución del período…');
      const response = await fetch(`${config.endpoint}?${query}`, { signal: controller.signal }), data = await response.json();
      if (!response.ok) throw new Error(data.error || 'No se pudo generar el reporte.');
      if (controller.signal.aborted || generation !== state.generation) return;
      state.report = data; state.chartSeries = new Set(['total']); $('results').hidden = false; $('export').disabled = false;
      $('context').textContent = `${data.scope.label} · ${date(data.period.from)} – ${date(data.period.to)} · ${weekdayReport ? 'Promedio por día de la semana' : `Evolución ${ { daily: 'diaria', weekly: 'semanal', monthly: 'mensual' }[data.filters.grain]}`} · ${data.filters.groupFormats ? 'Tamaños agrupados' : 'Tamaños separados'}`;
      const cards = weekdayReport ? [['Promedio diario de venta neta', money(data.totals.netSales)], ['Promedio diario de unidades', number(data.totals.units)], ['Fechas con venta', number(data.sample.observedDays)], ['Fechas sin venta excluidas', number(data.sample.excludedDays)]]
        : [['Venta neta', money(data.totals.netSales)], ['Unidades vendidas', number(data.totals.units)], ['Productos / familias', number(data.series.length)], ['Períodos', number(data.periods.length)]];
      $('summary').replaceChildren(...cards.map(([name, val]) => { const node = el('article'); node.append(el('span', name), el('strong', val)); return node; }));
      $('definition').textContent = data.definition; $('warnings').textContent = data.warnings.join(' ');
      $('chart-status').textContent = 'Pasa sobre un punto o selecciónalo con el teclado para ver su valor.';
      renderSeriesPicker(); presentation(); status(weekdayReport && !data.sample.observedDays ? 'No hay fechas con venta total registrada distinta de cero para calcular promedios.'
        : data.series.length || weekdayReport ? 'Reporte generado. Puedes alternar la medida, la tabla y el gráfico sin volver a calcular.' : 'No hay ventas registradas para esta selección en el período.', data.series.length || weekdayReport && data.sample.observedDays ? 'success' : 'muted');
    } catch (error) { if (!controller.signal.aborted && generation === state.generation) status(error.message, 'error'); }
    finally { if (generation === state.generation) { state.controller = null; busy(false); } }
  }
  function exportWorkbook() {
    if (!state.report) return;
    const data = state.report, workbook = XLSX.utils.book_new();
    for (const [value, name] of [['units', 'Unidades'], ['netSales', 'Venta neta']]) {
      const rows = weekdayReport ? [['Día de la semana', 'Días con venta', 'Días sin venta excluidos', 'Fechas con importe incompleto', ...data.series.map(item => `${item.label} · ${item.codes.join(' / ')}`), 'Promedio selección', 'Total selección en fechas válidas'],
        ...data.periods.map((point, i) => [point.label, point.observedDays, point.excludedDays, point.unknownDays, ...data.series.map(item => item.points[i][value]), point[value], point[value === 'units' ? 'totalUnits' : 'totalNetSales']]),
        ['Promedio diario del período', data.sample.observedDays, data.sample.excludedDays, data.sample.unknownDays, ...data.series.map(item => item[value]), data.totals[value], data.totals[value === 'units' ? 'totalUnits' : 'totalNetSales']]]
        : [['Período', 'Desde', 'Hasta', ...data.series.map(item => `${item.label} · ${item.codes.join(' / ')}`), 'Total selección'],
        ...data.periods.map((point, i) => [label(point), point.from, point.to, ...data.series.map(item => item.points[i][value]), point[value]]),
        ['Total del período', '', '', ...data.series.map(item => item[value]), data.totals[value]]];
      const sheet = XLSX.utils.aoa_to_sheet(rows); sheet['!cols'] = [{ wch: 38 }, { wch: 12 }, { wch: 12 }, ...data.series.map(() => ({ wch: 25 })), { wch: 20 }];
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    }
    if (weekdayReport) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Día de la semana', 'Fecha incluida en el divisor'], ...data.periods.flatMap(point => point.dates.map(date => [point.label, date]))]), 'Fechas con venta');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Criterio', 'Valor'], ['Cafetería', data.scope.label], ['Desde', data.period.from], ['Hasta', data.period.to],
      ...Object.entries(data.filters).map(([name, val]) => [name, Array.isArray(val) ? val.join(' / ') : String(val)]), ['Definición', data.definition], ['Observaciones', data.warnings.join(' ')], ['Versión', data.definitionVersion]]), 'Consulta y criterios');
    XLSX.writeFile(workbook, `${weekdayReport ? 'distribucion-diaria' : 'productos-en-el-tiempo'}-${data.period.from}-${data.period.to}.xlsx`);
  }
  $('filters').addEventListener('submit', generate);
  $('filters').addEventListener('change', event => {
    if ($('picker').contains(event.target)) return;
    if (event.target === $('period')) syncDates();
    if (event.target === $('mode') || event.target === $('hierarchy')) {
      if (state.hierarchyUnavailable) { state.optionsNotice = ''; optionsStatus(''); }
      state.hierarchyUnavailable = false;
    }
    if (event.target === $('mode')) { $('search').value = ''; $('hierarchy').value = '[]'; syncMode(); }
    if (event.target === $('formats')) {
      expandFormats(); renderChoices();
    }
    dirty();
    if (['location', 'period', 'from', 'to'].some(id => event.target === $(id))) {
      queueOptions();
    }
  });
  $('filters').addEventListener('input', event => { if (event.target === $('from') || event.target === $('to')) { dirty(); queueOptions(); } });
  $('choices').addEventListener('change', event => { if (!event.target.matches('input[type=checkbox]')) return; const selected = selectedSet(); for (const code of JSON.parse(event.target.dataset.codes)) { if (event.target.checked) selected.add(code); else selected.delete(code); } renderChoices(); dirty(); });
  $('search').addEventListener('input', renderChoices);
  $('clear').addEventListener('click', () => { selectedSet().clear(); renderChoices(); dirty(); });
  $('metric').addEventListener('change', presentation); $('presentation').addEventListener('change', presentation);
  $('series').addEventListener('change', event => {
    if (!event.target.matches('input')) return;
    if (event.target.checked && state.chartSeries.size >= 12) { event.target.checked = false; $('chart-status').textContent = 'Selecciona hasta 12 series para mantener legible el gráfico.'; return; }
    if (event.target.checked) state.chartSeries.add(event.target.value); else state.chartSeries.delete(event.target.value); renderChart();
  });
  $('cancel').addEventListener('click', () => dirty('Generación cancelada. Puedes ajustar los filtros y volver a generar.'));
  $('export').addEventListener('click', exportWorkbook);
  window[config.openHandler] = () => { syncDates(); loadOptions(); };
  window[config.cancelHandler] = () => { if (state.controller) dirty('Generación cancelada al salir del reporte.'); clearTimeout(state.optionsTimer); state.optionsTimer = null; state.optionsController?.abort(); };
  syncDates(); syncMode();
};
window.initializeProductTimeline({ prefix: 'product-timeline', endpoint: '/api/sales/product-timeline', openHandler: 'openProductTimeline', cancelHandler: 'cancelProductTimeline' });
window.initializeProductTimeline({ prefix: 'daily-distribution', endpoint: '/api/sales/daily-distribution', openHandler: 'openDailyDistribution', cancelHandler: 'cancelDailyDistribution', weekday: true });
