let locationRegistry = {};
let exportDecimalSystem = 'comma';
const FIELD_LABELS = {
  kardex: 'Kardex / inventario',
  waste: 'Merma',
  marketing: 'Consumo de marketing',
  employees: 'Consumo de colaboradores',
  purchases: 'Compras',
  sales: 'Ventas',
  'payment-details': 'Detalle Pagos',
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
let productAnalysisState = null;
let productAnalysisOptions = null;
let ingredientsViewState = null;
let purchasesViewState = null;
let purchaseCostVariationState = null;
let purchaseProjectionState = null;
let purchaseOrderEditorState = null;
let tentativePurchaseOrdersState = null;
let salesDashboardState = null;
let hourlySalesDemandState = null;
let hourlyAnalysisState = null;
let findingsViewState = null;
let salesIngredientsState = null;
let salesHierarchyPath = [];
let hourlySalesHierarchyPath = [];
let hourlySalesProductKey = null;
let hourlyDemandChartMetric = 'units';
let pendingInventorySummaryField = null;
let pendingInventoryPreview = null;
let pendingTransactionDelete = null;
let inventoryKardexTableState = null;
let currentInventoryTableState = null;
let transactionUploadContext = null;
const expandedUploadHistories = new Set();
let productsSort = { key: 'unitsLast7Days', direction: 'desc' };
let ingredientsSort = { key: 'usageCost', direction: 'desc' };
const ingredientProductSorts = new Map();
let purchasesSort = { key: 'date', direction: 'desc' };
let purchaseCostVariationSort = { key: 'product', direction: 'asc' };
let purchaseProjectionSort = { key: 'supplier', direction: 'asc' };
const expandedIngredients = new Set();
const selectedSalesAnalysis = new Set();
const collapsedSalesAnalysisGroups = new Set();
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'brewit.sidebarCollapsed';
let sidebarCollapsedPreference = false;

function applySidebarPreference() {
  const collapsed = sidebarCollapsedPreference && window.matchMedia('(min-width: 901px)').matches;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = document.getElementById('sidebar-toggle');
  if (!button) return;
  const label = collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', label);
  button.title = label;
}

function initializeSidebarToggle() {
  try {
    sidebarCollapsedPreference = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    sidebarCollapsedPreference = false;
  }
  applySidebarPreference();
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    sidebarCollapsedPreference = !document.body.classList.contains('sidebar-collapsed');
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsedPreference));
    } catch {}
    applySidebarPreference();
  });
  window.matchMedia('(min-width: 901px)').addEventListener('change', applySidebarPreference);
}

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
  if (view === 'findings') {
    const findings = document.getElementById('findings-workspace');
    findings.hidden = false;
    findings.style.display = '';
    loadFindingsView();
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

function configuredExcelNumberFormat({ currency = false, percent = false, integer = false, decimalPlaces = null } = {}) {
  const decimal = exportDecimalSystem === 'dot' ? '.' : ',';
  const thousands = exportDecimalSystem === 'dot' ? ',' : '.';
  const decimals = integer
    ? ''
    : `${decimal}${Number.isInteger(decimalPlaces) ? '0'.repeat(Math.max(1, decimalPlaces)) : '########'}`;
  const prefix = currency ? '$ ' : '';
  const suffix = percent ? '%' : '';
  return `${prefix}#${thousands}##0${percent ? `${decimal}00` : decimals}${suffix}`;
}

function localizedExportNumber(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /^[-—–]$/.test(text) || /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(text)) return null;
  const currency = text.includes('$');
  const percent = text.endsWith('%');
  let compact = text.replace(/\s+/g, '').replace(/\$/g, '').replace(/%$/, '');
  if (!/^[+-]?[\d.,]+$/.test(compact)) return null;

  const hasComma = compact.includes(',');
  const hasDot = compact.includes('.');
  if (!currency && !percent && !hasComma && !hasDot) return null;
  let decimalPlaces = 0;
  if (hasComma) {
    decimalPlaces = compact.split(',').at(-1).length;
    compact = compact.replace(/\./g, '').replace(',', '.');
  } else if (hasDot && /^[+-]?\d{1,3}(?:\.\d{3})+$/.test(compact)) {
    compact = compact.replace(/\./g, '');
  } else if (hasDot) {
    decimalPlaces = compact.split('.').at(-1).length;
  }

  const number = Number(compact);
  if (!Number.isFinite(number)) return null;
  return { value: percent ? number / 100 : number, currency, percent, decimalPlaces };
}

function prepareWorksheetForConfiguredExport(sheet) {
  if (!sheet?.['!ref']) return;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = sheet[address];
      if (!cell || cell.f) continue;
      if (cell.t === 'n' && Number.isFinite(cell.v)) {
        const existingFormat = String(cell.z || '');
        if (!/[dmyhs]/i.test(existingFormat)) {
          cell.z = configuredExcelNumberFormat({
            currency: existingFormat.includes('$'),
            percent: existingFormat.includes('%'),
            integer: Number.isInteger(cell.v) && !existingFormat.includes('%')
          });
        }
        delete cell.w;
        continue;
      }
      const parsed = localizedExportNumber(cell.v);
      if (!parsed) continue;
      cell.t = 'n';
      cell.v = parsed.value;
      cell.z = configuredExcelNumberFormat({
        currency: parsed.currency,
        percent: parsed.percent,
        integer: parsed.decimalPlaces === 0 && Number.isInteger(parsed.value) && !parsed.percent,
        decimalPlaces: parsed.decimalPlaces
      });
      delete cell.w;
    }
  }
}

function writeConfiguredExcelWorkbook(workbook, filename) {
  workbook.SheetNames.forEach(name => prepareWorksheetForConfiguredExport(workbook.Sheets[name]));
  workbook.Props = {
    ...(workbook.Props || {}),
    Comments: `Sistema decimal de exportación: ${exportDecimalSystem === 'dot' ? '1,234.56' : '1.234,56'}`
  };
  XLSX.writeFile(workbook, filename, { compression: true, cellStyles: true });
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

async function inspectTransactionFile(file, field, locationOverride = null, input = null) {
  if (!file) return;
  const status = transactionUploadStatus();
  clearInspection();
  setStatus(status, `Validando “${file.name}” y detectando sus fechas…`);
  document.querySelectorAll('.transaction-upload-button').forEach(button => { button.disabled = true; });
  try {
    const location = locationOverride || transactionUploadContext?.location || document.getElementById('location-select').value;
    const formData = new FormData();
    formData.append(field, file);
    const manifest = await apiRequest(`/api/uploads/transactions/inspect?location=${encodeURIComponent(location)}`, {
      method: 'POST',
      body: formData
    });
    const autoConfirm = canAutoConfirmToteatReport(manifest);
    showInspection(manifest, { openDialog: !autoConfirm });
    if (autoConfirm) {
      setStatus(status,
        `Estructura y fechas válidas (${formatDetectedRange(manifest.detectedRange)}). Procesando automáticamente ${FIELD_LABELS[manifest.files[0].field] || 'el reporte'}…`,
        'success');
      return confirmTransactionUpload('keep', { automatic: true });
    }
    const acceptedWarning = manifest.files.find(file => file.structure?.permissive);
    if (acceptedWarning) {
      setStatus(status,
        `${acceptedWarning.structure.reason} Fechas detectadas: ${formatDetectedRange(manifest.detectedRange)}. Revisa y confirma en la ventana emergente.`,
        'warning');
    } else {
      setStatus(status, manifest.detectedRange
        ? `Estructura válida. Fechas detectadas: ${formatDetectedRange(manifest.detectedRange)}. Revisa y confirma en la ventana emergente.`
        : 'La estructura es válida, pero no se detectaron fechas. Ingresa el rango correcto en la ventana emergente.', 'success');
    }
  } catch (error) {
    if (input) input.value = '';
    setStatus(status, error.message, 'error');
    transactionUploadContext = null;
    return false;
  } finally {
    updateFileUploadControls();
  }
}

async function inspectSelectedTransactionFile(input, locationOverride = null) {
  if (!input.files.length) return;
  return inspectTransactionFile(input.files[0], input.name, locationOverride, input);
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
  document.getElementById('inventory-file-confirmed').checked = false;
  document.getElementById('inventory-file-confirmation-row').hidden = true;
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

function hasCompleteDetectedRange(range) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  return Boolean(range && isoDate.test(range.from) && isoDate.test(range.to) && range.from <= range.to);
}

function canAutoConfirmToteatReport(manifest) {
  const expectedField = transactionUploadContext?.toteatField || 'sales';
  return transactionUploadContext?.downloadedFrom === 'toteat'
    && manifest?.location === transactionUploadContext.location
    && manifest.files?.length === 1
    && manifest.files.every(file => file.field === expectedField
      && file.size > 0
      && file.structure?.ok
      && !file.structure.permissive
      && hasCompleteDetectedRange(file.detectedRange))
    && hasCompleteDetectedRange(manifest.detectedRange);
}

async function confirmTransactionUpload(overlapAction, { automatic = false } = {}) {
  const button = overlapAction === 'replace'
    ? document.getElementById('replace-transactions-btn')
    : document.getElementById('keep-transactions-btn');
  const status = document.getElementById('transaction-confirmation-status');
  const uploadContext = transactionUploadContext;
  const pageStatus = transactionUploadStatus();
  const dateFrom = document.getElementById('confirmed-date-from').value;
  const dateTo = document.getElementById('confirmed-date-to').value;
  const requiresDateConfirmation = !automatic && (!inspectionState?.files?.length
    || inspectionState.files.some(file => file.field !== 'sales'));
  const confirmed = document.getElementById('dates-confirmed').checked;
  const requiresCategoryConfirmation = inspectionState?.files.some(file => file.structure?.requiresCategoryConfirmation);
  const categoryConfirmed = document.getElementById('inventory-file-confirmed').checked;
  const fail = message => {
    setStatus(status, message, 'error');
    if (automatic) {
      setStatus(pageStatus, `No se completó la carga automática: ${message} Revisa la confirmación pendiente.`, 'error');
      const confirmation = document.getElementById('date-confirmation');
      if (!confirmation.open) confirmation.showModal();
    }
    return false;
  };
  if (!inspectionState) return fail('Vuelve a revisar los archivos antes de confirmar.');
  if (!dateFrom || !dateTo) return fail('Ingresa las fechas desde y hasta.');
  if (requiresDateConfirmation && !confirmed) return fail('Marca la confirmación de fechas antes de guardar.');
  if (requiresCategoryConfirmation && !categoryConfirmed) {
    return fail('Confirma que seleccionaste el archivo correcto para Kardex o Merma.');
  }
  button.disabled = true;
  setStatus(automatic ? pageStatus : status, automatic
    ? 'Validación completa. Manteniendo los datos existentes y agregando automáticamente los nuevos…'
    : 'Guardando archivos confirmados…');
  try {
    const savedLocation = inspectionState.location;
    const result = await apiRequest('/api/uploads/transactions/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inspectionState.token, dateFrom, dateTo, confirmed: true, categoryConfirmed, overlapAction })
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
    if (result.imports?.['payment-details']) {
      const imported = result.imports['payment-details'];
      importMessages.push(imported.newTransactions
        ? `Detalle Pagos actualizado: ${imported.newTransactions} fila(s) nueva(s) guardada(s) y ${imported.duplicateTransactions} repetida(s) omitida(s).`
        : `Detalle Pagos procesado sin duplicar datos: ${imported.duplicateTransactions} fila(s) ya existía(n).`);
    }
    if (importMessages.length) {
      setStatus(pageStatus, importMessages.join(' '), 'success');
    } else {
      setStatus(pageStatus, overlapAction === 'replace'
        ? `Se reemplazaron los días coincidentes y se conservaron los datos fuera del rango para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`
        : `Se agregaron los registros nuevos sin duplicar los ya existentes para ${locationRegistry[savedLocation]?.name || 'la ubicación'}.`, 'success');
    }
    transactionUploadContext = null;
    return true;
  } catch (error) {
    return fail(error.message);
  } finally {
    button.disabled = false;
  }
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
      : 'Esta cafetería recibe Kardex, merma, consumos de marketing y colaboradores, compras, ventas, Detalle Pagos y transacciones MercadoPago.';
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

function formatPurchaseOrderCost(value) {
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    .format(Number(value) || 0);
}

function roundedPurchaseOrderCost(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : NaN;
}

function parseLocalizedNumber(value) {
  const text = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!text) return NaN;
  if (text.includes(',') && text.includes('.')) return Number(text.replace(/\./g, '').replace(',', '.'));
  if (text.includes(',')) return Number(text.replace(',', '.'));
  if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ''));
  return Number(text);
}

function formatReportDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

function offsetIsoDate(value, amount) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function rankText(label, ranking) {
  return ranking?.position ? `${label}: #${ranking.position} de ${ranking.total}` : `${label}: —`;
}

function renderIntradayReport(intraday, includeToday = true) {
  const referenceText = value => value ? formatReportDate(value) : 'Sin referencia';
  const intradayTitle = includeToday ? 'Venta acumulada de hoy' : 'Venta acumulada del día anterior';
  const referenceTitle = includeToday ? 'Hoy' : 'Día anterior';
  document.getElementById('intraday-title').textContent = intradayTitle;
  document.getElementById('intraday-reference-title').textContent = referenceTitle;
  document.getElementById('intraday-indicators').setAttribute('aria-label', `Indicadores de ${intradayTitle.toLowerCase()}`);
  document.getElementById('intraday-today-date').textContent = formatReportDate(intraday.today.date);
  const cutoffLabel = intraday.today.cutoffTime
    ? `Corte ${intraday.today.cutoffTime.slice(0, 5)}`
    : includeToday ? 'Sin ventas de hoy' : 'Sin ventas del día anterior';
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
    renderIntradayReport(report.intraday, report.includeToday);
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

async function downloadReportSalesFromToteat() {
  const status = document.getElementById('report-status');
  const button = document.getElementById('report-download-toteat-sales');
  const location = document.getElementById('report-location-filter').value || 'all';
  if (location === 'all' || locationRegistry[location]?.type !== 'store') {
    return setStatus(status, 'Selecciona una cafetería específica antes de descargar sus ventas desde Toteat.', 'error');
  }
  button.disabled = true;
  setStatus(status, `Conectando con Toteat para ${locationRegistry[location].name}…`);
  try {
    const downloadReport = async (endpoint, fallbackFilename) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || 'No se pudo descargar el reporte desde Toteat.');
        error.code = payload.code;
        error.state = payload.state;
        error.status = response.status;
        throw error;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackFilename;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { blob, filename };
    };
    const validateAndSave = async (download, field) => {
      transactionUploadContext = {
        source: 'report', statusId: 'report-status', location, refreshReport: true,
        downloadedFrom: 'toteat', toteatField: field
      };
      setStatus(status, `${download.filename} descargado. Validando estructura y fechas…`);
      const saved = await inspectTransactionFile(
        new File([download.blob], download.filename, { type: download.blob.type || 'text/csv' }),
        field,
        location
      );
      if (!saved) throw new Error(status.textContent || `No se pudo validar y guardar ${FIELD_LABELS[field] || field}.`);
    };

    const sales = await downloadReport('/api/integrations/toteat/download-sales', `ventas-toteat-${location}.xlsx`);
    await validateAndSave(sales, 'sales');
    setStatus(status, 'Ventas procesadas correctamente. Descargando ahora Detalle Pagos desde Toteat…', 'success');
    const paymentDetails = await downloadReport(
      '/api/integrations/toteat/download-payment-details',
      `detalle-pagos-toteat-${location}.csv`
    );
    await validateAndSave(paymentDetails, 'payment-details');
    setStatus(status, 'Ventas y Detalle Pagos fueron descargados, validados y actualizados correctamente.', 'success');
    return;
  } catch (error) {
    if (error.status !== 409 || error.code !== 'TOTEAT_AUTH_REQUIRED') {
      return setStatus(status, error.message, 'error');
    }
    const expiredSession = error.state === 'session_expired';
    setStatus(status, expiredSession
      ? `La sesión vencida de Toteat fue detectada. Abriendo una nueva sesión para ${locationRegistry[location].name}…`
      : `Abriendo Toteat para conectar ${locationRegistry[location].name}…`);
    const connectResponse = await fetch('/api/integrations/toteat/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location })
    });
    const connection = await connectResponse.json().catch(() => ({}));
    if (!connectResponse.ok) throw new Error(connection.error || 'No se pudo abrir la sesión de Toteat.');
    setStatus(status, expiredSession
      ? `Se cerró la sesión vencida y se abrió Toteat para ${locationRegistry[location].name}. Inicia sesión allí y luego vuelve a presionar “Descargar Ventas desde web”.`
      : `Se abrió Toteat para ${locationRegistry[location].name}. Inicia sesión allí y luego vuelve a presionar “Descargar Ventas desde web”.`,
    'muted');
  } finally {
    button.disabled = false;
  }
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

function refreshFindingsLocationFilter() {
  const select = document.getElementById('findings-location');
  if (!select) return;
  const previous = select.value || 'all';
  const options = [new Option('Todas las ubicaciones', 'all')];
  for (const location of Object.values(locationRegistry)) options.push(new Option(location.name, location.id));
  select.replaceChildren(...options);
  select.value = previous === 'all' || locationRegistry[previous] ? previous : 'all';
}

function findingsSummaryCard(label, value, className = '') {
  const card = document.createElement('article');
  card.className = `findings-summary-card ${className}`.trim();
  const title = document.createElement('span');
  title.textContent = label;
  const number = document.createElement('strong');
  number.textContent = value;
  card.append(title, number);
  return card;
}

function renderFindingsView() {
  const summary = document.getElementById('findings-summary');
  const context = document.getElementById('findings-context');
  const report = document.getElementById('findings-report');
  if (!findingsViewState) {
    summary.replaceChildren();
    context.textContent = '';
    report.replaceChildren();
    return;
  }
  const data = findingsViewState;
  const statusFilter = document.getElementById('findings-status-filter')?.value || 'open';
  const allFindings = data.sections.flatMap(section => section.findings);
  const openFindings = allFindings.filter(finding => !finding.closed);
  const closedFindings = allFindings.filter(finding => finding.closed);
  const visibleSections = data.sections.map(section => ({
    ...section,
    findings: statusFilter === 'open' ? section.findings.filter(finding => !finding.closed) : section.findings
  }));
  summary.replaceChildren(
    findingsSummaryCard('Abiertos por revisar', openFindings.length),
    findingsSummaryCard('Cerrados', closedFindings.length, 'closed'),
    findingsSummaryCard('Prioridad alta', openFindings.filter(finding => finding.severity === 'high').length, 'high'),
    findingsSummaryCard('Prioridad media', openFindings.filter(finding => finding.severity === 'medium').length, 'medium'),
    findingsSummaryCard('Atención', openFindings.filter(finding => finding.severity === 'low').length, 'low')
  );
  const sourceText = data.sources.length
    ? `Fuentes maestras: ${data.sources.map(source => `${source.type} “${source.name}” (vigente desde ${formatReportDate(source.validFrom)})`).join(' · ')}.`
    : 'No se encontraron fuentes maestras vigentes.';
  const warningText = data.warnings.length ? ` Advertencias de lectura: ${data.warnings.join(' ')}` : '';
  context.textContent = `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · ${data.summary.salesRowsRead} filas de ventas, ${data.summary.purchaseRowsRead} líneas de compra y ${data.summary.ordersRead} órdenes revisadas. ${sourceText}${warningText}`;
  const severityLabels = { high: 'Alta', medium: 'Media', low: 'Atención' };
  report.replaceChildren(...visibleSections.map(section => {
    const container = document.createElement('section');
    container.className = 'findings-section';
    container.dataset.section = section.key;
    const head = document.createElement('div');
    head.className = 'findings-section-head';
    const headingCopy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = section.label;
    const description = document.createElement('p');
    description.textContent = section.description;
    headingCopy.append(title, description);
    const count = document.createElement('span');
    count.className = 'findings-section-count';
    count.textContent = section.findings.length;
    count.setAttribute('aria-label', `${section.findings.length} hallazgo(s)`);
    head.append(headingCopy, count);
    container.appendChild(head);
    if (!section.findings.length) {
      const empty = document.createElement('div');
      empty.className = 'findings-empty-section';
      empty.textContent = statusFilter === 'open'
        ? 'Sin hallazgos abiertos para este período.'
        : 'Sin señales que requieran revisión para este período.';
      container.appendChild(empty);
      return container;
    }
    const list = document.createElement('div');
    list.className = 'findings-list';
    section.findings.forEach(finding => {
      const item = document.createElement('article');
      item.className = `finding-item${finding.closed ? ' closed' : ''}`;
      item.dataset.findingId = finding.id;
      const severity = document.createElement('span');
      severity.className = `finding-severity ${finding.severity}`;
      severity.textContent = severityLabels[finding.severity] || finding.severity;
      const copy = document.createElement('div');
      copy.className = 'finding-copy';
      const findingNumber = document.createElement('span');
      findingNumber.className = 'finding-number';
      findingNumber.textContent = `Hallazgo N.º ${finding.number}`;
      const findingTitle = document.createElement('strong');
      findingTitle.textContent = finding.title;
      const detail = document.createElement('p');
      detail.textContent = finding.detail;
      copy.append(findingNumber, findingTitle, detail);
      const metadata = [
        finding.code ? `Código: ${finding.code}` : null,
        finding.location ? `Ubicación: ${finding.location}` : null,
        finding.date || finding.occurrenceDate ? `Fecha del hallazgo: ${formatReportDate(finding.date || finding.occurrenceDate)}` : null,
        finding.createdAt ? `Registrado: ${formatReportDate(finding.createdAt.slice(0, 10))}` : null,
        finding.observed !== null && finding.observed !== undefined ? `Observado: ${finding.observed}` : null
      ].filter(Boolean);
      if (metadata.length) {
        const meta = document.createElement('div');
        meta.className = 'finding-meta';
        meta.textContent = metadata.join(' · ');
        copy.appendChild(meta);
      }
      const action = document.createElement('div');
      action.className = 'finding-action';
      action.textContent = `Revisión sugerida: ${finding.action}`;
      const reviewControls = document.createElement('div');
      reviewControls.className = 'finding-review-controls';
      const closedLabel = document.createElement('label');
      closedLabel.className = 'finding-closed-toggle';
      const closed = document.createElement('input');
      closed.type = 'checkbox';
      closed.checked = Boolean(finding.closed);
      closed.setAttribute('aria-label', `Marcar Hallazgo N.º ${finding.number} como cerrado`);
      closed.addEventListener('change', () => updateStoredFinding(finding.id, { closed: closed.checked }, true));
      closedLabel.append(closed, document.createTextNode('Cerrado'));
      const observationsLabel = document.createElement('label');
      observationsLabel.className = 'finding-observations-label';
      observationsLabel.appendChild(document.createTextNode('Observaciones'));
      const observations = document.createElement('textarea');
      observations.className = 'finding-observations';
      observations.maxLength = 5000;
      observations.value = finding.observations || '';
      observations.placeholder = 'Anota la revisión o solución aplicada';
      observations.setAttribute('aria-label', `Observaciones del Hallazgo N.º ${finding.number}`);
      observationsLabel.appendChild(observations);
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'icon-button small';
      save.textContent = 'Guardar observaciones';
      const saveStatus = document.createElement('span');
      saveStatus.className = 'finding-save-status';
      saveStatus.setAttribute('aria-live', 'polite');
      save.addEventListener('click', async () => {
        save.disabled = true;
        saveStatus.textContent = 'Guardando…';
        const saved = await updateStoredFinding(finding.id, { observations: observations.value }, false);
        save.disabled = false;
        saveStatus.textContent = saved ? 'Observaciones guardadas.' : 'No se pudieron guardar.';
      });
      reviewControls.append(closedLabel, observationsLabel, save, saveStatus);
      item.append(severity, copy, action, reviewControls);
      list.appendChild(item);
    });
    container.appendChild(list);
    return container;
  }));
}

function replaceFindingInView(updatedFinding) {
  if (!findingsViewState) return;
  for (const section of findingsViewState.sections) {
    const index = section.findings.findIndex(finding => finding.id === updatedFinding.id);
    if (index >= 0) {
      section.findings[index] = updatedFinding;
      return;
    }
  }
}

