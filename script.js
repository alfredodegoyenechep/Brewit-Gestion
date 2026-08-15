const dashboardSections = ['.summary-grid', '.content-layout', '.lower-grid'];
let locationRegistry = {};
const FIELD_LABELS = {
  kardex: 'Kardex / inventario',
  waste: 'Merma',
  marketing: 'Consumo de marketing',
  employees: 'Consumo de colaboradores',
  purchases: 'Compras',
  sales: 'Ventas'
};
const MASTER_FIELD_LABELS = {
  'master-catalog': 'Maestro Productos / Ingredientes / Extras',
  'product-hierarchy': 'Jerarquía Productos',
  'ingredient-hierarchy': 'Jerarquía Ingredientes',
  'extras-hierarchy': 'Jerarquía Extras',
  'master-recipes': 'Maestro de recetas',
  'master-suppliers': 'Maestro Proveedores'
};
const LEGACY_MASTER_FIELDS = {
  'master-products': 'master-catalog',
  'master-ingredients': 'product-hierarchy',
  'master-extras': 'extras-hierarchy'
};
let inspectionState = null;
let currentWeekFiles = {};
let pendingTrashLocation = null;
let inventorySourceState = null;
let productsViewState = null;
let purchasesViewState = null;
let pendingInventorySummaryField = null;
let pendingInventoryPreview = null;

function setView(view) {
  document.querySelectorAll('.main-content > section').forEach(section => {
    section.hidden = true;
    section.style.display = 'none';
  });
  if (view === 'uploads') {
    const loader = document.getElementById('file-loader');
    loader.hidden = false;
    loader.style.display = '';
    return;
  }
  if (view === 'config') {
    const settings = document.getElementById('location-settings');
    settings.hidden = false;
    settings.style.display = '';
    return;
  }
  if (view === 'report') {
    const report = document.getElementById('weekly-report');
    report.hidden = false;
    report.style.display = '';
    loadWeeklySalesReport();
    return;
  }
  if (view === 'inventory') {
    const inventory = document.getElementById('inventory-workspace');
    inventory.hidden = false;
    inventory.style.display = '';
    loadInventorySources();
    return;
  }
  if (view === 'products') {
    const products = document.getElementById('products-workspace');
    products.hidden = false;
    products.style.display = '';
    loadProductsView();
    return;
  }
  if (view === 'purchases') {
    const purchases = document.getElementById('purchases-workspace');
    purchases.hidden = false;
    purchases.style.display = '';
    loadPurchasesView();
    return;
  }
  dashboardSections.forEach(selector => {
    const section = document.querySelector(selector);
    if (section) {
      section.hidden = false;
      section.style.display = '';
    }
  });
}

function setUploadMode(mode) {
  document.querySelectorAll('.upload-mode').forEach(button => {
    const active = button.dataset.uploadMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.getElementById('weekly-upload-pane').hidden = mode !== 'weekly';
  document.getElementById('master-upload-pane').hidden = mode !== 'masters';
}

function dateFromKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDetectedRange(range) {
  if (!range) return 'No se encontraron fechas; ingrésalas manualmente.';
  return `${range.from} → ${range.to}`;
}

async function apiRequest(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error('No se pudo conectar con Brewit. Inicia la aplicación con npm start e intenta nuevamente.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(data.error || `La solicitud falló (${response.status}).`);
    requestError.status = response.status;
    requestError.data = data;
    throw requestError;
  }
  return data;
}

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `form-status${type ? ` ${type}` : ''}`;
}

function initializeFileUploadControls() {
  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => {
    input.classList.add('native-file-input');
    const control = document.createElement('label');
    control.className = 'file-upload-control';
    control.htmlFor = input.id;
    const state = document.createElement('span');
    state.className = 'file-upload-state';
    const filename = document.createElement('span');
    filename.className = 'file-upload-filename';
    control.append(state, filename);
    input.insertAdjacentElement('afterend', control);
    const actions = document.createElement('div');
    actions.className = 'weekly-file-actions';
    control.insertAdjacentElement('afterend', actions);
  });
  updateFileUploadControls();
}

function updateFileUploadControls() {
  document.querySelectorAll('[data-weekly-field]').forEach(row => {
    row.querySelector('.weekly-delete-confirmation')?.remove();
    const field = row.dataset.weeklyField;
    const input = row.querySelector('input[type="file"]');
    const state = row.querySelector('.file-upload-state');
    const filename = row.querySelector('.file-upload-filename');
    const selected = input.files[0];
    const uploaded = currentWeekFiles[field];
    const latest = uploaded?.latest;
    const actions = row.querySelector('.weekly-file-actions');
    actions.replaceChildren();

    if (selected) {
      state.textContent = 'Subir Archivo';
      state.className = 'file-upload-state missing';
      filename.textContent = selected.name;
    } else if (latest) {
      state.textContent = 'Archivo ya subido';
      state.className = 'file-upload-state uploaded';
      const range = uploaded.dataRange ? ` · ${formatDetectedRange(uploaded.dataRange)}` : '';
      filename.textContent = `${latest.originalName || latest.name} · ${uploaded.fileCount} carga(s)${range}`;
      const previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.className = 'icon-button small';
      previewButton.textContent = 'Previsualizar';
      previewButton.addEventListener('click', () => openWeeklyPreview(field, latest));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'delete-button small';
      deleteButton.textContent = 'Eliminar';
      deleteButton.addEventListener('click', () => showWeeklyDeleteConfirmation(row, field, latest));
      actions.append(previewButton, deleteButton);
    } else {
      state.textContent = 'Subir Archivo';
      state.className = 'file-upload-state missing';
      filename.textContent = '';
    }
  });
}

function openWeeklyPreview(field, record) {
  openSpreadsheetPreview(
    record.previewUrl,
    record.originalName || record.name
  );
}

function showWeeklyDeleteConfirmation(row, field, record) {
  row.querySelector('.delete-confirmation')?.remove();
  const location = document.getElementById('location-select').value;
  const confirmation = document.createElement('div');
  confirmation.className = 'delete-confirmation weekly-delete-confirmation';
  const message = document.createElement('span');
  message.textContent = `¿Eliminar la carga más reciente “${record.originalName || record.name}”? Los datos de cargas anteriores se conservarán.`;
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'delete-button small';
  confirmButton.textContent = 'Sí, eliminar';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'icon-button small';
  cancelButton.textContent = 'Cancelar';
  cancelButton.addEventListener('click', () => confirmation.remove());
  confirmButton.addEventListener('click', async () => {
    confirmButton.disabled = true;
    try {
      await apiRequest(record.deleteUrl, { method: 'DELETE' });
      await loadTransactionFiles();
      if (field === 'sales') await loadLatestSalesTransaction(location);
      setStatus(document.getElementById('week-status'), 'Carga transaccional eliminada.', 'success');
    } catch (error) {
      setStatus(document.getElementById('week-status'), error.message, 'error');
      confirmButton.disabled = false;
    }
  });
  confirmation.append(message, confirmButton, cancelButton);
  row.appendChild(confirmation);
}

function clearWeeklySelections() {
  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => { input.value = ''; });
  updateFileUploadControls();
}

function appendDownload(parent, record, prefix = '') {
  const link = document.createElement('a');
  link.href = record.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = `${prefix}${record.originalName || record.name}`;
  parent.appendChild(link);
}

function clearInspection(clearStatus = false) {
  inspectionState = null;
  const confirmation = document.getElementById('date-confirmation');
  confirmation.hidden = true;
  document.getElementById('dates-confirmed').checked = false;
  document.getElementById('detected-files-list').replaceChildren();
  document.getElementById('transaction-overlap-notice').hidden = true;
  document.getElementById('replace-transactions-btn').hidden = true;
  if (clearStatus) setStatus(document.getElementById('week-status'), '');
}

function updateLocationFields() {
  const location = document.getElementById('location-select').value;
  const locationRecord = locationRegistry[location];
  const isWarehouse = locationRecord?.type === 'warehouse';
  const hasLocation = Boolean(locationRecord);
  document.querySelectorAll('.store-only').forEach(row => {
    row.hidden = !hasLocation || isWarehouse;
    const input = row.querySelector('input');
    input.disabled = !hasLocation || isWarehouse;
    if (input.disabled) input.value = '';
  });
  const kardexInput = document.getElementById('file-kardex');
  kardexInput.disabled = !hasLocation;
  document.getElementById('inspect-week-btn').disabled = !hasLocation;
  document.getElementById('location-note').textContent = !hasLocation
    ? 'Crea o recupera una ubicación en Configuración para cargar archivos.'
    : isWarehouse
      ? 'Esta bodega solo requiere su Kardex de inventario.'
      : 'Esta cafetería recibe Kardex, merma, consumos de marketing y colaboradores, compras y ventas.';
  currentWeekFiles = {};
  clearWeeklySelections();
  clearInspection(true);
  loadTransactionFiles();
  loadLatestSalesTransaction(location);
}

