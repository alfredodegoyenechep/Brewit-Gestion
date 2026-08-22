let locationRegistry = {};
const FIELD_LABELS = {
  kardex: 'Kardex / inventario',
  waste: 'Merma',
  marketing: 'Consumo de marketing',
  employees: 'Consumo de colaboradores',
  purchases: 'Compras',
  sales: 'Ventas',
  mercadopago: 'Transacciones MercadoPago'
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
let ingredientsViewState = null;
let purchasesViewState = null;
let purchaseCostVariationState = null;
let purchaseProjectionState = null;
let salesDashboardState = null;
let salesIngredientsState = null;
let salesHierarchyPath = [];
let pendingInventorySummaryField = null;
let pendingInventoryPreview = null;
let pendingTransactionDelete = null;
let inventoryKardexTableState = null;
let transactionUploadContext = null;
const expandedUploadHistories = new Set();
let productsSort = { key: 'unitsLast7Days', direction: 'desc' };
let ingredientsSort = { key: 'usageCost', direction: 'desc' };
let purchasesSort = { key: 'date', direction: 'desc' };
let purchaseCostVariationSort = { key: 'product', direction: 'asc' };
let purchaseProjectionSort = { key: 'supplier', direction: 'asc' };
const expandedIngredients = new Set();
const selectedSalesAnalysis = new Set();
const collapsedSalesAnalysisGroups = new Set();

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
  if (view === 'sales') {
    const sales = document.getElementById('sales-workspace');
    sales.hidden = false;
    sales.style.display = '';
    loadSalesDashboard();
    return;
  }
  if (view === 'sales-ingredients') {
    const salesIngredients = document.getElementById('sales-ingredients-workspace');
    salesIngredients.hidden = false;
    salesIngredients.style.display = '';
    loadSalesIngredientsView();
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
  if (view === 'ingredients') {
    const ingredients = document.getElementById('ingredients-workspace');
    ingredients.hidden = false;
    ingredients.style.display = '';
    loadIngredientsView();
    return;
  }
  if (view === 'purchases') {
    const purchases = document.getElementById('purchases-workspace');
    purchases.hidden = false;
    purchases.style.display = '';
    loadPurchasesView();
    return;
  }
  if (view === 'purchase-projection') {
    const projection = document.getElementById('purchase-projection-workspace');
    projection.hidden = false;
    projection.style.display = '';
    loadPurchaseProjection();
    return;
  }
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
    const control = document.createElement('div');
    control.className = 'file-upload-control';
    const state = document.createElement('button');
    state.type = 'button';
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
    row.querySelector('.transaction-upload-history')?.remove();
    const field = row.dataset.weeklyField;
    const input = row.querySelector('input[type="file"]');
    const state = row.querySelector('.file-upload-state');
    const filename = row.querySelector('.file-upload-filename');
    const uploaded = currentWeekFiles[field];
    const latest = uploaded?.latest;
    const actions = row.querySelector('.weekly-file-actions');
    actions.replaceChildren();

    if (latest) {
      state.textContent = `Último archivo subido ${expandedUploadHistories.has(field) ? '▲' : '▼'}`;
      state.className = 'file-upload-state uploaded';
      state.disabled = false;
      state.title = 'Ver historial de cargas';
      state.onclick = () => {
        if (expandedUploadHistories.has(field)) expandedUploadHistories.delete(field);
        else expandedUploadHistories.add(field);
        updateFileUploadControls();
      };
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
      deleteButton.addEventListener('click', () => openTransactionDeleteDialog(field, uploaded));
      actions.append(previewButton, deleteButton);
    } else {
      state.textContent = 'Sin archivos subidos';
      state.className = 'file-upload-state missing';
      state.disabled = true;
      state.title = '';
      state.onclick = null;
      filename.textContent = '';
    }
    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'primary small transaction-upload-button';
    uploadButton.textContent = 'Cargar nuevo archivo';
    uploadButton.disabled = input.disabled;
    uploadButton.addEventListener('click', () => {
      transactionUploadContext = { source: 'uploads', statusId: 'week-status', location: document.getElementById('location-select').value };
      clearInspection(true);
      document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(other => {
        if (other !== input) other.value = '';
      });
      input.value = '';
      input.click();
    });
    actions.appendChild(uploadButton);

    if (latest && expandedUploadHistories.has(field)) {
      const history = document.createElement('div');
      history.className = 'transaction-upload-history';
      const heading = document.createElement('strong');
      heading.textContent = `Historial de cargas (${uploaded.uploads?.length || uploaded.fileCount})`;
      history.appendChild(heading);
      (uploaded.uploads || [latest]).forEach((record, index) => {
        const item = document.createElement('div');
        item.className = 'transaction-upload-history-item';
        const name = document.createElement('span');
        name.textContent = `${index + 1}. ${record.originalName || record.name}`;
        const details = document.createElement('span');
        const range = record.confirmedRange || record.detectedRange;
        const saved = record.savedAt ? new Date(record.savedAt).toLocaleString('es-CL') : record.week ? `Semana ${record.week}` : 'Fecha no disponible';
        details.textContent = `${saved}${range ? ` · ${formatDetectedRange(range)}` : ''}${record.overlapAction === 'replace' ? ' · Reemplazó fechas coincidentes' : ' · Agregó registros nuevos'}`;
        item.append(name, details);
        history.appendChild(item);
      });
      row.appendChild(history);
    }
  });
}

function openWeeklyPreview(field, record) {
  openSpreadsheetPreview(
    record.previewUrl,
    record.originalName || record.name
  );
}

function openTransactionDeleteDialog(field, uploaded) {
  pendingTransactionDelete = {
    field,
    location: document.getElementById('location-select').value,
    fileCount: uploaded.fileCount,
    latest: uploaded.latest
  };
  const label = FIELD_LABELS[field] || field;
  document.getElementById('transaction-delete-title').textContent = `Eliminar ${label}`;
  document.getElementById('transaction-delete-description').textContent =
    `Hay ${uploaded.fileCount} carga(s) guardada(s). La última es “${uploaded.latest.originalName || uploaded.latest.name}”. Selecciona el alcance y confirma antes de continuar.`;
  document.querySelector('input[name="transaction-delete-action"][value="last"]').checked = true;
  document.getElementById('transaction-delete-confirmation').value = '';
  document.getElementById('confirm-transaction-delete').disabled = true;
  setStatus(document.getElementById('transaction-delete-status'), 'Esta acción no puede deshacerse desde esta pantalla.', 'muted');
  document.getElementById('transaction-delete-dialog').showModal();
}

function closeTransactionDeleteDialog() {
  pendingTransactionDelete = null;
  document.getElementById('transaction-delete-dialog').close();
}

function transactionUploadStatus() {
  return document.getElementById(transactionUploadContext?.statusId || 'week-status');
}

async function inspectSelectedTransactionFile(input, locationOverride = null) {
  if (!input.files.length) return;
  const status = transactionUploadStatus();
  clearInspection();
  setStatus(status, `Validando “${input.files[0].name}” y detectando sus fechas…`);
  document.querySelectorAll('.transaction-upload-button').forEach(button => { button.disabled = true; });
  try {
    const location = locationOverride || transactionUploadContext?.location || document.getElementById('location-select').value;
    const formData = new FormData();
    formData.append(input.name, input.files[0]);
    const manifest = await apiRequest(`/api/uploads/transactions/inspect?location=${encodeURIComponent(location)}`, {
      method: 'POST',
      body: formData
    });
    showInspection(manifest);
    setStatus(status, manifest.detectedRange
      ? `Estructura válida. Fechas detectadas: ${formatDetectedRange(manifest.detectedRange)}. Revisa y confirma en la ventana emergente.`
      : 'La estructura es válida, pero no se detectaron fechas. Ingresa el rango correcto en la ventana emergente.', 'success');
  } catch (error) {
    input.value = '';
    setStatus(status, error.message, 'error');
    transactionUploadContext = null;
  } finally {
    updateFileUploadControls();
  }
}

function clearWeeklySelections() {
  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => { input.value = ''; });
  document.getElementById('report-sales-upload-input').value = '';
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
  if (confirmation.open) confirmation.close();
  document.getElementById('dates-confirmed').checked = false;
  document.getElementById('detected-files-list').replaceChildren();
  document.getElementById('transaction-overlap-notice').hidden = true;
  document.getElementById('replace-transactions-btn').hidden = true;
  setStatus(document.getElementById('transaction-confirmation-status'), '');
  if (clearStatus) setStatus(document.getElementById('week-status'), '');
}

