/* Recurrence UI: generation is explicit, navigation only exposes prepared data. */
(() => {
  const byId = id => document.getElementById(id);
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = text; if (className) node.className = className; return node; };
  const count = n => n === null || n === undefined ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(n);
  const percent = n => n === null || n === undefined ? '—' : `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)}%`;
  const money = n => n === null || n === undefined ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
  const date = d => d ? formatReportDate(d) : 'Sin fecha acreditada';
  const stateName = { complete: 'Completo', partial: 'Provisional', no_data: 'Sin datos', no_activity: 'Sin operaciones', immature: 'Pendiente', error: 'Error' };
  const state = { generation: 0, controller: null, report: null, returns: null, purchases: null, quality: null, monthly: null, network: null, dirty: false, detail: { page: 1, kind: 'active' }, sections: new Map(), returnTouched: false };
  const filterKey = () => JSON.stringify(['sales-customers-location', 'sales-customers-period', 'sales-customers-from', 'sales-customers-to', 'recurrence-evolution'].map(id => byId(id).value));
  const hint = (text, className = 'panel-description') => el('p', text, className);
  function table(headers, rows, className = '') {
    const wrap = el('div', null, `recurrence-scroll ${className}`), node = el('table', null, 'sales-dashboard-table recurrence-table'), head = el('thead'), tr = el('tr');
    headers.forEach(([title]) => tr.append(el('th', title))); head.append(tr); node.append(head);
    const body = el('tbody'); rows.forEach(row => { const line = el('tr'); headers.forEach(([, value]) => { const cell = el('td'); const result = value(row); if (result instanceof Node) cell.append(result); else cell.textContent = result ?? '—'; line.append(cell); }); body.append(line); });
    if (!rows.length) { const line = el('tr'), cell = el('td', 'Sin observaciones para esta consulta.', 'empty-state'); cell.colSpan = headers.length; line.append(cell); body.append(line); }
    node.append(body); wrap.append(node); return wrap;
  }
  function status(id, message, type = 'muted') { setStatus(byId(id), message, type); }
  function syncDates() {
    const custom = byId('sales-customers-period').value === 'custom';
    ['sales-customers-from', 'sales-customers-to'].forEach(id => { byId(id).disabled = !custom; });
    if (custom) return;
    const today = browserIsoToday(), mode = byId('sales-customers-period').value;
    let from = today, to = today;
    if (mode === 'last-28-days') { to = offsetIsoDate(today, -1); from = offsetIsoDate(to, -27); }
    if (mode === 'current-week') from = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (mode === 'current-month') from = `${today.slice(0, 7)}-01`;
    byId('sales-customers-from').value = from; byId('sales-customers-to').value = to;
  }
  function markDirty() {
    state.generation++; state.controller?.abort(); state.sections.forEach(c => c.abort()); state.sections.clear();
    state.dirty = true; byId('recurrence-progress').hidden = true; byId('sales-customers-filters').setAttribute('aria-busy', 'false');
    byId('sales-customers-filters').querySelector('button[type=submit]').disabled = false;
    ['recurrence-purchases-run', 'recurrence-quality-run', 'recurrence-return-run', 'recurrence-monthly-run', 'recurrence-network-run'].forEach(id => { byId(id).disabled = !state.report || state.dirty; });
    status('sales-customers-status', state.report ? 'Los filtros cambiaron. El resultado visible conserva su consulta anterior; pulsa Generar reportes para aplicar la selección.' : 'Selecciona los filtros y pulsa Generar reportes.');
  }
  function button(text, callback, className = 'icon-button small') { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', callback); return node; }
  function metricCard(title, value, note, metric, detailKind) {
    const card = el('article', null, 'recurrence-kpi'); card.append(el('h4', title), el('strong', value), el('p', note));
    card.append(el('span', stateName[metric.status] || 'Provisional', `recurrence-status ${metric.status}`));
    const info = el('details'), summary = el('summary', 'Cómo se calcula'); info.append(summary,
      hint(metric.population), hint(`${date(metric.periodStart)} – ${date(metric.periodEnd)} · Corte ${date(metric.asOf?.slice(0, 10))}`));
    if (metric.numerator !== undefined) info.append(hint(`Numerador: ${count(metric.numerator)} · Denominador: ${count(metric.denominator)}`));
    if (metric.reason) info.append(hint(metric.reason)); card.append(info);
    if (detailKind) card.append(button('Ver detalle', () => showDetails(detailKind))); return card;
  }
  function distribution(title, data, footer) {
    const panel = el('section', null, 'recurrence-subpanel'); panel.append(el('h4', title), hint(`${date(data.period.from)} – ${date(data.period.to)} · ${stateName[data.status]}`));
    for (const row of data.rows) {
      const line = el('div', null, 'recurrence-distribution-row'), track = el('div', null, 'recurrence-track'), fill = el('span'); fill.style.width = `${row.percent || 0}%`; track.append(fill);
      line.append(el('span', row.label), track, el('strong', `${count(row.instruments)} · ${percent(row.percent)}`)); panel.append(line);
    }
    if (!data.coverage.complete) panel.append(hint(`Historial insuficiente para ${data.coverage.expectedDays} días: ${data.coverage.coveredDays} días con cobertura acreditada. Distribución provisional, sin comparación.`));
    panel.append(hint(footer)); return panel;
  }
  function renderSummary(report) {
    const root = byId('recurrence-summary'); root.replaceChildren();
    const s = report.summary, kpis = el('div', null, 'recurrence-kpis');
    kpis.append(metricCard('Instrumentos activos', count(s.active.value), `${count(s.firstObserved)} de primera observación · ${count(s.knownBefore)} ya observados`, s.active, 'active'),
      metricCard('Activos con regreso observado', percent(s.returning.value), `${count(s.returning.numerator)} de ${count(s.returning.denominator)} instrumentos · compras en fechas distintas`, s.returning),
      metricCard('Importe de compras de regreso', percent(s.returnAmountRate.value), `${money(s.returnAmount)} / ${money(s.identifiedAmount)} identificados · importe MP observado`, s.returnAmountRate, 'return'),
      metricCard('Volvieron en 30 días', percent(report.return30.value), report.return30.denominator ? `${count(report.return30.numerator)} de ${count(report.return30.denominator)} con seguimiento completo` : report.return30.reason, report.return30));
    root.append(kpis);
    if (s.comparison.available) root.append(hint(`Comparación ${date(s.comparison.period.from)} – ${date(s.comparison.period.to)}: instrumentos ${s.comparison.activeDelta >= 0 ? '+' : ''}${count(s.comparison.activeDelta)}; importe de regreso ${count(s.comparison.returnAmountPoints)} puntos porcentuales.`));
    else root.append(hint(s.comparison.reason));
    const trend = el('section', null, 'recurrence-subpanel');
    const mode = state.evolution, rows = mode === 'months6' ? report.trend.months : mode === 'weeks12' ? report.trend.weeks : report.trend.weeks.slice(-8);
    trend.append(el('h4', `Días con compra: primera fecha y regreso · ${mode === 'months6' ? '6 meses' : mode === 'weeks12' ? '12 semanas' : '8 semanas'}`),
      hint('La evolución tiene su propia ventana. Las fechas sin cobertura no representan cero compras.'));
    const label = el('label', 'Mostrar '), select = el('select'); select.append(new Option('Cantidad', 'quantity'), new Option('Porcentaje', 'percent')); select.value = 'percent'; label.append(select); trend.append(label);
    const chart = el('div', null, 'recurrence-trend'); trend.append(chart);
    function paint() {
      chart.replaceChildren(); const max = Math.max(1, ...rows.map(r => r.days));
      rows.forEach(row => { const line = el('div', null, 'recurrence-trend-row'), title = `${date(row.period.from)} – ${date(row.period.to)}`;
        const track = el('div', null, `recurrence-stacked ${row.status}`); track.title = `${title}: primera fecha ${row.firstDays}; regreso ${row.returnDays}; identificados ${row.days}; ${stateName[row.status]}`;
        if (row.status === 'no_data') track.append(el('span', 'Sin cobertura', 'recurrence-gap'));
        else {
          const first = el('span', null, 'recurrence-first'), returning = el('span', null, 'recurrence-return');
          const denominator = select.value === 'percent' ? row.days || 1 : max;
          first.style.width = `${row.firstDays / denominator * 100}%`; returning.style.width = `${row.returnDays / denominator * 100}%`;
          track.append(first, returning);
        }
        line.append(el('span', title), track, el('span', row.status === 'no_data' ? 'Sin datos' : select.value === 'percent' ? percent(row.returnDaysRate.value) : `${row.firstDays} + ${row.returnDays}${row.status === 'partial' ? ' · Provisional' : ''}`)); chart.append(line);
      });
    }
    select.addEventListener('change', paint); paint();
    trend.append(hint('■ Primera fecha observada · ■ Regreso en otra fecha. El volumen de períodos parciales no es comparable con períodos completos.'));
    const details = el('details'), summary = el('summary', 'Ver tabla y denominadores de la evolución'); details.append(summary, table([
      ['Desde', r => date(r.period.from)], ['Hasta', r => date(r.period.to)], ['Primera fecha', r => r.status === 'no_data' ? '—' : r.firstDays], ['Regreso', r => r.status === 'no_data' ? '—' : r.returnDays], ['Base identificada', r => r.status === 'no_data' ? '—' : r.days], ['% días de regreso', r => percent(r.returnDaysRate.value)], ['Estado', r => stateName[r.status]]
    ], rows)); trend.append(details); root.append(trend);
    const distributions = el('div', null, 'recurrence-distributions'); distributions.append(distribution('Días con compra durante 28 días completos', report.frequency,
      `${count(report.frequency.active)} instrumentos activos · ${count(report.frequency.average)} días por instrumento · ${count(report.frequency.knownBefore)} observados antes de la ventana.`),
      distribution('Tiempo desde la última compra observada', report.recency, `${report.recency.population} · ${count(report.recency.total)} instrumentos; ${count(report.recency.older)} recurrentes de 90 días o más fuera del denominador.`)); root.append(distributions);
    root.append(hint(report.frequency.comparison.available ? `Frente a ${date(report.frequency.comparison.period.from)} – ${date(report.frequency.comparison.period.to)}: cambio de instrumentos activos ${count(report.frequency.comparison.activeDelta)}; cambio de días por instrumento ${count(report.frequency.comparison.averageDelta)}.` : report.frequency.comparison.reason));
    const detail = el('details'); detail.append(el('summary', 'Intervalos y base observada desde antes de la ventana'), hint(`${report.interval.definition} Ventana ${date(report.interval.period.from)} – ${date(report.interval.period.to)}; ${stateName[report.recency.status]}. Resultado: ${count(report.interval.value)} días · ${report.interval.instruments} instrumentos.`),
      table([['Días con compra', row => row.label], ['Instrumentos', row => row.instruments], ['Primera observación anterior a la ventana', row => row.knownBefore]], report.frequency.rows)); root.append(detail);
  }
  function renderReturns(data) {
    const root = byId('recurrence-return-content'); root.replaceChildren(hint(`Primeras observaciones ${date(data.from)} – ${date(data.to)} · Seguimiento hasta ${date(data.D)}. No exige compras posteriores para pertenecer a la cohorte.`));
    const cell = (row, horizon) => {
      const c = row.horizons[horizon], node = el('div', null, 'recurrence-cohort-cell');
      node.tabIndex = 0;
      node.title = `Elegibles: ${c.eligible}; retornaron: ${c.returned}; pendientes: ${c.pending}; excluidos por datos: ${c.excluded}. ${data.commonBase ? 'Misma base madura de 30 días.' : 'Cada horizonte tiene su propia base; las tasas pueden no ser crecientes.'}`;
      node.setAttribute('aria-label', node.title);
      node.style.setProperty('--cohort-opacity', c.value === null ? '0' : String(c.value / 100));
      node.append(el('strong', c.value === null ? c.excluded ? 'Sin cobertura' : 'Pendiente' : percent(c.value)), el('small', `${c.returned}/${c.eligible} elegibles`));
      if (c.pending) node.append(el('small', `${c.pending} pendientes de seguimiento`));
      if (c.excluded) node.append(el('small', `${c.excluded} excluidos por cobertura`));
      if (c.unverifiedPayments) node.append(el('small', 'Pagos observados: validación parcial'));
      if (c.smallBase) node.append(el('small', 'Base pequeña'));
      if (state.report.quality.coverage.length && state.report.quality.coverage.filter(cov => cov.source === 'mercadopago').sort((a, b) => a.from.localeCompare(b.from)).slice(0, 1).some(cov => row.key <= cov.from)) node.append(el('small', 'Inicio del historial: adquisición no verificable'));
      return node;
    };
    root.append(table([['Primera observación', row => row.key], ['Instrumentos', row => row.instruments], ['Volvieron en 7 días', row => cell(row, 7)], ['En 14 días', row => cell(row, 14)], ['En 30 días', row => cell(row, 30)]], data.rows));
    root.append(hint('Cada celda muestra retornados / elegibles. Ningún pendiente se trata como cero. Con la misma base madura se cumple R7 ≤ R14 ≤ R30.'));
  }
  function renderQuality(data) {
    const root = byId('recurrence-quality-content'); root.replaceChildren();
    root.append(hint(`${data.monetaryBasis} La precisión de la identidad y del emparejamiento es limitada; cobertura no equivale a exactitud de identidad.`));
    root.append(table([['Medida', r => r.label], ['Numerador', r => count(r.metric.numerator)], ['Denominador', r => count(r.metric.denominator)], ['Porcentaje', r => percent(r.metric.value)], ['Estado', r => stateName[r.metric.status]]], [
      { label: 'Pagos identificables / pagos observados', metric: data.identificationPayments }, { label: 'Importe identificable / importe MP observado', metric: data.identificationAmount }
    ]));
    const coverageRows = state.report.scope.locations.flatMap(location => ['mercadopago', 'sales', 'payment-details'].map(source => {
      const segments = data.coverage.filter(c => c.locationId === location.id && c.source === source);
      return { location: location.name, source, from: segments.map(c => c.from).sort()[0], to: segments.map(c => c.to).sort().at(-1), checked: segments.map(c => c.checkedAt).filter(Boolean).sort().at(-1), evidence: segments.map(c => c.evidenceId).join(' · ') };
    }));
    root.append(el('h4', 'Cobertura acreditada por local y fuente'), table([['Cafetería', r => r.location], ['Fuente', r => r.source], ['Desde', r => date(r.from)], ['Hasta', r => date(r.to)], ['Última evidencia', r => r.checked ? new Date(r.checked).toLocaleString('es-CL') : 'Sin evidencia acreditada']], coverageRows));
    const gaps = state.report.summary.coverage.locations.map(c => ({ location: state.report.scope.locations.find(l => l.id === c.locationId)?.name || c.locationId, covered: `${c.coveredDays}/${c.expectedDays}`, missing: c.missing.join(', ') || 'Sin huecos en el período' }));
    root.append(table([['Cafetería', r => r.location], ['Días cubiertos del período', r => r.covered], ['Fechas sin evidencia', r => r.missing]], gaps));
    if (data.purchases) {
      root.append(el('h4', 'Pedidos Toteat y calidad del vínculo'), table([['Medida', r => r.label], ['Valor', r => r.value]], [
        { label: 'Pedidos válidos observados', value: count(data.purchases.orders) }, { label: 'Con vínculo confiable', value: count(data.purchases.linked) }, { label: 'Clasificables', value: count(data.purchases.classifiable) },
        { label: 'Cobertura de pedidos clasificables', value: percent(data.purchases.orderCoveragePercent) }, { label: 'Venta neta analizable / observada', value: `${money(data.purchases.classifiedSales)} / ${money(data.purchases.netSales)}` }, { label: 'Cobertura de venta analizable', value: percent(data.purchases.salesCoveragePercent) }
      ]), hint(data.purchaseBasis || ''), table([['Motivo no clasificable', r => r.reason], ['Pedidos', r => r.orders], ['Venta neta', r => money(r.netSales)]], data.unclassified || []));
    } else root.append(hint('La calidad de los vínculos Toteat aún no está preparada. Pulsa Preparar calidad de vínculos; el Resumen de MercadoPago permanece independiente.'));
    if (data.purchaseCoverage) for (const cov of [data.purchaseCoverage, data.paymentCoverage].filter(Boolean)) root.append(hint(`${cov.source}: ${cov.coveredDays}/${cov.expectedDays} días acreditados para Compras.`), table([['Cafetería', r => state.report.scope.locations.find(l => l.id === r.locationId)?.name || r.locationId], ['Fechas sin evidencia', r => r.missing.join(', ') || 'Sin huecos']], cov.locations));
    const diagnostics = data.diagnostics || {}, detail = el('details'); detail.append(el('summary', 'Mapeo de campos, revisiones y exclusiones'),
      table([['Campo', r => r[0]], ['Regla', r => r[1]]], Object.entries(state.report.fieldMapping)),
      hint(`Filas ${count(diagnostics.rows)} · duplicadas ${count(diagnostics.duplicates)} · revisiones ${count(diagnostics.revised)} · ajustes sin vínculo ${count(diagnostics.unknownRefunds)}. Estado de devoluciones: ${data.refunds === 'verified-fields' ? 'Campos explícitos' : 'No acreditado para toda la fuente'}.`),
      table([['Motivo de exclusión', r => r[0]], ['Registros', r => r[1]]], Object.entries(diagnostics.excluded || {})),
      hint(`Metodología ${state.report.definitionVersion} · identidad ${state.report.keyVersion} · versión de datos ${state.report.dataVersion}.`)); root.append(detail);
  }
  function renderPurchases(data) {
    const root = byId('recurrence-purchases-content'); root.replaceChildren(hint(`${date(data.period.from)} – ${date(data.period.to)} · ${stateName[data.status]} · ${data.monetaryBasis}`));
    for (const row of data.rows) {
      const block = el('section', null, 'recurrence-subpanel'); block.append(el('h4', row.label),
        table([['Pedidos', r => count(r.orders)], ['Venta neta sin IVA', r => money(r.netSales)], ['Ticket mediano con IVA', r => money(r.medianTicketGross)], ['Unidades por pedido', r => count(r.unitsPerOrder)]], [row]),
        table([['Categoría', r => r.name], ['Penetración en pedidos', r => percent(r.penetrationPercent)], ['Unidades / 100 pedidos', r => count(r.unitsPer100Orders)]], row.mix.categories),
        table([['Productos principales', r => r.name], ['Pedidos que lo incluyen', r => percent(r.penetrationPercent)], ['Unidades', r => count(r.units)]], row.mix.products),
        hint(`${row.unknownMode} pedidos sin modalidad utilizable; ${row.takeaway} clasificados para llevar. Penetraciones de categorías pueden sumar más de 100%.`)); root.append(block);
    }
    root.append(button('Ver pedidos y motivos de clasificación', () => showDetails('purchases')));
  }
  const historyColors = ['#3d8264', '#906337', '#3a74a0', '#865694'];
  function historyMetric(cell) {
    const node = el('div', null, 'recurrence-history-value');
    node.append(el('strong', percent(cell.value)), el('small', `${money(cell.numerator)} / ${money(cell.denominator)}`), el('small', stateName[cell.status]));
    node.title = `${cell.population}. Historial ${date(cell.historyFrom)} – ${date(cell.historyTo)}: ${cell.coveredDays}/${cell.expectedDays} días acreditados. ${cell.reason || ''}`;
    return node;
  }
  function historyTable(rows) {
    return table([['Mes / período', row => row.month ? `${row.month}${row.partialMonth ? ' · hasta el corte' : ''}` : `${date(row.from)} – ${date(row.to)}`],
      ...[30, 60, 90, 180].map(h => [`Compra previa ≤ ${h} días`, row => historyMetric(row.windows[h])])], rows);
  }
  function historyChart(data) {
    const root = el('section', null, 'recurrence-subpanel'), label = el('label', 'Mostrar ventanas '), select = el('select');
    select.append(new Option('30, 60, 90 y 180 días', 'all'), ...data.windows.map(h => new Option(`${h} días`, String(h)))); label.append(select);
    root.append(el('h4', 'Participación mensual del importe MP total'), label);
    const legend = el('div', null, 'recurrence-history-legend'); data.windows.forEach((h, i) => { const item = el('span', `${h} días`); item.style.color = historyColors[i]; legend.append(item); }); root.append(legend);
    const host = el('div', null, 'recurrence-history-chart'); root.append(host);
    const svgNode = (tag, attributes = {}, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attributes).forEach(([k, v]) => n.setAttribute(k, v)); if (text !== undefined) n.textContent = text; return n; };
    function paint() {
      const svg = svgNode('svg', { viewBox: '0 0 820 300', role: 'img', 'aria-label': 'Evolución mensual de porcentajes por ventana de compra previa. Cifras y estados en la tabla siguiente.' });
      svg.append(svgNode('title', {}, 'Porcentaje del importe MP con compras en fechas anteriores'));
      const maximum = Math.max(0, ...data.rows.flatMap(row => data.windows.map(h => row.windows[h].value || 0)));
      const ceiling = [10, 20, 40, 60, 80, 100].find(limit => limit >= maximum) || 100;
      const x = i => 48 + i * 67, y = value => 235 - value / ceiling * 200;
      for (const tick of [0, ceiling / 4, ceiling / 2, ceiling * .75, ceiling]) svg.append(svgNode('line', { x1: 48, y1: y(tick), x2: 790, y2: y(tick), stroke: 'currentColor', opacity: '.15' }), svgNode('text', { x: 40, y: y(tick) + 4, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 11 }, percent(tick)));
      data.rows.forEach((row, i) => svg.append(svgNode('text', { x: x(i), y: 260, transform: `rotate(-30 ${x(i)} 260)`, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 11 }, row.month)));
      data.windows.forEach((h, colorIndex) => {
        if (select.value !== 'all' && select.value !== String(h)) return;
        let previous = null;
        data.rows.forEach((row, i) => {
          const cell = row.windows[h]; if (cell.value === null) { previous = null; return; }
          const point = { x: x(i), y: y(cell.value) };
          if (previous) svg.append(svgNode('line', { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y, stroke: historyColors[colorIndex], 'stroke-width': 2, 'stroke-dasharray': cell.status === 'partial' || previous.partial ? '5 4' : colorIndex === 1 ? '8 2' : colorIndex === 2 ? '2 2' : colorIndex === 3 ? '8 2 2 2' : 'none' }));
          const dot = svgNode('circle', { cx: point.x, cy: point.y, r: 3 + colorIndex * .6, stroke: historyColors[colorIndex], fill: cell.status === 'partial' ? 'var(--panel)' : historyColors[colorIndex], 'stroke-width': 2 });
          dot.append(svgNode('title', {}, `${row.month} · ${h} días: ${percent(cell.value)} · ${money(cell.numerator)} / ${money(cell.denominator)} · ${stateName[cell.status]}`)); svg.append(dot);
          previous = { ...point, partial: cell.status === 'partial' };
        });
      });
      host.replaceChildren(svg);
    }
    select.addEventListener('change', paint); paint();
    root.append(hint('Líneas discontinuas y puntos huecos: datos provisionales. Los meses sin base aparecen como huecos. Las ventanas se superponen y no se suman.'));
    return root;
  }
  function renderHistory(kind, data) {
    const root = byId(`recurrence-${kind}-content`); root.replaceChildren(hint(`${date(data.period.from)} – ${date(data.period.to)} · Corte ${data.asOf.replace('T', ' ')}. Ventana propia de 12 meses, independiente del inicio del período principal.`),
      hint(`${data.definition} Base: importe MP total del destino, incluidos los pagos no identificables. ${data.monetaryBasis}`));
    if (data.warnings.length) { const notes = el('details'); notes.append(el('summary', 'Cobertura e identificación de este reporte'), ...data.warnings.map(w => hint(w))); root.append(notes); }
    root.append(historyChart(data), historyTable(data.rows));
    if (kind === 'network') {
      root.append(hint('El total de red cuenta cada importe de destino una sola vez si existe antecedente en otra cafetería. Un mismo pago puede aparecer en varios orígenes del desglose; esos porcentajes no se suman. La coincidencia entre cuentas es aproximada.'));
      if (data.locations.length < 2) root.append(hint('Se necesitan al menos dos cafeterías para observar cruces.'));
      if (data.destinations.length > 1) for (const destination of data.destinations) { const panel = el('details'); panel.append(el('summary', `Cobrado en ${destination.name}`), historyTable(destination.rows)); root.append(panel); }
      const block = el('section', null, 'recurrence-subpanel'), label = el('label', 'Desglosar origen por '), select = el('select');
      select.append(new Option('Los 12 meses acumulados', 'all'), ...data.rows.map(row => new Option(row.month, row.month))); label.append(select);
      const result = el('div'); block.append(el('h4', 'Dónde compró antes el instrumento'), label, result); root.append(block);
      function paint() { const rows = select.value === 'all' ? data.originTotals : data.origins.filter(row => row.month === select.value);
        result.replaceChildren(table([['Cobrado en', row => row.destination], ['Compra previa en', row => row.origin], ...data.windows.map(h => [`≤ ${h} días`, row => historyMetric(row.windows[h])])], rows)); }
      select.addEventListener('change', paint); paint();
    }
    const details = el('details'); details.append(el('summary', 'Cobertura y bases de las ventanas'), table([
      ['Mes', row => row.month], ['Ventana', row => `${row.cell.days} días`], ['Desde historial', row => date(row.cell.historyFrom)], ['Hasta', row => date(row.cell.historyTo)], ['Días acreditados', row => `${row.cell.coveredDays}/${row.cell.expectedDays}`], ['Motivo / estado', row => row.cell.reason || stateName[row.cell.status]]
    ], data.rows.flatMap(row => data.windows.map(h => ({ month: row.month, cell: row.windows[h] }))))); root.append(details);
  }
  async function generate(event) {
    event?.preventDefault(); state.controller?.abort(); state.sections.forEach(c => c.abort()); state.sections.clear();
    const controller = new AbortController(), generation = ++state.generation, key = filterKey(); state.controller = controller;
    const form = byId('sales-customers-filters'), submit = form.querySelector('button[type=submit]'); submit.disabled = true; form.setAttribute('aria-busy', 'true'); byId('recurrence-progress').hidden = false;
    status('sales-customers-status', 'Preparando pagos locales, cobertura e historial de instrumentos…');
    const params = new URLSearchParams({ location: byId('sales-customers-location').value, period: byId('sales-customers-period').value });
    if (params.get('period') === 'custom') { params.set('dateFrom', byId('sales-customers-from').value); params.set('dateTo', byId('sales-customers-to').value); }
    const evolution = byId('recurrence-evolution').value;
    try {
      const data = await apiRequest(`/api/sales/recurrence?${params}`, { signal: controller.signal });
      if (generation !== state.generation || key !== filterKey()) return;
      state.report = data; state.returns = data.returns; state.purchases = null; state.monthly = null; state.network = null; state.quality = data.quality; state.evolution = evolution; state.dirty = false;
      if (byId('sales-customers-period').value !== 'custom') { byId('sales-customers-from').value = data.period.from; byId('sales-customers-to').value = data.period.to; }
      if (!state.returnTouched) { byId('recurrence-cohort-from').value = data.cohortDefaults.from; byId('recurrence-cohort-to').value = data.cohortDefaults.to; }
      byId('recurrence-cohort-to').max = data.observationDay; byId('recurrence-cohort-from').max = data.observationDay;
      byId('sales-customers-context').textContent = `${data.scope.label} · Actividad ${date(data.period.from)} – ${date(data.period.to)} · Corte ${data.asOf.replace('T', ' ')} · Último día completo acreditado: ${date(data.lastCompleteDay)} · Generado ${new Date(data.generatedAt).toLocaleString('es-CL')}`;
      byId('recurrence-notices').hidden = !data.warnings.length; byId('recurrence-notices-title').textContent = 'Alcance, cobertura y limitaciones';
      byId('recurrence-notices-body').replaceChildren(...data.warnings.map(w => hint(w)));
      renderSummary(data); renderReturns(data.returns); renderQuality(data.quality);
      if (state.returnTouched) status('recurrence-return-status', 'El resultado de Retorno indica sus fechas de entrada. Pulsa Generar retorno para aplicar tu selección independiente.');
      for (const kind of ['monthly', 'network']) { byId(`recurrence-${kind}-content`).replaceChildren(); status(`recurrence-${kind}-status`, 'Pulsa Generar para preparar esta sección con el reporte actual.'); }
      byId('recurrence-purchases-content').replaceChildren(); status('recurrence-purchases-status', 'Pulsa Preparar Compras para vincular pedidos con este reporte.');
      ['recurrence-export', 'recurrence-purchases-run', 'recurrence-quality-run', 'recurrence-return-run', 'recurrence-monthly-run', 'recurrence-network-run'].forEach(id => { byId(id).disabled = false; });
      status('sales-customers-status', `Reporte generado. ${stateName[data.summary.status]}. Se conservan poblaciones y denominadores separados.`, data.summary.status === 'complete' ? 'success' : 'warning');
    } catch (error) { if (generation === state.generation && error.name !== 'AbortError') status('sales-customers-status', error.message, 'error'); }
    finally { if (generation === state.generation) { submit.disabled = false; byId('recurrence-progress').hidden = true; form.setAttribute('aria-busy', 'false'); } }
  }
  async function section(kind, params = {}) {
    if (!state.report || state.dirty) return status('sales-customers-status', 'Genera el reporte con los filtros actuales antes de preparar otra sección.', 'warning');
    state.sections.get(kind)?.abort(); const controller = new AbortController(), id = state.report.id, generation = state.generation; state.sections.set(kind, controller);
    const statusId = `recurrence-${kind}-status`, buttonId = `recurrence-${kind}-run`; byId(buttonId).disabled = true; status(statusId, `Preparando ${({ return: 'cohortes y seguimiento', monthly: 'evolución mensual de 12 meses', network: 'historial de la red y cruces entre cafeterías' })[kind] || 'pedidos y calidad de vínculos'}…`);
    try {
      const data = await apiRequest(`/api/sales/recurrence/${id}/${kind}?${new URLSearchParams(params)}`, { signal: controller.signal });
      if (id !== state.report?.id || generation !== state.generation || state.sections.get(kind) !== controller) return;
      if (kind === 'return') { state.returns = data; renderReturns(data); }
      else if (kind === 'purchases') { state.purchases = data; renderPurchases(data); }
      else if (kind === 'monthly' || kind === 'network') { state[kind] = data; renderHistory(kind, data); }
      else { state.quality = data; renderQuality(data); }
      status(statusId, 'Sección preparada con la misma versión del reporte.', 'success');
    } catch (error) { if (generation === state.generation && error.name !== 'AbortError') status(statusId, error.message, 'error'); }
    finally { if (generation === state.generation && state.sections.get(kind) === controller) { byId(buttonId).disabled = false; state.sections.delete(kind); } }
  }
  async function showDetails(kind, page = 1) {
    if (!state.report) return;
    const dialog = byId('recurrence-detail-dialog'), id = state.report.id; state.detail = { kind, page };
    if (!dialog.open) dialog.showModal(); byId('recurrence-detail-status').textContent = 'Preparando detalle del reporte…';
    try {
      const data = await apiRequest(`/api/sales/recurrence/${id}/details?${new URLSearchParams({ kind, page })}`);
      if (state.report?.id !== id || state.detail.kind !== kind || state.detail.page !== page) return;
      byId('recurrence-detail-status').textContent = `${data.total} registros · ${data.scope.label} · ${date(data.period.from)} – ${date(data.period.to)}`;
      byId('recurrence-detail-content').replaceChildren(table([['Alias de instrumento', r => r.alias], ['Fecha', r => date(r.date)], ['Hora', r => r.time], ['Cafetería', r => r.locationId], ['Clasificación', r => ({ first: 'Primera fecha', return: 'Regreso', unidentified: 'No identificable', unclassified: 'No clasificable' })[r.classification]],
        [kind === 'purchases' ? 'Venta neta' : 'Importe MP', r => money(kind === 'purchases' ? r.netSales : r.amount)], [kind === 'purchases' ? 'Productos / motivo' : 'Referencia de pago', r => kind === 'purchases' ? r.reason || r.products : r.sourcePaymentId]], data.rows));
      byId('recurrence-detail-page').textContent = `Página ${page} de ${Math.max(1, Math.ceil(data.total / data.pageSize))}`; byId('recurrence-detail-prev').disabled = page <= 1; byId('recurrence-detail-next').disabled = page * data.pageSize >= data.total;
    } catch (error) { byId('recurrence-detail-status').textContent = error.message; }
  }
  async function exportReport() {
    if (!state.report) return; const id = state.report.id; byId('recurrence-export').disabled = true;
    try {
      const data = await apiRequest(`/api/sales/recurrence/${id}/export?${new URLSearchParams({ cohortKey: state.returns.selectionKey })}`); const book = XLSX.utils.book_new();
      const sheet = (name, rows) => XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Estado: 'Sin observaciones o sección no preparada' }]), name);
      const report = data.summary;
      sheet('Metadatos', Object.entries({ Cafetería: report.scope.label, Locales: report.scope.locations.map(l => l.name).join(', '), Desde: report.period.from, Hasta: report.period.to, Corte: report.asOf, DíaCompleto: report.lastCompleteDay, Generado: report.generatedAt, Metodología: report.definitionVersion, Identidad: report.keyVersion, Datos: report.dataVersion, VersionesFuentes: JSON.stringify(report.sourceVersions), BaseMonetaria: report.quality.monetaryBasis }).map(([Campo, Valor]) => ({ Campo, Valor })));
      sheet('Resumen', ['active', 'returning', 'returnDaysRate', 'returnAmountRate'].map(key => ({ Indicador: key, ...Object.fromEntries(Object.entries(report.summary[key]).filter(([field]) => field !== 'coverage')), CoberturaCompleta: report.summary.coverage.complete, DiasCubiertos: report.summary.coverage.coveredDays, DiasEsperados: report.summary.coverage.expectedDays })));
      sheet('Retorno30', [{ ...report.return30 }]);
      sheet('Evolucion', [...report.trend.weeks, ...report.trend.months].map(row => ({ Desde: row.period.from, Hasta: row.period.to, PrimeraFecha: row.firstDays, Regreso: row.returnDays, Denominador: row.days, Porcentaje: row.returnDaysRate.value, Estado: row.status })));
      sheet('Frecuencia28', report.frequency.rows.map(row => ({ ...row, Desde: report.frequency.period.from, Hasta: report.frequency.period.to, Denominador: report.frequency.active, Estado: report.frequency.status })));
      sheet('Recencia90', report.recency.rows.map(row => ({ ...row, Desde: report.recency.period.from, Hasta: report.recency.period.to, Denominador: report.recency.total, Estado: report.recency.status })));
      sheet('Cohortes', data.returns.rows.flatMap(row => Object.values(row.horizons).map(cell => ({ Cohorte: row.key, Instrumentos: row.instruments, ...cell, EntradaDesde: data.returns.from, EntradaHasta: data.returns.to, Seguimiento: data.returns.D }))));
      sheet('Cobertura', data.quality.coverage);
      sheet('Calidad', Object.entries({ ...data.quality.diagnostics, ...data.quality.purchases, ...data.quality.linkage, Reembolsos: data.quality.refunds, IdentificacionPagosNumerador: data.quality.identificationPayments.numerator, IdentificacionPagosDenominador: data.quality.identificationPayments.denominator, IdentificacionImporteNumerador: data.quality.identificationAmount.numerator, IdentificacionImporteDenominador: data.quality.identificationAmount.denominator }).map(([Campo, Valor]) => ({ Campo, Valor: typeof Valor === 'object' ? JSON.stringify(Valor) : Valor })));
      sheet('ExclusionesPedidos', data.quality.unclassified || []);
      sheet('DiasSinEvidencia', [report.summary.coverage, data.quality.purchaseCoverage, data.quality.paymentCoverage].filter(Boolean).flatMap(c => c.locations.flatMap(l => l.missing.map(Fecha => ({ Fuente: c.source, Cafeteria: l.locationId, Fecha })))));  sheet('Definiciones', Object.entries(report.fieldMapping).map(([Campo, Regla]) => ({ Campo, Regla })));
      sheet('Pagos', data.paymentDetails); if (data.purchaseDetails) sheet('Pedidos', data.purchaseDetails);
      if (data.purchases) sheet('Compras', data.purchases.rows.map(row => ({ Segmento: row.label, Pedidos: row.orders, VentaNeta: row.netSales, TicketMediano: row.medianTicketGross, UnidadesPedido: row.unitsPerOrder, Estado: data.purchases.status })));
      if (data.purchases) {
        sheet('CategoriasCompras', data.purchases.rows.flatMap(row => row.mix.categories.map(c => ({ Segmento: row.label, DenominadorPedidos: row.orders, ...c }))));
        sheet('ProductosCompras', data.purchases.rows.flatMap(row => row.mix.products.map(p => ({ Segmento: row.label, DenominadorPedidos: row.orders, ...p }))));
      }
      const historyRows = (report, rows) => rows.flatMap(row => report.windows.map(h => ({ Mes: row.month || 'Acumulado', Desde: row.from, Hasta: row.to, Destino: row.destination || report.scopeLabel || data.summary.scope.label, Origen: row.origin || null, VentanaDias: h, Porcentaje: row.windows[h].value, NumeradorMP: row.windows[h].numerator, DenominadorMP: row.windows[h].denominator, ImporteIdentificable: row.identifiedAmount, Estado: row.windows[h].status, HistorialDesde: row.windows[h].historyFrom, HistorialHasta: row.windows[h].historyTo, DiasAcreditados: row.windows[h].coveredDays, DiasEsperados: row.windows[h].expectedDays, Motivo: row.windows[h].reason, Corte: report.asOf, Metodologia: report.definitionVersion, Base: report.denominator })));
      if (data.monthly) sheet('Evolucion12Meses', historyRows(data.monthly, data.monthly.rows));
      if (data.network) {
        sheet('CrucesRed12Meses', historyRows(data.network, data.network.rows));
        sheet('CrucesPorDestino', historyRows(data.network, data.network.destinations.flatMap(d => d.rows)));
        sheet('CrucesPorOrigen', historyRows(data.network, data.network.origins));
        sheet('OrigenesAcumulados', historyRows(data.network, data.network.originTotals));
        sheet('CoberturaRed', data.network.coverage); sheet('NotasCrucesRed', data.network.warnings.map(Nota => ({ Nota })));
      }
      sheet('Limitaciones', data.quality.warnings.map(Nota => ({ Nota })));
      XLSX.writeFile(book, `Brewit_Recurrencia_${report.scope.location}_${report.period.to}.xlsx`);
      status('sales-customers-status', 'Exportación preparada con las secciones calculadas y la versión del reporte.', 'success');
    } catch (error) { status('sales-customers-status', error.message, 'error'); }
    finally { byId('recurrence-export').disabled = false; }
  }
  document.addEventListener('DOMContentLoaded', () => {
    syncDates(); document.body.append(byId('recurrence-detail-dialog'));
    byId('sales-customers-filters').addEventListener('submit', generate);
    byId('sales-customers-period').addEventListener('change', syncDates);
    ['sales-customers-location', 'sales-customers-period', 'sales-customers-from', 'sales-customers-to', 'recurrence-evolution'].forEach(id => byId(id).addEventListener('change', markDirty));
    ['recurrence-cohort-from', 'recurrence-cohort-to', 'recurrence-cohort-granularity', 'recurrence-common-base'].forEach(id => byId(id).addEventListener('change', () => { state.returnTouched = true; state.sections.get('return')?.abort(); status('recurrence-return-status', 'La tabla conserva su selección anterior. Pulsa Generar retorno para aplicar los filtros.'); }));
    byId('recurrence-return-filters').addEventListener('submit', event => { event.preventDefault(); section('return', { from: byId('recurrence-cohort-from').value, to: byId('recurrence-cohort-to').value, granularity: byId('recurrence-cohort-granularity').value, commonBase: byId('recurrence-common-base').checked }); });
    byId('recurrence-purchases-run').addEventListener('click', () => section('purchases'));
    byId('recurrence-quality-run').addEventListener('click', () => section('quality'));
    for (const kind of ['monthly', 'network']) byId(`recurrence-${kind}-run`).addEventListener('click', () => section(kind));
    byId('recurrence-export').addEventListener('click', exportReport);
    byId('recurrence-detail-close').addEventListener('click', () => byId('recurrence-detail-dialog').close());
    byId('recurrence-detail-prev').addEventListener('click', () => showDetails(state.detail.kind, state.detail.page - 1));
    byId('recurrence-detail-next').addEventListener('click', () => showDetails(state.detail.kind, state.detail.page + 1));
    const tabs = [...document.querySelectorAll('[data-recurrence-tab]')];
    function activate(index, focus = false) { tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; byId(tab.getAttribute('aria-controls')).hidden = i !== index; }); if (focus) tabs[index].focus(); }
    tabs.forEach((tab, index) => { tab.addEventListener('click', () => activate(index)); tab.addEventListener('keydown', event => { let next; if (event.key === 'ArrowRight') next = (index + 1) % tabs.length; if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length; if (event.key === 'Home') next = 0; if (event.key === 'End') next = tabs.length - 1; if (next !== undefined) { event.preventDefault(); activate(next, true); } }); });
    window.addEventListener('brewit-sales-updated', markDirty); window.addEventListener('brewit-payments-updated', markDirty);
  });
})();