function formatSalesDateTime(value) {
  if (!value) return null;
  const [datePart, timePart = '00:00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'medium' })
    .format(new Date(year, month - 1, day, hour, minute, second));
}

async function loadLatestSalesTransaction(location = document.getElementById('location-select').value) {
  const output = document.getElementById('latest-sales-transaction');
  const locationRecord = locationRegistry[location];
  if (!locationRecord || locationRecord.type !== 'store') {
    output.textContent = '';
    return;
  }
  output.textContent = 'Última transacción: consultando…';
  try {
    const data = await apiRequest(`/api/sales/latest?location=${encodeURIComponent(location)}`);
    if (location !== document.getElementById('location-select').value) return;
    const formatted = formatSalesDateTime(data.latestTransactionAt);
    output.textContent = formatted ? `Última transacción: ${formatted}` : 'Última transacción: sin registros';
  } catch (error) {
    if (location === document.getElementById('location-select').value) output.textContent = 'Última transacción: no disponible';
  }
}

async function loadTransactionFiles() {
  const status = document.getElementById('week-status');
  const location = document.getElementById('location-select').value;
  if (!location) return;
  try {
    const data = await apiRequest(`/api/transactions?location=${encodeURIComponent(location)}`);
    if (location !== document.getElementById('location-select').value) return;
    currentWeekFiles = data.files || {};
    updateFileUploadControls();
    const available = Object.values(data.files || {}).filter(file => file.latest);
    setStatus(status, available.length
      ? `${available.length} tipo(s) de datos disponibles para ${data.location.name}.`
      : 'Aún no hay datos transaccionales guardados para esta ubicación.', available.length ? 'success' : 'muted');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

function formatClp(value) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatReportDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

function rankText(label, ranking) {
  return ranking?.position ? `${label}: #${ranking.position} de ${ranking.total}` : `${label}: —`;
}

function renderIntradayReport(intraday) {
  const referenceText = value => value ? formatReportDate(value) : 'Sin referencia';
  document.getElementById('intraday-today-date').textContent = formatReportDate(intraday.today.date);
  const cutoffLabel = intraday.today.cutoffTime ? `Corte ${intraday.today.cutoffTime.slice(0, 5)}` : 'Sin ventas de hoy';
  const setIntradayRank = (valueId, detailId, ranking, fallback) => {
    document.getElementById(valueId).textContent = ranking?.position ? `#${ranking.position}` : '—';
    document.getElementById(detailId).textContent = ranking?.position
      ? `de ${ranking.total} días · ${cutoffLabel}`
      : fallback;
  };
  setIntradayRank('intraday-general-rank', 'intraday-general-detail', intraday.today.generalRank, cutoffLabel);
  setIntradayRank('intraday-weekday-rank', 'intraday-weekday-detail', intraday.today.sameWeekdayRank, 'Sin días equivalentes');
  const comparison = intraday.today.comparisonToAveragePercent;
  document.getElementById('intraday-average-comparison').textContent = comparison === null
    ? '—'
    : `${comparison >= 0 ? '+' : ''}${comparison.toFixed(1)}%`;
  document.getElementById('intraday-average-detail').textContent = intraday.today.averageSampleSize
    ? `Promedio ${formatClp(intraday.today.sameWeekdayAverage)} · ${intraday.today.averageSampleSize} fechas`
    : 'Sin fechas equivalentes';
  const weekday = new Intl.DateTimeFormat('es-CL', { weekday: 'long' }).format(dateFromKey(intraday.today.date));
  document.getElementById('intraday-weekday-title').textContent = `Mejor ${weekday}`;
  document.getElementById('intraday-weekday-date').textContent = referenceText(intraday.references.sameWeekday.date);
  document.getElementById('intraday-month-date').textContent = referenceText(intraday.references.month.date);
  document.getElementById('intraday-historical-date').textContent = referenceText(intraday.references.historical.date);
  const body = document.getElementById('intraday-sales-body');
  body.replaceChildren(...intraday.blocks.map(block => {
    const row = document.createElement('tr');
    const period = document.createElement('td');
    period.textContent = block.label;
    row.appendChild(period);
    for (const [index, key] of ['today', 'sameWeekday', 'month', 'historical'].entries()) {
      const cell = document.createElement('td');
      cell.textContent = block[key] === null ? '—' : formatClp(block[key]);
      if (index === 0) cell.className = 'today-value';
      row.appendChild(cell);
    }
    return row;
  }));
}

async function loadWeeklySalesReport() {
  const status = document.getElementById('report-status');
  const refreshButton = document.getElementById('refresh-weekly-report');
  const locationFilter = document.getElementById('report-location-filter');
  const selectedLocation = locationFilter.value || 'all';
  refreshButton.disabled = true;
  setStatus(status, 'Calculando ventas netas…');
  try {
    const report = await apiRequest(`/api/reports/weekly-sales?location=${encodeURIComponent(selectedLocation)}`);
    if (selectedLocation !== locationFilter.value) return;
    document.getElementById('report-scope-description').textContent = report.scope.type === 'all'
      ? 'Venta neta sin IVA, consolidada para todas las cafeterías.'
      : `Venta neta sin IVA para ${report.scope.label}.`;
    document.getElementById('report-yesterday-date').textContent = formatReportDate(report.previousDay.date);
    document.getElementById('report-yesterday-value').textContent = formatClp(report.previousDay.netSales);
    document.getElementById('report-general-rank').textContent = rankText('Ranking general', report.previousDay.generalRank);
    document.getElementById('report-weekday-rank').textContent = rankText('Ranking mismo día', report.previousDay.sameWeekdayRank);
    const comparison = report.previousDay.comparisonToAveragePercent;
    document.getElementById('report-average-comparison').textContent = comparison === null
      ? 'Vs. promedio 8 semanas: —'
      : `Vs. promedio 8 semanas: ${comparison >= 0 ? '+' : ''}${comparison.toFixed(1)}%`;
    document.getElementById('report-week-value').textContent = formatClp(report.week.netSales);
    document.getElementById('report-week-range').textContent = `${formatReportDate(report.week.from)} – ${formatReportDate(report.week.to)}`;
    document.getElementById('report-month-value').textContent = formatClp(report.month.netSales);
    document.getElementById('report-month-range').textContent = `${formatReportDate(report.month.from)} – ${formatReportDate(report.month.to)}`;
    document.getElementById('report-weekday-average').textContent = formatClp(report.previousDay.sameWeekdayAverage);
    const weekday = new Intl.DateTimeFormat('es-CL', { weekday: 'long' }).format(dateFromKey(report.previousDay.date));
    document.getElementById('report-weekday-label').textContent = `Promedio de ${weekday} · ${report.previousDay.averageSampleSize} observaciones`;
    renderIntradayReport(report.intraday);
    if (!report.filesRead) {
      setStatus(status, 'No hay archivos de ventas cargados para las ubicaciones activas.', 'muted');
    } else if (report.warnings.length) {
      setStatus(status, report.warnings.join(' '), 'error');
    } else {
      setStatus(status, `${report.filesRead} archivo(s) de ventas procesado(s).`, 'success');
    }
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    refreshButton.disabled = false;
  }
}

function refreshReportLocationFilter() {
  const select = document.getElementById('report-location-filter');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function refreshProductsLocationFilter() {
  const select = document.getElementById('products-location-filter');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function refreshPurchasesLocationFilter() {
  const select = document.getElementById('purchases-location-filter');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function formatProductUnits(value) {
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function renderProductsView() {
  const container = document.getElementById('products-hierarchy-list');
  const summary = document.getElementById('products-summary');
  if (!productsViewState) {
    container.replaceChildren();
    summary.replaceChildren();
    return;
  }
  const query = document.getElementById('products-search').value.trim().toLocaleLowerCase('es');
  const matches = product => !query || `${product.code} ${product.name}`.toLocaleLowerCase('es').includes(query);
  const groups = productsViewState.hierarchies
    .map(group => ({ ...group, products: group.products.filter(matches) }))
    .filter(group => group.products.length);
  const visibleCount = groups.reduce((sum, group) => sum + group.products.length, 0);
  const summaryTexts = [
    `${visibleCount} de ${productsViewState.productCount} productos`,
    `${groups.length} jerarquías`,
    `Últimos 7 días: ${formatReportDate(productsViewState.periods.last7.from)} – ${formatReportDate(productsViewState.periods.last7.to)}`,
    `Promedio 8 semanas: 56 días ÷ 8`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  container.replaceChildren(...groups.map((group, groupIndex) => {
    const details = document.createElement('details');
    details.className = 'product-hierarchy-group';
    details.open = Boolean(query) || groupIndex < 3;
    const heading = document.createElement('summary');
    const path = document.createElement('strong');
    path.textContent = group.path.join(' › ');
    const count = document.createElement('span');
    count.textContent = `${group.products.length} producto(s)`;
    heading.append(path, count);
    const wrap = document.createElement('div');
    wrap.className = 'products-table-wrap';
    const table = document.createElement('table');
    table.className = 'products-table';
    const headers = ['Código', 'Producto', 'Precio venta', 'Precio venta neto', 'Costo', 'Margen', 'Prom. semanal 8 sem.', 'Últimos 7 días', 'Cambio vs. prom. 8 sem.'];
    const headRow = document.createElement('tr');
    for (const label of headers) {
      const cell = document.createElement('th');
      cell.textContent = label;
      headRow.appendChild(cell);
    }
    const head = document.createElement('thead');
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    for (const product of group.products) {
      const row = document.createElement('tr');
      if (!product.active) row.className = 'inactive-product';
      const values = [
        product.code,
        product.name,
        formatClp(product.price),
        formatClp(product.netPrice),
        formatClp(product.cost),
        product.marginPercent === null ? '—' : `${product.marginPercent.toFixed(1)}%`,
        formatProductUnits(product.averageWeeklyUnits8),
        formatProductUnits(product.unitsLast7Days),
        product.unitsChangePercent === null
          ? '—'
          : `${product.unitsChangePercent >= 0 ? '+' : ''}${product.unitsChangePercent.toFixed(1)}%`
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 1 && !product.active) {
          const badge = document.createElement('span');
          badge.className = 'product-inactive-badge';
          badge.textContent = 'Inactivo';
          cell.append(' ', badge);
        }
        if (index === 8 && product.unitsChangePercent !== null) {
          cell.classList.add(product.unitsChangePercent >= 0 ? 'product-change-positive' : 'product-change-negative');
        }
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
    table.append(head, body);
    wrap.appendChild(table);
    details.append(heading, wrap);
    return details;
  }));
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No hay productos que coincidan con la búsqueda.';
    container.appendChild(empty);
  }
}

async function loadProductsView() {
  const status = document.getElementById('products-status');
  const button = document.getElementById('refresh-products');
  const location = document.getElementById('products-location-filter').value || 'all';
  button.disabled = true;
  setStatus(status, 'Calculando catálogo y ventas por producto…');
  try {
    const data = await apiRequest(`/api/products?location=${encodeURIComponent(location)}`);
    if (location !== document.getElementById('products-location-filter').value) return;
    productsViewState = data;
    renderProductsView();
    await refreshSavedProductReports();
    if (data.warnings.length) setStatus(status, data.warnings.join(' '), 'error');
    else setStatus(status, `${data.filesRead} archivo(s) de ventas procesado(s) para ${data.scope.label}.`, 'success');
  } catch (error) {
    productsViewState = null;
    renderProductsView();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderPurchasesView() {
  const summary = document.getElementById('purchases-summary');
  const container = document.getElementById('purchases-groups');
  if (!purchasesViewState) {
    summary.replaceChildren();
    container.replaceChildren();
    return;
  }
  const data = purchasesViewState;
  const summaryTexts = [
    `${data.summary.lineCount} línea(s) de compra`,
    `${data.summary.supplierCount} proveedor(es)`,
    `${data.summary.productCount} insumo(s)`,
    `Total: ${formatClp(data.summary.totalAmount)}`,
    `${data.summary.changedPriceCount} cambio(s) de precio`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));

  const groups = new Map();
  data.rows.forEach(row => {
    if (!groups.has(row.supplierKey)) groups.set(row.supplierKey, []);
    groups.get(row.supplierKey).push(row);
  });
  container.replaceChildren(...[...groups.values()].map(rows => {
    const section = document.createElement('section');
    section.className = 'purchase-supplier-group';
    const heading = document.createElement('div');
    heading.className = 'purchase-supplier-heading';
    const title = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = rows[0].supplier;
    const taxId = document.createElement('span');
    taxId.textContent = rows[0].supplierTaxId ? `RUT ${rows[0].supplierTaxId}` : 'RUT no disponible';
    title.append(name, taxId);
    const totals = document.createElement('span');
    totals.textContent = `${rows.length} compra(s) · ${formatClp(rows.reduce((sum, row) => sum + row.totalAmount, 0))}`;
    heading.append(title, totals);

    const wrap = document.createElement('div');
    wrap.className = 'purchases-table-wrap';
    const table = document.createElement('table');
    table.className = 'purchases-table';
    const columns = [
      { label: 'Fecha', value: row => formatReportDate(row.date) },
      { label: 'Cafetería', value: row => row.locationName },
      { label: 'Documento', value: row => row.document || '—' },
      { label: 'Código', value: row => row.code || '—' },
      { label: 'Insumo', value: row => row.product || '—' },
      { label: 'Cantidad', value: row => formatProductUnits(row.quantity) },
      { label: 'Unidad', value: row => row.unit || '—' },
      { label: 'Costo unit. registrado', value: row => formatClp(row.listedUnitPrice) },
      { label: 'Descuento', value: row => formatClp(row.discount) },
      { label: 'Precio unit. efectivo', value: row => formatClp(row.effectiveUnitPrice) },
      { label: 'Precio anterior', value: row => row.previousEffectiveUnitPrice === null ? '—' : formatClp(row.previousEffectiveUnitPrice) },
      {
        label: 'Cambio',
        value: row => row.priceChangePercent === null
          ? '—'
          : `${row.priceChangePercent >= 0 ? '+' : ''}${row.priceChangePercent.toFixed(1)}%`,
        change: true
      },
      { label: 'Monto total', value: row => formatClp(row.totalAmount) }
    ];
    const headRow = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('th');
      cell.textContent = column.label;
      headRow.appendChild(cell);
    });
    const head = document.createElement('thead');
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    rows.forEach(item => {
      const row = document.createElement('tr');
      columns.forEach(column => {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        if (column.change && item.priceChangePercent !== null && Math.abs(item.priceChangePercent) >= 0.01) {
          cell.className = item.priceChangePercent > 0 ? 'purchase-price-increase' : 'purchase-price-decrease';
        }
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    table.append(head, body);
    wrap.appendChild(table);
    section.append(heading, wrap);
    return section;
  }));
  if (!data.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No hay compras para los filtros seleccionados.';
    container.appendChild(empty);
  }
}

async function loadPurchasesView() {
  const status = document.getElementById('purchases-status');
  const button = document.getElementById('refresh-purchases');
  const location = document.getElementById('purchases-location-filter').value || 'all';
  const supplier = document.getElementById('purchases-supplier-filter').value || 'all';
  const dateFrom = document.getElementById('purchases-date-from').value;
  const dateTo = document.getElementById('purchases-date-to').value;
  const params = new URLSearchParams({ location, supplier });
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  button.disabled = true;
  setStatus(status, 'Procesando el historial de compras…');
  try {
    const data = await apiRequest(`/api/purchases?${params}`);
    if (location !== document.getElementById('purchases-location-filter').value) return;
    purchasesViewState = data;
    const supplierSelect = document.getElementById('purchases-supplier-filter');
    supplierSelect.replaceChildren(
      new Option('Todos los proveedores', 'all'),
      ...data.suppliers.map(item => new Option(item.name, item.key))
    );
    supplierSelect.value = data.suppliers.some(item => item.key === supplier) ? supplier : 'all';
    const fromInput = document.getElementById('purchases-date-from');
    const toInput = document.getElementById('purchases-date-to');
    fromInput.value = data.filters.dateFrom || '';
    toInput.value = data.filters.dateTo || '';
    fromInput.min = toInput.min = data.availablePeriod?.from || '';
    fromInput.max = toInput.max = data.availablePeriod?.to || '';
    renderPurchasesView();
    setStatus(status, data.sourceFileCount
      ? `${data.sourceFileCount} archivo(s) procesado(s) para ${data.scope.label}.`
      : 'No hay archivos de compras cargados para la selección.', data.sourceFileCount ? 'success' : 'muted');
  } catch (error) {
    purchasesViewState = null;
    renderPurchasesView();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshSavedProductReports(selectId = null) {
  const select = document.getElementById('products-saved-report');
  const compareButton = document.getElementById('compare-products-report');
  const location = document.getElementById('products-location-filter').value || 'all';
  try {
    const data = await apiRequest(`/api/products/reports?location=${encodeURIComponent(location)}`);
    const options = data.reports.map(report => new Option(
      `${formatReportDate(report.date)} · ${report.scope.label} · ${report.productCount} productos`,
      report.id
    ));
    select.replaceChildren(...(options.length ? options : [new Option('No hay reportes guardados', '')]));
    if (selectId && options.some(option => option.value === selectId)) select.value = selectId;
    compareButton.disabled = !select.value;
  } catch (error) {
    select.replaceChildren(new Option('No se pudieron cargar los reportes', ''));
    compareButton.disabled = true;
  }
}

async function saveProductsReport(replace = false) {
  const status = document.getElementById('products-status');
  const button = document.getElementById('save-products-report');
  const location = document.getElementById('products-location-filter').value || 'all';
  button.disabled = true;
  setStatus(status, 'Guardando reporte de productos…');
  try {
    const saved = await apiRequest('/api/products/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, replace })
    });
    await refreshSavedProductReports(saved.id);
    setStatus(status, `Reporte de ${saved.scope.label} guardado para ${formatReportDate(saved.date)}.`, 'success');
  } catch (error) {
    if (error.status === 409 && error.data?.requiresReplacement
      && window.confirm(`${error.message}\n\n¿Quieres reemplazar el reporte guardado para esa fecha?`)) {
      button.disabled = false;
      return saveProductsReport(true);
    }
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function productChangeText(before, after, type) {
  if (before === null || before === undefined || after === null || after === undefined) return '—';
  const difference = after - before;
  if (type === 'margin') return `${difference >= 0 ? '+' : ''}${difference.toFixed(1)} pp`;
  const percent = before ? (difference / before) * 100 : null;
  return `${difference >= 0 ? '+' : ''}${formatClp(difference)}${percent === null ? '' : ` (${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%)`}`;
}

function renderProductsComparison(data) {
  const section = document.getElementById('products-comparison');
  document.getElementById('products-comparison-title').textContent =
    `${formatReportDate(data.previous.date)} vs. ${formatReportDate(data.current.date)}`;
  document.getElementById('products-comparison-description').textContent =
    `${data.previous.scope.label}. Se muestran solo productos agregados, retirados o con cambios en precio, costo o margen.`;
  const summary = document.getElementById('products-comparison-summary');
  const summaryValues = [
    `${data.changeCount} productos con cambios`,
    `${data.counts.price} cambios de precio`,
    `${data.counts.cost} cambios de costo`,
    `${data.counts.margin} cambios de margen`,
    `${data.counts.added} agregados · ${data.counts.removed} retirados`
  ];
  summary.replaceChildren(...summaryValues.map(value => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = value;
    return chip;
  }));
  const statusLabels = { added: 'Agregado', removed: 'Retirado', changed: 'Modificado' };
  const body = document.getElementById('products-comparison-body');
  body.replaceChildren(...data.changes.map(change => {
    const row = document.createElement('tr');
    row.className = `product-comparison-${change.status}`;
    const before = change.before;
    const after = change.after;
    const values = [
      change.code,
      change.name,
      statusLabels[change.status],
      before ? formatClp(before.price) : '—',
      after ? formatClp(after.price) : '—',
      productChangeText(before?.price, after?.price, 'money'),
      before ? formatClp(before.cost) : '—',
      after ? formatClp(after.cost) : '—',
      productChangeText(before?.cost, after?.cost, 'money'),
      before?.marginPercent === null || before?.marginPercent === undefined ? '—' : `${before.marginPercent.toFixed(1)}%`,
      after?.marginPercent === null || after?.marginPercent === undefined ? '—' : `${after.marginPercent.toFixed(1)}%`,
      productChangeText(before?.marginPercent, after?.marginPercent, 'margin')
    ];
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    return row;
  }));
  if (!data.changes.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 12;
    cell.className = 'products-comparison-empty';
    cell.textContent = 'No hay cambios de precio, costo o margen respecto del reporte seleccionado.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function compareProductsReport() {
  const status = document.getElementById('products-status');
  const button = document.getElementById('compare-products-report');
  const location = document.getElementById('products-location-filter').value || 'all';
  const snapshot = document.getElementById('products-saved-report').value;
  if (!snapshot) return;
  button.disabled = true;
  setStatus(status, 'Comparando precios, costos y márgenes…');
  try {
    const data = await apiRequest(`/api/products/reports/compare?location=${encodeURIComponent(location)}&snapshot=${encodeURIComponent(snapshot)}`);
    renderProductsComparison(data);
    setStatus(status, `Comparación completada: ${data.changeCount} producto(s) con cambios.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function refreshInventoryLocationFilter() {
  const select = document.getElementById('inventory-location-select');
  const previous = select.value;
  const options = Object.values(locationRegistry).map(location => new Option(location.name, location.id));
  select.replaceChildren(...options);
  if (options.some(option => option.value === previous)) select.value = previous;
}

async function loadInventorySources() {
  const select = document.getElementById('inventory-location-select');
  const location = select.value;
  const status = document.getElementById('inventory-source-status');
  const list = document.getElementById('inventory-source-list');
  const processButton = document.getElementById('process-inventory-report');
  if (!location) {
    inventorySourceState = null;
    list.replaceChildren();
    processButton.disabled = true;
    return setStatus(status, 'No hay ubicaciones activas disponibles.', 'muted');
  }
  setStatus(status, 'Buscando los archivos más recientes…');
  try {
    const data = await apiRequest(`/api/inventory/sources?location=${encodeURIComponent(location)}`);
    if (location !== select.value) return;
    inventorySourceState = data;
    document.getElementById('waste-summary-results').hidden = true;
    document.getElementById('consumption-summary-results').hidden = true;
    document.getElementById('inventory-report-results').hidden = true;
    list.replaceChildren(...data.sources.map(source => {
      const card = document.createElement('article');
      card.className = `inventory-source-card${source.applicable ? '' : ' not-applicable'}`;
      const name = document.createElement('div');
      name.className = 'inventory-source-name';
      const title = document.createElement('strong');
      title.textContent = source.label;
      const badge = document.createElement('span');
      badge.className = `inventory-source-badge${source.available && source.applicable ? '' : ' missing'}`;
      badge.textContent = !source.applicable ? 'No aplica' : source.available ? 'Disponible' : 'Falta cargar';
      name.append(title, badge);

      const details = document.createElement('div');
      details.className = 'inventory-source-file';
      if (source.file) {
        const filename = document.createElement('strong');
        filename.textContent = source.file.originalName || source.file.name;
        const coverage = document.createElement('span');
        coverage.textContent = `Datos detectados hasta: ${source.file.dataThrough}`;
        const confirmed = document.createElement('span');
        confirmed.textContent = source.file.confirmedRange
          ? `Rango confirmado: ${formatDetectedRange(source.file.confirmedRange)}`
          : 'Rango confirmado por archivo: no disponible en esta carga histórica';
        const saved = document.createElement('span');
        saved.textContent = source.file.savedAt
          ? `Guardado: ${new Date(source.file.savedAt).toLocaleString('es-CL')}`
          : `Semana: ${source.file.week}`;
        details.append(filename, coverage, confirmed, saved);
        if (source.field === 'kardex' && data.kardexPeriod) {
          const period = document.createElement('span');
          period.textContent = `Días del Kardex: ${formatReportDate(data.kardexPeriod.firstDate)} – ${formatReportDate(data.kardexPeriod.lastDate)} · cierre máximo: ${formatReportDate(data.kardexPeriod.penultimateDate)}`;
          details.appendChild(period);
        }
      } else {
        details.textContent = source.applicable
          ? 'No existe un archivo disponible para esta ubicación.'
          : 'Este archivo no es requerido para una bodega.';
      }

      const actions = document.createElement('div');
      actions.className = 'inventory-source-actions';
      if (source.file) {
        if (['waste', 'marketing', 'employees'].includes(source.field) && source.applicable) {
          const summary = document.createElement('button');
          summary.type = 'button';
          summary.className = 'primary small';
          const summaryNames = {
            waste: 'Ver resumen merma',
            marketing: 'Ver resumen marketing',
            employees: 'Ver resumen colaboradores'
          };
          summary.textContent = summaryNames[source.field];
          summary.addEventListener('click', () => openSourceSummaryDialog(source.field));
          actions.appendChild(summary);
        }
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'icon-button small';
        preview.textContent = 'Previsualizar';
        preview.addEventListener('click', () => openInventoryPreviewRange(
          source.file.previewUrl,
          source.file.originalName || source.label
        ));
        const download = document.createElement('a');
        download.className = 'icon-button small';
        download.href = source.file.url;
        download.target = '_blank';
        download.rel = 'noopener';
        download.textContent = 'Descargar';
        actions.append(preview, download);
      }
      card.append(name, details, actions);
      return card;
    }));
    processButton.disabled = !data.ready || !data.kardexPeriod;
    document.getElementById('inventory-process-note').textContent = data.ready
      ? data.kardexPeriod
        ? 'Al procesar, confirma por separado los saldos inicial y final y el período inclusivo de movimientos.'
        : `No fue posible interpretar las fechas del Kardex: ${data.kardexError || 'estructura no reconocida'}.`
      : 'Faltan uno o más archivos requeridos. Puedes cargarlos antes de procesar el informe.';
    setStatus(status, data.ready
      ? 'La ubicación tiene todas las fuentes requeridas disponibles.'
      : 'La ubicación todavía no tiene todas las fuentes requeridas.', data.ready ? 'success' : 'muted');
  } catch (error) {
    inventorySourceState = null;
    list.replaceChildren();
    processButton.disabled = true;
    setStatus(status, error.message, 'error');
  }
}

function clearInventoryPeriodResults() {
  document.getElementById('waste-summary-results').hidden = true;
  document.getElementById('consumption-summary-results').hidden = true;
  document.getElementById('inventory-report-results').hidden = true;
}

function isoLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function inventoryDefaultPeriod() {
  const today = new Date();
  const currentMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  currentMonday.setDate(currentMonday.getDate() - ((currentMonday.getDay() + 6) % 7));
  const previousMonday = new Date(currentMonday);
  previousMonday.setDate(previousMonday.getDate() - 7);
  const previousSunday = new Date(currentMonday);
  previousSunday.setDate(previousSunday.getDate() - 1);
  return {
    previousMonday: isoLocalDate(previousMonday),
    previousSunday: isoLocalDate(previousSunday),
    currentMonday: isoLocalDate(currentMonday)
  };
}

function constrainInventoryDateInput(input) {
  const dates = inventorySourceState?.kardexPeriod?.dates || [];
  input.min = dates[0] || '';
  input.max = dates.at(-1) || '';
}

function openInventoryProcessDialog() {
  const defaults = inventoryDefaultPeriod();
  const initialDate = document.getElementById('inventory-initial-date');
  const finalDate = document.getElementById('inventory-final-date');
  const movementFrom = document.getElementById('inventory-movement-from');
  const movementTo = document.getElementById('inventory-movement-to');
  [initialDate, finalDate, movementFrom, movementTo].forEach(constrainInventoryDateInput);
  initialDate.value = defaults.previousMonday;
  finalDate.value = defaults.currentMonday;
  movementFrom.value = defaults.previousMonday;
  movementTo.value = defaults.previousSunday;
  document.getElementById('inventory-initial-basis').value = 'initial';
  document.getElementById('inventory-final-basis').value = 'initial';
  setStatus(document.getElementById('inventory-process-dialog-status'), '');
  document.getElementById('inventory-process-dialog').showModal();
}

function openSourceSummaryDialog(field) {
  pendingInventorySummaryField = field;
  const defaults = inventoryDefaultPeriod();
  document.getElementById('source-summary-date-from').value = defaults.previousMonday;
  document.getElementById('source-summary-date-to').value = defaults.previousSunday;
  const titles = {
    waste: 'Resumen de Merma',
    marketing: 'Resumen de Consumo de Marketing',
    employees: 'Resumen de Consumo de Colaboradores'
  };
  document.getElementById('source-summary-dialog-title').textContent = titles[field] || 'Ver resumen';
  setStatus(document.getElementById('source-summary-dialog-status'), '');
  document.getElementById('source-summary-dialog').showModal();
}

function openInventoryPreviewRange(endpoint, title) {
  pendingInventoryPreview = { endpoint, title };
  const defaults = inventoryDefaultPeriod();
  document.getElementById('inventory-preview-date-from').value = defaults.previousMonday;
  document.getElementById('inventory-preview-date-to').value = defaults.previousSunday;
  document.getElementById('inventory-preview-range-title').textContent = `Previsualizar ${title}`;
  setStatus(document.getElementById('inventory-preview-range-status'), '');
  document.getElementById('inventory-preview-range-dialog').showModal();
}

function confirmInventoryPreviewRange() {
  const status = document.getElementById('inventory-preview-range-status');
  const dateFrom = document.getElementById('inventory-preview-date-from').value;
  const dateTo = document.getElementById('inventory-preview-date-to').value;
  if (!pendingInventoryPreview || !dateFrom || !dateTo || dateFrom > dateTo) {
    return setStatus(status, 'Selecciona un rango de fechas válido. Ambas fechas se incluyen.', 'error');
  }
  const { endpoint, title } = pendingInventoryPreview;
  const separator = endpoint.includes('?') ? '&' : '?';
  document.getElementById('inventory-preview-range-dialog').close();
  pendingInventoryPreview = null;
  openSpreadsheetPreview(
    `${endpoint}${separator}dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`,
    title,
    { dialog: 'inventory-preview-dialog', title: 'inventory-preview-title', content: 'inventory-preview-content' }
  );
}

function formatInventoryQuantity(value) {
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 3 }).format(value || 0);
}

function formatKardexQuantity(value) {
  return new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(Number(value) || 0);
}

function formatKardexCost(value) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function populateWasteSummaryTable(table, report) {
  const visibleDefinitions = report.additionDefinitions.filter(definition =>
    definition.key.startsWith('mov-in-')
      || Math.abs(Number(report.additionTotals?.[definition.key]) || 0) > 0.0000001
  );
  const columns = [
    { key: 'code', label: 'Código', value: item => item.code, total: 'TOTAL' },
    { key: 'name', label: 'Ítem', value: item => item.name, total: '' },
    { key: 'unit', label: 'Unidad', value: item => item.unit, total: '' },
    ...visibleDefinitions.map(definition => ({
      key: definition.key,
      label: definition.label,
      value: item => formatInventoryQuantity(item.additions[definition.key]),
      total: formatInventoryQuantity(report.additionTotals?.[definition.key])
    })),
    {
      key: 'total',
      label: 'Total adiciones',
      value: item => formatInventoryQuantity(item.total),
      total: formatInventoryQuantity(report.totalAdditions)
    },
    {
      key: 'unitCost',
      label: 'Costo unitario',
      value: item => item.costAvailable ? formatClp(item.unitCost) : 'Sin costo',
      total: ''
    },
    {
      key: 'cost',
      label: 'Costo total',
      value: item => item.costAvailable ? formatClp(item.totalCost) : 'Sin costo',
      total: formatClp(report.totalCost)
    }
  ];
  const headerRow = document.createElement('tr');
  columns.forEach(column => {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    headerRow.appendChild(cell);
  });
  const head = document.createElement('thead');
  head.appendChild(headerRow);
  const body = document.createElement('tbody');
  if (!report.items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = 'No hay ítems con adiciones distintas de cero en el período seleccionado.';
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    report.items.forEach(item => {
      const row = document.createElement('tr');
      columns.forEach(column => {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  }
  const footer = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.className = 'consumption-total-row';
  columns.forEach(column => {
    const cell = document.createElement('td');
    cell.textContent = column.total;
    totalRow.appendChild(cell);
  });
  footer.appendChild(totalRow);
  table.replaceChildren(head, body, footer);
}

function renderWasteSummary(data) {
  const report = data.report;
  document.getElementById('waste-summary-period').textContent =
    `${formatReportDate(report.dateFrom)} – ${formatReportDate(report.dateTo)} · solo ítems con adiciones distintas de cero.${report.itemsWithoutCost?.length ? ` ${report.itemsWithoutCost.length} ítem(s) sin costo maestro vigente.` : ''}`;
  document.getElementById('waste-summary-item-count').textContent = `${report.itemCount} ítem(s)`;
  populateWasteSummaryTable(document.getElementById('waste-summary-table'), report);
  const section = document.getElementById('waste-summary-results');
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function generateSourceSummary() {
  const dialog = document.getElementById('source-summary-dialog');
  const dialogStatus = document.getElementById('source-summary-dialog-status');
  const pageStatus = document.getElementById('inventory-source-status');
  const button = document.getElementById('confirm-source-summary');
  const dateFrom = document.getElementById('source-summary-date-from').value;
  const dateTo = document.getElementById('source-summary-date-to').value;
  const field = pendingInventorySummaryField;
  if (!field || !dateFrom || !dateTo || dateFrom > dateTo) {
    return setStatus(dialogStatus, 'Selecciona un rango de fechas válido. Ambas fechas se incluyen.', 'error');
  }
  button.disabled = true;
  setStatus(dialogStatus, 'Generando resumen…');
  try {
    const location = document.getElementById('inventory-location-select').value;
    if (field === 'waste') {
      const data = await apiRequest(`/api/inventory/waste-summary?location=${encodeURIComponent(location)}&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`);
      renderWasteSummary(data);
      setStatus(pageStatus, 'Resumen de Merma generado correctamente.', 'success');
    } else {
      const data = await apiRequest(`/api/inventory/consumption-summary?location=${encodeURIComponent(location)}&field=${encodeURIComponent(field)}&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`);
      const titles = {
        marketing: 'Consumo de marketing',
        employees: 'Consumo de colaboradores'
      };
      document.getElementById('consumption-summary-title').textContent = titles[field];
      document.getElementById('consumption-summary-period').textContent =
        `${formatReportDate(dateFrom)} – ${formatReportDate(dateTo)} · ambas fechas incluidas.`;
      renderConsumptionReports({ [field]: data.summary }, [field], document.getElementById('standalone-consumption-report'));
      const section = document.getElementById('consumption-summary-results');
      section.hidden = false;
      section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setStatus(pageStatus, `Resumen de ${titles[field].toLowerCase()} generado correctamente.`, 'success');
    }
    dialog.close();
    pendingInventorySummaryField = null;
  } catch (error) {
    setStatus(dialogStatus, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function buildConsumptionTable(columns, rows, totals = null) {
  const wrap = document.createElement('div');
  wrap.className = 'consumption-table-wrap';
  const table = document.createElement('table');
  table.className = 'consumption-table';
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.className = `consumption-col-${column.key}`;
    cell.textContent = column.label;
    headRow.appendChild(cell);
  }
  const head = document.createElement('thead');
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  for (const item of rows) {
    const row = document.createElement('tr');
    for (const column of columns) {
      const cell = document.createElement('td');
      cell.className = `consumption-col-${column.key}`;
      const value = String(column.value(item) ?? '');
      cell.textContent = column.maxChars && value.length > column.maxChars
        ? `${value.slice(0, column.maxChars - 1)}…`
        : value;
      if (column.maxChars && value.length > column.maxChars) cell.title = value;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  if (totals) {
    const footRow = document.createElement('tr');
    footRow.className = 'consumption-total-row';
    for (const column of columns) {
      const cell = document.createElement('td');
      cell.className = `consumption-col-${column.key}`;
      cell.textContent = totals[column.key] ?? '';
      footRow.appendChild(cell);
    }
    const foot = document.createElement('tfoot');
    foot.appendChild(footRow);
    table.appendChild(foot);
  }
  wrap.appendChild(table);
  return wrap;
}

function renderCostReconciliation(data) {
  const productCost = Number(data.products.totalCost) || 0;
  const ingredientCost = Number(data.ingredients.totalCost) || 0;
  const difference = productCost - ingredientCost;
  const percentage = productCost ? Math.abs(difference) / productCost * 100 : 0;
  const box = document.createElement('aside');
  box.className = `cost-reconciliation ${Math.abs(difference) < 1 ? 'is-balanced' : 'has-difference'}`;

  const title = document.createElement('strong');
  title.textContent = Math.abs(difference) < 1 ? 'Costos conciliados' : 'Explicación de la diferencia de costos';
  const comparison = document.createElement('p');
  comparison.textContent = `Productos: ${formatClp(productCost)} · Ingredientes: ${formatClp(ingredientCost)} · Diferencia: ${formatClp(difference)} (${percentage.toLocaleString('es-CL', { maximumFractionDigits: 1 })}%).`;
  const method = document.createElement('p');
  method.textContent = 'El costo de productos usa el costo unitario del maestro vigente. El costo de ingredientes se recalcula desde cada receta, considerando cantidades, rendimiento y conversiones de unidad. La comparación correcta es entre los costos totales; sumar costos unitarios es solo una referencia y no representa por sí sola el costo consumido.';
  box.append(title, comparison, method);

  const reasons = [];
  const withoutRecipe = data.ingredients.productsWithoutRecipe || [];
  const withoutCost = data.ingredients.ingredientsWithoutCost || [];
  const withoutConversion = data.ingredients.ingredientsWithoutConversion || [];
  if (withoutRecipe.length) reasons.push(`Productos sin receta: ${withoutRecipe.join(', ')}. Su costo aparece en productos, pero no puede descomponerse en ingredientes.`);
  if (withoutCost.length) reasons.push(`Ingredientes sin costo maestro: ${withoutCost.join(', ')}.`);
  if (withoutConversion.length) reasons.push(`Ingredientes con unidades incompatibles: ${withoutConversion.join(', ')}.`);
  if (Math.abs(difference) >= 1) reasons.push('La diferencia restante puede deberse a redondeos, tasas de rendimiento o a que el costo calculado del producto y los costos actuales de sus ingredientes provienen de actualizaciones distintas del maestro.');
  if (reasons.length) {
    const list = document.createElement('ul');
    for (const reason of reasons) {
      const item = document.createElement('li');
      item.textContent = reason;
      list.appendChild(item);
    }
    box.appendChild(list);
  }
  return box;
}

function sumConsumptionRows(rows, field) {
  return rows.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
}

function quantitiesByUnit(rows) {
  const totals = new Map();
  for (const item of rows) {
    const unit = item.unit || 'Sin unidad';
    totals.set(unit, (totals.get(unit) || 0) + (Number(item.quantity) || 0));
  }
  return [...totals.entries()]
    .map(([unit, quantity]) => `${formatInventoryQuantity(quantity)} ${unit}`)
    .join(' · ');
}

function renderConsumptionReports(
  consumption,
  fields = ['marketing', 'employees'],
  container = document.getElementById('inventory-consumption-reports')
) {
  container.replaceChildren(...fields.map(field => {
    const data = consumption?.[field];
    const card = document.createElement('section');
    card.className = 'consumption-report-card';
    const heading = document.createElement('h4');
    heading.textContent = data?.label || FIELD_LABELS[field] || field;
    card.appendChild(heading);
    if (!data?.available || data.error || !data.products) {
      const error = document.createElement('p');
      error.className = 'form-status error';
      error.textContent = data?.error || 'No hay información disponible para este período.';
      card.appendChild(error);
      return card;
    }
    const summary = document.createElement('div');
    summary.className = 'consumption-report-summary';
    for (const text of [
      `Hoja: ${data.products.sheetName}`,
      `${data.products.products.length} productos consumidos`,
      `Costo productos: ${formatClp(data.products.totalCost)}`,
      `Costo ingredientes: ${formatClp(data.ingredients.totalCost)}`
    ]) {
      const badge = document.createElement('span');
      badge.className = 'chip neutral';
      badge.textContent = text;
      summary.appendChild(badge);
    }
    card.appendChild(summary);
    if (!data.ingredients.error) card.appendChild(renderCostReconciliation(data));

    const productPart = document.createElement('section');
    productPart.className = 'consumption-report-part';
    const productTitle = document.createElement('h5');
    productTitle.textContent = '1. Resumen de productos consumidos';
    const productRows = data.products.products;
    productPart.append(productTitle, buildConsumptionTable([
      { key: 'code', label: 'Código', value: item => item.code, maxChars: 18 },
      { key: 'name', label: 'Producto', value: item => item.name, maxChars: 50 },
      { key: 'quantity', label: 'Cantidad', value: item => formatInventoryQuantity(item.quantity) },
      { key: 'unitCost', label: 'Costo unit.', value: item => formatClp(item.unitCost) },
      { key: 'totalCost', label: 'Costo total', value: item => formatClp(item.totalCost) }
    ], productRows, {
      code: 'TOTAL',
      quantity: formatInventoryQuantity(sumConsumptionRows(productRows, 'quantity')),
      totalCost: formatClp(sumConsumptionRows(productRows, 'totalCost'))
    }));
    if (data.products.productsWithoutMasterCost?.length) {
      const warning = document.createElement('p');
      warning.className = 'form-status muted';
      warning.textContent = `${data.products.productsWithoutMasterCost.length} producto(s) sin costo en el maestro; se usó el costo de la planilla.`;
      productPart.appendChild(warning);
    }
    card.appendChild(productPart);

    const ingredientPart = document.createElement('section');
    ingredientPart.className = 'consumption-report-part';
    const ingredientTitle = document.createElement('h5');
    ingredientTitle.textContent = '2. Resumen de ingredientes consumidos';
    ingredientPart.appendChild(ingredientTitle);
    if (data.ingredients.error) {
      const error = document.createElement('p');
      error.className = 'form-status error';
      error.textContent = data.ingredients.error;
      ingredientPart.appendChild(error);
    } else {
      const ingredientRows = data.ingredients.items;
      ingredientPart.appendChild(buildConsumptionTable([
        { key: 'code', label: 'Código', value: item => item.code, maxChars: 18 },
        { key: 'name', label: 'Ingrediente', value: item => item.name, maxChars: 50 },
        { key: 'quantity', label: 'Cantidad', value: item => formatInventoryQuantity(item.quantity) },
        { key: 'unit', label: 'Unidad', value: item => item.unit },
        { key: 'unitCost', label: 'Costo unit.', value: item => formatClp(item.unitCost) },
        { key: 'totalCost', label: 'Costo total', value: item => formatClp(item.totalCost) }
      ], ingredientRows, {
        code: 'TOTAL',
        quantity: quantitiesByUnit(ingredientRows),
        totalCost: formatClp(sumConsumptionRows(ingredientRows, 'totalCost'))
      }));
      const warningParts = [];
      if (data.ingredients.productsWithoutRecipe.length) warningParts.push(`${data.ingredients.productsWithoutRecipe.length} producto(s) sin receta`);
      if (data.ingredients.ingredientsWithoutCost.length) warningParts.push(`${data.ingredients.ingredientsWithoutCost.length} ingrediente(s) sin costo`);
      if (data.ingredients.ingredientsWithoutConversion?.length) warningParts.push(`${data.ingredients.ingredientsWithoutConversion.length} ingrediente(s) con unidad de costo incompatible`);
      if (warningParts.length) {
        const warning = document.createElement('p');
        warning.className = 'form-status muted';
        warning.textContent = warningParts.join(' · ');
        ingredientPart.appendChild(warning);
      }
    }
    card.appendChild(ingredientPart);
    return card;
  }));
}

function renderInventoryResults(data) {
  const report = data.report;
  renderConsumptionReports(data.consumption);
  const wasteSection = document.getElementById('inventory-waste-report');
  if (data.waste?.available && data.waste.report) {
    document.getElementById('inventory-waste-period').textContent =
      `${formatReportDate(data.waste.report.dateFrom)} – ${formatReportDate(data.waste.report.dateTo)} · ${data.waste.report.itemCount} ítem(s) con adiciones.${data.waste.report.itemsWithoutCost?.length ? ` ${data.waste.report.itemsWithoutCost.length} ítem(s) sin costo maestro vigente.` : ''}`;
    populateWasteSummaryTable(document.getElementById('inventory-waste-table'), data.waste.report);
    wasteSection.hidden = false;
  } else {
    wasteSection.hidden = true;
  }
  const basisLabel = basis => basis === 'final' ? 'Inventario Final' : 'Inventario Inicial';
  document.getElementById('inventory-report-period').textContent = report.selection
    ? `Saldo inicial: ${basisLabel(report.selection.initialBasis)} del ${formatReportDate(report.selection.initialDate)} · movimientos: ${formatReportDate(report.dateFrom)} a ${formatReportDate(report.dateTo)}, ambas fechas incluidas · saldo final: ${basisLabel(report.selection.finalBasis)} del ${formatReportDate(report.selection.finalDate)}.`
    : `${formatReportDate(report.dateFrom)} a ${formatReportDate(report.dateTo)} · inventario físico tomado del inicio del ${formatReportDate(report.physicalInventoryDate)}.`;
  document.getElementById('inventory-report-item-count').textContent = `${report.itemCount} productos`;
  const table = document.getElementById('inventory-results-table');
  const header = document.createElement('tr');
  const columns = [
    { label: 'Código', value: item => item.code },
    { label: 'Producto', value: item => item.name },
    { label: 'Unidad', value: item => item.unit },
    {
      label: 'Costo unitario',
      value: item => item.costAvailable ? formatKardexCost(item.unitCost) : 'Sin costo'
    },
    {
      label: report.selection
        ? `${basisLabel(report.selection.initialBasis)} ${formatReportDate(report.selection.initialDate)}`
        : 'Inventario inicial',
      value: item => formatKardexQuantity(item.initialInventory)
    },
    ...report.movementDefinitions.map(definition => ({
      label: definition.label,
      value: item => formatKardexQuantity(item.movements[definition.key])
    })),
    ...(report.selection ? [
      {
        label: 'Inventario Final Teórico',
        value: item => formatKardexQuantity(item.theoreticalFinal)
      },
      {
        label: `${basisLabel(report.selection.finalBasis)} ${formatReportDate(report.selection.finalDate)}`,
        value: item => formatKardexQuantity(item.finalInventory)
      },
      {
        label: 'Diferencia de Inventario',
        value: item => formatKardexQuantity(item.difference),
        signValue: item => item.difference
      }
    ] : [
      { label: 'Inventario final teórico', value: item => formatKardexQuantity(item.theoreticalFinal) },
      { label: `Inventario físico ${formatReportDate(report.physicalInventoryDate)}`, value: item => formatKardexQuantity(item.physicalFinal) },
      { label: 'Diferencia físico − teórico', value: item => formatKardexQuantity(item.difference), signValue: item => item.difference }
    ]),
    { label: 'Consumo Colaboradores', value: item => formatKardexQuantity(item.employeeConsumption) },
    { label: 'Consumo Marketing', value: item => formatKardexQuantity(item.marketingConsumption) },
    {
      label: 'Diferencia ajustada por consumos',
      value: item => formatKardexQuantity(item.adjustedDifference),
      signValue: item => item.adjustedDifference,
      adjustedDifference: true
    },
    { label: 'Costo Total', value: item => item.costAvailable ? formatKardexCost(item.totalCost) : 'Sin costo' }
  ];
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    header.appendChild(cell);
  }
  const head = document.createElement('thead');
  head.appendChild(header);
  const body = document.createElement('tbody');
  for (const item of report.items) {
    const row = document.createElement('tr');
    for (const column of columns) {
      const cell = document.createElement('td');
      cell.textContent = column.value(item);
      if (column.signValue) {
        const value = Number(column.signValue(item)) || 0;
        if (value < 0) cell.className = 'difference-negative';
        else if (value > 0) cell.className = column.adjustedDifference ? 'difference-adjusted-positive' : 'difference-positive';
      }
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  const foot = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.className = 'consumption-total-row';
  columns.forEach((column, index) => {
    const cell = document.createElement('td');
    if (index === 0) cell.textContent = 'TOTAL';
    else if (index === columns.length - 1) cell.textContent = formatKardexCost(report.totalCost);
    totalRow.appendChild(cell);
  });
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);
  const results = document.getElementById('inventory-report-results');
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function generateInventoryReport() {
  const status = document.getElementById('inventory-source-status');
  const dialogStatus = document.getElementById('inventory-process-dialog-status');
  const dialog = document.getElementById('inventory-process-dialog');
  const button = document.getElementById('confirm-inventory-process');
  const initialInventoryDate = document.getElementById('inventory-initial-date').value;
  const finalInventoryDate = document.getElementById('inventory-final-date').value;
  const movementDateFrom = document.getElementById('inventory-movement-from').value;
  const movementDateTo = document.getElementById('inventory-movement-to').value;
  const availableDates = inventorySourceState?.kardexPeriod?.dates || [];
  if (!initialInventoryDate || !finalInventoryDate || !movementDateFrom || !movementDateTo || movementDateFrom > movementDateTo) {
    return setStatus(dialogStatus, 'Completa las cuatro fechas y selecciona un rango de movimientos válido.', 'error');
  }
  if (!availableDates.includes(initialInventoryDate) || !availableDates.includes(finalInventoryDate)) {
    return setStatus(dialogStatus, 'Las fechas de los saldos inicial y final deben existir en el Kardex.', 'error');
  }
  button.disabled = true;
  setStatus(status, 'Consolidando el Kardex para el período seleccionado…');
  setStatus(dialogStatus, 'Procesando informe…');
  try {
    const data = await apiRequest('/api/inventory/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: document.getElementById('inventory-location-select').value,
        initialInventoryDate,
        initialInventoryBasis: document.getElementById('inventory-initial-basis').value,
        finalInventoryDate,
        finalInventoryBasis: document.getElementById('inventory-final-basis').value,
        movementDateFrom,
        movementDateTo
      })
    });
    dialog.close();
    renderInventoryResults(data);
    setStatus(status, 'Informe de inventario procesado correctamente.', 'success');
  } catch (error) {
    setStatus(dialogStatus, error.message, 'error');
    setStatus(status, 'No fue posible procesar el informe. Revisa los criterios indicados.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshLocationConfiguration() {
  const status = document.getElementById('location-status');
  try {
    const data = await apiRequest('/api/config/locations');
    locationRegistry = Object.fromEntries(data.active.map(location => [location.id, location]));
    refreshReportLocationFilter();
    refreshProductsLocationFilter();
    refreshPurchasesLocationFilter();
    refreshInventoryLocationFilter();
    const select = document.getElementById('location-select');
    const previous = select.value;
    const options = data.active.map(location => {
      const option = document.createElement('option');
      option.value = location.id;
      option.textContent = location.name;
      option.dataset.type = location.type;
      return option;
    });
    select.replaceChildren(...options);
    if (locationRegistry[previous]) select.value = previous;
    renderLocationManagement(data);
    updateLocationFields();
    return data;
  } catch (error) {
    setStatus(status, error.message, 'error');
    throw error;
  }
}

function renderLocationManagement(data) {
  const activeList = document.getElementById('active-locations-list');
  const trashList = document.getElementById('trashed-locations-list');
  activeList.replaceChildren();
  trashList.replaceChildren();

  if (!data.active.length) activeList.textContent = 'No hay ubicaciones activas.';
  for (const location of data.active) {
    const row = document.createElement('article');
    row.className = 'location-row';
    const nameInput = document.createElement('input');
    nameInput.value = location.name;
    nameInput.maxLength = 80;
    nameInput.setAttribute('aria-label', `Nombre de ${location.name}`);
    const type = document.createElement('span');
    type.className = 'location-type-badge';
    type.textContent = location.type === 'warehouse' ? 'Bodega' : 'Cafetería';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'icon-button small';
    saveButton.textContent = 'Guardar nombre';
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      try {
        await apiRequest(`/api/config/locations/${encodeURIComponent(location.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value })
        });
        setStatus(document.getElementById('location-status'), 'Nombre actualizado.', 'success');
        await refreshLocationConfiguration();
      } catch (error) {
        setStatus(document.getElementById('location-status'), error.message, 'error');
        saveButton.disabled = false;
      }
    });
    const trashButton = document.createElement('button');
    trashButton.type = 'button';
    trashButton.className = 'delete-button small';
    trashButton.textContent = 'Enviar a papelera';
    trashButton.addEventListener('click', () => openLocationTrashDialog(location));
    row.append(nameInput, type, saveButton, trashButton);
    activeList.appendChild(row);
  }

  if (!data.trash.length) trashList.textContent = 'La papelera está vacía.';
  for (const location of data.trash) {
    const row = document.createElement('article');
    row.className = 'location-row trashed-location-row';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = location.name;
    const date = document.createElement('div');
    date.className = 'subtle';
    date.textContent = location.trashedAt ? `En papelera desde ${new Date(location.trashedAt).toLocaleString('es-CL')}` : 'En papelera';
    details.append(name, date);
    const type = document.createElement('span');
    type.className = 'location-type-badge';
    type.textContent = location.type === 'warehouse' ? 'Bodega' : 'Cafetería';
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'icon-button small';
    restoreButton.textContent = 'Restaurar';
    restoreButton.addEventListener('click', async () => {
      restoreButton.disabled = true;
      try {
        await apiRequest(`/api/config/locations/${encodeURIComponent(location.id)}/restore`, { method: 'POST' });
        setStatus(document.getElementById('location-status'), `${location.name} fue restaurada.`, 'success');
        await refreshLocationConfiguration();
      } catch (error) {
        setStatus(document.getElementById('location-status'), error.message, 'error');
        restoreButton.disabled = false;
      }
    });
    row.append(details, type, restoreButton);
    trashList.appendChild(row);
  }
}

function openLocationTrashDialog(location) {
  pendingTrashLocation = location;
  document.getElementById('location-trash-step-one').hidden = false;
  document.getElementById('location-trash-step-two').hidden = true;
  document.getElementById('location-trash-confirmation-name').value = '';
  document.getElementById('confirm-location-trash').disabled = true;
  document.getElementById('location-trash-dialog').showModal();
}

function closeLocationTrashDialog() {
  pendingTrashLocation = null;
  document.getElementById('location-trash-dialog').close();
}

function showInspection(manifest) {
  inspectionState = manifest;
  const confirmation = document.getElementById('date-confirmation');
  const list = document.getElementById('detected-files-list');
  list.replaceChildren();
  for (const file of manifest.files) {
    const row = document.createElement('div');
    row.className = 'detected-file';
    const name = document.createElement('strong');
    name.textContent = `${FIELD_LABELS[file.field] || file.field}: ${file.originalName}`;
    const range = document.createElement('span');
    range.textContent = formatDetectedRange(file.detectedRange);
    if (!file.detectedRange) range.className = 'detection-warning';
    row.append(name, range);
    if (file.overlapRange) {
      const overlap = document.createElement('span');
      overlap.className = 'detection-warning';
      overlap.textContent = `Coincide con datos existentes: ${formatDetectedRange(file.overlapRange)}`;
      row.appendChild(overlap);
    }
    list.appendChild(row);
  }
  document.getElementById('confirmed-date-from').value = manifest.detectedRange?.from || '';
  document.getElementById('confirmed-date-to').value = manifest.detectedRange?.to || '';
  document.getElementById('dates-confirmed').checked = false;
  const overlapNotice = document.getElementById('transaction-overlap-notice');
  const replaceButton = document.getElementById('replace-transactions-btn');
  const keepButton = document.getElementById('keep-transactions-btn');
  overlapNotice.hidden = !manifest.hasOverlap;
  replaceButton.hidden = !manifest.hasOverlap;
  if (manifest.hasOverlap) {
    keepButton.textContent = 'Mantener existentes y agregar nuevos';
    const descriptions = manifest.files.filter(file => file.overlapRange).map(file =>
      `${FIELD_LABELS[file.field] || file.field}: ${formatDetectedRange(file.overlapRange)}`);
    overlapNotice.textContent = `Ya existen datos para ${descriptions.join(' · ')}. Puedes mantenerlos y agregar únicamente registros no repetidos, o reemplazar completamente la información de esos días con la nueva carga.`;
    document.getElementById('transaction-confirmation-copy').textContent =
      'Revisa el rango y elige qué hacer con los días que coinciden con datos ya guardados.';
  } else {
    keepButton.textContent = 'Confirmar y guardar registros';
    overlapNotice.textContent = '';
    document.getElementById('transaction-confirmation-copy').textContent =
      'No se encontraron fechas coincidentes. Confirma el rango para agregar estos registros al sistema.';
  }
  confirmation.hidden = false;
  confirmation.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderMasterList() {
  const container = document.getElementById('master-list');
  container.replaceChildren();
  try {
    const data = await apiRequest('/api/masters');
    updateLatestMasterDates(data);
    const versions = Object.keys(data).sort().reverse();
    if (!versions.length) {
      container.textContent = 'Aún no hay archivos maestros guardados.';
      return;
    }
    for (const version of versions) {
      const group = document.createElement('article');
      group.className = 'master-version';
      const title = document.createElement('strong');
      title.textContent = new Date(version).toLocaleString('es-CL');
      group.appendChild(title);
      for (const [field, record] of Object.entries(data[version])) {
        const row = document.createElement('div');
        row.className = 'master-record';
        const details = document.createElement('span');
        details.textContent = `${MASTER_FIELD_LABELS[field] || field} · válido desde: ${record.validFrom || 'no especificado'} · `;
        row.appendChild(details);
        appendDownload(row, record);
        const actions = document.createElement('div');
        actions.className = 'master-record-actions';
        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.className = 'icon-button small';
        previewButton.textContent = 'Vista previa';
        previewButton.addEventListener('click', () => openMasterPreview(version, field));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'delete-button small';
        deleteButton.textContent = 'Eliminar';
        deleteButton.addEventListener('click', () => showDeleteConfirmation(row, version, field, record));
        actions.append(previewButton, deleteButton);
        row.appendChild(actions);
        group.appendChild(row);
      }
      container.appendChild(group);
    }
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'form-status error';
    message.textContent = error.message;
    container.appendChild(message);
  }
}

function updateLatestMasterDates(data) {
  const latest = {};
  for (const group of Object.values(data)) {
    for (const [storedField, record] of Object.entries(group)) {
      const field = LEGACY_MASTER_FIELDS[storedField] || storedField;
      if (record.validFrom && (!latest[field] || record.validFrom > latest[field])) latest[field] = record.validFrom;
    }
  }
  document.querySelectorAll('.latest-valid-date').forEach(badge => {
    const date = latest[badge.dataset.masterField];
    badge.textContent = `Última vigencia: ${date || '—'}`;
    badge.classList.toggle('empty', !date);
  });
}

function openMasterPreview(version, field) {
  openSpreadsheetPreview(
    `/api/masters/${encodeURIComponent(version)}/${encodeURIComponent(field)}/preview`,
    MASTER_FIELD_LABELS[field] || field
  );
}

async function openSpreadsheetPreview(endpoint, fallbackTitle, ids = {}) {
  const dialog = document.getElementById(ids.dialog || 'master-preview-dialog');
  const title = document.getElementById(ids.title || 'master-preview-title');
  const content = document.getElementById(ids.content || 'master-preview-content');
  title.textContent = fallbackTitle;
  content.textContent = 'Cargando vista previa…';
  dialog.showModal();
  try {
    const preview = await apiRequest(endpoint);
    title.textContent = preview.originalName;
    content.replaceChildren();
    if (preview.selectedRange) {
      const range = document.createElement('p');
      range.className = 'form-status success';
      range.textContent = `Período mostrado: ${formatReportDate(preview.selectedRange.from)} – ${formatReportDate(preview.selectedRange.to)}.`;
      content.appendChild(range);
    }
    for (const sheet of preview.sheets) {
      const section = document.createElement('section');
      section.className = 'preview-sheet';
      const heading = document.createElement('h4');
      heading.textContent = `${sheet.name} · ${sheet.totalRows} filas`;
      section.appendChild(heading);
      const tableWrap = document.createElement('div');
      tableWrap.className = 'preview-table-wrap';
      const table = document.createElement('table');
      sheet.rows.forEach((values, rowIndex) => {
        const row = document.createElement('tr');
        values.forEach(value => {
          const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
          cell.textContent = value ?? '';
          row.appendChild(cell);
        });
        table.appendChild(row);
      });
      tableWrap.appendChild(table);
      section.appendChild(tableWrap);
      if (sheet.truncated) {
        const notice = document.createElement('p');
        notice.className = 'subtle';
        notice.textContent = 'Vista limitada a 200 filas y 300 columnas.';
        section.appendChild(notice);
      }
      content.appendChild(section);
    }
  } catch (error) {
    content.textContent = error.message;
  }
}

function showDeleteConfirmation(row, version, field, record) {
  row.querySelector('.delete-confirmation')?.remove();
  const confirmation = document.createElement('div');
  confirmation.className = 'delete-confirmation';
  const message = document.createElement('span');
  message.textContent = `¿Eliminar permanentemente “${record.originalName || record.name}”?`;
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'delete-button small';
  confirmButton.textContent = 'Sí, eliminar';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'icon-button small';
  cancelButton.textContent = 'Cancelar';
  cancelButton.addEventListener('click', () => confirmation.remove());
  confirmButton.addEventListener('click', async () => {
    confirmButton.disabled = true;
    try {
      await apiRequest(`/api/masters/${encodeURIComponent(version)}/${encodeURIComponent(field)}`, { method: 'DELETE' });
      setStatus(document.getElementById('master-status'), 'Archivo maestro eliminado.', 'success');
      await renderMasterList();
    } catch (error) {
      setStatus(document.getElementById('master-status'), error.message, 'error');
      confirmButton.disabled = false;
    }
  });
  confirmation.append(message, confirmButton, cancelButton);
  row.appendChild(confirmation);
}

function hideMasterConflict() {
  document.getElementById('master-conflict').hidden = true;
  document.getElementById('master-conflict-message').textContent = '';
}

function showMasterConflict(conflicts) {
  const descriptions = conflicts.map(conflict => {
    const label = MASTER_FIELD_LABELS[conflict.field] || conflict.field;
    return `${label} (${conflict.validFrom}): ${conflict.existingOriginalName}`;
  });
  document.getElementById('master-conflict-message').textContent =
    `${descriptions.join(' · ')}. ¿Quieres reemplazar ${conflicts.length === 1 ? 'el archivo actual' : 'los archivos actuales'}?`;
  document.getElementById('master-conflict').hidden = false;
}

async function uploadMasterFiles(replace = false) {
  const form = document.getElementById('master-upload-form');
  const uploadButton = document.getElementById('upload-master-btn');
  const replaceButton = document.getElementById('replace-master-btn');
  const status = document.getElementById('master-status');
  const selectedInputs = [...form.querySelectorAll('input[type="file"]')].filter(input => input.files.length);
  if (!selectedInputs.length) {
    setStatus(status, 'Selecciona al menos un archivo maestro.', 'error');
    return;
  }
  const missingDate = selectedInputs.find(input => !form.elements[`${input.name}-from`]?.value);
  if (missingDate) {
    setStatus(status, `Indica la fecha “Válido desde” para ${MASTER_FIELD_LABELS[missingDate.name] || missingDate.name}.`, 'error');
    return;
  }

  uploadButton.disabled = true;
  replaceButton.disabled = true;
  setStatus(status, replace ? 'Reemplazando archivo maestro…' : 'Guardando archivos maestros…');
  try {
    await apiRequest(`/upload/master${replace ? '?replace=true' : ''}`, { method: 'POST', body: new FormData(form) });
    form.reset();
    hideMasterConflict();
    setStatus(status, replace ? 'Archivo maestro reemplazado correctamente.' : 'Archivos maestros guardados correctamente.', 'success');
    await renderMasterList();
  } catch (error) {
    if (error.status === 409 && error.data?.code === 'MASTER_DATE_CONFLICT') {
      showMasterConflict(error.data.conflicts || []);
      setStatus(status, 'Ya existe un archivo del mismo tipo con esa fecha de inicio.', 'error');
    } else {
      setStatus(status, error.message, 'error');
    }
  } finally {
    uploadButton.disabled = false;
    replaceButton.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
      setView(link.dataset.view || 'general');
    });
  });
  document.querySelectorAll('.upload-mode').forEach(button => {
    button.addEventListener('click', () => setUploadMode(button.dataset.uploadMode));
  });

  const refreshButton = document.querySelector('.activity-panel .icon-button');
  refreshButton?.addEventListener('click', () => {
    refreshButton.textContent = 'Synced';
    refreshButton.classList.add('synced');
  });

  initializeFileUploadControls();
  renderMasterList();
  await refreshLocationConfiguration().catch(() => {});

  document.getElementById('location-select').addEventListener('change', updateLocationFields);
  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      clearInspection(true);
      updateFileUploadControls();
    });
  });

  document.getElementById('weekly-upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('inspect-week-btn');
    const status = document.getElementById('week-status');
    const files = [...form.querySelectorAll('input[type="file"]:not(:disabled)')].flatMap(input => [...input.files]);
    if (!files.length) return setStatus(status, 'Selecciona al menos un archivo.', 'error');
    clearInspection();
    button.disabled = true;
    setStatus(status, 'Leyendo archivos y detectando fechas…');
    try {
      const location = document.getElementById('location-select').value;
      const manifest = await apiRequest(`/api/uploads/transactions/inspect?location=${encodeURIComponent(location)}`, {
        method: 'POST',
        body: new FormData(form)
      });
      showInspection(manifest);
      setStatus(status, manifest.detectedRange
        ? `Fechas detectadas: ${formatDetectedRange(manifest.detectedRange)}. Revisa y confirma abajo.`
        : 'No se detectaron fechas automáticamente. Ingresa el rango correcto y confírmalo.', 'success');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  async function confirmTransactionUpload(overlapAction) {
    const button = overlapAction === 'replace'
      ? document.getElementById('replace-transactions-btn')
      : document.getElementById('keep-transactions-btn');
    const status = document.getElementById('week-status');
    const dateFrom = document.getElementById('confirmed-date-from').value;
    const dateTo = document.getElementById('confirmed-date-to').value;
    const confirmed = document.getElementById('dates-confirmed').checked;
    if (!inspectionState) return setStatus(status, 'Vuelve a revisar los archivos antes de confirmar.', 'error');
    if (!dateFrom || !dateTo) return setStatus(status, 'Ingresa las fechas desde y hasta.', 'error');
    if (!confirmed) return setStatus(status, 'Marca la confirmación de fechas antes de guardar.', 'error');
    button.disabled = true;
    setStatus(status, 'Guardando archivos confirmados…');
    try {
      const savedLocation = inspectionState.location;
      const result = await apiRequest('/api/uploads/transactions/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inspectionState.token, dateFrom, dateTo, confirmed: true, overlapAction })
      });
      clearWeeklySelections();
      clearInspection();
      await loadTransactionFiles();
      await loadLatestSalesTransaction(savedLocation);
      if (result.imports?.sales) {
        const imported = result.imports.sales;
        setStatus(status, imported.newTransactions
          ? `${imported.newTransactions} transacción(es) nueva(s) guardada(s); ${imported.duplicateTransactions} ya existente(s) omitida(s).`
          : `Archivo procesado sin duplicar datos: no había transacciones nuevas y ${imported.duplicateTransactions} ya existía(n).`, 'success');
      } else {
        setStatus(status, overlapAction === 'replace'
          ? `Se reemplazaron los días coincidentes y se conservaron los datos fuera del rango para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`
          : `Se agregaron los registros nuevos sin duplicar los ya existentes para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`, 'success');
      }
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }
  document.getElementById('keep-transactions-btn').addEventListener('click', () => confirmTransactionUpload('keep'));
  document.getElementById('replace-transactions-btn').addEventListener('click', () => confirmTransactionUpload('replace'));

  document.getElementById('master-upload-form').addEventListener('submit', event => {
    event.preventDefault();
    uploadMasterFiles(false);
  });
  document.getElementById('replace-master-btn').addEventListener('click', () => uploadMasterFiles(true));
  document.getElementById('cancel-master-btn').addEventListener('click', () => {
    document.getElementById('master-upload-form').reset();
    hideMasterConflict();
    setStatus(document.getElementById('master-status'), 'Carga cancelada.', 'muted');
  });
  document.getElementById('master-upload-form').addEventListener('change', () => {
    hideMasterConflict();
  });
  document.getElementById('close-master-preview').addEventListener('click', () => {
    document.getElementById('master-preview-dialog').close();
  });
  document.getElementById('refresh-weekly-report').addEventListener('click', loadWeeklySalesReport);
  document.getElementById('report-location-filter').addEventListener('change', loadWeeklySalesReport);
  document.getElementById('products-location-filter').addEventListener('change', () => {
    document.getElementById('products-comparison').hidden = true;
    loadProductsView();
  });
  document.getElementById('products-search').addEventListener('input', renderProductsView);
  document.getElementById('refresh-products').addEventListener('click', loadProductsView);
  document.getElementById('purchases-location-filter').addEventListener('change', () => {
    document.getElementById('purchases-supplier-filter').value = 'all';
    document.getElementById('purchases-date-from').value = '';
    document.getElementById('purchases-date-to').value = '';
    loadPurchasesView();
  });
  document.getElementById('purchases-supplier-filter').addEventListener('change', loadPurchasesView);
  document.getElementById('purchases-date-from').addEventListener('change', loadPurchasesView);
  document.getElementById('purchases-date-to').addEventListener('change', loadPurchasesView);
  document.getElementById('refresh-purchases').addEventListener('click', loadPurchasesView);
  document.getElementById('save-products-report').addEventListener('click', () => saveProductsReport(false));
  document.getElementById('products-saved-report').addEventListener('change', event => {
    document.getElementById('compare-products-report').disabled = !event.currentTarget.value;
  });
  document.getElementById('compare-products-report').addEventListener('click', compareProductsReport);
  document.getElementById('close-products-comparison').addEventListener('click', () => {
    document.getElementById('products-comparison').hidden = true;
  });
  document.getElementById('inventory-location-select').addEventListener('change', loadInventorySources);
  document.getElementById('process-inventory-report').addEventListener('click', openInventoryProcessDialog);
  document.getElementById('confirm-inventory-process').addEventListener('click', generateInventoryReport);
  for (const id of ['close-inventory-process-dialog', 'cancel-inventory-process']) {
    document.getElementById(id).addEventListener('click', () => {
      document.getElementById('inventory-process-dialog').close();
    });
  }
  document.getElementById('confirm-source-summary').addEventListener('click', generateSourceSummary);
  for (const id of ['close-source-summary-dialog', 'cancel-source-summary']) {
    document.getElementById(id).addEventListener('click', () => {
      pendingInventorySummaryField = null;
      document.getElementById('source-summary-dialog').close();
    });
  }
  document.getElementById('close-waste-summary').addEventListener('click', () => {
    document.getElementById('waste-summary-results').hidden = true;
  });
  document.getElementById('close-consumption-summary').addEventListener('click', () => {
    document.getElementById('consumption-summary-results').hidden = true;
  });
  document.getElementById('close-inventory-preview').addEventListener('click', () => {
    document.getElementById('inventory-preview-dialog').close();
  });
  document.getElementById('confirm-inventory-preview').addEventListener('click', confirmInventoryPreviewRange);
  for (const id of ['close-inventory-preview-range', 'cancel-inventory-preview-range']) {
    document.getElementById(id).addEventListener('click', () => {
      pendingInventoryPreview = null;
      document.getElementById('inventory-preview-range-dialog').close();
    });
  }
  document.getElementById('inventory-upload-files').addEventListener('click', () => {
    const location = document.getElementById('inventory-location-select').value;
    const uploadLink = document.querySelector('.nav-link[data-view="uploads"]');
    document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === uploadLink));
    setView('uploads');
    if (locationRegistry[location]) {
      document.getElementById('location-select').value = location;
      updateLocationFields();
    }
  });

  document.getElementById('create-location-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await apiRequest('/api/config/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('new-location-name').value,
          type: document.getElementById('new-location-type').value
        })
      });
      form.reset();
      setStatus(document.getElementById('location-status'), 'Ubicación creada.', 'success');
      await refreshLocationConfiguration();
    } catch (error) {
      setStatus(document.getElementById('location-status'), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('continue-location-trash').addEventListener('click', () => {
    if (!pendingTrashLocation) return;
    document.getElementById('location-trash-step-one').hidden = true;
    document.getElementById('location-trash-step-two').hidden = false;
    document.getElementById('location-trash-confirmation-copy').textContent =
      `Escribe “${pendingTrashLocation.name}” para confirmar que quieres mover esta ubicación y todos sus archivos a la papelera.`;
    const input = document.getElementById('location-trash-confirmation-name');
    input.placeholder = pendingTrashLocation.name;
    input.focus();
  });
  document.getElementById('location-trash-confirmation-name').addEventListener('input', event => {
    document.getElementById('confirm-location-trash').disabled = event.target.value !== pendingTrashLocation?.name;
  });
  document.getElementById('confirm-location-trash').addEventListener('click', async event => {
    if (!pendingTrashLocation) return;
    const location = pendingTrashLocation;
    event.currentTarget.disabled = true;
    try {
      await apiRequest(`/api/config/locations/${encodeURIComponent(location.id)}/trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationStage: 2, confirmationText: location.name })
      });
      closeLocationTrashDialog();
      setStatus(document.getElementById('location-status'), `${location.name} fue enviada a la papelera.`, 'success');
      await refreshLocationConfiguration();
    } catch (error) {
      setStatus(document.getElementById('location-status'), error.message, 'error');
      event.currentTarget.disabled = false;
    }
  });
  document.querySelectorAll('.cancel-location-trash').forEach(button => {
    button.addEventListener('click', closeLocationTrashDialog);
  });
  document.getElementById('location-trash-dialog').addEventListener('close', () => {
    pendingTrashLocation = null;
  });
});