function cancelTransactionConfirmation() {
  const status = transactionUploadStatus();
  clearWeeklySelections();
  clearInspection();
  setStatus(status, 'Carga cancelada.', 'muted');
  transactionUploadContext = null;
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
  document.getElementById('location-note').textContent = !hasLocation
    ? 'Crea o recupera una ubicación en Configuración para cargar archivos.'
    : isWarehouse
      ? 'Esta bodega solo requiere su Kardex de inventario.'
      : 'Esta cafetería recibe Kardex, merma, consumos de marketing y colaboradores, compras, ventas y transacciones MercadoPago.';
  currentWeekFiles = {};
  clearWeeklySelections();
  clearInspection(true);
  loadTransactionFiles();
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

function renderSalesStatistics(statistics) {
  const shortDate = (value, includeWeekday = false) => {
    if (!value) return '—';
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('es-CL', {
      ...(includeWeekday ? { weekday: 'short' } : {}),
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date(year, month - 1, day)).replace(/\./g, '');
  };
  const monthLabel = value => {
    const [year, month] = value.split('-').map(Number);
    const label = new Intl.DateTimeFormat('es-CL', { month: 'short', year: 'numeric' })
      .format(new Date(year, month - 1, 1)).replace(/\./g, '');
    return label.charAt(0).toUpperCase() + label.slice(1);
  };
  const renderRows = (bodyId, rows, labelFor) => {
    const body = document.getElementById(bodyId);
    body.replaceChildren(...rows.map(item => {
      const row = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = labelFor(item);
      const amount = document.createElement('td');
      const amountContent = document.createElement('span');
      amountContent.className = 'sales-statistics-value-wrap';
      if (item.variationPercent !== null && Number.isFinite(item.variationPercent)) {
        const variation = document.createElement('span');
        variation.className = `sales-statistics-variation ${item.variationPercent < 0 ? 'negative' : 'positive'}`;
        variation.textContent = `${item.variationPercent > 0 ? '+' : ''}${item.variationPercent.toFixed(1)}%`;
        amountContent.appendChild(variation);
      }
      const value = document.createElement('span');
      value.textContent = formatClp(item.netSales);
      amountContent.appendChild(value);
      amount.appendChild(amountContent);
      row.append(label, amount);
      return row;
    }));
  };
  renderRows('sales-statistics-months', statistics.months, item => monthLabel(item.key));
  renderRows('sales-statistics-weeks', statistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`);
  renderRows('sales-statistics-days', statistics.days, item => shortDate(item.date, true));
  renderRows('sales-statistics-equivalent-days', statistics.equivalentDays, item => shortDate(item.date, true));
}

async function loadWeeklySalesReport() {
  const status = document.getElementById('report-status');
  const refreshButton = document.getElementById('refresh-weekly-report');
  const locationFilter = document.getElementById('report-location-filter');
  const selectedLocation = locationFilter.value || 'all';
  const includeToday = document.getElementById('report-include-today').checked;
  refreshButton.disabled = true;
  setStatus(status, 'Calculando ventas netas…');
  try {
    const report = await apiRequest(`/api/reports/weekly-sales?location=${encodeURIComponent(selectedLocation)}&includeToday=${includeToday}`);
    if (selectedLocation !== locationFilter.value || includeToday !== document.getElementById('report-include-today').checked) return;
    document.getElementById('report-scope-description').textContent = report.scope.type === 'all'
      ? 'Venta neta sin IVA, consolidada para todas las cafeterías.'
      : `Venta neta sin IVA para ${report.scope.label}.`;
    document.getElementById('report-yesterday-date').textContent = formatReportDate(report.previousDay.date);
    document.getElementById('report-reference-label').textContent = report.includeToday ? 'Venta de hoy' : 'Venta del día anterior';
    document.getElementById('report-cutoff-label').textContent = report.includeToday ? 'Venta hoy' : 'Venta día anterior';
    document.getElementById('report-week-chip').textContent = report.includeToday ? 'Lun–hoy' : 'Lun–ayer';
    document.getElementById('report-month-chip').textContent = report.includeToday ? 'Mes–hoy' : 'Mes–ayer';
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
    renderSalesStatistics(report.statistics);
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

function closeReportSalesLocationDialog() {
  const dialog = document.getElementById('report-sales-location-dialog');
  if (dialog.open) dialog.close();
}

function openReportSalesFilePicker(location) {
  if (!location || !locationRegistry[location] || locationRegistry[location].type !== 'store') {
    return setStatus(document.getElementById('report-status'), 'Selecciona una cafetería válida para cargar sus ventas.', 'error');
  }
  transactionUploadContext = { source: 'report', statusId: 'report-status', location, refreshReport: true };
  const input = document.getElementById('report-sales-upload-input');
  input.value = '';
  input.click();
}

function startReportSalesUpload() {
  const selected = document.getElementById('report-location-filter').value || 'all';
  if (selected !== 'all') return openReportSalesFilePicker(selected);
  const select = document.getElementById('report-sales-upload-location');
  const stores = Object.values(locationRegistry).filter(location => location.type === 'store');
  select.replaceChildren(...stores.map(location => new Option(location.name, location.id)));
  if (!stores.length) {
    return setStatus(document.getElementById('report-status'), 'No hay cafeterías activas disponibles para cargar ventas.', 'error');
  }
  document.getElementById('report-sales-location-dialog').showModal();
}

function refreshSalesDashboardLocationFilter() {
  const select = document.getElementById('sales-dashboard-location');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function dashboardChange(value, suffix = '') {
  if (value === null || !Number.isFinite(value)) return 'Sin base de comparación';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}${suffix || '%'} vs. período anterior`;
}

function renderSalesDashboardMetrics(metrics) {
  const container = document.getElementById('sales-dashboard-metrics');
  const definitions = [
    ['day', 'Venta de hoy'],
    ['yesterday', 'Venta del día anterior'],
    ['week', 'Venta de la semana'],
    ['month', 'Venta del mes']
  ];
  container.replaceChildren(...definitions.map(([key, label], index) => {
    const metric = metrics[key];
    const card = document.createElement('article');
    card.className = `sales-kpi-card${index === 0 ? ' primary' : ''}`;
    const heading = document.createElement('div');
    heading.className = 'sales-kpi-label';
    heading.textContent = label;
    const value = document.createElement('div');
    value.className = 'sales-kpi-value';
    value.textContent = formatClp(metric.netSales);
    const range = document.createElement('div');
    range.className = 'sales-kpi-range';
    range.textContent = metric.from === metric.to
      ? formatReportDate(metric.from)
      : `${formatReportDate(metric.from)} – ${formatReportDate(metric.to)}`;
    const comparison = document.createElement('div');
    comparison.className = metric.changePercent === null ? 'sales-kpi-comparison neutral' : metric.changePercent >= 0 ? 'sales-kpi-comparison positive' : 'sales-kpi-comparison negative';
    comparison.textContent = dashboardChange(metric.changePercent);
    const prior = document.createElement('div');
    prior.className = 'sales-kpi-prior';
    prior.textContent = `${metric.previous.label}: ${formatClp(metric.previous.netSales)}`;
    card.append(heading, value, range, comparison, prior);
    return card;
  }));
}

function renderSalesLocations(report) {
  const body = document.getElementById('sales-location-body');
  body.replaceChildren(...report.sales.locations.map(location => {
    const row = document.createElement('tr');
    [location.name, formatClp(location.day), formatClp(location.yesterday), formatClp(location.week), formatClp(location.month)]
      .forEach((text, index) => {
        const cell = document.createElement(index ? 'td' : 'th');
        cell.textContent = text;
        if (index) cell.className = 'numeric-cell';
        row.appendChild(cell);
      });
    return row;
  }));
  const totals = report.sales.metrics;
  const row = document.createElement('tr');
  ['Total', formatClp(totals.day.netSales), formatClp(totals.yesterday.netSales), formatClp(totals.week.netSales), formatClp(totals.month.netSales)]
    .forEach((text, index) => {
      const cell = document.createElement(index ? 'td' : 'th');
      cell.textContent = text;
      if (index) cell.className = 'numeric-cell';
      row.appendChild(cell);
    });
  document.getElementById('sales-location-foot').replaceChildren(row);
}

function renderSalesInsights() {
  if (!salesDashboardState) return;
  const key = document.getElementById('sales-insight-period').value;
  const insight = salesDashboardState.sales.productInsights[key];
  const productContainer = document.getElementById('sales-top-products');
  if (!insight.topProducts.length) {
    productContainer.textContent = 'No hay productos vendidos en este período.';
    productContainer.className = 'sales-ranked-list empty-state';
  } else {
    productContainer.className = 'sales-ranked-list';
    productContainer.replaceChildren(...insight.topProducts.map((product, index) => {
      const row = document.createElement('div');
      row.className = 'sales-ranked-row';
      const rank = document.createElement('span');
      rank.className = 'sales-rank-number';
      rank.textContent = String(index + 1);
      const name = document.createElement('div');
      name.className = 'sales-ranked-name';
      name.innerHTML = `<strong></strong><small></small>`;
      name.querySelector('strong').textContent = product.name;
      name.querySelector('small').textContent = product.code || 'Sin código';
      const values = document.createElement('div');
      values.className = 'sales-ranked-values';
      values.innerHTML = `<strong></strong><small></small>`;
      values.querySelector('strong').textContent = `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(product.quantity)} un.`;
      values.querySelector('small').textContent = formatClp(product.netSales);
      row.append(rank, name, values);
      return row;
    }));
  }
  const hierarchyContainer = document.getElementById('sales-hierarchy-share');
  const tree = insight.hierarchyTree;
  const findHierarchyNode = (node, path, depth = 0) => {
    if (depth === path.length) return node;
    const child = node.children.find(item => item.name === path[depth]);
    return child ? findHierarchyNode(child, path, depth + 1) : node;
  };
  const currentNode = tree ? findHierarchyNode(tree, salesHierarchyPath) : null;
  const backButton = document.getElementById('sales-hierarchy-back');
  backButton.hidden = salesHierarchyPath.length === 0;
  document.getElementById('sales-hierarchy-context').textContent = ['Todas las jerarquías', ...salesHierarchyPath].join(' › ');
  if (!currentNode || !currentNode.netSales) {
    document.getElementById('sales-hierarchy-title').textContent = 'Venta por jerarquía';
    hierarchyContainer.textContent = 'No hay venta por jerarquía en este período.';
    hierarchyContainer.className = 'sales-share-list empty-state';
  } else if (currentNode.children.length) {
    document.getElementById('sales-hierarchy-title').textContent = salesHierarchyPath.length ? 'Subjerarquías' : 'Venta por jerarquía';
    hierarchyContainer.className = 'sales-share-list';
    hierarchyContainer.replaceChildren(...currentNode.children.map(item => {
      const percent = currentNode.netSales ? item.netSales / currentNode.netSales * 100 : 0;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sales-share-row sales-share-navigation';
      row.setAttribute('aria-label', `Ver detalle de ${item.name}`);
      const header = document.createElement('div');
      header.className = 'sales-share-head';
      const name = document.createElement('span');
      name.textContent = item.name;
      const value = document.createElement('strong');
      const margin = item.contributionMarginPercent;
      value.textContent = `${percent.toFixed(1)}% part. · Margen ${margin === null ? '—' : `${margin.toFixed(1)}%`} · ${formatClp(item.netSales)}  ›`;
      value.classList.add(margin === null ? 'neutral' : margin < 0 ? 'negative' : 'positive');
      header.append(name, value);
      const track = document.createElement('div');
      track.className = 'sales-share-track';
      const fill = document.createElement('span');
      fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      track.appendChild(fill);
      row.append(header, track);
      row.addEventListener('click', () => {
        salesHierarchyPath = [...item.path];
        renderSalesInsights();
      });
      return row;
    }));
  } else {
    document.getElementById('sales-hierarchy-title').textContent = 'Productos vendidos';
    hierarchyContainer.className = 'sales-share-list hierarchy-product-list';
    hierarchyContainer.replaceChildren(...currentNode.products.map((item, index) => {
      const percent = currentNode.netSales ? item.netSales / currentNode.netSales * 100 : 0;
      const row = document.createElement('div');
      row.className = 'sales-share-row hierarchy-product-row';
      const header = document.createElement('div');
      header.className = 'sales-share-head';
      const name = document.createElement('span');
      name.textContent = `${index + 1}. ${item.name} · ${item.code || 'Sin código'} · ${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(item.quantity)} un.`;
      const value = document.createElement('strong');
      const margin = item.contributionMarginPercent;
      value.className = 'sales-product-financials';
      const participation = document.createElement('span');
      participation.textContent = `${percent.toFixed(1)}% part. ·`;
      const marginValue = document.createElement('span');
      marginValue.className = margin === null ? 'product-margin neutral' : margin < 0 ? 'product-margin negative' : 'product-margin positive';
      marginValue.textContent = `Margen ${margin === null ? '—' : `${margin.toFixed(1)}%`} ·`;
      const salesValue = document.createElement('span');
      salesValue.textContent = formatClp(item.netSales);
      value.append(participation, marginValue, salesValue);
      header.append(name, value);
      const track = document.createElement('div');
      track.className = 'sales-share-track';
      const fill = document.createElement('span');
      fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      track.appendChild(fill);
      row.append(header, track);
      return row;
    }));
  }
}

function renderMercadoPago(report) {
  const customer = report.mercadoPago.customers;
  const summary = document.getElementById('mercadopago-customer-summary');
  summary.replaceChildren();
  for (const [label, value] of [['Tarjetas identificadas', customer.identified], ['Clientes recurrentes', customer.recurrent]]) {
    const item = document.createElement('div');
    item.innerHTML = `<strong></strong><span></span>`;
    item.querySelector('strong').textContent = new Intl.NumberFormat('es-CL').format(value);
    item.querySelector('span').textContent = label;
    summary.appendChild(item);
  }
  const labels = { day: 'Hoy', week: 'Semana', month: 'Mes' };
  document.getElementById('mercadopago-period-body').replaceChildren(...Object.entries(report.mercadoPago.metrics).map(([key, metric]) => {
    const row = document.createElement('tr');
    const prior = `${formatClp(metric.previous.sales)} · ${metric.previous.transactions} trans. · ${metric.previous.recurringTransactionPercent.toFixed(1)}% recurrentes`;
    const cells = [
      labels[key],
      `${formatClp(metric.sales)} (${dashboardChange(metric.salesChangePercent).replace(' vs. período anterior', '')})`,
      `${metric.transactions} (${dashboardChange(metric.transactionChangePercent).replace(' vs. período anterior', '')})`,
      `${metric.recurringTransactionPercent.toFixed(1)}% (${metric.recurringTransactionPercentChange >= 0 ? '+' : ''}${metric.recurringTransactionPercentChange.toFixed(1)} pp)`,
      `${metric.recurringSalesPercent.toFixed(1)}% (${metric.recurringSalesPercentChange >= 0 ? '+' : ''}${metric.recurringSalesPercentChange.toFixed(1)} pp)`,
      prior
    ];
    cells.forEach((text, index) => {
      const cell = document.createElement(index ? 'td' : 'th');
      cell.textContent = text;
      row.appendChild(cell);
    });
    return row;
  }));
  const definitions = [
    ['moreThanThreeWeekly', 'Más de 3 veces por semana'],
    ['moreThanWeekly', 'Más de 1 vez por semana'],
    ['moreThanEvery15Days', 'Más de 1 vez cada 15 días'],
    ['moreThanMonthly', 'Más de 1 vez al mes'],
    ['occasional', 'Recurrentes menos frecuentes']
  ];
  document.getElementById('mercadopago-frequency').replaceChildren(...definitions.map(([key, label]) => {
    const card = document.createElement('div');
    card.className = 'frequency-card';
    const value = document.createElement('strong');
    value.textContent = new Intl.NumberFormat('es-CL').format(customer.frequency[key]);
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(value, caption);
    return card;
  }));
  const monthLabel = period => new Intl.DateTimeFormat('es-CL', { month: 'short', year: 'numeric' })
    .format(dateFromKey(period.from));
  const shortDate = value => new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short' })
    .format(dateFromKey(value));
  const historyRow = (period, label) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    row.appendChild(heading);
    const percentCell = document.createElement('td');
    percentCell.className = 'recurring-percent-cell';
    const percent = document.createElement('strong');
    percent.textContent = `${period.recurringSalesPercent.toFixed(1)}%`;
    const track = document.createElement('span');
    track.className = 'recurring-percent-track';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.max(0, period.recurringSalesPercent))}%`;
    track.appendChild(fill);
    percentCell.append(percent, track);
    row.appendChild(percentCell);
    const values = [
      `${formatClp(period.recurringSales)} / ${formatClp(period.totalSales)}`,
      period.identifiedCards,
      period.recurrentCustomers,
      period.frequency.moreThanThreeWeekly,
      period.frequency.moreThanWeekly,
      period.frequency.moreThanEvery15Days,
      period.frequency.moreThanMonthly,
      period.frequency.occasional
    ];
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = typeof value === 'number' ? new Intl.NumberFormat('es-CL').format(value) : value;
      row.appendChild(cell);
    });
    return row;
  };
  document.getElementById('mercadopago-month-history').replaceChildren(...report.mercadoPago.history.months.map(period =>
    historyRow(period, monthLabel(period))));
  document.getElementById('mercadopago-week-history').replaceChildren(...report.mercadoPago.history.weeks.map(period =>
    historyRow(period, `${shortDate(period.from)} – ${shortDate(period.to)}`)));
}

async function loadSalesDashboard() {
  const status = document.getElementById('sales-dashboard-status');
  const button = document.getElementById('refresh-sales-dashboard');
  const select = document.getElementById('sales-dashboard-location');
  const location = select.value || 'all';
  button.disabled = true;
  setStatus(status, 'Calculando indicadores de ventas y recurrencia…');
  try {
    const report = await apiRequest(`/api/sales/dashboard?location=${encodeURIComponent(location)}`);
    if (location !== select.value) return;
    salesDashboardState = report;
    salesHierarchyPath = [];
    document.getElementById('sales-dashboard-description').textContent = `Venta neta sin IVA para ${report.scope.label}. Indicadores al ${formatReportDate(report.date)}.`;
    renderSalesDashboardMetrics(report.sales.metrics);
    renderSalesLocations(report);
    renderSalesInsights();
    renderMercadoPago(report);
    const sourceText = `${report.sales.filesRead} archivo(s) de ventas y ${report.mercadoPago.filesRead} archivo(s) MercadoPago procesado(s).`;
    setStatus(status, report.warnings.length ? `${sourceText} ${report.warnings.join(' ')}` : sourceText, report.warnings.length ? 'error' : 'success');
  } catch (error) {
    salesDashboardState = null;
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function salesAnalysisChip(text) {
  const chip = document.createElement('span');
  chip.className = 'chip neutral';
  chip.textContent = text;
  return chip;
}

function formatSalesAnalysisPercent(value) {
  return Number.isFinite(value)
    ? `${value.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
    : '—';
}

function updateSalesAnalysisSelectionCount() {
  const count = selectedSalesAnalysis.size;
  document.getElementById('sales-ingredients-selected-count').textContent = `${count} seleccionado${count === 1 ? '' : 's'}`;
  document.getElementById('run-sales-ingredients').disabled = !count;
}

function renderSalesAnalysisPickers() {
  if (!salesIngredientsState) return;
  const ingredients = salesIngredientsState.options.ingredients || [];
  const hierarchySelect = document.getElementById('sales-ingredient-hierarchy');
  const previousHierarchy = hierarchySelect.value || 'all';
  const hierarchies = [...new Map(ingredients.map(item => [item.hierarchyId, {
    id: item.hierarchyId,
    label: item.hierarchyPath.join(' › ')
  }])).values()].sort((left, right) => left.label.localeCompare(right.label, 'es'));
  hierarchySelect.replaceChildren(new Option('Todas las jerarquías', 'all'),
    ...hierarchies.map(item => new Option(item.label, item.id)));
  hierarchySelect.value = hierarchies.some(item => item.id === previousHierarchy) ? previousHierarchy : 'all';
  const ingredientQuery = document.getElementById('sales-ingredient-search').value.trim().toLocaleLowerCase('es');
  const visibleIngredients = ingredients.filter(item =>
    (hierarchySelect.value === 'all' || item.hierarchyId === hierarchySelect.value)
    && (!ingredientQuery || `${item.code} ${item.name}`.toLocaleLowerCase('es').includes(ingredientQuery)));
  const renderOption = (item, detail) => {
    const label = document.createElement('label');
    label.className = 'sales-analysis-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.selectionKey = item.key;
    input.checked = selectedSalesAnalysis.has(item.key);
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = item.name;
    const context = document.createElement('small');
    context.textContent = detail;
    text.append(name, context);
    label.append(input, text);
    return label;
  };
  const ingredientContainer = document.getElementById('sales-ingredient-options');
  ingredientContainer.replaceChildren(...visibleIngredients.map(item => renderOption(item,
    `${item.source === 'recipe-extra' ? 'Extra con receta · ' : ''}${item.code} · ${item.unit || 'sin unidad'}`)));
  if (!visibleIngredients.length) ingredientContainer.textContent = 'No hay ingredientes para este filtro.';

  const extraQuery = document.getElementById('sales-extra-search').value.trim().toLocaleLowerCase('es');
  const extras = (salesIngredientsState.options.extras || []).filter(item =>
    !extraQuery || item.hierarchyPath.join(' ').toLocaleLowerCase('es').includes(extraQuery));
  const extraContainer = document.getElementById('sales-extra-options');
  extraContainer.replaceChildren(...extras.map(item => renderOption(item, item.hierarchyPath.slice(0, -1).join(' › ') || 'Jerarquía de extras')));
  if (!extras.length) extraContainer.textContent = salesIngredientsState.options.extrasHierarchiesAvailable
    ? 'No hay clasificaciones para este filtro.'
    : 'No hay un maestro de jerarquía de extras vigente.';
  updateSalesAnalysisSelectionCount();
}

function renderSalesIngredientsReport() {
  const report = document.getElementById('sales-ingredients-report');
  const summary = document.getElementById('sales-ingredients-summary');
  if (!salesIngredientsState) {
    report.replaceChildren();
    summary.replaceChildren();
    return;
  }
  const { groups, totals } = salesIngredientsState;
  summary.replaceChildren(
    salesAnalysisChip(`${totals.selectedGroups} criterio(s)`),
    salesAnalysisChip(`${totals.uniqueProducts} producto(s) sin duplicar`),
    salesAnalysisChip(`${formatProductUnits(totals.productUnits)} unidades vendidas`),
    salesAnalysisChip(`${formatClp(totals.netSales)} venta neta asociada`),
    salesAnalysisChip(`${formatClp(totals.totalCost)} costo total`),
    salesAnalysisChip(`${formatSalesAnalysisPercent(totals.contributionMarginPercent)} margen`),
    salesAnalysisChip(`${totals.shareOfPeriodSales.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de la venta del período`)
  );
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Selecciona al menos un ingrediente o clasificación para generar el reporte.';
    report.replaceChildren(empty);
    return;
  }
  report.replaceChildren(...groups.map(group => {
    const card = document.createElement('article');
    card.className = 'sales-ingredient-result-card';
    card.dataset.groupKey = group.key;
    const collapsed = collapsedSalesAnalysisGroups.has(group.key);
    card.classList.toggle('collapsed', collapsed);
    const head = document.createElement('div');
    head.className = 'sales-ingredient-result-head';
    const titleWrap = document.createElement('div');
    const eyebrow = document.createElement('div');
    eyebrow.className = 'panel-eyebrow';
    eyebrow.textContent = group.source === 'recipe-extra'
      ? 'Extra con receta'
      : group.type === 'ingredient' ? 'Ingrediente de receta' : 'Clasificación de preparación';
    const title = document.createElement('h3');
    title.textContent = group.name;
    const context = document.createElement('p');
    context.className = 'panel-description';
    context.textContent = group.type === 'ingredient'
      ? `${group.code} · ${group.hierarchyPath.join(' › ')}`
      : group.hierarchyPath.join(' › ');
    titleWrap.append(eyebrow, title, context);
    const metrics = document.createElement('div');
    metrics.className = 'sales-ingredient-result-metrics';
    metrics.append(
      salesAnalysisChip(`${formatProductUnits(group.totals.productUnits)} unidades producto`),
      ...(group.type === 'ingredient' ? [salesAnalysisChip(`${formatProductUnits(group.totals.ingredientQuantity)} ${group.totals.ingredientUnit || ''} requeridos`)] : []),
      salesAnalysisChip(`${formatClp(group.totals.netSales)} venta neta`),
      salesAnalysisChip(`${formatClp(group.totals.totalCost)} costo total`),
      salesAnalysisChip(`${formatSalesAnalysisPercent(group.totals.contributionMarginPercent)} margen`),
      salesAnalysisChip(`${group.shareOfPeriodSales.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% del período`)
    );
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-button small sales-ingredient-collapse';
    toggle.dataset.groupKey = group.key;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? 'Expandir' : 'Colapsar';
    const actions = document.createElement('div');
    actions.className = 'sales-ingredient-result-actions';
    actions.append(metrics, toggle);
    head.append(titleWrap, actions);
    const wrap = document.createElement('div');
    wrap.className = 'sales-ingredient-result-table-wrap';
    const table = document.createElement('table');
    table.className = 'sales-ingredient-result-table';
    table.innerHTML = `<thead><tr><th>Código</th><th>Producto vendido</th><th>Unidades vendidas</th>${group.type === 'ingredient' ? '<th>Cantidad ingrediente</th>' : ''}<th>Venta neta sin IVA</th><th>Costo total producto</th><th>Margen</th><th>% del bloque</th></tr></thead>`;
    const body = document.createElement('tbody');
    for (const product of group.products) {
      const row = document.createElement('tr');
      const values = [
        product.code || '—', product.name, formatProductUnits(product.quantity),
        ...(group.type === 'ingredient' ? [product.ingredientQuantity === null ? 'Unidad no compatible' : `${formatProductUnits(product.ingredientQuantity)} ${group.totals.ingredientUnit || ''}`] : []),
        formatClp(product.netSales),
        formatClp(product.totalCost),
        formatSalesAnalysisPercent(product.netSales ? (product.netSales - product.totalCost) / product.netSales * 100 : null),
        `${(group.totals.netSales ? product.netSales / group.totals.netSales * 100 : 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index >= 2) cell.className = 'numeric';
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
    if (!group.products.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = group.type === 'ingredient' ? 8 : 7;
      cell.className = 'empty-state';
      cell.textContent = 'No hubo productos vendidos con este criterio en el período.';
      row.appendChild(cell);
      body.appendChild(row);
    }
    const foot = document.createElement('tfoot');
    const totalRow = document.createElement('tr');
    const totalLabel = document.createElement('th');
    totalLabel.colSpan = 2;
    totalLabel.textContent = 'TOTAL';
    const totalValues = [formatProductUnits(group.totals.productUnits),
      ...(group.type === 'ingredient' ? [`${formatProductUnits(group.totals.ingredientQuantity)} ${group.totals.ingredientUnit || ''}`] : []),
      formatClp(group.totals.netSales),
      formatClp(group.totals.totalCost),
      formatSalesAnalysisPercent(group.totals.contributionMarginPercent),
      '100,0%'];
    totalRow.appendChild(totalLabel);
    totalValues.forEach(value => {
      const cell = document.createElement('th');
      cell.textContent = value;
      cell.className = 'numeric';
      totalRow.appendChild(cell);
    });
    foot.appendChild(totalRow);
    table.append(body, foot);
    wrap.appendChild(table);
    card.append(head, wrap);
    return card;
  }));
}

async function loadSalesIngredientsView() {
  const status = document.getElementById('sales-ingredients-status');
  const button = document.getElementById('refresh-sales-ingredients');
  const location = document.getElementById('sales-ingredients-location').value || 'all';
  const params = new URLSearchParams({ location });
  const dateFrom = document.getElementById('sales-ingredients-from').value;
  const dateTo = document.getElementById('sales-ingredients-to').value;
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (selectedSalesAnalysis.size) params.set('selections', [...selectedSalesAnalysis].join(','));
  button.disabled = true;
  setStatus(status, 'Relacionando ventas, recetas, ingredientes y clasificaciones…');
  try {
    const data = await apiRequest(`/api/sales-by-ingredients?${params}`);
    salesIngredientsState = data;
    document.getElementById('sales-ingredients-from').value = data.period.from;
    document.getElementById('sales-ingredients-to').value = data.period.to;
    const validKeys = new Set([...data.options.ingredients, ...data.options.extras].map(item => item.key));
    for (const key of selectedSalesAnalysis) if (!validKeys.has(key)) selectedSalesAnalysis.delete(key);
    renderSalesAnalysisPickers();
    renderSalesIngredientsReport();
    const sourceText = `${data.filesRead} archivo(s) procesado(s) para ${data.scope.label}.`;
    setStatus(status, data.warnings.length ? `${sourceText} ${data.warnings.join(' ')}` : sourceText,
      data.warnings.length ? 'error' : 'success');
  } catch (error) {
    salesIngredientsState = null;
    renderSalesIngredientsReport();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
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

function refreshSalesIngredientsLocationFilter() {
  const select = document.getElementById('sales-ingredients-location');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function refreshIngredientsLocationFilter() {
  const select = document.getElementById('ingredients-location-filter');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry)
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'es') : left.type === 'store' ? -1 : 1))) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function refreshPurchasesLocationFilter() {
  const select = document.getElementById('purchases-location-filter');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry)
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'es') : left.type === 'store' ? -1 : 1))) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function refreshProjectionLocationFilter() {
  const select = document.getElementById('projection-location-filter');
  const previous = select.value;
  const options = Object.values(locationRegistry)
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'es') : left.type === 'store' ? -1 : 1))
    .map(location => new Option(location.name, location.id));
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : options[0]?.value || '';
}

function formatProductUnits(value) {
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function formatWeeklyAverageUnits(value) {
  return new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(Number(value) || 0);
}

function formatPurchaseConversion(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 4 }).format(Number(value));
}

function valueAtPath(item, key) {
  return key.split('.').reduce((value, part) => value?.[part], item);
}

function sortRows(items, sort) {
  const multiplier = sort.direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    const leftValue = valueAtPath(left, sort.key);
    const rightValue = valueAtPath(right, sort.key);
    if (leftValue === null || leftValue === undefined) return rightValue === null || rightValue === undefined ? 0 : 1;
    if (rightValue === null || rightValue === undefined) return -1;
    if (typeof leftValue === 'number' && typeof rightValue === 'number') return (leftValue - rightValue) * multiplier;
    if (typeof leftValue === 'boolean' && typeof rightValue === 'boolean') return (Number(leftValue) - Number(rightValue)) * multiplier;
    return String(leftValue).localeCompare(String(rightValue), 'es', { numeric: true, sensitivity: 'base' }) * multiplier;
  });
}

function applySort(sortState, key, defaultDirection = 'asc') {
  if (sortState.key === key) sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
  else {
    sortState.key = key;
    sortState.direction = defaultDirection;
  }
}

function markSortableHeader(cell, key, sortState, label) {
  cell.dataset.sortKey = key;
  cell.classList.add('sortable-table-header');
  cell.textContent = `${label}${sortState.key === key ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : ''}`;
  cell.setAttribute('aria-sort', sortState.key === key ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
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
    const headers = [
      ['code', 'Código'], ['name', 'Producto'], ['price', 'Precio venta'], ['netPrice', 'Precio venta neto'],
      ['cost', 'Costo'], ['marginPercent', 'Margen'], ['averageWeeklyUnits8', 'Prom. semanal 8 sem.'],
      ['unitsLast7Days', 'Últimos 7 días'], ['unitsChangePercent', 'Cambio vs. prom. 8 sem.']
    ];
    const headRow = document.createElement('tr');
    for (const [key, label] of headers) {
      const cell = document.createElement('th');
      markSortableHeader(cell, key, productsSort, label);
      headRow.appendChild(cell);
    }
    const head = document.createElement('thead');
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    for (const product of sortRows(group.products, productsSort)) {
      const row = document.createElement('tr');
      if (!product.active) row.className = 'inactive-product';
      const values = [
        product.code,
        product.name,
        formatClp(product.price),
        formatClp(product.netPrice),
        formatClp(product.cost),
        product.marginPercent === null ? '—' : `${product.marginPercent.toFixed(1)}%`,
        formatWeeklyAverageUnits(product.averageWeeklyUnits8),
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

function renderIngredientsView() {
  const body = document.getElementById('ingredients-table-body');
  const summary = document.getElementById('ingredients-summary');
  const ranking = document.getElementById('ingredients-cost-ranking');
  if (!ingredientsViewState) {
    body.replaceChildren();
    summary.replaceChildren();
    ranking.replaceChildren();
    return;
  }
  const supplier = document.getElementById('ingredients-supplier-filter').value || 'all';
  const query = document.getElementById('ingredients-search').value.trim().toLocaleLowerCase('es');
  const onlyChanged = document.getElementById('ingredients-only-changed').checked;
  const items = ingredientsViewState.items.filter(item =>
    (supplier === 'all' || item.supplierKey === supplier)
    && (!query || `${item.code} ${item.name}`.toLocaleLowerCase('es').includes(query))
    && (!onlyChanged || (item.costChangePercent !== null && Math.abs(item.costChangePercent) >= 0.01)));
  summary.replaceChildren(...[
    `${items.length} de ${ingredientsViewState.summary.ingredientCount} ingredientes`,
    `${items.filter(item => item.usageQuantity > 0).length} con consumo`,
    `Costo consumido: ${formatClp(items.reduce((sum, item) => sum + item.usageCost, 0))}`,
    `${items.filter(item => item.costChangePercent !== null && Math.abs(item.costChangePercent) >= 0.01).length} con variación de costo`
  ].map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  const ranked = [...items].filter(item => item.usageCost > 0).sort((left, right) => right.usageCost - left.usageCost).slice(0, 10);
  const rankingTotal = items.reduce((sum, item) => sum + item.usageCost, 0);
  ranking.replaceChildren(...ranked.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'ingredient-ranking-row';
    const label = document.createElement('span');
    label.textContent = `${index + 1}. ${item.name}`;
    const value = document.createElement('strong');
    value.textContent = `${rankingTotal ? (item.usageCost / rankingTotal * 100).toFixed(1) : '0,0'}% · ${formatClp(item.usageCost)}`;
    const track = document.createElement('span');
    track.className = 'ingredient-ranking-track';
    const fill = document.createElement('span');
    fill.style.width = `${rankingTotal ? Math.min(100, item.usageCost / rankingTotal * 100) : 0}%`;
    track.appendChild(fill);
    row.append(label, value, track);
    return row;
  }));
  if (!ranked.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No hay consumo valorizado para los filtros y período seleccionados.';
    ranking.appendChild(empty);
  }
  document.querySelectorAll('.ingredients-table thead th[data-sort-key]').forEach(cell => {
    markSortableHeader(cell, cell.dataset.sortKey, ingredientsSort, cell.textContent.replace(/ [▲▼]$/, ''));
  });
  const rows = [];
  for (const item of sortRows(items, ingredientsSort)) {
    const row = document.createElement('tr');
    row.dataset.code = item.code;
    const productCount = item.products.length;
    const values = [
      item.code, item.name, item.supplier, item.unit || '—', formatClp(item.unitCost),
      item.latestPurchaseCost === null ? '—' : formatClp(item.latestPurchaseCost),
      item.costChangePercent === null ? '—' : `${item.costChangePercent >= 0 ? '+' : ''}${item.costChangePercent.toFixed(1)}%`,
      `${formatProductUnits(item.usageQuantity)} ${item.usageUnit || item.unit}`, formatClp(item.usageCost)
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 6 && item.costChangePercent !== null) cell.className = item.costChangePercent > 0 ? 'ingredient-cost-up' : item.costChangePercent < 0 ? 'ingredient-cost-down' : '';
      row.appendChild(cell);
    });
    const detailCell = document.createElement('td');
    const detailButton = document.createElement('button');
    detailButton.type = 'button';
    detailButton.className = 'ingredient-detail-button';
    detailButton.dataset.ingredientCode = item.code;
    detailButton.disabled = productCount === 0;
    detailButton.textContent = productCount ? `${productCount} producto(s) ${expandedIngredients.has(item.code) ? '▲' : '▼'}` : 'Sin recetas';
    detailCell.appendChild(detailButton);
    row.appendChild(detailCell);
    rows.push(row);
    if (expandedIngredients.has(item.code)) {
      const detailRow = document.createElement('tr');
      detailRow.className = 'ingredient-products-detail';
      const detail = document.createElement('td');
      detail.colSpan = 10;
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Producto</th><th>Código</th><th>Cantidad receta</th><th>Rendimiento</th><th>Cantidad efectiva</th></tr></thead>';
      const detailBody = document.createElement('tbody');
      item.products.forEach(product => {
        const productRow = document.createElement('tr');
        [product.name, product.code, `${formatProductUnits(product.recipeQuantity)} ${product.recipeUnit}`, `${product.yieldRate.toFixed(1)}%`, `${formatProductUnits(product.effectiveQuantity)} ${product.effectiveUnit}`]
          .forEach(value => {
            const cell = document.createElement('td');
            cell.textContent = value;
            productRow.appendChild(cell);
          });
        detailBody.appendChild(productRow);
      });
      table.appendChild(detailBody);
      detail.appendChild(table);
      detailRow.appendChild(detail);
      rows.push(detailRow);
    }
  }
  body.replaceChildren(...rows);
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
    cell.className = 'ingredients-empty';
    cell.textContent = 'No hay ingredientes para los filtros seleccionados.';
    row.appendChild(cell);
    body.appendChild(row);
  }
}

async function loadIngredientsView() {
  const status = document.getElementById('ingredients-status');
  const button = document.getElementById('refresh-ingredients');
  const location = document.getElementById('ingredients-location-filter').value || 'all';
  const dateFrom = document.getElementById('ingredients-date-from').value;
  const dateTo = document.getElementById('ingredients-date-to').value;
  const params = new URLSearchParams({ location });
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  button.disabled = true;
  setStatus(status, 'Calculando uso, costos, proveedores y recetas…');
  try {
    const data = await apiRequest(`/api/ingredients?${params}`);
    ingredientsViewState = data;
    document.getElementById('ingredients-date-from').value = data.period.from;
    document.getElementById('ingredients-date-to').value = data.period.to;
    const supplierSelect = document.getElementById('ingredients-supplier-filter');
    const previous = supplierSelect.value || 'all';
    supplierSelect.replaceChildren(new Option('Todos los proveedores', 'all'), ...data.suppliers.map(item => new Option(item.name, item.key)));
    supplierSelect.value = data.suppliers.some(item => item.key === previous) ? previous : 'all';
    renderIngredientsView();
    setStatus(status, `Período ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} para ${data.scope.label}.`, 'success');
  } catch (error) {
    ingredientsViewState = null;
    renderIngredientsView();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
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
  const printButton = document.getElementById('print-purchases-report');
  const exportButton = document.getElementById('export-purchases-report');
  if (!purchasesViewState) {
    summary.replaceChildren();
    container.replaceChildren();
    printButton.disabled = true;
    exportButton.disabled = true;
    return;
  }
  const data = purchasesViewState;
  printButton.disabled = data.rows.length === 0;
  exportButton.disabled = data.rows.length === 0;
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
  container.replaceChildren(...[...groups.values()].map(groupRows => {
    const rows = sortRows(groupRows, purchasesSort);
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
      { key: 'date', label: 'Fecha', value: row => formatReportDate(row.date) },
      { key: 'locationName', label: 'Ubicación', value: row => row.locationName },
      { key: 'document', label: 'Documento', value: row => row.document || '—' },
      { key: 'code', label: 'Código', value: row => row.code || '—' },
      { key: 'product', label: 'Insumo', value: row => row.product || '—' },
      { key: 'quantity', label: 'Cantidad', value: row => formatProductUnits(row.quantity) },
      { key: 'purchaseUnit', label: 'UDC', headerTitle: 'Unidad de Compra', value: row => row.purchaseUnit || row.unit || '—' },
      {
        key: 'unitsPerPurchaseUnit',
        label: 'Unidades x UDC',
        headerTitle: 'UDC significa Unidad de Compra',
        value: row => formatPurchaseConversion(row.unitsPerPurchaseUnit),
        cellTitle: row => row.baseUnit && row.unitsPerPurchaseUnit !== null
          ? `1 ${row.purchaseUnit || row.unit} = ${formatPurchaseConversion(row.unitsPerPurchaseUnit)} ${row.baseUnit}`
          : 'Conversión no disponible en el maestro vigente'
      },
      { key: 'baseUnit', label: 'Unidad de Medida', value: row => row.baseUnit || '—' },
      { key: 'listedUnitPrice', label: 'Costo UDC registrado', value: row => formatClp(row.listedUnitPrice) },
      {
        key: 'baseUnitCost',
        label: 'Costo Unitario',
        value: row => row.baseUnitCost === null || row.baseUnitCost === undefined ? '—' : formatClp(row.baseUnitCost),
        muted: true
      },
      { key: 'discount', label: 'Descuento', value: row => formatClp(row.discount) },
      { key: 'effectiveUnitPrice', label: 'Precio unit. efectivo', value: row => formatClp(row.effectiveUnitPrice) },
      { key: 'previousEffectiveUnitPrice', label: 'Precio anterior', value: row => row.previousEffectiveUnitPrice === null ? '—' : formatClp(row.previousEffectiveUnitPrice) },
      {
        key: 'priceChangePercent',
        label: 'Cambio',
        value: row => row.priceChangePercent === null
          ? '—'
          : `${row.priceChangePercent >= 0 ? '+' : ''}${row.priceChangePercent.toFixed(1)}%`,
        change: true
      },
      { key: 'totalAmount', label: 'Monto total', value: row => formatClp(row.totalAmount) }
    ];
    const headRow = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('th');
      markSortableHeader(cell, column.key, purchasesSort, column.label);
      if (column.headerTitle) cell.title = column.headerTitle;
      if (column.muted) cell.classList.add('purchase-muted-column');
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
        if (column.cellTitle) cell.title = column.cellTitle(item);
        if (column.muted) cell.classList.add('purchase-muted-column');
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
  const product = document.getElementById('purchases-product-filter').value.trim();
  const dateFrom = document.getElementById('purchases-date-from').value;
  const dateTo = document.getElementById('purchases-date-to').value;
  const params = new URLSearchParams({ location, supplier });
  if (product) params.set('product', product);
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
    const productInput = document.getElementById('purchases-product-filter');
    const productOptions = document.getElementById('purchases-product-options');
    productOptions.replaceChildren(...data.products.map(item => {
      const option = document.createElement('option');
      option.value = item.code || item.name;
      option.label = item.code ? item.name : '';
      return option;
    }));
    productInput.value = data.filters.product || '';
    const fromInput = document.getElementById('purchases-date-from');
    const toInput = document.getElementById('purchases-date-to');
    fromInput.value = data.filters.dateFrom || '';
    toInput.value = data.filters.dateTo || '';
    fromInput.min = toInput.min = data.availablePeriod?.from || '';
    fromInput.max = toInput.max = data.availablePeriod?.to || '';
    renderPurchasesView();
    setStatus(status, data.sourceFileCount
      ? data.scope.type === 'warehouse'
        ? `${data.sourceFileCount} Kardex procesado(s) para ${data.scope.label}. Se muestran ingresos BUY; el Kardex no identifica proveedor ni documento de compra.`
        : `${data.sourceFileCount} archivo(s) procesado(s) para ${data.scope.label}.`
      : 'No hay información de compras disponible para la selección.', data.sourceFileCount ? 'success' : 'muted');
  } catch (error) {
    purchasesViewState = null;
    renderPurchasesView();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function purchasesReportFilename(extension) {
  const from = purchasesViewState?.filters.dateFrom || 'inicio';
  const to = purchasesViewState?.filters.dateTo || 'fin';
  return `historial-compras-${from}-${to}.${extension}`;
}

function printPurchasesReport() {
  if (!purchasesViewState?.rows.length) return;
  const section = document.getElementById('purchases-workspace');
  const previousTitle = document.title;
  document.title = `Historial de compras - ${purchasesViewState.scope.label}`;
  document.body.classList.add('printing-purchases-report');
  section.classList.add('purchases-print-target');
  try {
    window.print();
  } finally {
    section.classList.remove('purchases-print-target');
    document.body.classList.remove('printing-purchases-report');
    document.title = previousTitle;
  }
}

function exportPurchasesReport() {
  const data = purchasesViewState;
  const status = document.getElementById('purchases-status');
  if (!data?.rows.length) return;
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const locationSelect = document.getElementById('purchases-location-filter');
    const supplierSelect = document.getElementById('purchases-supplier-filter');
    const information = XLSX.utils.aoa_to_sheet([
      ['Reporte', 'Historial de compras e insumos'],
      ['Ubicación', locationSelect.selectedOptions[0]?.textContent || data.scope.label],
      ['Fecha inicial', data.filters.dateFrom || 'Sin límite'],
      ['Fecha final', data.filters.dateTo || 'Sin límite'],
      ['Proveedor', supplierSelect.selectedOptions[0]?.textContent || 'Todos los proveedores'],
      ['Producto / ingrediente', data.filters.product || 'Todos'],
      ['Fuente', data.scope.type === 'warehouse'
        ? 'Movimientos BUY según Kardex; proveedor y documento no disponibles'
        : 'Archivos de compras cargados para la ubicación'],
      ['Líneas', data.summary.lineCount],
      ['Monto total', data.summary.totalAmount],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    const headers = [
      'Fecha', 'Ubicación', 'Proveedor', 'RUT proveedor', 'Tipo documento', 'Documento', 'Línea',
      'Código', 'Insumo', 'Cantidad', 'UDC', 'Unidades x UDC', 'Unidad de Medida',
      'Costo UDC registrado', 'Costo Unitario', 'Descuento', 'Precio unit. efectivo',
      'Precio anterior', 'Cambio %', 'Monto neto', 'Monto total', 'Fuente'
    ];
    const values = data.rows.map(row => [
      row.date, row.locationName, row.supplier, row.supplierTaxId || '', row.documentType || '',
      row.document || '', row.line || '', row.code || '', row.product || '', row.quantity,
      row.purchaseUnit || row.unit || '', row.unitsPerPurchaseUnit, row.baseUnit || '',
      row.listedUnitPrice, row.baseUnitCost, row.discount, row.effectiveUnitPrice,
      row.previousEffectiveUnitPrice, row.priceChangePercent, row.netAmount, row.totalAmount,
      row.sourceType === 'kardex-buy' ? 'Kardex BUY' : 'Archivo de compras'
    ]);
    const purchasesSheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
    purchasesSheet['!autofilter'] = { ref: `A1:V${values.length + 1}` };
    purchasesSheet['!cols'] = headers.map((header, index) => ({
      wch: index === 8 ? 45 : Math.min(Math.max(header.length + 2, 12), 24)
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, information, 'Información');
    XLSX.utils.book_append_sheet(workbook, purchasesSheet, 'Compras');
    XLSX.writeFile(workbook, purchasesReportFilename('xlsx'), { compression: true });
    setStatus(status, 'Historial de compras exportado a Excel correctamente.', 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el historial: ${error.message}`, 'error');
  }
}

function renderPurchaseCostVariations() {
  const data = purchaseCostVariationState;
  const summary = document.getElementById('purchase-cost-variation-summary');
  const container = document.getElementById('purchase-cost-variation-groups');
  const printButton = document.getElementById('print-purchase-cost-variations');
  const exportButton = document.getElementById('export-purchase-cost-variations');
  if (!data) {
    summary.replaceChildren();
    container.replaceChildren();
    printButton.disabled = true;
    exportButton.disabled = true;
    return;
  }
  printButton.disabled = data.summary.itemCount === 0;
  exportButton.disabled = data.summary.itemCount === 0;
  document.getElementById('purchase-cost-variation-period').textContent =
    `${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · ${data.scope.label}. Se incluye toda fluctuación positiva o negativa del costo unitario.`;
  const summaryTexts = [
    `${data.summary.supplierCount} proveedor(es)`,
    `${data.summary.itemCount} insumo(s) con variación`,
    `${data.summary.fluctuationCount} fluctuación(es)`,
    `${data.summary.increaseCount} alza(s)`,
    `${data.summary.decreaseCount} baja(s)`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  const columns = [
    { key: 'code', label: 'Código', value: item => item.code || '—' },
    { key: 'product', label: 'Insumo', value: item => item.product || '—' },
    { key: 'locationName', label: 'Ubicación', value: item => item.locationName },
    { key: 'purchaseUnit', label: 'UDC', value: item => item.purchaseUnit || '—' },
    { key: 'comparisonUnit', label: 'Unid. costo', value: item => item.comparisonUnit || '—' },
    { key: 'firstCost', label: 'Costo inicial', value: item => formatClp(item.firstCost) },
    { key: 'minCost', label: 'Costo mínimo', value: item => formatClp(item.minCost) },
    { key: 'maxCost', label: 'Costo máximo', value: item => formatClp(item.maxCost) },
    { key: 'latestCost', label: 'Último costo', value: item => formatClp(item.latestCost) },
    {
      key: 'netChangePercent', label: 'Variación período', change: true,
      value: item => item.netChangePercent === null ? '—' : `${item.netChangePercent >= 0 ? '+' : ''}${item.netChangePercent.toFixed(1)}%`
    },
    { key: 'fluctuationCount', label: 'Fluc.', value: item => String(item.fluctuationCount) },
    { key: 'increaseCount', label: 'Alzas', value: item => String(item.increaseCount) },
    { key: 'decreaseCount', label: 'Bajas', value: item => String(item.decreaseCount) },
    {
      key: 'maxIncreasePercent', label: 'Mayor alza', positive: true,
      value: item => item.maxIncreasePercent ? `+${item.maxIncreasePercent.toFixed(1)}%` : '—'
    },
    {
      key: 'maxDecreasePercent', label: 'Mayor baja', negative: true,
      value: item => item.maxDecreasePercent ? `${item.maxDecreasePercent.toFixed(1)}%` : '—'
    },
    { key: 'lastChangeDate', label: 'Último cambio', value: item => formatReportDate(item.lastChangeDate) }
  ];
  container.replaceChildren(...data.groups.map(group => {
    const section = document.createElement('section');
    section.className = 'purchase-supplier-group';
    const heading = document.createElement('div');
    heading.className = 'purchase-supplier-heading';
    const title = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = group.supplier;
    const taxId = document.createElement('span');
    taxId.textContent = group.supplierTaxId ? `RUT ${group.supplierTaxId}` : 'RUT no disponible';
    title.append(name, taxId);
    const totals = document.createElement('span');
    totals.textContent = `${group.items.length} insumo(s) · ${group.items.reduce((sum, item) => sum + item.fluctuationCount, 0)} fluctuación(es)`;
    heading.append(title, totals);
    const wrap = document.createElement('div');
    wrap.className = 'purchases-table-wrap';
    const table = document.createElement('table');
    table.className = 'purchases-table purchase-cost-variation-table';
    const headRow = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('th');
      markSortableHeader(cell, column.key, purchaseCostVariationSort, column.label);
      headRow.appendChild(cell);
    });
    const head = document.createElement('thead');
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    sortRows(group.items, purchaseCostVariationSort).forEach(item => {
      const row = document.createElement('tr');
      columns.forEach(column => {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        if (column.change && item.netChangePercent !== null && Math.abs(item.netChangePercent) >= 0.01) {
          cell.className = item.netChangePercent > 0 ? 'purchase-price-increase' : 'purchase-price-decrease';
        } else if (column.positive && item.maxIncreasePercent) cell.className = 'purchase-price-increase';
        else if (column.negative && item.maxDecreasePercent) cell.className = 'purchase-price-decrease';
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    table.append(head, body);
    wrap.appendChild(table);
    section.append(heading, wrap);
    return section;
  }));
  if (!data.groups.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No se encontraron variaciones de costo unitario durante los últimos 30 días.';
    container.appendChild(empty);
  }
}

async function openPurchaseCostVariations() {
  const button = document.getElementById('open-purchase-cost-variations');
  const status = document.getElementById('purchases-status');
  const location = document.getElementById('purchases-location-filter').value || 'all';
  button.disabled = true;
  setStatus(status, 'Preparando las variaciones de costo de los últimos 30 días…');
  try {
    purchaseCostVariationState = await apiRequest(`/api/purchase-cost-variations?location=${encodeURIComponent(location)}`);
    renderPurchaseCostVariations();
    document.getElementById('purchase-cost-variation-dialog').showModal();
    setStatus(status, `Reporte de variaciones generado para ${purchaseCostVariationState.scope.label}.`, 'success');
  } catch (error) {
    purchaseCostVariationState = null;
    renderPurchaseCostVariations();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function printPurchaseCostVariations() {
  if (!purchaseCostVariationState) return;
  const dialog = document.getElementById('purchase-cost-variation-dialog');
  const previousTitle = document.title;
  document.title = `Variaciones de costo - ${purchaseCostVariationState.scope.label}`;
  document.body.classList.add('printing-purchase-cost-variations');
  dialog.classList.add('purchase-cost-variation-print-target');
  try {
    window.print();
  } finally {
    dialog.classList.remove('purchase-cost-variation-print-target');
    document.body.classList.remove('printing-purchase-cost-variations');
    document.title = previousTitle;
  }
}

function exportPurchaseCostVariations() {
  const data = purchaseCostVariationState;
  const status = document.getElementById('purchases-status');
  if (!data || !window.XLSX) return;
  const headers = [
    'Proveedor', 'RUT proveedor', 'Código', 'Insumo', 'Ubicación', 'UDC', 'Unidad costo',
    'Costo inicial', 'Costo mínimo', 'Costo máximo', 'Último costo', 'Variación período %',
    'Fluctuaciones', 'Alzas', 'Bajas', 'Mayor alza %', 'Mayor baja %', 'Último cambio'
  ];
  const values = data.groups.flatMap(group => group.items.map(item => [
    group.supplier, group.supplierTaxId || '', item.code || '', item.product, item.locationName,
    item.purchaseUnit, item.comparisonUnit, item.firstCost, item.minCost, item.maxCost, item.latestCost,
    item.netChangePercent, item.fluctuationCount, item.increaseCount, item.decreaseCount,
    item.maxIncreasePercent, item.maxDecreasePercent, item.lastChangeDate
  ]));
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
  sheet['!autofilter'] = { ref: `A1:R${values.length + 1}` };
  sheet['!cols'] = headers.map((header, index) => ({ wch: index === 3 ? 42 : Math.max(12, Math.min(24, header.length + 2)) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Variaciones de costo');
  XLSX.writeFile(workbook, `variaciones-costo-${data.period.from}-${data.period.to}.xlsx`, { compression: true });
  setStatus(status, 'Reporte de variaciones exportado a Excel correctamente.', 'success');
}

function formatProjectionQuantity(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(Number(value));
}

function formatProjectionMetric(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
}

function filteredPurchaseProjectionItems() {
  if (!purchaseProjectionState) return [];
  const supplier = document.getElementById('projection-supplier-filter').value || 'all';
  const onlyRequired = document.getElementById('projection-only-required').checked;
  const onlyManaged = document.getElementById('projection-only-managed').checked;
  return sortRows(purchaseProjectionState.items.filter(item =>
    (supplier === 'all' || item.supplierKey === supplier)
    && (!onlyRequired || item.needsPurchase)
    && (!onlyManaged || item.managed)), purchaseProjectionSort);
}

function updatePurchaseOrderButton() {
  const supplier = document.getElementById('projection-supplier-filter').value || 'all';
  const eligible = purchaseProjectionState?.items.some(item =>
    item.managed && item.supplierKey === supplier && item.needsPurchase
    && item.suggestedPurchaseUnits > 0 && item.conversionAvailable);
  document.getElementById('print-purchase-order').disabled = supplier === 'all' || supplier === 'unassigned' || !eligible;
}

function renderPurchaseProjection() {
  const body = document.getElementById('purchase-projection-body');
  const summary = document.getElementById('purchase-projection-summary');
  const saveButton = document.getElementById('save-projection-policies');
  if (!purchaseProjectionState) {
    body.replaceChildren();
    summary.replaceChildren();
    saveButton.disabled = true;
    updatePurchaseOrderButton();
    return;
  }
  const data = purchaseProjectionState;
  document.querySelectorAll('.purchase-projection-table thead th[data-sort-key]').forEach(cell => {
    markSortableHeader(cell, cell.dataset.sortKey, purchaseProjectionSort, cell.textContent.replace(/ [▲▼]$/, ''));
  });
  const visibleItems = filteredPurchaseProjectionItems();
  const managedItems = data.items.filter(item => item.managed);
  const managedPurchaseItems = managedItems.filter(item => item.needsPurchase);
  const summaryTexts = [
    `${managedItems.length} ítem(s) administrados`,
    `${data.summary.itemCount} ítem(s) disponibles`,
    `${managedPurchaseItems.length} ítem(s) por comprar`,
    `Compra estimada: ${formatClp(managedItems.reduce((sum, item) => sum + (item.estimatedTotal || 0), 0))}`,
    `${managedPurchaseItems.filter(item => !item.conversionAvailable).length} sin conversión UDC`,
    `${managedPurchaseItems.filter(item => item.estimatedPurchaseUnitCost === null).length} sin costo histórico`,
    `${managedPurchaseItems.filter(item => item.supplierKey === 'unassigned').length} sin proveedor`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  body.replaceChildren(...visibleItems.map(item => {
    const row = document.createElement('tr');
    row.dataset.key = item.key;
    if (item.needsPurchase) row.classList.add('projection-needs-purchase');
    const managedCell = document.createElement('td');
    const managedInput = document.createElement('input');
    managedInput.type = 'checkbox';
    managedInput.className = 'projection-managed-input';
    managedInput.checked = item.managed;
    managedInput.setAttribute('aria-label', `Administrar ${item.name}`);
    managedCell.appendChild(managedInput);
    row.appendChild(managedCell);
    const values = [item.code || '—', item.name || '—'];
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      cell.title = value;
      row.appendChild(cell);
    });
    const supplierCell = document.createElement('td');
    const supplierSelect = document.createElement('select');
    supplierSelect.className = 'projection-supplier-input';
    supplierSelect.setAttribute('aria-label', `Proveedor de ${item.name}`);
    supplierSelect.replaceChildren(...data.suppliers.map(supplier => new Option(supplier.name, supplier.key)));
    supplierSelect.value = data.suppliers.some(supplier => supplier.key === item.supplierKey) ? item.supplierKey : 'unassigned';
    supplierCell.appendChild(supplierSelect);
    if (item.supplierInferred) {
      const note = document.createElement('small');
      note.textContent = `Sugerido por última compra${item.supplierReferenceLocation ? ` en ${item.supplierReferenceLocation}` : ''}`;
      supplierCell.appendChild(note);
    } else if (!item.supplierPurchaseReferenceMatched) {
      const note = document.createElement('small');
      note.textContent = 'Sin compra histórica de este proveedor; confirmar UDC y precio.';
      supplierCell.appendChild(note);
    }
    row.appendChild(supplierCell);
    const plainValues = [
      { value: item.internalUnit || '—' },
      { value: formatProjectionMetric(item.currentInventory) },
      { value: formatProjectionMetric(item.consumption30) },
      { value: formatProjectionMetric(item.averageDailyConsumption) },
      {
        value: item.currentCoverageDays === null ? 'Sin consumo' : `${formatProjectionMetric(item.currentCoverageDays)} días`,
        lowCoverage: item.currentCoverageDays !== null && item.currentCoverageDays < item.minDays
      }
    ];
    plainValues.forEach(entry => {
      const cell = document.createElement('td');
      cell.textContent = entry.value;
      if (entry.lowCoverage) cell.classList.add('projection-coverage-low');
      row.appendChild(cell);
    });
    for (const [field, value] of [['minDays', item.minDays], ['maxDays', item.maxDays]]) {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '365';
      input.step = '1';
      input.value = String(value);
      input.className = `projection-${field === 'minDays' ? 'min' : 'max'}-input`;
      input.setAttribute('aria-label', `${field === 'minDays' ? 'Días mínimos' : 'Días máximos'} de ${item.name}`);
      cell.appendChild(input);
      row.appendChild(cell);
    }
    const resultValues = [
      item.needsPurchase ? `${formatProjectionQuantity(item.suggestedInternalQuantity)} ${item.internalUnit}` : 'No comprar',
      item.purchaseUnit || '—',
      item.conversionAvailable ? formatProjectionQuantity(item.unitsPerPurchaseUnit) : 'Sin conversión',
      item.suggestedPurchaseUnits === null ? '—' : formatProjectionQuantity(item.suggestedPurchaseUnits),
      item.estimatedPurchaseUnitCost === null ? '—' : formatClp(item.estimatedPurchaseUnitCost),
      item.estimatedTotal === null ? '—' : formatClp(item.estimatedTotal)
    ];
    resultValues.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    return row;
  }));
  if (!visibleItems.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 17;
    cell.className = 'projection-empty';
    cell.textContent = 'No hay ítems para los filtros seleccionados.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  saveButton.disabled = data.items.length === 0;
  updatePurchaseOrderButton();
}

async function loadPurchaseProjection() {
  const status = document.getElementById('purchase-projection-status');
  const button = document.getElementById('refresh-purchase-projection');
  const location = document.getElementById('projection-location-filter').value;
  if (!location) return;
  button.disabled = true;
  setStatus(status, 'Calculando inventario, consumos y necesidades de compra…');
  try {
    const data = await apiRequest(`/api/purchase-projections?location=${encodeURIComponent(location)}`);
    if (location !== document.getElementById('projection-location-filter').value) return;
    purchaseProjectionState = data;
    const supplierSelect = document.getElementById('projection-supplier-filter');
    const previousSupplier = supplierSelect.value || 'all';
    supplierSelect.replaceChildren(
      new Option('Todos los proveedores', 'all'),
      ...data.suppliers.map(supplier => new Option(supplier.name, supplier.key))
    );
    supplierSelect.value = data.suppliers.some(supplier => supplier.key === previousSupplier) ? previousSupplier : 'all';
    renderPurchaseProjection();
    const stale = data.period.dataThrough < data.period.to
      ? ` El último inventario disponible corresponde al ${formatReportDate(data.period.dataThrough)}.`
      : '';
    setStatus(status,
      `Consumo considerado: ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)}. ${data.consumptionCriteria}.${stale}`,
      stale ? 'muted' : 'success');
  } catch (error) {
    purchaseProjectionState = null;
    renderPurchaseProjection();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function savePurchaseProjectionPolicies() {
  if (!purchaseProjectionState) return;
  const status = document.getElementById('purchase-projection-status');
  const button = document.getElementById('save-projection-policies');
  const rows = new Map([...document.querySelectorAll('#purchase-projection-body tr[data-key]')]
    .map(row => [row.dataset.key, row]));
  for (const item of purchaseProjectionState.items) {
    const row = rows.get(item.key);
    if (!row) continue;
    item.minDays = Number(row.querySelector('.projection-min-input').value);
    item.maxDays = Number(row.querySelector('.projection-max-input').value);
    item.supplierKey = row.querySelector('.projection-supplier-input').value;
    item.managed = row.querySelector('.projection-managed-input').checked;
  }
  const invalid = purchaseProjectionState.items.find(item =>
    !Number.isFinite(item.minDays) || !Number.isFinite(item.maxDays)
    || item.minDays < 0 || item.maxDays < item.minDays || item.maxDays > 365);
  if (invalid) return setStatus(status, `Revisa los días mínimos y máximos de ${invalid.name}.`, 'error');
  button.disabled = true;
  try {
    await apiRequest('/api/purchase-projections/policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: purchaseProjectionState.location.id,
        items: purchaseProjectionState.items.map(item => ({
          key: item.key, minDays: item.minDays, maxDays: item.maxDays,
          supplierKey: item.supplierKey, managed: item.managed
        }))
      })
    });
    setStatus(status, 'Criterios de inventario y proveedores guardados correctamente.', 'success');
    await loadPurchaseProjection();
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function printPurchaseOrder() {
  const data = purchaseProjectionState;
  const supplierKey = document.getElementById('projection-supplier-filter').value;
  if (!data || ['all', 'unassigned'].includes(supplierKey)) return;
  const supplier = data.suppliers.find(item => item.key === supplierKey);
  const items = data.items.filter(item => item.managed && item.supplierKey === supplierKey
    && item.needsPurchase && item.suggestedPurchaseUnits > 0 && item.conversionAvailable);
  if (!supplier || !items.length) return;
  const documentSection = document.getElementById('purchase-order-document');
  const heading = document.createElement('div');
  heading.className = 'purchase-order-heading';
  const headingMain = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'panel-eyebrow';
  eyebrow.textContent = 'Orden de compra sugerida';
  const supplierName = document.createElement('h2');
  supplierName.textContent = supplier.name;
  const supplierDetail = document.createElement('p');
  supplierDetail.textContent = `${supplier.taxId ? `RUT ${supplier.taxId} · ` : ''}${data.location.name}`;
  headingMain.append(eyebrow, supplierName, supplierDetail);
  const headingMeta = document.createElement('div');
  const orderDate = document.createElement('strong');
  orderDate.textContent = isoLocalDate(new Date());
  headingMeta.append(orderDate, document.createElement('br'), document.createTextNode('Basada en proyección de 30 días'));
  heading.append(headingMain, headingMeta);
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Código</th><th>Producto / ingrediente</th><th>Cantidad UDC</th><th>UDC</th><th>Equivalencia interna</th><th>Costo UDC estimado</th><th>Total estimado</th></tr></thead>';
  const body = document.createElement('tbody');
  items.forEach(item => {
    const row = document.createElement('tr');
    [
      item.code || '', item.name, formatProjectionQuantity(item.suggestedPurchaseUnits), item.purchaseUnit,
      `${formatProjectionQuantity(item.projectedInternalQuantity)} ${item.internalUnit}`,
      item.estimatedPurchaseUnitCost === null ? '—' : formatClp(item.estimatedPurchaseUnitCost),
      item.estimatedTotal === null ? '—' : formatClp(item.estimatedTotal)
    ].forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  const footer = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.innerHTML = `<td colspan="6">TOTAL ESTIMADO</td><td>${formatClp(items.reduce((sum, item) => sum + (item.estimatedTotal || 0), 0))}</td>`;
  footer.appendChild(totalRow);
  table.append(body, footer);
  const note = document.createElement('p');
  note.className = 'purchase-order-note';
  note.textContent = 'Documento sugerido. Verificar disponibilidad, precios, impuestos y condiciones comerciales antes de enviarlo al proveedor.';
  documentSection.replaceChildren(heading, table, note);
  documentSection.hidden = false;
  const previousTitle = document.title;
  document.title = `Orden de compra - ${supplier.name}`;
  document.body.classList.add('printing-purchase-order');
  try {
    window.print();
  } finally {
    document.body.classList.remove('printing-purchase-order');
    documentSection.hidden = true;
    document.title = previousTitle;
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
    closeInventoryResultDialogs();
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
  closeInventoryResultDialogs();
}

function closeInventoryResultDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
}

function closeInventoryResultDialogs() {
  ['waste-summary-results', 'consumption-summary-results', 'inventory-report-results']
    .forEach(closeInventoryResultDialog);
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
  const dialog = document.getElementById('waste-summary-results');
  dialog.showModal();
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
      dialog.close();
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
      dialog.close();
      document.getElementById('consumption-summary-results').showModal();
      setStatus(pageStatus, `Resumen de ${titles[field].toLowerCase()} generado correctamente.`, 'success');
    }
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

function normalizedInventorySearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function renderInventoryKardexTable() {
  if (!inventoryKardexTableState) return;
  const { report, columns } = inventoryKardexTableState;
  const table = document.getElementById('inventory-results-table');
  const previousScrollLeft = table.parentElement.scrollLeft;
  const search = normalizedInventorySearch(document.getElementById('inventory-kardex-search').value);
  const costCriterion = document.getElementById('inventory-kardex-cost-filter').value;
  const minimumInput = document.getElementById('inventory-kardex-cost-min').value;
  const maximumInput = document.getElementById('inventory-kardex-cost-max').value;
  const minimum = minimumInput === '' ? null : Number(minimumInput);
  const maximum = maximumInput === '' ? null : Number(maximumInput);
  const epsilon = 0.000001;
  const items = report.items.filter(item => {
    const matchesSearch = !search || normalizedInventorySearch(`${item.code} ${item.name}`).includes(search);
    if (!matchesSearch) return false;
    const cost = Number(item.totalCost) || 0;
    if (costCriterion === 'positive' && cost <= epsilon) return false;
    if (costCriterion === 'negative' && cost >= -epsilon) return false;
    if (costCriterion === 'zero' && Math.abs(cost) > epsilon) return false;
    if (costCriterion === 'nonzero' && Math.abs(cost) <= epsilon) return false;
    if (minimum !== null && cost < minimum) return false;
    if (maximum !== null && cost > maximum) return false;
    return true;
  });
  const sortColumn = columns[inventoryKardexTableState.sortIndex];
  const direction = inventoryKardexTableState.direction === 'desc' ? -1 : 1;
  items.sort((left, right) => {
    const leftValue = sortColumn.sortValue(left);
    const rightValue = sortColumn.sortValue(right);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return String(left.code).localeCompare(String(right.code), 'es', { numeric: true });
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), 'es', { numeric: true, sensitivity: 'base' });
    return (comparison || String(left.code).localeCompare(String(right.code), 'es', { numeric: true })) * direction;
  });

  const header = document.createElement('tr');
  columns.forEach((column, index) => {
    const cell = document.createElement('th');
    const active = index === inventoryKardexTableState.sortIndex;
    cell.setAttribute('aria-sort', active
      ? inventoryKardexTableState.direction === 'asc' ? 'ascending' : 'descending'
      : 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inventory-sort-button${active ? ' active' : ''}`;
    button.textContent = `${column.label}${active ? inventoryKardexTableState.direction === 'asc' ? ' ▲' : ' ▼' : ''}`;
    button.addEventListener('click', () => {
      if (inventoryKardexTableState.sortIndex === index) {
        inventoryKardexTableState.direction = inventoryKardexTableState.direction === 'asc' ? 'desc' : 'asc';
      } else {
        inventoryKardexTableState.sortIndex = index;
        inventoryKardexTableState.direction = 'asc';
      }
      renderInventoryKardexTable();
    });
    cell.appendChild(button);
    header.appendChild(cell);
  });
  const head = document.createElement('thead');
  head.appendChild(header);
  const body = document.createElement('tbody');
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = 'No hay filas que coincidan con los filtros seleccionados.';
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    for (const item of items) {
      const row = document.createElement('tr');
      for (const [columnIndex, column] of columns.entries()) {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        if (columnIndex < 4) cell.title = cell.textContent;
        if (column.signValue) {
          const value = Number(column.signValue(item)) || 0;
          if (value < 0) cell.className = 'difference-negative';
          else if (value > 0) cell.className = column.finalDifference ? 'difference-final-positive' : 'difference-positive';
        }
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
  }
  const foot = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.className = 'consumption-total-row';
  columns.forEach((column, index) => {
    const cell = document.createElement('td');
    if (index === 0) cell.textContent = 'TOTAL';
    else if (index === columns.length - 1) {
      cell.textContent = formatKardexCost(items.reduce((sum, item) => sum + (Number(item.totalCost) || 0), 0));
    }
    totalRow.appendChild(cell);
  });
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);
  table.parentElement.scrollLeft = previousScrollLeft;
  document.getElementById('inventory-kardex-visible-count').textContent = `${items.length} de ${report.items.length} filas`;
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
  const columns = [
    { label: 'Código', value: item => item.code, sortValue: item => item.code },
    { label: 'Producto', value: item => item.name, sortValue: item => item.name },
    { label: 'Unidad', value: item => item.unit, sortValue: item => item.unit },
    {
      label: 'Costo unitario',
      value: item => item.costAvailable ? formatKardexCost(item.unitCost) : 'Sin costo',
      sortValue: item => item.costAvailable ? Number(item.unitCost) || 0 : null
    },
    {
      label: report.selection
        ? `${basisLabel(report.selection.initialBasis)} ${formatReportDate(report.selection.initialDate)}`
        : 'Inventario inicial',
      value: item => formatKardexQuantity(item.initialInventory),
      sortValue: item => Number(item.initialInventory) || 0
    },
    ...report.movementDefinitions.map(definition => ({
      label: definition.label,
      value: item => formatKardexQuantity(item.movements[definition.key]),
      sortValue: item => Number(item.movements[definition.key]) || 0
    })),
    { label: 'Consumo Colaboradores', value: item => formatKardexQuantity(item.employeeConsumption), sortValue: item => Number(item.employeeConsumption) || 0 },
    { label: 'Consumo Marketing', value: item => formatKardexQuantity(item.marketingConsumption), sortValue: item => Number(item.marketingConsumption) || 0 },
    ...(report.selection ? [
      {
        label: 'Inventario Final Teórico',
        value: item => formatKardexQuantity(item.theoreticalFinal),
        sortValue: item => Number(item.theoreticalFinal) || 0
      },
      {
        label: `${basisLabel(report.selection.finalBasis)} ${formatReportDate(report.selection.finalDate)}`,
        value: item => formatKardexQuantity(item.finalInventory),
        sortValue: item => Number(item.finalInventory) || 0
      }
    ] : [
      { label: 'Inventario final teórico', value: item => formatKardexQuantity(item.theoreticalFinal), sortValue: item => Number(item.theoreticalFinal) || 0 },
      { label: `Inventario físico ${formatReportDate(report.physicalInventoryDate)}`, value: item => formatKardexQuantity(item.physicalFinal), sortValue: item => Number(item.physicalFinal) || 0 }
    ]),
    {
      label: report.selection ? 'Diferencia de Inventario' : 'Diferencia físico − teórico',
      value: item => formatKardexQuantity(item.difference),
      sortValue: item => Number(item.difference) || 0,
      signValue: item => item.difference,
      finalDifference: true
    },
    { label: 'Costo Total', value: item => item.costAvailable ? formatKardexCost(item.totalCost) : 'Sin costo', sortValue: item => item.costAvailable ? Number(item.totalCost) || 0 : null }
  ];
  document.getElementById('inventory-kardex-search').value = '';
  document.getElementById('inventory-kardex-cost-filter').value = 'all';
  document.getElementById('inventory-kardex-cost-min').value = '';
  document.getElementById('inventory-kardex-cost-max').value = '';
  inventoryKardexTableState = { report, columns, sortIndex: 0, direction: 'asc' };
  renderInventoryKardexTable();
  document.getElementById('inventory-report-results').showModal();
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
    refreshSalesDashboardLocationFilter();
    refreshSalesIngredientsLocationFilter();
    refreshProductsLocationFilter();
    refreshIngredientsLocationFilter();
    refreshPurchasesLocationFilter();
    refreshProjectionLocationFilter();
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
    if (file.structure?.ok) {
      const structure = document.createElement('span');
      structure.className = file.structure.permissive ? 'detection-warning' : 'structure-validation-ok';
      structure.textContent = file.structure.permissive
        ? file.structure.reason
        : 'Estructura verificada para la categoría seleccionada.';
      row.appendChild(structure);
    }
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
  setStatus(document.getElementById('transaction-confirmation-status'), '');
  confirmation.showModal();
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

function inventoryReportTitle(section) {
  return section.querySelector('.inventory-results-head h3')?.textContent?.trim() || 'Informe de inventario';
}

function inventoryReportFilename(title, extension) {
  const slug = title.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'informe-inventario'}-${isoLocalDate(new Date())}.${extension}`;
}

function printInventoryReport(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section || section.hidden) return;
  const previousTitle = document.title;
  const reopenDialog = section instanceof HTMLDialogElement && section.open;
  if (reopenDialog) section.close();
  document.title = inventoryReportTitle(section);
  document.body.classList.add('printing-inventory-report');
  section.classList.add('inventory-print-target');
  try {
    window.print();
  } finally {
    section.classList.remove('inventory-print-target');
    document.body.classList.remove('printing-inventory-report');
    document.title = previousTitle;
    if (reopenDialog) section.showModal();
  }
}

function excelSheetLabel(table, index) {
  if (table.id === 'inventory-results-table') return 'Kardex consolidado';
  if (table.id === 'inventory-waste-table' || table.id === 'waste-summary-table') return 'Merma';
  const card = table.closest('.consumption-report-card');
  const reportName = card?.querySelector('h4')?.textContent?.trim() || `Reporte ${index + 1}`;
  const part = table.closest('.consumption-report-part')?.querySelector('h5')?.textContent || '';
  const detail = /^1\./.test(part) ? 'Productos' : /^2\./.test(part) ? 'Ingredientes' : '';
  return `${reportName} ${detail}`.trim();
}

function uniqueExcelSheetName(label, usedNames) {
  const clean = label.replace(/[\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim() || 'Reporte';
  let name = clean.slice(0, 31);
  let suffix = 2;
  while (usedNames.has(name)) {
    const marker = ` ${suffix++}`;
    name = `${clean.slice(0, 31 - marker.length)}${marker}`;
  }
  usedNames.add(name);
  return name;
}

function exportInventoryReport(sectionId) {
  const section = document.getElementById(sectionId);
  const status = document.getElementById('inventory-source-status');
  if (!section || section.hidden) return;
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const title = inventoryReportTitle(section);
    const workbook = XLSX.utils.book_new();
    const locationSelect = document.getElementById('inventory-location-select');
    const location = locationSelect.selectedOptions[0]?.textContent || '';
    const period = section.querySelector('.inventory-results-head .panel-description')?.textContent?.trim() || '';
    const information = XLSX.utils.aoa_to_sheet([
      ['Reporte', title],
      ['Ubicación', location],
      ['Período / criterios', period],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    XLSX.utils.book_append_sheet(workbook, information, 'Información');
    const usedNames = new Set(['Información']);
    const tables = [...section.querySelectorAll('table')].filter(table => !table.closest('[hidden]'));
    tables.forEach((table, index) => {
      const sheet = XLSX.utils.table_to_sheet(table, { raw: true });
      XLSX.utils.book_append_sheet(workbook, sheet, uniqueExcelSheetName(excelSheetLabel(table, index), usedNames));
    });
    XLSX.writeFile(workbook, inventoryReportFilename(title, 'xlsx'), { compression: true });
    setStatus(status, 'Reporte exportado a Excel correctamente.', 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el reporte: ${error.message}`, 'error');
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
  document.body.appendChild(document.getElementById('date-confirmation'));
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
      setView(link.dataset.view || 'report');
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
  setView(document.querySelector('.nav-link.active')?.dataset.view || 'report');

  document.getElementById('location-select').addEventListener('change', updateLocationFields);
  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      transactionUploadContext = { source: 'uploads', statusId: 'week-status', location: document.getElementById('location-select').value };
      inspectSelectedTransactionFile(input);
    });
  });
  document.getElementById('report-sales-upload-input').addEventListener('change', event => {
    inspectSelectedTransactionFile(event.currentTarget, transactionUploadContext?.location);
  });
  document.getElementById('report-upload-sales').addEventListener('click', startReportSalesUpload);
  document.getElementById('confirm-report-sales-location').addEventListener('click', () => {
    const location = document.getElementById('report-sales-upload-location').value;
    closeReportSalesLocationDialog();
    openReportSalesFilePicker(location);
  });
  for (const id of ['close-report-sales-location', 'cancel-report-sales-location']) {
    document.getElementById(id).addEventListener('click', closeReportSalesLocationDialog);
  }

  document.getElementById('weekly-upload-form').addEventListener('submit', event => event.preventDefault());

  document.getElementById('transaction-delete-confirmation').addEventListener('input', event => {
    document.getElementById('confirm-transaction-delete').disabled = event.target.value.trim() !== 'ELIMINAR';
  });
  document.getElementById('confirm-transaction-delete').addEventListener('click', async event => {
    if (!pendingTransactionDelete) return;
    const button = event.currentTarget;
    const action = document.querySelector('input[name="transaction-delete-action"]:checked')?.value;
    const { location, field } = pendingTransactionDelete;
    button.disabled = true;
    setStatus(document.getElementById('transaction-delete-status'), action === 'all'
      ? 'Eliminando toda la información de esta categoría…'
      : 'Revirtiendo la última carga…');
    try {
      const result = await apiRequest(`/api/transactions/${encodeURIComponent(location)}/${encodeURIComponent(field)}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirmed: true, confirmationText: 'ELIMINAR' })
      });
      closeTransactionDeleteDialog();
      await loadTransactionFiles();
      setStatus(document.getElementById('week-status'), action === 'all'
        ? `Se eliminó toda la información de ${FIELD_LABELS[field] || field}.`
        : `Se revirtió la última carga de ${FIELD_LABELS[field] || field}. Quedan ${result.remainingCount} carga(s).`, 'success');
    } catch (error) {
      setStatus(document.getElementById('transaction-delete-status'), error.message, 'error');
      button.disabled = false;
    }
  });
  document.getElementById('close-transaction-delete').addEventListener('click', closeTransactionDeleteDialog);
  document.getElementById('cancel-transaction-delete').addEventListener('click', closeTransactionDeleteDialog);
  document.getElementById('transaction-delete-dialog').addEventListener('close', () => { pendingTransactionDelete = null; });
  document.getElementById('close-transaction-confirmation').addEventListener('click', cancelTransactionConfirmation);
  document.getElementById('cancel-transaction-confirmation').addEventListener('click', cancelTransactionConfirmation);
  document.getElementById('date-confirmation').addEventListener('cancel', event => {
    event.preventDefault();
    cancelTransactionConfirmation();
  });

  async function confirmTransactionUpload(overlapAction) {
    const button = overlapAction === 'replace'
      ? document.getElementById('replace-transactions-btn')
      : document.getElementById('keep-transactions-btn');
    const status = document.getElementById('transaction-confirmation-status');
    const uploadContext = transactionUploadContext;
    const pageStatus = transactionUploadStatus();
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
      if (uploadContext?.refreshReport) await loadWeeklySalesReport();
      const importMessages = [];
      if (result.imports?.sales) {
        const imported = result.imports.sales;
        importMessages.push(imported.newTransactions
          ? `${imported.newTransactions} transacción(es) nueva(s) guardada(s); ${imported.duplicateTransactions} ya existente(s) omitida(s).`
          : `Ventas procesadas sin duplicar datos: no había transacciones nuevas y ${imported.duplicateTransactions} ya existía(n).`);
      }
      if (result.imports?.mercadopago) {
        const imported = result.imports.mercadopago;
        importMessages.push(imported.newTransactions
          ? `${imported.newTransactions} transacción(es) MercadoPago nueva(s) guardada(s); ${imported.duplicateTransactions} fila(s) repetida(s) omitida(s).`
          : `MercadoPago procesado sin duplicar datos: no había transacciones nuevas y ${imported.duplicateTransactions} fila(s) ya existía(n).`);
      }
      if (importMessages.length) {
        setStatus(pageStatus, importMessages.join(' '), 'success');
      } else {
        setStatus(pageStatus, overlapAction === 'replace'
          ? `Se reemplazaron los días coincidentes y se conservaron los datos fuera del rango para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`
          : `Se agregaron los registros nuevos sin duplicar los ya existentes para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`, 'success');
      }
      transactionUploadContext = null;
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
  document.getElementById('report-include-today').addEventListener('change', loadWeeklySalesReport);
  document.getElementById('refresh-sales-dashboard').addEventListener('click', loadSalesDashboard);
  document.getElementById('sales-dashboard-location').addEventListener('change', loadSalesDashboard);
  document.getElementById('refresh-sales-ingredients').addEventListener('click', loadSalesIngredientsView);
  document.getElementById('sales-ingredients-location').addEventListener('change', loadSalesIngredientsView);
  document.getElementById('run-sales-ingredients').addEventListener('click', loadSalesIngredientsView);
  document.getElementById('clear-sales-ingredients').addEventListener('click', () => {
    selectedSalesAnalysis.clear();
    collapsedSalesAnalysisGroups.clear();
    renderSalesAnalysisPickers();
    loadSalesIngredientsView();
  });
  document.getElementById('sales-ingredient-hierarchy').addEventListener('change', renderSalesAnalysisPickers);
  document.getElementById('sales-ingredient-search').addEventListener('input', renderSalesAnalysisPickers);
  document.getElementById('sales-extra-search').addEventListener('input', renderSalesAnalysisPickers);
  for (const containerId of ['sales-ingredient-options', 'sales-extra-options']) {
    document.getElementById(containerId).addEventListener('change', event => {
      const checkbox = event.target.closest('input[data-selection-key]');
      if (!checkbox) return;
      if (checkbox.checked) selectedSalesAnalysis.add(checkbox.dataset.selectionKey);
      else selectedSalesAnalysis.delete(checkbox.dataset.selectionKey);
      updateSalesAnalysisSelectionCount();
    });
  }
  document.getElementById('sales-ingredients-report').addEventListener('click', event => {
    const button = event.target.closest('.sales-ingredient-collapse');
    if (!button) return;
    const key = button.dataset.groupKey;
    if (collapsedSalesAnalysisGroups.has(key)) collapsedSalesAnalysisGroups.delete(key);
    else collapsedSalesAnalysisGroups.add(key);
    renderSalesIngredientsReport();
  });
  document.getElementById('sales-insight-period').addEventListener('change', () => {
    salesHierarchyPath = [];
    renderSalesInsights();
  });
  document.getElementById('sales-hierarchy-back').addEventListener('click', () => {
    salesHierarchyPath = salesHierarchyPath.slice(0, -1);
    renderSalesInsights();
  });
  document.getElementById('products-location-filter').addEventListener('change', () => {
    document.getElementById('products-comparison').hidden = true;
    loadProductsView();
  });
  document.getElementById('products-search').addEventListener('input', renderProductsView);
  document.getElementById('refresh-products').addEventListener('click', loadProductsView);
  document.getElementById('products-hierarchy-list').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(productsSort, header.dataset.sortKey, ['price', 'netPrice', 'cost', 'marginPercent', 'averageWeeklyUnits8', 'unitsLast7Days', 'unitsChangePercent'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderProductsView();
  });
  document.getElementById('ingredients-location-filter').addEventListener('change', () => {
    document.getElementById('ingredients-supplier-filter').value = 'all';
    loadIngredientsView();
  });
  document.getElementById('ingredients-date-from').addEventListener('change', loadIngredientsView);
  document.getElementById('ingredients-date-to').addEventListener('change', loadIngredientsView);
  document.getElementById('ingredients-supplier-filter').addEventListener('change', renderIngredientsView);
  document.getElementById('ingredients-search').addEventListener('input', renderIngredientsView);
  document.getElementById('ingredients-only-changed').addEventListener('change', renderIngredientsView);
  document.getElementById('refresh-ingredients').addEventListener('click', loadIngredientsView);
  document.querySelector('.ingredients-table thead').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(ingredientsSort, header.dataset.sortKey, ['unitCost', 'latestPurchaseCost', 'costChangePercent', 'usageQuantity', 'usageCost', 'products.length'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderIngredientsView();
  });
  document.getElementById('ingredients-table-body').addEventListener('click', event => {
    const button = event.target.closest('.ingredient-detail-button');
    if (!button) return;
    if (expandedIngredients.has(button.dataset.ingredientCode)) expandedIngredients.delete(button.dataset.ingredientCode);
    else expandedIngredients.add(button.dataset.ingredientCode);
    renderIngredientsView();
  });
  document.getElementById('purchases-location-filter').addEventListener('change', () => {
    document.getElementById('purchase-cost-variation-dialog').close();
    purchaseCostVariationState = null;
    document.getElementById('purchases-supplier-filter').value = 'all';
    document.getElementById('purchases-product-filter').value = '';
    document.getElementById('purchases-date-from').value = '';
    document.getElementById('purchases-date-to').value = '';
    loadPurchasesView();
  });
  document.getElementById('purchases-supplier-filter').addEventListener('change', loadPurchasesView);
  document.getElementById('purchases-product-filter').addEventListener('change', loadPurchasesView);
  document.getElementById('purchases-date-from').addEventListener('change', loadPurchasesView);
  document.getElementById('purchases-date-to').addEventListener('change', loadPurchasesView);
  document.getElementById('refresh-purchases').addEventListener('click', loadPurchasesView);
  document.getElementById('purchases-groups').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchasesSort, header.dataset.sortKey,
      ['quantity', 'unitsPerPurchaseUnit', 'listedUnitPrice', 'baseUnitCost', 'discount', 'effectiveUnitPrice', 'previousEffectiveUnitPrice', 'priceChangePercent', 'totalAmount'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderPurchasesView();
  });
  document.getElementById('open-purchase-cost-variations').addEventListener('click', openPurchaseCostVariations);
  document.getElementById('print-purchases-report').addEventListener('click', printPurchasesReport);
  document.getElementById('export-purchases-report').addEventListener('click', exportPurchasesReport);
  document.getElementById('close-purchase-cost-variations').addEventListener('click', () => {
    document.getElementById('purchase-cost-variation-dialog').close();
  });
  document.getElementById('print-purchase-cost-variations').addEventListener('click', printPurchaseCostVariations);
  document.getElementById('export-purchase-cost-variations').addEventListener('click', exportPurchaseCostVariations);
  document.getElementById('purchase-cost-variation-groups').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchaseCostVariationSort, header.dataset.sortKey,
      ['firstCost', 'minCost', 'maxCost', 'latestCost', 'netChangePercent', 'fluctuationCount', 'increaseCount', 'decreaseCount', 'maxIncreasePercent', 'maxDecreasePercent'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderPurchaseCostVariations();
  });
  document.getElementById('projection-location-filter').addEventListener('change', () => {
    document.getElementById('projection-supplier-filter').value = 'all';
    loadPurchaseProjection();
  });
  document.getElementById('projection-supplier-filter').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-required').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-managed').addEventListener('change', renderPurchaseProjection);
  document.getElementById('refresh-purchase-projection').addEventListener('click', loadPurchaseProjection);
  document.querySelector('.purchase-projection-table thead').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchaseProjectionSort, header.dataset.sortKey,
      ['managed', 'currentInventory', 'consumption30', 'averageDailyConsumption', 'currentCoverageDays', 'minDays', 'maxDays', 'suggestedInternalQuantity', 'unitsPerPurchaseUnit', 'suggestedPurchaseUnits', 'estimatedPurchaseUnitCost', 'estimatedTotal'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderPurchaseProjection();
  });
  document.getElementById('save-projection-policies').addEventListener('click', savePurchaseProjectionPolicies);
  document.getElementById('print-purchase-order').addEventListener('click', printPurchaseOrder);
  document.getElementById('purchase-projection-body').addEventListener('input', event => {
    const row = event.target.closest('tr[data-key]');
    const item = purchaseProjectionState?.items.find(candidate => candidate.key === row?.dataset.key);
    if (!item) return;
    if (event.target.matches('.projection-min-input')) item.minDays = Number(event.target.value);
    if (event.target.matches('.projection-max-input')) item.maxDays = Number(event.target.value);
    if (event.target.matches('.projection-managed-input')) {
      item.managed = event.target.checked;
      renderPurchaseProjection();
    }
  });
  document.getElementById('purchase-projection-body').addEventListener('change', event => {
    if (!event.target.matches('.projection-supplier-input')) return;
    const row = event.target.closest('tr[data-key]');
    const item = purchaseProjectionState?.items.find(candidate => candidate.key === row?.dataset.key);
    if (item) item.supplierKey = event.target.value;
  });
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
    closeInventoryResultDialog('waste-summary-results');
  });
  document.getElementById('close-consumption-summary').addEventListener('click', () => {
    closeInventoryResultDialog('consumption-summary-results');
  });
  document.getElementById('close-inventory-report').addEventListener('click', () => {
    closeInventoryResultDialog('inventory-report-results');
  });
  for (const id of ['inventory-kardex-search', 'inventory-kardex-cost-min', 'inventory-kardex-cost-max']) {
    document.getElementById(id).addEventListener('input', renderInventoryKardexTable);
  }
  document.getElementById('inventory-kardex-cost-filter').addEventListener('change', renderInventoryKardexTable);
  document.getElementById('clear-inventory-kardex-filters').addEventListener('click', () => {
    document.getElementById('inventory-kardex-search').value = '';
    document.getElementById('inventory-kardex-cost-filter').value = 'all';
    document.getElementById('inventory-kardex-cost-min').value = '';
    document.getElementById('inventory-kardex-cost-max').value = '';
    renderInventoryKardexTable();
  });
  document.querySelectorAll('.inventory-print-report').forEach(button => {
    button.addEventListener('click', () => printInventoryReport(button.dataset.reportTarget));
  });
  document.querySelectorAll('.inventory-export-report').forEach(button => {
    button.addEventListener('click', () => exportInventoryReport(button.dataset.reportTarget));
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
