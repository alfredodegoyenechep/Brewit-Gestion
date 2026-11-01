/* Shared, DOM-free document data for complete XLSX/PDF exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProductXrayDocument = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const reportsFor = snapshot => snapshot.type === 'collection' ? snapshot.reports : [snapshot];
  const money = n => n == null ? 'Sin dato' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
  const count = n => n == null ? 'Sin dato' : Number(n).toLocaleString('es-CL', { maximumFractionDigits: 2 });
  const percent = n => n == null ? 'Sin dato' : `${Number(n).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const money2 = n => n == null ? 'Sin dato' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const preciseMoney = n => n == null ? 'Sin dato' : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n);
  const preciseCount = n => n == null ? 'Sin dato' : Number(n).toLocaleString('es-CL', { maximumFractionDigits: 6 });
  const formatters = { money, count, percent, money2, preciseMoney, preciseCount };
  const source = v => ({ recipe: 'Receta', purchase: 'Compra', master: 'Maestro', missing: 'Sin costo', 'sales-export': 'Costo registrado en venta' })[v] || v;
  const coverage = v => ({ complete: 'Completa', partial: 'Parcial', no_data: 'Sin datos' })[v] || v;
  function tables(r) {
    const out = [], add = (title, headers, rows, formats = [], group = title) => out.push({ title, headers, rows, formats, group });
    add('Resumen y criterios', ['Campo', 'Valor'], [
      ['Producto', r.family.name], ['Cafetería', r.scope.label], ['Desde', r.period.from], ['Hasta', r.period.to],
      ['Jerarquía', r.family.path.join(' / ') || 'Sin jerarquía'], ['Códigos', r.family.codes.join(' / ')],
      ['Barra', ({ hot: 'Caliente', cold: 'Fría' })[r.family.bar] || 'Sin clasificación'], ['Clasificación', r.family.classificationLabel],
      ['Unidades del período', count(r.selected.total.units)], ['Venta neta del período', money(r.selected.total.netSales)], ['Cobertura de ventas', coverage(r.selected.status)],
      ['Pedidos de consumo', r.consumption.orders], ['Fechas con actividad', r.consumption.dates],
      ['Cobertura género unidades %', r.consumption.genderCoverageUnits], ['Cobertura género pedidos %', r.consumption.genderCoverageOrders],
      ['Ajustes excluidos de consumo: unidades', r.consumption.excludedAdjustments.units], ['Ajustes excluidos de consumo: venta neta', money(r.consumption.excludedAdjustments.netSales)],
      ['Perfil', r.conclusion.status], ['Reglas del perfil', '100 pedidos y 7 fechas. Predominio >=50,0% y ventaja >=15,0 puntos en dos dimensiones; género con cobertura >=50,0%.'],
      ['Versión fuentes', r.sourceVersion], ['Teórico vigente al', r.referenceDate], ['Último mes completo desde', r.lastMonth.from], ['Último mes completo hasta', r.lastMonth.to], ['Cobertura último mes', r.lastMonth.coverage.complete ? 'Completa' : 'Parcial / sin fuente'], ['Generado', r.generatedAt], ...r.conclusion.statements.map(s => ['Conclusión', s]),
      ...r.methodology.map(s => ['Criterio', s]), ...r.warnings.map(s => ['Advertencia', s])
    ]);
    if (r.sizeMix) add('Participación por tamaño', ['Tamaño', 'Códigos', 'Unidades de consumo', 'Participación %'], r.sizeMix.rows.map(f => [f.format, f.codes.join(' / '), f.units, f.percent]), [null, null, 'count', 'percent']);
    add('Margen teórico vigente', ['Formato', 'Código', 'Local', 'Precio lista vigente con IVA', 'Precio neto', 'Costo disponible', 'Margen unitario $', 'Margen %', 'Origen', 'Fecha', 'Estado'],
      r.formats.flatMap(p => p.references.map(v => [p.format, p.code, v.location, v.priceGross, v.priceNet, v.cost, v.margin, v.marginPercent, source(v.source), v.date,
        v.margin == null ? `Margen no calculable: ${v.reason || 'precio sin información'}` : 'Precio y costo netos'])), [null, null, null, 'money', 'money2', 'money2', 'money2', 'percent']);
    add('Venta real del período', ['Formato', 'Código', 'Unidades', 'Venta neta', 'Precio real medio con IVA', 'Precio real medio neto', 'Costo neto total', 'Costo por unidad', 'Margen total $', 'Margen por unidad', 'Margen %', 'Estado'],
      r.formats.map(p => { const a = p.actual; return [p.format, p.code, a.units, a.netSales, a.priceGross, a.priceNet, a.cost, a.unitCost, a.margin, a.unitMargin, a.marginPercent,
        a.margin == null ? `Margen no calculable: ${a.units <= 0 ? 'sin unidades positivas netas' : a.reasons.join('; ') || 'información incompleta'}` : 'Costos netos a fecha de venta']; }),
      [null, null, 'count', 'money', 'money2', 'money2', 'money2', 'money2', 'money2', 'money2', 'percent']);
    add('Último mes real', ['Formato', 'Código', 'Unidades', 'Venta neta', 'Precio real medio con IVA', 'Precio real medio neto', 'Costo real medio neto', 'Margen real unitario', 'Margen real %'], r.formats.map(p => { const a = p.lastMonthActual; return [p.format, p.code, a.units, a.netSales, a.priceGross, a.priceNet, a.unitCost, a.unitMargin, a.marginPercent]; }), [null, null, 'count', 'money', 'money2', 'money2', 'money2', 'money2', 'percent']);
    for (const p of r.formats) {
      for (const ref of p.references) if (ref.breakdown) {
        const b = ref.breakdown;
        add(`Comparación ingredientes ${p.code}`, ['Formato / código', 'Local', 'Ingrediente', 'Unidad', 'Cantidad teórica / producto', 'Costo neto teórico / unidad', 'Aporte teórico / producto', 'Cantidad real media / producto', 'Costo real medio / unidad', 'Aporte real medio / producto'], ref.ingredientComparison.map(i => [`${p.format} · ${p.code}`, ref.location, `${i.code} · ${i.name}`, i.unit, i.theoreticalQuantity, i.theoreticalUnitCost, i.theoreticalCost, i.realQuantityPerProduct, i.realUnitCost, i.realCostPerProduct]), [null, null, null, null, 'preciseCount', 'preciseMoney', 'preciseMoney', 'preciseCount', 'preciseMoney', 'preciseMoney'], 'Comparación ingredientes');
        add(`Cantidades costo ${p.code}`, ['Formato / código', 'Local', 'Receta padre', 'Código', 'Ingrediente / envase', 'Cantidad por producto', 'Rendimiento %', 'Cantidad efectiva', 'Unidad'],
          b.rows.map(i => [`${p.format} · ${p.code}`, ref.location, i.parentCode, i.code, i.name, i.quantity, i.yieldRate, i.effectiveQuantity, i.unit]),
          [null, null, null, null, null, 'preciseCount', 'percent', 'preciseCount'], 'Cantidades costo');
        add(`Aportes costo ${p.code}`, ['Formato / código', 'Local', 'Código', 'Ingrediente / envase', 'Costo neto / unidad', 'Aporte neto', 'Cómputo', 'Origen', 'Fecha', 'Local de compra'],
          b.rows.map(i => [`${p.format} · ${p.code}`, ref.location, i.code, i.name, i.unitCost, i.totalCost, i.includedInTotal ? 'Incluido en total' : 'Subtotal subreceta: no sumar', source(i.source), i.date, i.location]),
          [null, null, null, null, 'preciseMoney', 'preciseMoney'], 'Aportes costo');
        add(`Total costo ${p.code}`, ['Formato / código', 'Local', 'Costo neto total', 'Subtotal observado', 'Estado'], [[`${p.format} · ${p.code}`, ref.location, b.totalNet, b.observedNet, b.reason || 'Componentes finales conciliados; subtotales no duplicados']],
          [null, null, 'money2', 'money2'], 'Totales costo');
      }
      add(`Receta ${p.code}`, ['Receta padre', 'Código', 'Ingrediente', 'Tipo', 'Cantidad', 'Unidad', 'Rendimiento %', 'Cantidad ajustada', 'Clasificación principal'],
        p.recipe.ingredients.map(i => [i.parentCode, i.code, i.name, i.packaging ? 'Packaging' : 'Ingrediente', i.quantity, i.unit, i.yieldRate, i.effectiveQuantity, p.recipe.evidence.find(e => e.code === i.code)?.label || '']),
        [null, null, null, null, 'count', null, 'percent', 'count'], 'Recetas');
      add(`Evidencia ${p.code}`, ['Formato', 'Código', 'Capacidad explícita', 'Estado de receta', 'Observaciones'], [[p.format, p.code, p.recipe.capacity.join(' / '), p.recipe.complete ? 'Completa' : 'Clasificación incompleta',
        [...p.recipe.problems, ...p.recipe.evidence.map(e => `${e.label}: ${e.name} (${e.code})`), 'Cantidades por receta padre; subrecetas y rendimientos convertidos por el motor de costos.'].join(' · ')]], [], 'Evidencia recetas');
      add(`Costos efectivos ${p.code}`, ['Local ID', 'Origen', 'Fecha', 'Costo disponible', 'Base', 'Local de compra'], p.actual.sources.map(s => [s.locationId, source(s.source), s.date, s.cost, s.reason || 'Costo neto', s.sourceLocation]), [null, null, null, 'money2'], 'Costos efectivos');
    }
    add('Ventas y evolución', ['Período', 'Desde', 'Hasta', 'Formato', 'Unidades', 'Venta neta', 'Cobertura'],
      [r.selected, ...r.history].flatMap((m, i) => [[i ? m.from.slice(0, 7) : 'Período seleccionado', m.from, m.to, 'Total', m.total.units, m.total.netSales, coverage(m.status)],
        ...m.formats.map(f => [i ? m.from.slice(0, 7) : 'Período seleccionado', m.from, m.to, `${f.format} · ${f.code}`, f.units, f.netSales, coverage(m.status)])]), [null, null, null, null, 'count', 'money']);
    for (const [title, rows] of [['Género', r.consumption.gender], ['Franjas horarias', r.consumption.hours], ['Días de la semana', r.consumption.weekdays]])
      add(title, ['Segmento', 'Unidades', 'Participación %', 'Pedidos únicos', 'Venta neta'], rows.map(v => [v.label, v.units, v.percent, v.orders, v.netSales]), [null, 'count', 'percent', 'count', 'money']);
    add('Acompañamientos', ['Categoría', 'Pedidos', 'Participación %'], [['Bollería', r.accompanies.bakery.orders, r.accompanies.bakery.percent], ['Sándwiches', r.accompanies.sandwich.orders, r.accompanies.sandwich.percent], ['Ambas en el mismo pedido', r.accompanies.both?.orders ?? 0, r.accompanies.both?.percent ?? null], ['Cualquiera de ambas, sin duplicar', r.accompanies.either.orders, r.accompanies.either.percent]], [null, 'count', 'percent']);
    if (r.clusters) {
      const c = r.clusters;
      add('Conclusión clusters', ['Campo', 'Resultado'], [['Resultado', c.conclusion], ['Diagnóstico', c.message], ['Pedidos analizados', c.summary.orders], ['Pedidos con información suficiente', c.summary.eligibleOrders], ['Clusters sólidos', c.summary.solidClusters], ['Clusters exploratorios', c.summary.exploratoryClusters], ['Pedidos sin asignar', c.unassigned.orders], ['Base', 'Pedidos completos que contienen el producto, con todos sus formatos y acompañamientos. Venta y ticket corresponden a la canasta completa. Comparaciones por dimensión entre pedidos con ese dato disponible.']]);
      add('Clusters del producto', ['Cluster', 'Estado', 'Pedidos', 'Pedidos %', 'Venta neta canasta', 'Ticket mediano con IVA', 'Fechas', 'Silueta', 'Estabilidad %'], c.clusters.map(v => [v.name, v.status === 'solid' ? 'Sólido' : 'Exploratorio', v.orders, v.orderShare, v.netSales, v.profile.medianTicketGross, v.distinctDates, v.silhouette, v.stability == null ? null : v.stability * 100]), [null, null, 'count', 'percent', 'money', 'money', 'count', 'count', 'percent']);
      add('Perfil de clusters', ['Cluster', 'Característica'], c.clusters.flatMap(v => [
        ...v.differences.map(d => [v.name, d.type === 'categorical' ? `${d.dimensionLabel}: ${d.label} en ${percent(d.prevalence)} del grupo frente a ${percent(d.rest)} del resto.` : `${d.label}: ${count(d.value)} frente a ${count(d.rest)} en el resto.`]),
        [v.name, `Productos frecuentes: ${v.profile.products.map(p => `${p.name} (${percent(p.percent)} de pedidos)`).join('; ')}`],
        ...v.checks.map(check => [v.name, `${check.label}: ${check.passed ? 'Cumple' : 'Pendiente'}`]) ]));
      add('Cobertura de clusters', ['Dimensión', 'Cobertura %', 'Estado'], c.coverage.filter(d => d.requested).map(d => [d.label, d.coverage, d.available ? 'Disponible' : d.reason]), [null, 'percent']);
      add('Parámetros de clusters', ['Parámetro', 'Valor'], [...Object.entries(c.parameters), ['Versión motor', c.version], ['Versión fuentes', c.sourceVersion], ...c.warnings.map(w => ['Advertencia', w])]);
    }
    add('Fuentes', ['Tipo', 'Fuente', 'Vigente desde'], r.sources.map(s => [s.kind, s.name, s.validFrom]));
    return out;
  }
  function pdfTables(report) {
    const excluded = new Set(['Fuentes', 'Cobertura de clusters', 'Parámetros de clusters']);
    const notes = new Set(['Reglas del perfil', 'Versión fuentes', 'Generado', 'Criterio', 'Advertencia']);
    return tables(report).filter(t => !excluded.has(t.title)).map(t => t.title === 'Resumen y criterios' ? { ...t, rows: t.rows.filter(row => !notes.has(row[0])) } : t);
  }
  function workbookTables(snapshot) {
    if (snapshot.type !== 'collection') return tables(snapshot);
    const groups = new Map();
    for (const r of snapshot.reports) for (const t of tables(r)) {
      if (!groups.has(t.group)) groups.set(t.group, { title: t.group, headers: ['Jerarquía', 'Producto', 'Códigos del producto', ...t.headers], formats: [null, null, null, ...t.formats], rows: [] });
      groups.get(t.group).rows.push(...t.rows.map(row => [r.family.path.join(' / ') || 'Sin jerarquía', r.family.name, r.family.codes.join(' / '), ...row]));
    }
    return [...groups.values()];
  }
  const clean = value => String(value ?? 'Sin dato').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/↳/g, '>').replace(/[–—]/g, '-').replace(/\u202f/g, ' ');
  async function createPdf(snapshot, JsPDF, { onProgress = () => {}, isCurrent = () => true } = {}) {
    const reports = reportsFor(snapshot), doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    doc.setProperties({ title: 'X-ray producto', author: 'Brewit', subject: `${snapshot.scope.label} · ${snapshot.period.from} - ${snapshot.period.to}` });
    const width = 273, left = 12, bottom = 192, entries = [], destinations = new Map(); let y = 22, heading = 'X-ray producto';
    const font = (size = 9, bold = false) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(35); };
    const page = () => { doc.addPage(); y = 22; font(10, true); doc.text(doc.splitTextToSize(clean(heading), width)[0], left, 12); };
    const ensure = h => { if (y + h > bottom) page(); };
    function text(value, size = 10, bold = false) { font(size, bold); const lines = doc.splitTextToSize(clean(value), width), lh = size * .45;
      for (const line of lines) { ensure(lh + 2); font(size, bold); doc.text(line, left, y); y += lh; } y += 3; }
    text('X-ray producto', 24, true); text(snapshot.scope.label, 15); text(`${snapshot.period.from} - ${snapshot.period.to}`);
    text(`Selección: ${snapshot.type === 'collection' ? snapshot.hierarchy.join(' / ') || 'Todas las jerarquías' : snapshot.family.name}`);
    text(`${reports.length} fichas de producto, con todos sus formatos disponibles.`);
    text('Orden: jerarquía, subjerarquía y producto. El índice enlaza directamente con cada ficha.');
    text('La participación por tamaño usa unidades de compras positivas válidas del período seleccionado. No se muestra para productos con un solo formato.');
    text('Venta neta de productos sin IVA; extras y adicionales no incluidos. Período seleccionado separado de los seis meses completos anteriores al mes de inicio.');
    text(`Generado: ${snapshot.generatedAt}`);
    // Reserve the exact index layout first; product destinations are filled after pagination.
    let previous = [], indexPage = 2, indexY = 28;
    for (const r of reports) {
      const path = r.family.path.length ? r.family.path : ['Sin jerarquía'];
      let common = 0; while (common < path.length && path[common] === previous[common]) common++;
      for (let depth = common; depth < path.length; depth++) entries.push({ label: path[depth], depth, bold: true });
      entries.push({ label: `${r.family.name} · ${r.family.codes.join(' / ')}`, depth: path.length, id: r.family.id }); previous = path;
    }
    for (const entry of entries) { font(10, entry.bold); entry.lines = doc.splitTextToSize(clean(entry.label), width - entry.depth * 4 - 22); entry.height = entry.lines.length * 5 + 3;
      if (indexY + entry.height > bottom) { indexPage++; indexY = 28; } entry.page = indexPage; entry.y = indexY; indexY += entry.height; }
    for (let p = 2; p <= indexPage; p++) doc.addPage();
    function table(t) {
      const widths = t.headers.length === 2 ? [64, width - 64] : t.headers.map((_, i) => width / t.headers.length);
      font(8);
      const smallHeight = t.rows.length <= 6 ? [t.headers, ...t.rows].reduce((sum, values) => sum + Math.max(1, ...values.map((v, i) => doc.splitTextToSize(clean(v), widths[i] - 4).length)) * 3.8 + 4, 14) : 22;
      ensure(Math.min(smallHeight, bottom - 24)); text(t.title, 12, true);
      const row = (values, isHead = false) => {
        font(8, isHead); let cells = values.map((v, i) => doc.splitTextToSize(clean(v), widths[i] - 4));
        const fullHeight = Math.max(1, ...cells.map(c => c.length)) * 3.8 + 4;
        if (y + fullHeight > bottom && !isHead) { page(); row(t.headers, true); }
        do {
          const capacity = Math.max(1, Math.floor((bottom - y - 4) / 3.8)), pieces = cells.map(c => c.slice(0, capacity));
          const height = Math.max(1, ...pieces.map(c => c.length)) * 3.8 + 4;
          let x = left; doc.setDrawColor(215); doc.setFillColor(...(isHead ? [235, 229, 219] : [255, 255, 255]));
          pieces.forEach((lines, i) => { doc.setFillColor(...(isHead ? [235, 229, 219] : [255, 255, 255])); doc.rect(x, y, widths[i], height, 'FD'); font(8, isHead); if (lines.length) doc.text(lines, x + 2, y + 4, { lineHeightFactor: 1.35 }); x += widths[i]; }); y += height;
          cells = cells.map(c => c.slice(capacity)); if (cells.some(c => c.length)) { page(); row(t.headers, true); }
        } while (cells.some(c => c.length));
      };
      row(t.headers, true);
      for (const values of t.rows) row(values.map((v, i) => formatters[t.formats[i]] ? formatters[t.formats[i]](v) :
        t.title === 'Resumen y criterios' && i === 1 && String(values[0]).includes('%') ? percent(v) : v));
      y += 5;
    }
    function graph(r, metric, title) {
      const series = [{ label: 'Total', key: null }, ...r.formats.map(f => ({ label: `${f.format} (${f.code})`, key: f.code }))];
      const colors = [[150, 90, 40], [30, 120, 110], [210, 125, 45], [105, 105, 175], [165, 70, 110]];
      ensure(86 + Math.ceil(series.length / 4) * 5); text(title, 12, true); const top = y, x0 = left + 28, span = width - 38, h = 50;
      const value = (m, s) => (s.key ? m.formats.find(f => f.code === s.key) : m.total)?.[metric];
      const vals = r.history.flatMap(m => series.map(s => value(m, s))).filter(Number.isFinite), min = Math.min(0, ...vals), max = Math.max(1, ...vals), py = v => top + h - (v - min) / (max - min) * h;
      for (let i = 0; i < 4; i++) { const v = min + (max - min) * i / 3; doc.setDrawColor(220); doc.line(x0, py(v), x0 + span, py(v)); font(7); doc.text(metric === 'netSales' ? money(v) : count(v), x0 - 3, py(v) + 1, { align: 'right' }); }
      r.history.forEach((m, i) => { font(8); doc.text(`${m.from.slice(0, 7)}${m.status === 'partial' ? '*' : ''}`, x0 + i * span / 5, top + h + 6, { align: 'center' }); });
      series.forEach((s, j) => { let prior; doc.setDrawColor(...colors[j % colors.length]); doc.setFillColor(...colors[j % colors.length]);
        r.history.forEach((m, i) => { const v = value(m, s); if (!Number.isFinite(v)) { prior = null; return; } const point = [x0 + i * span / 5, py(v)]; if (prior) doc.line(...prior, ...point); doc.circle(...point, .8, 'F'); prior = point; });
        const x = left + j % 4 * 68, ly = top + h + 13 + Math.floor(j / 4) * 5; doc.line(x, ly - 1, x + 5, ly - 1); font(8); doc.text(clean(s.label), x + 7, ly);
      }); y = top + h + 19 + Math.ceil(series.length / 4) * 5; text('* Cobertura parcial. Sin fuente: sin punto en el gráfico.', 8);
    }
    const outlines = new Map();
    for (let i = 0; i < reports.length; i++) {
      if (!isCurrent()) throw new Error('El informe cambió o se canceló la exportación.');
      const r = reports[i]; heading = `${r.family.path.join(' / ') || 'Sin jerarquía'} · ${r.family.name}`; page(); const destination = doc.getNumberOfPages(); destinations.set(r.family.id, destination);
      let parent = null; for (let depth = 1; depth <= r.family.path.length; depth++) { const key = JSON.stringify(r.family.path.slice(0, depth)); if (!outlines.has(key)) outlines.set(key, doc.outline.add(parent, clean(r.family.path[depth - 1]), { pageNumber: destination })); parent = outlines.get(key); }
      doc.outline.add(parent, clean(r.family.name), { pageNumber: destination });
      text(r.family.name, 19, true); text(`${r.family.path.join(' / ') || 'Sin jerarquía'} · ${r.family.codes.join(' / ')}`);
      for (const t of pdfTables(r)) { if (t.title === 'Participación por tamaño') text(r.sizeMix.basis, 9); table(t); if (t.title === 'Ventas y evolución') { graph(r, 'netSales', 'Evolución de venta neta ($)'); graph(r, 'units', 'Evolución de unidades'); } }
      onProgress(i + 1, reports.length); await new Promise(resolve => setTimeout(resolve, 0));
    }

    for (let p = 2; p <= indexPage; p++) { doc.setPage(p); y = 16; text('Índice de productos', 17, true); }
    for (const entry of entries) { doc.setPage(entry.page); font(10, entry.bold); doc.text(entry.lines, left + entry.depth * 4, entry.y, { lineHeightFactor: 1.4 });
      if (entry.id) { const target = destinations.get(entry.id); doc.text(String(target), left + width, entry.y, { align: 'right' }); doc.link(left, entry.y - 4, width, entry.height, { pageNumber: target }); } }
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) { doc.setPage(p); font(8); doc.text(`${p} / ${pages}`, left + width, 202, { align: 'right' }); if (p > indexPage) { doc.text('Volver al índice', left, 202); doc.link(left, 198, 35, 6, { pageNumber: 2 }); } }
    return { doc, pages, index: reports.map(r => ({ id: r.family.id, name: r.family.name, page: destinations.get(r.family.id) })) };
  }
  return { reportsFor, tables, pdfTables, workbookTables, createPdf };
});
