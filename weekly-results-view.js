(() => {
  const workspace = document.getElementById('weekly-results-workspace');
  const refresh = document.getElementById('weekly-results-refresh');
  const form = document.getElementById('weekly-results-form');
  const weeks = document.getElementById('weekly-results-weeks');
  const periodType = document.getElementById('weekly-results-period');
  const includeCurrent = document.getElementById('weekly-results-current');
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
  const inboundDialog = document.getElementById('weekly-results-inbound');
  const inboundBody = document.getElementById('weekly-results-inbound-body');
  const inboundLabels = { centralWarehouseInbound: 'Entradas Bodega Central', directSupplierInbound: 'Entradas Proveedores Directos', suppliesOutbound: 'Salidas Insumos' };
  const metricLabels = { netSales: 'Venta neta', tips: 'Propinas', inventoryShortage: 'Inventario faltante',
    waste: 'Merma', marketing: 'Marketing', employees: 'Consumo personal', otherConsumables: 'Otros gastos / consumibles', finalInventory: 'Inventario Final' };
  const metricDialog = document.getElementById('weekly-results-metric-detail');
  const metricBody = document.getElementById('weekly-results-metric-body');
  const metricStatus = document.getElementById('weekly-results-metric-status');
  const metricDownload = document.getElementById('weekly-results-metric-xlsx');
  let metricController = null, metricGeneration = 0, metricSnapshot = null, metricVisibleRows = [];
  const metricCache = new Map();
  const pdfButton = document.getElementById('weekly-results-pdf');
  const xlsxButton = document.getElementById('weekly-results-xlsx');
  const exportDialog = document.getElementById('weekly-results-export');
  const exportBody = document.getElementById('weekly-results-export-body');
  const exportStatus = document.getElementById('weekly-results-export-status');
  const exportDownload = document.getElementById('weekly-results-export-download');
  const states = { 'no-data': 'Sin datos', 'no-physical-count': 'Sin toma física',
    'no-opening-inventory': 'Sin inventario inicial', incomplete: 'Incompleto', pending: 'Pendiente', partial: 'Parcial', 'not-included': 'No incluido', 'not-applicable': '—',
    'weekly-only': 'Solo total semanal', 'monthly-only': 'Solo total mensual', future: 'Sin transcurrir' };
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
    document.getElementById('weekly-results-export-title').textContent = `Previsualización ${format.toUpperCase()} · ${window.WeeklyResultsExport.reportTitle(snapshot)}`;
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
      const monthly = snapshot.options?.period === 'month';
      exportUrl = URL.createObjectURL(blob); exportFilename = `Resultados_${monthly ? 'Mensuales' : 'Semanales'}_${snapshot.date}_${snapshot.weeks.length}_${monthly ? 'meses' : 'semanas'}${snapshot.options?.includeCurrent === false ? '_sin_actual' : ''}.${format}`;
      if (format === 'pdf') {
        const frame = document.createElement('iframe'); frame.className = 'weekly-results-pdf-preview'; frame.title = `Previsualización PDF de ${report.title}`; frame.src = exportUrl; exportBody.append(frame);
      } else {
        const context = paragraph(exportBody, report.context); context.className = 'weekly-results-export-context';
        const preview = container.firstElementChild.cloneNode(true);
        preview.querySelectorAll('.weekly-results-inbound-button').forEach(button => button.replaceWith(...button.childNodes));
        preview.querySelectorAll('button').forEach(button => button.remove());
        preview.setAttribute('aria-label', `Previsualización XLSX de ${report.title}`); exportBody.append(preview);
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
  function closeInbound() {
    if (metricDialog.open) metricDialog.close();
    if (inboundDialog.open) inboundDialog.close();
    inboundBody.replaceChildren();
  }
  const detailNumber = value => value.toLocaleString('es-CL', { maximumFractionDigits: 4 });
  const detailText = (column, value) => {
    if (value == null) return '—';
    if (column.type === 'date') return date(value);
    if (column.type === 'currency') return formatClp(value);
    if (column.type === 'unitCost') return value.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 2 });
    if (column.type === 'number') return detailNumber(value);
    return String(value);
  };
  function renderMetricDetail(report) {
    metricSnapshot = report;
    const total = paragraph(metricBody, `${report.partial ? 'Subtotal conocido' : 'Total del reporte'}: ${formatClp(report.total)}`);
    total.className = 'weekly-results-metric-total';
    if (report.partial) paragraph(metricBody, 'Detalle parcial: los importes conocidos suman la cifra del reporte. Puede faltar cobertura del período; los registros sin saldo o costo completo se identifican en el detalle.')
      .className = 'weekly-results-inbound-notice';
    if (report.inventory?.movements) paragraph(metricBody,
      `Tomas físicas: ${date(report.inventory.initialDate)} → ${date(report.inventory.finalDate)} · Movimientos: ${date(report.inventory.movements.from)} – ${date(report.inventory.movements.to)}.`);
    if (report.balanceDate) paragraph(metricBody, `${report.basis === 'physical' ? 'Inventario físico' : 'Inventario teórico al cierre'} · ${date(report.balanceDate)}`);
    if (report.groups?.length) paragraph(metricBody, report.groups.map(group => `${group.label}: ${formatClp(group.amount)}`).join(' · '));
    if (report.costCutoff) paragraph(metricBody, `Valorización al ${date(report.costCutoff)}.`);
    const toolbar = document.createElement('div'); toolbar.className = 'weekly-results-metric-filters';
    const label = document.createElement('label'); label.textContent = 'Buscar en el detalle';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Código, producto, fecha o medio de pago';
    search.id = 'weekly-results-metric-search'; label.htmlFor = search.id; label.append(search);
    const count = document.createElement('span'); count.setAttribute('aria-live', 'polite'); toolbar.append(label, count); metricBody.append(toolbar);
    const wrap = document.createElement('div'); wrap.className = 'weekly-results-metric-table-wrap';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Detalle de ${report.title}; tabla desplazable`);
    const table = document.createElement('table'); table.className = 'weekly-results-metric-table';
    const caption = table.createCaption(); caption.textContent = `${report.title} · ${report.location.name}`;
    const head = table.createTHead().insertRow(), body = table.createTBody();
    const footer = table.createTFoot().insertRow();
    let sortKey = 'amount', ascending = false;
    const headers = [];
    const normalized = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const draw = () => {
      const query = normalized(search.value.trim());
      metricVisibleRows = report.rows.filter(row => !query || report.columns.some(column => normalized(detailText(column, row[column.key])).includes(query)));
      metricVisibleRows.sort((a, b) => {
        if (a[sortKey] == null) return b[sortKey] == null ? 0 : 1;
        if (b[sortKey] == null) return -1;
        const order = typeof a[sortKey] === 'number' ? a[sortKey] - b[sortKey]
          : String(a[sortKey]).localeCompare(String(b[sortKey]), 'es', { numeric: true });
        return ascending ? order : -order;
      });
      headers.forEach((th, index) => th.setAttribute('aria-sort', report.columns[index].key === sortKey ? ascending ? 'ascending' : 'descending' : 'none'));
      body.replaceChildren();
      for (const item of metricVisibleRows) {
        const row = body.insertRow();
        for (const column of report.columns) {
          const cell = row.insertCell(); cell.textContent = detailText(column, item[column.key]);
          if (['number', 'currency', 'unitCost'].includes(column.type)) cell.className = 'numeric';
          if (column.key === 'status' && item.status !== 'Valorizado') cell.className = 'weekly-results-metric-incomplete';
        }
      }
      if (!metricVisibleRows.length) {
        const cell = body.insertRow().insertCell(); cell.colSpan = report.columns.length;
        cell.textContent = query ? 'No hay registros que coincidan con la búsqueda.'
          : report.partial ? 'No hay registros con detalle disponible para este período.' : 'No se registraron movimientos en el período.';
      }
      count.textContent = `${metricVisibleRows.length} de ${report.rows.length} registros`;
      footer.replaceChildren();
      const amountIndex = report.columns.findIndex(column => column.key === 'amount');
      const label = document.createElement('th'); label.scope = 'row'; label.colSpan = amountIndex;
      label.textContent = query ? 'Total de registros visibles' : report.partial ? 'Subtotal conocido' : 'Total del reporte'; footer.append(label);
      footer.insertCell().textContent = formatClp(query ? metricVisibleRows.reduce((sum, row) => sum + (row.amount ?? 0), 0) : report.total);
      for (let index = amountIndex + 1; index < report.columns.length; index++) footer.insertCell();
    };
    for (const column of report.columns) {
      const th = document.createElement('th'); th.scope = 'col';
      const button = document.createElement('button'); button.type = 'button'; button.textContent = column.label;
      button.title = `Ordenar por ${column.label}`;
      button.addEventListener('click', () => { ascending = sortKey === column.key ? !ascending : true; sortKey = column.key; draw(); });
      th.append(button); head.append(th); headers.push(th);
    }
    wrap.append(table); metricBody.append(wrap); search.addEventListener('input', draw); draw();
    (report.notes || []).forEach(note => paragraph(metricBody, note).className = 'panel-description');
    if (report.excluded?.length) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = `Artículos excluidos (${report.excluded.length})`; details.append(summary);
      report.excluded.forEach(item => paragraph(details, `${item.code || '—'} · ${item.name || ''}: ${item.reason}`));
      metricBody.append(details);
    }
    metricDownload.disabled = false;
  }
  async function openMetricDetail(key, result, { location, period }) {
    metricController?.abort();
    const request = ++metricGeneration, active = new AbortController(); metricController = active;
    metricSnapshot = null; metricDownload.disabled = true; metricBody.replaceChildren();
    document.getElementById('weekly-results-metric-title').textContent = metricLabels[key];
    document.getElementById('weekly-results-metric-context').textContent = `${location.name} · ${date(period.from)} – ${date(period.through)}`;
    setStatus(metricStatus, 'Cargando detalle…'); metricDialog.setAttribute('aria-busy', 'true');
    if (!metricDialog.open) metricDialog.showModal();
    const id = result.detailReports[key];
    try {
      let report = metricCache.get(id);
      if (!report) {
        const response = await fetch(`/api/weekly-results/details/${encodeURIComponent(id)}`, { signal: active.signal });
        report = await response.json();
        if (!response.ok) throw Error(report.error || 'No se pudo cargar el detalle.');
      }
      if (request !== metricGeneration || !metricDialog.open) return;
      metricCache.set(id, report); renderMetricDetail(report); setStatus(metricStatus, '');
    } catch (error) {
      if (request === metricGeneration && error.name !== 'AbortError') setStatus(metricStatus, error.message, 'error');
    } finally {
      if (request === metricGeneration) { metricController = null; metricDialog.setAttribute('aria-busy', 'false'); }
    }
  }
  function openInbound(key, result, { location, period }) {
    const source = result.sources[key], metric = result.values[key], items = source.items;
    document.getElementById('weekly-results-inbound-title').textContent = key === 'centralWarehouseInbound' && location.type === 'warehouse' ? 'Reversas / devoluciones' : inboundLabels[key];
    document.getElementById('weekly-results-inbound-context').textContent = `${location.name} · ${date(period.from)} – ${date(period.through)} · Costeo al ${date(source.costCutoff)}`;
    inboundBody.replaceChildren();
    if (!metric.complete) {
      const note = paragraph(inboundBody, 'Detalle parcial: el total corresponde únicamente a los importes conocidos.');
      note.className = 'weekly-results-inbound-notice';
    }
    if (source.unresolvedOriginCount) paragraph(inboundBody, `${source.unresolvedOriginCount} movimientos con ${key === 'suppliesOutbound' ? 'destino' : 'origen'} sin confirmar no se incluyen en el total.`);
    (source.issues || []).forEach(message => paragraph(inboundBody, message));
    paragraph(inboundBody, `${metric.complete ? key === 'suppliesOutbound' ? 'Total de salidas' : 'Total de entradas' : 'Subtotal conocido'}: ${metric.available ? formatClp(metric.amount) : 'Sin datos'}`)
      .className = 'weekly-results-inbound-total';
    const quantity = amount => amount.toLocaleString('es-CL', { maximumFractionDigits: 6 });
    const unitCost = amount => amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const groups = new Map();
    for (const item of items) {
      const identity = JSON.stringify([item.code, item.unit]);
      const group = groups.get(identity) || { code: item.code, name: item.name, unit: item.unit, quantity: 0, amount: 0, known: 0, count: 0, costs: new Set() };
      group.quantity += item.quantity; group.count++;
      if (item.available) { group.amount += item.amount; group.known++; group.costs.add(item.unitCost); }
      groups.set(identity, group);
    }
    const tableFor = (headers, rows, className) => {
      const wrap = document.createElement('div'); wrap.className = 'weekly-results-inbound-table-wrap'; wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', className === 'weekly-results-inbound-summary' ? 'Entradas por ingrediente; tabla desplazable' : 'Movimientos de entradas; tabla desplazable');
      const table = document.createElement('table'); table.className = `weekly-results-inbound-table ${className}`;
      const head = table.createTHead().insertRow();
      for (const label of headers) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell); }
      const body = table.createTBody();
      for (const values of rows) { const row = body.insertRow(); for (const text of values) row.insertCell().textContent = text; }
      wrap.append(table); return { wrap, table };
    };
    if (items.length) {
      const rows = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'es') || a.code.localeCompare(b.code));
      const summary = tableFor(['Código', 'Ingrediente / artículo', 'Cantidad', 'Unidad', 'Costo unitario', 'Importe'], rows.map(item => [
        item.code, item.name, quantity(item.quantity), item.unit,
        !item.known ? 'Sin costo' : item.costs.size === 1 ? unitCost([...item.costs][0]) : 'Variable',
        !item.known ? 'Sin costo' : `${formatClp(item.amount)}${item.known < item.count ? ' · Parcial' : ''}`
      ]), 'weekly-results-inbound-summary');
      const total = summary.table.createTFoot().insertRow();
      const label = document.createElement('th'); label.scope = 'row'; label.colSpan = 5;
      label.textContent = metric.complete ? 'Total de entradas' : 'Subtotal conocido'; total.append(label);
      total.insertCell().textContent = metric.available ? formatClp(metric.amount) : 'Sin costo';
      inboundBody.append(summary.wrap);
      const details = document.createElement('details'), heading = document.createElement('summary');
      heading.textContent = `Ver movimientos (${items.length})`; details.append(heading);
      const movements = tableFor(['Fecha', 'Documento', 'Código', 'Ingrediente / artículo', 'Cantidad', 'Unidad', 'Costo unitario', 'Importe'],
        [...items].sort((a, b) => a.date.localeCompare(b.date) || a.document.localeCompare(b.document, 'es', { numeric: true })).map(item => [
          date(item.date), item.document, item.code, item.name, quantity(item.quantity), item.unit,
          item.available ? unitCost(item.unitCost) : 'Sin costo', item.available ? formatClp(item.amount) : 'Sin costo'
        ]), 'weekly-results-inbound-movements');
      details.append(movements.wrap); inboundBody.append(details);
    } else {
      paragraph(inboundBody, metric.complete ? `No se registraron ${key === 'suppliesOutbound' ? 'salidas' : 'entradas'} de este tipo en el período seleccionado.` : 'No hay movimientos con detalle disponible para el período seleccionado.');
    }
    if (source.missingCostCodes?.length) paragraph(inboundBody, `Sin costo completo: ${source.missingCostCodes.join(', ')}.`);
    inboundDialog.showModal();
  }
  function metricCells(row, key, result, weekStart = false, detailContext = null) {
    const metric = result?.values[key], showPercent = metric?.showPercent !== false;
    const amount = row.insertCell(), percent = document.createElement('td');
    if (detailContext?.location.type !== 'warehouse') row.append(percent);
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
      } else if (key === 'finalInventory' && metric.date) {
        const note = document.createElement('span'); note.className = 'weekly-results-inventory-dates';
        note.textContent = `${metric.basis === 'physical' ? 'Físico' : 'Inventario teórico'} · ${date(metric.date)}`;
        amount.append(note);
        if (metric.status === 'partial') partialTag(amount);
      } else if (metric.status === 'partial') partialTag(amount);
      percent.textContent = !showPercent ? '' : metric.percent == null ? '—' : `${metric.percent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      if (showPercent && metric.percentPartial && metric.percent != null && key !== 'inventoryShortage') partialTag(percent);
      if (key === 'collectionDifference') amount.classList.add(metric.amount === 0 ? 'weekly-results-balanced' : 'weekly-results-difference');
    }
    if (key === 'centralWarehouseInbound' && detailContext?.location.type === 'warehouse') {
      const note = document.createElement('span'); note.className = 'weekly-results-inventory-dates';
      note.textContent = 'Reversas / devoluciones'; amount.append(note);
    }
    if (inboundLabels[key] && metric?.status !== 'not-applicable' && detailContext && Array.isArray(result?.sources?.[key]?.items)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'weekly-results-inbound-button';
      button.textContent = amount.firstChild.textContent;
      button.title = 'Ver ingredientes, cantidades e importes'; button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-label', `Ver detalle de ${inboundLabels[key]}: ${button.textContent} · ${detailContext.location.name} · ${date(detailContext.period.from)}`);
      button.addEventListener('click', () => openInbound(key, result, detailContext));
      amount.firstChild.replaceWith(button);
    }
    if (metricLabels[key] && metric?.available && result?.detailReports?.[key] && detailContext) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'weekly-results-inbound-button weekly-results-metric-button';
      button.textContent = amount.firstChild.textContent; button.title = `Ver detalle de ${metricLabels[key]}`;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-label', `Ver detalle de ${metricLabels[key]}: ${button.textContent} · ${detailContext.location.name} · ${date(detailContext.period.from)}`);
      button.addEventListener('click', () => openMetricDetail(key, result, detailContext)); amount.firstChild.replaceWith(button);
    }
  }
  function metricRow(body, key, label) {
    const row = body.insertRow(); row.dataset.metric = key;
    if (['mercadoPagoTips', 'cashTips'].includes(key)) row.className = 'weekly-results-tip-breakdown';
    if (['grossSales', 'discounts', 'grossSalesAfterDiscounts', 'mercadoPagoTips', 'cashTips', 'centralWarehouseInbound', 'directSupplierInbound', 'cogs', 'otherVariableCosts'].includes(key)) row.classList.add('weekly-results-breakdown');
    if (['netSales', 'inventoryConsumptionTotal'].includes(key)) row.className = 'weekly-results-subtotal';
    const th = document.createElement('th'); th.scope = 'row'; th.textContent = label; row.append(th);
    return row;
  }
  function cancelDaily(close = false) {
    closeInbound();
    dailyController?.abort(); dailyController = null; dailyGeneration++;
    dailyDialog.setAttribute('aria-busy', 'false');
    if (close && dailyDialog.open) dailyDialog.close();
  }
  function renderDaily(detail, weeklyResult) {
    const units = detail.location.type === 'warehouse' ? ['Importe'] : ['Importe', '%'];
    const totalLabel = detail.periodType === 'month' ? 'Total mes' : 'Total semana';
    const wrap = document.createElement('div'); wrap.className = 'weekly-results-table-wrap'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `Detalle diario y ${totalLabel.toLowerCase()}; tabla desplazable`);
    const table = document.createElement('table'); table.className = 'weekly-results-table weekly-results-daily-table';
    const head = table.createTHead(), daysRow = head.insertRow(), unitsRow = head.insertRow();
    const concept = document.createElement('th'); concept.textContent = 'Concepto'; concept.rowSpan = 2; concept.scope = 'col'; daysRow.append(concept);
    for (const day of [...detail.days, null]) {
      const th = document.createElement('th'); th.colSpan = units.length; th.scope = 'colgroup';
      th.textContent = day ? `${new Intl.DateTimeFormat('es-CL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))} · ${date(day.date)}` : totalLabel;
      if (!day) th.className = 'weekly-results-weekly-total';
      daysRow.append(th);
      for (const unit of units) {
        const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = unit; unitsRow.append(cell);
      }
    }
    const body = table.createTBody();
    for (const [key, label] of detail.metrics) {
      const row = metricRow(body, key, label);
      for (const day of detail.days) metricCells(row, key, day, false, { location: detail.location, period: { from: day.date, through: day.date } });
      metricCells(row, key, weeklyResult, true, { location: detail.location, period: detail.period });
      row.cells[row.cells.length - units.length].classList.add('weekly-results-weekly-total');
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
    const key = `${data.date}:${data.options?.period || 'week'}:${week.period.from}:${location.id}`, request = dailyGeneration;
    dailyBody.replaceChildren();
    if (dailyCache.has(key)) {
      renderDaily(dailyCache.get(key), weeklyResult); setStatus(dailyStatus, 'Detalle diario actualizado.', 'success'); return;
    }
    const active = new AbortController(); dailyController = active;
    dailyDialog.setAttribute('aria-busy', 'true'); setStatus(dailyStatus, 'Calculando detalle diario…');
    try {
      const params = new URLSearchParams({ from: week.period.from, date: data.date, location: location.id,
        period: data.options?.period || 'week', weeks: data.weeks.length, includeCurrent: data.options?.includeCurrent !== false });
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
      marketing: 'Marketing', employees: 'Consumo personal', waste: 'Merma', inventory: 'Inventario',
      centralWarehouseInbound: 'Entradas Bodega Central', directSupplierInbound: 'Entradas Proveedores Directos' };
    if (location.type === 'warehouse') {
      labels.centralWarehouseInbound = 'Reversas / devoluciones'; labels.suppliesOutbound = 'Salidas Insumos';
    }
    for (const [key, label] of Object.entries(labels)) {
      if (location.type === 'warehouse' && !['waste', 'inventory', 'centralWarehouseInbound', 'directSupplierInbound', 'suppliesOutbound'].includes(key)) continue;
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
      if (source.items) {
        paragraph(detailBody, `${source.items.filter(item => item.available).length} de ${source.items.length} entradas costeadas.`);
        for (const item of source.items) paragraph(detailBody,
          `${date(item.date)} · Documento ${item.document} · ${item.code} ${item.name} · ${item.quantity.toLocaleString('es-CL')} ${item.unit} · ${item.available ? `${formatClp(item.unitCost)} por unidad = ${formatClp(item.amount)}` : 'Sin costo completo'}${item.costSource ? ` · Fuente de costo: ${item.costSource === 'purchase' ? 'Compra' : item.costSource === 'recipe' ? 'Receta' : item.costSource === 'master' ? 'Maestro' : 'Sin costo'}` : ''}${item.costSourceDate ? ` (${date(item.costSourceDate)})` : ''}`);
        if (source.unresolvedOriginCount) paragraph(detailBody, `${source.unresolvedOriginCount} entradas con origen sin confirmar; no se suman al subtotal.`);
        (source.issues || []).forEach(message => paragraph(detailBody, message));
      }
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
    document.getElementById('weekly-results-context').textContent = window.WeeklyResultsExport.reportContext(data);
    if (!data.locations.length) { paragraph(container, 'No hay ubicaciones activas para mostrar.'); return; }
    const wrap = document.createElement('div'); wrap.className = 'weekly-results-table-wrap';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${window.WeeklyResultsExport.reportTitle(data)} por sucursal; tabla desplazable`);
    const table = document.createElement('table'); table.className = 'weekly-results-table';
    const head = table.createTHead(), weeksRow = head.insertRow(), storesRow = head.insertRow(), unitsRow = head.insertRow();
    const concept = document.createElement('th'); concept.textContent = 'Concepto'; concept.rowSpan = 3; concept.scope = 'col'; weeksRow.append(concept);
    for (const [index, week] of data.weeks.entries()) {
      const th = document.createElement('th'); th.colSpan = data.locations.reduce((sum, location) => sum + (location.type === 'warehouse' ? 1 : 2), 0); th.scope = 'colgroup'; th.className = 'weekly-results-week-start';
      const heading = document.createElement('div'); heading.className = 'weekly-results-week-heading';
      const weekLabel = document.createElement('span');
      weekLabel.textContent = `${window.WeeklyResultsExport.periodLabel(data, index)} · ${date(week.period.from)} – ${date(week.period.to)}`;
      const dailyButton = document.createElement('button'); dailyButton.type = 'button'; dailyButton.className = 'secondary weekly-results-daily-button'; dailyButton.textContent = 'Detalle Diario';
      dailyButton.setAttribute('aria-label', `Detalle Diario ${data.options?.period === 'month' ? 'del mes' : 'de la semana'} del ${date(week.period.from)}`);
      dailyButton.addEventListener('click', () => openDaily(data, week));
      heading.append(weekLabel, dailyButton); th.append(heading);
      weeksRow.append(th);
      for (const [storeIndex, location] of data.locations.entries()) {
        const units = location.type === 'warehouse' ? ['Importe'] : ['Importe', '%'];
        const result = week.locations.find(item => item.locationId === location.id);
        const store = document.createElement('th'); store.colSpan = units.length; store.scope = 'colgroup';
        if (!storeIndex) store.className = 'weekly-results-week-start';
        const label = document.createElement('span'); label.textContent = location.name; store.append(label);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'weekly-results-review'; button.textContent = 'Fechas y fuentes';
        button.setAttribute('aria-label', `Revisar fechas y fuentes de ${location.name}, ${data.options?.period === 'month' ? 'mes' : 'semana'} del ${date(week.period.from)}`);
        button.addEventListener('click', () => openDetail(data, week, location, result)); store.append(button); storesRow.append(store);
        for (const unit of units) {
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
        metricCells(row, key, result, !storeIndex, { location, period: week.period });
      }
    }
    wrap.append(table); container.append(wrap);
    data.warnings.forEach(message => paragraph(warnings, message));
  }
  window.cancelCafeWeeklyResults = () => {
    metricCache.clear();
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
    const monthly = periodType.value === 'month';
    setStatus(status, `Calculando resultados ${monthly ? 'mensuales' : 'semanales'}…`);
    const params = new URLSearchParams({ weeks: weeks.value, period: periodType.value, includeCurrent: includeCurrent.value, includeInventory: includeInventory.value });
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
      render(data); progress.value = 100; setStatus(status, `Resultados ${monthly ? 'mensuales' : 'semanales'} actualizados.`, 'success');
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
    const monthly = periodType.value === 'month';
    document.getElementById('weekly-results-title').textContent = monthly ? 'Resultados Mensuales' : 'Resultados Semanales';
    document.getElementById('weekly-results-count-label').textContent = monthly ? 'Cantidad de meses' : 'Cantidad de semanas';
    document.getElementById('weekly-results-current-label').textContent = monthly ? 'Incluir mes actual' : 'Incluir semana actual';
    for (const option of weeks.options) option.textContent = `${option.value} ${monthly ? 'meses' : 'semanas'}`;
    progress.setAttribute('aria-label', `Avance de Resultados ${monthly ? 'Mensuales' : 'Semanales'}`);
    window.cancelCafeWeeklyResults();
    resetExport();
    if (dialog.open) dialog.close();
    container.replaceChildren(); warnings.replaceChildren();
    document.getElementById('weekly-results-context').textContent = '';
    setStatus(status, 'Pulsa Actualizar para aplicar las opciones seleccionadas.');
  });
  document.getElementById('weekly-results-detail-close').addEventListener('click', () => dialog.close());
  document.getElementById('weekly-results-inbound-close').addEventListener('click', () => inboundDialog.close());
  document.getElementById('weekly-results-metric-close').addEventListener('click', () => metricDialog.close());
  metricDialog.addEventListener('close', () => {
    metricController?.abort(); metricController = null; metricGeneration++;
    metricSnapshot = null; metricDialog.setAttribute('aria-busy', 'false'); metricDownload.disabled = true;
  });
  metricDownload.addEventListener('click', () => {
    if (!metricSnapshot) return;
    const report = metricSnapshot, total = metricVisibleRows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
    const rows = [[report.title], [report.location.name], [`${date(report.period.from)} – ${date(report.period.through)}`],
      [`${report.partial ? 'Subtotal conocido' : 'Total del reporte'}: ${formatClp(report.total)}`], [],
      report.columns.map(column => column.label), ...metricVisibleRows.map(row => report.columns.map(column => row[column.key] ?? '—')),
      report.columns.map(column => column.key === 'amount' ? total : column === report.columns[0] ? 'Total de registros visibles' : '')];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    for (let r = 6; r < rows.length; r++) report.columns.forEach((column, c) => {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t !== 'n') return;
      if (column.type === 'currency') cell.z = '"$"#,##0;"$"-#,##0;"$"0';
      else if (column.type === 'unitCost') cell.z = '"$"#,##0.00';
      else if (column.type === 'number') cell.z = '#,##0.####';
    });
    sheet['!cols'] = report.columns.map(column => ({ wch: column.key === 'name' ? 38 : 22 }));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Detalle');
    const name = `${report.title}_${report.location.name}_${report.period.from}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
    XLSX.writeFile(book, `${name}.xlsx`);
  });
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
