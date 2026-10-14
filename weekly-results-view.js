(() => {
  const workspace = document.getElementById('weekly-results-workspace');
  const refresh = document.getElementById('weekly-results-refresh');
  const form = document.getElementById('weekly-results-form');
  const weeks = document.getElementById('weekly-results-weeks');
  const includeInventory = document.getElementById('weekly-results-inventory');
  const status = document.getElementById('weekly-results-status');
  const progress = document.getElementById('weekly-results-progress');
  const container = document.getElementById('weekly-results-table');
  const warnings = document.getElementById('weekly-results-warnings');
  const dialog = document.getElementById('weekly-results-detail');
  const detailBody = document.getElementById('weekly-results-detail-body');
  const dailyDialog = document.getElementById('weekly-results-daily');
  const dailyLocation = document.getElementById('weekly-results-daily-location');
  const dailyStatus = document.getElementById('weekly-results-daily-status');
  const dailyBody = document.getElementById('weekly-results-daily-body');
  const pdfButton = document.getElementById('weekly-results-pdf');
  const xlsxButton = document.getElementById('weekly-results-xlsx');
  const exportDialog = document.getElementById('weekly-results-export');
  const exportBody = document.getElementById('weekly-results-export-body');
  const exportStatus = document.getElementById('weekly-results-export-status');
  const exportDownload = document.getElementById('weekly-results-export-download');
  const states = { 'no-data': 'Sin datos', 'no-physical-count': 'Sin toma física',
    'no-opening-inventory': 'Sin inventario inicial', incomplete: 'Incompleto', pending: 'Pendiente', partial: 'Parcial', 'not-included': 'No incluido',
    'weekly-only': 'Solo total semanal', future: 'Sin transcurrir' };
  const date = iso => iso ? new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T12:00:00Z`)) : '—';
  let controller = null, generation = 0;
  let dailyController = null, dailyGeneration = 0, dailyReport = null;
  const dailyCache = new Map();
  let exportData = null, exportUrl = null, exportFilename = null, exportGeneration = 0;
  const paragraph = (parent, content) => {
    const p = document.createElement('p'); p.textContent = content; parent.append(p); return p;
  };
  const partialTag = cell => {
    const tag = document.createElement('span'); tag.className = 'weekly-results-partial'; tag.textContent = 'Parcial'; cell.append(tag);
  };
  function closeExport() {
    exportGeneration++;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = null; exportFilename = null; exportDownload.disabled = true;
    exportBody.replaceChildren(); exportDialog.setAttribute('aria-busy', 'false');
  }
  function resetExport() {
    exportData = null; pdfButton.disabled = true; xlsxButton.disabled = true;
    if (exportDialog.open) exportDialog.close();
    closeExport();
  }
  async function openExport(format) {
    if (!exportData) return;
    closeExport();
    const snapshot = exportData, request = exportGeneration;
    document.getElementById('weekly-results-export-title').textContent = `Previsualización ${format.toUpperCase()} · Resultados Semanales`;
    exportDownload.textContent = `Descargar ${format.toUpperCase()}`;
    exportDialog.showModal(); exportDialog.setAttribute('aria-busy', 'true'); setStatus(exportStatus, 'Preparando previsualización…');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (snapshot !== exportData || request !== exportGeneration || !exportDialog.open) return;
    try {
      const api = window.WeeklyResultsExport;
      if (!api) throw Error('No se pudo cargar el módulo de exportación. Recarga la página.');
      const computed = getComputedStyle(workspace), color = variable => {
        // Resolve theme colors to RGB before serializing them into the files.
        const probe = document.createElement('span'); probe.style.color = computed.getPropertyValue(variable).trim(); workspace.append(probe);
        const rgb = getComputedStyle(probe).color.match(/\d+/g); probe.remove();
        return rgb?.length >= 3 ? '#' + rgb.slice(0, 3).map(channel => Number(channel).toString(16).padStart(2, '0')).join('') : undefined;
      };
      const palette = Object.fromEntries(Object.entries({ bg: '--bg', soft: '--bg-soft', text: '--text', muted: '--text-muted', border: '--border', positive: '--green', difference: '--red' })
        .map(([key, variable]) => [key, color(variable)]).filter(([, value]) => value));
      const fontSize = parseFloat(getComputedStyle(container.querySelector('table')).fontSize) * .75;
      const report = api.model(snapshot, palette, Math.max(9, fontSize));
      let blob;
      if (format === 'pdf') {
        if (!window.jspdf?.jsPDF) throw Error('No se pudo cargar el generador PDF. Recarga la página.');
        blob = api.pdf(report, window.jspdf.jsPDF).output('blob');
      } else {
        const book = api.workbook(report, XLSX);
        blob = new Blob([api.styledWorkbookBytes(book, XLSX)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      exportUrl = URL.createObjectURL(blob); exportFilename = `Resultados_Semanales_${snapshot.date}_${snapshot.weeks.length}_semanas.${format}`;
      if (format === 'pdf') {
        const frame = document.createElement('iframe'); frame.className = 'weekly-results-pdf-preview'; frame.title = 'Previsualización PDF de Resultados Semanales'; frame.src = exportUrl; exportBody.append(frame);
      } else {
        const context = paragraph(exportBody, report.context); context.className = 'weekly-results-export-context';
        const preview = container.firstElementChild.cloneNode(true);
        preview.querySelectorAll('button').forEach(button => button.remove());
        preview.setAttribute('aria-label', 'Previsualización XLSX de Resultados Semanales'); exportBody.append(preview);
        report.notes.forEach(note => paragraph(exportBody, note));
      }
      exportDownload.disabled = false;
      setStatus(exportStatus, format === 'pdf' ? 'PDF horizontal listo. Conceptos y encabezados se repiten en cada página.' : 'XLSX listo. Primera columna y encabezados fijos; valores numéricos y formato del reporte conservados.', 'success');
    } catch (error) { setStatus(exportStatus, error.message, 'error'); }
    finally { exportDialog.setAttribute('aria-busy', 'false'); }
  }
  async function readStream(response, receive) {
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw Error(failure.error || `La solicitud falló (${response.status}).`);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.trim()) receive(JSON.parse(line));
      if (chunk.done) break;
    }
    if (pending.trim()) receive(JSON.parse(pending));
  }
  function metricCells(row, key, result, weekStart = false) {
    const metric = result?.values[key], showPercent = metric?.showPercent !== false;
    const amount = row.insertCell(), percent = row.insertCell();
    if (weekStart) amount.classList.add('weekly-results-week-start');
    amount.classList.add('weekly-results-amount'); percent.classList.add('weekly-results-percent');
    if (!metric?.available) {
      amount.textContent = states[metric?.status] || 'Sin datos'; percent.textContent = showPercent ? '—' : '';
      amount.classList.add('weekly-results-unavailable');
    } else {
      amount.textContent = formatClp(metric.amount);
      if (key === 'inventoryShortage') {
        const inventory = result.inventory;
        if (inventory?.initialDate && inventory?.finalDate) {
          const dates = document.createElement('span'); dates.className = 'weekly-results-inventory-dates';
          dates.textContent = `${date(inventory.initialDate)} → ${date(inventory.finalDate)}`;
          dates.title = `Inventario inicial: ${date(inventory.initialDate)} · Inventario final: ${date(inventory.finalDate)}`;
          amount.append(dates);
        }
      } else if (metric.status === 'partial') partialTag(amount);
      percent.textContent = !showPercent ? '' : metric.percent == null ? '—' : `${metric.percent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      if (showPercent && metric.percentPartial && metric.percent != null && key !== 'inventoryShortage') partialTag(percent);
      if (key === 'collectionDifference') amount.classList.add(metric.amount === 0 ? 'weekly-results-balanced' : 'weekly-results-difference');
    }
  }
  function metricRow(body, key, label) {
    const row = body.insertRow(); row.dataset.metric = key;
    if (['mercadoPagoTips', 'cashTips'].includes(key)) row.className = 'weekly-results-tip-breakdown';
    if (['grossSales', 'discounts', 'grossSalesAfterDiscounts', 'mercadoPagoTips', 'cashTips'].includes(key)) row.classList.add('weekly-results-breakdown');
    if (['netSales', 'inventoryConsumptionTotal'].includes(key)) row.className = 'weekly-results-subtotal';
    const th = document.createElement('th'); th.scope = 'row'; th.textContent = label; row.append(th);
    return row;
  }
  function cancelDaily(close = false) {
    dailyController?.abort(); dailyController = null; dailyGeneration++;
    dailyDialog.setAttribute('aria-busy', 'false');
    if (close && dailyDialog.open) dailyDialog.close();
  }
  function renderDaily(detail, weeklyResult) {
    const wrap = document.createElement('div'); wrap.className = 'weekly-results-table-wrap'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Detalle diario y total semanal; tabla desplazable');
    const table = document.createElement('table'); table.className = 'weekly-results-table weekly-results-daily-table';
    const head = table.createTHead(), daysRow = head.insertRow(), unitsRow = head.insertRow();
    const concept = document.createElement('th'); concept.textContent = 'Concepto'; concept.rowSpan = 2; concept.scope = 'col'; daysRow.append(concept);
    for (const day of [...detail.days, null]) {
      const th = document.createElement('th'); th.colSpan = 2; th.scope = 'colgroup';
      th.textContent = day ? `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))} · ${date(day.date)}` : 'Total semana';
      if (!day) th.className = 'weekly-results-weekly-total';
      daysRow.append(th);
      for (const unit of ['Importe', '%']) {
        const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = unit; unitsRow.append(cell);
      }
    }
    const body = table.createTBody();
    for (const [key, label] of detail.metrics) {
      const row = metricRow(body, key, label);
      for (const day of detail.days) metricCells(row, key, day);
      metricCells(row, key, weeklyResult, true);
      row.cells[row.cells.length - 2].classList.add('weekly-results-weekly-total');
    }
    wrap.append(table); dailyBody.replaceChildren(wrap);
    const messages = [...new Set(detail.days.flatMap(day => (day.warnings || []).map(message => `${date(day.date)}: ${message}`)))];
    if (messages.length) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'Cobertura del detalle diario'; details.append(summary);
      messages.forEach(message => paragraph(details, message)); dailyBody.append(details);
    }
  }
  async function loadDaily() {
    cancelDaily();
    const { data, week } = dailyReport;
    const location = data.locations.find(item => item.id === dailyLocation.value);
    const weeklyResult = week.locations.find(item => item.locationId === location.id);
    const key = `${data.date}:${week.period.from}:${location.id}`, request = dailyGeneration;
    dailyBody.replaceChildren();
    if (dailyCache.has(key)) {
      renderDaily(dailyCache.get(key), weeklyResult); setStatus(dailyStatus, 'Detalle diario actualizado.', 'success'); return;
    }
    const active = new AbortController(); dailyController = active;
    dailyDialog.setAttribute('aria-busy', 'true'); setStatus(dailyStatus, 'Calculando detalle diario…');
    try {
      const params = new URLSearchParams({ from: week.period.from, date: data.date, location: location.id });
      const response = await fetch(`/api/weekly-results/daily/stream?${params}`, { signal: active.signal });
      let result = null;
      await readStream(response, event => {
        if (request !== dailyGeneration) return;
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'result') result = event.data;
        if (event.type === 'progress') setStatus(dailyStatus, `${event.completed} de ${event.total} días calculados`);
      });
      if (request !== dailyGeneration) return;
      if (!result) throw Error('Se interrumpió el cálculo del detalle diario. Vuelve a abrirlo para reintentar.');
      dailyCache.set(key, result); renderDaily(result, weeklyResult); setStatus(dailyStatus, 'Detalle diario actualizado.', 'success');
    } catch (error) {
      active.abort();
      if (request === dailyGeneration && error.name !== 'AbortError') setStatus(dailyStatus, error.message, 'error');
    } finally {
      if (request === dailyGeneration) { dailyController = null; dailyDialog.setAttribute('aria-busy', 'false'); }
    }
  }
  function openDaily(data, week) {
    dailyReport = { data, week };
    document.getElementById('weekly-results-daily-title').textContent = `Detalle Diario · ${date(week.period.from)} – ${date(week.period.to)}`;
    dailyLocation.replaceChildren(...data.locations.map(location => {
      const option = document.createElement('option'); option.value = location.id; option.textContent = location.name; return option;
    }));
    dailyDialog.showModal(); loadDaily();
  }
  function openDetail(data, week, location, result) {
    document.getElementById('weekly-results-detail-title').textContent = `${location.name} · ${date(week.period.from)} – ${date(week.period.to)}`;
    detailBody.replaceChildren();
    paragraph(detailBody, `Fecha de consulta: ${date(data.date)} · Datos calendario: ${date(week.period.from)} – ${date(week.period.through)}`);
    const inventory = result?.inventory;
    paragraph(detailBody, `Inventario: ${states[inventory?.status] || (inventory?.status === 'complete' ? 'Calculado' : 'Sin datos')}`);
    paragraph(detailBody, `Toma inicial: ${date(inventory?.initialDate)} · Toma final: ${date(inventory?.finalDate)}`);
    paragraph(detailBody, inventory?.movements
      ? `Movimientos: ${date(inventory.movements.from)} – ${date(inventory.movements.to)}. El día de la toma final queda excluido; no se prorratea el intervalo.`
      : 'No hay un intervalo de inventario calculable.');
    const coverage = inventory?.coverage;
    if (coverage) {
      paragraph(detailBody, `Inventario valorizado: ${coverage.coveredItemCount ?? 0} de ${coverage.totalItemCount ?? 0} artículos.`);
      for (const [key, label] of [['missingPhysicalCodes', 'Sin toma final'], ['missingCostCodes', 'Sin costo'], ['excludedOpeningCodes', 'Sin apertura calculable']]) {
        if (coverage[key]?.length) paragraph(detailBody, `${label}: ${coverage[key].join(', ')}`);
      }
    }
    const labels = { sales: 'Ventas', margin: 'Margen', payments: 'Pagos TotEat', mercadoPago: 'Mercado Pago', mercadoPagoFee: 'Comision Mercadopago',
      marketing: 'Marketing', employees: 'Consumo personal', waste: 'Merma', inventory: 'Inventario' };
    for (const [key, label] of Object.entries(labels)) {
      const source = result?.sources?.[key];
      const heading = document.createElement('h4'); heading.textContent = label; detailBody.append(heading);
      if (!source || (Array.isArray(source) && !source.length)) {
        paragraph(detailBody, key === 'inventory' && inventory?.status === 'not-included' ? 'Cálculo no incluido en este reporte.' : 'Sin fuente disponible.');
        continue;
      }
      if (source.label || source.name) paragraph(detailBody, source.label || source.name);
      const files = Array.isArray(source) ? source : source.files || (source.name && source.range ? [source] : []);
      for (const file of files) paragraph(detailBody, `${file.name || 'Archivo'}${file.range ? ` · ${date(file.range.from)} – ${date(file.range.to)}` : ''}`);
      if (source.dates) paragraph(detailBody, `Fechas registradas: ${source.dates.map(date).join(', ') || '—'}`);
      if (source.costCutoff) paragraph(detailBody, `Valorización al corte: ${date(source.costCutoff)}`);
      if (source.detectedFields) {
        paragraph(detailBody, `Columnas de comisión: ${source.detectedFields.join(', ') || 'Sin columna reconocida'}`);
        paragraph(detailBody, `Movimientos con fees: ${source.transactionsWithFee} de ${source.transactions}. Importe cobrado sin conversión de IVA.`);
      }
      if (source.costSources) {
        const names = { recipe: 'Receta', purchase: 'Compra', master: 'Maestro', 'sales-export': 'Archivo de ventas', missing: 'Sin costo' };
        paragraph(detailBody, `Líneas de venta por fuente de costo: ${Object.entries(source.costSources).map(([key, count]) => `${names[key] || key}: ${count}`).join(' · ')}`);
      }
      if (source.missingCostProducts?.length) paragraph(detailBody, `Productos vendidos sin costo: ${source.missingCostProducts.map(item => item.code || item.name).join(', ')}`);
      if (source.catalog) paragraph(detailBody, `Catálogo: ${source.catalog.name} · vigente desde ${date(source.catalog.validFrom)}`);
      if (source.range && !files.length) paragraph(detailBody, `Cobertura: ${date(source.range.from)} – ${date(source.range.to)}`);
      if (source.excluded?.length) paragraph(detailBody, `Artículos excluidos: ${source.excluded.map(item => `${item.code}: ${item.reason}`).join('; ')}`);
      if (result.values[key]?.missingCostCodes?.length) paragraph(detailBody, `Sin costo: ${result.values[key].missingCostCodes.join(', ')}`);
    }
    if (result?.warnings?.length) {
      const heading = document.createElement('h4'); heading.textContent = 'Cobertura y observaciones'; detailBody.append(heading);
      result.warnings.forEach(message => paragraph(detailBody, message));
    }
    dialog.showModal();
  }
  function render(data) {
    exportData = data; pdfButton.disabled = !data.locations.length; xlsxButton.disabled = !data.locations.length;
    document.getElementById('weekly-results-context').textContent = `Consulta: ${date(data.date)} · ${data.locations.length} sucursales · ${data.weeks.length} semanas · Inventario ${data.options?.includeInventory === false ? 'no incluido' : 'incluido'} · Semana actual acumulada hasta ${date(data.date)}`;
    if (!data.locations.length) { paragraph(container, 'No hay cafeterías activas para mostrar.'); return; }
    const wrap = document.createElement('div'); wrap.className = 'weekly-results-table-wrap';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Resultados semanales por sucursal; tabla desplazable');
    const table = document.createElement('table'); table.className = 'weekly-results-table';
    const head = table.createTHead(), weeksRow = head.insertRow(), storesRow = head.insertRow(), unitsRow = head.insertRow();
    const concept = document.createElement('th'); concept.textContent = 'Concepto'; concept.rowSpan = 3; concept.scope = 'col'; weeksRow.append(concept);
    for (const [index, week] of data.weeks.entries()) {
      const th = document.createElement('th'); th.colSpan = data.locations.length * 2; th.scope = 'colgroup'; th.className = 'weekly-results-week-start';
      const heading = document.createElement('div'); heading.className = 'weekly-results-week-heading';
      const weekLabel = document.createElement('span');
      weekLabel.textContent = `${index === 0 ? 'Semana actual' : `Hace ${index} semana${index === 1 ? '' : 's'}`} · ${date(week.period.from)} – ${date(week.period.to)}`;
      const dailyButton = document.createElement('button'); dailyButton.type = 'button'; dailyButton.className = 'secondary weekly-results-daily-button'; dailyButton.textContent = 'Detalle Diario';
      dailyButton.setAttribute('aria-label', `Detalle Diario de la semana del ${date(week.period.from)}`);
      dailyButton.addEventListener('click', () => openDaily(data, week));
      heading.append(weekLabel, dailyButton); th.append(heading);
      weeksRow.append(th);
      for (const [storeIndex, location] of data.locations.entries()) {
        const result = week.locations.find(item => item.locationId === location.id);
        const store = document.createElement('th'); store.colSpan = 2; store.scope = 'colgroup';
        if (!storeIndex) store.className = 'weekly-results-week-start';
        const label = document.createElement('span'); label.textContent = location.name; store.append(label);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'weekly-results-review'; button.textContent = 'Fechas y fuentes';
        button.setAttribute('aria-label', `Revisar fechas y fuentes de ${location.name}, semana del ${date(week.period.from)}`);
        button.addEventListener('click', () => openDetail(data, week, location, result)); store.append(button); storesRow.append(store);
        for (const unit of ['Importe', '%']) {
          const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = unit;
          if (!storeIndex && unit === 'Importe') cell.className = 'weekly-results-week-start';
          unitsRow.append(cell);
        }
      }
    }
    const body = table.createTBody();
    for (const [key, label] of data.metrics) {
      const row = metricRow(body, key, label);
      for (const week of data.weeks) for (const [storeIndex, location] of data.locations.entries()) {
        const result = week.locations.find(item => item.locationId === location.id);
        metricCells(row, key, result, !storeIndex);
      }
    }
    wrap.append(table); container.append(wrap);
    if (data.warnings.length) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'Cobertura y criterios de cálculo'; details.append(summary);
      data.warnings.forEach(message => paragraph(details, message)); warnings.append(details);
    }
  }
  window.cancelCafeWeeklyResults = () => {
    if (exportDialog.open) exportDialog.close();
    closeExport();
    cancelDaily(true); dailyCache.clear();
    controller?.abort(); controller = null; generation++;
    refresh.disabled = false; workspace.setAttribute('aria-busy', 'false'); progress.hidden = true;
  };
  window.loadCafeWeeklyResults = async () => {
    if (!form.reportValidity()) return;
    window.cancelCafeWeeklyResults();
    resetExport();
    const active = new AbortController(), request = generation;
    controller = active; refresh.disabled = true; workspace.setAttribute('aria-busy', 'true');
    progress.hidden = false; progress.value = 0;
    container.replaceChildren(); warnings.replaceChildren();
    document.getElementById('weekly-results-context').textContent = '';
    setStatus(status, 'Calculando resultados semanales…');
    const params = new URLSearchParams({ weeks: weeks.value, includeInventory: includeInventory.value });
    try {
      const response = await fetch(`/api/weekly-results/stream?${params}`, { signal: active.signal });
      let data = null;
      const receive = event => {
        if (request !== generation) return;
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'result') data = event.data;
        if (event.type === 'progress') {
          progress.value = event.total ? event.completed / event.total * 100 : 100;
          setStatus(status, `${Math.round(progress.value)}% · ${event.completed} de ${event.total} cálculos${event.location ? ` · ${event.location}` : ''}`);
        }
      };
      await readStream(response, receive);
      if (request !== generation) return;
      if (!data) throw Error('Se interrumpió el cálculo. Pulsa Actualizar para volver a intentarlo.');
      render(data); progress.value = 100; setStatus(status, 'Resultados semanales actualizados.', 'success');
    } catch (error) {
      active.abort();
      if (request === generation && error.name !== 'AbortError') setStatus(status, error.message, 'error');
    } finally {
      if (request === generation) { controller = null; refresh.disabled = false; workspace.setAttribute('aria-busy', 'false'); }
    }
  };
  window.openCafeWeeklyResults = () => {
    if (!controller && !container.childElementCount) setStatus(status, 'Selecciona las opciones y pulsa Actualizar para generar el reporte.');
  };
  form.addEventListener('submit', event => { event.preventDefault(); window.loadCafeWeeklyResults(); });
  form.addEventListener('change', () => {
    window.cancelCafeWeeklyResults();
    resetExport();
    if (dialog.open) dialog.close();
    container.replaceChildren(); warnings.replaceChildren();
    document.getElementById('weekly-results-context').textContent = '';
    setStatus(status, 'Pulsa Actualizar para aplicar las opciones seleccionadas.');
  });
  document.getElementById('weekly-results-detail-close').addEventListener('click', () => dialog.close());
  document.getElementById('weekly-results-daily-close').addEventListener('click', () => dailyDialog.close());
  dailyDialog.addEventListener('close', () => cancelDaily());
  dailyLocation.addEventListener('change', () => loadDaily());
  pdfButton.addEventListener('click', () => openExport('pdf'));
  xlsxButton.addEventListener('click', () => openExport('xlsx'));
  document.getElementById('weekly-results-export-close').addEventListener('click', () => exportDialog.close());
  exportDialog.addEventListener('close', closeExport);
  exportDownload.addEventListener('click', () => {
    if (!exportUrl || !exportFilename) return;
    const link = document.createElement('a'); link.href = exportUrl; link.download = exportFilename;
    document.body.append(link); link.click(); link.remove();
  });
  window.openCafeWeeklyResults();
})();
