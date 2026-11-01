(() => {
  const byId = id => document.getElementById(`product-xray-${id}`);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const money = v => v == null ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
  const count = v => v == null ? '—' : Number(v).toLocaleString('es-CL', { maximumFractionDigits: 2 });
  const percent = v => v == null ? '—' : `${Number(v).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const costSource = v => ({ purchase: 'Compra', recipe: 'Receta', master: 'Maestro', missing: 'Sin costo', 'sales-export': 'Costo registrado en venta' })[v] || v;
  const netMoney = v => v == null ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  const preciseMoney = v => v == null ? '—' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(v);
  const preciseCount = v => v == null ? '—' : Number(v).toLocaleString('es-CL', { maximumFractionDigits: 6 });
  const state = { options: null, report: null, controller: null, generation: 0, valid: false, pdfController: null };
  const status = message => { byId('status').textContent = message; if (byId('dialog-status')) byId('dialog-status').textContent = message; };
  let renderRoot;
  const reportsFor = data => window.ProductXrayDocument.reportsFor(data);
  function actions() { for (const id of ['export', 'pdf', 'open', 'dialog-pdf', 'dialog-export']) if (byId(id)) byId(id).disabled = !state.valid || !!state.pdfController; }
  const query = () => new URLSearchParams({ location: byId('location').value, period: byId('period').value, dateFrom: byId('from').value,
    dateTo: byId('to').value, hierarchy: byId('hierarchy').value, family: byId('family').value });
  async function json(url, signal) { const r = await fetch(url, { signal, cache: 'no-store' }), data = await r.json(); if (!r.ok) throw new Error(data.error || 'No se pudo cargar la ficha.'); return data; }
  function dirty(message = 'Filtros modificados. Genera la ficha para actualizarlos.') {
    state.valid = false; state.pdfController?.abort(); actions();
    if (costDialog.open) costDialog.close();
    byId('results').querySelectorAll('button').forEach(b => b.disabled = true);
    if (state.report) status(message);
  }
  function stop() { state.controller?.abort(); state.controller = null; state.generation++; byId('cancel').hidden = true; byId('progress').hidden = true; byId('generate').disabled = false; }
  function pickProducts() {
    const selected = byId('family').value, term = byId('search').value.trim().toLocaleLowerCase('es'), path = JSON.parse(byId('hierarchy').value || '[]');
    const products = (state.options?.families || []).filter(f => path.every((p, i) => f.path[i] === p) && `${f.name} ${f.codes.join(' ')}`.toLocaleLowerCase('es').includes(term));
    byId('family').replaceChildren(new Option('Todos los productos de la selección', ''), ...products.map(f => new Option(`${f.name} · ${[...new Set(f.formats)].join(', ')} · ${f.codes.join(' / ')}`, f.id)));
    if (products.some(f => f.id === selected)) byId('family').value = selected;
    if (selected !== byId('family').value) dirty();
  }
  async function loadOptions() {
    stop(); const generation = state.generation, controller = new AbortController(); state.controller = controller;
    status('Preparando productos y formatos…'); byId('generate').disabled = true; byId('cancel').hidden = false;
    try {
      const data = await json(`/api/sales/product-xray/options?${query()}`, controller.signal); if (generation !== state.generation) return;
      state.options = data; const location = byId('location').value, hierarchy = byId('hierarchy').value;
      byId('location').replaceChildren(new Option('Todas las cafeterías', 'all'), ...data.locations.map(l => new Option(l.name, l.id))); byId('location').value = location;
      byId('from').max = data.today; byId('to').max = data.today;
      if (byId('period').value !== 'custom') { byId('from').value = data.period.from; byId('to').value = data.period.to; }
      const paths = new Map(); data.families.forEach(f => f.path.forEach((_, i) => { const path = f.path.slice(0, i + 1); paths.set(JSON.stringify(path), path.join(' / ')); }));
      byId('hierarchy').replaceChildren(new Option('Todas las jerarquías', '[]'), ...[...paths].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([v, label]) => new Option(label, v)));
      if (paths.has(hierarchy)) byId('hierarchy').value = hierarchy;
      pickProducts(); status('Selecciona una jerarquía o un producto opcional y pulsa Generar informe.');
    } catch (e) { if (generation === state.generation && e.name !== 'AbortError') status(e.message); }
    finally { if (generation === state.generation) { byId('generate').disabled = false; byId('cancel').hidden = true; state.controller = null; } }
  }
  function section(title, intro) { const s = el('section', null, 'xray-section'); s.append(el('h4', title)); if (intro) s.append(el('p', intro, 'panel-description')); renderRoot.append(s); return s; }
  function table(title, headers, rows, formats = []) {
    const wrap = el('div', null, 'xray-scroll'), t = el('table', null, 'xray-table'), head = t.createTHead().insertRow();
    t.setAttribute('aria-label', title);
    headers.forEach(h => head.append(el('th', h))); const body = t.createTBody();
    rows.forEach(row => { const tr = body.insertRow(); row.forEach((value, i) => { const cell = el('td'), display = formats[i] ? formats[i](value) : value ?? '—'; if (display instanceof Node) cell.append(display); else cell.textContent = display; tr.append(cell); }); });
    wrap.append(t); return wrap;
  }
  function comparisonTable(reference) {
    return table('Comparación de ingredientes', ['Código', 'Ingrediente / envase', 'Unidad', 'Cantidad teórica por producto', 'Costo neto teórico / unidad', 'Aporte teórico por producto', 'Cantidad media real por producto (último mes)', 'Costo neto medio real / unidad (último mes)', 'Aporte real medio por producto (último mes)'],
      reference.ingredientComparison.map(r => [r.code, r.name, r.unit, r.theoreticalQuantity, r.theoreticalUnitCost, r.theoreticalCost, r.realQuantityPerProduct, r.realUnitCost, r.realCostPerProduct]), [null, null, null, preciseCount, preciseMoney, preciseMoney, preciseCount, preciseMoney, preciseMoney]);
  }
  function cards(items) { const n = el('div', null, 'recurrence-kpis'); for (const [title, value, hint] of items) { const card = el('div', null, 'recurrence-kpi'); card.append(el('h4', title), el('strong', value)); if (hint) card.append(el('small', hint)); n.append(card); } return n; }
  function chart(report, metric, title) {
    const figure = el('figure', null, 'xray-chart'), caption = el('figcaption', title), legend = el('div', null, 'xray-legend'); figure.append(caption, legend);
    const series = [{ name: 'Total producto', key: 'total' }, ...report.formats.map(p => ({ name: `${p.format} · ${p.code}`, key: p.code }))];
    const visible = new Set(series.map(s => s.key)), colors = ['#a36a3d', '#2b8c80', '#d8883c', '#8184c2', '#ba6085', '#5f8a48'];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 700 260'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title); figure.append(svg);
    function node(tag, attrs, text) { const n = document.createElementNS(svg.namespaceURI, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text != null) n.textContent = text; svg.append(n); return n; }
    const value = (month, s) => (s.key === 'total' ? month.total : month.formats.find(f => f.code === s.key))?.[metric];
    function draw() {
      svg.replaceChildren(); const values = report.history.flatMap(m => series.filter(s => visible.has(s.key)).map(s => value(m, s))).filter(Number.isFinite);
      const min = Math.min(0, ...values), max = Math.max(1, ...values), y = v => 215 - (v - min) / (max - min) * 185;
      for (let i = 0; i <= 3; i++) { const v = min + (max - min) * i / 3; node('line', { x1: 85, x2: 670, y1: y(v), y2: y(v), stroke: 'currentColor', opacity: .13 }); node('text', { x: 78, y: y(v) + 4, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 11 }, metric === 'netSales' ? money(v) : count(v)); }
      report.history.forEach((m, i) => node('text', { x: 100 + i * 110, y: 243, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 12 }, `${m.from.slice(0, 7)}${m.status === 'partial' ? '*' : ''}`));
      series.forEach((s, j) => { if (!visible.has(s.key)) return; let prior = null;
        report.history.forEach((m, i) => { const v = value(m, s); if (!Number.isFinite(v)) { prior = null; return; } const point = [100 + i * 110, y(v)];
          if (prior) node('line', { x1: prior[0], y1: prior[1], x2: point[0], y2: point[1], stroke: colors[j % colors.length], 'stroke-width': j === 0 ? 3 : 2 });
          const dot = node('circle', { cx: point[0], cy: point[1], r: 4, fill: colors[j % colors.length], tabindex: 0 });
          const tip = document.createElementNS(svg.namespaceURI, 'title'); tip.textContent = `${m.from.slice(0, 7)} · ${s.name}: ${metric === 'netSales' ? money(v) : count(v)}${m.status === 'partial' ? ' (parcial)' : ''}`; dot.append(tip); prior = point;
        });
      });
    }
    series.forEach((s, i) => { const button = el('button', s.name, 'icon-button small'); button.type = 'button'; button.style.borderColor = colors[i % colors.length]; button.setAttribute('aria-pressed', 'true'); button.addEventListener('click', () => { visible.has(s.key) ? visible.delete(s.key) : visible.add(s.key); button.setAttribute('aria-pressed', String(visible.has(s.key))); draw(); }); legend.append(button); }); draw(); return figure;
  }
  function render(report, target = byId('results')) {
    renderRoot = target; target.replaceChildren();
    const identity = section(report.family.name, `${report.scope.label} · ${report.period.from} — ${report.period.to} · Todos los formatos agrupados`);
    identity.append(el('p', report.family.path.join(' / ') || 'Sin jerarquía'), el('p', `${({ hot: 'Barra caliente', cold: 'Barra fría' })[report.family.bar] || 'Sin clasificación de barra'} · ${report.family.classificationLabel}`));
    identity.append(cards([['Unidades del período', count(report.selected.total.units)], ['Venta neta del período', money(report.selected.total.netSales), 'Sin IVA, después de descuentos'], ['Pedidos de consumo', count(report.consumption.orders), 'Compras positivas válidas'], ['Cobertura de género', percent(report.consumption.genderCoverageUnits), `${percent(report.consumption.genderCoverageOrders)} de pedidos`]]));
    if (report.selected.status !== 'complete') identity.append(el('p', report.selected.status === 'no_data' ? 'Sin datos de ventas para esta selección.' : 'Datos provisionales: cobertura de ventas incompleta.', 'form-status warning'));
    if (report.sizeMix) { const mix = section('Participación por tamaño', report.sizeMix.basis); mix.append(table('Participación por tamaño', ['Tamaño', 'Códigos', 'Unidades de consumo', 'Participación %'], report.sizeMix.rows.map(r => [r.format, r.codes.join(' / '), r.units, r.percent]), [null, null, count, percent])); }
    const profitability = section('Formatos y rentabilidad', `Margen real: ventas después de descuentos y costos de cada fecha de venta. Margen teórico vigente al ${report.referenceDate}: precio de lista actual y últimas compras de ingredientes.`);
    profitability.append(el('h5', `Margen teórico vigente · ${report.referenceDate}`), table('Margen teórico vigente', ['Formato', 'Código', 'Cafetería', 'Precio lista vigente con IVA', 'Precio neto', 'Costo disponible', 'Margen unitario $', 'Margen %', 'Origen costo', 'Fecha costo', 'Estado'],
      report.formats.flatMap(p => p.references.map(r => [p.format, p.code, r.location, r.priceGross, r.priceNet, { report, product: p, reference: r }, r.margin, r.marginPercent, costSource(r.source), r.date, r.margin === null ? `Margen no calculable: ${r.reason || 'precio sin información'}` : 'Precio y costo netos' ])), [null, null, null, money, netMoney, costButton, netMoney, percent]));
    profitability.append(el('p', 'Haz clic en el costo disponible para ver ingredientes, cantidades, rendimientos, envases y total neto. Precio neto = precio lista con IVA / 1,19; margen = precio neto − costo neto.'));
    if (report.scope.locations.length > 1) {
      const ranges = report.formats.map(p => { const costs = p.references.map(r => r.cost).filter(Number.isFinite); return `${p.format}: ${costs.length ? `${money(Math.min(...costs))} – ${money(Math.max(...costs))}` : 'Sin costo comparable'}`; });
      profitability.append(el('p', `Rango de costos disponibles por local: ${ranges.join(' · ')}. Los márgenes se calculan por local sobre bases netas.`));
    }
    profitability.append(el('h5', 'Venta real del período seleccionado'), table('Venta real del período', ['Formato', 'Código', 'Unidades', 'Venta neta', 'Precio real medio con IVA', 'Precio real medio neto', 'Costo neto total', 'Costo neto unitario', 'Margen total $', 'Margen unitario $', 'Margen %', 'Estado'],
      report.formats.map(p => [p.format, p.code, p.actual.units, p.actual.netSales, p.actual.priceGross, p.actual.priceNet, p.actual.cost, p.actual.unitCost, p.actual.margin, p.actual.unitMargin, p.actual.marginPercent,
        p.actual.margin === null ? `Margen no calculable: ${p.actual.units <= 0 ? 'sin unidades positivas netas' : p.actual.reasons.join('; ') || 'información incompleta'}` : 'Costos netos a fecha de venta']), [null, null, count, money, netMoney, netMoney, netMoney, netMoney, netMoney, netMoney, percent]));
    profitability.append(el('h5', `Último mes completo · ${report.lastMonth.from} — ${report.lastMonth.to}`), el('p', report.lastMonth.coverage.complete ? 'Cobertura del mes completa.' : 'Mes con cobertura incompleta: se muestran las ventas observadas y sus costos históricos.'), table('Último mes real', ['Formato', 'Código', 'Unidades', 'Venta neta', 'Precio real medio con IVA', 'Precio real medio neto', 'Costo real unitario neto', 'Margen real unitario', 'Margen real %'], report.formats.map(p => { const a = p.lastMonthActual; return [p.format, p.code, a.units, a.netSales, a.priceGross, a.priceNet, a.unitCost, a.unitMargin, a.marginPercent]; }), [null, null, count, money, netMoney, netMoney, netMoney, netMoney, percent]));
    for (const p of report.formats) {
      const details = el('details'), summary = el('summary', `Receta y evidencia · ${p.format} · ${p.code}${p.recipe.capacity.length ? ` · ${p.recipe.capacity.join(' / ')}` : ''}`); details.append(summary);
      details.append(el('p', p.recipe.complete ? 'Receta completa en las fuentes consultadas.' : p.recipe.problems.join(' · ')));
      details.append(el('p', p.recipe.evidence.map(e => `${e.label}: ${e.name} (${e.code})`).join(' · ') || (p.recipe.complete ? 'Ninguno de los ingredientes principales indicados.' : 'Clasificación incompleta.')));
      details.append(table(`Receta ${p.code}`, ['Receta padre', 'Código', 'Ingrediente', 'Tipo', 'Cantidad', 'Unidad', 'Rendimiento %', 'Cantidad ajustada', 'Clasificación principal'], p.recipe.ingredients.map(i => [i.parentCode, i.code, `${'↳ '.repeat(i.depth)}${i.name}`, i.packaging ? 'Packaging' : 'Ingrediente', i.quantity, i.unit, i.yieldRate, i.effectiveQuantity, p.recipe.evidence.find(e => e.code === i.code)?.label || '']), [null, null, null, null, count, null, percent, count]));
      details.append(el('p', `Receta teórica vigente al ${report.referenceDate}. Las cantidades de subrecetas se expresan por su receta padre; la comparación inferior usa porciones por producto y costos reales del ${report.lastMonth.from} al ${report.lastMonth.to}.`));
      for (const ref of p.references) { details.append(el('h5', ref.location), cards([['Precio lista vigente con IVA', money(ref.priceGross)], ['Costo teórico neto vigente', netMoney(ref.cost)], ['Precio real medio del último mes con IVA', netMoney(ref.lastMonth.priceGross)], ['Costo real medio del último mes neto', netMoney(ref.lastMonth.unitCost), ref.lastMonth.reasons.join('; ')]])); if (ref.lastMonth.units > 0 && !ref.lastMonth.ingredientBreakdownComplete) details.append(el('p', 'El desglose histórico por ingrediente no cubre todo el mes. Un costo total registrado en ventas puede estar disponible sin permitir reconstruir la receta histórica.', 'form-status warning')); details.append(comparisonTable(ref)); }
      details.append(table(`Costos efectivos ${p.code}`, ['Local ID', 'Origen', 'Fecha', 'Costo unitario disponible', 'Base', 'Local de compra'], p.actual.sources.map(s => [s.locationId, costSource(s.source), s.date, s.cost, s.reason || 'Costo neto', s.sourceLocation]), [null, null, null, money])); profitability.append(details);
    }
    const history = section('Ventas y evolución', 'Seis meses completos anteriores al inicio de la selección. * indica cobertura parcial; los meses sin datos quedan sin punto en el gráfico.');
    const charts = el('div', null, 'xray-charts'); charts.append(chart(report, 'netSales', 'Evolución de venta neta ($)'), chart(report, 'units', 'Evolución de unidades')); history.append(charts);
    const periodRows = [report.selected, ...report.history].flatMap((m, i) => [[i === 0 ? 'Período seleccionado' : m.from.slice(0, 7), m.from, m.to, 'Total', m.total.units, m.total.netSales, m.status], ...m.formats.map(f => [i === 0 ? 'Período seleccionado' : m.from.slice(0, 7), m.from, m.to, `${f.format} · ${f.code}`, f.units, f.netSales, m.status])]);
    history.append(table('Ventas y evolución', ['Período', 'Desde', 'Hasta', 'Formato', 'Unidades', 'Venta neta', 'Cobertura'], periodRows, [null, null, null, null, count, money, v => ({ complete: 'Completa', partial: 'Parcial', no_data: 'Sin datos' })[v]]));
    const consumption = section('Radiografía del consumidor y del consumo', 'Porcentajes sobre unidades de compras positivas válidas. Los pedidos no representan personas únicas.');
    for (const [title, rows] of [['Género', report.consumption.gender], ['Franjas horarias', report.consumption.hours], ['Días de la semana', report.consumption.weekdays]]) { consumption.append(el('h5', title), table(title, ['Segmento', 'Unidades', 'Participación %', 'Pedidos únicos', 'Venta neta'], rows.map(r => [r.label, r.units, r.percent, r.orders, r.netSales]), [null, count, percent, count, money])); }
    consumption.append(el('p', `Ajustes excluidos de consumo: ${count(report.consumption.excludedAdjustments.units)} unidades y ${money(report.consumption.excludedAdjustments.netSales)}. Permanecen en los totales comerciales.`));
    consumption.append(el('h5', 'Acompañamientos'), table('Acompañamientos', ['Categoría', 'Pedidos', 'Participación %'], [['Bollería', report.accompanies.bakery.orders, report.accompanies.bakery.percent], ['Sándwiches', report.accompanies.sandwich.orders, report.accompanies.sandwich.percent], ['Ambas en el mismo pedido', report.accompanies.both.orders, report.accompanies.both.percent], ['Cualquiera de ambas, sin duplicar', report.accompanies.either.orders, report.accompanies.either.percent]], [null, count, percent]), el('p', `Denominador: ${report.consumption.orders} pedidos únicos que incluyen el producto. Bollería y sándwiches se identifican por sus ramas específicas. La fila «Ambas» es la intersección; «Cualquiera» es la unión sin duplicar pedidos.`));
    const conclusion = section('Conclusión', report.conclusion.status); report.conclusion.statements.forEach(s => conclusion.append(el('p', s)));
    const clusterResults = el('div', null, 'xray-clusters'); clusterResults.id = state.report.type === 'collection' ? `product-xray-clusters-${report.family.id}` : 'product-xray-clusters'; conclusion.append(clusterResults); paintCluster(clusterResults, report.clusters);
    const quality = el('details', null, 'xray-section xray-quality'); quality.append(el('summary', 'Alcance, calidad y notas')); target.append(quality);
    quality.append(el('p', 'Base suficiente: 100 pedidos y 7 fechas. Concentración descriptiva: al menos dos dimensiones con ≥50,0% y ventaja ≥15,0 puntos; género exige cobertura ≥50,0%.'));
    quality.append(table('Fuentes', ['Tipo', 'Fuente', 'Vigente desde'], report.sources.map(s => [s.kind, s.name, s.validFrom])));
    [...report.warnings, ...report.methodology, ...(report.clusters?.warnings || [])].forEach(s => quality.append(el('p', s)));
    if (report.clusters) {
      quality.append(table('Cobertura de clusters', ['Dimensión', 'Cobertura %', 'Estado'], report.clusters.coverage.filter(d => d.requested).map(d => [d.label, d.coverage, d.available ? 'Disponible' : d.reason]), [null, percent]));
      quality.append(table('Parámetros de clusters', ['Parámetro', 'Valor'], Object.entries(report.clusters.parameters)));
    }

  }
  const dialog = el('dialog', null, 'xray-dialog'); dialog.id = 'product-xray-dialog'; dialog.setAttribute('aria-labelledby', 'product-xray-dialog-title');
  const toolbar = el('div', null, 'xray-dialog-toolbar'), dialogTitle = el('h3', 'X-ray producto'); dialogTitle.id = 'product-xray-dialog-title'; toolbar.append(dialogTitle);
  for (const [id, label, action] of [['dialog-pdf', 'Exportar PDF', exportPdf], ['dialog-export', 'Exportar XLSX', exportXlsx], ['dialog-pdf-cancel', 'Cancelar PDF', () => state.pdfController?.abort()], ['dialog-close', 'Cerrar ventana', () => dialog.close()]]) {
    const button = el('button', label, 'icon-button'); button.type = 'button'; button.id = `product-xray-${id}`; button.addEventListener('click', action); if (id.endsWith('cancel')) button.hidden = true; toolbar.append(button);
  }
  const dialogStatus = el('p', null, 'form-status'), dialogBody = el('div', null, 'xray-dialog-body'); dialogStatus.id = 'product-xray-dialog-status'; dialogStatus.setAttribute('role', 'status');
  dialog.append(toolbar, dialogStatus, dialogBody); document.body.append(dialog);
  const costDialog = el('dialog', null, 'xray-dialog xray-cost-dialog'); costDialog.id = 'product-xray-cost-dialog'; costDialog.setAttribute('aria-labelledby', 'product-xray-cost-title');
  const costToolbar = el('div', null, 'xray-dialog-toolbar'), costTitle = el('h3'); costTitle.id = 'product-xray-cost-title';
  const costClose = el('button', 'Cerrar detalle de costo', 'icon-button'); costClose.type = 'button'; costClose.addEventListener('click', () => costDialog.close());
  const costBody = el('div'); costToolbar.append(costTitle, costClose); costDialog.append(costToolbar, costBody); document.body.append(costDialog);
  function costButton({ report, product, reference }) {
    const button = el('button', reference.cost == null ? 'Ver detalle' : netMoney(reference.cost), 'xray-cost-button'); button.type = 'button';
    button.setAttribute('aria-label', `Ver costo neto de ${product.name} en ${reference.location}`);
    button.addEventListener('click', async () => {
      if (!await verify()) return;
      const b = reference.breakdown; costTitle.textContent = `Costo neto · ${report.family.name} · ${product.format} · ${reference.location}`; costBody.replaceChildren();
      costBody.append(el('p', `Costo teórico vigente al ${report.referenceDate}. Ingredientes y envases netos; no se aplica IVA a los costos. Origen: ${costSource(reference.source)} · ${reference.date || 'Fecha sin información'}.`));
      if (!b.complete) costBody.append(el('p', b.reason || 'Desglose incompleto. Margen no calculable.', 'form-status warning'));
      costBody.append(table('Detalle de costo neto', ['Receta padre', 'Código', 'Ingrediente / envase', 'Cantidad por producto', 'Rendimiento %', 'Cantidad efectiva por producto', 'Unidad', 'Costo neto / unidad', 'Aporte neto', 'Cómputo', 'Origen', 'Fecha', 'Local de compra'],
        b.rows.map(r => [r.parentCode, r.code, `${'↳ '.repeat(r.depth)}${r.name}`, r.quantity, r.yieldRate, r.effectiveQuantity, r.unit, r.unitCost, r.totalCost, r.includedInTotal ? 'Incluido en total' : 'Subtotal de subreceta (no sumar)', costSource(r.source), r.date, r.location]),
        [null, null, null, preciseCount, percent, preciseCount, null, preciseMoney, preciseMoney]));
      const subtotal = packaging => { const rows = b.rows.filter(r => r.includedInTotal && r.packaging === packaging); return rows.some(r => r.totalCost == null) ? null : rows.reduce((n, r) => n + r.totalCost, 0); };
      costBody.append(cards([['Ingredientes netos', netMoney(subtotal(false))], ['Envases netos', netMoney(subtotal(true))], ['Total costo neto', netMoney(b.totalNet), 'Sin duplicar subtotales de subrecetas']]));
      costBody.append(el('p', 'Cantidad efectiva = cantidad / (rendimiento / 100). Las subrecetas se escalan a la porción usada en este producto y a su unidad de salida; sus subtotales ya están contenidos en los componentes finales. El total usa importes sin redondeos intermedios.'));
      if (!reference.lastMonth.ingredientBreakdownComplete && reference.lastMonth.units > 0) costBody.append(el('p', 'El costo histórico por ingrediente no está completo para todo el mes. Un costo total registrado en ventas no aporta por sí solo el desglose de ingredientes.', 'form-status warning'));
      costBody.append(el('h4', `Comparación con el último mes completo · ${report.lastMonth.from} — ${report.lastMonth.to}`), comparisonTable(reference));
      costBody.append(el('p', `Último mes: ${count(reference.lastMonth.units)} unidades · Precio real medio con IVA: ${netMoney(reference.lastMonth.priceGross)} · Precio real medio neto: ${netMoney(reference.lastMonth.priceNet)} · Costo real medio neto: ${netMoney(reference.lastMonth.unitCost)} · Margen real: ${percent(reference.lastMonth.marginPercent)}.`));
      costBody.append(el('p', `Precio lista vigente con IVA: ${money(reference.priceGross)} · Precio neto: ${netMoney(reference.priceNet)} · Margen unitario: ${netMoney(reference.margin)} · Margen: ${percent(reference.marginPercent)}.`));
      if (!costDialog.open) costDialog.showModal();
    }); return button;
  }
  function openDialog() { if (!state.report) return; dialogBody.append(byId('results')); dialogTitle.textContent = `X-ray producto · ${state.report.scope.label}`; dialogStatus.textContent = byId('status').textContent; if (!dialog.open) dialog.showModal(); }
  dialog.addEventListener('close', () => { byId('result-slot').append(byId('results')); byId('open').focus(); });
  byId('open').addEventListener('click', openDialog);
  function renderSnapshot(snapshot) {
    if (snapshot.type !== 'collection') { render(snapshot); return; }
    const root = byId('results'); root.replaceChildren(); renderRoot = root;
    const rows = snapshot.reports, sum = key => rows.some(r => r.selected.total[key] == null) ? null : rows.reduce((n, r) => n + r.selected.total[key], 0);
    const overview = section('Informe por jerarquía', `${snapshot.scope.label} · ${snapshot.period.from} — ${snapshot.period.to} · ${snapshot.hierarchy.join(' / ') || 'Todas las jerarquías'}`);
    overview.append(cards([['Productos', count(rows.length)], ['Unidades de productos', count(sum('units'))], ['Venta neta de productos', money(sum('netSales')), 'Extras y adicionales no incluidos']]));
    overview.append(el('p', 'Abre una ficha desde el índice o su título. La exportación incluye todos los productos, aunque sus fichas estén cerradas.'));
    const index = el('nav', null, 'xray-index'); index.setAttribute('aria-label', 'Índice de productos'); index.tabIndex = -1; index.append(el('h4', 'Índice de productos')); overview.append(index);
    const groups = new Map();
    function group(path) { const key = JSON.stringify(path); if (groups.has(key)) return groups.get(key); const parent = path.length > 1 ? group(path.slice(0, -1)) : root;
      const node = el('section', null, 'xray-group'); node.append(el(path.length === 1 ? 'h4' : 'h5', path.at(-1))); parent.append(node); groups.set(key, node); return node; }
    for (const report of rows) {
      const path = report.family.path.length ? report.family.path : ['Sin jerarquía'], parent = group(path), details = el('details', null, 'xray-product'); details.id = `xray-product-${report.family.id}`;
      const summary = el('summary', `${report.family.name} · ${count(report.selected.total.units)} un. · ${money(report.selected.total.netSales)}`), body = el('div'); let drawn = false;
      const draw = () => { if (drawn) return; drawn = true; render(report, body); const back = el('button', 'Volver al índice', 'icon-button'); back.type = 'button'; back.addEventListener('click', () => { index.scrollIntoView({ block: 'start' }); index.focus({ preventScroll: true }); }); body.prepend(back); if (!state.valid) body.querySelectorAll('button').forEach(b => b.disabled = true); };
      details.append(summary, body); details.addEventListener('toggle', () => { if (details.open) draw(); }); parent.append(details);
      const link = el('a', `${path.join(' › ')} · ${report.family.name}`); link.href = `#${details.id}`;
      link.addEventListener('click', event => { event.preventDefault(); draw(); details.open = true; summary.scrollIntoView({ block: 'start' }); summary.focus(); }); index.append(link);
    }
  }
  async function verify() {
    if (!state.report || !state.valid) return false;
    const report = state.report;
    try { const data = await json(`/api/sales/product-xray/version?location=${encodeURIComponent(report.scope.location)}`); if (state.report !== report || !state.valid) return false; if (data.sourceVersion !== report.sourceVersion) { dirty('Las fuentes cambiaron. Genera nuevamente la ficha.'); return false; } return true; }
    catch (e) { status(e.message); return false; }
  }
  byId('filters').addEventListener('submit', async event => {
    event.preventDefault(); stop(); dirty(); const generation = state.generation, controller = new AbortController(); state.controller = controller;
    byId('generate').disabled = true; byId('cancel').hidden = false; byId('progress').hidden = false; byId('progress').removeAttribute('value'); status('Preparando ficha…');
    try {
      const q = query(); q.set('progress', '1'); q.set('sourceVersion', state.options?.sourceVersion || '');
      const response = await fetch(`/api/sales/product-xray?${q}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error((await response.json()).error), { status: response.status });
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', report = null;
      function consume(line) { if (!line.trim()) return; const data = JSON.parse(line); if (data.type === 'error') throw Object.assign(new Error(data.error), { status: data.status });
        if (data.type === 'progress') { status(data.message); byId('progress').value = data.step; } if (data.type === 'result') report = data.report; }
      try { while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(consume); if (done) { consume(buffer); break; } } } finally { await reader.cancel().catch(() => {}); }
      if (generation !== state.generation) return; if (!report) throw new Error('El cálculo no entregó una ficha.');
      state.report = report; state.valid = true; renderSnapshot(report); actions(); status(report.type === 'collection' ? `Informe generado: ${report.reports.length} productos.` : 'Ficha generada.'); if (report.type === 'collection') openDialog();
    } catch (e) { if (generation === state.generation && e.name !== 'AbortError') { if (e.status === 409) { await loadOptions(); status('Fuentes actualizadas. Revisa la selección y genera nuevamente la ficha.'); } else status(e.message); } }
    finally { if (generation === state.generation) { state.controller = null; byId('generate').disabled = false; byId('cancel').hidden = true; byId('progress').hidden = true; } }
  });
  byId('cancel').addEventListener('click', () => { stop(); status('Preparación cancelada.'); });
  for (const id of ['location', 'period', 'from', 'to']) byId(id).addEventListener('change', () => { dirty(); const custom = byId('period').value === 'custom'; byId('from').disabled = !custom; byId('to').disabled = !custom; if (!custom || byId('from').value && byId('to').value && byId('from').value <= byId('to').value) loadOptions(); });
  byId('hierarchy').addEventListener('change', () => { stop(); dirty(); pickProducts(); }); byId('search').addEventListener('input', pickProducts); byId('family').addEventListener('change', () => { stop(); dirty(); });
  async function exportXlsx() {
    if (!await verify()) return;
    const snapshot = state.report, book = XLSX.utils.book_new();
    window.ProductXrayDocument.workbookTables(snapshot).forEach((s, index) => {
      const sheet = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]); sheet['!cols'] = s.headers.map((_, i) => ({ wch: i === 0 ? 30 : 24 }));
      s.headers.forEach((h, c) => { if (h.includes('%')) for (let r = 1; r <= s.rows.length; r++) { const cell = sheet[XLSX.utils.encode_cell({ r, c })]; if (cell?.t === 'n') { cell.v = Number(cell.v.toFixed(1)); cell.z = '0.0"%"'; } } });
      if (s.title === 'Resumen y criterios') { const c = snapshot.type === 'collection' ? 4 : 1; s.rows.forEach((r, i) => { const cell = sheet[XLSX.utils.encode_cell({ r: i + 1, c })]; if (String(r[c - 1]).includes('%') && cell?.t === 'n') cell.z = '0.0"%"'; }); }
      XLSX.utils.book_append_sheet(book, sheet, `${String(index + 1).padStart(2, '0')} ${s.title}`.slice(0, 31));
    });

    XLSX.writeFile(book, `${filename(snapshot)}.xlsx`);
  }
  function filename(r) { return `X-ray-${(r.type === 'collection' ? r.hierarchy.join('-') || 'Todos-los-productos' : r.family.name).replace(/[^\p{L}\p{N}-]/gu, '_').slice(0, 90)}-${r.period.to}`; }
  async function exportPdf() {
    if (state.pdfController || !await verify()) return;
    if (state.pdfController) return;
    const snapshot = state.report, controller = new AbortController(); state.pdfController = controller; actions();
    byId('pdf-cancel').hidden = false; byId('dialog-pdf-cancel').hidden = false;
    try {
      const current = () => !controller.signal.aborted && state.valid && state.report === snapshot;
      status('Preparando PDF con índice…');
      const { doc, pages } = await window.ProductXrayDocument.createPdf(snapshot, window.jspdf.jsPDF, { isCurrent: current, onProgress: (n, total) => status(`Preparando PDF: ${n} de ${total} productos…`) });
      if (!current() || !await verify() || !current()) return;
      doc.save(`${filename(snapshot)}.pdf`); status(`PDF exportado: ${pages} páginas, con índice enlazado.`);
    } catch (error) { status(controller.signal.aborted ? 'Exportación PDF cancelada.' : error.message); }
    finally { state.pdfController = null; byId('pdf-cancel').hidden = true; byId('dialog-pdf-cancel').hidden = true; actions(); }
  }
  byId('export').addEventListener('click', exportXlsx); byId('pdf').addEventListener('click', exportPdf);
  byId('pdf-cancel').addEventListener('click', () => state.pdfController?.abort());
  window.addEventListener('sales-gender-updated', () => { stop(); state.options = null; dirty('Las asignaciones cambiaron. Actualiza las opciones y genera nuevamente la ficha.'); });
  function paintCluster(root, result) {
    root.replaceChildren(el('h5', 'Clusters del producto'));
    if (!result) { root.append(el('p', 'El análisis no está disponible. Genera nuevamente el informe.')); return; }
    root.append(el('p', result.conclusion));
    if (!result.clusters.length || !result.validation.complete) root.append(el('p', result.message));
    root.append(el('p', `${count(result.summary.orders)} pedidos completos analizados; ${count(result.summary.eligibleOrders)} con información suficiente. ${count(result.summary.solidClusters)} clusters sólidos y ${count(result.summary.exploratoryClusters)} exploratorios. Sin asignar: ${count(result.unassigned.orders)} pedidos.`));
    root.append(el('p', 'Los porcentajes de clusters usan pedidos; sus ventas y tickets incluyen toda la canasta. Las comparaciones por dimensión usan pedidos con ese dato disponible.'));
    for (const c of result.clusters) {
      const card = el('article', null, 'xray-cluster'); card.append(el('h5', `${c.name} · ${c.status === 'solid' ? 'Sólido' : 'Exploratorio'}`));
      card.append(el('p', `${count(c.orders)} pedidos (${percent(c.orderShare)}) · ${count(c.distinctDates)} fechas · Venta neta de canastas: ${money(c.netSales)} · Ticket mediano con IVA: ${money(c.profile.medianTicketGross)}.`));
      for (const d of c.differences) card.append(el('p', d.type === 'categorical' ? `${d.dimensionLabel}: ${d.label} en ${percent(d.prevalence)} del grupo frente a ${percent(d.rest)} del resto.` : `${d.label}: ${count(d.value)} en el grupo frente a ${count(d.rest)} en el resto.`));
      card.append(el('p', `Productos frecuentes: ${c.profile.products.map(p => `${p.name} (${percent(p.percent)} de pedidos)`).join('; ')}.`));
      card.append(el('p', `Separación (silueta): ${count(c.silhouette)} · Estabilidad: ${c.stability == null ? 'Sin validación' : percent(c.stability * 100)}.`));
      const checks = el('details'); checks.append(el('summary', 'Comprobaciones estadísticas'), table('Comprobaciones del cluster', ['Criterio', 'Resultado'], c.checks.map(v => [v.label, v.passed ? 'Cumple' : 'Pendiente']))); card.append(checks);
      const pending = c.checks.filter(v => !v.passed).map(v => v.label); if (pending.length) card.append(el('p', `Exploratorio por: ${pending.join('; ')}.`));
      root.append(card);
    }
  }
  window.openProductXray = async () => { if (!state.options || !state.valid && !state.report) await loadOptions(); else if (state.report && !await verify()) await loadOptions(); };
  window.cancelProductXray = () => { if (state.controller) { stop(); status('Preparación cancelada al cambiar de reporte.'); } };
  window.addEventListener('focus', () => { if (state.valid && byId('workspace').getClientRects().length) verify(); });
  setInterval(() => { if (!document.hidden && state.valid && byId('workspace').getClientRects().length) verify(); }, 60000);
})();