async function updateStoredFinding(id, changes, rerender) {
  const status = document.getElementById('findings-status');
  try {
    const data = await apiRequest(`/api/findings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    });
    replaceFindingInView(data.finding);
    if (rerender) renderFindingsView();
    setStatus(status, `Hallazgo N.º ${data.finding.number} actualizado.`, 'success');
    return true;
  } catch (error) {
    if (rerender) renderFindingsView();
    setStatus(status, error.message, 'error');
    return false;
  }
}

async function loadFindingsView() {
  const status = document.getElementById('findings-status');
  const button = document.getElementById('run-findings');
  const params = new URLSearchParams({ location: document.getElementById('findings-location').value || 'all' });
  const dateFrom = document.getElementById('findings-date-from').value;
  const dateTo = document.getElementById('findings-date-to').value;
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  button.disabled = true;
  setStatus(status, 'Revisando productos, recetas, costos, inventarios, órdenes, compras y ventas…');
  try {
    const data = await apiRequest(`/api/findings?${params}`);
    findingsViewState = data;
    document.getElementById('findings-date-from').value = data.period.from;
    document.getElementById('findings-date-to').value = data.period.to;
    renderFindingsView();
    const openCount = data.sections.flatMap(section => section.findings).filter(finding => !finding.closed).length;
    const openHighCount = data.sections.flatMap(section => section.findings)
      .filter(finding => !finding.closed && finding.severity === 'high').length;
    const persistenceText = Number.isFinite(data.summary.added)
      ? ` ${data.summary.added} nuevo(s) agregado(s) y ${data.summary.reused} existente(s) reconocido(s).`
      : '';
    setStatus(status, data.summary.total
      ? `Revisión completa: ${openCount} hallazgo(s) abierto(s), ${openHighCount} de prioridad alta.${persistenceText}`
      : 'Revisión completa: no se detectaron señales que requieran atención.', openHighCount ? 'warning' : 'success');
  } catch (error) {
    findingsViewState = null;
    renderFindingsView();
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
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

function syncSalesServiceModeControls() {
  const custom = document.getElementById('sales-service-mode-period').value === 'custom';
  document.getElementById('sales-service-mode-custom-range').hidden = !custom;
  return custom;
}

function alignSalesServiceModeTableHeight() {
  const tableWrap = document.querySelector('.sales-service-mode-table-wrap');
  const packagingSection = document.querySelector('.avoided-cups-section');
  if (!tableWrap || !packagingSection) return;
  tableWrap.style.maxHeight = '';
  if (window.matchMedia('(max-width: 900px)').matches) return;
  window.requestAnimationFrame(() => {
    const availableHeight = packagingSection.getBoundingClientRect().bottom - tableWrap.getBoundingClientRect().top;
    tableWrap.style.maxHeight = `${Math.max(360, Math.min(720, Math.round(availableHeight)))}px`;
  });
}

function renderSalesServiceModes() {
  if (!salesDashboardState) return;
  const serviceModes = salesDashboardState.sales.serviceModes;
  const periodKey = document.getElementById('sales-service-mode-period').value;
  const period = serviceModes?.periods?.[periodKey];
  const summary = document.getElementById('sales-service-mode-summary');
  const hierarchyBody = document.getElementById('sales-service-mode-hierarchies');
  const hierarchyFoot = document.getElementById('sales-service-mode-hierarchy-totals');
  const cups = document.getElementById('sales-avoided-cups');
  const status = document.getElementById('sales-service-mode-status');
  if (!period) {
    summary.replaceChildren();
    hierarchyBody.replaceChildren();
    hierarchyFoot.replaceChildren();
    cups.textContent = 'No hay información disponible para este período.';
    setStatus(status, periodKey === 'custom'
      ? 'Define las fechas Desde y Hasta, y luego presiona Aplicar.'
      : 'No fue posible construir la estadística de modalidad.', periodKey === 'custom' ? 'muted' : 'error');
    return;
  }
  summary.replaceChildren(...period.groups.map(group => {
    const card = document.createElement('article');
    card.className = `sales-service-mode-card ${group.key}`;
    const title = document.createElement('h4');
    title.textContent = group.label;
    const value = document.createElement('strong');
    value.textContent = `${group.orders.toLocaleString('es-CL')} pedido${group.orders === 1 ? '' : 's'}`;
    const sales = document.createElement('p');
    sales.textContent = `${formatClp(group.netSales)} venta neta · ${group.orderPercent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de pedidos · ${group.salesPercent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de ventas`;
    const ticket = document.createElement('p');
    ticket.className = 'sales-service-mode-ticket';
    ticket.textContent = `Ticket promedio ${formatClp(group.averageTicket ?? (group.orders ? group.netSales / group.orders : 0))}`;
    card.append(title, value, sales, ticket);
    return card;
  }));
  if (period.hierarchies.length) {
    hierarchyBody.replaceChildren(...period.hierarchies.map(hierarchy => {
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      name.textContent = hierarchy.name;
      row.appendChild(name);
      for (const key of ['takeaway', 'dineIn', 'unknown']) {
        const cell = document.createElement('td');
        const value = document.createElement('div');
        value.className = 'service-mode-table-value';
        const sales = document.createElement('strong');
        sales.textContent = formatClp(hierarchy.groups[key].netSales);
        const orders = document.createElement('small');
        orders.textContent = `${hierarchy.groups[key].orders} pedido${hierarchy.groups[key].orders === 1 ? '' : 's'}`;
        value.append(sales, orders);
        cell.appendChild(value);
        row.appendChild(cell);
      }
      const total = document.createElement('td');
      total.className = 'numeric-cell';
      total.textContent = formatClp(hierarchy.totalNetSales);
      row.appendChild(total);
      return row;
    }));
  } else {
    const row = document.createElement('tr');
    const empty = document.createElement('td');
    empty.colSpan = 5;
    empty.className = 'sales-service-mode-empty';
    empty.textContent = 'No hay ventas por jerarquía en el período seleccionado.';
    row.appendChild(empty);
    hierarchyBody.replaceChildren(row);
  }
  const hierarchyTotals = period.hierarchyTotals || {
    takeaway: period.hierarchies.reduce((sum, item) => sum + item.groups.takeaway.netSales, 0),
    dineIn: period.hierarchies.reduce((sum, item) => sum + item.groups.dineIn.netSales, 0),
    unknown: period.hierarchies.reduce((sum, item) => sum + item.groups.unknown.netSales, 0),
    total: period.hierarchies.reduce((sum, item) => sum + item.totalNetSales, 0)
  };
  const totalRow = document.createElement('tr');
  const totalHeading = document.createElement('th');
  totalHeading.scope = 'row';
  totalHeading.textContent = 'Total jerarquías';
  totalRow.appendChild(totalHeading);
  for (const key of ['takeaway', 'dineIn', 'unknown', 'total']) {
    const cell = document.createElement('td');
    cell.className = 'numeric-cell';
    cell.textContent = formatClp(hierarchyTotals[key] || 0);
    totalRow.appendChild(cell);
  }
  hierarchyFoot.replaceChildren(totalRow);
  const packaging = period.avoidedDisposablePackaging || period.avoidedDisposableCups || [];
  if (packaging.length) {
    cups.className = 'sales-avoided-cups';
    const items = packaging.map(itemData => {
      const item = document.createElement('div');
      item.className = 'sales-avoided-cup';
      const identity = document.createElement('div');
      identity.className = 'sales-avoided-packaging-identity';
      const type = document.createElement('small');
      type.textContent = itemData.kind === 'lid' ? 'Tapa' : 'Vaso';
      const name = document.createElement('span');
      name.textContent = `${itemData.name}${itemData.code ? ` · ${itemData.code}` : ''}`;
      identity.append(type, name);
      const values = document.createElement('div');
      values.className = 'sales-avoided-packaging-values';
      const quantity = document.createElement('strong');
      quantity.textContent = `${Number(itemData.quantity).toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${itemData.unit || 'UN'}`;
      const cost = document.createElement('small');
      cost.textContent = itemData.hasCost
        ? `Costo unitario ${formatClp(itemData.unitCost)} · Ahorro ${formatClp(itemData.totalCost)}`
        : 'Costo de compra o maestro no disponible';
      values.append(quantity, cost);
      item.append(identity, values);
      return item;
    });
    const total = document.createElement('div');
    total.className = 'sales-avoided-packaging-total';
    const totalLabel = document.createElement('span');
    totalLabel.textContent = 'Ahorro total valorizado';
    const totalValue = document.createElement('strong');
    totalValue.textContent = formatClp(period.totalAvoidedPackagingCost || 0);
    total.append(totalLabel, totalValue);
    if (period.packagingWithoutCost?.length) {
      const warning = document.createElement('small');
      warning.textContent = `${period.packagingWithoutCost.length} tipo(s) sin costo de compra o maestro no están incluidos en el total.`;
      total.appendChild(warning);
    }
    cups.replaceChildren(...items, total);
  } else {
    cups.className = 'sales-avoided-cups sales-service-mode-empty';
    cups.textContent = serviceModes.recipeSource
      ? 'No se identificaron vasos ni tapas desechables evitados en las recetas para este período.'
      : 'No hay un maestro de recetas vigente para estimar el packaging evitado.';
  }
  alignSalesServiceModeTableHeight();
  const coverage = period.totalOrders ? period.matchedOrders / period.totalOrders * 100 : 0;
  const coverageText = `${formatReportDate(period.period.from)} – ${formatReportDate(period.period.to)} · ${period.matchedOrders} de ${period.totalOrders} pedidos relacionados con Detalle Pagos (${coverage.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%).`;
  const ambiguityText = period.ambiguousOrders
    ? ` ${period.ambiguousOrders} pedido(s) contenían indicaciones mixtas y se clasificaron sin información.`
    : '';
  const recipeText = period.productsWithoutRecipe.length
      ? ` ${period.productsWithoutRecipe.length} producto(s) servidos no tenían receta y no pudieron aportar al cálculo de packaging.`
      : '';
  setStatus(status, serviceModes.paymentDetailsFilesRead
    ? `${coverageText}${ambiguityText}${recipeText}`
    : 'No hay archivos de Detalle Pagos disponibles; todos los pedidos se muestran sin información.',
  serviceModes.paymentDetailsFilesRead ? 'success' : 'muted');
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

function hourlyProductIdentity(product) {
  return `${product.code || ''}\u001f${product.name || ''}`;
}

function hourlyPathMatches(product, path) {
  return path.every((name, index) => product.hierarchyPath[index] === name);
}

function formatDemandQuantity(value) {
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value || 0);
}

function formatHourlyTableQuantity(value) {
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value || 0);
}

function filteredHourlyDemandRows(report = hourlySalesDemandState) {
  if (!report) return [];
  return report.buckets.map(bucket => {
    const products = bucket.products.filter(product =>
      hourlyPathMatches(product, hourlySalesHierarchyPath)
      && (!hourlySalesProductKey || hourlyProductIdentity(product) === hourlySalesProductKey));
    const dailyUnits = Object.fromEntries((report.selectedDates || []).map(date => [
      date,
      products.reduce((sum, product) => sum + (Number(product.dailyUnits?.[date]) || 0), 0)
    ]));
    const dailyNetSales = Object.fromEntries((report.selectedDates || []).map(date => [
      date,
      products.reduce((sum, product) => sum + (Number(product.dailyNetSales?.[date]) || 0), 0)
    ]));
    const dailyUnitValues = Object.values(dailyUnits);
    const dailySalesValues = Object.values(dailyNetSales);
    return {
      label: bucket.label,
      quantity: products.reduce((sum, product) => sum + product.quantity, 0),
      netSales: products.reduce((sum, product) => sum + product.netSales, 0),
      dailyUnits,
      minQuantity: dailyUnitValues.length ? Math.min(...dailyUnitValues) : 0,
      maxQuantity: dailyUnitValues.length ? Math.max(...dailyUnitValues) : 0,
      dailyNetSales,
      minNetSales: dailySalesValues.length ? Math.min(...dailySalesValues) : 0,
      maxNetSales: dailySalesValues.length ? Math.max(...dailySalesValues) : 0
    };
  });
}

function hourlyMinMaxLabel(minimum, maximum) {
  return `${formatHourlyTableQuantity(minimum)} – ${formatHourlyTableQuantity(maximum)}`;
}

function hourlySalesMinMaxLabel(minimum, maximum) {
  return `${formatClp(minimum)} – ${formatClp(maximum)}`;
}

function hourlyChartButton(metric = 'units') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hourly-demand-chart-button';
  button.dataset.metric = metric;
  button.title = metric === 'sales'
    ? 'Ver facturación por día y franja horaria'
    : 'Ver unidades vendidas por día y franja horaria';
  button.setAttribute('aria-label', button.title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y, width, height] of [[2, 11, 3, 6], [8, 7, 3, 10], [14, 3, 3, 14]]) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('rx', '1');
    svg.appendChild(rect);
  }
  button.appendChild(svg);
  button.addEventListener('click', () => openHourlyDemandChart(metric));
  return button;
}

function appendSvgElement(parent, tagName, attributes = {}, textValue = null) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  if (textValue !== null) element.textContent = textValue;
  parent.appendChild(element);
  return element;
}

function openHourlyDemandChart(metric = hourlyDemandChartMetric) {
  const report = hourlySalesDemandState;
  if (!report?.selectedDates?.length) return;
  hourlyDemandChartMetric = metric === 'sales' ? 'sales' : 'units';
  const isSalesChart = hourlyDemandChartMetric === 'sales';
  const rows = filteredHourlyDemandRows(report);
  const chronologicalDates = report.selectedDates.slice().sort();
  const weekdayIndex = date => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekdayInitials = ['L', 'M', 'W', 'J', 'V', 'S', 'D'];
  const groupByWeekday = document.getElementById('hourly-demand-chart-order').value === 'weekday';
  const dates = chronologicalDates.slice().sort((left, right) => groupByWeekday
    ? weekdayIndex(left) - weekdayIndex(right) || left.localeCompare(right)
    : left.localeCompare(right));
  const dailyTotals = dates.map(date => rows.reduce((sum, row) => sum
    + (Number(isSalesChart ? row.dailyNetSales[date] : row.dailyUnits[date]) || 0), 0));
  const maximum = Math.max(1, ...dailyTotals);
  const formatChartValue = value => isSalesChart ? formatClp(value) : formatHourlyTableQuantity(value);
  const palette = ['#b96f3f', '#d08b4e', '#d6a55d', '#8d6747', '#6f8061', '#4f8270', '#3f6e78', '#6673a1', '#84658e', '#9b5f68', '#a37756', '#77808b', '#5f7256', '#967b45'];
  const margin = { top: 34, right: 24, bottom: 96, left: isSalesChart ? 90 : 58 };
  const plotHeight = 280;
  const step = isSalesChart ? 74 : 54;
  const width = Math.max(760, margin.left + margin.right + dates.length * step);
  const height = margin.top + plotHeight + margin.bottom;
  const plotWidth = width - margin.left - margin.right;
  const barStep = plotWidth / dates.length;
  const barWidth = Math.min(34, barStep * 0.68);
  const svg = document.getElementById('hourly-demand-chart');
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  for (let index = 0; index <= 4; index += 1) {
    const value = maximum * index / 4;
    const y = margin.top + plotHeight - plotHeight * index / 4;
    appendSvgElement(svg, 'line', { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: 'hourly-chart-grid-line' });
    appendSvgElement(svg, 'text', { x: margin.left - 9, y: y + 4, class: 'hourly-chart-axis-label', 'text-anchor': 'end' }, formatChartValue(value));
  }

  dates.forEach((date, dateIndex) => {
    const x = margin.left + dateIndex * barStep + (barStep - barWidth) / 2;
    if (groupByWeekday && dateIndex > 0 && weekdayIndex(date) !== weekdayIndex(dates[dateIndex - 1])) {
      const separatorX = margin.left + dateIndex * barStep;
      appendSvgElement(svg, 'line', {
        x1: separatorX,
        y1: margin.top - 8,
        x2: separatorX,
        y2: margin.top + plotHeight + 70,
        class: 'hourly-chart-weekday-separator'
      });
    }
    let bottom = margin.top + plotHeight;
    rows.forEach((row, rowIndex) => {
      const value = Number(isSalesChart ? row.dailyNetSales[date] : row.dailyUnits[date]) || 0;
      if (value <= 0) return;
      const segmentHeight = value / maximum * plotHeight;
      bottom -= segmentHeight;
      const rect = appendSvgElement(svg, 'rect', {
        x,
        y: bottom,
        width: barWidth,
        height: Math.max(1, segmentHeight),
        fill: palette[rowIndex % palette.length],
        class: 'hourly-chart-segment'
      });
      appendSvgElement(rect, 'title', {}, `${formatReportDate(date)} · ${row.label}: ${formatChartValue(value)}${isSalesChart ? ' facturación neta' : ' unidades'}`);
    });
    appendSvgElement(svg, 'text', {
      x: x + barWidth / 2,
      y: Math.max(16, bottom - 7),
      class: 'hourly-chart-total-label',
      'text-anchor': 'middle'
    }, formatChartValue(dailyTotals[dateIndex]));
    appendSvgElement(svg, 'text', {
      x: x + barWidth / 2,
      y: margin.top + plotHeight + 17,
      class: 'hourly-chart-date-label',
      'text-anchor': 'end',
      transform: `rotate(-45 ${x + barWidth / 2} ${margin.top + plotHeight + 17})`
    }, new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)));
    appendSvgElement(svg, 'text', {
      x: x + barWidth / 2,
      y: margin.top + plotHeight + 78,
      class: 'hourly-chart-weekday-label',
      'text-anchor': 'middle'
    }, weekdayInitials[weekdayIndex(date)]);
  });

  const legend = document.getElementById('hourly-demand-chart-legend');
  legend.replaceChildren(...rows.map((row, index) => {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.backgroundColor = palette[index % palette.length];
    item.append(swatch, row.label);
    return item;
  }));
  const path = ['Todas las jerarquías', ...hourlySalesHierarchyPath];
  if (hourlySalesProductKey) {
    const selectedProduct = report.buckets.flatMap(bucket => bucket.products)
      .find(product => hourlyProductIdentity(product) === hourlySalesProductKey);
    if (selectedProduct) path.push(selectedProduct.name);
  }
  document.getElementById('hourly-demand-chart-context').textContent =
    `${path.join(' › ')} · ${formatReportDate(chronologicalDates[0])} – ${formatReportDate(chronologicalDates.at(-1))}`;
  document.getElementById('hourly-demand-chart-eyebrow').textContent = isSalesChart ? 'Facturación por día' : 'Unidades por día';
  document.getElementById('hourly-demand-chart-heading').textContent = isSalesChart
    ? 'Facturación diaria por franja horaria'
    : 'Composición diaria por franja horaria';
  document.getElementById('hourly-demand-chart-title').textContent = isSalesChart
    ? 'Facturación neta diaria por franja horaria'
    : 'Unidades vendidas diariamente por franja horaria';
  document.getElementById('hourly-demand-chart-description').textContent = isSalesChart
    ? 'Gráfico de barras apiladas. Cada barra representa la facturación neta de un día y cada sección una franja horaria.'
    : 'Gráfico de barras apiladas. Cada barra representa las unidades de un día y cada sección una franja horaria.';
  const dialog = document.getElementById('hourly-demand-chart-dialog');
  if (!dialog.open) dialog.showModal();
}

function renderHourlySalesDemand() {
  const report = hourlySalesDemandState;
  if (!report) return;
  const allProducts = report.buckets.flatMap(bucket => bucket.products);
  const productsInPath = allProducts.filter(product => hourlyPathMatches(product, hourlySalesHierarchyPath));
  const selectedProducts = hourlySalesProductKey
    ? productsInPath.filter(product => hourlyProductIdentity(product) === hourlySalesProductKey)
    : productsInPath;
  const hierarchyList = document.getElementById('hourly-demand-hierarchies');
  const nextDepth = hourlySalesHierarchyPath.length;
  const children = new Map();
  productsInPath.forEach(product => {
    const name = product.hierarchyPath[nextDepth];
    if (!name) return;
    const item = children.get(name) || { name, quantity: 0, netSales: 0 };
    item.quantity += product.quantity;
    item.netSales += product.netSales;
    children.set(name, item);
  });
  const pathLabel = ['Todas las jerarquías', ...hourlySalesHierarchyPath];
  if (hourlySalesProductKey && selectedProducts[0]) pathLabel.push(selectedProducts[0].name);
  document.getElementById('hourly-demand-context').textContent = pathLabel.join(' › ');
  document.getElementById('hourly-demand-back').hidden = !hourlySalesHierarchyPath.length && !hourlySalesProductKey;
  if (children.size && !hourlySalesProductKey) {
    hierarchyList.className = 'hourly-hierarchy-list';
    hierarchyList.replaceChildren(...[...children.values()].sort((left, right) => right.netSales - left.netSales).map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hourly-hierarchy-button';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const values = document.createElement('span');
      values.textContent = `${formatDemandQuantity(item.quantity)} un. · ${formatClp(item.netSales)} ›`;
      button.append(name, values);
      button.addEventListener('click', () => {
        hourlySalesHierarchyPath = [...hourlySalesHierarchyPath, item.name];
        renderHourlySalesDemand();
      });
      return button;
    }));
  } else if (!hourlySalesProductKey) {
    const productTotals = new Map();
    productsInPath.forEach(product => {
      const key = hourlyProductIdentity(product);
      const item = productTotals.get(key) || { key, code: product.code, name: product.name, quantity: 0, netSales: 0 };
      item.quantity += product.quantity;
      item.netSales += product.netSales;
      productTotals.set(key, item);
    });
    hierarchyList.className = 'hourly-hierarchy-list products';
    hierarchyList.replaceChildren(...[...productTotals.values()].sort((left, right) => right.quantity - left.quantity).map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hourly-hierarchy-button';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const values = document.createElement('span');
      values.textContent = `${item.code || 'Sin código'} · ${formatDemandQuantity(item.quantity)} un. · ${formatClp(item.netSales)}`;
      button.append(name, values);
      button.addEventListener('click', () => {
        hourlySalesProductKey = item.key;
        renderHourlySalesDemand();
      });
      return button;
    }));
  } else {
    hierarchyList.replaceChildren();
  }

  const rows = filteredHourlyDemandRows(report);
  const dailyTotals = Object.fromEntries((report.selectedDates || []).map(date => [
    date,
    rows.reduce((sum, row) => sum + (row.dailyUnits[date] || 0), 0)
  ]));
  const dailySalesTotals = Object.fromEntries((report.selectedDates || []).map(date => [
    date,
    rows.reduce((sum, row) => sum + (row.dailyNetSales[date] || 0), 0)
  ]));
  const dailyTotalValues = Object.values(dailyTotals);
  const dailySalesValues = Object.values(dailySalesTotals);
  const totals = {
    quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    netSales: rows.reduce((sum, row) => sum + row.netSales, 0),
    minQuantity: dailyTotalValues.length ? Math.min(...dailyTotalValues) : 0,
    maxQuantity: dailyTotalValues.length ? Math.max(...dailyTotalValues) : 0,
    minNetSales: dailySalesValues.length ? Math.min(...dailySalesValues) : 0,
    maxNetSales: dailySalesValues.length ? Math.max(...dailySalesValues) : 0
  };
  document.getElementById('hourly-demand-body').replaceChildren(...rows.map(item => {
    const row = document.createElement('tr');
    const values = [
      item.label,
      formatHourlyTableQuantity(item.quantity),
      hourlyMinMaxLabel(item.minQuantity, item.maxQuantity),
      formatClp(item.netSales),
      hourlySalesMinMaxLabel(item.minNetSales, item.maxNetSales),
      `${totals.quantity ? item.quantity / totals.quantity * 100 : 0}`,
      `${totals.netSales ? item.netSales / totals.netSales * 100 : 0}`
    ];
    values.forEach((value, index) => {
      const cell = document.createElement(index ? 'td' : 'th');
      if (index >= 5) cell.textContent = `${Number(value).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
      else cell.textContent = value;
      if (index) cell.className = 'numeric-cell';
      row.appendChild(cell);
    });
    return row;
  }));
  const totalRow = document.createElement('tr');
  ['Total 07:00–21:00', formatHourlyTableQuantity(totals.quantity), hourlyMinMaxLabel(totals.minQuantity, totals.maxQuantity),
    formatClp(totals.netSales), hourlySalesMinMaxLabel(totals.minNetSales, totals.maxNetSales), '100,0%', '100,0%']
    .forEach((value, index) => {
      const cell = document.createElement(index ? 'td' : 'th');
      if (index === 2 || index === 4) {
        const wrapper = document.createElement('span');
        wrapper.className = 'hourly-total-min-max';
        wrapper.append(value, hourlyChartButton(index === 4 ? 'sales' : 'units'));
        cell.appendChild(wrapper);
      } else cell.textContent = value;
      if (index) cell.className = 'numeric-cell';
      totalRow.appendChild(cell);
    });
  document.getElementById('hourly-demand-foot').replaceChildren(totalRow);
  const summary = document.getElementById('hourly-demand-summary');
  const basis = report.isAverage ? `Promedio de ${report.sampleSize} día(s) con venta` : 'Valores del día';
  summary.replaceChildren(
    salesAnalysisChip(basis),
    salesAnalysisChip(`${formatDemandQuantity(totals.quantity)} unidades`),
    salesAnalysisChip(`${formatClp(totals.netSales)} facturación neta`)
  );
}

function syncHourlyDemandControls() {
  const mode = document.getElementById('hourly-demand-mode').value;
  const isSpecificDate = mode === 'date';
  const isAutomaticPeriod = [
    'current-week', 'previous-week', 'current-month', 'previous-month',
    'last-30-days', 'last-60-days', 'last-90-days', 'last-180-days', 'last-360-days'
  ].includes(mode);
  const date = document.getElementById('hourly-demand-date');
  const days = document.getElementById('hourly-demand-days');
  date.disabled = isAutomaticPeriod;
  days.disabled = isSpecificDate || isAutomaticPeriod;
  document.getElementById('hourly-demand-date-label').classList.toggle('disabled-control', isAutomaticPeriod);
  document.getElementById('hourly-demand-days-label').classList.toggle('disabled-control', isSpecificDate || isAutomaticPeriod);
}

async function loadHourlySalesDemand() {
  const status = document.getElementById('hourly-demand-status');
  const button = document.getElementById('refresh-hourly-demand');
  const location = document.getElementById('sales-dashboard-location').value || 'all';
  const params = new URLSearchParams({
    location,
    mode: document.getElementById('hourly-demand-mode').value,
    date: document.getElementById('hourly-demand-date').value,
    days: document.getElementById('hourly-demand-days').value,
    interval: document.getElementById('hourly-demand-interval').value
  });
  button.disabled = true;
  setStatus(status, 'Calculando demanda por franja horaria…');
  try {
    const report = await apiRequest(`/api/sales/hourly-demand?${params}`);
    if (location !== document.getElementById('sales-dashboard-location').value) return;
    hourlySalesDemandState = report;
    hourlySalesHierarchyPath = [];
    hourlySalesProductKey = null;
    renderHourlySalesDemand();
    const dateList = report.selectedDates.map(formatReportDate).join(', ');
    if (!report.sampleSize) {
      setStatus(status, report.filters.mode === 'date'
        ? 'La fecha seleccionada no registra ventas; puede corresponder a un día cerrado.'
        : 'No hay días abiertos que cumplan los filtros seleccionados.', 'error');
    } else {
      setStatus(status, report.isAverage
        ? `Promedio calculado con ${report.sampleSize} día(s) abierto(s): ${dateList}.`
        : `Ventas del ${dateList}.`, 'success');
    }
  } catch (error) {
    hourlySalesDemandState = null;
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function hourlyAnalysisTableRow(values, numericFrom = 1) {
  const row = document.createElement('tr');
  values.forEach((value, index) => {
    const cell = document.createElement(index ? 'td' : 'th');
    cell.textContent = value;
    if (index >= numericFrom) cell.className = 'numeric-cell';
    row.appendChild(cell);
  });
  return row;
}

function hourlyAnalysisBreakdownFindingCard(finding, index) {
  const card = document.createElement('article');
  card.className = `hourly-analysis-finding hourly-analysis-breakdown-finding priority-${finding.priority}`;
  const head = document.createElement('div');
  head.className = 'hourly-analysis-finding-head';
  const number = document.createElement('span');
  number.className = 'hourly-analysis-finding-number';
  number.textContent = String(index + 1).padStart(2, '0');
  const titleWrap = document.createElement('div');
  const category = document.createElement('span');
  category.className = 'hourly-analysis-category';
  category.textContent = finding.category;
  const title = document.createElement('h4');
  title.textContent = finding.title;
  titleWrap.append(category, title);
  const priority = document.createElement('span');
  priority.className = `hourly-analysis-priority ${finding.priority}`;
  priority.textContent = finding.priority === 'high' ? 'Prioridad alta' : finding.priority === 'medium' ? 'Revisar' : 'Informativo';
  head.append(number, titleWrap, priority);
  const conclusion = document.createElement('p');
  conclusion.className = 'hourly-analysis-conclusion';
  conclusion.textContent = finding.conclusion;
  const evidence = document.createElement('p');
  evidence.className = 'hourly-analysis-evidence';
  evidence.textContent = `Evidencia: ${finding.evidence || 'Conclusión descriptiva basada en la muestra seleccionada.'}`;
  card.append(head, conclusion, evidence);
  if (finding.questions?.length) {
    const followup = document.createElement('div');
    followup.className = 'hourly-analysis-followup questions';
    const label = document.createElement('strong');
    label.textContent = 'Preguntas para investigar';
    const list = document.createElement('ul');
    finding.questions.forEach(textValue => {
      const item = document.createElement('li');
      item.textContent = textValue;
      list.appendChild(item);
    });
    followup.append(label, list);
    card.appendChild(followup);
  }
  return card;
}

function renderHourlyAnalysisBreakdown(breakdown) {
  const isHierarchy = breakdown.level === 'hierarchy';
  const section = document.createElement('section');
  section.className = 'hourly-analysis-section hourly-analysis-breakdown';
  section.dataset.analysisLevel = breakdown.level;
  const eyebrow = document.createElement('div');
  eyebrow.className = 'panel-eyebrow';
  eyebrow.textContent = isHierarchy ? 'Análisis por jerarquías de producto' : 'Análisis por producto';
  const heading = document.createElement('h3');
  heading.textContent = isHierarchy ? 'Comparación entre jerarquías' : 'Comportamiento individual de productos';
  const executive = document.createElement('div');
  executive.className = 'hourly-analysis-executive';
  executive.replaceChildren(...breakdown.executiveSummary.map(textValue => {
    const paragraph = document.createElement('p');
    paragraph.textContent = textValue;
    return paragraph;
  }));
  section.append(eyebrow, heading, executive);
  if (breakdown.findings.length) {
    const findingsHeading = document.createElement('h4');
    findingsHeading.textContent = 'Resultados destacados';
    const findings = document.createElement('div');
    findings.className = 'hourly-analysis-findings hourly-analysis-breakdown-findings';
    findings.replaceChildren(...breakdown.findings.map(hourlyAnalysisBreakdownFindingCard));
    section.append(findingsHeading, findings);
  }
  const detailHeading = document.createElement('h4');
  detailHeading.textContent = isHierarchy ? `Detalle de ${breakdown.groupCount} jerarquía(s)` : `Detalle de ${breakdown.groupCount} producto(s)`;
  const wrap = document.createElement('div');
  wrap.className = 'sales-table-wrap hourly-analysis-breakdown-table-wrap';
  const table = document.createElement('table');
  table.className = 'sales-dashboard-table hourly-analysis-breakdown-table';
  table.dataset.breakdownLevel = breakdown.level;
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = isHierarchy
    ? ['Jerarquía', 'Prom. unidades', 'Prom. facturación', '% unidades', '% facturación', 'CV unidades', 'Tendencia unidades', 'Días atípicos', 'Franja principal']
    : ['Código', 'Producto', 'Jerarquía', 'Prom. unidades', 'Prom. facturación', '% unidades', '% facturación', 'CV unidades', 'Tendencia unidades', 'Días atípicos', 'Franja principal'];
  headers.forEach(textValue => {
    const cell = document.createElement('th');
    cell.textContent = textValue;
    headerRow.appendChild(cell);
  });
  head.appendChild(headerRow);
  const body = document.createElement('tbody');
  body.replaceChildren(...breakdown.rows.map(row => hourlyAnalysisTableRow(isHierarchy ? [
    row.label,
    formatHourlyTableQuantity(row.averageUnits),
    formatClp(row.averageNetSales),
    `${formatHourlyTableQuantity(row.unitShare)}%`,
    `${formatHourlyTableQuantity(row.salesShare)}%`,
    row.unitCoefficientOfVariation === null ? '—' : `${formatHourlyTableQuantity(row.unitCoefficientOfVariation)}%`,
    `${formatHourlyTableQuantity(row.unitTrend.estimatedChangePercent)}%`,
    new Intl.NumberFormat('es-CL').format(row.anomalyCount),
    row.strongestInterval || '—'
  ] : [
    row.code || '—', row.label, row.hierarchy || 'Sin jerarquía',
    formatHourlyTableQuantity(row.averageUnits),
    formatClp(row.averageNetSales),
    `${formatHourlyTableQuantity(row.unitShare)}%`,
    `${formatHourlyTableQuantity(row.salesShare)}%`,
    row.unitCoefficientOfVariation === null ? '—' : `${formatHourlyTableQuantity(row.unitCoefficientOfVariation)}%`,
    `${formatHourlyTableQuantity(row.unitTrend.estimatedChangePercent)}%`,
    new Intl.NumberFormat('es-CL').format(row.anomalyCount),
    row.strongestInterval || '—'
  ], isHierarchy ? 1 : 3)));
  table.append(head, body);
  wrap.appendChild(table);
  section.append(detailHeading, wrap);
  return section;
}

function renderHourlyAnalysisBreakdowns(report) {
  const container = document.getElementById('hourly-analysis-breakdowns');
  container.replaceChildren(...[report.breakdowns?.hierarchies, report.breakdowns?.products]
    .filter(Boolean)
    .map(renderHourlyAnalysisBreakdown));
}

function renderHourlyAnalysis(report) {
  hourlyAnalysisState = report;
  const dates = report.selectedDates || [];
  const levelLabel = report.analysisLevel === 'product'
    ? 'General + jerarquías + productos'
    : report.analysisLevel === 'hierarchy' ? 'General + jerarquías' : 'Nivel general';
  document.getElementById('hourly-analysis-context').textContent = dates.length
    ? `${report.scope.label} · ${report.selection.label} · ${levelLabel} · ${formatReportDate(dates[0])} – ${formatReportDate(dates.at(-1))} · ${report.sampleSize} día(s) con ventas`
    : `${report.scope.label} · ${report.selection.label} · ${levelLabel} · Sin días con ventas para los filtros seleccionados`;
  const metricDefinitions = [
    ['Promedio diario', `${formatHourlyTableQuantity(report.metrics.averageUnits)} unidades`],
    ['Facturación promedio', formatClp(report.metrics.averageNetSales)],
    ['Variación unidades', report.metrics.unitCoefficientOfVariation === null ? 'Sin base' : `${formatHourlyTableQuantity(report.metrics.unitCoefficientOfVariation)}% CV`],
    ['Variación facturación', report.metrics.salesCoefficientOfVariation === null ? 'Sin base' : `${formatHourlyTableQuantity(report.metrics.salesCoefficientOfVariation)}% CV`],
    ['Días atípicos', new Intl.NumberFormat('es-CL').format(report.metrics.anomalyCount)],
    ['Franja más intensa', report.metrics.strongestInterval || 'Sin datos']
  ];
  document.getElementById('hourly-analysis-metrics').replaceChildren(...metricDefinitions.map(([label, value]) => {
    const item = document.createElement('article');
    const caption = document.createElement('span');
    const strong = document.createElement('strong');
    caption.textContent = label;
    strong.textContent = value;
    item.append(caption, strong);
    return item;
  }));
  document.getElementById('hourly-analysis-executive').replaceChildren(...report.executiveSummary.map(textValue => {
    const paragraph = document.createElement('p');
    paragraph.textContent = textValue;
    return paragraph;
  }));
  const findings = document.getElementById('hourly-analysis-findings');
  if (!report.findings.length) {
    const empty = document.createElement('p');
    empty.className = 'sales-service-mode-empty';
    empty.textContent = 'No fue posible generar hallazgos con los datos disponibles.';
    findings.replaceChildren(empty);
  } else findings.replaceChildren(...report.findings.map((finding, index) => {
    const card = document.createElement('article');
    card.className = `hourly-analysis-finding priority-${finding.priority}`;
    const heading = document.createElement('div');
    heading.className = 'hourly-analysis-finding-head';
    const number = document.createElement('span');
    number.className = 'hourly-analysis-finding-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const titleWrap = document.createElement('div');
    const category = document.createElement('span');
    category.className = 'hourly-analysis-category';
    category.textContent = finding.category;
    const title = document.createElement('h4');
    title.textContent = finding.title;
    titleWrap.append(category, title);
    const priority = document.createElement('span');
    priority.className = `hourly-analysis-priority ${finding.priority}`;
    priority.textContent = finding.priority === 'high' ? 'Prioridad alta' : finding.priority === 'medium' ? 'Revisar' : 'Informativo';
    heading.append(number, titleWrap, priority);
    const conclusion = document.createElement('p');
    conclusion.className = 'hourly-analysis-conclusion';
    conclusion.textContent = finding.conclusion;
    const evidence = document.createElement('p');
    evidence.className = 'hourly-analysis-evidence';
    evidence.textContent = `Evidencia: ${finding.evidence || 'Conclusión descriptiva basada en la muestra seleccionada.'}`;
    card.append(heading, conclusion, evidence);
    for (const [label, entries, className] of [
      ['Explicaciones posibles', finding.possibleExplanations, 'hypotheses'],
      ['Preguntas para investigar', finding.questions, 'questions']
    ]) {
      if (!entries?.length) continue;
      const block = document.createElement('div');
      block.className = `hourly-analysis-followup ${className}`;
      const subtitle = document.createElement('strong');
      subtitle.textContent = label;
      const list = document.createElement('ul');
      entries.forEach(entry => {
        const item = document.createElement('li');
        item.textContent = entry;
        list.appendChild(item);
      });
      block.append(subtitle, list);
      card.appendChild(block);
    }
    return card;
  }));
  renderHourlyAnalysisBreakdowns(report);
  document.getElementById('hourly-analysis-daily-body').replaceChildren(...report.appendix.daily.map(item => hourlyAnalysisTableRow([
    formatReportDate(item.date),
    item.weekday,
    formatHourlyTableQuantity(item.units),
    formatClp(item.netSales),
    formatClp(item.revenuePerUnit),
    `${formatHourlyTableQuantity(item.unitZScore)}σ`,
    `${formatHourlyTableQuantity(item.salesZScore)}σ`
  ], 2)));
  document.getElementById('hourly-analysis-bucket-body').replaceChildren(...report.appendix.buckets.map(item => hourlyAnalysisTableRow([
    item.label,
    formatHourlyTableQuantity(item.unitStats.mean),
    hourlyMinMaxLabel(item.unitStats.min, item.unitStats.max),
    formatHourlyTableQuantity(item.unitStats.standardDeviation),
    item.unitStats.coefficientOfVariation === null ? '—' : `${formatHourlyTableQuantity(item.unitStats.coefficientOfVariation)}%`,
    formatClp(item.salesStats.mean),
    hourlySalesMinMaxLabel(item.salesStats.min, item.salesStats.max),
    formatClp(item.salesStats.standardDeviation),
    item.salesStats.coefficientOfVariation === null ? '—' : `${formatHourlyTableQuantity(item.salesStats.coefficientOfVariation)}%`,
    `${formatHourlyTableQuantity(item.unitShare)}% un. · ${formatHourlyTableQuantity(item.salesShare)}% venta`
  ])));
  document.getElementById('hourly-analysis-weekday-body').replaceChildren(...report.appendix.weekdays.map(item => hourlyAnalysisTableRow([
    item.label,
    new Intl.NumberFormat('es-CL').format(item.sampleSize),
    formatHourlyTableQuantity(item.units.mean),
    formatClp(item.netSales.mean),
    formatClp(item.revenuePerUnit)
  ])));
  const methodology = document.getElementById('hourly-analysis-methodology');
  const methodologyTitle = document.createElement('strong');
  methodologyTitle.textContent = 'Metodología y límites';
  const methodologyList = document.createElement('ul');
  report.appendix.methodology.forEach(textValue => {
    const item = document.createElement('li');
    item.textContent = textValue;
    methodologyList.appendChild(item);
  });
  methodology.replaceChildren(methodologyTitle, methodologyList);
}

function openHourlyAnalysisOptions() {
  const dialog = document.getElementById('hourly-analysis-options-dialog');
  if (!dialog.open) dialog.showModal();
}

async function loadHourlyAnalysis(analysisLevel = 'general') {
  const dialog = document.getElementById('hourly-analysis-dialog');
  const optionsDialog = document.getElementById('hourly-analysis-options-dialog');
  const status = document.getElementById('hourly-analysis-status');
  const button = document.getElementById('generate-hourly-analysis');
  const params = new URLSearchParams({
    location: document.getElementById('sales-dashboard-location').value || 'all',
    mode: document.getElementById('hourly-demand-mode').value,
    date: document.getElementById('hourly-demand-date').value,
    days: document.getElementById('hourly-demand-days').value,
    interval: document.getElementById('hourly-demand-interval').value,
    hierarchyPath: JSON.stringify(hourlySalesHierarchyPath),
    productKey: hourlySalesProductKey || '',
    analysisLevel
  });
  if (optionsDialog.open) optionsDialog.close();
  if (!dialog.open) dialog.showModal();
  button.disabled = true;
  setStatus(status, 'Analizando tendencias, dispersión, anomalías y participación horaria…');
  try {
    const report = await apiRequest(`/api/sales/hourly-analysis?${params}`);
    renderHourlyAnalysis(report);
    const additionalFindings = (report.breakdowns?.hierarchies?.findings.length || 0)
      + (report.breakdowns?.products?.findings.length || 0);
    setStatus(status, report.sampleSize
      ? `Análisis completo: ${report.sampleSize} día(s), ${report.findings.length + additionalFindings} resultado(s) priorizado(s).`
      : 'No hay ventas suficientes para elaborar el reporte con estos filtros.', report.sampleSize ? 'success' : 'error');
  } catch (error) {
    hourlyAnalysisState = null;
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function printHourlyAnalysis() {
  if (!hourlyAnalysisState) return;
  document.body.classList.add('printing-hourly-analysis');
  setTimeout(() => {
    window.print();
    document.body.classList.remove('printing-hourly-analysis');
  }, 50);
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
  const periodKey = document.getElementById('sales-service-mode-period').value;
  const dateFrom = document.getElementById('sales-service-mode-from').value;
  const dateTo = document.getElementById('sales-service-mode-to').value;
  if (periodKey === 'custom' && (!dateFrom || !dateTo || dateFrom > dateTo)) {
    setStatus(document.getElementById('sales-service-mode-status'), 'Selecciona un rango de fechas válido.', 'error');
    return;
  }
  button.disabled = true;
  setStatus(status, 'Calculando indicadores de ventas y recurrencia…');
  try {
    const params = new URLSearchParams({ location });
    if (periodKey === 'custom') {
      params.set('serviceDateFrom', dateFrom);
      params.set('serviceDateTo', dateTo);
    }
    const report = await apiRequest(`/api/sales/dashboard?${params}`);
    if (location !== select.value) return;
    salesDashboardState = report;
    salesHierarchyPath = [];
    const customFrom = document.getElementById('sales-service-mode-from');
    const customTo = document.getElementById('sales-service-mode-to');
    customFrom.max = report.date;
    customTo.max = report.date;
    if (!customTo.value) customTo.value = report.date;
    if (!customFrom.value) customFrom.value = offsetIsoDate(report.date, -29);
    syncSalesServiceModeControls();
    document.getElementById('sales-dashboard-description').textContent = `Venta neta sin IVA para ${report.scope.label}. Indicadores al ${formatReportDate(report.date)}.`;
    renderSalesDashboardMetrics(report.sales.metrics);
    renderSalesLocations(report);
    renderSalesServiceModes();
    renderSalesInsights();
    renderMercadoPago(report);
    document.getElementById('hourly-demand-date').value = report.date;
    loadHourlySalesDemand();
    const sourceText = `${report.sales.filesRead} archivo(s) de ventas, ${report.sales.serviceModes.paymentDetailsFilesRead} archivo(s) de Detalle Pagos y ${report.mercadoPago.filesRead} archivo(s) MercadoPago procesado(s).`;
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

function costSourceDescription(item) {
  if (item?.costSource === 'purchase') {
    return `Última compra${item.costSourceDate ? ` · ${formatReportDate(item.costSourceDate)}` : ''}`;
  }
  if (item?.costSource === 'master') return 'Costo del maestro vigente (sin compra anterior comparable)';
  return 'Sin costo de compra ni costo maestro compatible';
}

function costSourceShort(item) {
  if (item?.costSource === 'purchase') return `Compra${item.costSourceDate ? ` ${formatReportDate(item.costSourceDate)}` : ''}`;
  if (item?.costSource === 'master') return 'Maestro';
  return 'Sin costo';
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
  const indicator = sortState.key === key ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
  const headerLines = cell.dataset.headerLines?.split('|');
  if (headerLines?.length) {
    cell.replaceChildren();
    headerLines.forEach((line, index) => {
      if (index) cell.appendChild(document.createElement('br'));
      cell.appendChild(document.createTextNode(line));
    });
    if (indicator) cell.appendChild(document.createTextNode(indicator));
  } else {
    cell.textContent = `${label}${indicator}`;
  }
  cell.setAttribute('aria-sort', sortState.key === key ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
}

function productTableNode(products) {
  const wrap = document.createElement('div');
  wrap.className = 'products-table-wrap';
  const table = document.createElement('table');
  table.className = 'products-table';
  const headers = [
    ['code', 'Código'], ['name', 'Producto'], ['price', 'Precio venta'], ['netPrice', 'Precio venta neto'],
    ['cost', 'Costo aplicado'], ['marginPercent', 'Margen'], ['averageWeeklyUnits8', 'Prom. semanal 8 sem.'],
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
  for (const product of sortRows(products, productsSort)) {
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
      if (index === 4) cell.title = costSourceDescription(product);
      if (index === 2 && product.previousPrice !== null && product.previousPrice !== undefined) {
        const previous = document.createElement('span');
        previous.className = 'product-previous-price';
        previous.textContent = `(ant. ${formatClp(product.previousPrice)})`;
        cell.append(previous, document.createTextNode(value));
      } else cell.textContent = value;
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
  return wrap;
}

function productHierarchyNodes(groups, { queryActive = false, openAll = false } = {}) {
  return groups.map((group, groupIndex) => {
    const details = document.createElement('details');
    details.className = 'product-hierarchy-group';
    details.open = openAll || queryActive || groupIndex < 3;
    const heading = document.createElement('summary');
    const path = document.createElement('strong');
    path.textContent = group.path.join(' › ');
    const count = document.createElement('span');
    count.textContent = `${group.products.length} producto(s)`;
    heading.append(path, count);
    const wrap = productTableNode(group.products);
    details.append(heading, wrap);
    return details;
  });
}

function allProductsNode(products) {
  const section = document.createElement('section');
  section.className = 'product-hierarchy-group products-all-group';
  const heading = document.createElement('div');
  heading.className = 'products-all-heading';
  const title = document.createElement('strong');
  title.textContent = 'Todos los productos';
  const count = document.createElement('span');
  count.textContent = `${products.length} producto(s)`;
  heading.append(title, count);
  section.append(heading, productTableNode(products));
  return section;
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
  const grouping = document.getElementById('products-grouping').value;
  const uniqueProducts = [...new Map(groups.flatMap(group => group.products)
    .map(product => [product.code || product.name, product])).values()];
  const visibleCount = grouping === 'all'
    ? uniqueProducts.length
    : groups.reduce((sum, group) => sum + group.products.length, 0);
  const summaryTexts = [
    `${visibleCount} de ${productsViewState.productCount} productos`,
    grouping === 'all' ? 'Vista: todos juntos' : `${groups.length} jerarquías`,
    `Últimos 7 días: ${formatReportDate(productsViewState.periods.last7.from)} – ${formatReportDate(productsViewState.periods.last7.to)}`,
    `Promedio 8 semanas: 56 días ÷ 8`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  const nodes = !groups.length
    ? []
    : grouping === 'all'
      ? [allProductsNode(uniqueProducts)]
      : productHierarchyNodes(groups, { queryActive: Boolean(query) });
  container.replaceChildren(...nodes);
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No hay productos que coincidan con la búsqueda.';
    container.appendChild(empty);
  }
}

function relevantProductGroups() {
  if (!productsViewState) return [];
  return productsViewState.hierarchies
    .map(group => ({
      ...group,
      products: group.products.filter(product => product.averageWeeklyUnits8 >= 5
        && product.unitsChangePercent !== null
        && Math.abs(product.unitsChangePercent) > 20)
    }))
    .filter(group => group.products.length);
}

function renderRelevantProductsReport() {
  const groups = relevantProductGroups();
  const container = document.getElementById('relevant-products-hierarchy-list');
  const summary = document.getElementById('relevant-products-summary');
  const count = groups.reduce((sum, group) => sum + group.products.length, 0);
  document.getElementById('print-relevant-products-report').disabled = count === 0;
  document.getElementById('export-relevant-products-report').disabled = count === 0;
  const priceReference = productsViewState?.priceReference;
  document.getElementById('relevant-products-description').textContent =
    `Productos con promedio semanal de al menos 5 unidades y variación absoluta superior a 20%. ${priceReference
      ? `Los precios anteriores corresponden al reporte guardado del ${formatReportDate(priceReference.date)}.`
      : 'No existe un reporte anterior del mismo alcance dentro de los últimos 30 días; no se muestran precios anteriores.'}`;
  const summaryTexts = [
    `${count} producto(s) relevante(s)`,
    `${groups.length} jerarquía(s)`,
    `Promedio mínimo: 5,0 unidades`,
    `Variación: superior a ±20,0%`
  ];
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  container.replaceChildren(...productHierarchyNodes(groups, { openAll: true }));
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'form-status muted';
    empty.textContent = 'No hay productos que cumplan ambos criterios.';
    container.appendChild(empty);
  }
}

function openRelevantProductsReport() {
  if (!productsViewState) return;
  renderRelevantProductsReport();
  document.getElementById('relevant-products-dialog').showModal();
}

function printRelevantProductsReport() {
  if (!relevantProductGroups().length) return;
  const dialog = document.getElementById('relevant-products-dialog');
  const previousTitle = document.title;
  document.title = `Cambios Relevantes - ${productsViewState.scope.label}`;
  document.body.classList.add('printing-relevant-products');
  dialog.classList.add('relevant-products-print-target');
  try {
    window.print();
  } finally {
    dialog.classList.remove('relevant-products-print-target');
    document.body.classList.remove('printing-relevant-products');
    document.title = previousTitle;
  }
}

function exportRelevantProductsReport() {
  const groups = relevantProductGroups();
  const status = document.getElementById('products-status');
  if (!groups.length) return;
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const information = XLSX.utils.aoa_to_sheet([
      ['Reporte', 'Cambios Relevantes'],
      ['Cafetería', productsViewState.scope.label],
      ['Fecha', productsViewState.date],
      ['Criterio promedio', 'Promedio semanal últimas 8 semanas >= 5 unidades'],
      ['Criterio variación', 'Variación absoluta últimos 7 días > 20%'],
      ['Referencia de precios', productsViewState.priceReference?.date || 'Sin reporte anterior aplicable'],
      ['Productos incluidos', groups.reduce((sum, group) => sum + group.products.length, 0)],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    const headers = [
      'Jerarquía', 'Código', 'Producto', 'Precio anterior', 'Precio venta', 'Precio venta neto',
      'Costo aplicado', 'Origen costo', 'Fecha costo', 'Margen %', 'Prom. semanal 8 sem.', 'Últimos 7 días',
      'Cambio vs. prom. 8 sem. %'
    ];
    const values = groups.flatMap(group => sortRows(group.products, productsSort).map(product => [
      group.path.join(' › '), product.code, product.name, product.previousPrice,
      product.price, product.netPrice, product.cost,
      product.costSource === 'purchase' ? 'Última compra' : product.costSource === 'master' ? 'Maestro' : 'Sin costo',
      product.costSourceDate,
      product.marginPercent,
      product.averageWeeklyUnits8, product.unitsLast7Days, product.unitsChangePercent
    ]));
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
    sheet['!autofilter'] = { ref: `A1:M${values.length + 1}` };
    sheet['!cols'] = headers.map((header, index) => ({
      wch: index === 0 ? 42 : index === 2 ? 38 : Math.max(12, Math.min(24, header.length + 2))
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, information, 'Información');
    XLSX.utils.book_append_sheet(workbook, sheet, 'Cambios Relevantes');
    writeConfiguredExcelWorkbook(workbook, `cambios-relevantes-${productsViewState.date}.xlsx`);
    setStatus(status, 'Reporte de Cambios Relevantes exportado a Excel correctamente.', 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el reporte: ${error.message}`, 'error');
  }
}

function productAnalysisPresetRange(mode, referenceDate) {
  const monday = value => {
    const date = dateFromKey(value);
    const weekday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - weekday);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const monthStart = `${referenceDate.slice(0, 7)}-01`;
  if (mode === 'current-week') return { from: monday(referenceDate), to: referenceDate };
  if (mode === 'previous-week') {
    const start = monday(referenceDate);
    return { from: offsetIsoDate(start, -7), to: offsetIsoDate(start, -1) };
  }
  if (mode === 'current-month') return { from: monthStart, to: referenceDate };
  if (mode === 'previous-month') {
    const to = offsetIsoDate(monthStart, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  const days = Number(mode.match(/^last-(\d+)-days$/)?.[1]) || 30;
  return { from: offsetIsoDate(referenceDate, -days + 1), to: referenceDate };
}

function syncProductAnalysisPeriod() {
  const mode = document.getElementById('product-analysis-period').value;
  const from = document.getElementById('product-analysis-date-from');
  const to = document.getElementById('product-analysis-date-to');
  const custom = mode === 'custom';
  from.disabled = !custom;
  to.disabled = !custom;
  if (!custom && productAnalysisOptions?.availablePeriod?.to) {
    const range = productAnalysisPresetRange(mode, productAnalysisOptions.availablePeriod.to);
    from.value = range.from;
    to.value = range.to;
  }
}

async function loadProductAnalysisOptions(location) {
  const status = document.getElementById('product-analysis-config-status');
  setStatus(status, 'Leyendo períodos, jerarquías y cobertura disponible…');
  try {
    const options = await apiRequest(`/api/products/analysis/options?location=${encodeURIComponent(location)}`);
    productAnalysisOptions = options;
    const hierarchy = document.getElementById('product-analysis-hierarchy');
    hierarchy.replaceChildren(new Option('Todas las jerarquías', 'all'), ...options.hierarchies.map(item => new Option(item.pathLabel, item.id)));
    syncProductAnalysisPeriod();
    const available = options.availablePeriod;
    setStatus(status, available
      ? `Datos disponibles entre ${formatReportDate(available.from)} y ${formatReportDate(available.to)}. Cobertura de Detalle Pagos: ${Number(options.coverage.paymentMatchPercent || 0).toLocaleString('es-CL', { maximumFractionDigits: 1 })}%.`
      : 'No hay ventas disponibles para esta selección.', available ? 'success' : 'muted');
  } catch (error) {
    productAnalysisOptions = null;
    setStatus(status, error.message, 'error');
  }
}

async function openProductAnalysisConfig() {
  const dialog = document.getElementById('product-analysis-config-dialog');
  const location = document.getElementById('products-location-filter').value || 'all';
  const select = document.getElementById('product-analysis-location');
  const stores = Object.values(locationRegistry).filter(item => item.type === 'store' && item.status !== 'trash');
  select.replaceChildren(new Option('Todas las cafeterías', 'all'), ...stores.map(item => new Option(item.name, item.id)));
  select.value = location;
  dialog.showModal();
  await loadProductAnalysisOptions(location);
}

function productAnalysisElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function productAnalysisFamilyMetric(value, sharePercent, formatter) {
  const metric = productAnalysisElement('span', 'product-analysis-family-metric');
  metric.append(
    productAnalysisElement('span', 'product-analysis-family-value', formatter(value)),
    productAnalysisElement('span', 'product-analysis-family-share', `${Number(sharePercent || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`)
  );
  return metric;
}

function productAnalysisAveragePriceMetric(value, discountPercent, options = {}) {
  const metric = productAnalysisElement('span', 'product-analysis-average-price-metric');
  if (discountPercent !== null && Number.isFinite(Number(discountPercent))) {
    const nonzeroClass = Math.abs(Number(discountPercent)) >= 0.05 ? ' discount-nonzero' : '';
    const discount = productAnalysisElement(options.onClick ? 'button' : 'span', `product-analysis-implicit-discount${options.onClick ? ' product-analysis-discount-button' : ''}${nonzeroClass}`, `(${formatProductAnalysisPercent(discountPercent)})`);
    if (options.onClick) {
      discount.type = 'button';
      discount.title = options.title || 'Ver las transacciones que componen este descuento';
      discount.setAttribute('aria-expanded', 'false');
      if (options.controls) discount.setAttribute('aria-controls', options.controls);
      discount.addEventListener('click', options.onClick);
    }
    metric.appendChild(discount);
  }
  metric.appendChild(productAnalysisElement('span', 'product-analysis-average-price-value', formatClp(value)));
  return metric;
}

function productAnalysisModeLabel(mode) {
  if (mode === 'takeaway') return 'Para llevar';
  if (mode === 'dineIn') return 'Servir en el local';
  return 'Sin información';
}

function productAnalysisSalesAllocationLabel(value) {
  if (value === 'catalog_share') return 'Distribuido por precio de lista';
  if (value === 'scaled_to_order') return 'Ajustado al total del pedido';
  return 'Informado por Toteat';
}

function productAnalysisTimeLabel(hour) {
  const value = Number(hour);
  if (!Number.isFinite(value)) return '—';
  const hours = Math.max(0, Math.min(23, Math.trunc(value)));
  const minutes = Math.max(0, Math.min(59, Math.round((value - hours) * 60)));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function productAnalysisOrderFacts(transaction) {
  const facts = productAnalysisElement('dl', 'product-analysis-order-facts');
  const append = (term, value) => facts.append(productAnalysisElement('dt', '', term), productAnalysisElement('dd', '', value));
  append('Pedido', transaction.orderReference || transaction.orderKey);
  append('Fecha y hora', `${formatReportDate(transaction.date)} · ${productAnalysisTimeLabel(transaction.hour)}`);
  append('Ubicación', transaction.locationName || '—');
  append('Modalidad', productAnalysisModeLabel(transaction.mode));
  append('Clientes informados', Number(transaction.clients || 0).toLocaleString('es-CL'));
  append('Venta neta del pedido', formatClp(transaction.orderNetSales));
  append('Total Detalle Pagos', transaction.paymentDue === null ? 'Sin información' : formatClp(transaction.paymentDue));
  append('Comentario general', transaction.paymentComment || 'Sin comentario');
  return facts;
}

function productAnalysisTransactionsTable(item, familyIndex, itemIndex) {
  const headers = ['Fecha', 'Hora', 'Pedido', 'Ubicación', 'Modalidad', 'Unidades', 'Venta neta producto', 'Precio neto unitario', 'Precio con IVA', 'Descuento'];
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap');
  const table = productAnalysisElement('table', 'product-analysis-table product-analysis-transactions-table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  headers.forEach((header, index) => head.appendChild(productAnalysisElement('th', index >= 5 ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');
  item.transactions.forEach((transaction, transactionIndex) => {
    const detailId = `order-detail-${familyIndex}-${itemIndex}-${transactionIndex}`;
    const row = document.createElement('tr');
    row.append(
      productAnalysisElement('td', '', formatReportDate(transaction.date)),
      productAnalysisElement('td', '', productAnalysisTimeLabel(transaction.hour))
    );
    const orderCell = document.createElement('td');
    const orderButton = productAnalysisElement('button', 'product-analysis-order-button', transaction.orderReference || transaction.orderKey);
    orderButton.type = 'button';
    orderButton.title = `Ver el detalle completo del pedido ${transaction.orderReference || transaction.orderKey}`;
    orderButton.setAttribute('aria-expanded', 'false');
    orderButton.setAttribute('aria-controls', detailId);
    orderCell.appendChild(orderButton);
    row.append(
      orderCell,
      productAnalysisElement('td', '', transaction.locationName || '—'),
      productAnalysisElement('td', '', productAnalysisModeLabel(transaction.mode)),
      productAnalysisElement('td', 'numeric-cell', formatProductAnalysisUnits(transaction.quantity)),
      productAnalysisElement('td', 'numeric-cell', formatClp(transaction.netSales)),
      productAnalysisElement('td', 'numeric-cell', formatClp(transaction.averageNetPrice)),
      productAnalysisElement('td', 'numeric-cell', formatClp(transaction.averageGrossPrice)),
      productAnalysisElement('td', 'numeric-cell', transaction.implicitDiscountPercent === null ? '—' : formatProductAnalysisPercent(transaction.implicitDiscountPercent))
    );

    const detailRow = document.createElement('tr');
    detailRow.id = detailId;
    detailRow.className = 'product-analysis-order-detail-row';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = headers.length;
    const detail = productAnalysisElement('div', 'product-analysis-order-detail');
    detail.append(
      productAnalysisElement('h6', '', `Detalle completo del pedido ${transaction.orderReference || transaction.orderKey}`),
      productAnalysisOrderFacts(transaction),
      productAnalysisElement('h6', 'product-analysis-order-lines-title', 'Productos y extras del pedido'),
      productAnalysisTable(
        ['Código', 'Producto / extra', 'Tipo', 'Jerarquía', 'Cantidad', 'Venta neta', 'Origen valor', 'Precio neto unitario', 'Precio con IVA', 'Descuento'],
        (transaction.orderLines || []).map(line => [
          line.code,
          line.name,
          line.type,
          line.hierarchy || '—',
          formatProductAnalysisUnits(line.quantity),
          formatClp(line.netSales),
          productAnalysisSalesAllocationLabel(line.salesAllocation),
          formatClp(line.averageNetPrice),
          formatClp(line.averageGrossPrice),
          line.implicitDiscountPercent === null ? '—' : formatProductAnalysisPercent(line.implicitDiscountPercent)
        ]),
        { className: 'product-analysis-order-lines-table', empty: 'No hay líneas disponibles para este pedido.' }
      )
    );
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    orderButton.addEventListener('click', () => {
      const opening = detailRow.hidden;
      detailRow.hidden = !opening;
      orderButton.setAttribute('aria-expanded', String(opening));
      row.classList.toggle('order-detail-open', opening);
    });
    tbody.append(row, detailRow);
  });
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function productAnalysisFormatsTable(family, familyIndex) {
  const headers = ['Código', 'Formato detectado', 'Producto', 'Precio lista', 'Precio neto', 'Unidades', 'Venta neta', 'Precio promedio'];
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap');
  const table = productAnalysisElement('table', 'product-analysis-table product-analysis-format-table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  headers.forEach((header, index) => head.appendChild(productAnalysisElement('th', index >= 3 ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');

  family.formats.forEach((item, itemIndex) => {
    const detailId = `format-transactions-${familyIndex}-${itemIndex}`;
    const row = document.createElement('tr');
    const detailRow = document.createElement('tr');
    detailRow.id = detailId;
    detailRow.className = 'product-analysis-transaction-detail-row';
    detailRow.hidden = true;
    const discountMetric = productAnalysisAveragePriceMetric(item.averagePrice, item.implicitDiscountPercent, {
      controls: detailId,
      title: `Ver ${item.transactions.length} transacción(es) de ${item.name}`,
      onClick: event => {
        const opening = detailRow.hidden;
        detailRow.hidden = !opening;
        event.currentTarget.setAttribute('aria-expanded', String(opening));
        row.classList.toggle('transaction-detail-open', opening);
      }
    });
    const unitsCell = productAnalysisElement('td', 'numeric-cell');
    unitsCell.appendChild(productAnalysisFamilyMetric(item.units, item.familyUnitSharePercent, formatProductAnalysisUnits));
    const salesCell = productAnalysisElement('td', 'numeric-cell');
    salesCell.appendChild(productAnalysisFamilyMetric(item.netSales, item.familySalesSharePercent, formatClp));
    const averagePriceCell = productAnalysisElement('td', 'numeric-cell');
    averagePriceCell.appendChild(discountMetric);
    row.append(
      productAnalysisElement('td', 'product-analysis-row-label', item.code),
      productAnalysisElement('td', '', item.format),
      productAnalysisElement('td', '', item.name),
      productAnalysisElement('td', 'numeric-cell', formatClp(item.listPrice)),
      productAnalysisElement('td', 'numeric-cell', formatClp(item.netListPrice)),
      unitsCell,
      salesCell,
      averagePriceCell
    );
    const detailCell = document.createElement('td');
    detailCell.colSpan = headers.length;
    const detail = productAnalysisElement('div', 'product-analysis-transaction-detail');
    detail.append(
      productAnalysisElement('h5', '', `Transacciones de ${item.name}`),
      productAnalysisElement('p', 'panel-description', `${item.transactions.length} transacción(es). El descuento se compara con el precio neto de lista y se calcula para cada venta.`),
      productAnalysisTransactionsTable(item, familyIndex, itemIndex)
    );
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    tbody.append(row, detailRow);
  });
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function formatProductAnalysisUnits(value) {
  return Number(value || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatProductAnalysisPercent(value) {
  return `${Number(value || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function productAnalysisValueIsNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value && typeof value === 'object' && value.nodeType) {
    if (value.classList?.contains('product-analysis-family-metric')
      || value.classList?.contains('product-analysis-average-price-metric')) return true;
    return productAnalysisValueIsNumeric(value.textContent);
  }
  const text = String(value ?? '').trim();
  if (!text || text === '—') return false;
  return /^-?\$?\s*\d[\d.]*?(?:,\d+)?%?$/.test(text);
}

function productAnalysisTable(headers, rows, options = {}) {
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap');
  const table = productAnalysisElement('table', `product-analysis-table ${options.className || ''}`);
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  const numericColumns = headers.map((header, index) => {
    const values = rows.map(row => row[index]).filter(value => value !== null && value !== undefined && value !== '—');
    return values.length > 0 && values.filter(productAnalysisValueIsNumeric).length / values.length >= 0.5;
  });
  headers.forEach((header, index) => head.appendChild(productAnalysisElement('th', numericColumns[index] ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');
  rows.forEach(values => {
    const row = document.createElement('tr');
    values.forEach((value, index) => {
      const classes = [index === 0 ? 'product-analysis-row-label' : '', numericColumns[index] ? 'numeric-cell' : ''].filter(Boolean).join(' ');
      const cell = productAnalysisElement('td', classes);
      if (value && typeof value === 'object' && value.nodeType) cell.appendChild(value);
      else cell.textContent = value ?? '—';
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = productAnalysisElement('td', 'product-analysis-empty', options.empty || 'No hay datos suficientes para esta sección.');
    cell.colSpan = headers.length;
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function productAnalysisIngredientsTable(items) {
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap product-analysis-ingredients-wrap');
  const table = productAnalysisElement('table', 'product-analysis-table product-analysis-ingredients-table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  ['Código', 'Ingrediente principal', 'Productos asociados', 'Unidades producto', 'Venta neta asociada', 'Part. venta']
    .forEach((header, index) => head.appendChild(productAnalysisElement('th', index >= 2 ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');
  items.forEach((item, index) => {
    const row = document.createElement('tr');
    row.append(
      productAnalysisElement('td', 'product-analysis-row-label', item.code),
      productAnalysisElement('td', '', item.name)
    );
    const countCell = productAnalysisElement('td', 'numeric-cell');
    const button = productAnalysisElement('button', 'product-analysis-associated-button', `${item.productCount} ▾`);
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `ingredient-products-${index}`);
    button.title = `Ver los ${item.productCount} producto(s) asociados a ${item.name}`;
    countCell.appendChild(button);
    row.append(
      countCell,
      productAnalysisElement('td', 'numeric-cell', formatProductAnalysisUnits(item.units)),
      productAnalysisElement('td', 'numeric-cell', formatClp(item.netSales)),
      productAnalysisElement('td', 'numeric-cell', formatProductAnalysisPercent(item.salesShare))
    );
    const detailRow = document.createElement('tr');
    detailRow.id = `ingredient-products-${index}`;
    detailRow.className = 'product-analysis-ingredient-detail-row';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = 6;
    const detail = productAnalysisElement('div', 'product-analysis-ingredient-detail');
    detail.append(
      productAnalysisElement('h5', '', `Productos asociados a ${item.name}`),
      productAnalysisElement('p', 'panel-description', `${item.productCount} producto(s), ordenados por venta neta asociada.`),
      productAnalysisTable(
        ['Código', 'Producto', 'Unidades', 'Pedidos', 'Precio promedio', 'Venta neta', '% unidades', '% venta'],
        item.products.map(product => [
          product.code,
          product.name,
          formatProductAnalysisUnits(product.units),
          product.orderCount.toLocaleString('es-CL'),
          formatClp(product.averagePrice),
          formatClp(product.netSales),
          formatProductAnalysisPercent(product.ingredientUnitSharePercent),
          formatProductAnalysisPercent(product.ingredientSalesSharePercent)
        ]),
        { className: 'product-analysis-ingredient-products-table' }
      )
    );
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    button.addEventListener('click', () => {
      const opening = detailRow.hidden;
      detailRow.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
      button.textContent = `${item.productCount} ${opening ? '▴' : '▾'}`;
      row.classList.toggle('ingredient-detail-open', opening);
    });
    tbody.append(row, detailRow);
  });
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function productAnalysisPriceObservationsTable(item, itemIndex) {
  const headers = ['Fecha', 'Unidades', 'Venta neta', 'Precio neto promedio', 'Precio con IVA', 'Descuento vs. lista neta'];
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap');
  const table = productAnalysisElement('table', 'product-analysis-table product-analysis-price-observations-table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  headers.forEach((header, index) => head.appendChild(productAnalysisElement('th', index >= 1 ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');

  (item.observationDetails || []).forEach((observation, observationIndex) => {
    const detailId = `price-day-transactions-${itemIndex}-${observationIndex}`;
    const row = document.createElement('tr');
    row.append(
      productAnalysisElement('td', 'product-analysis-row-label', formatReportDate(observation.date)),
      productAnalysisElement('td', 'numeric-cell', formatProductAnalysisUnits(observation.units)),
      productAnalysisElement('td', 'numeric-cell', formatClp(observation.netSales)),
      productAnalysisElement('td', 'numeric-cell', formatClp(observation.averageNetPrice)),
      productAnalysisElement('td', 'numeric-cell', formatClp(observation.averageGrossPrice))
    );
    const discountCell = productAnalysisElement('td', 'numeric-cell');
    if (observation.implicitDiscountPercent === null) {
      discountCell.textContent = '—';
      row.appendChild(discountCell);
      tbody.appendChild(row);
      return;
    }

    const nonzeroClass = Math.abs(Number(observation.implicitDiscountPercent)) >= 0.05 ? ' discount-nonzero' : '';
    const discountButton = productAnalysisElement('button', `product-analysis-daily-discount-button${nonzeroClass}`, formatProductAnalysisPercent(observation.implicitDiscountPercent));
    discountButton.type = 'button';
    discountButton.title = `Ver ${observation.transactions?.length || 0} transacción(es) de ${formatReportDate(observation.date)}`;
    discountButton.setAttribute('aria-expanded', 'false');
    discountButton.setAttribute('aria-controls', detailId);
    discountCell.appendChild(discountButton);
    row.appendChild(discountCell);

    const detailRow = document.createElement('tr');
    detailRow.id = detailId;
    detailRow.className = 'product-analysis-daily-transactions-row';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = headers.length;
    const detail = productAnalysisElement('div', 'product-analysis-daily-transactions-detail');
    detail.append(
      productAnalysisElement('h6', '', `Transacciones de ${item.name} · ${formatReportDate(observation.date)}`),
      productAnalysisElement('p', 'panel-description', `${observation.transactions?.length || 0} pedido(s) forman el precio neto promedio y el descuento de este día.`),
      productAnalysisTransactionsTable({ name: item.name, transactions: observation.transactions || [] }, `price-${itemIndex}`, observationIndex)
    );
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    discountButton.addEventListener('click', () => {
      const opening = detailRow.hidden;
      detailRow.hidden = !opening;
      discountButton.setAttribute('aria-expanded', String(opening));
      row.classList.toggle('daily-transactions-open', opening);
    });
    tbody.append(row, detailRow);
  });

  if (!(item.observationDetails || []).length) {
    const row = document.createElement('tr');
    const cell = productAnalysisElement('td', 'product-analysis-empty', 'No hay detalle disponible para estas observaciones.');
    cell.colSpan = headers.length;
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function productAnalysisPriceSensitivityTable(items) {
  const headers = ['Código', 'Producto', 'Observaciones', 'Niveles de precio', 'Rango', 'Coef. observado', 'R²', 'Confianza'];
  const wrapper = productAnalysisElement('div', 'product-analysis-table-wrap product-analysis-price-sensitivity-wrap');
  const table = productAnalysisElement('table', 'product-analysis-table product-analysis-price-sensitivity-table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  headers.forEach((header, index) => head.appendChild(productAnalysisElement('th', index >= 2 && index <= 6 ? 'numeric-cell' : '', header)));
  thead.appendChild(head);
  const tbody = document.createElement('tbody');

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    row.append(
      productAnalysisElement('td', 'product-analysis-row-label', item.code),
      productAnalysisElement('td', '', item.name)
    );
    const observationsCell = productAnalysisElement('td', 'numeric-cell');
    const button = productAnalysisElement('button', 'product-analysis-associated-button product-analysis-observation-button', `${item.observations} ▾`);
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `price-observations-${index}`);
    button.title = `Ver las ${item.observations} observaciones utilizadas para ${item.name}`;
    observationsCell.appendChild(button);
    row.append(
      observationsCell,
      productAnalysisElement('td', 'numeric-cell', item.pricePoints.toLocaleString('es-CL')),
      productAnalysisElement('td', 'numeric-cell', formatProductAnalysisPercent(item.priceRangePercent)),
      productAnalysisElement('td', 'numeric-cell', item.observedElasticity.toLocaleString('es-CL')),
      productAnalysisElement('td', 'numeric-cell', item.rSquared.toLocaleString('es-CL')),
      productAnalysisElement('td', '', item.confidence)
    );

    const detailRow = document.createElement('tr');
    detailRow.id = `price-observations-${index}`;
    detailRow.className = 'product-analysis-observation-detail-row';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = headers.length;
    const detail = productAnalysisElement('div', 'product-analysis-observation-detail');
    detail.append(
      productAnalysisElement('h5', '', `Observaciones de ${item.name}`),
      productAnalysisElement('p', 'panel-description', 'Cada fila es un día incluido en la regresión. Los precios son promedios ponderados por las unidades vendidas.'),
      productAnalysisPriceObservationsTable(item, index)
    );
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    button.addEventListener('click', () => {
      const opening = detailRow.hidden;
      detailRow.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
      button.textContent = `${item.observations} ${opening ? '▴' : '▾'}`;
      row.classList.toggle('observation-detail-open', opening);
    });
    tbody.append(row, detailRow);
  });

  if (!items.length) {
    const row = document.createElement('tr');
    const cell = productAnalysisElement('td', 'product-analysis-empty', 'Ningún producto cumple simultáneamente los mínimos de muestra y variación de precio.');
    cell.colSpan = headers.length;
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function productAnalysisSection(id, eyebrow, title, description = '') {
  const section = productAnalysisElement('section', 'product-analysis-section');
  section.id = `product-analysis-${id}`;
  section.append(productAnalysisElement('div', 'panel-eyebrow', eyebrow), productAnalysisElement('h4', '', title));
  if (description) section.appendChild(productAnalysisElement('p', 'panel-description', description));
  return section;
}

function analysisImpactLabel(value) {
  return value === 'alto' ? 'ALTO' : value === 'medio' ? 'MEDIO' : value === 'bajo' ? 'BAJO' : 'INFORMATIVO';
}

function renderProductAnalysis() {
  const report = productAnalysisState;
  if (!report) return;
  const content = document.getElementById('product-analysis-content');
  const nav = document.getElementById('product-analysis-nav');
  document.getElementById('product-analysis-description').textContent =
    `${report.scope.locationLabel} · ${report.scope.hierarchyLabel} · ${formatReportDate(report.period.from)} – ${formatReportDate(report.period.to)} · comparación ${formatReportDate(report.period.previousFrom)} – ${formatReportDate(report.period.previousTo)}.`;
  const sections = [];
  const register = (id, label, section) => { sections.push({ id, label, section }); return section; };

  const executive = register('executive', 'Resumen', productAnalysisSection('executive', 'Resumen ejecutivo', 'Qué merece atención', 'Las conclusiones están ordenadas por impacto y acompañadas por su nivel de confianza.'));
  const metrics = productAnalysisElement('div', 'product-analysis-metrics');
  [
    ['Venta neta', formatClp(report.summary.netSales)],
    ['Unidades', formatProductAnalysisUnits(report.summary.units)],
    ['Pedidos', Number(report.summary.orders).toLocaleString('es-CL')],
    ['Ticket promedio', formatClp(report.summary.averageTicket)],
    ['Margen estimado', report.summary.grossMarginPercent === null ? 'Sin costo suficiente' : formatProductAnalysisPercent(report.summary.grossMarginPercent)],
    ['Hallazgos de alto impacto', String(report.summary.highImpactCount)]
  ].forEach(([label, value]) => {
    const card = productAnalysisElement('div', 'product-analysis-metric');
    card.append(productAnalysisElement('span', '', label), productAnalysisElement('strong', '', value));
    metrics.appendChild(card);
  });
  executive.appendChild(metrics);
  const findingList = productAnalysisElement('div', 'product-analysis-findings');
  report.findings.forEach(finding => {
    const item = productAnalysisElement('article', `product-analysis-finding impact-${finding.impact}`);
    const header = productAnalysisElement('div', 'product-analysis-finding-head');
    header.append(productAnalysisElement('span', `analysis-impact impact-${finding.impact}`, analysisImpactLabel(finding.impact)), productAnalysisElement('span', 'analysis-confidence', `Confianza ${finding.confidence}`));
    item.append(header, productAnalysisElement('h5', '', finding.title), productAnalysisElement('p', '', finding.detail));
    if (finding.evidence?.length) item.appendChild(productAnalysisElement('p', 'analysis-evidence', `Evidencia: ${finding.evidence.join(' · ')}`));
    item.appendChild(productAnalysisElement('p', 'analysis-action', `Acción / pregunta: ${finding.action}`));
    findingList.appendChild(item);
  });
  if (!report.findings.length) findingList.appendChild(productAnalysisElement('p', 'form-status muted', 'No se detectaron señales con evidencia suficiente para destacar.'));
  executive.appendChild(findingList);

  const coverage = register('coverage', 'Cobertura', productAnalysisSection('coverage', 'Calidad de datos', 'Cobertura y límites', 'La confianza del reporte depende de la disponibilidad de pedidos, modalidad, recetas y costos.'));
  coverage.appendChild(productAnalysisTable(['Indicador', 'Valor', 'Lectura'], [
    ['Pedidos analizados', report.coverage.orders.toLocaleString('es-CL'), 'Pedidos con al menos un producto dentro del alcance'],
    ['Días con ventas', report.coverage.openDays.toLocaleString('es-CL'), `${report.period.days} días calendario en el período`],
    ['Detalle Pagos vinculado', formatProductAnalysisPercent(report.coverage.paymentMatchPercent), 'Cobertura para modalidad de consumo'],
    ['Modalidad sin información', formatProductAnalysisPercent(report.coverage.unknownModePercent), 'No se imputa una modalidad cuando el comentario no es concluyente'],
    ['Productos con receta', formatProductAnalysisPercent(report.coverage.recipeCoveragePercent), 'Necesario para análisis de ingredientes'],
    ['Costo desde compra vigente', formatProductAnalysisPercent(report.coverage.purchaseCostCoveragePercent), 'El resto usa maestro o queda sin costo'],
    ['Productos aptos para sensibilidad de precio', report.coverage.priceAnalysisEligibleProducts.toLocaleString('es-CL'), 'Exige muestra y variación mínima de precio']
  ]));

  const portfolio = register('portfolio', 'Portafolio', productAnalysisSection('portfolio', 'Portafolio y Pareto', 'Qué productos explican la venta', 'Clasificación ABC por participación acumulada de venta neta.'));
  portfolio.appendChild(productAnalysisTable(['Código', 'Producto', 'Jerarquía', 'ABC', 'Unidades', 'Venta neta', 'Part.', 'Crec. vs. anterior', 'Margen'], report.portfolio.products.slice(0, 80).map(item => [
    item.code, item.name, item.hierarchy, item.abc,
    formatProductAnalysisUnits(item.units), formatClp(item.netSales), formatProductAnalysisPercent(item.salesShare),
    item.salesGrowthPercent === null ? 'Sin base comparable' : formatProductAnalysisPercent(item.salesGrowthPercent),
    item.marginPercent === null ? 'Sin costo' : formatProductAnalysisPercent(item.marginPercent)
  ])));

  const trends = register('trends', 'Tendencias', productAnalysisSection('trends', 'Tendencias y anomalías', 'Comportamiento a través del período', 'Las anomalías son señales para investigar; no implican por sí mismas un error.'));
  trends.appendChild(productAnalysisTable(['Fecha', 'Unidades', 'Venta neta', 'Señal'], report.trends.daily.map(item => {
    const anomaly = report.trends.anomalies.find(value => value.date === item.date);
    return [formatReportDate(item.date), formatProductAnalysisUnits(item.units), formatClp(item.netSales), anomaly ? `${anomaly.direction} (${anomaly.deviationPercent}%)` : 'Dentro de rango'];
  })));

  const temporal = register('temporal', 'Día y hora', productAnalysisSection('temporal', 'Preferencias por día y horario', 'Cuándo se concentra la demanda', 'Los promedios diarios consideran solo días con ventas de cada día de semana.'));
  temporal.append(productAnalysisTable(['Día', 'Días observados', 'Unidades promedio', 'Venta neta promedio'], report.temporal.weekdays.map(item => [item.label, item.days, formatProductAnalysisUnits(item.averageUnits), formatClp(item.averageNetSales)])), productAnalysisTable(['Hora', 'Unidades', 'Venta neta'], report.temporal.hours.map(item => [item.label, formatProductAnalysisUnits(item.units), formatClp(item.netSales)])));

  const service = register('service', 'Modalidad', productAnalysisSection('service', 'Para llevar, local y sin información', 'Modalidad y ticket promedio', 'La clasificación proviene del Comentario General de Detalle Pagos.'));
  service.appendChild(productAnalysisTable(['Modalidad', 'Pedidos', 'Part. pedidos', 'Venta neta', 'Part. venta neta', 'Ticket promedio'], report.serviceModes.map(item => [item.label, item.orders.toLocaleString('es-CL'), formatProductAnalysisPercent(item.orderShare), formatClp(item.netSales), formatProductAnalysisPercent(item.salesShare), formatClp(item.averageTicket)])));

  const baskets = register('baskets', 'Canastas', productAnalysisSection('baskets', 'Productos que se venden juntos', 'Afinidad de canasta y extras', `Se muestran pares con al menos ${report.baskets.minimumPairOrders} pedidos. Un lift superior a 1 indica una coincidencia mayor a la esperada bajo independencia.`));
  baskets.append(productAnalysisElement('h5', '', 'Pares de productos'), productAnalysisTable(['Producto A', 'Producto B', 'Pedidos', 'Soporte', 'Confianza A→B', 'Confianza B→A', 'Lift'], report.baskets.pairs.slice(0, 40).map(item => [item.leftName, item.rightName, item.orders, formatProductAnalysisPercent(item.supportPercent), formatProductAnalysisPercent(item.confidenceLeftToRightPercent), formatProductAnalysisPercent(item.confidenceRightToLeftPercent), item.lift])));
  baskets.append(productAnalysisElement('h5', '', 'Extras y modificadores'), productAnalysisTable(['Código', 'Extra', 'Pedidos', 'Unidades', 'Part. pedidos'], report.baskets.modifiers.map(item => [item.code, item.name, item.orders, formatProductAnalysisUnits(item.units), formatProductAnalysisPercent(item.orderShare)]), { empty: 'No se identificaron extras en el período y alcance.' }));
  const basketReading = productAnalysisElement('div', 'product-analysis-price-reading');
  basketReading.appendChild(productAnalysisElement('h5', '', 'Cómo leer las columnas'));
  const basketDefinitions = productAnalysisElement('dl', 'product-analysis-definitions');
  report.baskets.definitions.forEach(item => {
    basketDefinitions.append(productAnalysisElement('dt', '', item.term), productAnalysisElement('dd', '', item.detail));
  });
  basketReading.appendChild(basketDefinitions);
  basketReading.appendChild(productAnalysisElement('h5', '', 'Qué muestran los datos de este período'));
  const basketInterpretations = productAnalysisElement('div', 'product-analysis-interpretations');
  report.baskets.interpretation.forEach(item => {
    const card = productAnalysisElement('article', `product-analysis-interpretation interpretation-${item.level}`);
    card.append(productAnalysisElement('strong', '', item.title), productAnalysisElement('p', '', item.detail));
    basketInterpretations.appendChild(card);
  });
  basketReading.appendChild(basketInterpretations);
  baskets.appendChild(basketReading);

  const formats = register('formats', 'Formatos', productAnalysisSection('formats', 'Familias, formatos y tamaños', 'Cómo se distribuye la elección dentro de una familia', report.formats.methodology));
  report.formats.families.forEach((family, familyIndex) => {
    const block = productAnalysisElement('div', 'product-analysis-family');
    block.append(productAnalysisElement('h5', '', family.family), productAnalysisElement('p', 'panel-description', `${family.hierarchy} · confianza ${family.confidence}`));
    block.appendChild(productAnalysisFormatsTable(family, familyIndex));
    formats.appendChild(block);
  });
  if (!report.formats.families.length) formats.appendChild(productAnalysisElement('p', 'form-status muted', 'No hay familias con múltiples formatos detectables en este alcance.'));

  const value = register('value', 'Valor', productAnalysisSection('value', 'Venta por tramo de precio', 'Unidades y valor vendido en cortes de $500', report.priceDistribution.basis));
  value.appendChild(productAnalysisTable(['Tramo de precio efectivo', 'Unidades', '% unidades', 'Venta neta', '% venta neta'], report.priceDistribution.bands.map(item => [
    item.label,
    formatProductAnalysisUnits(item.units),
    formatProductAnalysisPercent(item.unitSharePercent),
    formatClp(item.netSales),
    formatProductAnalysisPercent(item.salesSharePercent)
  ])));
  const valueInsights = productAnalysisElement('div', 'product-analysis-interpretations');
  report.priceDistribution.insights.forEach(insight => valueInsights.appendChild(productAnalysisElement('p', 'product-analysis-interpretation', insight)));
  value.appendChild(valueInsights);

  const price = register('price', 'Precio', productAnalysisSection('price', 'Precio, demanda y margen', 'Sensibilidad observada — no causal', report.priceSensitivity.caveat));
  price.appendChild(productAnalysisPriceSensitivityTable(report.priceSensitivity.items));
  const priceReading = productAnalysisElement('div', 'product-analysis-price-reading');
  priceReading.appendChild(productAnalysisElement('h5', '', 'Cómo leer las columnas'));
  const definitions = productAnalysisElement('dl', 'product-analysis-definitions');
  report.priceSensitivity.definitions.forEach(item => {
    definitions.append(productAnalysisElement('dt', '', item.term), productAnalysisElement('dd', '', item.detail));
  });
  priceReading.appendChild(definitions);
  priceReading.appendChild(productAnalysisElement('h5', '', 'Qué muestran los datos de este período'));
  const interpretations = productAnalysisElement('div', 'product-analysis-interpretations');
  report.priceSensitivity.interpretation.forEach(item => {
    const card = productAnalysisElement('article', `product-analysis-interpretation interpretation-${item.level}`);
    card.append(productAnalysisElement('strong', '', item.title), productAnalysisElement('p', '', item.detail));
    interpretations.appendChild(card);
  });
  priceReading.appendChild(interpretations);
  price.appendChild(priceReading);

  const ingredients = register('ingredients', 'Ingredientes', productAnalysisSection('ingredients', 'Composición por ingrediente principal', 'Lectura de la venta desde las recetas', 'El ingrediente principal se infiere por su contribución estimada al costo, excluyendo packaging.'));
  ingredients.appendChild(productAnalysisIngredientsTable(report.ingredients));

  const appendix = register('appendix', 'Anexo', productAnalysisSection('appendix', 'Anexo metodológico', 'Definiciones y fuentes', 'Detalle para interpretar y reproducir las conclusiones.'));
  const list = productAnalysisElement('ul', 'product-analysis-methodology');
  report.appendix.methodology.forEach(item => list.appendChild(productAnalysisElement('li', '', item)));
  appendix.appendChild(list);
  if (report.appendix.warnings.length) appendix.appendChild(productAnalysisElement('p', 'form-status error', report.appendix.warnings.join(' ')));
  const sources = report.sources ? Object.entries(report.sources).map(([key, value]) => `${key}: ${value}`).join(' · ') : '';
  if (sources) appendix.appendChild(productAnalysisElement('p', 'analysis-evidence', `Fuentes: ${sources}`));

  content.replaceChildren(...sections.map(item => item.section));
  nav.replaceChildren(...sections.map(item => {
    const link = productAnalysisElement('a', '', item.label);
    link.href = `#product-analysis-${item.id}`;
    return link;
  }));
}

async function generateProductAnalysis() {
  const button = document.getElementById('generate-product-analysis');
  const status = document.getElementById('product-analysis-config-status');
  const location = document.getElementById('product-analysis-location').value || 'all';
  const hierarchyId = document.getElementById('product-analysis-hierarchy').value || 'all';
  const dateFrom = document.getElementById('product-analysis-date-from').value;
  const dateTo = document.getElementById('product-analysis-date-to').value;
  if (!dateFrom || !dateTo || dateFrom > dateTo) return setStatus(status, 'Selecciona un rango de fechas válido.', 'error');
  button.disabled = true;
  setStatus(status, 'Construyendo portafolio, tendencias, canastas, formatos, precios, recetas y hallazgos…');
  try {
    const params = new URLSearchParams({ location, hierarchyId, dateFrom, dateTo });
    productAnalysisState = await apiRequest(`/api/products/analysis?${params}`);
    renderProductAnalysis();
    document.getElementById('product-analysis-config-dialog').close();
    document.getElementById('product-analysis-dialog').showModal();
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function printProductAnalysis() {
  if (!productAnalysisState) return;
  const previousTitle = document.title;
  document.title = `Análisis Productos - ${productAnalysisState.scope.locationLabel}`;
  document.body.classList.add('printing-product-analysis');
  try { window.print(); } finally { document.body.classList.remove('printing-product-analysis'); document.title = previousTitle; }
}

function exportProductAnalysis() {
  const report = productAnalysisState;
  if (!report || !window.XLSX) return;
  const workbook = XLSX.utils.book_new();
  const append = (name, headers, rows) => {
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    sheet['!autofilter'] = rows.length ? { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${rows.length + 1}` } : undefined;
    sheet['!cols'] = headers.map(header => ({ wch: Math.max(12, Math.min(42, String(header).length + 4)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
  };
  append('Información', ['Campo', 'Valor'], [
    ['Reporte', 'Análisis estadístico de productos'], ['Ubicación', report.scope.locationLabel], ['Jerarquía', report.scope.hierarchyLabel],
    ['Desde', report.period.from], ['Hasta', report.period.to], ['Comparación desde', report.period.previousFrom], ['Comparación hasta', report.period.previousTo],
    ['Venta neta', report.summary.netSales], ['Unidades', report.summary.units], ['Pedidos', report.summary.orders], ['Ticket promedio', report.summary.averageTicket],
    ['Cobertura Detalle Pagos %', report.coverage.paymentMatchPercent], ['Cobertura recetas %', report.coverage.recipeCoveragePercent],
    ['Exportado', new Date().toLocaleString('es-CL')]
  ]);
  append('Hallazgos', ['ID', 'Impacto', 'Confianza', 'Sección', 'Título', 'Detalle', 'Evidencia', 'Acción o pregunta'], report.findings.map(item => [item.id, item.impact, item.confidence, item.section, item.title, item.detail, item.evidence.join(' · '), item.action]));
  append('Productos', ['Código', 'Producto', 'Jerarquía', 'ABC', 'Unidades', 'Venta neta', 'Participación %', 'Pedidos', 'Precio promedio', 'Costo unitario', 'Origen costo', 'Margen %', 'Crecimiento venta %', 'Tendencia %', 'CV %'], report.appendix.products.map(item => [item.code, item.name, item.hierarchy, item.abc, item.units, item.netSales, item.salesShare, item.orderCount, item.averagePrice, item.unitCost, item.costSource, item.marginPercent, item.salesGrowthPercent, item.trendPercent, item.variabilityPercent]));
  append('Canastas', ['Código A', 'Producto A', 'Código B', 'Producto B', 'Pedidos', 'Soporte %', 'Confianza A-B %', 'Confianza B-A %', 'Lift'], report.baskets.pairs.map(item => [item.leftCode, item.leftName, item.rightCode, item.rightName, item.orders, item.supportPercent, item.confidenceLeftToRightPercent, item.confidenceRightToLeftPercent, item.lift]));
  append('Extras y modificadores', ['Código', 'Extra', 'Pedidos', 'Unidades', 'Participación pedidos %'], report.baskets.modifiers.map(item => [item.code, item.name, item.orders, item.units, item.orderShare]));
  append('Lectura canastas', ['Tipo', 'Título o término', 'Explicación'], [
    ...report.baskets.definitions.map(item => ['Definición', item.term, item.detail]),
    ...report.baskets.interpretation.map(item => ['Conclusión', item.title, item.detail])
  ]);
  append('Modalidad', ['Modalidad', 'Pedidos', 'Participación pedidos %', 'Venta neta', 'Participación venta neta %', 'Ticket promedio'], report.serviceModes.map(item => [item.label, item.orders, item.orderShare, item.netSales, item.salesShare, item.averageTicket]));
  append('Días y horas', ['Tipo', 'Valor', 'Observaciones', 'Unidades', 'Venta neta'], [...report.temporal.weekdays.map(item => ['Día semana', item.label, item.days, item.averageUnits, item.averageNetSales]), ...report.temporal.hours.map(item => ['Hora', item.label, '', item.units, item.netSales])]);
  append('Formatos', ['Familia', 'Jerarquía', 'Confianza', 'Código', 'Producto', 'Formato', 'Precio lista', 'Precio neto', 'Unidades', 'Participación unidades familia %', 'Venta neta', 'Participación venta familia %', 'Descuento implícito %', 'Precio promedio'], report.formats.families.flatMap(family => family.formats.map(item => [family.family, family.hierarchy, family.confidence, item.code, item.name, item.format, item.listPrice, item.netListPrice, item.units, item.familyUnitSharePercent, item.netSales, item.familySalesSharePercent, item.implicitDiscountPercent, item.averagePrice])));
  append('Transacciones formatos', ['Familia', 'Código', 'Producto', 'Fecha', 'Hora', 'Pedido', 'Ubicación', 'Modalidad', 'Unidades', 'Venta neta producto', 'Precio neto unitario', 'Precio con IVA', 'Descuento implícito %', 'Venta neta pedido'], report.formats.families.flatMap(family => family.formats.flatMap(item => item.transactions.map(transaction => [family.family, item.code, item.name, transaction.date, productAnalysisTimeLabel(transaction.hour), transaction.orderReference || transaction.orderKey, transaction.locationName, productAnalysisModeLabel(transaction.mode), transaction.quantity, transaction.netSales, transaction.averageNetPrice, transaction.averageGrossPrice, transaction.implicitDiscountPercent, transaction.orderNetSales]))));
  append('Detalle pedidos', ['Pedido', 'Fecha', 'Hora', 'Ubicación', 'Modalidad', 'Clientes', 'Comentario general', 'Total Detalle Pagos', 'Venta neta pedido', 'Código línea', 'Producto / extra', 'Tipo', 'Jerarquía', 'Cantidad', 'Venta neta línea', 'Origen valor', 'Precio neto unitario', 'Precio con IVA', 'Descuento implícito %'], report.formats.families.flatMap(family => family.formats.flatMap(item => item.transactions.flatMap(transaction => (transaction.orderLines || []).map(line => [transaction.orderReference || transaction.orderKey, transaction.date, productAnalysisTimeLabel(transaction.hour), transaction.locationName, productAnalysisModeLabel(transaction.mode), transaction.clients, transaction.paymentComment, transaction.paymentDue, transaction.orderNetSales, line.code, line.name, line.type, line.hierarchy, line.quantity, line.netSales, productAnalysisSalesAllocationLabel(line.salesAllocation), line.averageNetPrice, line.averageGrossPrice, line.implicitDiscountPercent])))));
  append('Tramos de precio', ['Tramo precio efectivo con IVA', 'Desde exclusivo', 'Hasta inclusivo', 'Unidades', 'Participación unidades %', 'Venta neta', 'Participación venta %', 'Venta con IVA'], report.priceDistribution.bands.map(item => [item.label, item.fromExclusive, item.toInclusive, item.units, item.unitSharePercent, item.netSales, item.salesSharePercent, item.grossSales]));
  append('Precio', ['Código', 'Producto', 'Observaciones', 'Niveles precio', 'Rango %', 'Coeficiente observado', 'Correlación', 'R²', 'Confianza'], report.priceSensitivity.items.map(item => [item.code, item.name, item.observations, item.pricePoints, item.priceRangePercent, item.observedElasticity, item.correlation, item.rSquared, item.confidence]));
  append('Detalle precio', ['Código', 'Producto', 'Fecha', 'Unidades', 'Venta neta', 'Precio neto promedio', 'Precio con IVA', 'Descuento vs. lista neta %'], report.priceSensitivity.items.flatMap(item => (item.observationDetails || []).map(observation => [item.code, item.name, observation.date, observation.units, observation.netSales, observation.averageNetPrice, observation.averageGrossPrice, observation.implicitDiscountPercent])));
  append('Transacciones precio', ['Código', 'Producto', 'Fecha observación', 'Pedido', 'Hora', 'Ubicación', 'Modalidad', 'Unidades', 'Venta neta producto', 'Precio neto unitario', 'Precio con IVA', 'Descuento implícito %', 'Venta neta pedido'], report.priceSensitivity.items.flatMap(item => (item.observationDetails || []).flatMap(observation => (observation.transactions || []).map(transaction => [item.code, item.name, observation.date, transaction.orderReference || transaction.orderKey, productAnalysisTimeLabel(transaction.hour), transaction.locationName, productAnalysisModeLabel(transaction.mode), transaction.quantity, transaction.netSales, transaction.averageNetPrice, transaction.averageGrossPrice, transaction.implicitDiscountPercent, transaction.orderNetSales]))));
  append('Lectura precio', ['Tipo', 'Título o término', 'Explicación'], [
    ...report.priceSensitivity.definitions.map(item => ['Definición', item.term, item.detail]),
    ...report.priceSensitivity.interpretation.map(item => ['Conclusión', item.title, item.detail])
  ]);
  append('Ingredientes', ['Código', 'Ingrediente principal', 'Unidades producto', 'Venta neta asociada', 'Participación %', 'Productos'], report.ingredients.map(item => [item.code, item.name, item.units, item.netSales, item.salesShare, item.products.map(product => `${product.code} ${product.name}`).join(' · ')]));
  append('Detalle ingredientes', ['Código ingrediente', 'Ingrediente principal', 'Código producto', 'Producto', 'Unidades', 'Pedidos', 'Precio promedio', 'Venta neta', 'Participación unidades ingrediente %', 'Participación venta ingrediente %'], report.ingredients.flatMap(item => item.products.map(product => [item.code, item.name, product.code, product.name, product.units, product.orderCount, product.averagePrice, product.netSales, product.ingredientUnitSharePercent, product.ingredientSalesSharePercent])));
  append('Serie diaria', ['Fecha', 'Unidades', 'Venta neta', 'Anomalía'], report.trends.daily.map(item => [item.date, item.units, item.netSales, report.trends.anomalies.find(value => value.date === item.date)?.direction || '']));
  append('Metodología', ['Definición'], report.appendix.methodology.map(item => [item]));
  writeConfiguredExcelWorkbook(workbook, `analisis-productos-${report.period.from}-${report.period.to}.xlsx`);
}

function filteredIngredientItems() {
  if (!ingredientsViewState) return [];
  const supplier = document.getElementById('ingredients-supplier-filter').value || 'all';
  const query = document.getElementById('ingredients-search').value.trim().toLocaleLowerCase('es');
  const onlyChanged = document.getElementById('ingredients-only-changed').checked;
  return sortRows(ingredientsViewState.items.filter(item =>
    (supplier === 'all' || item.supplierKey === supplier)
    && (!query || `${item.code} ${item.name}`.toLocaleLowerCase('es').includes(query))
    && (!onlyChanged || (item.costChangePercent !== null && Math.abs(item.costChangePercent) >= 0.01))), ingredientsSort);
}

function ingredientReportTable(headers, rows, className = '') {
  const table = document.createElement('table');
  table.className = className;
  const headRow = document.createElement('tr');
  headers.forEach(header => {
    const cell = document.createElement('th');
    cell.textContent = header;
    headRow.appendChild(cell);
  });
  const head = document.createElement('thead');
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  rows.forEach(values => {
    const row = document.createElement('tr');
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '—';
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  table.append(head, body);
  return table;
}

function printIngredientsReport() {
  const items = filteredIngredientItems();
  if (!items.length) return;
  const data = ingredientsViewState;
  const report = document.createElement('article');
  report.className = 'ingredients-print-report';
  const title = document.createElement('h1');
  title.textContent = 'Listado de ingredientes';
  const context = document.createElement('p');
  const supplier = document.getElementById('ingredients-supplier-filter').selectedOptions[0]?.textContent || 'Todos los proveedores';
  context.textContent = `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · ${supplier} · ${items.length} ingrediente(s).`;
  report.append(title, context, ingredientReportTable([
    'Código', 'Ingrediente', 'Proveedor', 'Unidad', 'Costo aplicado', 'Último costo compra',
    'Origen costo', 'Fecha costo', 'Variación costo', 'Consumo período', 'Costo consumido', 'Productos que lo usan'
  ], items.map(item => [
    item.code, item.name, item.supplier, item.unit || '—', formatClp(item.unitCost),
    item.latestPurchaseCost === null ? '—' : formatClp(item.latestPurchaseCost),
    item.costSource === 'purchase' ? 'Última compra' : item.costSource === 'master' ? 'Maestro' : 'Sin costo',
    item.costSourceDate ? formatReportDate(item.costSourceDate) : '—',
    item.costChangePercent === null ? '—' : `${item.costChangePercent >= 0 ? '+' : ''}${item.costChangePercent.toFixed(1)}%`,
    `${formatProductUnits(item.usageQuantity)} ${item.usageUnit || item.unit}`, formatClp(item.usageCost), item.products.length
  ]), 'ingredients-print-main-table'));
  items.filter(item => item.products.length).forEach(item => {
    const section = document.createElement('section');
    section.className = 'ingredients-print-detail';
    const heading = document.createElement('h2');
    heading.textContent = `${item.code} · ${item.name}`;
    const detailSort = ingredientProductSorts.get(item.code) || { key: 'name', direction: 'asc' };
    section.append(heading, ingredientReportTable([
      'Producto', 'Código', 'Cantidad receta', 'Rendimiento', 'Cantidad efectiva por producto',
      'Productos vendidos período', 'Consumo ingrediente período'
    ], sortRows(item.products, detailSort).map(product => [
      product.name, product.code, `${formatProductUnits(product.recipeQuantity)} ${product.recipeUnit}`,
      `${product.yieldRate.toFixed(1)}%`, `${formatProductUnits(product.effectiveQuantity)} ${product.effectiveUnit}`,
      product.periodProductQuantity === null ? '—' : formatProductUnits(product.periodProductQuantity),
      product.periodIngredientQuantity === null ? '—' : `${formatProductUnits(product.periodIngredientQuantity)} ${product.periodIngredientUnit}`
    ]), 'ingredients-print-detail-table'));
    report.appendChild(section);
  });
  const workspace = document.getElementById('ingredients-workspace');
  const previousTitle = document.title;
  workspace.appendChild(report);
  document.title = `Ingredientes - ${data.scope.label}`;
  document.body.classList.add('printing-ingredients-report');
  try {
    window.print();
  } finally {
    document.body.classList.remove('printing-ingredients-report');
    document.title = previousTitle;
    report.remove();
  }
}

function exportIngredientsReport() {
  const items = filteredIngredientItems();
  const status = document.getElementById('ingredients-status');
  if (!items.length) return;
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const data = ingredientsViewState;
    const supplier = document.getElementById('ingredients-supplier-filter').selectedOptions[0]?.textContent || 'Todos los proveedores';
    const search = document.getElementById('ingredients-search').value.trim() || 'Todos';
    const information = XLSX.utils.aoa_to_sheet([
      ['Reporte', 'Costos, uso y composición de ingredientes'],
      ['Ubicación', data.scope.label],
      ['Fecha inicial', data.period.from],
      ['Fecha final', data.period.to],
      ['Proveedor', supplier],
      ['Búsqueda', search],
      ['Solo con variación de costo', document.getElementById('ingredients-only-changed').checked ? 'Sí' : 'No'],
      ['Ingredientes incluidos', items.length],
      ['Costo consumido', items.reduce((sum, item) => sum + item.usageCost, 0)],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    const ingredientHeaders = [
      'Código', 'Ingrediente', 'Proveedor', 'Unidad', 'Costo aplicado', 'Último costo compra',
      'Origen costo', 'Fecha costo', 'Variación costo %', 'Consumo período', 'Unidad consumo', 'Costo consumido',
      'Productos que lo usan'
    ];
    const ingredientRows = items.map(item => [
      item.code, item.name, item.supplier, item.unit, item.unitCost, item.latestPurchaseCost,
      item.costSource === 'purchase' ? 'Última compra' : item.costSource === 'master' ? 'Maestro' : 'Sin costo',
      item.costSourceDate,
      item.costChangePercent, item.usageQuantity, item.usageUnit || item.unit, item.usageCost, item.products.length
    ]);
    const ingredientSheet = XLSX.utils.aoa_to_sheet([ingredientHeaders, ...ingredientRows]);
    ingredientSheet['!autofilter'] = { ref: `A1:M${ingredientRows.length + 1}` };
    ingredientSheet['!cols'] = ingredientHeaders.map((header, index) => ({
      wch: index === 1 ? 42 : index === 2 ? 30 : Math.max(12, Math.min(24, header.length + 2))
    }));
    const productHeaders = [
      'Código ingrediente', 'Ingrediente', 'Producto', 'Código producto', 'Cantidad receta', 'Unidad receta',
      'Rendimiento %', 'Cantidad efectiva', 'Unidad efectiva', 'Productos vendidos período',
      'Consumo ingrediente período', 'Unidad consumo período'
    ];
    const productRows = items.flatMap(item => {
      const detailSort = ingredientProductSorts.get(item.code) || { key: 'name', direction: 'asc' };
      return sortRows(item.products, detailSort).map(product => [
        item.code, item.name, product.name, product.code, product.recipeQuantity, product.recipeUnit,
        product.yieldRate, product.effectiveQuantity, product.effectiveUnit, product.periodProductQuantity,
        product.periodIngredientQuantity, product.periodIngredientUnit
      ]);
    });
    const productSheet = XLSX.utils.aoa_to_sheet([productHeaders, ...productRows]);
    productSheet['!autofilter'] = { ref: `A1:L${productRows.length + 1}` };
    productSheet['!cols'] = productHeaders.map((header, index) => ({
      wch: index === 1 || index === 2 ? 42 : Math.max(12, Math.min(26, header.length + 2))
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, information, 'Información');
    XLSX.utils.book_append_sheet(workbook, ingredientSheet, 'Ingredientes');
    XLSX.utils.book_append_sheet(workbook, productSheet, 'Productos por ingrediente');
    writeConfiguredExcelWorkbook(workbook, `ingredientes-${data.period.from}-${data.period.to}.xlsx`);
    setStatus(status, 'Listado de ingredientes exportado a Excel correctamente.', 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el listado: ${error.message}`, 'error');
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
    document.getElementById('print-ingredients-report').disabled = true;
    document.getElementById('export-ingredients-report').disabled = true;
    return;
  }
  const items = filteredIngredientItems();
  document.getElementById('print-ingredients-report').disabled = items.length === 0;
  document.getElementById('export-ingredients-report').disabled = items.length === 0;
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
  const requestedRankingLimit = Number(document.getElementById('ingredients-ranking-limit').value);
  const rankingLimit = [10, 20, 50].includes(requestedRankingLimit) ? requestedRankingLimit : 10;
  const ranked = [...items].filter(item => item.usageCost > 0).sort((left, right) => right.usageCost - left.usageCost).slice(0, rankingLimit);
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
  for (const item of items) {
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
      if (index === 4) cell.title = costSourceDescription(item);
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
      table.dataset.ingredientCode = item.code;
      const detailSort = ingredientProductSorts.get(item.code) || { key: 'name', direction: 'asc' };
      const detailHeaders = [
        ['name', 'Producto'],
        ['code', 'Código'],
        ['recipeQuantity', 'Cantidad receta'],
        ['yieldRate', 'Rendimiento'],
        ['effectiveQuantity', 'Cantidad efectiva por producto'],
        ['periodProductQuantity', 'Productos vendidos período'],
        ['periodIngredientEffectiveQuantity', 'Consumo ingrediente período']
      ];
      const detailHeadRow = document.createElement('tr');
      detailHeaders.forEach(([key, label]) => {
        const cell = document.createElement('th');
        markSortableHeader(cell, key, detailSort, label);
        detailHeadRow.appendChild(cell);
      });
      const detailHead = document.createElement('thead');
      detailHead.appendChild(detailHeadRow);
      table.appendChild(detailHead);
      const detailBody = document.createElement('tbody');
      sortRows(item.products, detailSort).forEach(product => {
        const productRow = document.createElement('tr');
        [
          product.name,
          product.code,
          `${formatProductUnits(product.recipeQuantity)} ${product.recipeUnit}`,
          `${product.yieldRate.toFixed(1)}%`,
          `${formatProductUnits(product.effectiveQuantity)} ${product.effectiveUnit}`,
          product.periodProductQuantity === null ? '—' : formatProductUnits(product.periodProductQuantity),
          product.periodIngredientQuantity === null
            ? '—'
            : `${formatProductUnits(product.periodIngredientQuantity)} ${product.periodIngredientUnit}`
        ]
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
  const relevantButton = document.getElementById('open-relevant-products-report');
  const analysisButton = document.getElementById('open-product-analysis');
  const location = document.getElementById('products-location-filter').value || 'all';
  button.disabled = true;
  relevantButton.disabled = true;
  analysisButton.disabled = true;
  setStatus(status, 'Calculando catálogo y ventas por producto…');
  try {
    const data = await apiRequest(`/api/products?location=${encodeURIComponent(location)}`);
    if (location !== document.getElementById('products-location-filter').value) return;
    productsViewState = data;
    renderProductsView();
    relevantButton.disabled = false;
    analysisButton.disabled = false;
    await refreshSavedProductReports();
    if (data.warnings.length) setStatus(status, data.warnings.join(' '), 'error');
    else setStatus(status, `${data.filesRead} archivo(s) de ventas procesado(s) para ${data.scope.label}.`, 'success');
  } catch (error) {
    productsViewState = null;
    renderProductsView();
    relevantButton.disabled = true;
    analysisButton.disabled = true;
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
        headerLines: 'Unidades x|UDC',
        headerTitle: 'UDC significa Unidad de Compra',
        value: row => formatPurchaseConversion(row.unitsPerPurchaseUnit),
        cellTitle: row => row.baseUnit && row.unitsPerPurchaseUnit !== null
          ? `1 ${row.purchaseUnit || row.unit} = ${formatPurchaseConversion(row.unitsPerPurchaseUnit)} ${row.baseUnit}`
          : 'Conversión no disponible en el maestro vigente'
      },
      { key: 'baseUnit', label: 'Unidad Medida', headerLines: 'Unidad|Medida', value: row => row.baseUnit || '—' },
      { key: 'listedUnitPrice', label: 'Costo UDC registrado', headerLines: 'Costo UDC|registrado', value: row => formatClp(row.listedUnitPrice) },
      {
        key: 'baseUnitCost',
        label: 'Costo Unitario',
        value: row => row.baseUnitCost === null || row.baseUnitCost === undefined ? '—' : formatClp(row.baseUnitCost),
        muted: true
      },
      { key: 'discount', label: 'Descuento', value: row => formatClp(row.discount) },
      { key: 'effectiveUnitPrice', label: 'Precio Unit. efectivo', headerLines: 'Precio Unit.|efectivo', value: row => formatClp(row.effectiveUnitPrice) },
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
      if (column.headerLines) cell.dataset.headerLines = column.headerLines;
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
      'Código', 'Insumo', 'Cantidad', 'UDC', 'Unidades x UDC', 'Unidad Medida',
      'Costo UDC registrado', 'Costo Unitario', 'Descuento', 'Precio Unit. efectivo',
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
    writeConfiguredExcelWorkbook(workbook, purchasesReportFilename('xlsx'));
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
  writeConfiguredExcelWorkbook(workbook, `variaciones-costo-${data.period.from}-${data.period.to}.xlsx`);
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

function formatProjectionOneDecimal(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(value));
}

function roundUpToPackageMultiple(quantity, unitsPerPackage) {
  const value = Number(quantity);
  const packageSize = Number(unitsPerPackage);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(packageSize) || packageSize <= 0) return value;
  return Number((Math.ceil((value / packageSize) - 1e-9) * packageSize).toPrecision(12));
}

function greatestCommonDivisor(left, right) {
  let first = Math.abs(left);
  let second = Math.abs(right);
  while (second) [first, second] = [second, first % second];
  return first || 1;
}

function purchaseUnitsRespectingPackage(quantity, unitsPerPurchaseUnit, unitsPerPackage) {
  const value = Number(quantity);
  const conversion = Number(unitsPerPurchaseUnit);
  const packageSize = Number(unitsPerPackage);
  if (!(value > 0) || !(conversion > 0) || !(packageSize > 0)) return null;
  const minimumPurchaseUnits = Math.ceil((value / conversion) - 1e-9);
  const scale = 1000000;
  const conversionInteger = Math.max(1, Math.round(conversion * scale));
  const packageInteger = Math.max(1, Math.round(packageSize * scale));
  const purchaseUnitMultiple = packageInteger / greatestCommonDivisor(conversionInteger, packageInteger);
  return Math.ceil(minimumPurchaseUnits / purchaseUnitMultiple) * purchaseUnitMultiple;
}

function purchaseQuantityPackageWarning(item, purchaseQuantity) {
  const quantity = Number(purchaseQuantity);
  const packageSize = Number(item.unitsPerPackage);
  const conversion = Number(item.unitsPerPurchaseUnit);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(packageSize) || packageSize <= 0
    || !Number.isFinite(conversion) || conversion <= 0) return '';
  const internalQuantity = quantity * conversion;
  const nearestMultiple = Math.round(internalQuantity / packageSize) * packageSize;
  if (Math.abs(internalQuantity - nearestMultiple) <= Math.max(1, Math.abs(internalQuantity)) * 1e-8) return '';
  return `Cantidad no múltiplo del empaque (${formatProjectionQuantity(packageSize)} ${item.internalUnit || 'un.'})`;
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
  const eligible = filteredPurchaseProjectionItems().some(item => item.supplierKey === supplier);
  document.getElementById('print-purchase-order').disabled = supplier === 'all' || supplier === 'unassigned' || !eligible;
}

function recalculatePurchaseProjectionItem(item) {
  item.minimumStock = item.averageDailyConsumption * item.minDays;
  item.maximumStock = item.averageDailyConsumption * item.maxDays;
  item.ownNeedsPurchase = item.averageDailyConsumption > 0 && item.currentInventory <= item.minimumStock;
  item.ownSuggestedInternalQuantity = item.ownNeedsPurchase
    ? Math.max(0, item.maximumStock - item.currentInventory) : 0;
  item.needsPurchase = item.ownNeedsPurchase || item.branchOrderInternalQuantity > 0;
  item.rawSuggestedInternalQuantity = item.ownSuggestedInternalQuantity + item.branchOrderInternalQuantity;
  item.suggestedInternalQuantity = roundUpToPackageMultiple(item.rawSuggestedInternalQuantity, item.unitsPerPackage);
  item.suggestedPurchaseUnits = purchaseUnitsRespectingPackage(
    item.suggestedInternalQuantity, item.unitsPerPurchaseUnit, item.unitsPerPackage
  );
  item.projectedInternalQuantity = item.suggestedPurchaseUnits === null
    ? item.suggestedInternalQuantity : item.suggestedPurchaseUnits * item.unitsPerPurchaseUnit;
  item.estimatedTotal = item.suggestedPurchaseUnits === null || item.estimatedPurchaseUnitCost === null
    ? null : item.suggestedPurchaseUnits * item.estimatedPurchaseUnitCost;
}

function renderPurchaseProjection() {
  const body = document.getElementById('purchase-projection-body');
  const summary = document.getElementById('purchase-projection-summary');
  const saveButton = document.getElementById('save-projection-policies');
  const branchOrdersHeader = document.getElementById('projection-branch-orders-header');
  const newCoverageHeader = document.getElementById('projection-new-coverage-header');
  if (!purchaseProjectionState) {
    body.replaceChildren();
    summary.replaceChildren();
    branchOrdersHeader.hidden = true;
    newCoverageHeader.hidden = true;
    saveButton.disabled = true;
    updatePurchaseOrderButton();
    return;
  }
  const data = purchaseProjectionState;
  const showsBranchOrders = data.branchOrders?.available === true;
  branchOrdersHeader.hidden = !showsBranchOrders;
  newCoverageHeader.hidden = !showsBranchOrders;
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
  if (showsBranchOrders) {
    summaryTexts.push(`${data.branchOrders.selectedOrderCount} OC suc. incluidas`);
    if (data.branchOrders.unconvertedItemCount) {
      summaryTexts.push(`${data.branchOrders.unconvertedItemCount} OC suc. sin conversión`);
    }
  }
  if (data.purchaseOrders.selectedOrderCount) {
    summaryTexts.push(`${data.purchaseOrders.selectedOrderCount} OC seleccionada(s)`);
    if (data.purchaseOrders.unconvertedItemCount) {
      summaryTexts.push(`${data.purchaseOrders.unconvertedItemCount} OC sin conversión`);
    }
  }
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
    const internalUnitCell = document.createElement('td');
    internalUnitCell.textContent = item.internalUnit || '—';
    row.appendChild(internalUnitCell);
    const packageCell = document.createElement('td');
    const packageInput = document.createElement('input');
    packageInput.type = 'number';
    packageInput.min = '0.0001';
    packageInput.max = '1000000';
    packageInput.step = 'any';
    packageInput.value = String(item.unitsPerPackage ?? 1);
    packageInput.className = 'projection-package-input';
    packageInput.setAttribute('aria-label', `Unidades por empaque de ${item.name}`);
    packageCell.appendChild(packageInput);
    row.appendChild(packageCell);
    const plainValues = [
      { value: formatProjectionMetric(item.currentInventory) },
      { value: formatProjectionMetric(item.consumption30) },
      { value: formatProjectionMetric(item.averageDailyConsumption) },
      {
        value: item.currentCoverageDays === null ? 'Sin consumo' : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
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
    if (showsBranchOrders) {
      const branchOrdersCell = document.createElement('td');
      branchOrdersCell.className = 'projection-branch-order-quantity';
      branchOrdersCell.textContent = `${formatProjectionQuantity(item.branchOrderInternalQuantity)} ${item.internalUnit || ''}`.trim();
      if (item.branchOrderConversionMissing) {
        branchOrdersCell.classList.add('projection-branch-order-warning');
        branchOrdersCell.title = 'Hay cantidades de sucursales cuya unidad no se pudo convertir.';
      }
      row.appendChild(branchOrdersCell);
    }
    const leadingResultValues = [
      item.needsPurchase ? `${formatProjectionOneDecimal(item.suggestedInternalQuantity)} ${item.internalUnit}` : 'No comprar',
      item.purchaseUnit || '—'
    ];
    leadingResultValues.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    const purchaseOrderCell = document.createElement('td');
    purchaseOrderCell.className = 'projection-purchase-order-quantity';
    if (!data.purchaseOrders.selectedOrderCount) {
      purchaseOrderCell.textContent = '—';
      purchaseOrderCell.title = 'Selecciona órdenes de compra desde el botón OC.';
    } else {
      purchaseOrderCell.textContent = `${formatProjectionOneDecimal(item.purchaseOrderInternalQuantity)} ${item.internalUnit || ''}`.trim();
      if (item.purchaseOrderConversionMissing) {
        purchaseOrderCell.classList.add('projection-purchase-order-warning');
        purchaseOrderCell.title = 'Hay cantidades de órdenes cuya unidad no se pudo convertir.';
      } else if (item.purchaseOrderInternalQuantity + 1e-9 >= item.suggestedInternalQuantity) {
        purchaseOrderCell.classList.add('projection-purchase-order-sufficient');
        purchaseOrderCell.title = 'La cantidad ordenada cubre la sugerencia interna.';
      } else {
        purchaseOrderCell.classList.add('projection-purchase-order-short');
        purchaseOrderCell.title = 'La cantidad ordenada es menor que la sugerencia interna.';
      }
    }
    row.appendChild(purchaseOrderCell);
    if (showsBranchOrders) {
      const newCoverageCell = document.createElement('td');
      newCoverageCell.className = 'projection-new-coverage';
      if (!data.purchaseOrders.selectedOrderCount) {
        newCoverageCell.textContent = '—';
        newCoverageCell.title = 'Selecciona órdenes de compra desde el botón OC.';
      } else if (item.purchaseOrderConversionMissing || item.branchOrderConversionMissing) {
        newCoverageCell.textContent = 'Sin conversión';
        newCoverageCell.classList.add('projection-purchase-order-warning');
        newCoverageCell.title = 'No fue posible convertir todas las cantidades a la unidad interna.';
      } else if (item.coverageAfterPurchaseOrdersDays === null) {
        newCoverageCell.textContent = 'Sin consumo';
        newCoverageCell.title = 'No existe consumo diario para calcular la cobertura.';
      } else {
        newCoverageCell.textContent = `${formatProjectionOneDecimal(item.coverageAfterPurchaseOrdersDays)} días`;
        newCoverageCell.title = 'Inventario actual + OC seleccionadas − OC Suc, dividido por el consumo diario.';
        if (item.coverageAfterPurchaseOrdersDays < item.minDays) {
          newCoverageCell.classList.add('projection-coverage-low');
        }
      }
      row.appendChild(newCoverageCell);
    }
    const trailingResultValues = [
      item.conversionAvailable ? formatProjectionQuantity(item.unitsPerPurchaseUnit) : 'Sin conversión',
      item.suggestedPurchaseUnits === null ? '—' : formatProjectionQuantity(item.suggestedPurchaseUnits),
      item.estimatedPurchaseUnitCost === null ? '—' : formatClp(item.estimatedPurchaseUnitCost),
      item.estimatedTotal === null ? '—' : formatClp(item.estimatedTotal)
    ];
    trailingResultValues.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    return row;
  }));
  if (!visibleItems.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = showsBranchOrders ? 21 : 19;
    cell.className = 'projection-empty';
    cell.textContent = 'No hay ítems para los filtros seleccionados.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  saveButton.disabled = data.items.length === 0;
  updatePurchaseOrderButton();
}

function openProjectionBranchOrders() {
  const branchOrders = purchaseProjectionState?.branchOrders;
  if (!branchOrders?.available) return;
  const dialog = document.getElementById('projection-branch-orders-dialog');
  const description = document.getElementById('projection-branch-orders-description');
  description.textContent = `Selecciona las sucursales cuyas órdenes dirigidas a ${branchOrders.companySupplier.name} se sumarán a la compra de Bodega Principal.`;
  const body = document.getElementById('projection-branch-orders-body');
  body.replaceChildren(...branchOrders.locations.map(location => {
    const row = document.createElement('tr');
    row.dataset.locationId = location.id;
    const selectionCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'projection-branch-location-input';
    checkbox.checked = location.selected;
    checkbox.setAttribute('aria-label', `Incluir ${location.name}`);
    selectionCell.appendChild(checkbox);
    const locationCell = document.createElement('td');
    locationCell.textContent = location.name;
    const orderCell = document.createElement('td');
    orderCell.textContent = location.latestOrder?.orderNumber || 'Sin órdenes a CODE SPA';
    const dateCell = document.createElement('td');
    dateCell.textContent = location.latestOrder ? formatReportDate(location.latestOrder.date) : '—';
    if (location.latestOrder) {
      dateCell.className = location.latestOrder.stale
        ? 'projection-branch-order-date stale'
        : 'projection-branch-order-date recent';
    }
    const countCell = document.createElement('td');
    countCell.textContent = String(location.orderCount);
    row.append(selectionCell, locationCell, orderCell, dateCell, countCell);
    return row;
  }));
  dialog.showModal();
}

async function applyProjectionBranchOrders() {
  const branchLocationIds = [...document.querySelectorAll('#projection-branch-orders-body tr[data-location-id]')]
    .filter(row => row.querySelector('.projection-branch-location-input').checked)
    .map(row => row.dataset.locationId);
  document.getElementById('projection-branch-orders-dialog').close();
  await loadPurchaseProjection({ branchLocationIds, preserveDraftCriteria: true });
}

async function openProjectionPurchaseOrders() {
  const purchaseOrders = purchaseProjectionState?.purchaseOrders;
  if (!purchaseOrders?.available) return;
  const dialog = document.getElementById('projection-purchase-orders-dialog');
  const status = document.getElementById('projection-purchase-orders-status');
  const openButton = document.getElementById('open-projection-purchase-orders');
  document.getElementById('projection-purchase-orders-description').textContent =
    `Selecciona las órdenes emitidas por ${purchaseProjectionState.location.name} que deseas comparar con la sugerencia interna.`;
  openButton.disabled = true;
  try {
    const latest = await apiRequest(`/api/purchase-orders?location=${encodeURIComponent(purchaseProjectionState.location.id)}`);
    const selectedIds = new Set(purchaseOrders.selectedOrderIds);
    purchaseOrders.orders = latest.orders.map(order => ({
      ...order,
      date: String(order.confirmedAt || order.updatedAt || order.createdAt || '').slice(0, 10),
      selected: selectedIds.has(order.id)
    }));
  } catch (error) {
    document.getElementById('projection-purchase-orders-body').replaceChildren();
    setStatus(status, error.message, 'error');
    dialog.showModal();
    return;
  } finally {
    openButton.disabled = false;
  }
  setStatus(status, purchaseOrders.orders.length
    ? (purchaseOrders.selectedOrderCount
      ? `${purchaseOrders.orders.length} orden(es) disponible(s); ${purchaseOrders.selectedOrderCount} seleccionada(s).`
      : `${purchaseOrders.orders.length} orden(es) disponible(s). La selección comienza vacía para no incluir órdenes antiguas automáticamente.`)
    : 'Esta ubicación aún no tiene órdenes de compra guardadas.', purchaseOrders.orders.length ? 'success' : 'muted');
  const body = document.getElementById('projection-purchase-orders-body');
  body.replaceChildren(...purchaseOrders.orders.map(order => {
    const row = document.createElement('tr');
    row.dataset.orderId = order.id;
    const selectionCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'projection-purchase-order-input projection-branch-location-input';
    checkbox.checked = order.selected;
    checkbox.setAttribute('aria-label', `Incluir ${order.orderNumber}`);
    selectionCell.appendChild(checkbox);
    const values = [
      order.orderNumber,
      order.supplier?.name || 'Proveedor no disponible',
      formatReportDate(order.date),
      String(order.itemCount),
      formatClp(order.total)
    ];
    row.appendChild(selectionCell);
    values.forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    return row;
  }));
  dialog.showModal();
}

async function applyProjectionPurchaseOrders() {
  const purchaseOrderIds = [...document.querySelectorAll('#projection-purchase-orders-body tr[data-order-id]')]
    .filter(row => row.querySelector('.projection-purchase-order-input').checked)
    .map(row => row.dataset.orderId);
  document.getElementById('projection-purchase-orders-dialog').close();
  await loadPurchaseProjection({ purchaseOrderIds, preserveDraftCriteria: true });
}

async function loadPurchaseProjection(options = {}) {
  const status = document.getElementById('purchase-projection-status');
  const button = document.getElementById('refresh-purchase-projection');
  const location = document.getElementById('projection-location-filter').value;
  if (!location) return;
  const draftCriteria = options.preserveDraftCriteria && purchaseProjectionState?.location.id === location
    ? new Map(purchaseProjectionState.items.map(item => [item.key, {
      minDays: item.minDays,
      maxDays: item.maxDays,
      unitsPerPackage: item.unitsPerPackage,
      managed: item.managed,
      supplierKey: item.supplierKey
    }]))
    : null;
  const requestedBranchLocationIds = Array.isArray(options.branchLocationIds)
    ? options.branchLocationIds
    : (purchaseProjectionState?.location.id === location && purchaseProjectionState.branchOrders?.available
      ? purchaseProjectionState.branchOrders.selectedLocationIds : null);
  const requestedPurchaseOrderIds = Array.isArray(options.purchaseOrderIds)
    ? options.purchaseOrderIds
    : (purchaseProjectionState?.location.id === location && purchaseProjectionState.purchaseOrders?.available
      ? purchaseProjectionState.purchaseOrders.selectedOrderIds : null);
  button.disabled = true;
  setStatus(status, 'Calculando inventario, consumos y necesidades de compra…');
  try {
    const query = new URLSearchParams({ location });
    if (requestedBranchLocationIds !== null) query.set('branches', requestedBranchLocationIds.join(','));
    if (requestedPurchaseOrderIds !== null) query.set('orders', requestedPurchaseOrderIds.join(','));
    const data = await apiRequest(`/api/purchase-projections?${query}`);
    if (location !== document.getElementById('projection-location-filter').value) return;
    if (draftCriteria) {
      data.items.forEach(item => {
        const draft = draftCriteria.get(item.key);
        if (!draft) return;
        item.minDays = draft.minDays;
        item.maxDays = draft.maxDays;
        item.unitsPerPackage = draft.unitsPerPackage;
        item.managed = draft.managed;
        item.supplierKey = draft.supplierKey;
        const supplier = data.suppliers.find(candidate => candidate.key === draft.supplierKey);
        if (supplier) {
          item.supplier = supplier.name;
          item.supplierTaxId = supplier.taxId || '';
        }
        recalculatePurchaseProjectionItem(item);
      });
    }
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
    item.unitsPerPackage = Number(row.querySelector('.projection-package-input').value);
    item.supplierKey = row.querySelector('.projection-supplier-input').value;
    item.managed = row.querySelector('.projection-managed-input').checked;
  }
  const invalid = purchaseProjectionState.items.find(item =>
    !Number.isFinite(item.minDays) || !Number.isFinite(item.maxDays) || !Number.isFinite(item.unitsPerPackage)
    || item.minDays < 0 || item.maxDays < item.minDays || item.maxDays > 365
    || item.unitsPerPackage <= 0 || item.unitsPerPackage > 1000000);
  if (invalid) return setStatus(status, `Revisa los días mínimos, máximos y las unidades por empaque de ${invalid.name}.`, 'error');
  button.disabled = true;
  try {
    await apiRequest('/api/purchase-projections/policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: purchaseProjectionState.location.id,
        items: purchaseProjectionState.items.map(item => ({
          key: item.key, minDays: item.minDays, maxDays: item.maxDays, unitsPerPackage: item.unitsPerPackage,
          supplierKey: item.supplierKey, managed: item.managed
        }))
      })
    });
    setStatus(status, 'Criterios de compra guardados correctamente.', 'success');
    await loadPurchaseProjection();
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function purchaseOrderHasChangedCosts() {
  return purchaseOrderEditorState?.items.some(item => item.selected
    && Number(item.unitCost) !== roundedPurchaseOrderCost(item.referenceUnitCost || 0)) || false;
}

function editableSavedPurchaseOrder(order) {
  return {
    ...order,
    items: order.items.map(item => ({
      ...item,
      unitsPerPackage: Number(item.unitsPerPackage) > 0 ? Number(item.unitsPerPackage) : 1,
      referenceUnitCost: roundedPurchaseOrderCost(item.referenceUnitCost || 0),
      unitCost: roundedPurchaseOrderCost(item.unitCost),
      selected: true,
      savedSelected: true,
      savedQuantity: Number(item.quantity),
      savedUnitCost: roundedPurchaseOrderCost(item.unitCost)
    }))
  };
}

function purchaseOrderEditorIsDirty() {
  if (!purchaseOrderEditorState?.id) return true;
  return purchaseOrderEditorState.items.some(item => item.selected !== item.savedSelected
    || Math.abs(Number(item.quantity) - Number(item.savedQuantity)) > 0.000001
    || Number(item.unitCost) !== Number(item.savedUnitCost));
}

function updatePurchaseOrderEditorTotals() {
  if (!purchaseOrderEditorState) return;
  const rows = [...document.querySelectorAll('#purchase-order-editor-body tr[data-key]')];
  let total = 0;
  for (const row of rows) {
    const item = purchaseOrderEditorState.items.find(candidate => candidate.key === row.dataset.key);
    if (!item) continue;
    item.selected = row.querySelector('.purchase-order-select').checked;
    item.quantity = Number(row.querySelector('.purchase-order-quantity').value);
    item.unitCost = roundedPurchaseOrderCost(parseLocalizedNumber(row.querySelector('.purchase-order-cost').value));
    const changed = item.unitCost !== roundedPurchaseOrderCost(item.referenceUnitCost || 0);
    const packageWarning = purchaseQuantityPackageWarning(item, item.quantity);
    const rowTotal = item.selected && Number.isFinite(item.quantity) && Number.isFinite(item.unitCost)
      ? item.quantity * item.unitCost : 0;
    row.querySelector('.purchase-order-row-total').textContent = formatClp(rowTotal);
    row.querySelector('.purchase-order-row-warning').textContent = [
      changed ? 'Costo modificado' : '', packageWarning
    ].filter(Boolean).join(' · ');
    row.classList.toggle('purchase-order-cost-modified', changed);
    row.classList.toggle('purchase-order-package-warning', Boolean(packageWarning));
    row.classList.toggle('purchase-order-row-excluded', !item.selected);
    total += rowTotal;
  }
  document.getElementById('purchase-order-editor-total').textContent = formatClp(total);
  document.getElementById('purchase-order-cost-warning').hidden = !purchaseOrderHasChangedCosts();
  const dirty = purchaseOrderEditorIsDirty();
  document.getElementById('print-saved-purchase-order').disabled = !purchaseOrderEditorState.id || dirty;
  if (purchaseOrderEditorState.id && dirty) {
    setStatus(document.getElementById('purchase-order-editor-status'),
      'Hay cambios pendientes. Confirma y guarda nuevamente antes de imprimir.', 'muted');
  } else if (purchaseOrderEditorState.id) {
    setStatus(document.getElementById('purchase-order-editor-status'),
      `Orden guardada. Última actualización: ${new Date(purchaseOrderEditorState.updatedAt).toLocaleString('es-CL')}.`, 'success');
  }
}

function renderPurchaseOrderEditor() {
  const state = purchaseOrderEditorState;
  if (!state) return;
  document.getElementById('purchase-order-editor-title').textContent = state.id
    ? `Orden de compra ${state.orderNumber}` : 'Nueva orden de compra';
  document.getElementById('purchase-order-editor-subtitle').textContent =
    `${state.supplier.name}${state.supplier.taxId ? ` · RUT ${state.supplier.taxId}` : ''} · ${state.location.name}`;
  document.getElementById('purchase-order-editor-status').textContent = state.id
    ? `Orden guardada. Última actualización: ${new Date(state.updatedAt).toLocaleString('es-CL')}.` :
      'Selecciona los ítems y confirma sus cantidades y costos antes de guardar.';
  const body = document.getElementById('purchase-order-editor-body');
  body.replaceChildren(...state.items.map(item => {
    const row = document.createElement('tr');
    row.dataset.key = item.key;
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'purchase-order-select';
    checkbox.checked = item.selected;
    checkbox.setAttribute('aria-label', `Incluir ${item.name}`);
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);
    [item.code || '—', item.name, item.purchaseUnit || '—',
      item.unitsPerPurchaseUnit === null ? '—' : formatProjectionQuantity(item.unitsPerPurchaseUnit),
      formatProjectionQuantity(item.unitsPerPackage || 1),
      item.suggestedPurchaseUnits === null ? '—' : formatProjectionQuantity(item.suggestedPurchaseUnits)]
      .forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
    const quantityCell = document.createElement('td');
    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = '0';
    quantity.step = '1';
    quantity.value = String(item.quantity ?? 0);
    quantity.className = 'purchase-order-quantity';
    quantityCell.appendChild(quantity);
    row.appendChild(quantityCell);
    const costCell = document.createElement('td');
    const cost = document.createElement('input');
    cost.type = 'text';
    cost.inputMode = 'numeric';
    cost.value = formatPurchaseOrderCost(item.unitCost);
    cost.className = 'purchase-order-cost';
    costCell.appendChild(cost);
    row.appendChild(costCell);
    const totalCell = document.createElement('td');
    totalCell.className = 'purchase-order-row-total';
    row.appendChild(totalCell);
    const warningCell = document.createElement('td');
    warningCell.className = 'purchase-order-row-warning';
    row.appendChild(warningCell);
    return row;
  }));
  updatePurchaseOrderEditorTotals();
}

function openPurchaseOrderEditor() {
  const data = purchaseProjectionState;
  const supplierKey = document.getElementById('projection-supplier-filter').value;
  if (!data || ['all', 'unassigned'].includes(supplierKey)) return;
  const supplier = data.suppliers.find(item => item.key === supplierKey);
  const visibleItems = filteredPurchaseProjectionItems().filter(item => item.supplierKey === supplierKey);
  if (!supplier || !visibleItems.length) return;
  purchaseOrderEditorState = {
    id: null,
    orderNumber: null,
    location: data.location,
    supplier,
    projectionPeriod: data.period,
    filters: {
      onlyRequired: document.getElementById('projection-only-required').checked,
      onlyManaged: document.getElementById('projection-only-managed').checked,
      branchLocationIds: data.branchOrders?.selectedLocationIds || [],
      selectedPurchaseOrderIds: data.purchaseOrders?.selectedOrderIds || []
    },
    items: visibleItems.map(item => ({
      ...item,
      referenceUnitCost: roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost || 0),
      quantity: Number(item.suggestedPurchaseUnits || 0),
      unitCost: roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost || 0),
      selected: Number(item.suggestedPurchaseUnits || 0) > 0
    }))
  };
  renderPurchaseOrderEditor();
  document.getElementById('purchase-order-editor-dialog').showModal();
}

async function confirmPurchaseOrder() {
  if (!purchaseOrderEditorState) return;
  updatePurchaseOrderEditorTotals();
  const status = document.getElementById('purchase-order-editor-status');
  const selected = purchaseOrderEditorState.items.filter(item => item.selected);
  if (!selected.length) return setStatus(status, 'Selecciona al menos un ítem para guardar la orden.', 'error');
  if (selected.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitCost) || item.unitCost < 0)) {
    return setStatus(status, 'Todos los ítems incluidos deben tener cantidad mayor que cero y un costo válido.', 'error');
  }
  if (purchaseOrderHasChangedCosts() && !window.confirm('Modificaste uno o más costos respecto de la estimación. ¿Confirmas que deseas guardar la orden con estos nuevos costos?')) return;
  const button = document.getElementById('confirm-purchase-order');
  button.disabled = true;
  try {
    const existing = purchaseOrderEditorState.id;
    const payload = {
      location: purchaseOrderEditorState.location.id,
      supplierKey: purchaseOrderEditorState.supplier.key,
      filters: purchaseOrderEditorState.filters,
      items: selected.map(item => ({ key: item.key, quantity: item.quantity, unitCost: item.unitCost }))
    };
    const saved = await apiRequest(existing ? `/api/purchase-orders/${encodeURIComponent(existing)}` : '/api/purchase-orders', {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    purchaseOrderEditorState = editableSavedPurchaseOrder(saved);
    renderPurchaseOrderEditor();
    setStatus(status, `Orden ${saved.orderNumber} guardada correctamente. Ya puedes imprimirla o volver a modificarla.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function printPurchaseOrder(order = purchaseOrderEditorState) {
  if (!order?.id || !order.items?.length) return;
  const documentSection = document.getElementById('purchase-order-document');
  const heading = document.createElement('div');
  heading.className = 'purchase-order-heading';
  const headingMain = document.createElement('div');
  headingMain.className = 'purchase-order-company';
  const logo = document.createElement('img');
  logo.className = 'purchase-order-logo';
  logo.src = order.company?.logoUrl || 'docs/brewit-final-01.jpg';
  logo.alt = 'Brewit';
  const companyDetail = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'panel-eyebrow';
  eyebrow.textContent = `Orden de compra · ${order.orderNumber}`;
  const companyName = document.createElement('h2');
  companyName.textContent = order.company?.name || 'Brewit';
  const companyTaxId = document.createElement('p');
  companyTaxId.textContent = order.company?.taxId ? `RUT ${order.company.taxId}` : 'RUT no configurado';
  const locationDetail = document.createElement('p');
  locationDetail.textContent = `${order.location.name}${order.location.address ? ` · ${order.location.address}` : ' · Dirección no configurada'}`;
  companyDetail.append(eyebrow, companyName, companyTaxId, locationDetail);
  headingMain.append(logo, companyDetail);
  const headingMeta = document.createElement('div');
  const orderDate = document.createElement('strong');
  orderDate.textContent = new Date(order.confirmedAt).toLocaleDateString('es-CL');
  headingMeta.append(orderDate, document.createElement('br'), document.createTextNode('Orden confirmada y guardada'));
  heading.append(headingMain, headingMeta);
  const supplierBlock = document.createElement('div');
  supplierBlock.className = 'purchase-order-supplier';
  const supplierLabel = document.createElement('span');
  supplierLabel.textContent = 'PROVEEDOR';
  const supplierName = document.createElement('strong');
  supplierName.textContent = order.supplier.name;
  const supplierTaxId = document.createElement('span');
  supplierTaxId.textContent = order.supplier.taxId ? `RUT ${order.supplier.taxId}` : 'RUT no disponible';
  supplierBlock.append(supplierLabel, supplierName, supplierTaxId);
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Código</th><th>Producto / ingrediente</th><th>Cantidad UDC</th><th>UDC</th><th>Equivalencia interna</th><th>Costo UDC</th><th>Total</th></tr></thead>';
  const body = document.createElement('tbody');
  order.items.forEach(item => {
    const row = document.createElement('tr');
    [
      item.code || '', item.name, formatProjectionQuantity(item.quantity), item.purchaseUnit,
      item.internalQuantity === null ? '—' : `${formatProjectionQuantity(item.internalQuantity)} ${item.internalUnit}`,
      formatClp(item.unitCost), formatClp(item.total)
    ].forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  const footer = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.className = 'purchase-order-total-row';
  totalRow.innerHTML = `<td colspan="6">TOTAL ORDEN</td><td>${formatClp(order.total)}</td>`;
  footer.appendChild(totalRow);
  table.append(body, footer);
  const note = document.createElement('p');
  note.className = 'purchase-order-note';
  note.textContent = order.items.some(item => item.costModified)
    ? 'Esta orden contiene costos modificados manualmente respecto de la estimación original. Verificar impuestos y condiciones comerciales antes de enviarla.'
    : 'Verificar disponibilidad, impuestos y condiciones comerciales antes de enviar la orden al proveedor.';
  documentSection.replaceChildren(heading, supplierBlock, table, note);
  documentSection.hidden = false;
  const previousTitle = document.title;
  document.title = `${order.orderNumber} - ${order.supplier.name}`;
  document.body.classList.add('printing-purchase-order');
  try {
    window.print();
  } finally {
    document.body.classList.remove('printing-purchase-order');
    documentSection.hidden = true;
    document.title = previousTitle;
  }
}

async function openPastPurchaseOrders() {
  const dialog = document.getElementById('past-purchase-orders-dialog');
  const list = document.getElementById('past-purchase-orders-list');
  const status = document.getElementById('past-purchase-orders-status');
  if (!dialog.open) dialog.showModal();
  list.replaceChildren();
  setStatus(status, 'Cargando órdenes guardadas…');
  try {
    const location = document.getElementById('projection-location-filter').value;
    const data = await apiRequest(`/api/purchase-orders?location=${encodeURIComponent(location)}`);
    const hiddenCount = data.orders.filter(order => order.hidden).length;
    const showHidden = document.getElementById('show-hidden-purchase-orders').checked;
    const displayedOrders = data.orders.filter(order => showHidden || !order.hidden);
    if (!data.orders.length) {
      setStatus(status, 'Aún no hay órdenes de compra guardadas para esta ubicación.', 'muted');
      return;
    }
    if (!displayedOrders.length) {
      setStatus(status, `No hay órdenes visibles. ${hiddenCount} orden(es) oculta(s).`, 'muted');
      return;
    }
    setStatus(status, `${displayedOrders.length} orden(es) mostrada(s)${hiddenCount ? ` · ${hiddenCount} oculta(s)` : ''}.`, 'success');
    list.replaceChildren(...displayedOrders.map(order => {
      const card = document.createElement('article');
      card.className = 'past-purchase-order-card';
      if (order.hidden) card.classList.add('is-hidden');
      const detail = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${order.orderNumber} · ${order.supplier.name}`;
      if (order.hidden) {
        const badge = document.createElement('span');
        badge.className = 'past-purchase-order-hidden-badge';
        badge.textContent = 'Oculta';
        title.append(' ', badge);
      }
      const meta = document.createElement('span');
      meta.textContent = `${new Date(order.updatedAt).toLocaleString('es-CL')} · ${order.itemCount} ítem(s) · ${formatClp(order.total)}`;
      detail.append(title, meta);
      const actions = document.createElement('div');
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'primary'; edit.dataset.orderAction = 'edit'; edit.dataset.orderId = order.id; edit.textContent = 'Ver / modificar';
      const print = document.createElement('button');
      print.type = 'button'; print.className = 'icon-button'; print.dataset.orderAction = 'print'; print.dataset.orderId = order.id; print.textContent = 'Imprimir / PDF';
      const visibility = document.createElement('button');
      visibility.type = 'button'; visibility.className = 'icon-button'; visibility.dataset.orderAction = 'visibility'; visibility.dataset.orderId = order.id;
      visibility.dataset.hidden = String(!order.hidden); visibility.dataset.orderNumber = order.orderNumber;
      visibility.textContent = order.hidden ? 'Mostrar' : 'Ocultar';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'delete-button'; remove.dataset.orderAction = 'delete'; remove.dataset.orderId = order.id;
      remove.dataset.orderNumber = order.orderNumber; remove.textContent = 'Eliminar';
      actions.append(edit, print, visibility, remove);
      card.append(detail, actions);
      return card;
    }));
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function setPurchaseOrderVisibility(orderId, orderNumber, hidden) {
  const status = document.getElementById('past-purchase-orders-status');
  try {
    await apiRequest(`/api/purchase-orders/${encodeURIComponent(orderId)}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden })
    });
    await openPastPurchaseOrders();
    setStatus(status, `Orden ${orderNumber} ${hidden ? 'ocultada' : 'mostrada'} correctamente.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function deleteSavedPurchaseOrder(orderId, orderNumber) {
  if (!window.confirm(`¿Eliminar definitivamente la orden ${orderNumber}? Esta acción no se puede deshacer.`)) return;
  const status = document.getElementById('past-purchase-orders-status');
  try {
    await apiRequest(`/api/purchase-orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: orderNumber })
    });
    await openPastPurchaseOrders();
    setStatus(status, `Orden ${orderNumber} eliminada.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function openSavedPurchaseOrder(orderId, printOnly = false) {
  const status = document.getElementById('past-purchase-orders-status');
  try {
    const order = await apiRequest(`/api/purchase-orders/${encodeURIComponent(orderId)}`);
    if (printOnly) return printPurchaseOrder(order);
    document.getElementById('past-purchase-orders-dialog').close();
    purchaseOrderEditorState = editableSavedPurchaseOrder(order);
    renderPurchaseOrderEditor();
    document.getElementById('purchase-order-editor-dialog').showModal();
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

function tentativeNoPurchaseReason(item) {
  if (item.averageDailyConsumption <= 0) return 'Sin consumo registrado en los últimos 30 días.';
  if (item.currentCoverageDays !== null && item.currentCoverageDays > item.minDays) {
    return `Cobertura actual de ${formatProjectionOneDecimal(item.currentCoverageDays)} días, sobre el mínimo de ${formatProjectionOneDecimal(item.minDays)} días.`;
  }
  return 'El inventario actual no activa reposición con los criterios guardados.';
}

function tentativeGroupsForProjection(projection) {
  const managedBySupplier = new Map();
  projection.items.filter(item => item.managed).forEach(item => {
    if (!managedBySupplier.has(item.supplierKey)) managedBySupplier.set(item.supplierKey, []);
    managedBySupplier.get(item.supplierKey).push(item);
  });
  return [...managedBySupplier.entries()].flatMap(([supplierKey, managedItems]) => {
    const buying = managedItems.filter(item => item.needsPurchase && item.suggestedInternalQuantity > 0);
    if (!buying.length) return [];
    const supplier = projection.suppliers.find(item => item.key === supplierKey)
      || { key: supplierKey, name: managedItems[0]?.supplier || 'Proveedor no asignado', taxId: '' };
    return [{
      supplier,
      confirmedOrder: null,
      buyingItems: buying.map(item => ({
        ...item,
        referenceUnitCost: roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost || 0),
        unitCost: roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost || 0),
        quantity: Number(item.suggestedPurchaseUnits || 0),
        selected: Number(item.suggestedPurchaseUnits || 0) > 0,
        total: Number(item.suggestedPurchaseUnits || 0) * roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost || 0)
      })),
      otherItems: managedItems.filter(item => !item.needsPurchase).map(item => ({
        ...item,
        noPurchaseReason: tentativeNoPurchaseReason(item)
      }))
    }];
  }).sort((left, right) => left.supplier.name.localeCompare(right.supplier.name, 'es'));
}

function currentTentativeOrderGroup() {
  const locationId = document.getElementById('tentative-orders-location').value;
  const supplierKey = document.getElementById('tentative-orders-supplier').value;
  const location = tentativePurchaseOrdersState?.locations.find(item => item.id === locationId);
  return location?.groups.find(group => group.supplier.key === supplierKey) || null;
}

function populateTentativeSupplierFilter(preferredSupplier = '') {
  const locationId = document.getElementById('tentative-orders-location').value;
  const location = tentativePurchaseOrdersState?.locations.find(item => item.id === locationId);
  const select = document.getElementById('tentative-orders-supplier');
  const options = (location?.groups || []).map(group => new Option(group.supplier.name, group.supplier.key));
  select.replaceChildren(...(options.length ? options : [new Option('Sin órdenes tentativas', '')]));
  select.disabled = !options.length;
  select.value = options.some(option => option.value === preferredSupplier) ? preferredSupplier : options[0]?.value || '';
}

function populateTentativeLocationFilter(preferredLocation = '') {
  const select = document.getElementById('tentative-orders-location');
  const locations = tentativePurchaseOrdersState?.locations || [];
  const options = locations.map(location => new Option(
    `${location.name}${location.groups.length ? '' : ' · sin compras sugeridas'}`, location.id
  ));
  select.replaceChildren(...options);
  const firstWithOrders = locations.find(location => location.groups.length)?.id || options[0]?.value || '';
  select.value = options.some(option => option.value === preferredLocation) ? preferredLocation : firstWithOrders;
  populateTentativeSupplierFilter();
}

function updateTentativeOrderTotals() {
  const group = currentTentativeOrderGroup();
  if (!group) {
    document.getElementById('tentative-order-total').textContent = '$0';
    document.getElementById('confirm-tentative-purchase-order').disabled = true;
    return;
  }
  let total = 0;
  const rows = [...document.querySelectorAll('#tentative-orders-buying-body tr[data-key]')];
  for (const row of rows) {
    const item = group.buyingItems.find(candidate => candidate.key === row.dataset.key);
    if (!item) continue;
    item.selected = row.querySelector('.tentative-order-select').checked;
    item.quantity = Number(row.querySelector('.tentative-order-quantity').value);
    item.unitCost = roundedPurchaseOrderCost(parseLocalizedNumber(row.querySelector('.tentative-order-cost').value));
    item.total = item.selected && Number.isFinite(item.quantity) && Number.isFinite(item.unitCost)
      ? item.quantity * item.unitCost : 0;
    row.querySelector('.tentative-order-row-total').textContent = formatClp(item.total);
    const warnings = [];
    if (!item.conversionAvailable) warnings.push('Sin conversión UDC');
    if (item.estimatedPurchaseUnitCost === null) warnings.push('Sin costo histórico');
    if (item.unitCost !== item.referenceUnitCost) warnings.push('Costo modificado');
    const packageWarning = purchaseQuantityPackageWarning(item, item.quantity);
    if (packageWarning) warnings.push(packageWarning);
    row.querySelector('.tentative-order-row-warning').textContent = warnings.join(' · ');
    row.classList.toggle('purchase-order-package-warning', Boolean(packageWarning));
    row.classList.toggle('purchase-order-row-excluded', !item.selected);
    total += item.total;
  }
  document.getElementById('tentative-order-total').textContent = formatClp(total);
  const selected = group.buyingItems.filter(item => item.selected);
  const summaryChips = document.querySelectorAll('#tentative-orders-summary .chip');
  if (summaryChips[1]) summaryChips[1].textContent = `${selected.length} incluido(s)`;
  document.getElementById('confirm-tentative-purchase-order').disabled = Boolean(group.confirmedOrder)
    || group.supplier.key === 'unassigned'
    || !selected.length
    || selected.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0
      || !Number.isFinite(item.unitCost) || item.unitCost < 0);
}

function renderTentativePurchaseOrderReview() {
  const review = document.getElementById('tentative-orders-review');
  if (!tentativePurchaseOrdersState) {
    review.hidden = true;
    return;
  }
  review.hidden = false;
  const location = tentativePurchaseOrdersState.locations.find(item =>
    item.id === document.getElementById('tentative-orders-location').value);
  const group = currentTentativeOrderGroup();
  const summary = document.getElementById('tentative-orders-summary');
  if (!location || !group) {
    summary.replaceChildren();
    document.getElementById('tentative-order-heading').textContent = 'Productos por comprar';
    document.getElementById('tentative-orders-buying-body').replaceChildren();
    document.getElementById('tentative-orders-other-body').replaceChildren();
    updateTentativeOrderTotals();
    return;
  }
  const selectedCount = group.buyingItems.filter(item => item.selected).length;
  summary.replaceChildren(...[
    `${group.buyingItems.length} ítem(s) sugeridos`,
    `${selectedCount} incluido(s)`,
    `${group.otherItems.length} no requieren compra`
  ].map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  document.getElementById('tentative-order-heading').textContent = `${location.name} · ${group.supplier.name}`;
  const disabled = Boolean(group.confirmedOrder);
  const buyingBody = document.getElementById('tentative-orders-buying-body');
  buyingBody.replaceChildren(...group.buyingItems.map(item => {
    const row = document.createElement('tr');
    row.dataset.key = item.key;
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.className = 'tentative-order-select'; checkbox.checked = item.selected; checkbox.disabled = disabled;
    checkbox.setAttribute('aria-label', `Incluir ${item.name}`);
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);
    [
      item.code || '—', item.name, formatProjectionMetric(item.currentInventory),
      item.currentCoverageDays === null ? 'Sin consumo' : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
      `${formatProjectionOneDecimal(item.suggestedInternalQuantity)} ${item.internalUnit || ''}`.trim(),
      formatProjectionQuantity(item.unitsPerPackage || 1),
      item.purchaseUnit || '—',
      item.conversionAvailable ? formatProjectionQuantity(item.unitsPerPurchaseUnit) : 'Sin conversión'
    ].forEach(value => {
      const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
    });
    const quantityCell = document.createElement('td');
    const quantity = document.createElement('input');
    quantity.type = 'number'; quantity.min = '0'; quantity.step = '1'; quantity.value = String(item.quantity);
    quantity.className = 'tentative-order-quantity'; quantity.disabled = disabled;
    quantity.setAttribute('aria-label', `Cantidad UDC de ${item.name}`);
    quantityCell.appendChild(quantity); row.appendChild(quantityCell);
    const costCell = document.createElement('td');
    const cost = document.createElement('input');
    cost.type = 'text'; cost.inputMode = 'numeric'; cost.value = formatPurchaseOrderCost(item.unitCost);
    cost.className = 'tentative-order-cost'; cost.disabled = disabled;
    cost.setAttribute('aria-label', `Costo UDC de ${item.name}`);
    costCell.appendChild(cost); row.appendChild(costCell);
    const totalCell = document.createElement('td'); totalCell.className = 'tentative-order-row-total'; row.appendChild(totalCell);
    const warningCell = document.createElement('td'); warningCell.className = 'tentative-order-row-warning'; row.appendChild(warningCell);
    return row;
  }));
  const otherBody = document.getElementById('tentative-orders-other-body');
  if (!group.otherItems.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td'); cell.colSpan = 8; cell.textContent = 'Todos los productos administrados de este proveedor están incluidos en la sugerencia de compra.';
    row.appendChild(cell); otherBody.replaceChildren(row);
  } else {
    otherBody.replaceChildren(...group.otherItems.map(item => {
      const row = document.createElement('tr');
      [
        item.code || '—', item.name, item.internalUnit || '—', formatProjectionMetric(item.currentInventory),
        item.currentCoverageDays === null ? 'Sin consumo' : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
        formatProjectionOneDecimal(item.minDays), formatProjectionOneDecimal(item.maxDays), item.noPurchaseReason
      ].forEach(value => {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      });
      return row;
    }));
  }
  const confirmButton = document.getElementById('confirm-tentative-purchase-order');
  confirmButton.textContent = group.confirmedOrder
    ? `Confirmada como ${group.confirmedOrder.orderNumber}` : 'Confirmar orden definitiva';
  confirmButton.classList.toggle('tentative-order-confirmed', Boolean(group.confirmedOrder));
  const printButton = document.getElementById('print-confirmed-tentative-order');
  printButton.hidden = !group.confirmedOrder;
  updateTentativeOrderTotals();
}

function openTentativePurchaseOrders() {
  const dialog = document.getElementById('tentative-purchase-orders-dialog');
  const scope = document.getElementById('tentative-orders-scope');
  const previous = scope.value || 'all';
  const locations = Object.values(locationRegistry)
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'es') : left.type === 'store' ? -1 : 1));
  scope.replaceChildren(new Option('Todas las ubicaciones', 'all'),
    ...locations.map(location => new Option(location.name, location.id)));
  scope.value = [...scope.options].some(option => option.value === previous) ? previous : 'all';
  if (tentativePurchaseOrdersState) renderTentativePurchaseOrderReview();
  dialog.showModal();
}

async function generateTentativePurchaseOrders() {
  const button = document.getElementById('generate-tentative-purchase-orders');
  const status = document.getElementById('tentative-purchase-orders-status');
  const scope = document.getElementById('tentative-orders-scope').value;
  const allLocations = Object.values(locationRegistry)
    .sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name, 'es') : left.type === 'store' ? -1 : 1));
  const requestedLocations = scope === 'all' ? allLocations : allLocations.filter(location => location.id === scope);
  if (!requestedLocations.length) return setStatus(status, 'Selecciona una ubicación válida.', 'error');
  const requestedLocationIds = new Set(requestedLocations.map(location => location.id));
  const previousLocations = tentativePurchaseOrdersState?.locations || [];
  const replacedTentativeCount = previousLocations
    .filter(location => requestedLocationIds.has(location.id))
    .reduce((sum, location) => sum + location.groups.filter(group => !group.confirmedOrder).length, 0);
  const retainedLocations = previousLocations.filter(location => !requestedLocationIds.has(location.id));
  button.disabled = true;
  document.getElementById('tentative-orders-review').hidden = true;
  setStatus(status, `Generando propuestas para ${requestedLocations.length} ubicación(es)…`);
  try {
    const results = await Promise.allSettled(requestedLocations.map(async location => ({
      location,
      projection: await apiRequest(`/api/purchase-projections?location=${encodeURIComponent(location.id)}`)
    })));
    const completed = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failures = results.filter(result => result.status === 'rejected');
    const regeneratedLocations = completed.map(({ location, projection }) => {
      const uniqueGroups = [...new Map(tentativeGroupsForProjection(projection)
        .map(group => [group.supplier.key, group])).values()];
      return {
        ...location,
        period: projection.period,
        branchLocationIds: projection.branchOrders?.selectedLocationIds || [],
        groups: uniqueGroups
      };
    });
    const locationOrder = new Map(allLocations.map((location, index) => [location.id, index]));
    tentativePurchaseOrdersState = {
      generatedAt: new Date().toISOString(),
      scope,
      locations: [...retainedLocations, ...regeneratedLocations]
        .sort((left, right) => (locationOrder.get(left.id) ?? 9999) - (locationOrder.get(right.id) ?? 9999))
    };
    const preferredLocation = scope !== 'all' ? scope : document.getElementById('projection-location-filter').value;
    populateTentativeLocationFilter(preferredLocation);
    renderTentativePurchaseOrderReview();
    const orderCount = regeneratedLocations.reduce((sum, location) => sum + location.groups.length, 0);
    const replacementNote = replacedTentativeCount
      ? ` Se reemplazaron ${replacedTentativeCount} tentativa(s) anterior(es) de las ubicaciones seleccionadas.`
      : '';
    const failureNote = failures.length ? ` ${failures.length} ubicación(es) no pudieron calcularse por falta de datos utilizables.` : '';
    setStatus(status, `${orderCount} orden(es) tentativa(s) generada(s) para ${completed.length} ubicación(es). Nada se ha guardado todavía.${replacementNote}${failureNote}`,
      orderCount ? 'success' : 'muted');
  } catch (error) {
    tentativePurchaseOrdersState = retainedLocations.length
      ? { ...tentativePurchaseOrdersState, locations: retainedLocations }
      : null;
    if (tentativePurchaseOrdersState) {
      populateTentativeLocationFilter();
      renderTentativePurchaseOrderReview();
    } else {
      document.getElementById('tentative-orders-review').hidden = true;
    }
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function confirmTentativePurchaseOrder() {
  const group = currentTentativeOrderGroup();
  const locationId = document.getElementById('tentative-orders-location').value;
  const location = tentativePurchaseOrdersState?.locations.find(item => item.id === locationId);
  const status = document.getElementById('tentative-purchase-orders-status');
  if (!group || !location || group.confirmedOrder) return;
  updateTentativeOrderTotals();
  const selected = group.buyingItems.filter(item => item.selected);
  if (!selected.length || selected.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0
    || !Number.isFinite(item.unitCost) || item.unitCost < 0)) {
    return setStatus(status, 'Selecciona al menos un ítem y revisa sus cantidades y costos.', 'error');
  }
  if (selected.some(item => item.unitCost !== item.referenceUnitCost)
    && !window.confirm('Modificaste uno o más costos respecto de la estimación. ¿Confirmas que deseas guardar la orden?')) return;
  const button = document.getElementById('confirm-tentative-purchase-order');
  button.disabled = true;
  try {
    const saved = await apiRequest('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: location.id,
        supplierKey: group.supplier.key,
        filters: { onlyRequired: true, onlyManaged: true, branchLocationIds: location.branchLocationIds },
        items: selected.map(item => ({ key: item.key, quantity: item.quantity, unitCost: item.unitCost }))
      })
    });
    group.confirmedOrder = saved;
    renderTentativePurchaseOrderReview();
    setStatus(status, `Orden tentativa confirmada y guardada como ${saved.orderNumber}.`, 'success');
    if (purchaseProjectionState?.location.id === location.id) await loadPurchaseProjection();
  } catch (error) {
    setStatus(status, error.message, 'error');
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
  const currentButton = document.getElementById('current-inventory-report');
  if (!location) {
    inventorySourceState = null;
    list.replaceChildren();
    processButton.disabled = true;
    currentButton.disabled = true;
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
    currentButton.disabled = !data.kardexPeriod;
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
    currentButton.disabled = true;
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
  ['waste-summary-results', 'consumption-summary-results', 'inventory-report-results', 'current-inventory-results']
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

function formatKardexQuantity(value, fractionDigits = 4) {
  return new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(Number(value) || 0);
}

function formatKardexTableQuantity(value) {
  const selected = Number(document.getElementById('inventory-kardex-decimals')?.value);
  return formatKardexQuantity(value, Number.isInteger(selected) && selected >= 1 && selected <= 4 ? selected : 2);
}

function kardexHeaderLines(label) {
  const words = String(label || '').trim().split(/\s+/);
  if (words.length < 2) return words;
  let bestIndex = 1;
  let smallestDifference = Infinity;
  for (let index = 1; index < words.length; index += 1) {
    const firstLength = words.slice(0, index).join(' ').length;
    const secondLength = words.slice(index).join(' ').length;
    const difference = Math.abs(firstLength - secondLength);
    if (difference < smallestDifference) {
      smallestDifference = difference;
      bestIndex = index;
    }
  }
  return [words.slice(0, bestIndex).join(' '), words.slice(bestIndex).join(' ')];
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
    { key: 'costSource', label: 'Origen costo', value: item => costSourceShort(item), total: '' },
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
    `${formatReportDate(report.dateFrom)} – ${formatReportDate(report.dateTo)} · solo ítems con adiciones distintas de cero.${report.itemsWithoutCost?.length ? ` ${report.itemsWithoutCost.length} ítem(s) sin costo de compra o maestro compatible.` : ''}`;
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
  if (withoutCost.length) reasons.push(`Ingredientes sin costo de compra o maestro: ${withoutCost.join(', ')}.`);
  if (withoutConversion.length) reasons.push(`Ingredientes con unidades incompatibles: ${withoutConversion.join(', ')}.`);
  if (Math.abs(difference) >= 1) reasons.push('La diferencia restante puede deberse a redondeos, tasas de rendimiento o a que productos e ingredientes tienen referencias de compra distintas.');
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
      { key: 'costSource', label: 'Origen costo', value: item => costSourceShort(item) },
      { key: 'totalCost', label: 'Costo total', value: item => formatClp(item.totalCost) }
    ], productRows, {
      code: 'TOTAL',
      quantity: formatInventoryQuantity(sumConsumptionRows(productRows, 'quantity')),
      totalCost: formatClp(sumConsumptionRows(productRows, 'totalCost'))
    }));
    if (data.products.productsWithoutMasterCost?.length) {
      const warning = document.createElement('p');
      warning.className = 'form-status muted';
      warning.textContent = `${data.products.productsWithoutMasterCost.length} producto(s) sin costo de compra o maestro compatible.`;
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
        { key: 'costSource', label: 'Origen costo', value: item => costSourceShort(item) },
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
    const headerLines = kardexHeaderLines(column.label);
    button.replaceChildren();
    headerLines.forEach((line, lineIndex) => {
      if (lineIndex) {
        button.appendChild(document.createElement('br'));
        button.appendChild(document.createTextNode(` ${line}`));
      } else {
        button.appendChild(document.createTextNode(line));
      }
    });
    if (active) button.appendChild(document.createTextNode(inventoryKardexTableState.direction === 'asc' ? ' ▲' : ' ▼'));
    button.title = column.label;
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
    else if (column.totalValue) cell.textContent = column.totalValue(items);
    totalRow.appendChild(cell);
  });
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);
  table.parentElement.scrollLeft = previousScrollLeft;
  document.getElementById('inventory-kardex-visible-count').textContent = `${items.length} de ${report.items.length} filas`;
}

function renderLac001SubstitutionReport(report) {
  const section = document.getElementById('inventory-lac001-substitution-report');
  if (!report) {
    section.hidden = true;
    return;
  }
  document.getElementById('inventory-lac001-substitution-period').textContent =
    `${formatReportDate(report.dateFrom)} – ${formatReportDate(report.dateTo)} · ventas con BX1010, BX1020 o BX1030.`;
  const summary = document.getElementById('inventory-lac001-substitution-summary');
  const summaryTexts = [
    `${report.salesCount} venta(s) con sustitución`,
    `${formatKardexQuantity(report.substitutionCount)} sustitución(es)`,
    `${formatKardexQuantity(report.lac001VolumeLiters)} L de LAC001 sustituido`,
    report.hasCost ? `${formatClp(report.totalSubstitutedCost || 0)} de costo sustituido` : 'LAC001 sin costo de compra o maestro compatible'
  ];
  if (report.unresolvedSubstitutionCount) {
    summaryTexts.push(`${formatKardexQuantity(report.unresolvedSubstitutionCount)} sin receta LAC001 identificable`);
  }
  if (report.warnings?.length) summaryTexts.push(`${report.warnings.length} archivo(s) de ventas no legible(s)`);
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));

  const table = document.getElementById('inventory-lac001-substitution-table');
  const columns = [
    { label: 'Código extra', value: item => item.code },
    { label: 'Extra', value: item => item.name },
    { label: 'Ventas con extra', value: item => String(item.salesCount) },
    { label: 'Cantidad de sustituciones', value: item => formatKardexQuantity(item.substitutionCount) },
    { label: 'LAC001 sustituido (L)', value: item => formatKardexQuantity(item.lac001VolumeLiters) },
    { label: 'Origen costo', value: item => costSourceShort(item) },
    { label: 'Costo LAC001 sustituido', value: item => item.hasCost ? formatClp(item.substitutedCost) : 'Sin costo' }
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
  report.items.forEach(item => {
    const row = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('td');
      cell.textContent = column.value(item);
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  const footRow = document.createElement('tr');
  footRow.className = 'consumption-total-row';
  ['TOTAL', '', String(report.salesCount), formatKardexQuantity(report.substitutionCount), `${formatKardexQuantity(report.lac001VolumeLiters)} L`, costSourceShort(report), report.hasCost ? formatClp(report.totalSubstitutedCost || 0) : 'Sin costo']
    .forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      footRow.appendChild(cell);
    });
  const foot = document.createElement('tfoot');
  foot.appendChild(footRow);
  table.replaceChildren(head, body, foot);
  section.hidden = false;
}

function appendExpandableTableText(cell, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'inventory-expandable-text';
  const text = document.createElement('span');
  text.className = 'inventory-expandable-value';
  text.textContent = value;
  text.title = value;
  const toggle = document.createElement('button');
  toggle.className = 'inventory-expandable-toggle';
  toggle.type = 'button';
  toggle.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Mostrar todos los productos');
  toggle.addEventListener('click', () => {
    const expanded = wrapper.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Contraer productos' : 'Mostrar todos los productos');
  });
  wrapper.append(text, toggle);
  cell.appendChild(wrapper);
  requestAnimationFrame(() => {
    toggle.hidden = text.scrollWidth <= text.clientWidth;
  });
}

function renderSyrupSauceSubstitutionReport(report) {
  const section = document.getElementById('inventory-syrup-substitution-report');
  if (!report) {
    section.hidden = true;
    return;
  }
  document.getElementById('inventory-syrup-substitution-period').textContent =
    `${formatReportDate(report.dateFrom)} – ${formatReportDate(report.dateTo)} · extras de ${report.targetHierarchy || 'BA.090'}.`;
  const summaryTexts = [
    `${report.salesCount} venta(s) con sustitución`,
    `${formatKardexQuantity(report.substitutionCount)} sustitución(es)`,
    `${formatKardexQuantity(report.matchedSubstitutionCount)} con ingrediente original identificado`,
    `${formatClp(report.totalSubstitutedCost || 0)} de costo sustituido`
  ];
  if (report.unresolvedSubstitutionCount) {
    summaryTexts.push(`${formatKardexQuantity(report.unresolvedSubstitutionCount)} sin ingrediente identificable`);
  }
  if (report.itemsWithoutCost?.length) {
    summaryTexts.push(`${report.itemsWithoutCost.length} ingrediente(s) sin costo de compra o maestro compatible`);
  }
  const summary = document.getElementById('inventory-syrup-substitution-summary');
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));

  const columns = [
    { label: 'Código extra', value: item => item.replacementCode },
    { label: 'Extra sustituto', value: item => item.replacementName },
    { label: 'Ingrediente original', value: item => `${item.originalCode ? `${item.originalCode} · ` : ''}${item.originalName}` },
    {
      label: 'Producto(s)',
      value: item => item.baseProducts.map(product => `${product.code} · ${product.name}`).join(', ') || 'Sin producto base identificable',
      expandable: true
    },
    { label: 'Ventas', value: item => String(item.salesCount) },
    { label: 'Sustituciones', value: item => formatKardexQuantity(item.substitutionCount) },
    {
      label: 'Cantidad teórica sustituida',
      value: item => item.status === 'resolved'
        ? `${formatKardexQuantity(item.theoreticalQuantity)} ${item.unit}`
        : 'Sin cantidad identificable'
    },
    { label: 'Origen costo', value: item => costSourceShort(item) },
    { label: 'Costo sustituido', value: item => item.hasCost ? formatClp(item.substitutedCost) : 'Sin costo' }
  ];
  const table = document.getElementById('inventory-syrup-substitution-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach(column => {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  if (report.items.length) {
    report.items.forEach(item => {
      const row = document.createElement('tr');
      columns.forEach(column => {
        const cell = document.createElement('td');
        const value = column.value(item);
        if (column.expandable) {
          cell.className = 'inventory-products-cell';
          appendExpandableTableText(cell, value);
        } else {
          cell.textContent = value;
        }
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  } else {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = 'No se registraron extras BA.090 durante este período.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  const totals = (report.totalsByUnit || [])
    .map(item => `${formatKardexQuantity(item.quantity)} ${item.unit}`).join(' · ');
  const foot = document.createElement('tfoot');
  const footRow = document.createElement('tr');
  footRow.className = 'consumption-total-row';
  ['TOTAL', '', '', '', String(report.salesCount), formatKardexQuantity(report.substitutionCount), totals || 'Sin cantidad conciliada', '', formatClp(report.totalSubstitutedCost || 0)]
    .forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      footRow.appendChild(cell);
    });
  foot.appendChild(footRow);
  table.replaceChildren(head, body, foot);
  section.hidden = false;
}

function renderInventoryAvoidedPackagingReport(report) {
  const section = document.getElementById('inventory-avoided-packaging-report');
  if (!report) {
    section.hidden = true;
    return;
  }
  const coverage = report.totalOrders ? report.matchedOrders / report.totalOrders * 100 : 0;
  document.getElementById('inventory-avoided-packaging-period').textContent =
    `${formatReportDate(report.dateFrom)} – ${formatReportDate(report.dateTo)} · ${report.matchedOrders} de ${report.totalOrders} pedidos relacionados con Detalle Pagos (${coverage.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%).`;
  const packaging = report.avoidedDisposablePackaging || report.avoidedDisposableCups || [];
  const totalQuantity = packaging.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const summaryTexts = [
    `${report.dineInOrders} pedido(s) servido(s) en el local`,
    `${formatKardexQuantity(totalQuantity)} unidad(es) desechable(s) no utilizada(s)`,
    `${formatClp(report.totalAvoidedPackagingCost || 0)} de ahorro valorizado`
  ];
  if (report.packagingWithoutCost?.length) {
    summaryTexts.push(`${report.packagingWithoutCost.length} tipo(s) sin costo de compra o maestro`);
  }
  if (report.productsWithoutRecipe?.length) {
    summaryTexts.push(`${report.productsWithoutRecipe.length} producto(s) sin receta`);
  }
  if (!report.paymentDetailsFilesRead) summaryTexts.push('Sin archivo de Detalle Pagos');
  const summary = document.getElementById('inventory-avoided-packaging-summary');
  summary.replaceChildren(...summaryTexts.map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));

  const columns = [
    { label: 'Tipo', value: item => item.kind === 'lid' ? 'Tapa' : 'Vaso' },
    { label: 'Código', value: item => item.code || '' },
    { label: 'Insumo desechable', value: item => item.name },
    { label: 'Cantidad no utilizada', value: item => `${formatKardexQuantity(item.quantity)} ${item.unit || 'UN'}` },
    { label: 'Costo unitario', value: item => item.hasCost ? formatClp(item.unitCost) : 'Sin costo' },
    { label: 'Origen costo', value: item => costSourceShort(item) },
    { label: 'Ahorro valorizado', value: item => item.hasCost ? formatClp(item.totalCost) : 'Sin costo' }
  ];
  const table = document.getElementById('inventory-avoided-packaging-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach(column => {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  if (packaging.length) {
    packaging.forEach(item => {
      const row = document.createElement('tr');
      columns.forEach(column => {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  } else {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = report.paymentDetailsFilesRead
      ? 'No se identificaron vasos ni tapas evitados durante este período.'
      : 'No hay Detalle Pagos disponible para identificar pedidos servidos en el local.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  const foot = document.createElement('tfoot');
  const footRow = document.createElement('tr');
  footRow.className = 'consumption-total-row';
  ['TOTAL', '', '', `${formatKardexQuantity(totalQuantity)} UN`, '', formatClp(report.totalAvoidedPackagingCost || 0)]
    .forEach(value => {
      const cell = document.createElement('td');
      cell.textContent = value;
      footRow.appendChild(cell);
    });
  foot.appendChild(footRow);
  table.replaceChildren(head, body, foot);
  section.hidden = false;
}

function renderInventoryResults(data) {
  const report = data.report;
  const physicalInventoryQuantity = item => report.selection ? item.finalInventory : item.physicalFinal;
  const inventoryValue = (item, quantity) => (Number(quantity) || 0) * (Number(item.unitCost) || 0);
  const totalInventoryValue = (items, quantity) => formatKardexCost(items.reduce(
    (sum, item) => item.costAvailable ? sum + inventoryValue(item, quantity(item)) : sum,
    0
  ));
  renderConsumptionReports(data.consumption);
  const wasteSection = document.getElementById('inventory-waste-report');
  if (data.waste?.available && data.waste.report) {
    document.getElementById('inventory-waste-period').textContent =
      `${formatReportDate(data.waste.report.dateFrom)} – ${formatReportDate(data.waste.report.dateTo)} · ${data.waste.report.itemCount} ítem(s) con adiciones.${data.waste.report.itemsWithoutCost?.length ? ` ${data.waste.report.itemsWithoutCost.length} ítem(s) sin costo de compra o maestro compatible.` : ''}`;
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
      label: 'Origen costo',
      value: item => costSourceShort(item),
      sortValue: item => `${item.costSource || ''}:${item.costSourceDate || ''}`
    },
    {
      label: report.selection
        ? `${basisLabel(report.selection.initialBasis)} ${formatReportDate(report.selection.initialDate)}`
        : 'Inventario inicial',
      value: item => formatKardexTableQuantity(item.initialInventory),
      sortValue: item => Number(item.initialInventory) || 0
    },
    ...report.movementDefinitions.map(definition => ({
      label: definition.label,
      value: item => formatKardexTableQuantity(item.movements[definition.key]),
      sortValue: item => Number(item.movements[definition.key]) || 0
    })),
    { label: 'Consumo Colaboradores', value: item => formatKardexTableQuantity(item.employeeConsumption), sortValue: item => Number(item.employeeConsumption) || 0 },
    { label: 'Consumo Marketing', value: item => formatKardexTableQuantity(item.marketingConsumption), sortValue: item => Number(item.marketingConsumption) || 0 },
    ...(report.selection ? [
      {
        label: 'Inventario Final Teórico',
        value: item => formatKardexTableQuantity(item.theoreticalFinal),
        sortValue: item => Number(item.theoreticalFinal) || 0
      },
      {
        label: `${basisLabel(report.selection.finalBasis)} ${formatReportDate(report.selection.finalDate)}`,
        value: item => formatKardexTableQuantity(item.finalInventory),
        sortValue: item => Number(item.finalInventory) || 0
      }
    ] : [
      { label: 'Inventario final teórico', value: item => formatKardexTableQuantity(item.theoreticalFinal), sortValue: item => Number(item.theoreticalFinal) || 0 },
      { label: `Inventario físico ${formatReportDate(report.physicalInventoryDate)}`, value: item => formatKardexTableQuantity(item.physicalFinal), sortValue: item => Number(item.physicalFinal) || 0 }
    ]),
    {
      label: report.selection ? 'Diferencia de Inventario' : 'Diferencia físico − teórico',
      value: item => formatKardexTableQuantity(item.difference),
      sortValue: item => Number(item.difference) || 0,
      signValue: item => item.difference,
      finalDifference: true
    },
    {
      label: 'Costo Total',
      value: item => item.costAvailable ? formatKardexCost(item.totalCost) : 'Sin costo',
      sortValue: item => item.costAvailable ? Number(item.totalCost) || 0 : null,
      totalValue: items => formatKardexCost(items.reduce((sum, item) => sum + (Number(item.totalCost) || 0), 0))
    },
    {
      label: 'Valor Inventario Final Teórico',
      value: item => item.costAvailable ? formatKardexCost(inventoryValue(item, item.theoreticalFinal)) : 'Sin costo',
      sortValue: item => item.costAvailable ? inventoryValue(item, item.theoreticalFinal) : null,
      totalValue: items => totalInventoryValue(items, item => item.theoreticalFinal)
    },
    {
      label: 'Valor Inventario Físico',
      value: item => item.costAvailable ? formatKardexCost(inventoryValue(item, physicalInventoryQuantity(item))) : 'Sin costo',
      sortValue: item => item.costAvailable ? inventoryValue(item, physicalInventoryQuantity(item)) : null,
      totalValue: items => totalInventoryValue(items, physicalInventoryQuantity)
    }
  ];
  document.getElementById('inventory-kardex-search').value = '';
  document.getElementById('inventory-kardex-cost-filter').value = 'all';
  document.getElementById('inventory-kardex-cost-min').value = '';
  document.getElementById('inventory-kardex-cost-max').value = '';
  inventoryKardexTableState = { report, columns, sortIndex: 0, direction: 'asc' };
  renderInventoryKardexTable();
  renderLac001SubstitutionReport(data.lac001Substitutions);
  renderSyrupSauceSubstitutionReport(data.syrupSauceSubstitutions);
  renderInventoryAvoidedPackagingReport(data.avoidedPackaging);
  document.getElementById('inventory-report-results').showModal();
}

function currentInventoryColumns() {
  return [
    { label: 'Jerarquía', value: item => item.hierarchyPath.join(' › '), sortValue: item => item.hierarchyPath.join(' › ') },
    { label: 'Código', value: item => item.code, sortValue: item => item.code },
    { label: 'Producto', value: item => item.name, sortValue: item => item.name },
    { label: 'Unidad', value: item => item.unit, sortValue: item => item.unit },
    { label: 'Inventario teórico', value: item => formatKardexQuantity(item.quantity, 2), sortValue: item => Number(item.quantity) || 0 },
    { label: 'Costo unitario', value: item => item.costAvailable ? formatKardexCost(item.unitCost) : 'Sin costo', sortValue: item => item.costAvailable ? Number(item.unitCost) || 0 : null },
    { label: 'Origen costo', value: item => costSourceShort(item), sortValue: item => `${item.costSource || ''}:${item.costSourceDate || ''}` },
    { label: 'Valorización', value: item => item.costAvailable ? formatKardexCost(item.valuation) : 'Sin costo', sortValue: item => item.costAvailable ? Number(item.valuation) || 0 : null }
  ];
}

function renderCurrentInventoryTable(table, items, missingCost = false) {
  const { columns, sortIndex, direction } = currentInventoryTableState;
  const headRow = document.createElement('tr');
  columns.forEach((column, index) => {
    const cell = document.createElement('th');
    const active = index === sortIndex;
    cell.setAttribute('aria-sort', active ? direction === 'asc' ? 'ascending' : 'descending' : 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inventory-sort-button${active ? ' active' : ''}`;
    button.textContent = `${column.label}${active ? direction === 'asc' ? ' ▲' : ' ▼' : ''}`;
    button.title = `Ordenar por ${column.label}`;
    button.addEventListener('click', () => {
      if (currentInventoryTableState.sortIndex === index) {
        currentInventoryTableState.direction = currentInventoryTableState.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentInventoryTableState.sortIndex = index;
        currentInventoryTableState.direction = 'asc';
      }
      renderCurrentInventoryTables();
    });
    cell.appendChild(button);
    headRow.appendChild(cell);
  });
  const head = document.createElement('thead');
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  let previousHierarchy = null;
  items.forEach(item => {
    const hierarchy = item.hierarchyPath.join(' › ');
    const row = document.createElement('tr');
    if (hierarchy !== previousHierarchy) row.classList.add('current-inventory-group-start');
    columns.forEach(column => {
      const cell = document.createElement('td');
      cell.textContent = column.value(item);
      row.appendChild(cell);
    });
    body.appendChild(row);
    previousHierarchy = hierarchy;
  });
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = 'No hay productos que coincidan con la búsqueda.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  const totalRow = document.createElement('tr');
  totalRow.className = 'consumption-total-row';
  columns.forEach((column, index) => {
    const cell = document.createElement('td');
    if (index === 0) cell.textContent = missingCost ? 'TOTAL SIN COSTO' : 'TOTAL VALORIZADO';
    if (index === columns.length - 1) {
      cell.textContent = missingCost
        ? 'Sin valorizar'
        : formatKardexCost(items.reduce((sum, item) => sum + (Number(item.valuation) || 0), 0));
    }
    totalRow.appendChild(cell);
  });
  const foot = document.createElement('tfoot');
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);
}

function renderCurrentInventoryTables() {
  if (!currentInventoryTableState) return;
  const { data, columns, sortIndex, direction } = currentInventoryTableState;
  const query = normalizedInventorySearch(document.getElementById('current-inventory-search').value);
  const matches = item => !query || normalizedInventorySearch(`${item.code} ${item.name}`).includes(query);
  const compareItems = (left, right) => {
    const leftValue = columns[sortIndex].sortValue(left);
    const rightValue = columns[sortIndex].sortValue(right);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), 'es', { numeric: true, sensitivity: 'base' });
    return (comparison || left.name.localeCompare(right.name, 'es', { sensitivity: 'base' })
      || left.code.localeCompare(right.code, 'es', { numeric: true })) * (direction === 'desc' ? -1 : 1);
  };
  const visibleItems = data.report.items.filter(matches).sort(compareItems);
  const valuedItems = visibleItems.filter(item => item.costAvailable);
  const missingItems = visibleItems.filter(item => !item.costAvailable);
  renderCurrentInventoryTable(document.getElementById('current-inventory-table'), valuedItems);
  renderCurrentInventoryTable(document.getElementById('current-inventory-missing-cost-table'), missingItems, true);
  document.getElementById('current-inventory-visible-count').textContent =
    `${valuedItems.length} valorizado(s) · ${missingItems.length} sin costo`;
  document.getElementById('current-inventory-missing-cost-note').textContent =
    `${data.report.itemsWithoutCost.length} producto(s) o insumo(s) no participan de la valorización porque no tienen un costo de compra o maestro compatible.`;
}

function renderCurrentInventoryReport(data) {
  const report = data.report;
  const valuedCount = report.items.filter(item => item.costAvailable).length;
  const missingCount = report.itemCount - valuedCount;
  currentInventoryTableState = { data, columns: currentInventoryColumns(), sortIndex: 0, direction: 'asc' };
  document.getElementById('current-inventory-search').value = '';
  document.getElementById('current-inventory-missing-cost').hidden = missingCount === 0;
  renderCurrentInventoryTables();
  const basis = report.balanceBasis === 'final' ? 'Inventario Final (IF)' : 'Inventario Inicial (II)';
  document.getElementById('current-inventory-period').textContent =
    `${basis} · Fecha solicitada: ${formatReportDate(data.referenceDate)} · Fecha del inventario utilizada: ${formatReportDate(report.date)} · ${report.hierarchyCount} jerarquía(s).`;
  document.getElementById('current-inventory-item-count').textContent = `${valuedCount} valorizados · ${missingCount} sin costo`;
  document.getElementById('current-inventory-total').textContent = `Valor total: ${formatKardexCost(report.totalValue)}`;
  const warning = document.getElementById('current-inventory-warning');
  warning.textContent = (data.warnings || []).join(' ');
  warning.hidden = !warning.textContent;
  closeInventoryResultDialogs();
  document.getElementById('current-inventory-results').showModal();
}

function openCurrentInventoryDateDialog() {
  const today = isoLocalDate(new Date());
  const input = document.getElementById('current-inventory-date');
  const firstKardexDate = inventorySourceState?.kardexPeriod?.firstDate || '';
  input.value = today;
  input.max = today;
  input.min = firstKardexDate && firstKardexDate <= today ? firstKardexDate : '';
  setStatus(document.getElementById('current-inventory-date-status'), '');
  document.getElementById('current-inventory-date-dialog').showModal();
}

async function generateCurrentInventoryReport() {
  const status = document.getElementById('inventory-source-status');
  const dialog = document.getElementById('current-inventory-date-dialog');
  const dialogStatus = document.getElementById('current-inventory-date-status');
  const button = document.getElementById('confirm-current-inventory-report');
  const location = document.getElementById('inventory-location-select').value;
  const referenceDate = document.getElementById('current-inventory-date').value;
  const today = isoLocalDate(new Date());
  if (!referenceDate) return setStatus(dialogStatus, 'Selecciona una fecha de referencia.', 'error');
  if (referenceDate > today) return setStatus(dialogStatus, 'La fecha de referencia no puede ser posterior a hoy.', 'error');
  button.disabled = true;
  setStatus(status, `Leyendo el saldo teórico disponible al ${formatReportDate(referenceDate)}…`);
  setStatus(dialogStatus, 'Generando inventario…');
  try {
    const data = await apiRequest(`/api/inventory/current?location=${encodeURIComponent(location)}&date=${encodeURIComponent(referenceDate)}`);
    dialog.close();
    renderCurrentInventoryReport(data);
    setStatus(status, `Inventario teórico al ${formatReportDate(data.report.date)} generado correctamente.`, 'success');
  } catch (error) {
    setStatus(dialogStatus, error.message, 'error');
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
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
    const [data, company] = await Promise.all([
      apiRequest('/api/config/locations'),
      apiRequest('/api/config/company')
    ]);
    document.getElementById('company-name').value = company.name || 'CODE SPA';
    document.getElementById('company-tax-id').value = company.taxId || '';
    exportDecimalSystem = company.exportDecimalSystem === 'dot' ? 'dot' : 'comma';
    document.getElementById('company-export-decimal-system').value = exportDecimalSystem;
    locationRegistry = Object.fromEntries(data.active.map(location => [location.id, location]));
    refreshReportLocationFilter();
    refreshSalesDashboardLocationFilter();
    refreshFindingsLocationFilter();
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
    const addressInput = document.createElement('input');
    addressInput.value = location.address || '';
    addressInput.maxLength = 200;
    addressInput.placeholder = 'Dirección para órdenes de compra';
    addressInput.setAttribute('aria-label', `Dirección de ${location.name}`);
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
          body: JSON.stringify({ name: nameInput.value, address: addressInput.value })
        });
        setStatus(document.getElementById('location-status'), 'Nombre y dirección actualizados.', 'success');
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
    row.append(nameInput, addressInput, type, saveButton, trashButton);
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

function showInspection(manifest, { openDialog = true } = {}) {
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
  const salesOnlyUpload = manifest.files.length > 0 && manifest.files.every(file => file.field === 'sales');
  document.getElementById('date-confirmation-row').hidden = salesOnlyUpload;
  const inventoryFile = manifest.files.find(file => file.structure?.requiresCategoryConfirmation);
  const inventoryConfirmation = document.getElementById('inventory-file-confirmation-row');
  document.getElementById('inventory-file-confirmed').checked = false;
  inventoryConfirmation.hidden = !inventoryFile;
  if (inventoryFile) {
    const category = inventoryFile.field === 'waste' ? 'Merma' : 'Kardex / tarjeta de inventario';
    document.getElementById('inventory-file-confirmation-copy').textContent =
      `Confirmo que “${inventoryFile.originalName}” es el archivo correcto para cargar como ${category}.`;
  }
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
  if (openDialog) confirmation.showModal();
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
      table.className = 'preview-table';
      const frozenRows = Math.min(2, Math.max(0, Number(sheet.frozenRows) || 0));
      sheet.rows.forEach((values, rowIndex) => {
        const row = document.createElement('tr');
        if (rowIndex < frozenRows) row.dataset.frozenRow = String(rowIndex);
        values.forEach(value => {
          const cell = document.createElement(rowIndex < frozenRows ? 'th' : 'td');
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
        notice.textContent = 'Vista limitada a 400 filas y 400 columnas.';
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
  if (table.id === 'current-inventory-table') return 'Inventario valorizado';
  if (table.id === 'current-inventory-missing-cost-table') return 'Productos sin costo';
  if (table.id === 'inventory-waste-table' || table.id === 'waste-summary-table') return 'Merma';
  if (table.id === 'inventory-lac001-substitution-table') return 'Sustitución LAC001';
  if (table.id === 'inventory-syrup-substitution-table') return 'Sustitución syrup-salsas';
  if (table.id === 'inventory-avoided-packaging-table') return 'Packaging no utilizado';
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
    writeConfiguredExcelWorkbook(workbook, inventoryReportFilename(title, 'xlsx'));
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
  initializeSidebarToggle();
  syncHourlyDemandControls();
  document.body.appendChild(document.getElementById('date-confirmation'));
  document.querySelectorAll('.nav-link').forEach(link => {
    const linkLabel = link.querySelector('.nav-text')?.textContent.trim() || '';
    link.title = linkLabel;
    link.setAttribute('aria-label', linkLabel);
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
  document.getElementById('report-download-toteat-sales').addEventListener('click', downloadReportSalesFromToteat);
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
  document.getElementById('run-findings').addEventListener('click', loadFindingsView);
  document.getElementById('findings-status-filter').addEventListener('change', renderFindingsView);
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
  document.getElementById('sales-service-mode-period').addEventListener('change', () => {
    syncSalesServiceModeControls();
    renderSalesServiceModes();
  });
  document.getElementById('apply-sales-service-mode-range').addEventListener('click', loadSalesDashboard);
  document.getElementById('sales-hierarchy-back').addEventListener('click', () => {
    salesHierarchyPath = salesHierarchyPath.slice(0, -1);
    renderSalesInsights();
  });
  document.getElementById('refresh-hourly-demand').addEventListener('click', loadHourlySalesDemand);
  document.getElementById('generate-hourly-analysis').addEventListener('click', openHourlyAnalysisOptions);
  document.getElementById('hourly-analysis-options-dialog').addEventListener('click', event => {
    const option = event.target.closest('[data-hourly-analysis-level]');
    if (option) loadHourlyAnalysis(option.dataset.hourlyAnalysisLevel);
  });
  document.getElementById('close-hourly-analysis-options').addEventListener('click', () => {
    document.getElementById('hourly-analysis-options-dialog').close();
  });
  document.getElementById('hourly-demand-mode').addEventListener('change', syncHourlyDemandControls);
  document.getElementById('hourly-demand-back').addEventListener('click', () => {
    if (hourlySalesProductKey) hourlySalesProductKey = null;
    else hourlySalesHierarchyPath = hourlySalesHierarchyPath.slice(0, -1);
    renderHourlySalesDemand();
  });
  document.getElementById('close-hourly-demand-chart').addEventListener('click', () => {
    document.getElementById('hourly-demand-chart-dialog').close();
  });
  document.getElementById('close-hourly-analysis').addEventListener('click', () => {
    document.getElementById('hourly-analysis-dialog').close();
  });
  document.getElementById('print-hourly-analysis').addEventListener('click', printHourlyAnalysis);
  document.getElementById('hourly-demand-chart-order').addEventListener('change', () => {
    if (document.getElementById('hourly-demand-chart-dialog').open) openHourlyDemandChart();
  });
  document.getElementById('products-location-filter').addEventListener('change', () => {
    document.getElementById('products-comparison').hidden = true;
    document.getElementById('relevant-products-dialog').close();
    loadProductsView();
  });
  document.getElementById('products-search').addEventListener('input', renderProductsView);
  document.getElementById('products-grouping').addEventListener('change', renderProductsView);
  document.getElementById('refresh-products').addEventListener('click', loadProductsView);
  document.getElementById('open-relevant-products-report').addEventListener('click', openRelevantProductsReport);
  document.getElementById('open-product-analysis').addEventListener('click', openProductAnalysisConfig);
  document.getElementById('close-product-analysis-config').addEventListener('click', () => {
    document.getElementById('product-analysis-config-dialog').close();
  });
  document.getElementById('product-analysis-location').addEventListener('change', event => {
    loadProductAnalysisOptions(event.target.value || 'all');
  });
  document.getElementById('product-analysis-period').addEventListener('change', syncProductAnalysisPeriod);
  document.getElementById('generate-product-analysis').addEventListener('click', generateProductAnalysis);
  document.getElementById('close-product-analysis').addEventListener('click', () => {
    document.getElementById('product-analysis-dialog').close();
  });
  document.getElementById('print-product-analysis').addEventListener('click', printProductAnalysis);
  document.getElementById('export-product-analysis').addEventListener('click', exportProductAnalysis);
  document.getElementById('close-relevant-products-report').addEventListener('click', () => {
    document.getElementById('relevant-products-dialog').close();
  });
  document.getElementById('print-relevant-products-report').addEventListener('click', printRelevantProductsReport);
  document.getElementById('export-relevant-products-report').addEventListener('click', exportRelevantProductsReport);
  document.getElementById('products-hierarchy-list').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(productsSort, header.dataset.sortKey, ['price', 'netPrice', 'cost', 'marginPercent', 'averageWeeklyUnits8', 'unitsLast7Days', 'unitsChangePercent'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderProductsView();
    if (document.getElementById('relevant-products-dialog').open) renderRelevantProductsReport();
  });
  document.getElementById('relevant-products-hierarchy-list').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(productsSort, header.dataset.sortKey, ['price', 'netPrice', 'cost', 'marginPercent', 'averageWeeklyUnits8', 'unitsLast7Days', 'unitsChangePercent'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderProductsView();
    renderRelevantProductsReport();
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
  document.getElementById('ingredients-ranking-limit').addEventListener('change', renderIngredientsView);
  document.getElementById('refresh-ingredients').addEventListener('click', loadIngredientsView);
  document.getElementById('print-ingredients-report').addEventListener('click', printIngredientsReport);
  document.getElementById('export-ingredients-report').addEventListener('click', exportIngredientsReport);
  document.querySelector('.ingredients-table thead').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(ingredientsSort, header.dataset.sortKey, ['unitCost', 'latestPurchaseCost', 'costChangePercent', 'usageQuantity', 'usageCost', 'products.length'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderIngredientsView();
  });
  document.getElementById('ingredients-table-body').addEventListener('click', event => {
    const detailHeader = event.target.closest('.ingredient-products-detail th[data-sort-key]');
    if (detailHeader) {
      const ingredientCode = detailHeader.closest('table')?.dataset.ingredientCode;
      if (!ingredientCode) return;
      const sortState = ingredientProductSorts.get(ingredientCode) || { key: 'name', direction: 'asc' };
      const numericKeys = new Set([
        'recipeQuantity', 'yieldRate', 'effectiveQuantity', 'periodProductQuantity', 'periodIngredientEffectiveQuantity'
      ]);
      applySort(sortState, detailHeader.dataset.sortKey, numericKeys.has(detailHeader.dataset.sortKey) ? 'desc' : 'asc');
      ingredientProductSorts.set(ingredientCode, sortState);
      renderIngredientsView();
      return;
    }
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
    purchaseProjectionState = null;
    loadPurchaseProjection();
  });
  document.getElementById('projection-supplier-filter').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-required').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-managed').addEventListener('change', renderPurchaseProjection);
  document.getElementById('refresh-purchase-projection').addEventListener('click', loadPurchaseProjection);
  document.getElementById('open-projection-branch-orders').addEventListener('click', openProjectionBranchOrders);
  document.getElementById('cancel-projection-branch-orders').addEventListener('click', () => {
    document.getElementById('projection-branch-orders-dialog').close();
  });
  document.getElementById('apply-projection-branch-orders').addEventListener('click', applyProjectionBranchOrders);
  document.getElementById('open-projection-purchase-orders').addEventListener('click', openProjectionPurchaseOrders);
  document.getElementById('cancel-projection-purchase-orders').addEventListener('click', () => {
    document.getElementById('projection-purchase-orders-dialog').close();
  });
  document.getElementById('apply-projection-purchase-orders').addEventListener('click', applyProjectionPurchaseOrders);
  document.querySelector('.purchase-projection-table thead').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchaseProjectionSort, header.dataset.sortKey,
      ['managed', 'unitsPerPackage', 'currentInventory', 'consumption30', 'averageDailyConsumption', 'currentCoverageDays', 'minDays', 'maxDays', 'suggestedInternalQuantity', 'unitsPerPurchaseUnit', 'suggestedPurchaseUnits', 'estimatedPurchaseUnitCost', 'estimatedTotal'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderPurchaseProjection();
  });
  document.getElementById('save-projection-policies').addEventListener('click', savePurchaseProjectionPolicies);
  document.getElementById('print-purchase-order').addEventListener('click', openPurchaseOrderEditor);
  document.getElementById('past-purchase-orders').addEventListener('click', openPastPurchaseOrders);
  document.getElementById('open-tentative-purchase-orders').addEventListener('click', openTentativePurchaseOrders);
  document.getElementById('close-tentative-purchase-orders').addEventListener('click', () => {
    document.getElementById('tentative-purchase-orders-dialog').close();
  });
  document.getElementById('generate-tentative-purchase-orders').addEventListener('click', generateTentativePurchaseOrders);
  document.getElementById('tentative-orders-location').addEventListener('change', () => {
    populateTentativeSupplierFilter();
    renderTentativePurchaseOrderReview();
  });
  document.getElementById('tentative-orders-supplier').addEventListener('change', renderTentativePurchaseOrderReview);
  document.getElementById('tentative-orders-buying-body').addEventListener('input', updateTentativeOrderTotals);
  document.getElementById('tentative-orders-buying-body').addEventListener('change', event => {
    if (event.target.matches('.tentative-order-cost')) {
      event.target.value = formatPurchaseOrderCost(roundedPurchaseOrderCost(parseLocalizedNumber(event.target.value)));
    }
    updateTentativeOrderTotals();
  });
  document.getElementById('confirm-tentative-purchase-order').addEventListener('click', confirmTentativePurchaseOrder);
  document.getElementById('print-confirmed-tentative-order').addEventListener('click', () => {
    const group = currentTentativeOrderGroup();
    if (group?.confirmedOrder) printPurchaseOrder(group.confirmedOrder);
  });
  document.getElementById('show-hidden-purchase-orders').addEventListener('change', openPastPurchaseOrders);
  document.getElementById('close-purchase-order-editor').addEventListener('click', () => {
    document.getElementById('purchase-order-editor-dialog').close();
  });
  document.getElementById('close-past-purchase-orders').addEventListener('click', () => {
    document.getElementById('past-purchase-orders-dialog').close();
  });
  document.getElementById('purchase-order-editor-body').addEventListener('input', updatePurchaseOrderEditorTotals);
  document.getElementById('purchase-order-editor-body').addEventListener('change', event => {
    if (event.target.matches('.purchase-order-cost')) {
      event.target.value = formatPurchaseOrderCost(roundedPurchaseOrderCost(parseLocalizedNumber(event.target.value)));
    }
    updatePurchaseOrderEditorTotals();
  });
  document.getElementById('confirm-purchase-order').addEventListener('click', confirmPurchaseOrder);
  document.getElementById('print-saved-purchase-order').addEventListener('click', () => printPurchaseOrder());
  document.getElementById('past-purchase-orders-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-order-action]');
    if (!button) return;
    if (button.dataset.orderAction === 'delete') {
      deleteSavedPurchaseOrder(button.dataset.orderId, button.dataset.orderNumber);
    } else if (button.dataset.orderAction === 'visibility') {
      setPurchaseOrderVisibility(button.dataset.orderId, button.dataset.orderNumber, button.dataset.hidden === 'true');
    } else {
      openSavedPurchaseOrder(button.dataset.orderId, button.dataset.orderAction === 'print');
    }
  });
  document.getElementById('purchase-projection-body').addEventListener('input', event => {
    const row = event.target.closest('tr[data-key]');
    const item = purchaseProjectionState?.items.find(candidate => candidate.key === row?.dataset.key);
    if (!item) return;
    const editsMinimum = event.target.matches('.projection-min-input');
    const editsMaximum = event.target.matches('.projection-max-input');
    const editsPackage = event.target.matches('.projection-package-input');
    if ((editsMinimum || editsMaximum || editsPackage) && event.target.value !== '') {
      if (editsMinimum) item.minDays = Number(event.target.value);
      if (editsMaximum) item.maxDays = Number(event.target.value);
      if (editsPackage) item.unitsPerPackage = Number(event.target.value);
      recalculatePurchaseProjectionItem(item);
      const inputClass = editsMinimum ? '.projection-min-input'
        : editsMaximum ? '.projection-max-input' : '.projection-package-input';
      renderPurchaseProjection();
      const replacementRow = [...document.querySelectorAll('#purchase-projection-body tr[data-key]')]
        .find(candidate => candidate.dataset.key === item.key);
      replacementRow?.querySelector(inputClass)?.focus();
      return;
    }
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
  document.getElementById('current-inventory-report').addEventListener('click', openCurrentInventoryDateDialog);
  document.getElementById('confirm-current-inventory-report').addEventListener('click', generateCurrentInventoryReport);
  for (const id of ['close-current-inventory-date-dialog', 'cancel-current-inventory-date-dialog']) {
    document.getElementById(id).addEventListener('click', () => {
      document.getElementById('current-inventory-date-dialog').close();
    });
  }
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
  document.getElementById('close-current-inventory-report').addEventListener('click', () => {
    closeInventoryResultDialog('current-inventory-results');
  });
  document.getElementById('current-inventory-search').addEventListener('input', renderCurrentInventoryTables);
  document.getElementById('clear-current-inventory-search').addEventListener('click', () => {
    document.getElementById('current-inventory-search').value = '';
    renderCurrentInventoryTables();
  });
  for (const id of ['inventory-kardex-search', 'inventory-kardex-cost-min', 'inventory-kardex-cost-max']) {
    document.getElementById(id).addEventListener('input', renderInventoryKardexTable);
  }
  document.getElementById('inventory-kardex-cost-filter').addEventListener('change', renderInventoryKardexTable);
  document.getElementById('inventory-kardex-decimals').addEventListener('change', renderInventoryKardexTable);
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
          address: document.getElementById('new-location-address').value,
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

  document.getElementById('company-profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const company = await apiRequest('/api/config/company', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('company-name').value,
          taxId: document.getElementById('company-tax-id').value,
          exportDecimalSystem: document.getElementById('company-export-decimal-system').value
        })
      });
      exportDecimalSystem = company.exportDecimalSystem === 'dot' ? 'dot' : 'comma';
      setStatus(document.getElementById('location-status'), 'Datos de Brewit y formato de exportación actualizados.', 'success');
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
