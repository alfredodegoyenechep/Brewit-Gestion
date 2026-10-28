const IngredientMasterExport = (() => {
  const headers = ['Código', 'Ingrediente', 'Unidad de Consumo', 'Unidad de Abastecimiento', 'Un. de Consumo x Un. de Abast.', 'Equivalencia',
    'Unidad de Transferencia a Cafeterías', 'Un. de Consumo x Un. de Transferencia', 'Equivalencia transferencia'];
  const quantity = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 4 }).format(value);

  function values(item, draft = item) {
    const unit = draft.purchaseUnit || item.masterPurchaseUnit || '';
    const raw = draft.purchaseUnit ? draft.unitsPerPurchaseUnit : item.masterContent;
    const content = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0
      ? Number(raw) : null;
    const transferUnit = draft.transferUnit || unit;
    const transferRaw = draft.transferUnit ? draft.unitsPerTransferUnit : content;
    const transferContent = transferRaw !== null && transferRaw !== undefined && transferRaw !== ''
      && Number.isFinite(Number(transferRaw)) && Number(transferRaw) > 0 ? Number(transferRaw) : null;
    return [item.code, item.name, item.internalUnit || 'Sin unidad de consumo', unit, content,
      unit && content !== null ? `1 ${unit} = ${quantity(content)} ${item.internalUnit}` : 'Sin equivalencia',
      transferUnit, transferContent, transferUnit && transferContent !== null
        ? `1 ${transferUnit} = ${quantity(transferContent)} ${item.internalUnit}` : 'Sin equivalencia'];
  }

  function csv(rows, decimalSystem = 'comma') {
    const escape = value => {
      let text = typeof value === 'number' && decimalSystem === 'comma'
        ? String(value).replace('.', ',') : String(value ?? '');
      // Keep spreadsheet applications from evaluating ingredient names or codes as formulas.
      if (typeof value === 'string' && /^[\s]*[=+@\-]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    return '\uFEFF' + [headers, ...rows].map(row => row.map(escape).join(';')).join('\r\n') + '\r\n';
  }

  function workbook(rows, XLSX) {
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    sheet['!cols'] = [16, 48, 20, 22, 30, 40, 32, 34, 40].map(wch => ({ wch }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!brewitTextColumns'] = [0, 1, 2, 3, 5, 6, 8];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Ingredientes');
    return book;
  }

  function pdf(rows, JsPDF, context = '') {
    const doc = new JsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
    doc.setProperties({ title: 'Maestro de ingredientes', author: 'Brewit' });
    const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight();
    const margin = 28, bottom = height - 32, lineHeight = 11;
    const widths = [.07, .18, .07, .105, .115, .115, .12, .11, .115].map(ratio => ratio * (width - margin * 2));
    const font = (bold = false, size = 9) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); };
    const split = row => row.map((value, index) => doc.splitTextToSize(String(value ?? ''), widths[index] - 12));
    const draw = (cells, y, rowHeight, header = false) => {
      if (header) { doc.setFillColor('#f7f2ea'); doc.rect(margin, y, width - margin * 2, rowHeight, 'F'); }
      let x = margin;
      cells.forEach((lines, index) => { if (lines.length) doc.text(lines, x + 6, y + 13); x += widths[index]; });
      doc.setDrawColor('#e6ded5'); doc.setLineWidth(.4);
      doc.line(margin, y + rowHeight, width - margin, y + rowHeight);
    };
    const page = () => {
      doc.setTextColor('#33291e'); font(true, 16); doc.text('Maestro de ingredientes', margin, 34);
      font(false, 9); doc.text(`${rows.length} ingredientes · ${context || 'Maestro compartido'}`, margin, 51);
      font(true); const cells = split(headers);
      const headerHeight = Math.max(...cells.map(lines => lines.length)) * lineHeight + 12;
      draw(cells, 64, headerHeight, true); font();
      return 64 + headerHeight;
    };
    let y = page();
    const top = y;
    for (const row of rows) {
      const cells = split(row.map(value => typeof value === 'number' ? quantity(value) : value));
      const count = Math.max(...cells.map(lines => lines.length));
      const rowHeight = count * lineHeight + 12;
      if (y + rowHeight > bottom && rowHeight <= bottom - top) { doc.addPage(); y = page(); }
      // Split exceptionally long rows without clipping text at the page edge.
      for (let offset = 0; offset < count;) {
        const capacity = Math.floor((bottom - y - 12) / lineHeight);
        if (capacity < 1) { doc.addPage(); y = page(); continue; }
        const take = Math.min(capacity, count - offset), blockHeight = take * lineHeight + 12;
        draw(cells.map(lines => lines.slice(offset, offset + take)), y, blockHeight);
        y += blockHeight; offset += take;
        if (offset < count) { doc.addPage(); y = page(); }
      }
    }
    const total = doc.getNumberOfPages();
    for (let index = 1; index <= total; index++) {
      doc.setPage(index); font(false, 8); doc.text(`Página ${index} de ${total}`, width - margin, height - 16, { align: 'right' });
    }
    return doc;
  }

  return { headers, values, csv, workbook, pdf };
})();

let locationRegistry = {};
let exportDecimalSystem = 'comma';
let toteatMasterDownloadBatchId = null;
let toteatTransactionalLocations = [];
let toteatTransactionalCentralWarehouse = null;
let toteatTransactionalMode = 'all';
const FIELD_LABELS = {
  kardex: 'Kardex / inventario',
  waste: 'Merma',
  marketing: 'Consumo de marketing',
  calibrations: 'Calibraciones y bebidas desechadas', employees: 'Consumo de colaboradores',
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
let costReviewState = null;
let purchasesViewState = null;
let purchaseCostVariationState = null;
let purchaseProjectionState = null;
let purchaseProjectionLoadSequence = 0;
let purchaseProjectionController = null;
let purchaseProjectionProgressTimer = null;
let consumptionReferenceConfiguration = null;
let ingredientPurchaseMasterState = null;
let ingredientPurchaseMasterDrafts = new Map();
let ingredientPurchaseMasterRequest = 0;
let purchaseOrderEditorState = null;
const pastPurchaseOrdersCache = new Map();
let pastPurchaseOrdersRequestSequence = 0;
let tentativePurchaseOrdersState = null;
let salesDashboardState = null;
let salesServiceModeState = null;
let salesProductFilters = { bar: 'all', groupFormats: false };
const salesReportDefinitions = {
  'sales-margin': { status: 'sales-margin-status', type: 'participation' },
  'sales-hierarchy-margin': { status: 'sales-hierarchy-margin-status', type: 'hierarchies' },
  'sales-service-mode': { status: 'sales-service-mode-status', type: 'service' },
  'sales-insight': { status: 'sales-insight-range-status', type: 'products' },
  'sales-ingredients': { status: 'sales-ingredients-status', type: 'ingredients' },
};
let transactionAuditState = null;
let transactionAuditSort = { key: 'date', direction: 'desc' };
const expandedAuditTransactions = new Set();
let hourlySalesDemandState = null;
let hourlyAnalysisState = null;
let findingsViewState = null;
let salesIngredientsState = null;
let financialResultsState = null;
const calculatedViewRequests = new Map();
const calculatedViewKeys = new Map();
function selectedCalculationKey(ids) {
  return JSON.stringify(ids.map(id => document.getElementById(id)?.value || ''));
}
function invalidateCalculation(view, statusId) {
  const active = calculatedViewRequests.get(view);
  if (active) active.controller.abort();
  calculatedViewRequests.delete(view);
  const buttonId = { financial: 'financial-results-filters', financialCosts: 'financial-costs-filters', ingredients: 'refresh-ingredients', purchases: 'refresh-purchases', costs: 'refresh-cost-review' }[view];
  const control = document.getElementById(buttonId);
  const button = ['financial', 'financialCosts'].includes(view) ? control?.querySelector('button[type="submit"]') : control;
  if (button) button.disabled = false;
  const previous = calculatedViewKeys.get(view);
  const action = ['financial', 'financialCosts'].includes(view) ? 'Generar resultados' : 'Consultar';
  setStatus(document.getElementById(statusId), previous
    ? `Los filtros cambiaron. El resultado visible corresponde a la última consulta; pulsa ${action} para aplicar la nueva selección.`
    : `Selecciona los filtros y pulsa ${action} para calcular con los datos guardados.`, 'muted');
}
function beginCalculation(view, key) {
  calculatedViewRequests.get(view)?.controller.abort();
  const request = { key, controller: new AbortController() };
  calculatedViewRequests.set(view, request);
  return request;
}
function isCurrentCalculation(view, request, ids) {
  return calculatedViewRequests.get(view) === request && selectedCalculationKey(ids) === request.key;
}
let financialGeneralExpensesGridState = null;
let salesHierarchyPath = [];
let hourlySalesHierarchyPath = [];
let hourlySalesProductKey = null;
let hourlyDemandChartMetric = 'units';
let pendingInventorySummaryField = null;
let pendingInventoryPreview = null;
let pendingTransactionDelete = null;
let inventoryKardexTableState = null;
let inventoryOtherConsumablesTableState = null;
let inventoryOtherConsumablesStickyObserver = null;
let currentInventoryTableState = null;
let transactionUploadContext = null;
let reportClassicLocation = 'all';
let reportLoadSequence = 0;
let intradayReportState = null;
let intradayBlockHours = 2;
const INTRADAY_BLOCK_HOURS_STORAGE_KEY = 'brewit.intradayBlockHours';
const reportChartRegistry = new Map();
let activeReportChart = null;
let activeReportChartType = 'bar';
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
const GENERAL_EXPENSES_COLLAPSED_STORAGE_KEY = 'brewit.financialGeneralExpensesCollapsed';
const FONT_SCALE_STORAGE_KEY = 'brewit.fontScale';
const FONT_SCALE_MIN = 80;
const FONT_SCALE_MAX = 200;
const FONT_SCALE_STEP = 10;
let sidebarCollapsedPreference = false;

function organizeWorkspaceNavigation() {
  const navigation = document.querySelector('.navigation');
  if (!navigation || navigation.dataset.organized === 'true') return;
  const links = new Map([...document.querySelectorAll('.nav-link[data-view]')]
    .map(link => [link.dataset.view, link]));
  const operationsLink = navigation.querySelector('a[href="/operaciones"]');
  const savedOrdersLink = document.createElement('a');
  savedOrdersLink.href = '#';
  savedOrdersLink.className = 'nav-link';
  savedOrdersLink.dataset.view = 'past-orders';
  savedOrdersLink.innerHTML = '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/></svg><span class="nav-text">Órdenes guardadas</span>';
  links.set('past-orders', savedOrdersLink);
  const groups = [
    { label: 'Ventas y resultados', views: ['report', 'financial-results'] },
    { label: 'Análisis de ventas', views: ['sales', 'demand-analysis'] },
    { label: 'Inventario y compras', views: ['inventory', 'purchases', 'purchase-projection', 'past-orders'] },
    { label: 'Productos y costos', views: ['products', 'ingredients', 'cost-review'] },
    { label: 'Control y configuración', views: ['findings', 'transaction-audit', 'uploads', 'historical-control', 'config'] }
  ];
  navigation.replaceChildren(...groups.map(group => {
    const section = document.createElement('section');
    section.className = 'nav-group';
    const heading = document.createElement('h2');
    heading.className = 'nav-group-label';
    heading.textContent = group.label;
    section.append(heading, ...group.views.map(view => links.get(view)).filter(Boolean));
    return section;
  }));
  if (operationsLink) navigation.querySelector('.nav-group:last-child').append(operationsLink);
  navigation.dataset.organized = 'true';
}

function applyFontScale(percent) {
  const scale = Number(percent);
  const normalized = Number.isFinite(scale) && scale >= FONT_SCALE_MIN && scale <= FONT_SCALE_MAX
    && (scale - FONT_SCALE_MIN) % FONT_SCALE_STEP === 0 ? scale : 100;
  document.documentElement.style.setProperty('--font-scale', String(normalized / 100));
  document.getElementById('font-size-value').value = `${normalized}%`;
  document.getElementById('font-size-decrease').disabled = normalized === FONT_SCALE_MIN;
  document.getElementById('font-size-increase').disabled = normalized === FONT_SCALE_MAX;
  return normalized;
}

function initializeFontScale() {
  let saved = null;
  try { saved = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY); } catch {}
  let current = applyFontScale(saved === null ? 100 : saved);
  const change = direction => {
    current = applyFontScale(current + direction * FONT_SCALE_STEP);
    try { window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(current)); } catch {}
  };
  document.getElementById('font-size-decrease').addEventListener('click', () => change(-1));
  document.getElementById('font-size-increase').addEventListener('click', () => change(1));
}

function initializeFinancialGeneralExpensesPanel() {
  const panel = document.querySelector('.financial-general-expenses-panel');
  const button = document.getElementById('financial-general-expenses-toggle');
  if (!panel || !button) return;
  let collapsed = false;
  try { collapsed = window.localStorage.getItem(GENERAL_EXPENSES_COLLAPSED_STORAGE_KEY) === 'true'; } catch {}
  const render = () => {
    panel.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? 'Expandir' : 'Colapsar';
    button.title = collapsed ? 'Expandir gastos generales' : 'Colapsar gastos generales';
  };
  button.addEventListener('click', () => {
    collapsed = !collapsed;
    try { window.localStorage.setItem(GENERAL_EXPENSES_COLLAPSED_STORAGE_KEY, String(collapsed)); } catch {}
    render();
  });
  render();
}

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

window.addEventListener('brewit-sales-updated', () => {
  const report = document.getElementById('weekly-report');
  const sales = document.getElementById('sales-workspace');
  if (report && !report.hidden && report.style.display !== 'none') loadWeeklySalesReport();
  if (sales && !sales.hidden && sales.style.display !== 'none') {
    Object.keys(salesReportDefinitions).forEach(markSalesReportDirty);
    markHourlyReportDirty();
  }
});
window.addEventListener('brewit-purchases-updated', () => {
  const view = document.getElementById('purchases-workspace');
  if (view && !view.hidden && view.style.display !== 'none') loadPurchasesView();
});

/* Configuration navigation and source scope; independent from integration forms. */
function initializeSettingsWorkspace() {
  const byId = id => document.getElementById(id);
  const root = byId('location-settings');
  const snapshots = new Map();
  const lockedControls = new WeakMap();
  const context = { location: '', syncLocation: '', syncSource: 'sales' };
  let locations = [], editorId = null, pendingNavigation = null;
  const controls = container => [...container.querySelectorAll('input, select, textarea')];
  const value = input => input.type === 'checkbox' ? input.checked : input.value;
  const clean = container => {
    if (typeof container === 'string') container = byId(container);
    if (container) snapshots.set(container, controls(container).map(input => [input, value(input)]));
  };
  const dirty = container => (snapshots.get(typeof container === 'string' ? byId(container) : container) || [])
    .some(([input, original]) => input.isConnected && value(input) !== original);
  function setBusy(container, busy) {
    container.dataset.saving = String(busy);
    if (busy) {
      lockedControls.set(container, controls(container).map(input => [input, input.disabled]));
      controls(container).forEach(input => { input.disabled = true; });
    } else {
      for (const [input, disabled] of lockedControls.get(container) || []) input.disabled = disabled;
      lockedControls.delete(container);
    }
  }
  function guard(action) {
    for (const container of snapshots.keys()) if (!container.isConnected) snapshots.delete(container);
    if ([...snapshots.keys()].some(container => container.dataset.saving === 'true')) return false;
    const changed = [...snapshots.keys()].filter(dirty);
    if (!changed.length) { action(); return true; }
    if (byId('settings-unsaved-dialog').open) return false;
    pendingNavigation = () => {
      for (const container of changed) for (const [input, original] of snapshots.get(container)) {
        if (input.type === 'checkbox') input.checked = original;
        else input.value = original;
        input.dispatchEvent(new Event('brewit-settings-discarded'));
      }
      action();
    };
    byId('settings-unsaved-dialog').showModal();
    return false;
  }
  byId('settings-keep-editing').onclick = () => { pendingNavigation = null; byId('settings-unsaved-dialog').close(); };
  byId('settings-discard').onclick = () => {
    const action = pendingNavigation; pendingNavigation = null;
    byId('settings-unsaved-dialog').close(); action?.();
  };
  byId('settings-unsaved-dialog').addEventListener('cancel', () => { pendingNavigation = null; });
  window.addEventListener('beforeunload', event => {
    if ([...snapshots.keys()].some(dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  function tab(name, focus = false) {
    root.querySelectorAll('[data-settings-tab]').forEach(button => {
      const selected = button.dataset.settingsTab === name;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      byId(button.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) button.focus();
    });
  }
  const tabs = [...root.querySelectorAll('[data-settings-tab]')];
  tabs.forEach((button, index) => {
    button.onclick = () => guard(() => tab(button.dataset.settingsTab));
    button.onkeydown = event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return;
      event.preventDefault(); guard(() => tab(tabs[next].dataset.settingsTab, true));
    };
  });
  function showLocations(mode = 'list', id = null, focus = true) {
    editorId = mode === 'edit' ? id : null;
    byId('location-list-view').hidden = mode !== 'list';
    byId('location-editor-view').hidden = !['edit', 'create'].includes(mode);
    byId('location-trash-view').hidden = mode !== 'trash';
    byId('location-create-view').hidden = mode !== 'create';
    byId('location-editor-list').hidden = mode !== 'edit';
    byId('location-editor-list').querySelectorAll('.location-row').forEach(row => { row.hidden = row.dataset.locationId !== id; });
    if (mode === 'edit' || mode === 'create') {
      byId('location-editor-title').textContent = mode === 'create' ? 'Nueva ubicación' : `Editar ${locations.find(item => item.id === id)?.name || 'ubicación'}`;
      if (focus) byId('location-editor-title').focus();
    } else if (focus) byId(mode === 'trash' ? 'location-trash-back' : 'new-location-open').focus();
  }
  byId('new-location-open').onclick = () => guard(() => { byId('create-location-form').reset(); clean('create-location-form'); showLocations('create'); });
  byId('location-editor-back').onclick = () => guard(() => showLocations());
  byId('location-trash-back').onclick = () => showLocations();
  byId('location-trash-open').onclick = () => guard(() => showLocations('trash'));
  function editLocation(id) {
    guard(() => {
      if (!locations.some(item => item.id === id)) return;
      setView('config'); tab('locations'); showLocations('edit', id);
    });
  }
  root.querySelectorAll('[data-edit-integration-location]').forEach(button => { button.onclick = () => editLocation(context.location); });
  function associations() {
    const location = locations.find(item => item.id === context.location);
    byId('toteat-association').textContent = location ? `Restaurant ID: ${location.toteatRestaurantId || 'Sin asignar'} · Local ID: ${location.toteatLocalId || 'Sin asignar'}` : 'Primero crea una cafetería.';
    byId('mercadopago-association').textContent = location?.mercadoPagoStoreId ? `Asociado · STORE_ID ${location.mercadoPagoStoreId}` : 'Sin asociación de MercadoPago';
    root.querySelectorAll('[data-edit-integration-location], [data-open-sync="sales"], [data-open-sync="purchases"]').forEach(button => { button.disabled = !location; });
  }
  function selectLocation(id) {
    context.location = id; byId('toteat-api-location').value = id;
    byId('toteat-api-form').elements.location.value = id;
    associations();
    window.dispatchEvent(new CustomEvent('brewit-settings-location', { detail: { location: id } }));
  }
  byId('toteat-api-location').addEventListener('change', () => {
    const id = byId('toteat-api-location').value;
    byId('toteat-api-location').value = context.location;
    guard(() => selectLocation(id));
  });
  function updateSyncScope() {
    byId('source-sync-location').value = context.syncLocation;
    byId('source-sync-kind').value = context.syncSource;
    const location = locations.find(item => item.id === context.syncLocation);
    byId('source-sync-scope').textContent = location
      ? `${location.name} · ${context.syncSource === 'sales' ? 'Ventas y pagos' : 'Compras'} · Actualización manual`
      : 'Crea una cafetería y configura su conexión antes de sincronizar.';
    document.querySelectorAll('[data-sync-source]').forEach(section => {
      section.hidden = section.dataset.syncSource !== context.syncSource;
      section.querySelectorAll('button').forEach(button => { button.disabled = !location; });
    });
    byId('source-sync-configure').disabled = !location;
    byId('source-sync-status').textContent = '';
  }
  byId('source-sync-location').onchange = event => { context.syncLocation = event.target.value; updateSyncScope(); };
  byId('source-sync-kind').onchange = event => { context.syncSource = event.target.value; updateSyncScope(); };
  root.querySelectorAll('[data-open-sync]').forEach(button => {
    button.onclick = () => guard(() => {
      const source = button.dataset.openSync;
      context.syncLocation = context.location;
      if (source !== 'masters') context.syncSource = source;
      updateSyncScope(); setView('uploads');
      uploadWorkspace.open(context.location, source);
      const target = byId(source === 'masters' ? 'shared-masters-title' : 'upload-title');
      target.tabIndex = -1; target.focus(); target.scrollIntoView({ block: 'start' });
    });
  });
  byId('source-sync-configure').onclick = () => guard(() => {
    byId('source-sync-dialog').close();
    setView('config'); tab('integrations'); selectLocation(context.syncLocation); byId('toteat-api-location').focus();
  });
  function setLocations(data) {
    locations = data.active;
    const stores = locations.filter(item => item.type === 'store');
    for (const id of ['toteat-api-location', 'source-sync-location']) byId(id).replaceChildren(...stores.map(item => new Option(item.name, item.id)));
    context.syncLocation = stores.some(item => item.id === context.syncLocation) ? context.syncLocation : stores[0]?.id || '';
    const selected = stores.some(item => item.id === context.location) ? context.location : stores[0]?.id || '';
    updateSyncScope();
    if (![byId('toteat-api-form'), byId('toteat-sales-settings'), byId('toteat-purchases-settings')].some(dirty)) selectLocation(selected);
    else { byId('toteat-api-location').value = context.location; associations(); }
    if (editorId) showLocations(locations.some(item => item.id === editorId) ? 'edit' : 'list', editorId, false);
  }
  window.brewitSettings = { context, clean, dirty, guard, setBusy, setLocations, editLocation, selectLocation,
    getLocation(id) { return locations.find(item => item.id === id); },
    openIntegration(id) { guard(() => { setView('config'); tab('integrations'); selectLocation(id); byId('toteat-api-location').focus(); }); },
    registerEditor(row, location) {
      clean(row);
      const summary = document.createElement('article'); summary.className = 'location-summary';
      const info = document.createElement('div'), name = document.createElement('h4'), address = document.createElement('p');
      name.textContent = location.name; address.textContent = location.address || 'Sin dirección registrada'; info.append(name, address);
      const type = document.createElement('span'); type.className = 'location-type-badge'; type.textContent = location.type === 'store' ? 'Cafetería' : 'Bodega';
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.textContent = 'Editar'; edit.setAttribute('aria-label', `Editar ${location.name}`); edit.onclick = () => editLocation(location.id);
      summary.append(info, type, edit); byId('active-locations-list').append(summary);
      row.dataset.locationId = location.id; row.hidden = location.id !== editorId;
    },
    created(id) { clean('create-location-form'); editLocation(id); },
    syncMessage(text, location, source) {
      if (context.syncLocation === location && context.syncSource === source) byId('source-sync-status').textContent = text;
    }
  };
  ['company-profile-form', 'create-location-form', 'toteat-api-form', 'toteat-sales-settings', 'toteat-purchases-settings'].forEach(clean);
}

initializeSettingsWorkspace();

function setView(view, { confirmed = false } = {}) {
  if (view === 'weekly-results') {
    setView('financial-results', { confirmed });
    document.getElementById('financial-results-workspace-tab-weekly').click();
    return;
  }
  if (view === 'sales-ingredients') {
    setView('sales', { confirmed });
    document.getElementById('sales-workspace-tab-ingredients').click();
    return;
  }
  if (!confirmed && view !== 'config' && !document.getElementById('location-settings').hidden && document.getElementById('location-settings').style.display !== 'none' && window.brewitSettings) {
    return window.brewitSettings.guard(() => setView(view, { confirmed: true }));
  }
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.view === view));
  if (view !== 'purchase-projection') cancelPurchaseProjectionLoad();
  if (view !== 'financial-results') window.cancelCafeWeeklyResults?.();
  document.querySelectorAll('.main-content > section').forEach(section => {
    section.hidden = true;
    section.style.display = 'none';
  });
  if (view === 'past-orders') {
    const projection = document.getElementById('purchase-projection-workspace');
    projection.hidden = false;
    projection.style.display = '';
    openPastPurchaseOrders();
    return;
  }
  if (view === 'uploads' || view === 'uploads-previous') {
    const loader = document.getElementById('upload-overview');
    loader.hidden = false;
    loader.style.display = '';
    loadUploadOverview();
    return;
  }
  if (view === 'historical-control') {
    const history = document.getElementById('historical-workspace');
    history.hidden = false;
    history.style.display = '';
    if (typeof window.openHistoricalControl === 'function') window.openHistoricalControl();
    else document.getElementById('historical-status').textContent = 'No se pudo cargar Control histórico. Reinicia el servidor y vuelve a cargar la página.';
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
    return;
  }
  if (view === 'transaction-audit') {
    const audit = document.getElementById('transaction-audit-workspace');
    audit.hidden = false;
    audit.style.display = '';
    loadTransactionAudit();
    return;
  }
  if (view === 'findings') {
    const findings = document.getElementById('findings-workspace');
    findings.hidden = false;
    findings.style.display = '';
    loadFindingsView();
    return;
  }
  if (view === 'financial-results') {
    const financialResults = document.getElementById('financial-results-workspace');
    financialResults.hidden = false;
    financialResults.style.display = '';
    if (!financialResultsState && !calculatedViewRequests.has('financial')) invalidateCalculation('financial', 'financial-results-status');
    if (document.getElementById('financial-results-workspace-tab-weekly').getAttribute('aria-selected') === 'true') window.openCafeWeeklyResults?.();
    return;
  }
  if (view === 'demand-analysis') {
    const demand = document.getElementById('demand-analysis-workspace');
    demand.hidden = false;
    demand.style.display = '';
    if (typeof loadDemandAnalysis !== 'function') setStatus(document.getElementById('demand-status'),
      'No se cargó el módulo de venta. Reinicia el servidor de Brewit y recarga esta página.', 'error');
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
    if (!ingredientsViewState) invalidateCalculation('ingredients', 'ingredients-status');
    return;
  }
  if (view === 'cost-review') {
    const review = document.getElementById('cost-review-workspace');
    review.hidden = false;
    review.style.display = '';
    if (!costReviewState) invalidateCalculation('costs', 'cost-review-status');
    return;
  }
  if (view === 'purchases') {
    const purchases = document.getElementById('purchases-workspace');
    purchases.hidden = false;
    purchases.style.display = '';
    initializePurchaseDates();
    if (!purchasesViewState) invalidateCalculation('purchases', 'purchases-status');
    return;
  }
  if (view === 'purchase-projection') {
    const projection = document.getElementById('purchase-projection-workspace');
    projection.hidden = false;
    projection.style.display = '';
    resetPurchaseProjection();
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
      if (sheet['!brewitTextColumns']?.includes(column)) continue;
      if (cell.t === 'n' && Number.isFinite(cell.v)) {
        if (sheet['!brewitNumberFormat']) {
          cell.z = sheet['!brewitNumberFormat'];
          delete cell.w;
          continue;
        }
        const columnFormat = sheet['!brewitColumnNumberFormats']?.[column];
        if (columnFormat) {
          cell.z = sheet['!brewitInventoryStyle'] === true
            ? columnFormat.integer ? '#,##0' : `#,##0.${'0'.repeat(columnFormat.decimalPlaces)}`
            : configuredExcelNumberFormat(columnFormat);
          delete cell.w;
          continue;
        }
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
      cell.z = sheet['!brewitNumberFormat'] || configuredExcelNumberFormat({
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
  if (workbook.SheetNames.some(name => workbook.Sheets[name]['!brewitInventoryStyle'])) {
    writeInventoryExcelFile(workbook, filename);
  } else {
    XLSX.writeFile(workbook, filename, { compression: true, cellStyles: true });
  }
}

// SheetJS's community writer does not emit font/alignment styles. Apply the
// inventory presentation to the generated XLSX while retaining its values.
function inventoryStyledExcelBytes(workbook) {
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true }));
  const zip = XLSX.CFB.read(bytes, { type: 'array' });
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const parse = name => {
    const entry = XLSX.CFB.find(zip, '/' + name);
    if (!entry) throw new Error(`Falta ${name} en el archivo Excel.`);
    const doc = new DOMParser().parseFromString(decoder.decode(new Uint8Array(entry.content)), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('No fue posible preparar el formato Excel.');
    return doc;
  };
  const save = (name, doc) => XLSX.CFB.utils.cfb_add(zip, '/' + name,
    encoder.encode(new XMLSerializer().serializeToString(doc)));
  const styles = parse('xl/styles.xml');
  const ns = styles.documentElement.namespaceURI;
  const element = (name, attributes = {}) => {
    const node = styles.createElementNS(ns, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const append = (table, node) => {
    const id = table.children.length;
    table.appendChild(node);
    table.setAttribute('count', String(table.children.length));
    return id;
  };
  const fonts = styles.getElementsByTagNameNS(ns, 'fonts')[0];
  const fontIds = new Map();
  const fontId = (bold, negative = false, size = 11) => {
    const key = `${bold}:${negative}:${size}`;
    if (fontIds.has(key)) return fontIds.get(key);
    const font = element('font');
    if (bold) font.appendChild(element('b'));
    font.appendChild(element('sz', { val: size }));
    font.appendChild(element('color', { rgb: negative ? 'FFFF0000' : 'FF000000' }));
    font.appendChild(element('name', { val: 'Calibri' }));
    font.appendChild(element('family', { val: 2 }));
    const id = append(fonts, font);
    fontIds.set(key, id);
    return id;
  };
  const fill = element('fill'), pattern = element('patternFill', { patternType: 'solid' });
  pattern.appendChild(element('fgColor', { rgb: 'FFD9D9D9' }));
  pattern.appendChild(element('bgColor', { indexed: 64 }));
  fill.appendChild(pattern);
  const headerFillId = append(styles.getElementsByTagNameNS(ns, 'fills')[0], fill);
  const border = element('border');
  ['left', 'right', 'top', 'bottom'].forEach(side => {
    const edge = element(side, { style: 'thin' });
    edge.appendChild(element('color', { rgb: 'FFD4D4D4' }));
    border.appendChild(edge);
  });
  border.appendChild(element('diagonal'));
  const borderId = append(styles.getElementsByTagNameNS(ns, 'borders')[0], border);
  const xfs = styles.getElementsByTagNameNS(ns, 'cellXfs')[0];
  const formats = new Map();
  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet['!brewitInventoryStyle']) return;
    const presentation = sheet['!brewitInventoryStyle'];
    const kardex = typeof presentation === 'object';
    const file = `xl/worksheets/sheet${index + 1}.xml`;
    const doc = parse(file);
    const lastRow = XLSX.utils.decode_range(sheet['!ref']).e.r + 1;
    [...doc.getElementsByTagNameNS(ns, 'c')].forEach(cell => {
      const address = cell.getAttribute('r');
      const position = XLSX.utils.decode_cell(address);
      const row = position.r + 1;
      const header = row === 1;
      const bold = header || (row === lastRow && (!kardex || presentation.hasTotalRow))
        || (kardex && presentation.boldColumns.includes(position.c));
      const numeric = sheet[address]?.t === 'n';
      const negative = kardex && numeric && sheet[address].v < 0;
      const fillId = kardex && header ? headerFillId : 0;
      const font = fontId(bold, negative, kardex && header ? 12 : 11);
      const original = Number(cell.getAttribute('s') || 0);
      const key = `${original}:${font}:${fillId}:${numeric}`;
      if (!formats.has(key)) {
        const xf = xfs.children[original].cloneNode(true);
        Object.entries({ fontId: font, borderId, fillId,
          applyFont: 1, applyBorder: 1, applyFill: 1, applyAlignment: 1 })
          .forEach(([key, value]) => xf.setAttribute(key, String(value)));
        [...xf.getElementsByTagNameNS(ns, 'alignment')].forEach(node => node.remove());
        xf.appendChild(element('alignment', { horizontal: numeric ? 'right' : 'left',
          vertical: 'center', wrapText: 0 }));
        formats.set(key, append(xfs, xf));
      }
      cell.setAttribute('s', String(formats.get(key)));
    });
    [...doc.getElementsByTagNameNS(ns, 'row')].forEach(row => {
      row.setAttribute('ht', kardex && row.getAttribute('r') === '1' ? '20' : '15');
      row.setAttribute('customHeight', '1');
    });
    [...doc.getElementsByTagNameNS(ns, 'sheetView')].forEach(view => {
      view.setAttribute('zoomScale', '80');
      view.setAttribute('showGridLines', '1');
      if (kardex) {
        const columns = presentation.freezeColumns || 0;
        const topLeftCell = XLSX.utils.encode_cell({ r: 1, c: columns });
        [...view.children].filter(node => ['pane', 'selection'].includes(node.localName)).forEach(node => node.remove());
        const pane = doc.createElementNS(ns, 'pane');
        Object.entries({ ...(columns ? { xSplit: columns } : {}), ySplit: 1, topLeftCell,
          activePane: columns ? 'bottomRight' : 'bottomLeft', state: 'frozen' })
          .forEach(([key, value]) => pane.setAttribute(key, String(value)));
        view.prepend(pane);
        const selection = doc.createElementNS(ns, 'selection');
        Object.entries({ pane: columns ? 'bottomRight' : 'bottomLeft', activeCell: topLeftCell, sqref: topLeftCell })
          .forEach(([key, value]) => selection.setAttribute(key, value));
        view.appendChild(selection);
      }
    });
    save(file, doc);
  });
  save('xl/styles.xml', styles);
  return XLSX.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
}

function writeInventoryExcelFile(workbook, filename) {
  const blob = new Blob([inventoryStyledExcelBytes(workbook)],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      state.textContent = `${latest.origin === 'toteat-api' ? 'Actualización por API' : 'Último archivo subido'} ${expandedUploadHistories.has(field) ? '▲' : '▼'}`;
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
      deleteButton.disabled = latest.origin === 'toteat-api';
      if (latest.origin === 'toteat-api') deleteButton.title = 'Administra esta fuente en Configuración → Conexión API de Toteat.';
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

function openTransactionDeleteDialog(field, uploaded, {
  location = document.getElementById('location-select').value,
  source = 'uploads',
  allOnly = false
} = {}) {
  pendingTransactionDelete = {
    field,
    location,
    source,
    allOnly,
    fileCount: uploaded.fileCount,
    latest: uploaded.latest
  };
  const label = FIELD_LABELS[field] || field;
  const locationName = locationRegistry[location]?.name || location;
  document.getElementById('transaction-delete-title').textContent = `Eliminar ${label}`;
  document.getElementById('transaction-delete-description').textContent = allOnly
    ? `Se eliminarán TODOS los datos de ${label} para ${locationName}, incluidos todos los archivos cargados y su historial. Esta acción no se puede deshacer.`
    : `Hay ${uploaded.fileCount} carga(s) guardada(s). La última es “${uploaded.latest.originalName || uploaded.latest.name}”. Selecciona el alcance y confirma antes de continuar.`;
  document.querySelector('.transaction-delete-options').hidden = allOnly;
  document.querySelector(`input[name="transaction-delete-action"][value="${allOnly ? 'all' : 'last'}"]`).checked = true;
  document.getElementById('transaction-delete-confirmation').value = '';
  document.getElementById('confirm-transaction-delete').disabled = true;
  document.getElementById('confirm-transaction-delete').textContent = allOnly ? 'Eliminar todos los datos' : 'Confirmar eliminación';
  setStatus(document.getElementById('transaction-delete-status'), 'Esta acción no puede deshacerse desde esta pantalla.', 'muted');
  document.getElementById('transaction-delete-dialog').showModal();
}

function closeTransactionDeleteDialog() {
  pendingTransactionDelete = null;
  document.getElementById('transaction-delete-dialog').close();
}

async function confirmTransactionDeletion(event) {
  if (!pendingTransactionDelete || pendingTransactionDelete.deleting
    || document.getElementById('transaction-delete-confirmation').value.trim() !== 'ELIMINAR') return;
  const button = event.currentTarget;
  const context = pendingTransactionDelete;
  const action = context.allOnly ? 'all' : document.querySelector('input[name="transaction-delete-action"]:checked')?.value;
  const { location, field, source } = context;
  context.deleting = true;
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
    if (pendingTransactionDelete === context) closeTransactionDeleteDialog();
    await loadTransactionFiles();
    if (source === 'inventory') await loadInventorySources();
    const status = document.getElementById(source === 'inventory' ? 'inventory-source-status' : 'week-status');
    const currentLocation = document.getElementById(source === 'inventory' ? 'inventory-location-select' : 'location-select').value;
    if (currentLocation === location) setStatus(status, action === 'all'
      ? `Se eliminó toda la información de ${FIELD_LABELS[field] || field}.`
      : `Se revirtió la última carga de ${FIELD_LABELS[field] || field}. Quedan ${result.remainingCount} carga(s).`, 'success');
  } catch (error) {
    if (pendingTransactionDelete !== context) return;
    setStatus(document.getElementById('transaction-delete-status'), error.message, 'error');
    context.deleting = false;
    button.disabled = document.getElementById('transaction-delete-confirmation').value.trim() !== 'ELIMINAR';
  }
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
    const location = field === 'mercadopago' ? null
      : locationOverride || transactionUploadContext?.location || document.getElementById('location-select').value;
    const formData = new FormData();
    formData.append(field, file);
    const inspectUrl = location === null ? '/api/uploads/transactions/inspect'
      : `/api/uploads/transactions/inspect?location=${encodeURIComponent(location)}`;
    const manifest = await apiRequest(inspectUrl, {
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
    if (manifest.mercadoPagoSummary) {
      const summary = manifest.mercadoPagoSummary;
      setStatus(status, summary.associatedCount
        ? `Archivo revisado: ${summary.associatedCount.toLocaleString('es-CL')} registro(s) asociados y ${summary.unassociatedCount.toLocaleString('es-CL')} sin asociación. Revisa el resumen y confirma la carga en la ventana emergente.`
        : 'El archivo no tiene registros asociados a nuestras cafeterías. Revisa el resumen en la ventana emergente.', summary.unassociatedCount ? 'warning' : 'success');
      return true;
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
  if(document.getElementById('historical-complete'))document.getElementById('historical-complete').checked=false;
  if(document.getElementById('historical-warehouse'))document.getElementById('historical-warehouse').value='';
  document.getElementById('inventory-file-confirmed').checked = false;
  document.getElementById('inventory-file-confirmation-row').hidden = true;
  document.getElementById('detected-files-list').replaceChildren();
  renderMercadoPagoUploadSummary(null);
  document.getElementById('transaction-overlap-notice').hidden = true;
  document.getElementById('replace-transactions-btn').hidden = true;
  setStatus(document.getElementById('transaction-confirmation-status'), '');
  if (clearStatus) setStatus(document.getElementById('week-status'), '');
}

function cancelTransactionConfirmation() {
  const status = transactionUploadStatus();
  if (inspectionState?.token) apiRequest('/api/uploads/transactions/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:inspectionState.token})}).catch(()=>{});
  clearWeeklySelections();
  clearInspection();
  setStatus(status, 'Carga cancelada.', 'muted');
  transactionUploadContext = null;
}

function hasCompleteDetectedRange(range) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  return Boolean(range && isoDate.test(range.from) && isoDate.test(range.to) && range.from <= range.to);
}

function hasSharedMercadoPagoDates(manifest) {
  return Boolean(manifest?.assignments?.length && manifest.files?.length
    && manifest.files.every(file => file.field === 'mercadopago' && hasCompleteDetectedRange(file.detectedRange))
    && hasCompleteDetectedRange(manifest.detectedRange));
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
  const requiresDateConfirmation = !automatic && !hasSharedMercadoPagoDates(inspectionState) && (!inspectionState?.files?.length
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
  if (inspectionState.mercadoPagoSummary?.associatedCount === 0) return fail('No hay registros asociados a nuestras cafeterías para procesar.');
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
      body: JSON.stringify({ token: inspectionState.token, dateFrom, dateTo, confirmed: true, categoryConfirmed, overlapAction, historicalComplete:document.getElementById('historical-complete')?.checked===true, historicalWarehouse:document.getElementById('historical-warehouse')?.value.trim() || '*',
        ...(inspectionState.mercadoPagoSummary?.unassociatedCount ? { excludedAcknowledged: true } : {}) })
    });
    clearWeeklySelections();
    clearInspection();
    await loadTransactionFiles();
    if (uploadContext?.refreshReport) await loadWeeklySalesReport();
    if (uploadContext?.source === 'overview') await loadUploadOverview();
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
      if (imported.conflictingTransactions) importMessages.push(`${imported.conflictingTransactions} corrección(es) MercadoPago pendiente(s) de revisión. Se conservó el importe anterior; revisa los originales en Control histórico.`);
      for (const assignment of result.assignments || []) {
        const stats = assignment.imports?.mercadopago;
        importMessages.push(`${assignment.name} (STORE_ID ${assignment.storeId}): ${stats?.newTransactions || 0} registro(s) nuevo(s), ${stats?.duplicateTransactions || 0} repetido(s) omitido(s), ${stats?.conflictingTransactions || 0} corrección(es) pendiente(s).`);
      }
      if (result.skippedCount) importMessages.push(`${result.skippedCount} registro(s) sin cafetería asociada no fueron procesados.`);
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
  const wasteRow = document.querySelector('[data-weekly-field="waste"]');
  wasteRow.hidden = !hasLocation;
  wasteRow.querySelector('input').disabled = !hasLocation;
  document.getElementById('location-note').textContent = !hasLocation
    ? 'Crea o recupera una ubicación en Configuración para cargar archivos.'
    : isWarehouse
      ? 'Esta bodega recibe su Kardex de inventario y el Kardex de Merma Central.'
      : 'Esta cafetería recibe Kardex, merma, consumos de marketing, colaboradores y calibraciones, compras, ventas, Detalle Pagos y transacciones MercadoPago.';
  currentWeekFiles = {};
  clearWeeklySelections();
  clearInspection(true);
  if (document.getElementById('week-status')) loadTransactionFiles();
}

async function loadTransactionFiles() {
  const status = document.getElementById('week-status');
  if (!status) return;
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

function browserIsoToday(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function refreshFinancialResultsLocationFilter() {
  for (const prefix of ['financial-results', 'financial-costs']) {
    const select = document.getElementById(`${prefix}-location`);
    const previous = select.value || 'all';
    const options = [new Option('Todas las cafeterías', 'all')];
    Object.values(locationRegistry)
      .filter(location => location.type === 'store')
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
      .forEach(location => options.push(new Option(location.name, location.id)));
    select.replaceChildren(...options);
    select.value = options.some(option => option.value === previous) ? previous : 'all';
  }
}

function syncFinancialResultsPeriod(prefix = 'financial-results') {
  const period = document.getElementById(`${prefix}-period`).value;
  const fromInput = document.getElementById(`${prefix}-from`);
  const toInput = document.getElementById(`${prefix}-to`);
  const custom = period === 'custom';
  fromInput.disabled = !custom;
  toInput.disabled = !custom;
  document.getElementById(`${prefix}-from-field`).classList.toggle('is-disabled', !custom);
  document.getElementById(`${prefix}-to-field`).classList.toggle('is-disabled', !custom);
  if (custom) return;
  const today = browserIsoToday();
  const currentWeekStart = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const previousMonthEnd = offsetIsoDate(currentMonthStart, -1);
  const ranges = {
    'today': { from: today, to: today },
    'yesterday': { from: offsetIsoDate(today, -1), to: offsetIsoDate(today, -1) },
    'current-week': { from: currentWeekStart, to: today },
    'previous-week': { from: offsetIsoDate(currentWeekStart, -7), to: offsetIsoDate(currentWeekStart, -1) },
    'current-month': { from: currentMonthStart, to: today },
    'previous-month': { from: `${previousMonthEnd.slice(0, 7)}-01`, to: previousMonthEnd },
    'last-30-days': { from: offsetIsoDate(today, -29), to: today },
    'current-year': { from: `${today.slice(0, 4)}-01-01`, to: today }
  };
  const range = ranges[period] || ranges['last-30-days'];
  fromInput.value = range.from;
  toInput.value = range.to;
}

function refreshFinancialGeneralExpensesLocationFilter() {
  const select = document.getElementById('financial-general-expenses-location');
  if (!select) return;
  const previous = select.value;
  const stores = Object.values(locationRegistry)
    .filter(location => location.type === 'store')
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  const units = [...stores, { id: 'head-office', name: 'Casa Matriz' }];
  select.replaceChildren(...units.map(location => new Option(location.name, location.id)));
  if (units.some(location => location.id === previous)) select.value = previous;
}

function financialGeneralExpenseInputValue(input) {
  const raw=String(input?.value || '').trim();
  if(input?.dataset.category==='inventoryDifference' && !raw)return null;
  const digits=raw.replace(/[^\d]/g,'');
  return (raw.startsWith('-') && input?.dataset.category==='inventoryDifference' ? -1 : 1)*(digits?Number(digits):0);
}

function formatFinancialGeneralExpenseInput(input) {
  if(input.dataset.category==='inventoryDifference' && !input.value.trim())return;
  input.value = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 })
    .format(financialGeneralExpenseInputValue(input));
}

function copyPreviousFinancialExpenseMonth(monthNumber, monthLabels) {
  if (monthNumber <= 1 || !financialGeneralExpensesGridState) return;
  const sourceMonth = String(monthNumber - 1).padStart(2, '0');
  const targetMonth = String(monthNumber).padStart(2, '0');
  const sourceLabel = monthLabels[monthNumber - 2];
  const targetLabel = monthLabels[monthNumber - 1];
  if (!window.confirm(`¿Copiar todos los gastos de ${sourceLabel} a ${targetLabel}? Los valores actuales de ${targetLabel} serán reemplazados.`)) return;
  for (const category of financialGeneralExpensesGridState.categories) {
    const source = document.querySelector(`#financial-general-expenses-grid input[data-category="${category.key}"][data-month="${sourceMonth}"]`);
    const target = document.querySelector(`#financial-general-expenses-grid input[data-category="${category.key}"][data-month="${targetMonth}"]`);
    target.value = financialGeneralExpenseInputValue(source)===null ? '' : String(financialGeneralExpenseInputValue(source));
    formatFinancialGeneralExpenseInput(target);
    target.classList.add('modified');
  }
  financialGeneralExpensesGridState.dirtyMonths.add(targetMonth);
  updateFinancialGeneralExpensesTotal();
  setStatus(document.getElementById('financial-general-expenses-status'),
    `Valores de ${sourceLabel} copiados a ${targetLabel}. Guarda los meses modificados para confirmar el cambio.`, 'muted');
}

function updateFinancialGeneralExpensesTotal() {
  const inputs = [...document.querySelectorAll('#financial-general-expenses-grid input')];
  let annualTotal = 0;
  for (const category of financialGeneralExpensesGridState?.categories || []) {
    const total = inputs.filter(input => input.dataset.category === category.key)
      .reduce((sum, input) => sum + financialGeneralExpenseInputValue(input), 0);
    annualTotal += total;
    const cell = document.querySelector(`[data-expense-row-total="${category.key}"]`);
    if (cell) cell.textContent = formatClp(total);
  }
  for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
    const month = String(monthNumber).padStart(2, '0');
    const total = inputs.filter(input => input.dataset.month === month)
      .reduce((sum, input) => sum + financialGeneralExpenseInputValue(input), 0);
    const cell = document.querySelector(`[data-expense-month-total="${month}"]`);
    if (cell) cell.textContent = formatClp(total);
  }
  document.getElementById('financial-general-expenses-total').textContent = `Total anual: ${formatClp(annualTotal)}`;
  const annualCell = document.querySelector('[data-expense-annual-total]');
  if (annualCell) annualCell.textContent = formatClp(annualTotal);
}

async function loadFinancialGeneralExpenses() {
  const location = document.getElementById('financial-general-expenses-location').value;
  const year = document.getElementById('financial-general-expenses-year').value;
  const grid = document.getElementById('financial-general-expenses-grid');
  const status = document.getElementById('financial-general-expenses-status');
  if (!location || !/^\d{4}$/.test(year)) {
    grid.replaceChildren();
    setStatus(status, 'Selecciona una cafetería y un año.', 'muted');
    return;
  }
  setStatus(status, 'Cargando matriz anual de gastos…');
  try {
    const months = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const month = `${year}-${String(index + 1).padStart(2, '0')}`;
      return apiRequest(`/api/financial-results/general-expenses?${new URLSearchParams({ location, month })}`);
    }));
    if (location !== document.getElementById('financial-general-expenses-location').value
      || year !== document.getElementById('financial-general-expenses-year').value) return;
    const categories = months[0].categories;
    financialGeneralExpensesGridState = { location, year, categories, months, dirtyMonths: new Set() };
    const monthLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sept', 'Oct', 'Nov', 'Dic'];
    const headRow = document.createElement('tr');
    ['Concepto', ...monthLabels, 'Total anual'].forEach((label, index) => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      if (index >= 2 && index <= 12) {
        const monthNumber = index;
        cell.className = 'financial-general-expenses-copy-month';
        cell.title = `Doble clic para copiar ${monthLabels[monthNumber - 2]} en ${monthLabels[monthNumber - 1]}`;
        cell.addEventListener('dblclick', () => copyPreviousFinancialExpenseMonth(monthNumber, monthLabels));
      } else if (index === 1) cell.title = 'Enero no tiene una columna anterior visible en este año.';
      headRow.appendChild(cell);
    });
    document.getElementById('financial-general-expenses-head').replaceChildren(headRow);
    grid.replaceChildren(...categories.map(category => {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = category.label;
      row.appendChild(heading);
      months.forEach((data, index) => {
        const month = String(index + 1).padStart(2, '0');
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off';
        input.name = category.key; input.dataset.category = category.key; input.dataset.month = month;
        input.value = category.key==='inventoryDifference' && data.values[category.key]==null ? '' : String(Number(data.values[category.key]) || 0);
        if(category.key==='inventoryDifference'){input.placeholder='Automático';input.title='Vacío: cálculo automático. Positivo: pérdida/gasto; negativo: sobrante. Se prorratea por días del mes.';}
        formatFinancialGeneralExpenseInput(input);
        input.classList.toggle('unconfigured', !data.configured);
        input.setAttribute('aria-label', `${category.label}, ${monthLabels[index]} ${year}`);
        input.addEventListener('focus', () => { input.value = financialGeneralExpenseInputValue(input)===null ? '' : String(financialGeneralExpenseInputValue(input)); input.select(); });
        input.addEventListener('blur', () => formatFinancialGeneralExpenseInput(input));
        input.addEventListener('input', () => {
          const sign=category.key==='inventoryDifference' && input.value.startsWith('-')?'-':'';
          input.value = sign+input.value.replace(/[^\d]/g, '').slice(0, 10);
          financialGeneralExpensesGridState.dirtyMonths.add(month);
          document.querySelectorAll(`#financial-general-expenses-grid input[data-month="${month}"]`)
            .forEach(monthInput => monthInput.classList.add('modified'));
          updateFinancialGeneralExpensesTotal();
        });
        cell.appendChild(input);
        row.appendChild(cell);
      });
      const total = document.createElement('td');
      total.className = 'financial-general-expenses-row-total';
      total.dataset.expenseRowTotal = category.key;
      row.appendChild(total);
      return row;
    }));
    const footRow = document.createElement('tr');
    const totalHeading = document.createElement('th');
    totalHeading.scope = 'row'; totalHeading.textContent = 'Total mensual';
    footRow.appendChild(totalHeading);
    for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
      const cell = document.createElement('td');
      cell.className = 'financial-general-expenses-month-total';
      cell.dataset.expenseMonthTotal = String(monthNumber).padStart(2, '0');
      footRow.appendChild(cell);
    }
    const annualCell = document.createElement('td');
    annualCell.dataset.expenseAnnualTotal = 'true';
    footRow.appendChild(annualCell);
    document.getElementById('financial-general-expenses-foot').replaceChildren(footRow);
    updateFinancialGeneralExpensesTotal();
    const configuredMonths = months.filter(data => data.configured).length;
    setStatus(status, `${months[0].location.name} · ${year}: ${configuredMonths} de 12 meses configurados. Los meses sin configurar se muestran en cero, pero no se consideran confirmados.`,
      configuredMonths === 12 ? 'success' : 'muted');
  } catch (error) {
    financialGeneralExpensesGridState = null;
    grid.replaceChildren();
    setStatus(status, error.message, 'error');
  }
}

async function saveFinancialGeneralExpenses() {
  const form = document.getElementById('financial-general-expenses-form');
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('financial-general-expenses-status');
  const location = document.getElementById('financial-general-expenses-location').value;
  const year = document.getElementById('financial-general-expenses-year').value;
  const dirtyMonths = [...(financialGeneralExpensesGridState?.dirtyMonths || [])].sort();
  if (!dirtyMonths.length) {
    setStatus(status, 'No hay meses modificados para guardar.', 'muted');
    return;
  }
  button.disabled = true;
  setStatus(status, `Guardando ${dirtyMonths.length} mes(es) modificado(s)…`);
  try {
    await Promise.all(dirtyMonths.map(month => {
      const values = Object.fromEntries([...document.querySelectorAll(`#financial-general-expenses-grid input[data-month="${month}"]`)]
        .map(input => [input.name, financialGeneralExpenseInputValue(input)]));
      return apiRequest('/api/financial-results/general-expenses', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, month: `${year}-${month}`, values })
      });
    }));
    await loadFinancialGeneralExpenses();
    setStatus(status, `${dirtyMonths.length} mes(es) guardado(s). El estado de resultados fue actualizado.`, 'success');
    await loadFinancialResults();
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function financialPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function financialCell(value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function renderFinancialMetricRows(targetId, rows) {
  const body = document.getElementById(targetId);
  body.replaceChildren(...rows.map(item => {
    const row = document.createElement('tr');
    row.append(
      financialCell(item.label),
      financialCell(formatClp(item.netSales), 'numeric-cell'),
      financialCell(financialPercent(item.salesSharePercent), 'numeric-cell'),
      financialCell(financialPercent(item.marginPercent), 'numeric-cell'),
      financialCell(item.contributionMargin === null ? '—' : formatClp(item.contributionMargin), 'numeric-cell')
    );
    if (!item.costAvailable) row.classList.add('financial-incomplete-row');
    return row;
  }));
}

function financialCoverageLabel(expense) {
  if (!expense.available) return 'Sin datos';
  if (expense.complete) return 'Completa';
  return `${expense.coveredLocations} de ${expense.totalLocations} ubic.`;
}

function renderFinancialStatement(data) {
  const body = document.getElementById('financial-statement-body');
  const total = data.revenue.total;
  const statement = data.statement;
  const rows = [];
  const percentOfSales = amount => amount === null || amount === undefined || !statement.netSales
    ? null
    : Number(amount) / statement.netSales * 100;
  const append = ({ label, amount, percentage = null, className = '', context = '' }) => {
    const row = document.createElement('tr');
    row.className = className;
    const labelCell = financialCell(label);
    if (context) {
      const detail = document.createElement('small');
      detail.className = 'financial-line-context';
      detail.textContent = context;
      labelCell.appendChild(detail);
    }
    row.append(
      labelCell,
      financialCell(amount === null ? '—' : formatClp(amount), 'numeric-cell'),
      financialCell(financialPercent(percentage), 'numeric-cell financial-sales-percent')
    );
    rows.push(row);
  };
  append({
    label: 'Ventas Netas (sin IVA)', amount: statement.netSales,
    percentage: 100,
    context: `${data.revenue.filesRead} archivo(s) de ventas procesado(s). Última venta registrada: ${formatReportDate(data.revenue.latestSaleDate)}.`, className: 'financial-primary-row financial-highlight-row'
  });
  const productCostAmount = statement.productCost === null ? null : -statement.productCost;
  append({
    label: 'Costo directo de productos',
    amount: productCostAmount,
    percentage: percentOfSales(productCostAmount),
    context: `Fuentes vigentes al corte del reporte. Costo disponible en ${data.revenue.linesWithCost} de ${data.revenue.lineCount} líneas; ${data.revenue.costSources?.['sales-export'] || 0} usan Costo del archivo de ventas como respaldo. Confirmar base sin IVA de cada fuente.`, className: 'financial-cost-row'
  });
  append({
    label: 'Margen de Contribución', amount: statement.contributionMargin,
    percentage: percentOfSales(statement.contributionMargin),
    context: `Cobertura de costos ${total.costAvailable ? 'completa' : 'incompleta'} (${data.revenue.linesWithCost} de ${data.revenue.lineCount} líneas).`, className: 'financial-subtotal-row financial-highlight-row'
  });
  statement.expenses.forEach(expense => {
    const coverage = financialCoverageLabel(expense);
    let context = `Cobertura: ${coverage}.`;
    if(expense.key==='inventoryDifference' && expense.locations?.some(item=>item.source==='monthly-override')) {
      context=`Incluye montos mensuales digitados, prorrateados por días, que reemplazan el cálculo automático en los meses informados. Cobertura: ${coverage}.`;
    } else if (expense.key === 'inventoryDifference' && expense.available) {
      const adjustments = (expense.locations || []).reduce((totalAdjustment, location) => {
        const detail = location.adjustments || {};
        totalAdjustment.lac001 += Number(detail.lac001SubstitutionCost) || 0;
        totalAdjustment.syrup += Number(detail.syrupSauceSubstitutionCost) || 0;
        totalAdjustment.packaging += Number(detail.avoidedPackagingCost) || 0;
        return totalAdjustment;
      }, { lac001: 0, syrup: 0, packaging: 0 });
      context = `Ajustes descontados: leche ${formatClp(adjustments.lac001)}, syrup/salsas ${formatClp(adjustments.syrup)} y vasos/tapas ${formatClp(adjustments.packaging)}. Cobertura: ${coverage}.`;
    } else if (expense.key === 'mercadoPago' && expense.available) {
      const detail = expense.detail || {};
      context = `Comisión con IVA ${formatClp(detail.grossAmount)} ÷ ${detail.vatFactor || 1.18} = neto ${formatClp(expense.amount)}. Cobertura: ${coverage}.`;
    } else if (expense.basis === 'monthly-prorated') {
      context = `Base mensual prorrateada por días del período. ${expense.configuredRecords} de ${expense.expectedRecords} combinación(es) cafetería/mes configuradas. Cobertura: ${coverage}.`;
    }
    const amount = expense.available ? -expense.amount : null;
    append({
      label: expense.label,
      amount,
      percentage: percentOfSales(amount),
      className: expense.available ? 'financial-expense-row' : 'financial-incomplete-row',
      context
    });
  });
  const knownExpenseAmount = -statement.knownOperatingExpenses;
  append({
    label: 'Total gastos operacionales 4Wall', amount: knownExpenseAmount,
    percentage: percentOfSales(knownExpenseAmount),
    context: statement.dataCoverageComplete ? 'Fuentes conocidas completas.' : 'Existen fuentes conocidas incompletas.',
    className: 'financial-subtotal-row'
  });
  append({
    label: 'EBITDA (4 Wall)', amount: statement.operationalResult4Wall ?? statement.partialResult,
    percentage: percentOfSales(statement.partialResult),
    context: statement.partial ? 'Resultado provisional: existen fuentes o meses sin cobertura completa.' : 'Cobertura operacional completa para el período.',
    className: `financial-result-row financial-highlight-row ${(statement.partialResult || 0) < 0 ? 'negative' : 'positive'}`
  });
  if (data.scope.location === 'all' && statement.headOffice) {
    const headOfficeAmount = statement.headOffice.available ? -statement.headOffice.amount : null;
    append({
      label: 'Casa Matriz', amount: headOfficeAmount,
      percentage: percentOfSales(headOfficeAmount),
      context: statement.headOffice.available
        ? `Gastos mensuales de oficina central prorrateados al período. ${statement.headOffice.configuredRecords} de ${statement.headOffice.expectedRecords} mes(es) configurados.`
        : 'Sin gastos configurados para Casa Matriz en el período.',
      className: statement.headOffice.available ? 'financial-expense-row' : 'financial-incomplete-row'
    });
    append({
      label: 'EBITDA Brewit (con Casa Matriz)', amount: statement.operationalResultWithHeadOffice,
      percentage: percentOfSales(statement.operationalResultWithHeadOffice),
      context: statement.headOffice.complete
        ? 'Resultado consolidado después de gastos de Casa Matriz.'
        : 'Resultado pendiente: faltan meses de Casa Matriz por configurar.',
      className: `financial-result-row financial-highlight-row ${(statement.operationalResultWithHeadOffice || 0) < 0 ? 'negative' : 'positive'}`
    });
  }
  body.replaceChildren(...rows);
}

function financialMiniTable(title, items) {
  const section = document.createElement('section');
  section.className = 'financial-hierarchy-detail';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const table = document.createElement('table');
  table.className = 'financial-table compact';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Línea</th><th>Venta</th><th>Participación</th><th>Margen %</th><th>Margen contribución</th></tr>';
  const body = document.createElement('tbody');
  body.replaceChildren(...items.map(item => {
    const row = document.createElement('tr');
    row.append(
      financialCell(item.label),
      financialCell(formatClp(item.netSales), 'numeric-cell'),
      financialCell(financialPercent(item.salesSharePercent), 'numeric-cell'),
      financialCell(financialPercent(item.marginPercent), 'numeric-cell'),
      financialCell(item.contributionMargin === null ? '—' : formatClp(item.contributionMargin), 'numeric-cell')
    );
    return row;
  }));
  table.append(head, body);
  section.append(heading, table);
  return section;
}

function renderFinancialHierarchies(groups) {
  const list = document.getElementById('financial-hierarchy-list');
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-description financial-empty';
    empty.textContent = 'No hay líneas de venta disponibles para este período.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...groups.map((group, index) => {
    const details = document.createElement('details');
    details.className = 'financial-hierarchy-item';
    if (index === 0) details.open = true;
    const summary = document.createElement('summary');
    const title = document.createElement('strong');
    title.textContent = group.label;
    const metrics = document.createElement('span');
    metrics.className = 'financial-hierarchy-metrics';
    [
      ['Venta', formatClp(group.netSales)],
      ['Participación', financialPercent(group.salesSharePercent)],
      ['Margen', financialPercent(group.marginPercent)],
      ['Aporte', group.contributionMargin === null ? '—' : formatClp(group.contributionMargin)]
    ].forEach(([label, value]) => {
      const metric = document.createElement('span');
      const caption = document.createElement('small');
      caption.textContent = label;
      const amount = document.createElement('b');
      amount.textContent = value;
      metric.append(caption, amount);
      metrics.appendChild(metric);
    });
    summary.append(title, metrics);
    const breakdowns = document.createElement('div');
    breakdowns.className = 'financial-hierarchy-breakdowns';
    breakdowns.append(financialMiniTable('Por barra', group.bars), financialMiniTable('Por ingrediente principal', group.ingredients));
    details.append(summary, breakdowns);
    return details;
  }));
}

function renderFinancialResults(data) {
  const statement = data.statement;
  const cards = [
    ['Ventas netas', formatClp(statement.netSales), ''],
    ['Margen contribución', statement.contributionMargin === null ? '—' : formatClp(statement.contributionMargin), ''],
    ['Margen %', financialPercent(statement.contributionMarginPercent), ''],
    ['Gastos operacionales', formatClp(statement.knownOperatingExpenses), 'expense'],
    ['EBITDA (4 Wall)', statement.operationalResult4Wall === null ? '—' : formatClp(statement.operationalResult4Wall), (statement.operationalResult4Wall || 0) < 0 ? 'negative' : 'positive']
  ];
  document.getElementById('financial-results-summary').replaceChildren(...cards.map(([label, value, tone]) => {
    const card = document.createElement('article');
    card.className = `financial-summary-card ${tone}`.trim();
    const caption = document.createElement('span');
    caption.textContent = label;
    const amount = document.createElement('strong');
    amount.textContent = value;
    card.append(caption, amount);
    return card;
  }));
  document.getElementById('financial-statement-context').textContent =
    `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · Costo al corte del reporte.`;
  const badge = document.getElementById('financial-statement-badge');
  badge.textContent = statement.dataCoverageComplete ? 'EBITDA 4 Wall · cobertura completa' : 'EBITDA 4 Wall · revisar cobertura';
  badge.className = `chip ${statement.dataCoverageComplete ? 'positive' : 'neutral'}`;
  renderFinancialStatement(data);
  renderFinancialWarnings(data);
}

function renderFinancialCosts(data) {
  document.getElementById('financial-costs-context').textContent =
    `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · Costo al corte del reporte.`;
  const missingCosts = data.revenue.missingCostProducts || [];
  const missingPanel = document.getElementById('financial-missing-costs');
  missingPanel.hidden = !missingCosts.length;
  const costsEmpty = document.getElementById('financial-costs-empty');
  costsEmpty.hidden = Boolean(missingCosts.length);
  costsEmpty.textContent = 'No hay productos sin costo calculable en el período consultado.';
  if (missingCosts.length) {
    const affectedLines = missingCosts.reduce((sum, item) => sum + item.lines, 0);
    const affectedSales = missingCosts.reduce((sum, item) => sum + item.netSales, 0);
    document.getElementById('financial-missing-costs-summary').textContent =
      `${affectedLines} línea(s) y ${formatClp(affectedSales)} de venta neta afectada. No se supone costo cero; completa recetas, conversiones o fuentes de costo antes de interpretar el margen.`;
    const reasonLabel = item => ({
      'no-effective-catalog': 'Sin maestro vigente en esa fecha',
      'not-in-effective-catalog': 'Producto ausente del maestro vigente',
      'no-positive-convertible-cost': 'Sin costo positivo o convertible',
      'recipe-component-missing': `Ingrediente sin costo: ${item.missingComponent || 'sin identificar'}`,
      'recipe-unit-conversion': 'Unidad de receta no convertible',
      'recipe-cycle': 'Ciclo en la receta'
    })[item.reason] || 'Costo no calculable';
    document.getElementById('financial-missing-costs-body').replaceChildren(...missingCosts.map(item => {
      const row = document.createElement('tr');
      row.append(
        financialCell(item.code || '—'), financialCell(item.name || '—'), financialCell(reasonLabel(item)),
        financialCell(Number(item.lines || 0).toLocaleString('es-CL'), 'numeric-cell'),
        financialCell(formatClp(item.netSales), 'numeric-cell'),
        financialCell(formatReportDate(item.firstDate)), financialCell(formatReportDate(item.lastDate))
      );
      return row;
    }));
  } else document.getElementById('financial-missing-costs-body').replaceChildren();
  renderFinancialWarnings(data, 'financial-costs-warnings');
}

function renderFinancialWarnings(data, targetId = 'financial-warnings') {
  const warnings = document.getElementById(targetId);
  const warningList = document.getElementById(`${targetId}-list`);
  warningList.replaceChildren(...data.warnings.map((message, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'financial-warning-detail-button';
    button.textContent = message; button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => openFinancialWarningDetail(data.warningDetails?.[index] || {
      message, explanation: message, action: 'Actualiza el reporte para obtener los antecedentes de esta advertencia.', rows: []
    }, data.period));
    item.append(button); return item;
  }));
  warnings.hidden = !data.warnings.length;
}

function openFinancialWarningDetail(detail, period) {
  const dialog = document.createElement('dialog');
  dialog.className = 'inventory-report-dialog finding-evidence-dialog financial-warning-dialog';
  dialog.setAttribute('aria-labelledby', 'financial-warning-dialog-title');
  const head = document.createElement('div'); head.className = 'preview-dialog-head';
  const title = document.createElement('h2'); title.id = 'financial-warning-dialog-title'; title.textContent = 'Datos que requieren revisión';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => dialog.close()); head.append(title, close); dialog.append(head);
  const paragraph = (text, className = '') => { const p = document.createElement('p'); p.textContent = text; p.className = className; dialog.append(p); };
  paragraph(detail.message, 'financial-warning-message');
  if (period) paragraph(`Período revisado: ${formatReportDate(period.from)} – ${formatReportDate(period.to)}`);
  paragraph(detail.explanation);
  const actionTitle = document.createElement('h3'); actionTitle.textContent = 'Qué revisar y corregir'; dialog.append(actionTitle);
  paragraph(detail.action, 'financial-warning-action');
  const rows = detail.rows || [];
  if (rows.length) {
    const heading = document.createElement('h3'); heading.textContent = `Antecedentes · ${rows.length} registro(s)`; dialog.append(heading);
    const wrap = document.createElement('div'); wrap.className = 'financial-warning-evidence'; wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Antecedentes de la advertencia, tabla desplazable');
    const table = document.createElement('table'); table.className = 'sales-dashboard-table';
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const headRow = table.createTHead().insertRow();
    columns.forEach(key => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = key; headRow.append(th); });
    const body = table.createTBody();
    const sourceLabels = { master: 'Maestro', recipe: 'Receta', purchase: 'Compra', 'sales-export': 'Archivo de ventas', missing: 'Sin costo' };
    rows.forEach(record => {
      const row = body.insertRow();
      columns.forEach(key => {
        const value = record[key]; const cell = row.insertCell();
        cell.textContent = value == null || value === '' ? 'No disponible'
          : key === 'Fuente' ? sourceLabels[value] || value
          : typeof value === 'number' ? /costo|subtotal|venta neta/i.test(key) ? formatClp(value) : value.toLocaleString('es-CL', { maximumFractionDigits: 4 })
          : typeof value === 'object' ? JSON.stringify(value) : String(value);
      });
    });
    wrap.append(table); dialog.append(wrap);
  }
  if (detail.note) paragraph(detail.note);
  paragraph('Después de corregir las fuentes, vuelve a procesar Estado de resultados para comprobar si la advertencia se resuelve.');
  const previousFocus = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); previousFocus?.focus(); });
  document.body.append(dialog); dialog.showModal(); close.focus();
}

async function loadFinancialResults(kind = 'statement') {
  const prefix = kind === 'costs' ? 'financial-costs' : 'financial-results';
  const calculation = kind === 'costs' ? 'financialCosts' : 'financial';
  const status = document.getElementById(`${prefix}-status`);
  const form = document.getElementById(`${prefix}-filters`);
  const button = form.querySelector('button[type="submit"]');
  const location = document.getElementById(`${prefix}-location`).value || 'all';
  const dateFrom = document.getElementById(`${prefix}-from`).value;
  const dateTo = document.getElementById(`${prefix}-to`).value;
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    setStatus(status, 'Selecciona un período válido.', 'error');
    return;
  }
  const filterIds = ['location', 'period', 'from', 'to'].map(field => `${prefix}-${field}`);
  const request = beginCalculation(calculation, selectedCalculationKey(filterIds));
  button.disabled = true;
  setStatus(status, 'Calculando ventas, márgenes, inventario y cobros de MercadoPago…');
  try {
    const params = new URLSearchParams({ location, dateFrom, dateTo });
    const data = await apiRequest(`/api/financial-results?${params}`, { signal: request.controller.signal });
    if (!isCurrentCalculation(calculation, request, filterIds)) return;
    calculatedViewKeys.set(calculation, request.key);
    if (kind === 'costs') renderFinancialCosts(data);
    else { financialResultsState = data; renderFinancialResults(data); }
    setStatus(status, `${data.revenue.lineCount} línea(s) de venta procesadas para ${data.scope.label}.`, 'success');
  } catch (error) {
    if (!isCurrentCalculation(calculation, request, filterIds)) return;
    setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get(calculation) === request) {
      calculatedViewRequests.delete(calculation);
      button.disabled = false;
    }
  }
}

function salesReportFilterIds(prefix) {
  const ids = ['location', 'period', 'from', 'to'].map(name => `${prefix}-${name}`);
  if (prefix === 'sales-insight') ids.push('sales-insight-bar', 'sales-insight-formats');
  return ids;
}

function salesReportKey(prefix) {
  const values = salesReportFilterIds(prefix).map(id => {
    const input = document.getElementById(id);
    return input.type === 'checkbox' ? input.checked : input.value;
  });
  if (prefix === 'sales-ingredients') values.push([...selectedSalesAnalysis].sort());
  return JSON.stringify(values);
}

function markSalesReportDirty(prefix) {
  calculatedViewRequests.get(prefix)?.controller.abort();
  calculatedViewRequests.delete(prefix);
  if (prefix === 'sales-ingredients') updateSalesAnalysisSelectionCount();
  const button = document.querySelector(`#${prefix}-filters button[type="submit"]`);
  button.disabled = false;
  const previous = calculatedViewKeys.has(prefix);
  setStatus(document.getElementById(salesReportDefinitions[prefix].status), previous
    ? `Los filtros cambiaron. El resultado visible conserva la última consulta; pulsa ${button.textContent} para aplicar la selección.`
    : `Selecciona los filtros y pulsa ${button.textContent}.`, 'muted');
}

async function loadSalesReport(prefix) {
  const definition = salesReportDefinitions[prefix];
  if (definition.type === 'ingredients') return loadSalesIngredientsView();
  const status = document.getElementById(definition.status);
  const button = document.querySelector(`#${prefix}-filters button[type="submit"]`);
  const location = document.getElementById(`${prefix}-location`).value || 'all';
  const hasPeriod = definition.type !== 'customers';
  const dateFrom = hasPeriod ? document.getElementById(`${prefix}-from`).value : null;
  const dateTo = hasPeriod ? document.getElementById(`${prefix}-to`).value : null;
  if (hasPeriod && (!dateFrom || !dateTo || dateFrom > dateTo || dateTo > browserIsoToday())) {
    setStatus(status, 'Selecciona un período válido, sin superar el día actual.', 'error');
    return;
  }
  const filters = { bar: document.getElementById('sales-insight-bar').value,
    groupFormats: document.getElementById('sales-insight-formats').checked };
  const request = beginCalculation(prefix, salesReportKey(prefix));
  const current = () => calculatedViewRequests.get(prefix) === request && salesReportKey(prefix) === request.key;
  button.disabled = true;
  setStatus(status, 'Generando reporte con los datos guardados…');
  try {
    const params = new URLSearchParams({ location });
    let endpoint = '/api/sales/dashboard';
    if (['participation', 'hierarchies'].includes(definition.type)) {
      endpoint = '/api/financial-results';
      params.set('dateFrom', dateFrom); params.set('dateTo', dateTo);
    } else if (hasPeriod) {
      const queryPrefix = { service: 'service', products: 'insight' }[definition.type];
      params.set(`${queryPrefix}DateFrom`, dateFrom); params.set(`${queryPrefix}DateTo`, dateTo);
    }
    const data = await apiRequest(`${endpoint}?${params}`, { signal: request.controller.signal });
    if (!current()) return;
    if (definition.type === 'participation') {
      renderFinancialMetricRows('financial-bars-body', data.revenue.bars);
      renderFinancialMetricRows('financial-ingredients-body', data.revenue.ingredients);
    } else if (definition.type === 'hierarchies') renderFinancialHierarchies(data.revenue.hierarchies);
    else if (definition.type === 'service') {
      salesServiceModeState = data;
      renderSalesServiceModes();
    } else if (definition.type === 'products') {
      salesDashboardState = data;
      salesProductFilters = filters;
      salesHierarchyPath = [];
      renderSalesInsights();
    }
    calculatedViewKeys.set(prefix, request.key);
    document.getElementById(`${prefix}-context`).textContent = hasPeriod
      ? `${data.scope.label} · ${formatReportDate(dateFrom)} – ${formatReportDate(dateTo)}${endpoint === '/api/financial-results' ? ' · Costo al corte del reporte.' : ''}`
      : `${data.scope.label} · Últimos 6 meses y últimas 8 semanas · Corte al ${formatReportDate(data.date)}.`;
    const message = endpoint === '/api/financial-results'
      ? `${data.revenue.lineCount} línea(s) de venta procesadas para ${data.scope.label}.`
      : definition.type === 'service' ? status.textContent : 'Reporte generado.';
    const warnings = data.warnings || [];
    setStatus(status, `${message}${warnings.length ? ` ${warnings.join(' ')}` : ''}`, warnings.length ? 'warning' : 'success');
  } catch (error) {
    if (current()) setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get(prefix) === request) {
      calculatedViewRequests.delete(prefix);
      button.disabled = false;
    }
  }
}

function transactionAuditPeriodRange() {
  const period = document.getElementById('transaction-audit-period').value;
  const today = browserIsoToday();
  if (period === 'custom') {
    return {
      from: document.getElementById('transaction-audit-from').value,
      to: document.getElementById('transaction-audit-to').value
    };
  }
  if (period === 'today') return { from: today, to: today };
  if (period === 'yesterday') {
    const yesterday = offsetIsoDate(today, -1);
    return { from: yesterday, to: yesterday };
  }
  if (period === 'current-week' || period === 'previous-week') {
    const date = dateFromKey(today);
    const mondayOffset = -((date.getDay() + 6) % 7) + (period === 'previous-week' ? -7 : 0);
    const from = offsetIsoDate(today, mondayOffset);
    return { from, to: period === 'previous-week' ? offsetIsoDate(from, 6) : today };
  }
  if (period === 'current-month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: offsetIsoDate(today, period === 'last-60' ? -59 : -29), to: today };
}

function syncTransactionAuditPeriod() {
  const custom = document.getElementById('transaction-audit-period').value === 'custom';
  document.getElementById('transaction-audit-custom-dates').hidden = !custom;
  if (!custom) {
    const range = transactionAuditPeriodRange();
    document.getElementById('transaction-audit-from').value = range.from;
    document.getElementById('transaction-audit-to').value = range.to;
  }
}

function refreshTransactionAuditLocationFilter() {
  const select = document.getElementById('transaction-audit-location');
  if (!select) return;
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  Object.values(locationRegistry)
    .filter(location => location.type === 'store')
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))
    .forEach(location => options.push(new Option(location.name, location.id)));
  select.replaceChildren(...options);
  select.value = previous === 'all' || locationRegistry[previous] ? previous : 'all';
}

function transactionAuditFilterValue(id) {
  const value = document.getElementById(id).value.trim();
  return value ? value : null;
}

function renderTransactionAuditSummary() {
  const container = document.getElementById('transaction-audit-summary');
  const summary = transactionAuditState?.summary;
  container.replaceChildren();
  document.getElementById('transaction-audit-reconciliation-note').hidden = !summary;
  if (!summary) return;
  const reconciliation = summary.paymentReconciliation || {};
  const withoutComparison = Number(summary.transactions || 0) - Number(reconciliation.matched || 0) - Number(reconciliation.difference || 0);
  const cards = [
    ['Transacciones', Number(summary.transactions || 0).toLocaleString('es-CL')],
    ['Venta antes de descuentos', formatClp(summary.saleBeforeDiscount)],
    ['Descuentos', `${formatClp(summary.discountAmount)} · ${Number(summary.discountPercent || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`],
    ['Venta con descuentos', formatClp(summary.saleWithDiscount)],
    ['Venta neta sin IVA', formatClp(summary.netSale)],
    ['Unidades', Number(summary.units || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
    ['Coinciden con Detalle Pagos', Number(reconciliation.matched || 0).toLocaleString('es-CL')],
    ['Diferencia por revisar', Number(reconciliation.difference || 0).toLocaleString('es-CL')],
    ['Sin comparación confiable', withoutComparison.toLocaleString('es-CL')],
    ['A Pagar parcial', Number(summary.paymentDuePartial || 0).toLocaleString('es-CL')],
    ['Señales de reversión', Number(summary.reversalReviewRequired || 0).toLocaleString('es-CL')]
  ];
  cards.forEach(([label, value]) => {
    const article = document.createElement('article');
    const heading = document.createElement('span');
    heading.textContent = label;
    const metric = document.createElement('strong');
    metric.textContent = value;
    article.append(heading, metric);
    container.appendChild(article);
  });
}

function transactionAuditComparable(transaction, key) {
  if (key === 'date') return `${transaction.date}T${transaction.time}`;
  const value = transaction[key];
  return typeof value === 'number' ? value : String(value || '').toLocaleLowerCase('es');
}

function transactionAuditSortedRows() {
  const direction = transactionAuditSort.direction === 'asc' ? 1 : -1;
  return [...(transactionAuditState?.transactions || [])].sort((left, right) => {
    const leftValue = transactionAuditComparable(left, transactionAuditSort.key);
    const rightValue = transactionAuditComparable(right, transactionAuditSort.key);
    if (typeof leftValue === 'number' && typeof rightValue === 'number') return (leftValue - rightValue) * direction;
    return String(leftValue).localeCompare(String(rightValue), 'es', { numeric: true }) * direction;
  });
}

function transactionAuditCell(value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value;
  return cell;
}

function transactionAuditReconciliationLabel(reconciliation) {
  const labels = {
    matched: 'Coincide', difference: 'Revisar diferencia',
    'not-linked': 'Sin pedido vinculado', 'no-source': 'Sin archivo de pagos',
    ambiguous: 'Importes múltiples', 'no-amount': 'Sin importe',
    'no-sale-amount': 'Sin venta comparable', 'review-reversal': 'Revisar reversión'
  };
  return labels[reconciliation?.status] || 'Sin comparación';
}

function renderAuditSourceDiagnostics() {
  const panel = document.getElementById('transaction-audit-sources');
  const diagnostics = transactionAuditState?.sourceDiagnostics;
  panel.hidden = !diagnostics;
  if (!diagnostics) return;
  document.getElementById('transaction-audit-sources-note').textContent =
    `${diagnostics.note} Esta tabla muestra todas las actividades del período, independientemente de los filtros de monto y descuento de arriba. Las fechas sin registros observados no se interpretan como venta cero.`;
  document.getElementById('transaction-audit-sources-files').replaceChildren(...diagnostics.filesByStore.map(store => {
    const item = document.createElement('span');
    item.textContent = `${store.locationName}: ${store.sales} archivo(s) de ventas, ${store.paymentDetails} de Detalle Pagos, ${store.mercadoPago} de MercadoPago`;
    return item;
  }));
  const sourceBody = document.getElementById('transaction-audit-sources-body');
  sourceBody.replaceChildren(...diagnostics.rows.map(item => {
    const row = document.createElement('tr');
    row.append(
      transactionAuditCell(item.locationName),
      transactionAuditCell(formatReportDate(item.date)),
      transactionAuditCell(String(item.salesOrders), 'numeric-cell'),
      transactionAuditCell(String(item.paymentLinked), 'numeric-cell'),
      transactionAuditCell(String(item.paymentMatched), 'numeric-cell'),
      transactionAuditCell(String(item.paymentDifference), 'numeric-cell'),
      transactionAuditCell(String(item.paymentUncertain), 'numeric-cell'),
      transactionAuditCell(String(item.paymentPartialDue), 'numeric-cell'),
      transactionAuditCell(String(item.reversalReviewRequired || 0), 'numeric-cell'),
      transactionAuditCell(String(item.mpSettlements), 'numeric-cell'),
      transactionAuditCell(item.mpWithoutAmount ? `${formatClp(item.mpAmount)} · ${item.mpWithoutAmount} sin importe` : formatClp(item.mpAmount), 'numeric-cell'),
      transactionAuditCell(item.mpWithoutFee ? `${formatClp(item.mpFeesGross)} · ${item.mpWithoutFee} sin comisión` : formatClp(item.mpFeesGross), 'numeric-cell')
    );
    return row;
  }));
  if (!diagnostics.rows.length) {
    const row = document.createElement('tr');
    const cell = transactionAuditCell('Sin actividad observada en las fuentes para este período; no equivale a venta cero.');
    cell.colSpan = 12;
    row.appendChild(cell);
    sourceBody.appendChild(row);
  }
  const warning = document.getElementById('transaction-audit-sources-warnings');
  warning.hidden = !diagnostics.warnings?.length;
  warning.textContent = (diagnostics.warnings || []).join(' ');
}

function buildTransactionAuditDetail(transaction) {
  const row = document.createElement('tr');
  row.className = 'transaction-audit-detail-row';
  const cell = document.createElement('td');
  cell.colSpan = 14;
  const detail = document.createElement('div');
  detail.className = 'transaction-audit-detail';
  const title = document.createElement('h4');
  title.textContent = `Detalle completo del pedido ${transaction.orderReference}`;
  const facts = document.createElement('dl');
  facts.className = 'transaction-audit-facts';
  [
    ['Cafetería', transaction.locationName],
    ['Fecha y hora', `${formatReportDate(transaction.date)} · ${transaction.time}`],
    ['Modalidad', transaction.modeLabel],
    ['Clientes informados', Number(transaction.clients || 0).toLocaleString('es-CL')],
    ['Venta antes de descuentos', formatClp(transaction.saleBeforeDiscount)],
    ['Descuento', `${formatClp(transaction.discountAmount)} (${Number(transaction.discountPercent || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)`],
    ['Venta con descuentos', formatClp(transaction.saleWithDiscount)],
    ['Venta neta sin IVA', formatClp(transaction.netSale)],
    ['Costo neto', transaction.netCost == null ? 'Sin costo completo' : formatClp(transaction.netCost)],
    ['Margen', transaction.margin == null ? '—' : formatClp(transaction.margin)],
    ['Margen %', transaction.marginPercent == null ? '—' : `${transaction.marginPercent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`],
    ['Total Detalle Pagos', transaction.paymentTotal === null ? 'Sin información' : formatClp(transaction.paymentTotal)],
    ['A Pagar / Due', transaction.paymentDue === null ? 'Sin información' : formatClp(transaction.paymentDue)],
    ['A Pagar parcial', transaction.paymentDuePartial ? 'Sí; revisar composición de pagos' : 'No detectado'],
    ['Señales de reversión', transaction.reversalSignals?.length
      ? transaction.reversalSignals.map(signal => ({
        'negative-order-amount': 'Total del pedido negativo',
        'negative-quantity': 'Cantidad negativa',
        'negative-line-amount': 'Importe de línea negativo',
        'explicit-reversal-label': 'Etiqueta explícita de anulación/devolución'
      })[signal] || signal).join(' · ')
      : 'No detectadas en estos campos'],
    ['Base del cotejo', transaction.paymentReconciliation?.basis === 'total' ? 'Total del pedido' : transaction.paymentReconciliation?.basis === 'due' ? 'A Pagar (respaldo)' : 'Sin comparación'],
    ['Conciliación', `${transactionAuditReconciliationLabel(transaction.paymentReconciliation)}${transaction.paymentReconciliation?.difference !== null && transaction.paymentReconciliation?.difference !== undefined ? ` · diferencia venta − Detalle Pagos: ${formatClp(transaction.paymentReconciliation.difference)}` : ''}`],
    ['Comentario general', transaction.paymentComment || 'Sin información']
  ].forEach(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  });
  const subtitle = document.createElement('h5');
  subtitle.textContent = 'Productos y extras del pedido';
  const wrap = document.createElement('div');
  wrap.className = 'transaction-audit-lines-wrap';
  const table = document.createElement('table');
  table.className = 'transaction-audit-lines';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Código', 'Producto / extra', 'Tipo', 'Jerarquía', 'Cantidad', 'Precio lista', 'Venta con desc.', 'Venta neta'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  transaction.lines.forEach(line => {
    const lineRow = document.createElement('tr');
    lineRow.append(
      transactionAuditCell(line.code || '—'),
      transactionAuditCell(line.name || 'Sin nombre'),
      transactionAuditCell(line.type),
      transactionAuditCell(line.hierarchy),
      transactionAuditCell(Number(line.quantity || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), 'numeric-cell'),
      transactionAuditCell(formatClp(line.listPrice), 'numeric-cell'),
      transactionAuditCell(formatClp(line.grossSale), 'numeric-cell'),
      transactionAuditCell(formatClp(line.netSale), 'numeric-cell')
    );
    body.appendChild(lineRow);
  });
  table.append(head, body);
  wrap.appendChild(table);
  detail.append(title, facts, subtitle, wrap);
  cell.appendChild(detail);
  row.appendChild(cell);
  return row;
}

function renderTransactionAuditTable() {
  const body = document.getElementById('transaction-audit-body');
  body.replaceChildren();
  document.querySelectorAll('[data-audit-sort]').forEach(button => {
    const active = button.dataset.auditSort === transactionAuditSort.key;
    button.classList.toggle('active', active);
    button.closest('th').setAttribute('aria-sort', active ? (transactionAuditSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  });
  const transactions = transactionAuditSortedRows();
  if (!transactions.length) {
    const row = document.createElement('tr');
    const cell = transactionAuditCell('No hay transacciones que coincidan con los filtros seleccionados.', 'transaction-audit-empty');
    cell.colSpan = 14;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  transactions.forEach(transaction => {
    const row = document.createElement('tr');
    row.className = 'transaction-audit-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(expandedAuditTransactions.has(transaction.id)));
    row.title = 'Ver detalle completo del pedido';
    const discount = transactionAuditCell(`${Number(transaction.discountPercent || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`, 'numeric-cell');
    if (transaction.discountPercent > 0) discount.classList.add('transaction-audit-discount');
    row.append(
      transactionAuditCell(transaction.locationName),
      transactionAuditCell(formatReportDate(transaction.date)),
      transactionAuditCell(transaction.time),
      transactionAuditCell(formatClp(transaction.saleBeforeDiscount), 'numeric-cell'),
      discount,
      transactionAuditCell(formatClp(transaction.saleWithDiscount), 'numeric-cell'),
      transactionAuditCell(formatClp(transaction.netSale), 'numeric-cell'),
      transactionAuditCell(transaction.netCost == null ? 'Sin costo completo' : formatClp(transaction.netCost), 'numeric-cell'),
      transactionAuditCell(transaction.margin == null ? '—' : formatClp(transaction.margin), 'numeric-cell'),
      transactionAuditCell(transaction.marginPercent == null ? '—' : `${transaction.marginPercent.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`, 'numeric-cell'),
      transactionAuditCell(transaction.modeLabel),
      transactionAuditCell(transactionAuditReconciliationLabel(transaction.paymentReconciliation), `transaction-audit-reconciliation ${transaction.paymentReconciliation?.status || ''}`),
      transactionAuditCell(Number(transaction.units || 0).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), 'numeric-cell'),
      transactionAuditCell(transaction.orderReference, 'transaction-audit-order')
    );
    const toggle = () => {
      if (expandedAuditTransactions.has(transaction.id)) expandedAuditTransactions.delete(transaction.id);
      else expandedAuditTransactions.add(transaction.id);
      renderTransactionAuditTable();
      document.querySelector(`[data-audit-order-id="${CSS.escape(transaction.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    row.dataset.auditOrderId = transaction.id;
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    body.appendChild(row);
    if (expandedAuditTransactions.has(transaction.id)) body.appendChild(buildTransactionAuditDetail(transaction));
  });
}

async function loadTransactionAudit() {
  const status = document.getElementById('transaction-audit-status');
  const range = transactionAuditPeriodRange();
  if (!range.from || !range.to || range.from > range.to) {
    setStatus(status, 'Selecciona un rango de fechas válido.', 'error');
    return;
  }
  const parameters = new URLSearchParams({
    location: document.getElementById('transaction-audit-location').value || 'all',
    dateFrom: range.from,
    dateTo: range.to
  });
  [
    ['transaction-audit-min-amount', 'minAmount'],
    ['transaction-audit-max-amount', 'maxAmount'],
    ['transaction-audit-min-discount', 'minDiscount'],
    ['transaction-audit-max-discount', 'maxDiscount']
  ].forEach(([id, key]) => {
    const value = transactionAuditFilterValue(id);
    if (value !== null) parameters.set(key, value);
  });
  setStatus(status, 'Revisando y conciliando transacciones…');
  try {
    transactionAuditState = await apiRequest(`/api/transactions/audit?${parameters}`);
    expandedAuditTransactions.clear();
    renderTransactionAuditSummary();
    renderAuditSourceDiagnostics();
    renderTransactionAuditTable();
    const warning = transactionAuditState.warnings?.length ? ` ${transactionAuditState.warnings.length} archivo(s) no pudieron leerse.` : '';
    setStatus(status,
      `${formatReportDate(range.from)} – ${formatReportDate(range.to)} · ${transactionAuditState.summary.transactions.toLocaleString('es-CL')} transacción(es).${warning}`,
      transactionAuditState.warnings?.length ? 'muted' : 'success');
  } catch (error) {
    transactionAuditState = null;
    renderTransactionAuditSummary();
    renderAuditSourceDiagnostics();
    renderTransactionAuditTable();
    setStatus(status, error.message, 'error');
  }
}

function rankText(label, ranking) {
  return ranking?.position ? `${label}: #${ranking.position} de ${ranking.total}` : `${label}: —`;
}

const REPORT_CHART_COLORS = ['#b96f42', '#557a66', '#5875a4', '#b08a43', '#865d8d'];

function reportChartIconButton(key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'report-chart-button';
  button.dataset.reportChart = key;
  button.disabled = true;
  button.title = `Ver gráfico: ${label}`;
  button.setAttribute('aria-label', `Ver gráfico: ${label}`);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16M7 15l4-4 3 2 5-6"/></svg>';
  return button;
}

function installReportChartButtons() {
  const summary = [
    ['report-summary-day', 'Venta del día'],
    ['report-summary-week', 'Venta de la semana'],
    ['report-summary-month', 'Venta del mes'],
    ['report-summary-equivalent', 'Promedio del mismo día']
  ];
  document.querySelectorAll('#weekly-report .report-summary-grid .summary-card').forEach((card, index) => {
    const target = card.querySelector('.summary-head');
    if (target && summary[index]) target.appendChild(reportChartIconButton(...summary[index]));
  });
  const statisticBodies = [...document.querySelectorAll('#weekly-report .sales-statistics-card tbody[id]')];
  for (const body of statisticBodies) {
    const card = body.closest('.sales-statistics-card');
    const heading = card?.querySelector('h3');
    if (!heading || heading.parentElement?.classList.contains('report-chart-title-row')) continue;
    const row = document.createElement('div');
    row.className = 'report-chart-title-row';
    heading.before(row);
    row.append(heading, reportChartIconButton(body.id, heading.textContent));
  }
  const intradayHeading = document.querySelector('#weekly-report .intraday-heading > div:first-child');
  const intradayTitle = intradayHeading?.querySelector('h3');
  if (intradayTitle && !intradayTitle.parentElement.classList.contains('report-chart-title-row')) {
    const row = document.createElement('div');
    row.className = 'report-chart-title-row';
    intradayTitle.before(row);
    row.append(intradayTitle, reportChartIconButton('report-intraday', 'Seguimiento intradía'));
  }
  const networkHeading = document.querySelector('#network-sales-dashboard .network-sales-intro h3');
  if (networkHeading && !networkHeading.parentElement.classList.contains('report-chart-title-row')) {
    const row = document.createElement('div');
    row.className = 'report-chart-title-row';
    networkHeading.before(row);
    row.append(networkHeading, reportChartIconButton('report-network', 'Comparativo por local'));
  }
}

const ANALYTICAL_TABLE_CHART_RULES = [
  { selector: '#transaction-audit-workspace .transaction-audit-sources-table', types: ['line', 'bar'], chronological: true, categoryIndex: 1, title: 'Evolución de la cobertura de fuentes' },
  { selector: '#transaction-audit-workspace .transaction-audit-table', types: ['line', 'bar'], chronological: true, categoryIndex: 1, title: 'Análisis de descuentos' },
  { selector: '#sales-workspace #sales-service-mode-hierarchies', types: ['bar', 'pie'], pieHeaders: /./, title: 'Composición de ventas por modalidad' },
  { selector: '#sales-workspace #hourly-analysis-daily-body', types: ['line', 'bar'], chronological: true, title: 'Evolución diaria del análisis horario' },
  { selector: '#sales-workspace #hourly-analysis-bucket-body', types: ['bar'], title: 'Comparación por tramo horario' },
  { selector: '#sales-workspace #hourly-analysis-weekday-body', types: ['bar'], title: 'Comparación por día de la semana' },
  { selector: '#sales-workspace #mercadopago-month-history', types: ['line', 'bar'], chronological: true, title: 'Evolución mensual de recurrencia observable' },
  { selector: '#sales-workspace #mercadopago-week-history', types: ['line', 'bar'], chronological: true, title: 'Evolución semanal de recurrencia observable' },
  { selector: '#products-comparison .products-comparison-table', types: ['bar'], categoryIndex: 1, title: 'Comparación de precios, costos y márgenes' },
  { selector: '#products-hierarchy-list .products-table', types: ['bar'], categoryIndex: 1, title: 'Desempeño comparado de productos' },
  { selector: '#product-analysis-content .product-analysis-table', types: ['bar'], title: 'Análisis gráfico de productos' },
  { selector: '#cost-review-workspace .financial-table', types: ['bar'], title: 'Comparación de costos que requieren revisión' },
  { selector: '#ingredients-workspace .ingredients-table', types: ['bar', 'pie'], pieHeaders: /Consumo período|Costo consumido/i, title: 'Uso y costo de ingredientes' },
  { selector: '#purchases-groups .purchases-table', types: ['line', 'bar'], chronological: true, title: 'Evolución de compras del proveedor' },
  { selector: '#purchase-cost-variation-groups .purchase-cost-variation-table', types: ['bar'], title: 'Variaciones de costos de compra' },
  { selector: '#purchase-projection-workspace .purchase-projection-table', types: ['bar'], title: 'Proyección de compra por insumo' },
  { selector: '#financial-results-workspace .financial-statement-table', types: ['bar'], title: 'Composición de resultados financieros' },
  { selector: '#sales-workspace #financial-bars-body', types: ['bar', 'pie'], pieHeaders: /Venta|Participación|Margen contribución/i, title: 'Ventas y margen por línea' },
  { selector: '#sales-workspace #financial-ingredients-body', types: ['bar', 'pie'], pieHeaders: /Venta|Participación|Margen contribución/i, title: 'Ventas y margen por ingrediente principal' },
  { selector: '#inventory-executive-summary-table', types: ['bar', 'pie'], pieHeaders: /cantidad|unidades|costo|valor|monto/i, title: 'Resumen ejecutivo de inventario' },
  { selector: '#inventory-waste-table', types: ['bar', 'pie'], pieHeaders: /cantidad|unidades|costo|valor|monto/i, title: 'Merma por producto' },
  { selector: '#inventory-results-table', types: ['line', 'bar'], chronological: true, title: 'Movimientos y valorización de inventario' },
  { selector: '#inventory-lac001-substitution-table', types: ['bar'], title: 'Sustituciones de leche' },
  { selector: '#inventory-syrup-substitution-table', types: ['bar'], title: 'Sustituciones de jarabes' },
  { selector: '#inventory-avoided-packaging-table', types: ['bar', 'pie'], pieHeaders: /cantidad|unidades|costo|valor|monto/i, title: 'Packaging desechable evitado' },
  { selector: '#current-inventory-table', types: ['bar', 'pie'], pieHeaders: /stock|cantidad|unidades|costo|valor|monto/i, title: 'Inventario actual por producto' },
  { selector: '#demand-locations-body', types: ['bar', 'pie'], pieHeaders: /Pedidos|Venta neta/i, title: 'Venta comparada por local' },
  { selector: '#sales-ingredients-report table', types: ['bar'], title: 'Ventas asociadas a ingredientes y extras' }
];

let analyticalChartSequence = 0;

function analyticalRuleElements(rule) {
  return [...document.querySelectorAll(rule.selector)]
    .map(element => element.tagName === 'TABLE' ? element : element.closest('table'))
    .filter((table, index, tables) => table && tables.indexOf(table) === index);
}

function tableChartText(cell) {
  const control = cell.querySelector('input:not([type="checkbox"]), select');
  const primaryValue = cell.querySelector('strong');
  return control?.value || primaryValue?.textContent.trim() || cell.textContent.trim();
}

function tableChartNumber(textValue) {
  const value = String(textValue || '').trim();
  if (!value || value === '—' || /sin datos|no disponible/i.test(value)) return null;
  const parsed = parseLocalizedNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tableChartMetricFormat(header) {
  if (/margen contribución|venta|costo|precio|monto|importe|ticket|comisión/i.test(header) && !/%/.test(header)) {
    return {
      formatValue: formatClp,
      formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
    };
  }
  if (/%|porcentaje|participación|margen|descuento|cambio|variación/i.test(header)) {
    return {
      formatValue: value => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`,
      formatAxis: value => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`
    };
  }
  return {
    formatValue: value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(value),
    formatAxis: value => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  };
}

function tableChartDateValue(label) {
  const textValue = String(label || '').toLowerCase().replace(/\./g, ' ');
  const iso = textValue.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const numeric = textValue.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
  if (numeric) return Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
  const monthNumbers = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, sept: 8, oct: 9, nov: 10, dic: 11 };
  const named = textValue.match(/\b(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)\s+(20\d{2})\b/);
  if (named) return Date.UTC(Number(named[3]), monthNumbers[named[2]], Number(named[1]));
  const monthOnly = textValue.match(/\b(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)\s+(20\d{2})\b/);
  return monthOnly ? Date.UTC(Number(monthOnly[2]), monthNumbers[monthOnly[1]], 1) : null;
}

function salesServiceModeChartConfiguration(rule) {
  const period = salesServiceModeState?.sales?.serviceModes?.periods?.custom;
  if (!period?.hierarchies?.length) return null;
  const definitions = [
    ['Para llevar', 'takeaway'],
    ['Servir en el local', 'dineIn'],
    ['Sin información', 'unknown']
  ];
  const metrics = definitions.map(([name, key]) => ({
    name,
    values: period.hierarchies.map(item => Number(item.groups?.[key]?.netSales) || 0),
    allowedTypes: rule.types,
    formatValue: formatClp,
    formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
  }));
  metrics.push({
    name: 'Total',
    values: period.hierarchies.map(item => Number(item.totalNetSales) || 0),
    allowedTypes: rule.types,
    formatValue: formatClp,
    formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
  });
  return {
    type: rule.types[0], allowedTypes: rule.types,
    title: rule.title,
    subtitle: `${formatReportDate(period.period.from)} – ${formatReportDate(period.period.to)} · venta neta sin IVA obtenida directamente del reporte de modalidad.`,
    labels: period.hierarchies.map(item => item.name),
    metrics,
    series: [{ name: metrics[0].name, values: metrics[0].values }],
    formatValue: formatClp,
    formatAxis: metrics[0].formatAxis
  };
}

function transactionAuditDiscountChartConfiguration(rule) {
  const transactions = transactionAuditState?.transactions || [];
  if (!transactions.length) return null;
  const byDate = new Map();
  for (const transaction of transactions) {
    if (!byDate.has(transaction.date)) {
      byDate.set(transaction.date, { date: transaction.date, transactions: 0, discountedTransactions: 0, saleBeforeDiscount: 0, discountAmount: 0 });
    }
    const day = byDate.get(transaction.date);
    day.transactions += 1;
    day.saleBeforeDiscount += Number(transaction.saleBeforeDiscount) || 0;
    day.discountAmount += Math.max(0, Number(transaction.discountAmount) || 0);
    if ((Number(transaction.discountAmount) || 0) > 0) day.discountedTransactions += 1;
  }
  const days = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const totalTransactions = transactions.length;
  const discountedTransactions = transactions.filter(transaction => (Number(transaction.discountAmount) || 0) > 0).length;
  const totalSaleBeforeDiscount = transactions.reduce((sum, transaction) => sum + (Number(transaction.saleBeforeDiscount) || 0), 0);
  const totalDiscount = transactions.reduce((sum, transaction) => sum + Math.max(0, Number(transaction.discountAmount) || 0), 0);
  const totalDiscountPercent = totalSaleBeforeDiscount ? totalDiscount / totalSaleBeforeDiscount * 100 : 0;
  const discountedTransactionPercent = totalTransactions ? discountedTransactions / totalTransactions * 100 : 0;
  const percentFormat = value => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`;
  const countFormat = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value);
  const metrics = [
    {
      name: 'Descuento total / venta antes de descuentos',
      values: days.map(day => day.saleBeforeDiscount ? day.discountAmount / day.saleBeforeDiscount * 100 : 0),
      allowedTypes: rule.types, formatValue: percentFormat, formatAxis: percentFormat
    },
    {
      name: 'Transacciones con descuento', values: days.map(day => day.discountedTransactions),
      allowedTypes: rule.types, formatValue: countFormat, formatAxis: countFormat
    },
    {
      name: 'Transacciones con descuento / total',
      values: days.map(day => day.transactions ? day.discountedTransactions / day.transactions * 100 : 0),
      allowedTypes: rule.types, formatValue: percentFormat, formatAxis: percentFormat
    }
  ];
  return {
    type: 'line', allowedTypes: rule.types, title: rule.title,
    subtitle: `${formatReportDate(transactionAuditState.filters?.dateFrom)} – ${formatReportDate(transactionAuditState.filters?.dateTo)} · total del período: ${formatClp(totalDiscount)} en descuentos (${percentFormat(totalDiscountPercent)} de la venta antes de descuentos); ${countFormat(discountedTransactions)} de ${countFormat(totalTransactions)} transacciones con descuento (${percentFormat(discountedTransactionPercent)}).`,
    labels: days.map(day => formatReportDate(day.date)),
    metrics,
    series: [{ name: metrics[0].name, values: metrics[0].values }],
    formatValue: percentFormat,
    formatAxis: percentFormat
  };
}

function tableChartConfiguration(table, rule) {
  if (table.querySelector('#sales-service-mode-hierarchies')) return salesServiceModeChartConfiguration(rule);
  if (table.querySelector('#transaction-audit-body')) return transactionAuditDiscountChartConfiguration(rule);
  const headers = [...table.querySelectorAll('thead tr:last-child th')].map(cell => cell.textContent.trim().replace(/\s+/g, ' '));
  const rawRows = [...table.querySelectorAll('tbody > tr')]
    .filter(row => !row.hidden && getComputedStyle(row).display !== 'none')
    .map(row => [...row.children].map(tableChartText));
  if (headers.length < 2 || !rawRows.length) return null;
  const excluded = /^(fecha|hora|local|cafetería|código|producto|insumo|proveedor|documento|pedido|estado|tipo|unidad|origen|detalle|comentario|línea)$/i;
  const metricIndexes = headers.map((header, index) => ({ header, index })).filter(({ header, index }) => {
    if (index === 0 || excluded.test(header)) return false;
    const numeric = rawRows.reduce((count, row) => count + (tableChartNumber(row[index]) !== null ? 1 : 0), 0);
    return numeric > 0 && numeric / rawRows.length >= 0.45;
  });
  if (!metricIndexes.length) return null;
  const categoryIndex = Number.isInteger(rule.categoryIndex)
    ? rule.categoryIndex
    : headers.findIndex((header, index) => index < metricIndexes[0].index && !excluded.test(header));
  const labelIndex = categoryIndex >= 0 ? categoryIndex : 0;
  const grouped = new Map();
  rawRows.forEach((row, rowIndex) => {
    const label = row[labelIndex] || `Fila ${rowIndex + 1}`;
    if (!grouped.has(label)) grouped.set(label, metricIndexes.map(() => 0));
    const totals = grouped.get(label);
    metricIndexes.forEach(({ index }, metricIndex) => {
      const value = tableChartNumber(row[index]);
      if (value !== null) totals[metricIndex] += value;
    });
  });
  let entries = [...grouped.entries()];
  if (rule.chronological) {
    const dated = entries.map(entry => ({ entry, date: tableChartDateValue(entry[0]) }));
    entries = dated.every(item => item.date !== null)
      ? dated.sort((left, right) => left.date - right.date).map(item => item.entry)
      : entries.reverse();
  }
  const labels = entries.map(([label]) => label);
  const metrics = metricIndexes.map(({ header }, metricIndex) => ({
    name: header,
    values: entries.map(([, values]) => values[metricIndex]),
    allowedTypes: rule.pieHeaders && !rule.pieHeaders.test(header) ? rule.types.filter(type => type !== 'pie') : rule.types,
    ...tableChartMetricFormat(header)
  }));
  return {
    type: rule.types[0],
    allowedTypes: rule.types,
    title: rule.title,
    subtitle: `Datos visibles en la vista actual · ${labels.length} categoría(s). Selecciona la métrica y el tipo de gráfico disponible.`,
    labels,
    metrics,
    series: [{ name: metrics[0].name, values: metrics[0].values }],
    formatValue: metrics[0].formatValue,
    formatAxis: metrics[0].formatAxis
  };
}

function installAnalyticalTableChart(table, rule) {
  if (!table || table.dataset.chartInstalled || table.closest('#report-chart-dialog')) return;
  table.dataset.chartInstalled = 'true';
  const key = `analytical-table-${++analyticalChartSequence}`;
  const button = reportChartIconButton(key, rule.title);
  button.disabled = false;
  button.classList.add('analytical-table-chart-button');
  button.addEventListener('click', () => {
    const config = tableChartConfiguration(table, rule) || {
      type: rule.types[0], allowedTypes: rule.types, title: rule.title,
      subtitle: 'No hay datos numéricos visibles para los filtros actuales.', labels: [], series: [],
      formatValue: formatClp, formatAxis: value => String(value)
    };
    reportChartRegistry.set(key, config);
    openReportChart(key);
  });
  const toolbar = document.createElement('div');
  toolbar.className = 'data-chart-toolbar';
  toolbar.append(button);
  const wrap = table.parentElement;
  wrap.before(toolbar);
}

function refreshAnalyticalTableCharts() {
  ANALYTICAL_TABLE_CHART_RULES.forEach(rule => analyticalRuleElements(rule)
    .forEach(table => installAnalyticalTableChart(table, rule)));
}

function initializeAnalyticalTableCharts() {
  const findingsHeading = document.querySelector('#findings-workspace .findings-heading h2');
  if (findingsHeading && !findingsHeading.parentElement.classList.contains('report-chart-title-row')) {
    const row = document.createElement('div');
    row.className = 'report-chart-title-row';
    const button = reportChartIconButton('findings-summary-chart', 'Distribución de hallazgos');
    button.addEventListener('click', () => openReportChart('findings-summary-chart'));
    findingsHeading.before(row);
    row.append(findingsHeading, button);
  }
  const productHead = document.querySelector('#sales-top-products')?.closest('.panel')?.querySelector('.panel-head');
  if (productHead && !productHead.querySelector('[data-report-chart="sales-top-products-chart"]')) {
    const button = reportChartIconButton('sales-top-products-chart', 'Productos más vendidos');
    button.addEventListener('click', () => openReportChart('sales-top-products-chart'));
    productHead.appendChild(button);
  }
  const hierarchyHead = document.querySelector('#sales-hierarchy-share')?.closest('.panel')?.querySelector('.hierarchy-panel-head');
  if (hierarchyHead && !hierarchyHead.querySelector('[data-report-chart="sales-hierarchy-chart"]')) {
    const button = reportChartIconButton('sales-hierarchy-chart', 'Venta por jerarquía');
    button.addEventListener('click', () => openReportChart('sales-hierarchy-chart'));
    const back = hierarchyHead.querySelector('#sales-hierarchy-back');
    hierarchyHead.insertBefore(button, back || null);
  }
  refreshAnalyticalTableCharts();
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refreshAnalyticalTableCharts();
    });
  });
  observer.observe(document.querySelector('.main-content'), { childList: true, subtree: true });
}

function setReportChart(key, config) {
  reportChartRegistry.set(key, {
    type: 'line',
    allowedTypes: config.type === 'bar' ? ['bar'] : ['line', 'bar'],
    formatValue: formatClp,
    formatAxis: value => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value),
    ...config
  });
  document.querySelectorAll(`[data-report-chart="${key}"]`).forEach(button => { button.disabled = false; });
}

function reportChartSvgElement(name, attributes = {}, textValue = '') {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (textValue !== '') element.textContent = textValue;
  return element;
}

function renderReportChart(config) {
  const svg = document.getElementById('report-chart-svg');
  const scroll = document.getElementById('report-chart-scroll');
  const empty = document.getElementById('report-chart-empty');
  let labels = config.labels || [];
  let series = (config.series || []).map((item, index) => ({
    ...item,
    color: item.color || REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length],
    values: (item.values || []).map(value => Number.isFinite(Number(value)) ? Number(value) : null)
  }));
  const values = series.flatMap(item => item.values).filter(Number.isFinite);
  const hasData = labels.length && values.length;
  empty.hidden = hasData;
  scroll.hidden = !hasData;
  svg.replaceChildren();
  if (!hasData) return;

  if (config.type !== 'line' && labels.length > 20) {
    const selectedIndexes = labels.map((label, index) => ({ label, index, value: Math.abs(series[0]?.values[index] || 0) }))
      .sort((left, right) => right.value - left.value).slice(0, 20).map(item => item.index);
    labels = selectedIndexes.map(index => labels[index]);
    series = series.map(item => ({ ...item, values: selectedIndexes.map(index => item.values[index]) }));
  }

  if (config.type === 'pie') {
    const positive = labels.map((label, index) => ({ label, value: series[0]?.values[index] }))
      .filter(item => Number.isFinite(item.value) && item.value > 0)
      .sort((left, right) => right.value - left.value);
    if (!positive.length) {
      empty.hidden = false;
      scroll.hidden = true;
      return;
    }
    const width = 900;
    const height = Math.max(430, positive.length * 25 + 80);
    const centerX = 250;
    const centerY = height / 2;
    const radius = Math.min(150, height / 2 - 45);
    const total = positive.reduce((sum, item) => sum + item.value, 0);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    if (positive.length === 1) {
      const item = positive[0];
      const circle = reportChartSvgElement('circle', { cx: centerX, cy: centerY, r: radius, fill: REPORT_CHART_COLORS[0], class: 'report-chart-mark' });
      circle.appendChild(reportChartSvgElement('title', {}, `${item.label}: ${config.formatValue(item.value)} · 100%`));
      svg.append(circle,
        reportChartSvgElement('rect', { x: 470, y: 38, width: 12, height: 12, rx: 3, fill: REPORT_CHART_COLORS[0] }),
        reportChartSvgElement('text', { x: 490, y: 48, class: 'report-chart-pie-label' }, `${item.label} · 100% · ${config.formatValue(item.value)}`));
      return;
    }
    let startAngle = -Math.PI / 2;
    positive.forEach((item, index) => {
      const angle = item.value / total * Math.PI * 2;
      const endAngle = startAngle + angle;
      const x1 = centerX + radius * Math.cos(startAngle);
      const y1 = centerY + radius * Math.sin(startAngle);
      const x2 = centerX + radius * Math.cos(endAngle);
      const y2 = centerY + radius * Math.sin(endAngle);
      const path = reportChartSvgElement('path', {
        d: `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
        fill: REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length], class: 'report-chart-mark'
      });
      path.appendChild(reportChartSvgElement('title', {}, `${item.label}: ${config.formatValue(item.value)} · ${(item.value / total * 100).toFixed(1)}%`));
      svg.appendChild(path);
      const legendY = 48 + index * 25;
      svg.append(
        reportChartSvgElement('rect', { x: 470, y: legendY - 10, width: 12, height: 12, rx: 3, fill: REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length] }),
        reportChartSvgElement('text', { x: 490, y: legendY, class: 'report-chart-pie-label' }, `${item.label} · ${(item.value / total * 100).toFixed(1)}% · ${config.formatValue(item.value)}`)
      );
      startAngle = endAngle;
    });
    return;
  }

  const width = Math.max(760, labels.length * (config.type === 'bar' ? 105 : 72));
  const height = 430;
  const margin = { top: 30, right: 28, bottom: 92, left: 84 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...values, 0);
  const minValue = Math.min(...values, 0);
  const range = maxValue - minValue || 1;
  const y = value => margin.top + (maxValue - value) / range * plotHeight;
  const x = index => margin.left + (labels.length === 1 ? plotWidth / 2 : index * plotWidth / (labels.length - 1));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  for (let index = 0; index <= 5; index += 1) {
    const value = maxValue - (range * index / 5);
    const gridY = y(value);
    svg.append(
      reportChartSvgElement('line', { x1: margin.left, x2: width - margin.right, y1: gridY, y2: gridY, class: 'report-chart-grid' }),
      reportChartSvgElement('text', { x: margin.left - 12, y: gridY + 4, 'text-anchor': 'end', class: 'report-chart-axis' }, config.formatAxis(value))
    );
  }

  if (config.type === 'bar') {
    const groupWidth = plotWidth / labels.length;
    const barWidth = Math.min(52, groupWidth * 0.72 / Math.max(series.length, 1));
    series.forEach((item, seriesIndex) => item.values.forEach((value, labelIndex) => {
      if (!Number.isFinite(value)) return;
      const zeroY = y(0);
      const valueY = y(value);
      const rect = reportChartSvgElement('rect', {
        x: margin.left + labelIndex * groupWidth + (groupWidth - barWidth * series.length) / 2 + seriesIndex * barWidth,
        y: Math.min(zeroY, valueY), width: Math.max(barWidth - 3, 2), height: Math.max(Math.abs(zeroY - valueY), 1),
        rx: 4, fill: item.color, class: 'report-chart-mark'
      });
      rect.appendChild(reportChartSvgElement('title', {}, `${labels[labelIndex]} · ${item.name}: ${config.formatValue(value)}`));
      svg.appendChild(rect);
    }));
  } else {
    series.forEach(item => {
      const validPoints = item.values.map((value, index) => Number.isFinite(value) ? `${x(index)},${y(value)}` : null).filter(Boolean);
      if (validPoints.length > 1) svg.appendChild(reportChartSvgElement('polyline', {
        points: validPoints.join(' '), fill: 'none', stroke: item.color, 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
      item.values.forEach((value, index) => {
        if (!Number.isFinite(value)) return;
        const circle = reportChartSvgElement('circle', { cx: x(index), cy: y(value), r: 5, fill: item.color, class: 'report-chart-mark' });
        circle.appendChild(reportChartSvgElement('title', {}, `${labels[index]} · ${item.name}: ${config.formatValue(value)}`));
        svg.appendChild(circle);
      });
    });
  }
  labels.forEach((label, index) => {
    const labelX = config.type === 'bar'
      ? margin.left + (index + 0.5) * plotWidth / labels.length
      : x(index);
    svg.appendChild(reportChartSvgElement('text', {
      x: labelX, y: height - margin.bottom + 22, class: 'report-chart-label',
      'text-anchor': 'end', transform: `rotate(-38 ${labelX} ${height - margin.bottom + 22})`
    }, label));
  });
}

function renderReportChartData(config) {
  const head = document.getElementById('report-chart-data-head');
  const body = document.getElementById('report-chart-data-body');
  const headingRow = document.createElement('tr');
  ['Período', ...(config.series || []).map(item => item.name)].forEach(label => {
    const cell = document.createElement('th');
    cell.textContent = label;
    headingRow.appendChild(cell);
  });
  head.replaceChildren(headingRow);
  body.replaceChildren(...(config.labels || []).map((label, index) => {
    const row = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    row.appendChild(labelCell);
    for (const item of config.series || []) {
      const cell = document.createElement('td');
      const value = item.values?.[index];
      cell.textContent = Number.isFinite(Number(value)) ? config.formatValue(Number(value)) : '—';
      row.appendChild(cell);
    }
    return row;
  }));
}

function openReportChart(key) {
  const config = reportChartRegistry.get(key);
  if (!config) return;
  activeReportChart = config;
  activeReportChartType = config.type;
  document.getElementById('report-chart-title').textContent = config.title;
  document.getElementById('report-chart-subtitle').textContent = config.subtitle || '';
  const metricField = document.getElementById('report-chart-metric-field');
  const metricSelect = document.getElementById('report-chart-metric');
  metricField.hidden = !config.metrics?.length;
  metricSelect.replaceChildren(...(config.metrics || []).map((metric, index) => new Option(metric.name, String(index))));
  metricSelect.value = '0';
  updateReportChartDialog();
  document.getElementById('report-chart-dialog').showModal();
}

function currentReportChartConfig() {
  if (!activeReportChart) return null;
  const metricIndex = Number(document.getElementById('report-chart-metric').value || 0);
  const metric = activeReportChart.metrics?.[metricIndex];
  return {
    ...activeReportChart,
    type: activeReportChartType,
    ...(metric ? {
      series: [{ name: metric.name, values: metric.values, color: metric.color }],
      allowedTypes: metric.allowedTypes || activeReportChart.allowedTypes,
      formatValue: metric.formatValue || activeReportChart.formatValue,
      formatAxis: metric.formatAxis || activeReportChart.formatAxis
    } : {})
  };
}

function updateReportChartDialog() {
  let config = currentReportChartConfig();
  if (!config) return;
  const allowed = config.allowedTypes || [config.type];
  if (!allowed.includes(activeReportChartType)) {
    activeReportChartType = allowed[0];
    config = currentReportChartConfig();
  }
  document.querySelectorAll('#report-chart-type-options [data-chart-type]').forEach(button => {
    const available = allowed.includes(button.dataset.chartType);
    button.hidden = !available;
    button.classList.toggle('active', button.dataset.chartType === activeReportChartType);
    button.setAttribute('aria-pressed', String(button.dataset.chartType === activeReportChartType));
  });
  const legend = document.getElementById('report-chart-legend');
  legend.hidden = config.type === 'pie';
  legend.replaceChildren(...(config.series || []).map((item, index) => {
    const entry = document.createElement('span');
    const marker = document.createElement('i');
    marker.style.background = item.color || REPORT_CHART_COLORS[index % REPORT_CHART_COLORS.length];
    entry.append(marker, document.createTextNode(item.name));
    return entry;
  }));
  renderReportChart(config);
  renderReportChartData(config);
}

function initializeIntradayBlockOptions() {
  try {
    if (localStorage.getItem(INTRADAY_BLOCK_HOURS_STORAGE_KEY) === '1') intradayBlockHours = 1;
  } catch {}
  const options = document.getElementById('intraday-block-options');
  const syncSelection = () => options.querySelectorAll('[data-block-hours]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.blockHours) === intradayBlockHours));
  });
  syncSelection();
  options.addEventListener('click', event => {
    const button = event.target.closest('[data-block-hours]');
    if (!button) return;
    intradayBlockHours = Number(button.dataset.blockHours);
    try { localStorage.setItem(INTRADAY_BLOCK_HOURS_STORAGE_KEY, String(intradayBlockHours)); } catch {}
    syncSelection();
    if (intradayReportState) renderIntradayReport(intradayReportState.intraday, intradayReportState.includeToday);
  });
}

function renderIntradayReport(intraday, includeToday = true) {
  intradayReportState = { intraday, includeToday };
  const blocks = intradayBlockHours === 1 ? intraday.hourlyBlocks : intraday.blocks;
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
    : `${comparison >= 0 ? '+' : ''}${comparison.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  document.getElementById('intraday-average-detail').textContent = intraday.today.sameWeekdayAverage != null
    ? `Promedio ${formatClp(intraday.today.sameWeekdayAverage)} · 8 fechas · ${cutoffLabel}`
    : `Referencia incompleta · ${intraday.today.averageSampleSize} de 8 fechas · ${cutoffLabel}`;
  const weekday = new Intl.DateTimeFormat('es-CL', { weekday: 'long' }).format(dateFromKey(intraday.today.date));
  document.getElementById('intraday-weekday-title').textContent = `Mejor ${weekday}`;
  document.getElementById('intraday-weekday-date').textContent = referenceText(intraday.references.sameWeekday.date);
  document.getElementById('intraday-month-date').textContent = referenceText(intraday.references.month.date);
  document.getElementById('intraday-historical-date').textContent = referenceText(intraday.references.historical.date);
  const body = document.getElementById('intraday-sales-body');
  body.replaceChildren(...blocks.map(block => {
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
  const references = [
    ['Referencia', 'today'],
    [`Mejor ${weekday}`, 'sameWeekday'],
    ['Mejor día del mes', 'month'],
    ['Mejor día histórico', 'historical']
  ];
  setReportChart('report-intraday', {
    title: intradayTitle,
    subtitle: `Venta neta acumulada · tramos de ${intradayBlockHours === 1 ? '1 hora' : '2 horas'} · corte ${intraday.today.cutoffTime?.slice(0, 5) || 'sin hora disponible'}.`,
    labels: blocks.map(block => block.label),
    series: references.map(([name, key], index) => ({
      name,
      color: REPORT_CHART_COLORS[index],
      values: blocks.map(block => block[key])
    }))
  });
}

function renderSalesStatistics(statistics, averageTicketStatistics, discountStatistics, orderCountStatistics) {
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
  const renderRows = (bodyId, rows, labelFor, options = {}) => {
    const valueKey = options.valueKey || 'netSales';
    const variationKey = options.variationKey || 'variationPercent';
    const variationSuffix = options.variationSuffix ?? '%';
    const formatValue = options.formatValue || formatClp;
    const body = document.getElementById(bodyId);
    body.replaceChildren(...rows.map(item => {
      const row = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = labelFor(item);
      const amount = document.createElement('td');
      const amountContent = document.createElement('span');
      amountContent.className = 'sales-statistics-value-wrap';
      const variationValue = item[variationKey];
      if (variationValue !== null && Number.isFinite(variationValue)) {
        const variation = document.createElement('span');
        variation.className = `sales-statistics-variation ${variationValue < 0 ? 'negative' : 'positive'}`;
        variation.textContent = `${variationValue > 0 ? '+' : ''}${variationValue.toFixed(1)}${variationSuffix}`;
        amountContent.appendChild(variation);
      }
      const value = document.createElement('span');
      value.textContent = formatValue(item[valueKey]);
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
  const ticketOptions = { valueKey: 'averageTicketWithVat' };
  renderRows('average-ticket-statistics-months', averageTicketStatistics.months, item => monthLabel(item.key), ticketOptions);
  renderRows('average-ticket-statistics-weeks', averageTicketStatistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`, ticketOptions);
  renderRows('average-ticket-statistics-days', averageTicketStatistics.days, item => shortDate(item.date, true), ticketOptions);
  renderRows('average-ticket-statistics-equivalent-days', averageTicketStatistics.equivalentDays, item => shortDate(item.date, true), ticketOptions);
  const discountOptions = {
    valueKey: 'discountPercent',
    variationKey: 'variationPoints',
    variationSuffix: ' pp',
    formatValue: value => `${value.toFixed(1)}%`
  };
  renderRows('discount-statistics-months', discountStatistics.months, item => monthLabel(item.key), discountOptions);
  renderRows('discount-statistics-weeks', discountStatistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`, discountOptions);
  renderRows('discount-statistics-days', discountStatistics.days, item => shortDate(item.date, true), discountOptions);
  renderRows('discount-statistics-equivalent-days', discountStatistics.equivalentDays, item => shortDate(item.date, true), discountOptions);

  const register = (key, title, rows, labelFor, valueKey, unit, formatValue = formatClp) => {
    const chronologicalRows = [...rows].reverse();
    setReportChart(key, {
      title,
      subtitle: `${unit} por período, desde el más antiguo al más reciente. Pasa el cursor sobre cada punto para ver el valor exacto.`,
      labels: chronologicalRows.map(labelFor),
      series: [{ name: unit, values: chronologicalRows.map(item => item[valueKey]) }],
      formatValue,
      ...(unit === 'Órdenes' ? { formatAxis: formatValue } : {}),
      ...(unit === 'Descuento sobre venta' ? { formatAxis: value => `${value.toFixed(0)}%` } : {})
    });
  };
  register('sales-statistics-months', 'Venta de los últimos 14 meses', statistics.months, item => monthLabel(item.key), 'netSales', 'Venta neta');
  register('sales-statistics-weeks', 'Venta de las últimas 14 semanas', statistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`, 'netSales', 'Venta neta');
  register('sales-statistics-days', 'Venta de los últimos 14 días', statistics.days, item => shortDate(item.date, true), 'netSales', 'Venta neta');
  register('sales-statistics-equivalent-days', 'Venta de los últimos 14 días equivalentes', statistics.equivalentDays, item => shortDate(item.date, true), 'netSales', 'Venta neta');
  register('average-ticket-statistics-months', 'Ticket promedio de los últimos 14 meses', averageTicketStatistics.months, item => monthLabel(item.key), 'averageTicketWithVat', 'Ticket promedio con IVA');
  register('average-ticket-statistics-weeks', 'Ticket promedio de las últimas 14 semanas', averageTicketStatistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`, 'averageTicketWithVat', 'Ticket promedio con IVA');
  register('average-ticket-statistics-days', 'Ticket promedio de los últimos 14 días', averageTicketStatistics.days, item => shortDate(item.date, true), 'averageTicketWithVat', 'Ticket promedio con IVA');
  register('average-ticket-statistics-equivalent-days', 'Ticket promedio de los últimos 14 días equivalentes', averageTicketStatistics.equivalentDays, item => shortDate(item.date, true), 'averageTicketWithVat', 'Ticket promedio con IVA');
  const count = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value);
  for (const [suffix, key, title, label] of [
    ['months', 'months', 'Número de órdenes de los últimos 14 meses', item => monthLabel(item.key)],
    ['weeks', 'weeks', 'Número de órdenes de las últimas 14 semanas', item => `${shortDate(item.from)} – ${shortDate(item.to)}`],
    ['days', 'days', 'Número de órdenes de los últimos 14 días', item => shortDate(item.date, true)],
    ['equivalent-days', 'equivalentDays', 'Número de órdenes de los últimos 14 días equivalentes', item => shortDate(item.date, true)]
  ]) {
    const id = `order-count-statistics-${suffix}`;
    renderRows(id, orderCountStatistics[key], label, { valueKey: 'orders', formatValue: count });
    register(id, title, orderCountStatistics[key], label, 'orders', 'Órdenes', count);
  }
  const percent = value => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`;
  register('discount-statistics-months', 'Descuento de los últimos 14 meses', discountStatistics.months, item => monthLabel(item.key), 'discountPercent', 'Descuento sobre venta', percent);
  register('discount-statistics-weeks', 'Descuento de las últimas 14 semanas', discountStatistics.weeks, item => `${shortDate(item.from)} – ${shortDate(item.to)}`, 'discountPercent', 'Descuento sobre venta', percent);
  register('discount-statistics-days', 'Descuento de los últimos 14 días', discountStatistics.days, item => shortDate(item.date, true), 'discountPercent', 'Descuento sobre venta', percent);
  register('discount-statistics-equivalent-days', 'Descuento de los últimos 14 días equivalentes', discountStatistics.equivalentDays, item => shortDate(item.date, true), 'discountPercent', 'Descuento sobre venta', percent);
}

async function loadWeeklySalesReport() {
  const status = document.getElementById('report-status');
  const locationFilter = document.getElementById('report-location-filter');
  const selectedLocation = locationFilter.value || 'all';
  const networkMode = document.getElementById('report-view-filter').value === 'grid';
  const sequence = ++reportLoadSequence;
  document.getElementById('weekly-report').classList.toggle('network-mode', networkMode);
  document.getElementById('network-sales-dashboard').hidden = !networkMode;
  const includeToday = document.getElementById('report-include-today').checked;
  setStatus(status, 'Calculando ventas netas…');
  try {
    if (networkMode) {
      const report = await apiRequest('/api/reports/network-sales');
      if (sequence !== reportLoadSequence) return;
      renderNetworkSalesDashboard(report);
      document.getElementById('report-scope-description').textContent = 'Venta neta sin IVA y ticket promedio con IVA, comparados por local y para toda la red.';
      const latest = `Última venta registrada: ${formatReportDate(report.sourceCoverage?.latestSaleDate)}.`;
      setStatus(status, report.warnings.length ? `${latest} ${report.warnings.join(' ')}` : `${report.filesRead} fuente(s) de ventas con detalle por producto procesada(s). ${latest}`,
        report.warnings.length ? 'error' : 'success');
      return;
    }
    const report = await apiRequest(`/api/reports/weekly-sales?location=${encodeURIComponent(selectedLocation)}&includeToday=${includeToday}`);
    if (sequence !== reportLoadSequence) return;
    window.BrewitSalesProjection?.remember(selectedLocation, report.salesProjection);
    document.getElementById('report-scope-description').textContent = report.scope.type === 'all'
      ? 'Venta neta sin IVA y ticket promedio con IVA, consolidados para todas las cafeterías.'
      : `Venta neta sin IVA y ticket promedio con IVA para ${report.scope.label}.`;
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
      ? 'Vs. promedio 8 días equivalentes: —'
      : `Vs. promedio 8 días equivalentes: ${comparison >= 0 ? '+' : ''}${comparison.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    document.getElementById('report-week-value').textContent = formatClp(report.week.netSales);
    document.getElementById('report-week-range').textContent = `${formatReportDate(report.week.from)} – ${formatReportDate(report.week.to)}`;
    document.getElementById('report-week-rank').textContent = rankText('Ranking semanas equivalentes', report.week.equivalentRank);
    document.getElementById('report-month-value').textContent = formatClp(report.month.netSales);
    document.getElementById('report-month-range').textContent = `${formatReportDate(report.month.from)} – ${formatReportDate(report.month.to)}`;
    document.getElementById('report-month-rank').textContent = rankText('Ranking meses equivalentes', report.month.equivalentRank);
    document.getElementById('report-weekday-average').textContent = report.previousDay.sameWeekdayAverage == null ? '—' : formatClp(report.previousDay.sameWeekdayAverage);
    const weekday = new Intl.DateTimeFormat('es-CL', { weekday: 'long' }).format(dateFromKey(report.previousDay.date));
    const comparisonCutoff = report.includeToday ? `Corte ${report.previousDay.comparisonCutoffTime.slice(0, 5)}` : 'Día completo';
    document.getElementById('report-weekday-label').textContent = `${weekday} · ${report.previousDay.averageSampleSize} de 8 días · ${comparisonCutoff}${report.previousDay.sameWeekdayAverage == null ? ' · Referencia incompleta' : ''}`;
    document.getElementById('report-weekday-label').title = `Fechas de referencia: ${report.previousDay.equivalentDays.dates.map(formatReportDate).join(', ')} · ${comparisonCutoff} · America/Santiago`;
    renderIntradayReport(report.intraday, report.includeToday);
    renderSalesStatistics(report.statistics, report.averageTicketStatistics, report.discountStatistics, report.orderCountStatistics);
    setReportChart('report-summary-day', {
      type: 'bar',
      title: report.includeToday ? 'Venta de hoy frente a su referencia' : 'Venta del día anterior frente a su referencia',
      subtitle: `Venta neta sin IVA · ${report.scope.label || 'todas las cafeterías'} · comparación con el promedio de los últimos ${report.previousDay.averageSampleSize || 0} días equivalentes.`,
      labels: ['Promedio días equivalentes', report.includeToday ? 'Hoy' : 'Día anterior'],
      series: [{ name: 'Venta neta', values: [report.previousDay.sameWeekdayAverage, report.previousDay.netSales] }]
    });
    const weekChart = reportChartRegistry.get('sales-statistics-weeks');
    const monthChart = reportChartRegistry.get('sales-statistics-months');
    if (weekChart) setReportChart('report-summary-week', { ...weekChart, title: 'Evolución de la venta semanal' });
    if (monthChart) setReportChart('report-summary-month', { ...monthChart, title: 'Evolución de la venta mensual' });
    setReportChart('report-summary-equivalent', {
      type: 'bar', title: 'Últimos 8 días equivalentes',
      subtitle: `${weekday} · ${comparisonCutoff} · America/Santiago`,
      labels: report.previousDay.equivalentDays.samples.map(sample => formatReportDate(sample.date)),
      series: [{ name: 'Venta neta', values: report.previousDay.equivalentDays.samples.map(sample => sample.sales) }]
    });
    const coverage = report.sourceCoverage || {};
    const sourceSummary = `Última venta registrada: ${formatReportDate(coverage.latestSaleDate)}.`;
    const missingStores = coverage.storesWithoutSalesFiles?.length
      ? ` Sin archivos de ventas: ${coverage.storesWithoutSalesFiles.join(', ')}.` : '';
    const futureDates = coverage.futureSaleDates
      ? ` ${coverage.futureSaleDates} fecha(s) de venta futura excluida(s) del reporte.` : '';
    if (!report.filesRead) {
      setStatus(status, 'No hay archivos de ventas cargados para las ubicaciones activas.', 'muted');
    } else if (report.warnings.length) {
      setStatus(status, `${sourceSummary}${missingStores}${futureDates} ${report.warnings.join(' ')}`, 'error');
    } else {
      setStatus(status, `${report.filesRead} fuente(s) de ventas con detalle por producto procesada(s). ${sourceSummary}${missingStores}${futureDates}`,
        missingStores || futureDates ? 'muted' : 'success');
    }
  } catch (error) {
    if (sequence === reportLoadSequence) setStatus(status, error.message, 'error');
  }
}

const NETWORK_SALES_COLUMNS = [
  ['today', 'sales', 'Venta', 'Venta neta sin IVA de hoy hasta la hora indicada.'],
  ['today', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['today', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['today', 'transactions', 'Transacciones', 'Número de órdenes de hoy hasta la hora de corte, utilizadas para calcular el ticket promedio.'],
  ['today', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.'],
  ['today', 'vsYesterday', 'vs ayer', 'Hoy hasta la hora actual frente a ayer hasta la misma hora.'],
  ['today', 'vsEquivalentDays', 'vs 8 días equiv.', 'Hoy hasta la hora actual frente al promedio de los ocho mismos días de la semana anteriores, con igual hora de corte.'],
  ['yesterday', 'sales', 'Venta', 'Venta neta sin IVA de ayer.'],
  ['yesterday', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['yesterday', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['yesterday', 'transactions', 'Transacciones', 'Número de órdenes de ayer utilizadas para calcular el ticket promedio.'],
  ['yesterday', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.'],
  ['yesterday', 'vsEquivalentDays', 'vs 8 días equiv.', 'Ayer frente al promedio de los ocho mismos días de la semana anteriores a ayer.'],
  ['yesterday', 'vsFourWeeks', 'vs prom. 4 sem.', 'Ayer frente al promedio diario de las fechas con operación registrada durante las cuatro semanas anteriores.'],
  ['currentWeek', 'sales', 'Venta', 'Venta neta acumulada desde el lunes hasta hoy a la hora indicada.'],
  ['currentWeek', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['currentWeek', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['currentWeek', 'transactions', 'Transacciones', 'Número de órdenes de la semana actual hasta la hora de corte.'],
  ['currentWeek', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.'],
  ['currentWeek', 'vsPreviousWeek', 'vs sem. ant.', 'Semana actual hasta hoy y hora actual frente al mismo tramo de la semana anterior.'],
  ['previousWeek', 'sales', 'Venta', 'Venta neta de la semana anterior completa, lunes a domingo.'],
  ['previousWeek', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['previousWeek', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['previousWeek', 'transactions', 'Transacciones', 'Número de órdenes de la semana anterior completa.'],
  ['previousWeek', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.'],
  ['previousWeek', 'vsEightWeeks', 'vs 8 sem.', 'Semana anterior completa frente al promedio de las ocho semanas completas anteriores a ella.'],
  ['currentMonth', 'sales', 'Venta', 'Venta neta acumulada desde el día 1 hasta hoy a la hora indicada.'],
  ['currentMonth', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['currentMonth', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['currentMonth', 'transactions', 'Transacciones', 'Número de órdenes del mes actual hasta la hora de corte.'],
  ['currentMonth', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.'],
  ['currentMonth', 'vsPreviousMonth', 'vs mes ant.', 'Mes actual hasta hoy y hora actual frente a un tramo equivalente del mes anterior.'],
  ['previousMonth', 'sales', 'Venta', 'Venta neta del mes anterior completo.'],
  ['previousMonth', 'marginPercent', 'Margen %', 'Margen monetario dividido por venta neta.'],
  ['previousMonth', 'discountPercent', 'Desc. %', 'Descuentos totales divididos por venta bruta antes de descuentos.'],
  ['previousMonth', 'transactions', 'Transacciones', 'Número de órdenes del mes anterior completo.'],
  ['previousMonth', 'averageTicket', 'Ticket con IVA', 'Venta con IVA después de descuentos dividida por número de transacciones.']
];

function networkMetricCell(period, metric) {
  const value = period?.[metric];
  const cell = document.createElement('td');
  if (value === null || value === undefined || !Number.isFinite(value)) {
    cell.textContent = '—';
    cell.className = 'network-empty';
  } else if (metric === 'sales' || metric === 'averageTicket') {
    cell.textContent = metric === 'averageTicket' && !period.transactions ? '—' : formatClp(value);
  } else if (metric === 'transactions') {
    cell.textContent = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value);
  } else {
    const comparison = metric.startsWith('vs');
    cell.textContent = `${comparison && value > 0 ? '+' : ''}${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`;
    if (comparison) cell.className = value > 0.05 ? 'network-positive' : value < -0.05 ? 'network-negative' : 'network-neutral';
  }
  return cell;
}

function renderNetworkSalesDashboard(report) {
  const headings = document.getElementById('network-sales-metric-headings');
  headings.replaceChildren(...NETWORK_SALES_COLUMNS.map(([, , label, tooltip]) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    cell.title = tooltip;
    return cell;
  }));
  const renderRow = (item, total = false) => {
    const row = document.createElement('tr');
    if (total) row.className = 'network-total-row';
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = item.name;
    row.append(name, ...NETWORK_SALES_COLUMNS.map(([period, metric]) => networkMetricCell(item[period], metric)));
    return row;
  };
  document.getElementById('network-sales-rows').replaceChildren(...report.rows.map(item => renderRow(item)));
  document.getElementById('network-sales-total').replaceChildren(renderRow(report.total, true));
  document.getElementById('network-sales-cutoff').textContent = `${formatReportDate(report.today)} · corte ${report.cutoff} · America/Santiago`;
  const coverage = report.sourceCoverage || {};
  const missingStores = (coverage.stores || []).filter(store => !store.filesRead).map(store => store.name);
  const costCoverage = coverage.ordersTotal
    ? `Costo disponible en ${coverage.ordersWithCost} de ${coverage.ordersTotal} pedidos.`
    : 'No hay pedidos para evaluar cobertura de costos.';
  const costBasisCoverage = coverage.ordersWithCost
    ? `En ${coverage.ordersWithNetFieldConsistentCost || 0} pedido(s), todos los costos concuerdan con el campo «Monto neto» de Compras; los demás usan fuentes no cotejadas. Esto no sustituye la revisión tributaria de las facturas.`
    : '';
  const missingSources = missingStores.length ? ` Sin archivos legibles: ${missingStores.join(', ')}.` : '';
  const valuationNote = 'Costo según fuentes vigentes al corte del reporte.';
  document.getElementById('network-sales-coverage').textContent = `${costCoverage} ${valuationNote} ${costBasisCoverage}${missingSources} ${report.coverageNote || ''}`.trim();
  setReportChart('report-network', {
    type: 'bar',
    allowedTypes: ['bar', 'pie'],
    title: 'Venta neta de hoy por local',
    subtitle: `Comparación hasta el corte ${report.cutoff} · America/Santiago. TOTAL RED se recalcula desde los datos agregados y no se incluye como un local adicional.`,
    labels: report.rows.map(item => item.name),
    series: [{ name: 'Venta neta de hoy', values: report.rows.map(item => item.today?.sales) }]
  });
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
  if (!options.some(option => option.value === reportClassicLocation)) reportClassicLocation = 'all';
}

function changeReportView() {
  const locationFilter = document.getElementById('report-location-filter');
  if (document.getElementById('report-view-filter').value === 'grid') {
    if (!locationFilter.disabled) reportClassicLocation = locationFilter.value || 'all';
    locationFilter.value = 'all';
    locationFilter.disabled = true;
    locationFilter.title = 'La vista grilla muestra todos los locales simultáneamente.';
  } else {
    locationFilter.disabled = false;
    locationFilter.value = [...locationFilter.options].some(option => option.value === reportClassicLocation)
      ? reportClassicLocation : 'all';
    locationFilter.removeAttribute('title');
  }
  loadWeeklySalesReport();
}

function refreshSalesDashboardLocationFilter() {
  document.querySelectorAll('.sales-report-location').forEach(select => {
    const previous = select.value || 'all';
    const options = [new Option('Todas las cafeterías', 'all')];
    for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
      options.push(new Option(location.name, location.id));
    }
    select.replaceChildren(...options);
    select.value = options.some(option => option.value === previous) ? previous : 'all';
  });
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

function openFindingEvidence(finding) {
  const dialog = document.createElement('dialog');
  dialog.className = 'inventory-report-dialog finding-evidence-dialog';
  dialog.setAttribute('aria-label', `Antecedentes del hallazgo ${finding.number}`);
  const head = document.createElement('div'); head.className = 'preview-dialog-head';
  const title = document.createElement('h2'); title.textContent = `Antecedentes · Hallazgo N.º ${finding.number}`;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => dialog.close()); head.append(title, close); dialog.append(head);
  const note = document.createElement('p');
  note.textContent = 'Datos disponibles en las fuentes. Los campos vacíos se muestran como no informados. Las horas de ventas del reporte están en horario de Chile; el pago original de la API conserva sus fechas UTC. Una cantidad negativa puede ser una devolución o anulación válida. Toteat puede repetir el cierre original en una reversa: no equivale a la hora de anulación. La fecha del hallazgo es distinta de la fecha de la transacción.';
  dialog.append(note);
  (finding.evidence || []).forEach((record, index) => {
    const section = document.createElement('details'); section.open = index === 0;
    const label = document.createElement('summary');
    label.textContent = `Registro ${index + 1} · ${record['Ubicación'] || ''} · ${record['ID de Pago'] || record.Documento || record.document || ''} · ${record['Fecha de cierre'] || record['Fecha emisión'] || record.date || ''} ${record['Hora de cierre'] || ''}`;
    section.append(label);
    const table = document.createElement('table'); table.className = 'sales-dashboard-table';
    const body = document.createElement('tbody');
    const addFields = (value, prefix = '') => Object.entries(value).forEach(([key, field]) => {
      const name = prefix ? `${prefix} · ${key}` : key;
      if (field && typeof field === 'object' && Object.keys(field).length) { addFields(field, name); return; }
      const row = document.createElement('tr'), heading = document.createElement('th'), cell = document.createElement('td');
      heading.scope = 'row'; heading.textContent = name;
      cell.textContent = field == null || field === '' ? 'No informado por la fuente' : typeof field === 'object' ? JSON.stringify(field) : String(field);
      row.append(heading, cell); body.append(row);
    });
    addFields(record); table.append(body); section.append(table); dialog.append(section);
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal(); close.focus();
}

function renderFindingsView() {
  document.getElementById('print-findings').disabled = !findingsViewState;
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
  const findingSectionMetrics = data.sections.map(section => {
    const open = section.findings.filter(finding => !finding.closed);
    return {
      label: section.label,
      open: open.length,
      closed: section.findings.length - open.length,
      high: open.filter(finding => finding.severity === 'high').length,
      medium: open.filter(finding => finding.severity === 'medium').length,
      low: open.filter(finding => finding.severity === 'low').length
    };
  });
  const integerFormat = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value);
  setReportChart('findings-summary-chart', {
    type: 'bar',
    allowedTypes: ['bar', 'pie'],
    title: 'Distribución de hallazgos por área',
    subtitle: `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)}. Selecciona estado o prioridad para comparar las áreas revisadas.`,
    labels: findingSectionMetrics.map(item => item.label),
    metrics: [
      ['Abiertos', 'open'], ['Cerrados', 'closed'], ['Prioridad alta', 'high'],
      ['Prioridad media', 'medium'], ['Atención', 'low']
    ].map(([name, key]) => ({
      name, values: findingSectionMetrics.map(item => item[key]), allowedTypes: ['bar', 'pie'],
      formatValue: integerFormat, formatAxis: integerFormat
    })),
    series: [{ name: 'Abiertos', values: findingSectionMetrics.map(item => item.open) }],
    formatValue: integerFormat,
    formatAxis: integerFormat
  });
  const sourceText = data.sources.length
    ? `Fuentes: ${data.sources.map(source => `${source.type}: ${source.name}${source.validFrom ? ` (vigente desde ${formatReportDate(source.validFrom)})` : ''}${source.updatedAt ? ` · actualización ${new Date(source.updatedAt).toLocaleString('es-CL')}` : ''}`).join(' · ')}.`
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
      if (finding.evidence?.length) {
        const evidenceButton = document.createElement('button');
        evidenceButton.type = 'button'; evidenceButton.className = 'icon-button small';
        evidenceButton.textContent = `Ver antecedentes (${finding.evidence.length} registros)`;
        evidenceButton.setAttribute('aria-haspopup', 'dialog');
        evidenceButton.addEventListener('click', () => openFindingEvidence(finding));
        copy.append(evidenceButton);
      }
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

function printFindingsReport() {
  const data = findingsViewState;
  if (!data) return;
  const root = document.createElement('article');
  root.id = 'findings-print-document';
  const add = (tag, text) => { const element = document.createElement(tag); element.textContent = text; root.append(element); };
  add('h1', 'Brewit · Hallazgos que requieren revisión');
  const filter = document.getElementById('findings-status-filter').value;
  add('p', `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} · ${filter === 'open' ? 'Solo abiertos' : 'Todos los hallazgos'}`);
  add('p', `Revisión: ${new Date(data.generatedAt).toLocaleString('es-CL')} · Emitido: ${new Date().toLocaleString('es-CL')}`);
  add('p', 'Cada hallazgo es una alerta para confirmar, no una corrección automática. Se incluyen las observaciones guardadas.');
  const all = data.sections.flatMap(section => section.findings);
  const visible = all.filter(finding => filter !== 'open' || !finding.closed);
  add('p', `${visible.length} hallazgos incluidos · ${visible.filter(f => !f.closed).length} abiertos · ${visible.filter(f => f.closed).length} cerrados · ${visible.filter(f => f.severity === 'high').length} de prioridad alta.`);
  const report = document.getElementById('findings-report').cloneNode(true);
  report.removeAttribute('id');
  report.querySelectorAll('.finding-item').forEach(item => {
    const finding = all.find(f => f.id === item.dataset.findingId);
    const review = document.createElement('div');
    review.className = 'finding-print-review';
    review.textContent = `Estado: ${finding.closed ? 'Cerrado' : 'Abierto'}${finding.closedAt ? ' · Cierre: ' + new Date(finding.closedAt).toLocaleString('es-CL') : ''}\nObservaciones: ${finding.observations || 'Sin observaciones guardadas.'}`;
    item.querySelector('.finding-review-controls').replaceWith(review);
  });
  root.append(report);
  add('h2', 'Fuentes y cobertura');
  add('p', document.getElementById('findings-context').textContent);
  const previousTitle = document.title;
  document.title = `Hallazgos Brewit - ${data.scope.label} - ${data.period.from} a ${data.period.to}`;
  document.body.append(root);
  document.body.classList.add('printing-findings');
  try { window.print(); }
  finally { root.remove(); document.body.classList.remove('printing-findings'); document.title = previousTitle; }
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
  document.getElementById('print-findings').disabled = true;
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
  if (!salesServiceModeState) return;
  const serviceModes = salesServiceModeState.sales.serviceModes;
  const periodKey = 'custom';
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
    ticket.textContent = `Ticket promedio con IVA ${group.averageTicket === null || group.averageTicket === undefined ? '—' : formatClp(group.averageTicket)}`;
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
  const key = 'custom';
  const rankBy = document.getElementById('sales-ranking-order').value;
  const originalInsight = salesDashboardState.sales.productInsights[key];
  if (!originalInsight) return;
  const insight = originalInsight.analysisProducts ? {...originalInsight,...window.buildFilteredSalesInsights(originalInsight.analysisProducts,{bar:salesProductFilters.bar,groupFormats:salesProductFilters.groupFormats,rankBy})} : originalInsight;
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
      const units = `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(product.quantity)} un.`;
      values.querySelector('strong').textContent = rankBy === 'netSales' ? formatClp(product.netSales) : units;
      values.querySelector('small').textContent = rankBy === 'netSales' ? units : formatClp(product.netSales);
      const share=document.createElement('small');share.textContent=`${(product.salesSharePercent||0).toFixed(2)}% de ventas · Acum. ${(product.cumulativeSalesSharePercent||0).toFixed(2)}%`;values.append(share);
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
  const quantityFormat = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(value);
  setReportChart('sales-top-products-chart', {
    type: 'bar',
    allowedTypes: ['bar'],
    title: 'Productos más vendidos',
    subtitle: `${formatReportDate(insight.period.from)} – ${formatReportDate(insight.period.to)} · ranking por ${rankBy === 'netSales' ? 'venta neta ($)' : 'unidades'} de hasta 100 productos del filtro seleccionado.`,
    labels: insight.topProducts.map(product => product.name),
    metrics: [
      {
        name: 'Unidades vendidas', values: insight.topProducts.map(product => product.quantity),
        allowedTypes: ['bar'], formatValue: quantityFormat,
        formatAxis: value => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      },
      {
        name: 'Venta neta sin IVA', values: insight.topProducts.map(product => product.netSales),
        allowedTypes: ['bar'], formatValue: formatClp,
        formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
      }
    ],
    series: [{ name: 'Unidades vendidas', values: insight.topProducts.map(product => product.quantity) }],
    formatValue: quantityFormat,
    formatAxis: value => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  });

  const hierarchyItems = currentNode
    ? currentNode.children.length ? currentNode.children : currentNode.products
    : [];
  const hierarchySales = hierarchyItems.map(item => Number(item.netSales) || 0);
  const hierarchyTotal = hierarchySales.reduce((sum, value) => sum + value, 0);
  const percentFormat = value => `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`;
  const hierarchyMetrics = [
    {
      name: 'Venta neta sin IVA', values: hierarchySales, allowedTypes: ['bar', 'pie'],
      formatValue: formatClp,
      formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
    },
    {
      name: 'Participación', values: hierarchySales.map(value => hierarchyTotal ? value / hierarchyTotal * 100 : 0),
      allowedTypes: ['bar', 'pie'], formatValue: percentFormat, formatAxis: percentFormat
    },
    {
      name: 'Margen %', values: hierarchyItems.map(item => item.contributionMarginPercent),
      allowedTypes: ['bar'], formatValue: percentFormat, formatAxis: percentFormat
    },
    {
      name: 'Margen de contribución',
      values: hierarchyItems.map(item => item.contributionMarginPercent === null
        ? null : item.netSales - item.totalCost),
      allowedTypes: ['bar'], formatValue: formatClp,
      formatAxis: value => `$${new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
    }
  ];
  if (currentNode && !currentNode.children.length) hierarchyMetrics.push({
    name: 'Unidades vendidas', values: hierarchyItems.map(item => item.quantity), allowedTypes: ['bar'],
    formatValue: quantityFormat,
    formatAxis: value => new Intl.NumberFormat('es-CL', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  });
  setReportChart('sales-hierarchy-chart', {
    type: 'bar',
    allowedTypes: ['bar', 'pie'],
    title: document.getElementById('sales-hierarchy-title').textContent,
    subtitle: `${formatReportDate(insight.period.from)} – ${formatReportDate(insight.period.to)} · ${['Todas las jerarquías', ...salesHierarchyPath].join(' › ')}.`,
    labels: hierarchyItems.map(item => item.name),
    metrics: hierarchyMetrics,
    series: [{ name: hierarchyMetrics[0].name, values: hierarchyMetrics[0].values }],
    formatValue: formatClp,
    formatAxis: hierarchyMetrics[0].formatAxis
  });
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
  [`${report.isAverage ? 'Promedio diario' : 'Total'} 07:00–21:00`, formatHourlyTableQuantity(totals.quantity), hourlyMinMaxLabel(totals.minQuantity, totals.maxQuantity),
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
  const basis = `${report.isAverage ? 'Promedio de' : 'Total de'} ${report.sampleSize} día(s) con venta`;
  document.getElementById('hourly-demand-title').textContent = `Venta por franja horaria · ${report.isAverage ? 'Promedios' : 'Totales'}`;
  document.getElementById('hourly-demand-units-heading').textContent = report.isAverage ? 'Unidades promedio' : 'Unidades totales';
  document.getElementById('hourly-demand-sales-heading').textContent = report.isAverage ? 'Facturación promedio' : 'Facturación total';
  summary.replaceChildren(
    salesAnalysisChip(basis),
    salesAnalysisChip(`${formatDemandQuantity(totals.quantity)} unidades ${report.isAverage ? 'promedio' : 'totales'}`),
    salesAnalysisChip(`${formatClp(totals.netSales)} facturación ${report.isAverage ? 'promedio' : 'total'} neta`)
  );
}

function syncHourlyDemandControls() {
  const mode = document.getElementById('hourly-demand-mode').value;
  const today = browserIsoToday();
  const weekStart = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const monthStart = `${today.slice(0, 7)}-01`;
  const previousMonthEnd = offsetIsoDate(monthStart, -1);
  const ranges = {
    recent: [offsetIsoDate(today, -6), today],
    'same-weekday': [offsetIsoDate(today, -48), today], weekdays: [offsetIsoDate(today, -6), today],
    'current-week': [weekStart, today],
    'previous-week': [offsetIsoDate(weekStart, -7), offsetIsoDate(weekStart, -1)],
    'current-month': [monthStart, today],
    'previous-month': [`${previousMonthEnd.slice(0, 7)}-01`, previousMonthEnd]
  };
  for (const days of [30, 60, 90, 180, 360]) ranges[`last-${days}-days`] = [offsetIsoDate(today, 1 - days), today];
  const from = document.getElementById('hourly-demand-from');
  const to = document.getElementById('hourly-demand-to');
  from.max = to.max = today;
  const specificDay = mode === 'date';
  document.getElementById('hourly-demand-sampling-note').hidden = !specificDay;
  document.getElementById('hourly-demand-from-label').hidden = specificDay;
  from.disabled = specificDay;
  document.getElementById('hourly-demand-occurrences-label').hidden = !specificDay;
  document.getElementById('hourly-demand-occurrences').disabled = !specificDay;
  if (specificDay) {
    if (!to.value) to.value = today;
    from.value = offsetIsoDate(to.value, -7 * (Number(document.getElementById('hourly-demand-occurrences').value) - 1));
  } else if (ranges[mode]) [from.value, to.value] = ranges[mode];
}

const hourlyReportFilterIds = ['hourly-demand-location', 'hourly-demand-mode', 'hourly-demand-from', 'hourly-demand-to', 'hourly-demand-occurrences', 'hourly-demand-aggregation', 'hourly-demand-interval'];
function markHourlyReportDirty() {
  for (const key of ['hourly', 'hourly-analysis']) {
    calculatedViewRequests.get(key)?.controller.abort();
    calculatedViewRequests.delete(key);
  }
  document.getElementById('refresh-hourly-demand').disabled = false;
  document.getElementById('generate-hourly-analysis').disabled = false;
  setStatus(document.getElementById('hourly-demand-status'), calculatedViewKeys.has('hourly')
    ? 'Los filtros cambiaron. El resultado visible conserva la última consulta; pulsa Generar reportes para aplicar la selección.'
    : 'Selecciona los filtros y pulsa Generar reportes.', 'muted');
}

function hourlyReportParams() {
  const dateFrom = document.getElementById('hourly-demand-from').value;
  const dateTo = document.getElementById('hourly-demand-to').value;
  const mode = document.getElementById('hourly-demand-mode').value;
  if (!dateTo || dateTo > browserIsoToday() || (mode !== 'date' && (!dateFrom || dateFrom > dateTo))) {
    setStatus(document.getElementById('hourly-demand-status'), 'Selecciona un período válido, sin superar el día actual.', 'error');
    return null;
  }
  const params = new URLSearchParams({ location: document.getElementById('hourly-demand-location').value || 'all',
    mode, dateTo, aggregation: document.getElementById('hourly-demand-aggregation').value,
    interval: document.getElementById('hourly-demand-interval').value });
  if (mode === 'date') params.set('occurrences', document.getElementById('hourly-demand-occurrences').value);
  else params.set('dateFrom', dateFrom);
  return params;
}

async function loadHourlySalesDemand() {
  const status = document.getElementById('hourly-demand-status');
  const button = document.getElementById('refresh-hourly-demand');
  const params = hourlyReportParams();
  if (!params) return;
  const request = beginCalculation('hourly', selectedCalculationKey(hourlyReportFilterIds));
  const current = () => isCurrentCalculation('hourly', request, hourlyReportFilterIds);
  button.disabled = true;
  setStatus(status, 'Calculando venta por franja horaria…');
  try {
    const report = await apiRequest(`/api/sales/hourly-demand?${params}`, { signal: request.controller.signal });
    if (!current()) return;
    hourlySalesDemandState = report;
    hourlySalesHierarchyPath = [];
    hourlySalesProductKey = null;
    calculatedViewKeys.set('hourly', request.key);
    renderHourlySalesDemand();
    const range = report.filters.range || { from: params.get('dateFrom'), to: params.get('dateTo') };
    const requested = report.requestedDates ? ` · ${report.requestedDates.length} fecha(s) del mismo día de semana; ${report.sampleSize} con venta; ${report.excludedDateCount} sin venta registrada` : '';
    document.getElementById('hourly-demand-report-context').textContent =
      `${report.scope.label} · ${formatReportDate(range.from)} – ${formatReportDate(range.to)}${requested}`;
    const dateList = report.selectedDates.map(formatReportDate).join(', ');
    if (!report.sampleSize) {
      setStatus(status, report.filters.mode === 'date'
        ? 'La fecha seleccionada no registra ventas; puede corresponder a un día cerrado.'
        : 'No hay días con venta total distinta de cero que cumplan los filtros seleccionados.', 'error');
    } else {
      setStatus(status, report.isAverage
        ? `Promedio calculado con ${report.sampleSize} día(s) con venta: ${dateList}. Se excluyen los días con venta total cero.`
        : `Total calculado con ${report.sampleSize} día(s) con venta: ${dateList}.`, 'success');
    }
  } catch (error) {
    if (current()) setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get('hourly') === request) {
      calculatedViewRequests.delete('hourly');
      button.disabled = false;
    }
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

function hourlyCvHelpButton(label = 'CV', description = 'Qué significa CV y cómo se calcula') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cv-help-trigger';
  button.textContent = label;
  button.setAttribute('aria-label', description);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'hourly-cv-help');
  return button;
}

function renderHourlyAnalysisBreakdown(breakdown, showTotals = false) {
  const isHierarchy = breakdown.level === 'hierarchy';
  const section = document.createElement('section');
  section.className = 'hourly-analysis-section hourly-analysis-breakdown';
  section.dataset.analysisLevel = breakdown.level;
  section.id = `hourly-analysis-detail-${breakdown.level}`;
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
  const quantityHeading = showTotals ? 'Unidades totales' : 'Unidades promedio';
  const salesHeading = showTotals ? 'Facturación total' : 'Facturación promedio';
  const headers = isHierarchy
    ? ['Jerarquía', quantityHeading, salesHeading, '% unidades', '% facturación', 'CV unidades', 'Tendencia unidades', 'Días atípicos', 'Franja principal']
    : ['Código', 'Producto', 'Jerarquía', quantityHeading, salesHeading, '% unidades', '% facturación', 'CV unidades', 'Tendencia unidades', 'Días atípicos', 'Franja principal'];
  headers.forEach(textValue => {
    const cell = document.createElement('th');
    if (textValue.startsWith('CV ')) cell.append(hourlyCvHelpButton(textValue));
    else cell.textContent = textValue;
    headerRow.appendChild(cell);
  });
  head.appendChild(headerRow);
  const body = document.createElement('tbody');
  body.replaceChildren(...breakdown.rows.map(row => hourlyAnalysisTableRow(isHierarchy ? [
    row.label,
    formatHourlyTableQuantity(showTotals ? row.totalUnits : row.averageUnits),
    formatClp(showTotals ? row.totalNetSales : row.averageNetSales),
    `${formatHourlyTableQuantity(row.unitShare)}%`,
    `${formatHourlyTableQuantity(row.salesShare)}%`,
    row.unitCoefficientOfVariation === null ? '—' : `${formatHourlyTableQuantity(row.unitCoefficientOfVariation)}%`,
    `${formatHourlyTableQuantity(row.unitTrend.estimatedChangePercent)}%`,
    new Intl.NumberFormat('es-CL').format(row.anomalyCount),
    row.strongestInterval || '—'
  ] : [
    row.code || '—', row.label, row.hierarchy || 'Sin jerarquía',
    formatHourlyTableQuantity(showTotals ? row.totalUnits : row.averageUnits),
    formatClp(showTotals ? row.totalNetSales : row.averageNetSales),
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
    .map(breakdown => renderHourlyAnalysisBreakdown(breakdown, report.filters.aggregation === 'total')));
}

const hourlyAnalysisLevels = {
  general: { label: 'Nivel general', title: 'Análisis general por franja horaria' },
  hierarchy: { label: 'General + jerarquías', title: 'Análisis por jerarquías de producto' },
  product: { label: 'General + jerarquías + productos', title: 'Análisis por jerarquías y productos' }
};

function renderHourlyAnalysisNavigation(report) {
  const hierarchy = report.breakdowns?.hierarchies;
  const products = report.breakdowns?.products;
  const parts = ['Análisis general'];
  const entries = [['Resumen general', 'hourly-analysis-general']];
  if (hierarchy) {
    parts.push(`${hierarchy.groupCount} jerarquía(s)`);
    entries.push([`Jerarquías (${hierarchy.groupCount})`, 'hourly-analysis-detail-hierarchy']);
  }
  if (products) {
    parts.push(`${products.groupCount} producto(s)`);
    entries.push([`Productos (${products.groupCount})`, 'hourly-analysis-detail-product']);
  }
  entries.push(['Anexo estadístico', 'hourly-analysis-appendix']);
  document.getElementById('hourly-analysis-level-summary').textContent = `Contenido de este reporte: ${parts.join(' · ')} · Anexo estadístico.`;
  document.getElementById('hourly-analysis-navigation').replaceChildren(...entries.map(([label, id]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button small';
    button.textContent = label;
    button.setAttribute('aria-controls', id);
    button.addEventListener('click', () => {
      const target = document.getElementById(id);
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
    });
    return button;
  }));
}

function renderHourlyAnalysis(report) {
  hourlyAnalysisState = report;
  const dates = report.selectedDates || [];
  const levelLabel = hourlyAnalysisLevels[report.analysisLevel].label;
  const showTotals = report.filters.aggregation === 'total';
  const viewLabel = showTotals ? 'Totales' : 'Promedios diarios';
  document.getElementById('hourly-analysis-title').textContent = `${hourlyAnalysisLevels[report.analysisLevel].title} · ${viewLabel}`;
  document.getElementById('hourly-analysis-report').dataset.analysisLevel = report.analysisLevel;
  document.getElementById('hourly-analysis-context').textContent = dates.length
    ? `${report.scope.label} · ${report.selection.label} · ${levelLabel} · ${viewLabel} · ${formatReportDate(dates[0])} – ${formatReportDate(dates.at(-1))} · ${report.filters.occurrences ? `${report.filters.occurrences} fecha(s) solicitadas · ` : ''}${report.sampleSize} día(s) con ventas`
    : `${report.scope.label} · ${report.selection.label} · ${levelLabel} · Sin días con ventas para los filtros seleccionados`;
  const metricDefinitions = [
    [showTotals ? 'Unidades totales' : 'Unidades promedio', `${formatHourlyTableQuantity(showTotals ? report.metrics.totalUnits : report.metrics.averageUnits)} unidades`],
    [showTotals ? 'Facturación total' : 'Facturación promedio', formatClp(showTotals ? report.metrics.totalNetSales : report.metrics.averageNetSales)],
    ['Variación unidades', report.metrics.unitCoefficientOfVariation === null ? 'Sin base' : `${formatHourlyTableQuantity(report.metrics.unitCoefficientOfVariation)}% CV`, true],
    ['Variación facturación', report.metrics.salesCoefficientOfVariation === null ? 'Sin base' : `${formatHourlyTableQuantity(report.metrics.salesCoefficientOfVariation)}% CV`, true],
    ['Días atípicos', new Intl.NumberFormat('es-CL').format(report.metrics.anomalyCount)],
    ['Franja más intensa', report.metrics.strongestInterval || 'Sin datos']
  ];
  document.getElementById('hourly-analysis-metrics').replaceChildren(...metricDefinitions.map(([label, value, explainsCv]) => {
    const item = document.createElement('article');
    const caption = document.createElement('span');
    const strong = document.createElement('strong');
    caption.textContent = label;
    strong.textContent = explainsCv ? `${value.replace(/ CV$/, '')} ` : value;
    if (explainsCv) strong.append(hourlyCvHelpButton('CV', `Qué significa CV en ${label.toLowerCase()} y cómo se calcula`));
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
  renderHourlyAnalysisNavigation(report);
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
  document.getElementById('hourly-analysis-content').hidden = false;
  document.getElementById('print-hourly-analysis').disabled = false;
  document.getElementById('hourly-analysis-dialog').scrollTop = 0;
}

function openHourlyAnalysisOptions() {
  const dialog = document.getElementById('hourly-analysis-options-dialog');
  if (!dialog.open) dialog.showModal();
}

async function loadHourlyAnalysis(analysisLevel = 'general') {
  if (!hourlyAnalysisLevels[analysisLevel]) return;
  const dialog = document.getElementById('hourly-analysis-dialog');
  const optionsDialog = document.getElementById('hourly-analysis-options-dialog');
  const status = document.getElementById('hourly-analysis-status');
  const button = document.getElementById('generate-hourly-analysis');
  const params = hourlyReportParams();
  if (!params) { if (optionsDialog.open) optionsDialog.close(); return; }
  const sameScope = calculatedViewKeys.get('hourly') === selectedCalculationKey(hourlyReportFilterIds);
  params.set('hierarchyPath', JSON.stringify(sameScope ? hourlySalesHierarchyPath : []));
  params.set('productKey', sameScope ? hourlySalesProductKey || '' : '');
  params.set('analysisLevel', analysisLevel);
  const request = beginCalculation('hourly-analysis', selectedCalculationKey(hourlyReportFilterIds));
  const current = () => isCurrentCalculation('hourly-analysis', request, hourlyReportFilterIds);
  if (optionsDialog.open) optionsDialog.close();
  hourlyAnalysisState = null;
  document.getElementById('hourly-analysis-content').hidden = true;
  document.getElementById('print-hourly-analysis').disabled = true;
  delete document.getElementById('hourly-analysis-report').dataset.analysisLevel;
  document.getElementById('hourly-analysis-title').textContent = hourlyAnalysisLevels[analysisLevel].title;
  document.getElementById('hourly-analysis-context').textContent =
    `${hourlyAnalysisLevels[analysisLevel].label} · ${formatReportDate(params.get('dateFrom') || offsetIsoDate(params.get('dateTo'), -7 * (Number(params.get('occurrences')) - 1)))} – ${formatReportDate(params.get('dateTo'))} · ${params.get('aggregation') === 'total' ? 'Totales' : 'Promedios diarios'}`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  button.disabled = true;
  setStatus(status, `Generando ${hourlyAnalysisLevels[analysisLevel].label.toLowerCase()}: analizando tendencias, dispersión, anomalías y participación horaria…`);
  try {
    const report = await apiRequest(`/api/sales/hourly-analysis?${params}`, { signal: request.controller.signal });
    if (!current()) return;
    if (report.analysisLevel !== analysisLevel) throw new Error('No se recibió el nivel de análisis seleccionado. Vuelve a generar el reporte.');
    renderHourlyAnalysis(report);
    const additionalFindings = (report.breakdowns?.hierarchies?.findings.length || 0)
      + (report.breakdowns?.products?.findings.length || 0);
    setStatus(status, report.sampleSize
      ? `Análisis completo: ${report.sampleSize} día(s), ${report.findings.length + additionalFindings} resultado(s) priorizado(s).`
      : 'No hay ventas suficientes para elaborar el reporte con estos filtros.', report.sampleSize ? 'success' : 'error');
  } catch (error) {
    if (current()) setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get('hourly-analysis') === request) {
      calculatedViewRequests.delete('hourly-analysis');
      button.disabled = false;
    }
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
  document.getElementById('run-sales-ingredients').disabled = !count || calculatedViewRequests.has('sales-ingredients');
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
  if (!dateFrom || !dateTo || dateFrom > dateTo || dateTo > browserIsoToday()) {
    setStatus(status, 'Selecciona un período válido, sin superar el día actual.', 'error');
    return;
  }
  params.set('dateFrom', dateFrom);
  params.set('dateTo', dateTo);
  if (selectedSalesAnalysis.size) params.set('selections', [...selectedSalesAnalysis].join(','));
  const prefix = 'sales-ingredients';
  const request = beginCalculation(prefix, salesReportKey(prefix));
  const current = () => calculatedViewRequests.get(prefix) === request && salesReportKey(prefix) === request.key;
  button.disabled = true;
  updateSalesAnalysisSelectionCount();
  setStatus(status, 'Relacionando ventas, recetas, ingredientes y clasificaciones…');
  try {
    const data = await apiRequest(`/api/sales-by-ingredients?${params}`, { signal: request.controller.signal });
    if (!current()) return;
    salesIngredientsState = data;
    calculatedViewKeys.set(prefix, request.key);
    document.getElementById('sales-ingredients-context').textContent = `${data.scope.label} · ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)}`;
    const validKeys = new Set([...data.options.ingredients, ...data.options.extras].map(item => item.key));
    for (const key of selectedSalesAnalysis) if (!validKeys.has(key)) selectedSalesAnalysis.delete(key);
    renderSalesAnalysisPickers();
    renderSalesIngredientsReport();
    const sourceText = `${data.filesRead} archivo(s) procesado(s) para ${data.scope.label}.`;
    setStatus(status, data.warnings.length ? `${sourceText} ${data.warnings.join(' ')}` : sourceText,
      data.warnings.length ? 'error' : 'success');
  } catch (error) {
    if (!current()) return;
    salesIngredientsState = null;
    renderSalesIngredientsReport();
    setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get(prefix) === request) {
      calculatedViewRequests.delete(prefix);
      button.disabled = false;
      updateSalesAnalysisSelectionCount();
    }
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

function refreshCostReviewLocationFilter() {
  const select = document.getElementById('cost-review-location');
  const previous = select.value || 'all';
  const options = [new Option('Todas las cafeterías', 'all')];
  for (const location of Object.values(locationRegistry).filter(item => item.type === 'store')) {
    options.push(new Option(location.name, location.id));
  }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : 'all';
}

function renderCostReview() {
  const summary = document.getElementById('cost-review-summary');
  const body = document.getElementById('cost-review-body');
  const count = document.getElementById('cost-review-count');
  if (!costReviewState) {
    summary.replaceChildren();
    body.replaceChildren();
    count.textContent = '';
    return;
  }
  const { items, summary: totals } = costReviewState;
  summary.replaceChildren(...[
    ['Sin costo calculable', totals.missing],
    ['Solo costo maestro', totals.masterFallback],
    ['Costo por receta', totals.recipeFallback],
    ['Compra de otro local', totals.otherLocation],
    ['Con compra', totals.covered]
  ].map(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'cost-review-summary-card';
    const title = document.createElement('span');
    title.textContent = label;
    const amount = document.createElement('strong');
    amount.textContent = value.toLocaleString('es-CL');
    card.append(title, amount);
    return card;
  }));
  const type = document.getElementById('cost-review-type').value;
  const state = document.getElementById('cost-review-state').value;
  const search = document.getElementById('cost-review-search').value.trim().toLocaleLowerCase('es-CL');
  const visible = items.filter(item => (type === 'all' || item.type === type)
    && (state === 'all' || (state === 'attention'
      ? item.status === 'missing' || item.status === 'other-location' || (item.status === 'no-purchase' && item.effectiveSource === 'master')
      : state === 'master-fallback' ? item.status === 'no-purchase' && item.effectiveSource === 'master'
        : state === 'recipe-fallback' ? item.status === 'no-purchase' && item.effectiveSource === 'recipe'
          : item.status === state))
    && (!search || `${item.code} ${item.name}`.toLocaleLowerCase('es-CL').includes(search)));
  const typeLabels = { product: 'Producto', ingredient: 'Ingrediente', extra: 'Extra' };
  const stateLabels = {
    missing: 'Sin costo', 'no-purchase': 'Sin compra directa',
    'other-location': 'Compra de otro local', covered: 'Con compra'
  };
  const sourceLabels = { purchase: 'Última compra', recipe: 'Receta', master: 'Maestro', missing: 'No calculable' };
  const money = value => value === null || value === undefined ? '—'
    : new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 2 }).format(value);
  const rows = visible.map(item => {
    const row = document.createElement('tr');
    row.className = `cost-review-${item.status}`;
    const values = [item.code, item.name, typeLabels[item.type] || item.type,
      stateLabels[item.status], item.unit || '—', money(item.effectiveCost),
      sourceLabels[item.effectiveSource] || item.effectiveSource,
      item.effectiveSource === 'missing' ? '—' : item.costBasisEvidence === 'net-field-consistent' ? 'Cotejado' : 'Sin cotejo',
      money(item.purchaseCost),
      item.purchaseDate ? formatReportDate(item.purchaseDate) : '—',
      item.purchaseLocation || '—', money(item.catalogCost)];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    if (item.reason || item.missingComponent) row.title = [item.reason, item.missingComponent].filter(Boolean).join(' · ');
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 12;
    cell.textContent = 'No hay artículos para los filtros seleccionados.';
    row.appendChild(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
  count.textContent = `${visible.length.toLocaleString('es-CL')} de ${items.length.toLocaleString('es-CL')} artículos activos del maestro vigente. Las recetas calculables sin compra directa están disponibles en su filtro; una compra de otro local se muestra como referencia, no como costo propio verificado.`;
}

async function loadCostReview() {
  const status = document.getElementById('cost-review-status');
  const button = document.getElementById('refresh-cost-review');
  const params = new URLSearchParams({ location: document.getElementById('cost-review-location').value || 'all' });
  const dateTo = document.getElementById('cost-review-date').value;
  if (dateTo) params.set('dateTo', dateTo);
  const filterIds = ['cost-review-location', 'cost-review-date'];
  const request = beginCalculation('costs', selectedCalculationKey(filterIds));
  button.disabled = true;
  setStatus(status, 'Revisando compras, recetas y costos del maestro…');
  try {
    const data = await apiRequest(`/api/cost-review?${params}`, { signal: request.controller.signal });
    if (!isCurrentCalculation('costs', request, filterIds)) return;
    costReviewState = data;
    calculatedViewKeys.set('costs', request.key);
    document.getElementById('cost-review-date').value = costReviewState.dateTo;
    renderCostReview();
    setStatus(status, `Costos al ${formatReportDate(costReviewState.dateTo)} · ${costReviewState.scope.label}.`, 'success');
  } catch (error) {
    if (!isCurrentCalculation('costs', request, filterIds)) return;
    setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get('costs') === request) {
      calculatedViewRequests.delete('costs');
      button.disabled = false;
    }
  }
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
  updateConsumptionReferenceButton();
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
  if (item?.costSource === 'toteat-api') return `Costo última compra · API Toteat${item.costSourceDate ? ` · ${formatReportDate(item.costSourceDate)}` : ''}`;
  if (item?.costSource === 'recipe') {
    return `Calculado desde receta e ingredientes${item.costSourceDate ? ` · compras hasta ${formatReportDate(item.costSourceDate)}` : ''}`;
  }
  if (item?.costSource === 'purchase') {
    return `Última compra${item.costSourceDate ? ` · ${formatReportDate(item.costSourceDate)}` : ''}`;
  }
  if (item?.costSource === 'master') return 'Costo del maestro vigente (sin compra anterior comparable)';
  return 'No fue posible calcular el costo con receta, compras o maestro disponibles';
}

function costSourceShort(item) {
  if (item?.costSource === 'toteat-api') return 'API Toteat';
  if (item?.costSource === 'recipe') return item.costIncomplete ? 'Receta (costo parcial)' : 'Receta calculada';
  if (item?.costSource === 'purchase') return `Compra${item.costSourceDate ? ` ${formatReportDate(item.costSourceDate)}` : ''}`;
  if (item?.costSource === 'master') return 'Maestro (respaldo)';
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
      product.costSource === 'recipe' ? 'Receta calculada' : product.costSource === 'purchase' ? 'Última compra' : product.costSource === 'master' ? 'Maestro' : 'Sin costo',
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
    const weekday = (new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7;
    return offsetIsoDate(value, -weekday);
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
  document.getElementById('product-analysis-date-from-field').hidden = !custom;
  document.getElementById('product-analysis-date-to-field').hidden = !custom;
  if (!custom) {
    const referenceDate = productAnalysisOptions?.availablePeriod?.to || browserIsoToday();
    const range = productAnalysisPresetRange(mode, referenceDate);
    from.value = range.from;
    to.value = range.to;
  }
}

async function loadProductAnalysisOptions(location) {
  const status = document.getElementById('product-analysis-config-status');
  const generateButton = document.getElementById('generate-product-analysis');
  generateButton.disabled = true;
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
  } finally {
    generateButton.disabled = false;
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
  append('Total Detalle Pagos', transaction.paymentTotal === null && transaction.paymentDue === null
    ? 'Sin información' : formatClp(transaction.paymentTotal ?? transaction.paymentDue));
  if (transaction.paymentDuePartial) append('A Pagar parcial', transaction.paymentDue === null ? 'Importes múltiples' : formatClp(transaction.paymentDue));
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
    ['Venta neta total', formatClp(report.summary.netSales)],
    ['Unidades de productos', formatProductAnalysisUnits(report.summary.productUnits ?? report.summary.units)],
    ['Unidades de extras', formatProductAnalysisUnits(report.summary.extraUnits || 0)],
    ['Venta neta de extras', formatClp(report.summary.extraNetSales || 0)],
    ['Pedidos', Number(report.summary.orders).toLocaleString('es-CL')],
    ['Ticket promedio con IVA', formatClp(report.summary.averageTicket)],
    ['Margen productos', report.summary.grossMarginPercent === null ? 'Sin costo suficiente' : formatProductAnalysisPercent(report.summary.grossMarginPercent)],
    ['Hallazgos de alto impacto', String(report.summary.highImpactCount)]
  ].forEach(([label, value]) => {
    const card = productAnalysisElement('div', 'product-analysis-metric');
    card.append(productAnalysisElement('span', '', label), productAnalysisElement('strong', '', value));
    metrics.appendChild(card);
  });
  executive.appendChild(metrics);
  const reconciliation = report.reconciliation || {
    productNetSales: report.summary.productNetSales ?? report.summary.netSales,
    extraNetSales: report.summary.extraNetSales || 0,
    otherNetSales: report.summary.otherNetSales || 0,
    totalNetSales: report.summary.netSales
  };
  const reconciliationBlock = productAnalysisElement('div', 'product-analysis-reconciliation');
  const reconciliationTitle = productAnalysisElement('div', 'product-analysis-reconciliation-title');
  reconciliationTitle.append(
    productAnalysisElement('strong', '', 'Conciliación de venta neta'),
    productAnalysisElement('span', '', 'El total usa los pedidos completos; los análisis de productos excluyen extras.')
  );
  const reconciliationEquation = productAnalysisElement('div', 'product-analysis-reconciliation-equation');
  const addReconciliationValue = (label, value) => {
    const item = productAnalysisElement('div', 'product-analysis-reconciliation-value');
    item.append(productAnalysisElement('span', '', label), productAnalysisElement('strong', '', formatClp(value)));
    reconciliationEquation.appendChild(item);
  };
  addReconciliationValue('Productos base', reconciliation.productNetSales);
  reconciliationEquation.appendChild(productAnalysisElement('b', 'product-analysis-reconciliation-symbol', '+'));
  addReconciliationValue('Extras', reconciliation.extraNetSales);
  if (Math.abs(Number(reconciliation.otherNetSales) || 0) >= 1) {
    reconciliationEquation.appendChild(productAnalysisElement('b', 'product-analysis-reconciliation-symbol', '+'));
    addReconciliationValue('Otras líneas fuera del alcance', reconciliation.otherNetSales);
  }
  reconciliationEquation.appendChild(productAnalysisElement('b', 'product-analysis-reconciliation-symbol', '='));
  const totalValue = productAnalysisElement('div', 'product-analysis-reconciliation-value is-total');
  totalValue.append(productAnalysisElement('span', '', 'Venta neta total'), productAnalysisElement('strong', '', formatClp(reconciliation.totalNetSales)));
  reconciliationEquation.appendChild(totalValue);
  reconciliationBlock.append(reconciliationTitle, reconciliationEquation);
  executive.appendChild(reconciliationBlock);
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
    ['Productos con costo calculable', formatProductAnalysisPercent(report.coverage.purchaseCostCoveragePercent), 'Receta calculada; sin receta, compra o costo directo como respaldo'],
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

  const temporal = register('temporal', 'Día y hora', productAnalysisSection('temporal', 'Preferencias por día y horario', 'Cuándo se concentra la venta', 'Los promedios diarios consideran solo días con ventas de cada día de semana.'));
  temporal.append(productAnalysisTable(['Día', 'Días observados', 'Unidades promedio', 'Venta neta promedio'], report.temporal.weekdays.map(item => [item.label, item.days, formatProductAnalysisUnits(item.averageUnits), formatClp(item.averageNetSales)])), productAnalysisTable(['Hora', 'Unidades', 'Venta neta'], report.temporal.hours.map(item => [item.label, formatProductAnalysisUnits(item.units), formatClp(item.netSales)])));

  const service = register('service', 'Modalidad', productAnalysisSection('service', 'Para llevar, local y sin información', 'Modalidad y ticket promedio', 'La clasificación proviene del Comentario General de Detalle Pagos.'));
  service.appendChild(productAnalysisTable(['Modalidad', 'Pedidos', 'Part. pedidos', 'Venta neta', 'Part. venta neta', 'Ticket con IVA'], report.serviceModes.map(item => [item.label, item.orders.toLocaleString('es-CL'), formatProductAnalysisPercent(item.orderShare), formatClp(item.netSales), formatProductAnalysisPercent(item.salesShare), formatClp(item.averageTicket)])));

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

  const price = register('price', 'Precio', productAnalysisSection('price', 'Precio, venta y margen', 'Sensibilidad observada — no causal', report.priceSensitivity.caveat));
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
  const mode = document.getElementById('product-analysis-period').value;
  const fromInput = document.getElementById('product-analysis-date-from');
  const toInput = document.getElementById('product-analysis-date-to');
  let dateFrom = fromInput.value;
  let dateTo = toInput.value;
  if (mode !== 'custom') {
    const referenceDate = productAnalysisOptions?.availablePeriod?.to || browserIsoToday();
    const range = productAnalysisPresetRange(mode, referenceDate);
    dateFrom = range.from;
    dateTo = range.to;
    fromInput.value = dateFrom;
    toInput.value = dateTo;
  }
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    return setStatus(status, mode === 'custom'
      ? 'Selecciona un rango personalizado válido.'
      : 'No fue posible determinar el período seleccionado.', 'error');
  }
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
    ['Venta neta total', report.summary.netSales], ['Venta neta productos base', report.summary.productNetSales ?? report.summary.netSales],
    ['Venta neta extras', report.summary.extraNetSales || 0], ['Otras líneas fuera del alcance', report.summary.otherNetSales || 0],
    ['Unidades de productos', report.summary.productUnits ?? report.summary.units], ['Unidades de extras', report.summary.extraUnits || 0],
    ['Pedidos', report.summary.orders], ['Ticket promedio con IVA', report.summary.averageTicket],
    ['Cobertura Detalle Pagos %', report.coverage.paymentMatchPercent], ['Cobertura recetas %', report.coverage.recipeCoveragePercent],
    ['Exportado', new Date().toLocaleString('es-CL')]
  ]);
  append('Conciliación', ['Concepto', 'Venta neta', 'Unidades'], [
    ['Productos base', report.reconciliation?.productNetSales ?? report.summary.productNetSales ?? report.summary.netSales, report.reconciliation?.productUnits ?? report.summary.productUnits ?? report.summary.units],
    ['Extras', report.reconciliation?.extraNetSales ?? report.summary.extraNetSales ?? 0, report.reconciliation?.extraUnits ?? report.summary.extraUnits ?? 0],
    ['Otras líneas fuera del alcance', report.reconciliation?.otherNetSales ?? report.summary.otherNetSales ?? 0, ''],
    ['Venta neta total', report.reconciliation?.totalNetSales ?? report.summary.netSales, '']
  ]);
  append('Hallazgos', ['ID', 'Impacto', 'Confianza', 'Sección', 'Título', 'Detalle', 'Evidencia', 'Acción o pregunta'], report.findings.map(item => [item.id, item.impact, item.confidence, item.section, item.title, item.detail, item.evidence.join(' · '), item.action]));
  append('Productos', ['Código', 'Producto', 'Jerarquía', 'ABC', 'Unidades', 'Venta neta', 'Participación %', 'Pedidos', 'Precio promedio', 'Costo unitario', 'Origen costo', 'Margen %', 'Crecimiento venta %', 'Tendencia %', 'CV %'], report.appendix.products.map(item => [item.code, item.name, item.hierarchy, item.abc, item.units, item.netSales, item.salesShare, item.orderCount, item.averagePrice, item.unitCost, item.costSource, item.marginPercent, item.salesGrowthPercent, item.trendPercent, item.variabilityPercent]));
  append('Canastas', ['Código A', 'Producto A', 'Código B', 'Producto B', 'Pedidos', 'Soporte %', 'Confianza A-B %', 'Confianza B-A %', 'Lift'], report.baskets.pairs.map(item => [item.leftCode, item.leftName, item.rightCode, item.rightName, item.orders, item.supportPercent, item.confidenceLeftToRightPercent, item.confidenceRightToLeftPercent, item.lift]));
  append('Extras y modificadores', ['Código', 'Extra', 'Pedidos', 'Unidades', 'Participación pedidos %'], report.baskets.modifiers.map(item => [item.code, item.name, item.orders, item.units, item.orderShare]));
  append('Lectura canastas', ['Tipo', 'Título o término', 'Explicación'], [
    ...report.baskets.definitions.map(item => ['Definición', item.term, item.detail]),
    ...report.baskets.interpretation.map(item => ['Conclusión', item.title, item.detail])
  ]);
  append('Modalidad', ['Modalidad', 'Pedidos', 'Participación pedidos %', 'Venta neta', 'Participación venta neta %', 'Ticket promedio con IVA'], report.serviceModes.map(item => [item.label, item.orders, item.orderShare, item.netSales, item.salesShare, item.averageTicket]));
  append('Días y horas', ['Tipo', 'Valor', 'Observaciones', 'Unidades', 'Venta neta'], [...report.temporal.weekdays.map(item => ['Día semana', item.label, item.days, item.averageUnits, item.averageNetSales]), ...report.temporal.hours.map(item => ['Hora', item.label, '', item.units, item.netSales])]);
  append('Formatos', ['Familia', 'Jerarquía', 'Confianza', 'Código', 'Producto', 'Formato', 'Precio lista', 'Precio neto', 'Unidades', 'Participación unidades familia %', 'Venta neta', 'Participación venta familia %', 'Descuento implícito %', 'Precio promedio'], report.formats.families.flatMap(family => family.formats.map(item => [family.family, family.hierarchy, family.confidence, item.code, item.name, item.format, item.listPrice, item.netListPrice, item.units, item.familyUnitSharePercent, item.netSales, item.familySalesSharePercent, item.implicitDiscountPercent, item.averagePrice])));
  append('Transacciones formatos', ['Familia', 'Código', 'Producto', 'Fecha', 'Hora', 'Pedido', 'Ubicación', 'Modalidad', 'Unidades', 'Venta neta producto', 'Precio neto unitario', 'Precio con IVA', 'Descuento implícito %', 'Venta neta pedido'], report.formats.families.flatMap(family => family.formats.flatMap(item => item.transactions.map(transaction => [family.family, item.code, item.name, transaction.date, productAnalysisTimeLabel(transaction.hour), transaction.orderReference || transaction.orderKey, transaction.locationName, productAnalysisModeLabel(transaction.mode), transaction.quantity, transaction.netSales, transaction.averageNetPrice, transaction.averageGrossPrice, transaction.implicitDiscountPercent, transaction.orderNetSales]))));
  append('Detalle pedidos', ['Pedido', 'Fecha', 'Hora', 'Ubicación', 'Modalidad', 'Clientes', 'Comentario general', 'Total Detalle Pagos', 'A Pagar', 'Venta neta pedido', 'Código línea', 'Producto / extra', 'Tipo', 'Jerarquía', 'Cantidad', 'Venta neta línea', 'Origen valor', 'Precio neto unitario', 'Precio con IVA', 'Descuento implícito %'], report.formats.families.flatMap(family => family.formats.flatMap(item => item.transactions.flatMap(transaction => (transaction.orderLines || []).map(line => [transaction.orderReference || transaction.orderKey, transaction.date, productAnalysisTimeLabel(transaction.hour), transaction.locationName, productAnalysisModeLabel(transaction.mode), transaction.clients, transaction.paymentComment, transaction.paymentTotal ?? transaction.paymentDue, transaction.paymentDue, transaction.orderNetSales, line.code, line.name, line.type, line.hierarchy, line.quantity, line.netSales, productAnalysisSalesAllocationLabel(line.salesAllocation), line.averageNetPrice, line.averageGrossPrice, line.implicitDiscountPercent])))));
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
    item.costSource === 'recipe' ? 'Receta calculada' : item.costSource === 'purchase' ? 'Última compra' : item.costSource === 'master' ? 'Maestro' : 'Sin costo',
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
      item.costSource === 'recipe' ? 'Receta calculada' : item.costSource === 'purchase' ? 'Última compra' : item.costSource === 'master' ? 'Maestro' : 'Sin costo',
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

function ingredientYieldExceptions() {
  if (!ingredientsViewState) return [];
  return filteredIngredientItems().flatMap(ingredient => ingredient.products.flatMap(product => {
    const yieldRate = Number(product.yieldRate);
    if (!Number.isFinite(yieldRate) || Math.abs(yieldRate - 100) < 0.0001) return [];
    const effectiveRecipeQuantity = yieldRate > 0
      ? product.recipeQuantity / (yieldRate / 100)
      : product.recipeQuantity;
    return [{
      ingredientCode: ingredient.code,
      ingredientName: ingredient.name,
      productCode: product.code,
      productName: product.name,
      recipeQuantity: product.recipeQuantity,
      recipeUnit: product.recipeUnit,
      yieldRate,
      effectiveRecipeQuantity,
      periodProductQuantity: product.periodProductQuantity,
      periodIngredientQuantity: product.periodIngredientQuantity,
      periodIngredientUnit: product.periodIngredientUnit
    }];
  })).sort((left, right) => left.productName.localeCompare(right.productName, 'es')
    || left.ingredientName.localeCompare(right.ingredientName, 'es'));
}

function exportIngredientYieldsReport() {
  const status = document.getElementById('ingredients-status');
  const rows = ingredientYieldExceptions();
  if (!rows.length) {
    return setStatus(status, 'No hay recetas con ingredientes cuyo rendimiento sea distinto de 100%.', 'muted');
  }
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const data = ingredientsViewState;
    const products = new Map();
    for (const row of rows) {
      const current = products.get(row.productCode) || {
        code: row.productCode,
        name: row.productName,
        periodProductQuantity: row.periodProductQuantity,
        ingredients: []
      };
      current.ingredients.push(row);
      products.set(row.productCode, current);
    }
    const productRows = [...products.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
      .map(product => [
        product.code,
        product.name,
        product.ingredients.length,
        Math.min(...product.ingredients.map(item => item.yieldRate)),
        product.ingredients.map(item => `${item.ingredientCode} ${item.ingredientName} (${item.yieldRate}%)`).join(' · '),
        product.periodProductQuantity
      ]);
    const detailHeaders = [
      'Código producto', 'Producto', 'Código ingrediente', 'Ingrediente', 'Cantidad receta', 'Unidad receta',
      'Rendimiento %', 'Cantidad efectiva por producto', 'Productos vendidos período',
      'Consumo ingrediente período', 'Unidad consumo período'
    ];
    const detailRows = rows.map(row => [
      row.productCode, row.productName, row.ingredientCode, row.ingredientName,
      row.recipeQuantity, row.recipeUnit, row.yieldRate, row.effectiveRecipeQuantity,
      row.periodProductQuantity, row.periodIngredientQuantity, row.periodIngredientUnit
    ]);
    const information = XLSX.utils.aoa_to_sheet([
      ['Reporte', 'Productos con ingredientes de rendimiento distinto de 100%'],
      ['Ubicación', data.scope.label],
      ['Fecha inicial', data.period.from],
      ['Fecha final', data.period.to],
      ['Proveedor', document.getElementById('ingredients-supplier-filter').selectedOptions[0]?.textContent || 'Todos los proveedores'],
      ['Búsqueda', document.getElementById('ingredients-search').value.trim() || 'Todos'],
      ['Solo con variación de costo', document.getElementById('ingredients-only-changed').checked ? 'Sí' : 'No'],
      ['Productos incluidos', productRows.length],
      ['Líneas de receta incluidas', detailRows.length],
      ['Criterio', 'Tasa Rendimiento <> 100%'],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    const productHeaders = [
      'Código producto', 'Producto', 'Ingredientes con rendimiento <> 100%', 'Rendimiento mínimo %',
      'Ingredientes y rendimientos', 'Productos vendidos período'
    ];
    const productSheet = XLSX.utils.aoa_to_sheet([productHeaders, ...productRows]);
    productSheet['!autofilter'] = { ref: `A1:F${productRows.length + 1}` };
    productSheet['!cols'] = [{ wch: 18 }, { wch: 44 }, { wch: 24 }, { wch: 22 }, { wch: 80 }, { wch: 24 }];
    const detailSheet = XLSX.utils.aoa_to_sheet([detailHeaders, ...detailRows]);
    detailSheet['!autofilter'] = { ref: `A1:K${detailRows.length + 1}` };
    detailSheet['!cols'] = detailHeaders.map((header, index) => ({
      wch: [1, 3].includes(index) ? 44 : Math.max(14, Math.min(30, header.length + 2))
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, information, 'Información');
    XLSX.utils.book_append_sheet(workbook, productSheet, 'Productos');
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detalle rendimientos');
    writeConfiguredExcelWorkbook(workbook, `rendimiento-ingredientes-no-100-${data.period.from}-${data.period.to}.xlsx`);
    setStatus(status, `Reporte exportado: ${productRows.length} producto(s) y ${detailRows.length} ingrediente(s) con rendimiento distinto de 100%.`, 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el reporte de rendimientos: ${error.message}`, 'error');
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
    document.getElementById('export-ingredient-yields-report').disabled = true;
    return;
  }
  const items = filteredIngredientItems();
  document.getElementById('print-ingredients-report').disabled = items.length === 0;
  document.getElementById('export-ingredients-report').disabled = items.length === 0;
  document.getElementById('export-ingredient-yields-report').disabled = ingredientYieldExceptions().length === 0;
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
  const filterIds = ['ingredients-location-filter', 'ingredients-date-from', 'ingredients-date-to'];
  const request = beginCalculation('ingredients', selectedCalculationKey(filterIds));
  button.disabled = true;
  setStatus(status, 'Calculando uso, costos, proveedores y recetas…');
  try {
    const data = await apiRequest(`/api/ingredients?${params}`, { signal: request.controller.signal });
    if (!isCurrentCalculation('ingredients', request, filterIds)) return;
    ingredientsViewState = data;
    calculatedViewKeys.set('ingredients', request.key);
    document.getElementById('ingredients-date-from').value = data.period.from;
    document.getElementById('ingredients-date-to').value = data.period.to;
    const supplierSelect = document.getElementById('ingredients-supplier-filter');
    const previous = supplierSelect.value || 'all';
    supplierSelect.replaceChildren(new Option('Todos los proveedores', 'all'), ...data.suppliers.map(item => new Option(item.name, item.key)));
    supplierSelect.value = data.suppliers.some(item => item.key === previous) ? previous : 'all';
    renderIngredientsView();
    setStatus(status, `Período ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)} para ${data.scope.label}.`, 'success');
  } catch (error) {
    if (!isCurrentCalculation('ingredients', request, filterIds)) return;
    setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get('ingredients') === request) {
      calculatedViewRequests.delete('ingredients');
      button.disabled = false;
    }
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
      { key: 'discount', label: 'Descuento', value: row => row.discount === null ? 'No disponible' : formatClp(row.discount) },
      { key: 'comparisonUnitCost', label: 'Precio comparable', headerLines: 'Precio comparable|por unidad', value: row => `${formatClp(row.comparisonUnitCost)} / ${row.comparisonUnit || '—'}` },
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

function initializePurchaseDates() {
  const today = browserIsoToday();
  const weekAgo = new Date(`${today}T12:00:00Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  if (!document.getElementById('purchases-date-from').value) document.getElementById('purchases-date-from').value = weekAgo.toISOString().slice(0, 10);
  if (!document.getElementById('purchases-date-to').value) document.getElementById('purchases-date-to').value = today;
}

async function loadPurchasesView() {
  const status = document.getElementById('purchases-status');
  const button = document.getElementById('refresh-purchases');
  const location = document.getElementById('purchases-location-filter').value || 'all';
  const supplier = document.getElementById('purchases-supplier-filter').value || 'all';
  const product = document.getElementById('purchases-product-filter').value.trim();
  initializePurchaseDates();
  const today = browserIsoToday();
  const dateFrom = document.getElementById('purchases-date-from').value;
  const dateTo = document.getElementById('purchases-date-to').value;
  const params = new URLSearchParams({ location, supplier });
  if (product) params.set('product', product);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const filterIds = ['purchases-location-filter', 'purchases-supplier-filter', 'purchases-product-filter', 'purchases-date-from', 'purchases-date-to'];
  const request = beginCalculation('purchases', selectedCalculationKey(filterIds));
  button.disabled = true;
  setStatus(status, 'Procesando el historial de compras…');
  try {
    const data = await apiRequest(`/api/purchases?${params}`, { signal: request.controller.signal });
    if (!isCurrentCalculation('purchases', request, filterIds)) return;
    purchasesViewState = data;
    calculatedViewKeys.set('purchases', request.key);
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
    fromInput.max = toInput.max = today;
    renderPurchasesView();
    setStatus(status, data.sourceFileCount
      ? data.scope.type === 'warehouse'
        ? `${data.sourceFileCount} Kardex procesado(s) para ${data.scope.label}. Se muestran ingresos BUY; el Kardex no identifica proveedor ni documento de compra.`
        : `${data.sourceFileCount} archivo(s) procesado(s) para ${data.scope.label}.`
      : 'No hay información de compras disponible para la selección.', data.sourceFileCount ? 'success' : 'muted');
  } catch (error) {
    if (!isCurrentCalculation('purchases', request, filterIds)) return;
    setStatus(status, error.message, 'error');
  } finally {
    if (calculatedViewRequests.get('purchases') === request) {
      calculatedViewRequests.delete('purchases');
      button.disabled = false;
    }
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
      'Costo UDC registrado', 'Costo Unitario', 'Descuento', 'Precio comparable', 'Unidad comparable',
      'Precio anterior', 'Cambio %', 'Monto neto', 'Monto total', 'Fuente'
    ];
    const values = data.rows.map(row => [
      row.date, row.locationName, row.supplier, row.supplierTaxId || '', row.documentType || '',
      row.document || '', row.line || '', row.code || '', row.product || '', row.quantity,
      row.purchaseUnit || row.unit || '', row.unitsPerPurchaseUnit, row.baseUnit || '',
      row.listedUnitPrice, row.baseUnitCost, row.discount, row.comparisonUnitCost, row.comparisonUnit,
      row.previousEffectiveUnitPrice, row.priceChangePercent, row.netAmount, row.totalAmount,
      row.sourceType === 'kardex-buy' ? 'Kardex BUY' : 'Archivo de compras'
    ]);
    const purchasesSheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
    purchasesSheet['!autofilter'] = { ref: `A1:W${values.length + 1}` };
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

function supplyMultipleFromPolicy(policy, unitsPerPurchaseUnit, purchaseUnit) {
  if (policy.unitsPerPackage === null) return null;
  const multiple = Number(policy.unitsPerPackage);
  if (!Number.isFinite(multiple) || multiple <= 0) return 1;
  if (policy.unitsPerPackageBasis === 'purchase') return multiple;
  const conversion = Number(unitsPerPurchaseUnit);
  if (!Number.isFinite(conversion) || conversion <= 0) return null;
  const converted = multiple / conversion;
  const measured = /^(kg|kilo|kilogramo|g|gr|gramo|mg|l|lt|litro|ml)$/i.test(String(purchaseUnit || '').trim());
  // Legacy package sizes were in consumption units. Counted supplies remain whole.
  return measured ? Number(converted.toPrecision(12)) : Math.max(1, Math.ceil(converted - 1e-9));
}

function purchaseUnitsForInternalQuantity(quantity, unitsPerPurchaseUnit, minimumMultiple = 1) {
  const value = Number(quantity), conversion = Number(unitsPerPurchaseUnit), multiple = Number(minimumMultiple);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(conversion) || conversion <= 0
    || !Number.isFinite(multiple) || multiple <= 0) return null;
  return Number((Math.max(1, Math.ceil((value / conversion / multiple) - 1e-9)) * multiple).toPrecision(12));
}

function isSupplyMultiple(quantity, minimumMultiple) {
  const value = Number(quantity), multiple = Number(minimumMultiple);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(multiple) || multiple <= 0) return false;
  const ratio = value / multiple;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-8 && Math.round(ratio) >= 1;
}

function purchaseQuantityPackageWarning(item, purchaseQuantity) {
  if (isSupplyMultiple(purchaseQuantity, item.unitsPerPackage)) return '';
  return `Solicita múltiplos de ${formatProjectionQuantity(item.unitsPerPackage)} ${item.purchaseUnit || 'unidades de abastecimiento'}.`;
}

function formatSupplySuggestion(item) {
  if (!item.needsPurchase) return 'No comprar';
  if (item.suggestedPurchaseUnits === null) return item.unitsPerPackage === null ? 'Configura múltiplo' : 'Sin conversión';
  return `${formatProjectionQuantity(item.suggestedPurchaseUnits)} ${item.purchaseUnit || ''}`.trim();
}

function projectionSuggestionMetrics(item) {
  const suggestedConsumptionQuantity = !item.needsPurchase ? 0
    : Number.isFinite(item.suggestedPurchaseUnits) && item.suggestedPurchaseUnits > 0
      && Number.isFinite(item.unitsPerPurchaseUnit) && item.unitsPerPurchaseUnit > 0
      ? Number((item.suggestedPurchaseUnits * item.unitsPerPurchaseUnit).toPrecision(12)) : null;
  const inventory = item.totalInventory === undefined ? item.currentInventory : item.totalInventory;
  const daily = item.localsDailyConsumption === undefined ? item.averageDailyConsumption : item.localsDailyConsumption;
  const coverageAfterSuggestionDays = suggestedConsumptionQuantity !== null && Number.isFinite(inventory)
    && Number.isFinite(daily) && daily > 0 ? (inventory + suggestedConsumptionQuantity) / daily : null;
  return { suggestedConsumptionQuantity, coverageAfterSuggestionDays };
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
  item.ownNeedsPurchase = Number.isFinite(item.currentInventory) && item.averageDailyConsumption > 0 && item.currentInventory <= item.minimumStock;
  item.ownSuggestedInternalQuantity = item.ownNeedsPurchase
    ? Math.max(0, item.maximumStock - item.currentInventory) : 0;
  item.rawSuggestedInternalQuantity = !Number.isFinite(item.currentInventory) ? 0 : item.averageDailyConsumption > 0
    ? (item.currentInventory <= item.minimumStock
      ? Math.max(0, item.maximumStock - item.currentInventory)
      : 0)
    : Math.max(0, -item.currentInventory);
  item.needsPurchase = item.rawSuggestedInternalQuantity > 0;
  item.suggestedPurchaseUnits = purchaseUnitsForInternalQuantity(
    item.rawSuggestedInternalQuantity, item.unitsPerPurchaseUnit, item.unitsPerPackage
  );
  item.suggestedInternalQuantity = item.suggestedPurchaseUnits === null ? item.rawSuggestedInternalQuantity
    : Number((item.suggestedPurchaseUnits * item.unitsPerPurchaseUnit).toPrecision(12));
  item.projectedInternalQuantity = item.suggestedInternalQuantity;
  Object.assign(item, projectionSuggestionMetrics(item));
  item.estimatedTotal = item.suggestedPurchaseUnits === null || item.estimatedPurchaseUnitCost === null
    ? null : item.suggestedPurchaseUnits * item.estimatedPurchaseUnitCost;
}

function updateConsumptionReferenceButton() {
  const location = document.getElementById('projection-location-filter').value;
  document.getElementById('configure-consumption-reference').disabled = locationRegistry[location]?.type !== 'store';
}

function renderConsumptionReferenceConfiguration() {
  const data = consumptionReferenceConfiguration;
  if (!data) return;
  const enabled = document.getElementById('consumption-reference-enabled').checked;
  const source = document.getElementById('consumption-reference-source');
  const curve = data.curves.find(item => item.id === document.getElementById('consumption-reference-curve').value);
  source.disabled = !enabled;
  document.getElementById('consumption-reference-curve').disabled = !enabled;
  document.getElementById('consumption-reference-opening').textContent = data.reference.openingDate
    ? formatReportDate(data.reference.openingDate) : 'Sin configurar';
  document.getElementById('consumption-reference-end').textContent = curve?.endsAt ? formatReportDate(curve.endsAt) : 'Requiere fecha de apertura';
  const stage = curve?.stages.filter(item => item.startsAt <= data.today).at(-1);
  const expired = curve?.endsAt && data.today >= curve.endsAt;
  document.getElementById('consumption-reference-stage').textContent = !enabled
    ? 'Función desactivada: se utiliza el consumo propio.'
    : !data.reference.openingDate ? 'Configura la fecha de apertura en Configuración antes de activar la referencia.'
    : expired ? 'La curva ya terminó. Se utilizará el consumo propio automáticamente.'
    : !stage ? 'La regla comenzará en la fecha de apertura.'
    : `Tramo vigente: ${stage.percentage}% del consumo de referencia. Después del término se utiliza el consumo propio.`;
  document.getElementById('save-consumption-reference').disabled = document.getElementById('consumption-reference-dialog').dataset.saving === 'true'
    || (enabled && (!source.value || !curve || !data.reference.openingDate));
}

async function openConsumptionReferenceConfiguration() {
  const location = document.getElementById('projection-location-filter').value;
  if (locationRegistry[location]?.type !== 'store') return;
  const dialog = document.getElementById('consumption-reference-dialog');
  const status = document.getElementById('consumption-reference-status');
  consumptionReferenceConfiguration = null;
  dialog.dataset.location = location;
  document.getElementById('consumption-reference-location').textContent = locationRegistry[location].name;
  document.getElementById('consumption-reference-enabled').checked = false;
  ['consumption-reference-enabled', 'consumption-reference-source', 'consumption-reference-curve', 'save-consumption-reference'].forEach(id => {
    document.getElementById(id).disabled = true;
  });
  document.getElementById('consumption-reference-source').replaceChildren();
  document.getElementById('consumption-reference-curve').replaceChildren();
  ['consumption-reference-opening', 'consumption-reference-end', 'consumption-reference-stage'].forEach(id => {
    document.getElementById(id).textContent = '';
  });
  setStatus(status, 'Cargando configuración…');
  dialog.showModal();
  try {
    const data = await apiRequest(`/api/purchase-projections/consumption-reference?location=${encodeURIComponent(location)}`);
    if (!dialog.open || dialog.dataset.location !== location) return;
    consumptionReferenceConfiguration = data;
    const source = document.getElementById('consumption-reference-source');
    source.replaceChildren(new Option('Selecciona una cafetería estable', ''),
      ...data.sources.map(item => new Option(item.name, item.id)));
    source.value = data.reference.sourceLocationId;
    const curve = document.getElementById('consumption-reference-curve');
    curve.replaceChildren(...data.curves.map(item => new Option(item.label, item.id)));
    curve.value = data.reference.curveId;
    document.getElementById('consumption-reference-enabled').disabled = false;
    document.getElementById('consumption-reference-enabled').checked = data.reference.enabled;
    renderConsumptionReferenceConfiguration();
    setStatus(status, '');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function saveConsumptionReferenceConfiguration() {
  const dialog = document.getElementById('consumption-reference-dialog');
  const status = document.getElementById('consumption-reference-status');
  const button = document.getElementById('save-consumption-reference');
  if (button.disabled || !consumptionReferenceConfiguration) return;
  const location = dialog.dataset.location;
  if (location !== document.getElementById('projection-location-filter').value) return;
  button.disabled = true;
  document.getElementById('cancel-consumption-reference').disabled = true;
  dialog.dataset.saving = 'true';
  setStatus(status, 'Guardando configuración…');
  try {
    await apiRequest('/api/purchase-projections/consumption-reference', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location,
        enabled: document.getElementById('consumption-reference-enabled').checked,
        sourceLocationId: document.getElementById('consumption-reference-source').value,
        curveId: document.getElementById('consumption-reference-curve').value
      })
    });
    dialog.close();
    resetPurchaseProjection();
    setStatus(document.getElementById('purchase-projection-status'),
      'Configuración de consumo de referencia guardada. Presiona Actualizar para cargar la proyección.', 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    dialog.dataset.saving = 'false';
    document.getElementById('cancel-consumption-reference').disabled = false;
    renderConsumptionReferenceConfiguration();
  }
}

function ingredientMasterEquivalence(row, item, draft) {
  const values = IngredientMasterExport.values(item, draft);
  row.querySelector('.ingredient-master-equivalence').textContent = values[5];
  row.querySelector('.ingredient-master-transfer-equivalence').textContent = values[8];
  if (!draft.transferUnit) row.querySelector('.ingredient-master-transfer-content').value = values[7] ?? '';
}

function visibleIngredientPurchaseMasterItems() {
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const query = normalize(document.getElementById('ingredient-purchase-master-search').value);
  return (ingredientPurchaseMasterState?.items || []).filter(item => normalize(`${item.code} ${item.name}`).includes(query));
}

function renderIngredientPurchaseMaster() {
  const items = visibleIngredientPurchaseMasterItems();
  document.getElementById('ingredient-purchase-master-body').replaceChildren(...items.map(item => {
    const draft = ingredientPurchaseMasterDrafts.get(item.code) || item;
    const row = document.createElement('tr');
    row.dataset.code = item.code;
    for (const value of [item.code, item.name, item.internalUnit || 'Sin unidad de consumo']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    const unitCell = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'ingredient-master-purchase-unit';
    select.setAttribute('aria-label', `Unidad de abastecimiento de ${item.name}`);
    select.replaceChildren(new Option('Usar valores del maestro', ''),
      ...item.allowedPurchaseUnits.map(unit => new Option(unit, unit)));
    select.value = draft.purchaseUnit;
    select.disabled = !item.internalUnit;
    unitCell.appendChild(select);
    row.appendChild(unitCell);
    const contentCell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.max = '1000000000';
    input.className = 'ingredient-master-content';
    input.value = draft.unitsPerPurchaseUnit ?? '';
    input.disabled = !draft.purchaseUnit || !item.internalUnit;
    input.setAttribute('aria-label', `Unidades de consumo en ${item.internalUnit} por unidad de abastecimiento de ${item.name}`);
    contentCell.append(input, ` ${item.internalUnit}`);
    row.appendChild(contentCell);
    const equivalence = document.createElement('td');
    equivalence.className = 'ingredient-master-equivalence';
    row.appendChild(equivalence);
    const transferUnitCell = document.createElement('td');
    const transferSelect = document.createElement('select');
    transferSelect.className = 'ingredient-master-transfer-unit';
    transferSelect.setAttribute('aria-label', `Unidad de transferencia a cafeterías de ${item.name}`);
    transferSelect.replaceChildren(new Option('Copiar unidad de abastecimiento', ''),
      ...item.allowedPurchaseUnits.map(unit => new Option(unit, unit)));
    transferSelect.value = draft.transferUnit || '';
    transferSelect.disabled = !item.internalUnit;
    transferUnitCell.appendChild(transferSelect); row.appendChild(transferUnitCell);
    const transferContentCell = document.createElement('td');
    const transferInput = document.createElement('input');
    transferInput.type = 'number'; transferInput.min = '0'; transferInput.step = 'any'; transferInput.max = '1000000000';
    transferInput.className = 'ingredient-master-transfer-content';
    transferInput.value = draft.unitsPerTransferUnit ?? '';
    transferInput.disabled = !draft.transferUnit || !item.internalUnit;
    transferInput.setAttribute('aria-label', `Unidades de consumo en ${item.internalUnit} por unidad de transferencia a cafeterías de ${item.name}`);
    transferContentCell.append(transferInput, ` ${item.internalUnit}`); row.appendChild(transferContentCell);
    const transferEquivalence = document.createElement('td');
    transferEquivalence.className = 'ingredient-master-transfer-equivalence';
    row.appendChild(transferEquivalence);
    ingredientMasterEquivalence(row, item, draft);
    return row;
  }));
  document.getElementById('save-ingredient-purchase-master').disabled = !ingredientPurchaseMasterDrafts.size;
  document.querySelectorAll('.ingredient-purchase-master-exports button').forEach(button => {
    button.disabled = !items.length || document.getElementById('ingredient-purchase-master-dialog').dataset.saving === 'true';
  });
}

function exportIngredientPurchaseMaster(format) {
  const status = document.getElementById('ingredient-purchase-master-status');
  const items = visibleIngredientPurchaseMasterItems();
  if (!items.length || document.getElementById('ingredient-purchase-master-dialog').dataset.saving === 'true') return;
  try {
    const rows = items.map(item => {
      const draft = ingredientPurchaseMasterDrafts.get(item.code) || item;
      const values = IngredientMasterExport.values(item, draft);
      if (ingredientPurchaseMasterDrafts.has(item.code) && (
        draft.purchaseUnit && (values[4] === null || values[4] > 1e9)
        || draft.transferUnit && (values[7] === null || values[7] > 1e9))) {
        throw new Error(`${item.code}: ingresa un contenido mayor que 0, expresado en ${item.internalUnit}.`);
      }
      return values;
    });
    const filename = 'maestro-ingredientes';
    if (format === 'xlsx') {
      if (!window.XLSX) throw new Error('No fue posible cargar el generador de archivos Excel.');
      writeConfiguredExcelWorkbook(IngredientMasterExport.workbook(rows, XLSX), `${filename}.xlsx`);
    } else if (format === 'pdf') {
      if (!window.jspdf?.jsPDF) throw new Error('No fue posible cargar el generador de archivos PDF.');
      const context = [document.getElementById('ingredient-purchase-master-search').value.trim() ? 'Tabla filtrada' : '',
        ingredientPurchaseMasterDrafts.size ? 'Incluye cambios sin guardar' : ''].filter(Boolean).join(' · ');
      IngredientMasterExport.pdf(rows, window.jspdf.jsPDF, context).save(`${filename}.pdf`);
    } else if (format === 'csv') {
      const url = URL.createObjectURL(new Blob([IngredientMasterExport.csv(rows, exportDecimalSystem)], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${filename}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setStatus(status, `${rows.length} ${rows.length === 1 ? 'ingrediente exportado' : 'ingredientes exportados'} a ${format.toUpperCase()}.${ingredientPurchaseMasterDrafts.size ? ' Incluye cambios sin guardar.' : ''}`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

function editIngredientPurchaseMaster(event) {
  const row = event.target.closest('tr[data-code]');
  if (!row || !ingredientPurchaseMasterState) return;
  const item = ingredientPurchaseMasterState.items.find(item => item.code === row.dataset.code);
  const purchaseUnit = row.querySelector('.ingredient-master-purchase-unit').value;
  const input = row.querySelector('.ingredient-master-content');
  if (!purchaseUnit) input.value = '';
  input.disabled = !purchaseUnit;
  const transferSelect = row.querySelector('.ingredient-master-transfer-unit');
  let transferUnit = transferSelect.value;
  const transferInput = row.querySelector('.ingredient-master-transfer-content');
  if (!transferUnit) {
    const supply = IngredientMasterExport.values(item, { purchaseUnit, unitsPerPurchaseUnit: purchaseUnit ? input.value : null });
    transferUnit = supply[3]; transferSelect.value = transferUnit;
    transferInput.value = supply[4] ?? '';
  }
  transferInput.disabled = !transferUnit;
  const draft = { code: item.code, internalUnit: item.internalUnit, purchaseUnit,
    unitsPerPurchaseUnit: purchaseUnit ? input.value : null,
    transferUnit, unitsPerTransferUnit: transferUnit ? transferInput.value : null };
  ingredientPurchaseMasterDrafts.set(item.code, draft);
  ingredientMasterEquivalence(row, item, draft);
  document.getElementById('save-ingredient-purchase-master').disabled = false;
}

async function openIngredientPurchaseMaster() {
  const dialog = document.getElementById('ingredient-purchase-master-dialog');
  const status = document.getElementById('ingredient-purchase-master-status');
  const request = ++ingredientPurchaseMasterRequest;
  ingredientPurchaseMasterState = null;
  ingredientPurchaseMasterDrafts.clear();
  document.getElementById('ingredient-purchase-master-search').value = '';
  renderIngredientPurchaseMaster();
  setStatus(status, 'Cargando maestro de ingredientes…');
  dialog.showModal();
  try {
    const data = await apiRequest('/api/purchase-projections/ingredient-master');
    if (request !== ingredientPurchaseMasterRequest || !dialog.open) return;
    ingredientPurchaseMasterState = data;
    renderIngredientPurchaseMaster();
    setStatus(status, `${data.items.length} ingredientes. Abastecimiento para Bodega Principal y transferencia para cafeterías; equivalencias compartidas.`, 'muted');
  } catch (error) {
    if (request === ingredientPurchaseMasterRequest && dialog.open) setStatus(status, error.message, 'error');
  }
}

async function saveIngredientPurchaseMaster() {
  const dialog = document.getElementById('ingredient-purchase-master-dialog');
  const status = document.getElementById('ingredient-purchase-master-status');
  const button = document.getElementById('save-ingredient-purchase-master');
  if (button.disabled || !ingredientPurchaseMasterState) return;
  const items = [...ingredientPurchaseMasterDrafts.values()];
  const invalid = items.find(item => [[item.purchaseUnit, item.unitsPerPurchaseUnit], [item.transferUnit, item.unitsPerTransferUnit]]
    .some(([unit, content]) => unit && (!Number.isFinite(Number(content)) || Number(content) <= 0 || Number(content) > 1e9)));
  if (invalid) {
    setStatus(status, `${invalid.code}: ingresa un contenido mayor que 0, expresado en ${invalid.internalUnit}.`, 'error');
    return;
  }
  dialog.dataset.saving = 'true';
  button.disabled = true;
  document.getElementById('close-ingredient-purchase-master').disabled = true;
  document.getElementById('ingredient-purchase-master-search').disabled = true;
  dialog.querySelectorAll('.ingredient-purchase-master-exports button').forEach(control => { control.disabled = true; });
  dialog.querySelectorAll('tbody input, tbody select').forEach(control => { control.disabled = true; });
  setStatus(status, 'Guardando unidades de abastecimiento y transferencia…');
  try {
    await apiRequest('/api/purchase-projections/ingredient-master', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
    });
    dialog.close();
    ingredientPurchaseMasterDrafts.clear();
    resetPurchaseProjection();
    setStatus(document.getElementById('purchase-projection-status'),
      'Unidades de abastecimiento y transferencia guardadas. Presiona Actualizar para cargar la proyección.', 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    dialog.dataset.saving = 'false';
    document.getElementById('close-ingredient-purchase-master').disabled = false;
    document.getElementById('ingredient-purchase-master-search').disabled = false;
    renderIngredientPurchaseMaster();
  }
}

function resetPurchaseProjection() {
  cancelPurchaseProjectionLoad();
  purchaseProjectionState = null;
  document.getElementById('projection-supplier-filter').replaceChildren(new Option('Todos los proveedores', 'all'));
  document.getElementById('refresh-purchase-projection').disabled = false;
  updateConsumptionReferenceButton();
  renderPurchaseProjection();
  setStatus(document.getElementById('purchase-projection-status'),
    'Presiona Actualizar para cargar la proyección de compras.', 'muted');
}

function projectionLocalMetric(item, field, subtotalField) {
  return formatProjectionMetric(item[field] ?? item[subtotalField] ?? 0);
}

function openProjectionLocalDetail(key, kind, item = purchaseProjectionState?.items.find(candidate => candidate.key === key),
  locationName = purchaseProjectionState?.location.name || 'Ubicación actual') {
  if (!item?.locals) return;
  const inventory = kind === 'inventory';
  const dialog = document.getElementById('projection-local-detail-dialog');
  document.getElementById('projection-local-detail-title').textContent = inventory ? 'Detalle de Inventario Locales' : 'Detalle de Consumo Diario Locales';
  document.getElementById('projection-local-detail-product').textContent = `${item.code} · ${item.name} · Unidad consolidada: ${item.internalUnit}`;
  document.getElementById('projection-local-detail-description').textContent = inventory
    ? 'Suma de los inventarios de todas las cafeterías activas, convertidos a la unidad de consumo del ingrediente. Cuando no hay datos, se considera 0. Se muestra la fecha del último inventario disponible en cada local.'
    : 'Suma del promedio diario utilizado para reposición solo en las cafeterías donde este ingrediente está administrado. Si hay referencia vigente, se usa el mayor entre el promedio propio y el promedio de referencia multiplicado por su porcentaje. Cada promedio utiliza los días de historial disponibles desde la apertura. Los ingredientes no administrados y los valores sin datos aportan 0.';
  const header = document.createElement('tr');
  const labels = inventory
    ? ['Cafetería', 'Inventario de origen', 'Unidad de origen', `Inventario (${item.internalUnit})`, 'Fecha de inventario', 'Observaciones']
    : ['Cafetería', 'Promedio propio', 'Prom Diario Sustitutivo', 'Promedio utilizado', 'Administrado', 'Aporte al total', 'Historial propio', 'Referencia vigente', 'Observaciones'];
  for (const label of labels) {
    const cell = document.createElement('th');
    cell.textContent = label;
    header.appendChild(cell);
  }
  document.getElementById('projection-local-detail-head').replaceChildren(header);
  const metric = value => formatProjectionMetric(value ?? 0);
  document.getElementById('projection-local-detail-body').replaceChildren(...item.locals.map(local => {
    const row = document.createElement('tr');
    row.dataset.locationId = local.locationId;
    const values = inventory
      ? [local.locationName, metric(local.sourceInventory), local.sourceUnit || '—', metric(local.inventory),
        local.inventoryDate ? formatReportDate(local.inventoryDate) : '—', local.inventoryIssue || (local.inventoryIncluded ? 'Incluido' : 'Contado en Inventario Actual')]
      : [local.locationName, metric(local.ownDailyConsumption), local.substituteDailyConsumption === null ? '—' : metric(local.substituteDailyConsumption),
        metric(local.replenishmentDailyConsumption), local.managed ? 'Sí' : 'No', metric(local.dailyConsumption),
        local.consumptionFrom ? `${formatReportDate(local.consumptionFrom)} – ${formatReportDate(local.inventoryDate)} · ${local.consumptionDays} días` : '—',
        local.reference ? `${local.reference.source?.name || 'No disponible'} × ${local.reference.percentage}%` : 'Consumo propio',
        local.consumptionIssue || 'Incluido'];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    return row;
  }));
  const sumTerms = item.locals.filter(local => inventory ? local.inventoryIncluded && local.inventory !== null : local.consumptionIncluded && local.dailyConsumption !== null)
    .map(local => `${formatProjectionMetric(inventory ? local.inventory : local.dailyConsumption)} (${local.locationName})`);
  const complete = inventory ? item.localsInventoryComplete : item.localsConsumptionComplete;
  const subtotal = inventory ? item.localsInventorySubtotal : item.localsDailyConsumptionSubtotal;
  const unit = inventory ? item.internalUnit : `${item.internalUnit}/día`;
  const sum = `${sumTerms.join(' + ') || '0'} = ${formatProjectionMetric(subtotal)} ${unit}${complete ? '' : ' (subtotal; faltan datos)'}.`;
  const coverage = item.coverageUnavailableReason
    ? `Cobertura actual no disponible: ${item.coverageUnavailableReason}`
    : `Cobertura actual = ${formatProjectionMetric(item.totalInventory)} ${item.internalUnit} ÷ ${formatProjectionMetric(item.localsDailyConsumption)} ${item.internalUnit}/día = ${formatProjectionOneDecimal(item.currentCoverageDays)} días.`;
  const total = item.totalInventory === null ? 'Inventario Total no disponible: falta inventario verificable.'
    : `Inventario Total = ${formatProjectionMetric(item.currentInventory)} (${locationName}) + ${formatProjectionMetric(item.localsInventory)} (cafeterías) = ${formatProjectionMetric(item.totalInventory)} ${item.internalUnit}.`;
  document.getElementById('projection-local-detail-calculation').textContent = `${inventory ? 'Inventario Locales' : 'Consumo Diario Locales'} = ${sum}\n${inventory ? `${total}\n` : ''}${coverage}`;
  dialog.showModal();
}

function initializePurchaseProjectionStickyColumns() {
  const table = document.querySelector('.purchase-projection-table');
  const headers = [...table.tHead.rows[0].cells].slice(0, 4);
  const updateOffsets = () => {
    const widths = headers.map(header => header.getBoundingClientRect().width);
    if (widths.some(width => width === 0)) return;
    let offset = 0;
    widths.forEach((width, index) => {
      table.style.setProperty(`--projection-sticky-left-${index + 1}`, `${offset}px`);
      offset += width;
    });
  };
  const observer = new ResizeObserver(updateOffsets);
  headers.forEach(header => observer.observe(header, { box: 'border-box' }));
  updateOffsets();
}

function renderPurchaseProjection() {
  const body = document.getElementById('purchase-projection-body');
  const summary = document.getElementById('purchase-projection-summary');
  const saveButton = document.getElementById('save-projection-policies');
  document.getElementById('show-all-projection-ingredients').disabled = !purchaseProjectionState;
  const newCoverageHeader = document.getElementById('projection-new-coverage-header');
  const reference = purchaseProjectionState?.consumptionReference;
  const showsReference = reference?.active === true;
  const showsLocals = purchaseProjectionState?.localsConsolidation?.available === true;
  const showsOwnDaily = (purchaseProjectionState?.location || locationRegistry[document.getElementById('projection-location-filter').value])?.type !== 'warehouse';
  document.getElementById('projection-own-daily-header').hidden = !showsOwnDaily;
  ['projection-locals-inventory-header', 'projection-total-inventory-header', 'projection-locals-daily-header', 'purchase-projection-locals-description'].forEach(id => {
    document.getElementById(id).hidden = !showsLocals;
  });
  const ownHeader = document.getElementById('projection-own-consumption-header');
  ownHeader.dataset.headerLines = showsReference ? 'Consumo y salidas|propios del período' : 'Consumo y salidas|del período';
  markSortableHeader(ownHeader, 'consumption30', purchaseProjectionSort, ownHeader.dataset.headerLines.replace('|', ' '));
  document.getElementById('projection-reference-daily-header').hidden = !showsReference;
  document.getElementById('projection-used-daily-header').hidden = !showsReference;
  const referenceDescription = document.getElementById('purchase-projection-reference');
  referenceDescription.hidden = !reference?.enabled;
  referenceDescription.textContent = reference?.enabled
    ? `Referencia: ${reference.source?.name || 'Sucursal no disponible'} · ${reference.active ? `${reference.percentage}% vigente (mes ${reference.month})` : reference.status === 'expired' ? 'Regla finalizada; consumo propio' : 'Regla pendiente; consumo propio'} · Apertura: ${reference.openingDate ? formatReportDate(reference.openingDate) : 'Sin configurar'} · Término: ${reference.endsAt ? formatReportDate(reference.endsAt) : 'Sin configurar'}. El promedio sustitutivo aplica el porcentaje vigente al promedio diario de referencia; para reponer se utiliza el mayor entre el promedio propio y el sustitutivo.`
    : '';
  if (!purchaseProjectionState) {
    body.replaceChildren();
    summary.replaceChildren();
    newCoverageHeader.hidden = true;
    saveButton.disabled = true;
    updatePurchaseOrderButton();
    return;
  }
  const data = purchaseProjectionState;
  data.items.forEach(item => Object.assign(item, projectionSuggestionMetrics(item)));
  const showsWarehouseCoverage = data.location.type === 'warehouse';
  newCoverageHeader.hidden = !showsWarehouseCoverage;
  document.querySelectorAll('.purchase-projection-table thead th[data-sort-key]').forEach(cell => {
    markSortableHeader(cell, cell.dataset.sortKey, purchaseProjectionSort, cell.textContent.replace(/ [▲▼]$/, ''));
  });
  const visibleItems = filteredPurchaseProjectionItems();
  const managedItems = data.items.filter(item => item.managed);
  const managedPurchaseItems = managedItems.filter(item => item.needsPurchase);
  const summaryTexts = [
    `${managedItems.length} ítem(s) administrados`,
    `${data.summary.itemCount} ítem(s) disponibles`,
    ...(data.summary.catalogOnlyItemCount ? [`${data.summary.catalogOnlyItemCount} del maestro sin inventario verificable; disponibles para compra manual`] : []),
    `${managedPurchaseItems.length} ítem(s) por comprar`,
    `Compra estimada: ${formatClp(managedItems.reduce((sum, item) => sum + (item.estimatedTotal || 0), 0))}`,
    `${managedPurchaseItems.filter(item => !item.conversionAvailable).length} sin conversión UDC`,
    `${managedPurchaseItems.filter(item => item.estimatedPurchaseUnitCost === null).length} sin costo histórico`,
    `${managedPurchaseItems.filter(item => item.supplierKey === 'unassigned').length} sin proveedor`
  ];
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
    if (item.hasInventoryHistory === false) {
      const note = document.createElement('small'); note.textContent = 'Sin inventario verificable · compra manual';
      row.lastElementChild.appendChild(note);
    }
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
    const purchaseUnitCell = document.createElement('td');
    purchaseUnitCell.textContent = item.purchaseUnit || '—';
    row.appendChild(purchaseUnitCell);
    const purchaseContentCell = document.createElement('td');
    purchaseContentCell.textContent = item.conversionAvailable
      ? `${formatProjectionQuantity(item.unitsPerPurchaseUnit)} ${item.internalUnit}` : 'Sin conversión';
    row.appendChild(purchaseContentCell);
    const packageCell = document.createElement('td');
    const packageInput = document.createElement('input');
    packageInput.type = 'number';
    packageInput.min = '0.0001';
    packageInput.max = '1000000';
    packageInput.step = 'any';
    packageInput.value = item.unitsPerPackage === null ? '' : String(item.unitsPerPackage ?? 1);
    packageInput.className = 'projection-package-input';
    packageInput.setAttribute('aria-label', `Múltiplo mínimo de abastecimiento de ${item.name}`);
    packageInput.title = item.unitsPerPackage === null ? 'Configura la equivalencia de abastecimiento para convertir el múltiplo guardado.'
      : `Las solicitudes deben ser múltiplos de este valor en ${item.purchaseUnit || 'unidades de abastecimiento'}.`;
    packageCell.appendChild(packageInput);
    row.appendChild(packageCell);
    const plainValues = [
      { value: item.hasInventoryHistory === false ? 'Sin inventario verificable'
        : `${formatProjectionMetric(item.currentInventory)} ${item.internalUnit || ''}`.trim(), title: item.currentInventoryBasis },
      ...(showsLocals ? [
        { value: projectionLocalMetric(item, 'localsInventory', 'localsInventorySubtotal'), detail: 'inventory' },
        { value: item.totalInventory === null ? 'Sin datos completos' : formatProjectionMetric(item.totalInventory), title: 'Inventario Actual de bodega + Inventario Locales.' }
      ] : []),
      { value: item.hasInventoryHistory === false ? 'Sin historial' : formatProjectionMetric(item.consumption30), title: `Período propio: ${item.consumptionFrom} · ${item.consumptionDays} días.${item.consumptionBreakdown ? ` Ventas: ${formatProjectionMetric(item.consumptionBreakdown.sales)} · Transferencias salida: ${formatProjectionMetric(item.consumptionBreakdown.transfersOut)} · Transformaciones salida: ${formatProjectionMetric(item.consumptionBreakdown.transformationsOut)} · Compensaciones menos internos: ${formatProjectionMetric(item.consumptionBreakdown.netCompensationsAndInternal)}` : ''}` },
      ...(showsLocals ? [{ value: projectionLocalMetric(item, 'localsDailyConsumption', 'localsDailyConsumptionSubtotal'), detail: 'consumption' }] : []),
      ...(showsOwnDaily ? [{ value: item.hasInventoryHistory === false ? 'Sin historial' : formatProjectionMetric(item.ownAverageDailyConsumption ?? item.averageDailyConsumption), title: `Promedio diario propio sobre ${item.consumptionDays} días de historial disponible. Unidad: ${item.internalUnit}.` }] : []),
      ...(showsReference ? [
        { value: item.projectedAverageDailyConsumption === null ? 'Sin referencia' : formatProjectionMetric(item.projectedAverageDailyConsumption), title: item.referenceIssue || `${reference.source.name}: promedio diario × ${reference.percentage}%. Referencia desde ${item.referenceConsumptionFrom}, ${item.referenceConsumptionDays} días. Unidad: ${item.internalUnit} por día.` },
        { value: formatProjectionMetric(item.averageDailyConsumption), title: `Máximo entre el promedio diario propio y el sustitutivo. Base de cobertura y reposición en ${item.internalUnit} por día.` }
      ] : []),
      {
        value: item.currentCoverageDays === null ? (showsLocals && item.coverageUnavailableReason !== 'Sin consumo diario en las cafeterías.' ? 'Sin datos completos' : 'Sin consumo') : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
        title: showsLocals ? item.coverageUnavailableReason || 'Inventario Total ÷ Consumo Diario Locales.' : '',
        lowCoverage: item.currentCoverageDays !== null && item.currentCoverageDays < item.minDays
      }
    ];
    plainValues.forEach(entry => {
      const cell = document.createElement('td');
      if (entry.detail) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'projection-value-detail';
        button.dataset.localDetail = entry.detail;
        button.textContent = entry.value;
        button.setAttribute('aria-label', `Ver detalle de ${entry.detail === 'inventory' ? 'Inventario Locales' : 'Consumo Diario Locales'} de ${item.name}`);
        cell.appendChild(button);
      } else cell.textContent = entry.value;
      if (entry.title) cell.title=entry.title;
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
    const leadingResultValues = [
      { value: formatSupplySuggestion(item) },
      {
        value: item.suggestedConsumptionQuantity === null ? formatSupplySuggestion(item)
          : `${formatProjectionQuantity(item.suggestedConsumptionQuantity)} ${item.internalUnit || ''}`.trim(),
        className: 'projection-suggested-consumption',
        title: 'Sugerencia de abastecimiento × unidades de consumo por unidad de abastecimiento.'
      },
      {
        value: item.coverageAfterSuggestionDays !== null ? `${formatProjectionOneDecimal(item.coverageAfterSuggestionDays)} días`
          : item.suggestedConsumptionQuantity === null ? formatSupplySuggestion(item)
          : (showsLocals ? item.localsDailyConsumption : item.averageDailyConsumption) === 0 ? 'Sin consumo' : 'Sin datos',
        className: 'projection-suggestion-coverage',
        title: showsLocals ? '(Inventario Total + Sugerencia Un. Consumo) ÷ Consumo Diario Locales.'
          : '(Inventario actual + Sugerencia Un. Consumo) ÷ Promedio diario utilizado para reposición.'
      }
    ];
    leadingResultValues.forEach(entry => {
      const cell = document.createElement('td');
      cell.textContent = entry.value;
      if (entry.className) cell.className = entry.className;
      if (entry.title) cell.title = entry.title;
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
        purchaseOrderCell.title = 'La cantidad ordenada cubre la sugerencia de abastecimiento.';
      } else {
        purchaseOrderCell.classList.add('projection-purchase-order-short');
        purchaseOrderCell.title = 'La cantidad ordenada es menor que la sugerencia de abastecimiento.';
      }
    }
    row.appendChild(purchaseOrderCell);
    if (showsWarehouseCoverage) {
      const newCoverageCell = document.createElement('td');
      newCoverageCell.className = 'projection-new-coverage';
      if (!data.purchaseOrders.selectedOrderCount) {
        newCoverageCell.textContent = '—';
        newCoverageCell.title = 'Selecciona órdenes de compra desde el botón OC.';
      } else if (item.purchaseOrderConversionMissing) {
        newCoverageCell.textContent = 'Sin conversión';
        newCoverageCell.classList.add('projection-purchase-order-warning');
        newCoverageCell.title = 'No fue posible convertir todas las cantidades a la unidad de consumo.';
      } else if (item.coverageAfterPurchaseOrdersDays === null) {
        newCoverageCell.textContent = 'Sin consumo';
        newCoverageCell.title = 'No existe consumo diario para calcular la cobertura.';
      } else {
        newCoverageCell.textContent = `${formatProjectionOneDecimal(item.coverageAfterPurchaseOrdersDays)} días`;
        newCoverageCell.title = 'Inventario actual + OC seleccionadas, dividido por el consumo diario.';
        if (item.coverageAfterPurchaseOrdersDays < item.minDays) {
          newCoverageCell.classList.add('projection-coverage-low');
        }
      }
      row.appendChild(newCoverageCell);
    }
    const trailingResultValues = [
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
    cell.colSpan = document.querySelectorAll('.purchase-projection-table thead th:not([hidden])').length;
    cell.className = 'projection-empty';
    cell.textContent = 'No hay ítems para los filtros seleccionados.';
    row.appendChild(cell);
    body.appendChild(row);
  }
  saveButton.disabled = data.items.length === 0;
  updatePurchaseOrderButton();
}

async function openProjectionPurchaseOrders() {
  const purchaseOrders = purchaseProjectionState?.purchaseOrders;
  if (!purchaseOrders?.available) return;
  const dialog = document.getElementById('projection-purchase-orders-dialog');
  const status = document.getElementById('projection-purchase-orders-status');
  const openButton = document.getElementById('open-projection-purchase-orders');
  document.getElementById('projection-purchase-orders-description').textContent =
    `Selecciona las órdenes emitidas por ${purchaseProjectionState.location.name} que deseas comparar con la sugerencia de abastecimiento.`;
  openButton.disabled = true;
  try {
    const latest = await apiRequest(`/api/purchase-orders?location=${encodeURIComponent(purchaseProjectionState.location.id)}`);
    pastPurchaseOrdersCache.set(purchaseProjectionState.location.id, latest.orders);
    const selectedIds = new Set(purchaseOrders.pendingSelectedOrderIds ?? purchaseOrders.selectedOrderIds);
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

function applyProjectionPurchaseOrders() {
  const purchaseOrderIds = [...document.querySelectorAll('#projection-purchase-orders-body tr[data-order-id]')]
    .filter(row => row.querySelector('.projection-purchase-order-input').checked)
    .map(row => row.dataset.orderId);
  document.getElementById('projection-purchase-orders-dialog').close();
  if (!purchaseProjectionState?.purchaseOrders) return;
  purchaseProjectionState.purchaseOrders.pendingSelectedOrderIds = purchaseOrderIds;
  setStatus(document.getElementById('purchase-projection-status'),
    'Selección de órdenes guardada. Presiona Actualizar para aplicarla a la comparación.', 'success');
}

function cancelPurchaseProjectionLoad() {
  purchaseProjectionLoadSequence += 1;
  purchaseProjectionController?.abort();
  purchaseProjectionController = null;
  clearInterval(purchaseProjectionProgressTimer);
  purchaseProjectionProgressTimer = null;
  document.getElementById('purchase-projection-progress').hidden = true;
  document.getElementById('purchase-projection-workspace').setAttribute('aria-busy', 'false');
  const button = document.getElementById('refresh-purchase-projection');
  button.disabled = false;
  button.textContent = 'Actualizar';
}

function updatePurchaseProjectionProgress(event) {
  const bar = document.getElementById('purchase-projection-progress-bar');
  document.getElementById('purchase-projection-progress-stage').textContent = event.message
    + (event.total > 0 ? ` · ${event.completed} de ${event.total} ${event.unit}` : '');
  if (event.total > 0) bar.value = event.completed / event.total * 100;
  else bar.removeAttribute('value');
}

async function requestPurchaseProjectionWithProgress(query, signal, onProgress) {
  let response;
  try {
    response = await fetch(`/api/purchase-projections?${query}`, { signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw Error('No se pudo conectar con Brewit. Inicia la aplicación con npm start e intenta nuevamente.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Error(data.error || `La solicitud falló (${response.status}).`);
  }
  // Retain compatibility with ordinary JSON responses during a server update.
  if (!response.headers.get('Content-Type')?.includes('application/x-ndjson')) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', result = null;
  const receive = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw Error(event.error || 'No se pudo calcular la proyección de compras.');
    if (event.type === 'progress') onProgress(event);
    if (event.type === 'result') result = event.data;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(receive);
      if (done) break;
    }
    receive(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw Error('La carga se interrumpió. Presiona Actualizar para volver a intentarlo.');
  return result;
}

async function loadPurchaseProjection(options = {}) {
  const status = document.getElementById('purchase-projection-status');
  const button = document.getElementById('refresh-purchase-projection');
  const location = document.getElementById('projection-location-filter').value;
  if (!location) return;
  cancelPurchaseProjectionLoad();
  const sequence = ++purchaseProjectionLoadSequence;
  const controller = new AbortController();
  purchaseProjectionController = controller;
  let completed = false;
  const draftCriteria = options.preserveDraftCriteria && purchaseProjectionState?.location.id === location
    ? new Map(purchaseProjectionState.items.map(item => [item.key, {
      minDays: item.minDays,
      maxDays: item.maxDays,
      unitsPerPackage: item.unitsPerPackage,
      managed: item.managed,
      supplierKey: item.supplierKey
    }]))
    : null;
  const requestedPurchaseOrderIds = Array.isArray(options.purchaseOrderIds)
    ? options.purchaseOrderIds
    : (purchaseProjectionState?.location.id === location && purchaseProjectionState.purchaseOrders?.available
      ? purchaseProjectionState.purchaseOrders.pendingSelectedOrderIds ?? purchaseProjectionState.purchaseOrders.selectedOrderIds : null);
  button.disabled = true;
  button.textContent = 'Actualizando…';
  document.getElementById('purchase-projection-workspace').setAttribute('aria-busy', 'true');
  document.getElementById('purchase-projection-progress').hidden = false;
  updatePurchaseProjectionProgress({ message: 'Iniciando carga de datos…' });
  const started = Date.now();
  const updateElapsed = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    document.getElementById('purchase-projection-progress-elapsed').textContent = `${seconds} s transcurridos`;
  };
  updateElapsed();
  purchaseProjectionProgressTimer = setInterval(updateElapsed, 1000);
  setStatus(status, 'Calculando inventario, consumos y necesidades de compra…');
  try {
    const query = new URLSearchParams({ location, progress: '1' });
    if (requestedPurchaseOrderIds !== null) query.set('orders', requestedPurchaseOrderIds.join(','));
    const data = await requestPurchaseProjectionWithProgress(query, controller.signal, event => {
      if (sequence === purchaseProjectionLoadSequence) updatePurchaseProjectionProgress(event);
    });
    if (sequence !== purchaseProjectionLoadSequence || location !== document.getElementById('projection-location-filter').value) return;
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
    if (Array.isArray(data.purchaseOrders?.savedOrders)) {
      pastPurchaseOrdersCache.set(data.location.id, data.purchaseOrders.savedOrders);
    }
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
      `${options.successMessage ? options.successMessage + ' ' : ''}Consumo considerado: ${formatReportDate(data.period.from)} – ${formatReportDate(data.period.to)}. ${data.consumptionCriteria}.${stale} ${(data.warnings||[]).join(' ')}`,
      stale || data.warnings?.length ? 'muted' : 'success');
    completed = true;
    updateElapsed();
    updatePurchaseProjectionProgress({ message: 'Carga completada', completed: data.items.length, total: data.items.length, unit: 'ingredientes' });
    document.getElementById('purchase-projection-progress-bar').value = 100;
  } catch (error) {
    if (sequence !== purchaseProjectionLoadSequence) return;
    controller.abort();
    purchaseProjectionState = null;
    renderPurchaseProjection();
    setStatus(status, `${options.successMessage ? options.successMessage + ' ' : ''}${error.message}`, 'error');
  } finally {
    if (sequence === purchaseProjectionLoadSequence) {
      clearInterval(purchaseProjectionProgressTimer);
      purchaseProjectionProgressTimer = null;
      purchaseProjectionController = null;
      document.getElementById('purchase-projection-workspace').setAttribute('aria-busy', 'false');
      if (!completed) document.getElementById('purchase-projection-progress').hidden = true;
      button.disabled = false;
      button.textContent = 'Actualizar';
    }
  }
}

async function openCopyProjectionPolicies() {
  const location = document.getElementById('projection-location-filter').value;
  if (!location) return;
  const dialog = document.getElementById('copy-projection-policies-dialog');
  const sourceSelect = document.getElementById('copy-projection-policies-source');
  const button = document.getElementById('confirm-copy-projection-policies');
  const status = document.getElementById('copy-projection-policies-status');
  dialog.dataset.location = location;
  dialog.dataset.locationName = locationRegistry[location]?.name || location;
  document.getElementById('copy-projection-policies-description').textContent = `Ubicación de destino: ${dialog.dataset.locationName}.`;
  sourceSelect.replaceChildren(new Option('Selecciona una cafetería', ''));
  sourceSelect.disabled = true;
  button.disabled = true;
  setStatus(status, 'Consultando criterios guardados…');
  dialog.showModal();
  try {
    const data = await apiRequest(`/api/purchase-projections/policies/sources?location=${encodeURIComponent(location)}`);
    if (!dialog.open || dialog.dataset.location !== location) return;
    sourceSelect.replaceChildren(new Option('Selecciona una cafetería', ''), ...data.sources.map(source => {
      const option = new Option(`${source.name} (${source.itemCount} ítems con criterios guardados)`, source.id);
      option.disabled = source.itemCount === 0;
      option.dataset.name = source.name;
      return option;
    }));
    sourceSelect.disabled = !data.sources.some(source => source.itemCount > 0);
    setStatus(status, sourceSelect.disabled ? 'No hay otra cafetería con criterios guardados. Guarda primero los criterios en la cafetería de origen.' : '', 'muted');
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function copyProjectionPolicies() {
  const dialog = document.getElementById('copy-projection-policies-dialog');
  const sourceSelect = document.getElementById('copy-projection-policies-source');
  const button = document.getElementById('confirm-copy-projection-policies');
  const cancelButton = document.getElementById('cancel-copy-projection-policies');
  const status = document.getElementById('copy-projection-policies-status');
  const location = dialog.dataset.location;
  const sourceLocation = sourceSelect.value;
  if (button.disabled || !sourceLocation) return;
  if (location !== document.getElementById('projection-location-filter').value) {
    return setStatus(status, 'La ubicación seleccionada cambió. Cierra este diálogo y vuelve a abrirlo para el nuevo destino.', 'error');
  }
  const sourceName = sourceSelect.selectedOptions[0].dataset.name;
  if (!window.confirm(`¿Cargar los criterios guardados de ${sourceName} en ${dialog.dataset.locationName}?\n\nSe reemplazarán los proveedores, los múltiplos mínimos de abastecimiento, los días mínimos y máximos y el campo Administrar existentes. Los productos sin criterios en el origen volverán a sus valores predeterminados y quedarán sin administrar. También se descartarán los cambios sin guardar de la proyección actual.\n\n¿Confirmas el reemplazo?`)) return;
  button.disabled = true;
  cancelButton.disabled = true;
  sourceSelect.disabled = true;
  dialog.dataset.copying = 'true';
  setStatus(status, 'Reemplazando criterios…');
  try {
    const result = await apiRequest('/api/purchase-projections/policies/copy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, sourceLocation, confirmed: true })
    });
    dialog.close();
    if (location === document.getElementById('projection-location-filter').value) {
      resetPurchaseProjection();
      setStatus(document.getElementById('purchase-projection-status'),
        `${result.copied} criterios cargados de ${result.source.name} y guardados en ${result.location.name}. Presiona Actualizar para cargar la proyección con estos criterios.`, 'success');
    }
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    dialog.dataset.copying = 'false';
    cancelButton.disabled = false;
    sourceSelect.disabled = false;
    button.disabled = !sourceSelect.value;
  }
}

async function savePurchaseProjectionPolicies() {
  if (!purchaseProjectionState) return;
  const state = purchaseProjectionState;
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
  if (invalid) return setStatus(status, `Revisa los días mínimos, máximos y los múltiplos mínimos de abastecimiento de ${invalid.name}.`, 'error');
  button.disabled = true;
  try {
    const result = await apiRequest('/api/purchase-projections/policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: state.location.id,
        projectionId: state.projectionId,
        items: state.items.map(item => ({
          key: item.key, minDays: item.minDays, maxDays: item.maxDays, unitsPerPackage: item.unitsPerPackage,
          supplierKey: item.supplierKey, managed: item.managed
        }))
      })
    });
    if (purchaseProjectionState !== state) return;
    const clearedCosts = new Set(result.clearedCostKeys || []);
    for (const item of state.items) {
      const supplier = state.suppliers.find(candidate => candidate.key === item.supplierKey);
      if (supplier) {
        item.supplier = supplier.name;
        item.supplierTaxId = supplier.taxId || '';
      }
      if (clearedCosts.has(item.key)) item.estimatedPurchaseUnitCost = null;
      item.unitsPerPackageBasis = 'purchase';
      recalculatePurchaseProjectionItem(item);
    }
    renderPurchaseProjection();
    setStatus(status, 'Criterios de compra guardados correctamente. Se conserva el inventario calculado; presiona Actualizar cuando quieras renovarlo.'
      + (clearedCosts.size ? ' Revisa los costos de los ítems cuyo proveedor cambió.' : ''), 'success');
  } catch (error) {
    if (purchaseProjectionState === state) setStatus(status, error.message, 'error');
  } finally {
    button.disabled = !purchaseProjectionState?.items.length;
  }
}

function purchaseOrderHasChangedCosts() {
  return purchaseOrderEditorState?.items.some(item => item.selected
    && Number(item.unitCost) !== roundedPurchaseOrderCost(item.referenceUnitCost || 0)) || false;
}

function editablePurchaseOrderSupplierItem(item, options = {}) {
  const referenceUnitCost = roundedPurchaseOrderCost(
    item.estimatedPurchaseUnitCost ?? item.referenceUnitCost ?? item.unitCost ?? 0
  );
  const quantity = Number(item.quantity ?? item.suggestedPurchaseUnits ?? 0);
  const unitCost = roundedPurchaseOrderCost(item.unitCost ?? referenceUnitCost);
  const selected = options.selected === true;
  return {
    ...item,
    unitsPerPackage: supplyMultipleFromPolicy(item, item.unitsPerPurchaseUnit, item.purchaseUnit),
    unitsPerPackageBasis: 'purchase',
    referenceUnitCost,
    quantity,
    unitCost,
    selected,
    editorDefaultVisible: options.editorDefaultVisible === true,
    savedSelected: options.savedSelected === true,
    savedQuantity: Number(options.savedQuantity ?? quantity),
    savedUnitCost: roundedPurchaseOrderCost(options.savedUnitCost ?? unitCost)
  };
}

function editableSavedPurchaseOrder(order, supplierItems = []) {
  const availableByKey = new Map(supplierItems.map(item => [item.key, item]));
  const savedKeys = new Set(order.items.map(item => item.key));
  const originals = new Map(order.items.map(item => [item.key, item]));
  const savedItems = (order.editingItems || order.items).map(item => editablePurchaseOrderSupplierItem({
    ...(availableByKey.get(item.key) || {}),
    ...item,
    transferUnitChanged: Boolean(item.transferUnitChanged)
  }, {
    selected: true,
    editorDefaultVisible: true,
    savedSelected: true,
    savedQuantity: originals.get(item.key).quantity,
    savedUnitCost: originals.get(item.key).unitCost
  }));
  const additionalItems = supplierItems
    .filter(item => !savedKeys.has(item.key))
    .map(item => editablePurchaseOrderSupplierItem(item))
    .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  return {
    ...order,
    showAllSupplierItems: false,
    supplierItemsLoaded: false,
    items: [...savedItems, ...additionalItems]
  };
}

function purchaseOrderEditorIsDirty() {
  if (!purchaseOrderEditorState?.id) return true;
  return purchaseOrderEditorState.items.some(item => item.selected !== item.savedSelected
    || item.transferUnitChanged
    || ((item.selected || item.savedSelected)
      && (Math.abs(Number(item.quantity) - Number(item.savedQuantity)) > 0.000001
        || Number(item.unitCost) !== Number(item.savedUnitCost))));
}

function purchaseOrderCoverageMetrics(item) {
  // Use the same inventory and daily demand as the projection, including locals for warehouses.
  const inventory = item.totalInventory === undefined ? item.currentInventory : item.totalInventory;
  const daily = item.localsDailyConsumption === undefined ? item.averageDailyConsumption : item.localsDailyConsumption;
  const currentDays = Number.isFinite(inventory) && Number.isFinite(daily) && daily > 0
    ? inventory / daily : null;
  const addedQuantity = !item.selected ? 0
    : Number.isFinite(item.quantity) && item.quantity >= 0
      && Number.isFinite(item.unitsPerPurchaseUnit) && item.unitsPerPurchaseUnit > 0
      ? item.quantity * item.unitsPerPurchaseUnit : null;
  const afterDays = currentDays !== null && addedQuantity !== null
    ? (inventory + addedQuantity) / daily : null;
  const unavailable = !Number.isFinite(inventory) || !Number.isFinite(daily) ? 'Sin datos'
    : daily <= 0 ? 'Sin consumo' : addedQuantity === null ? 'Sin conversión' : 'Sin datos';
  return { inventory, daily, currentDays, afterDays, unavailable };
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
    const consumptionQuantity = Number.isFinite(item.quantity) && Number.isFinite(item.unitsPerPurchaseUnit)
      && item.unitsPerPurchaseUnit > 0 ? Number((item.quantity * item.unitsPerPurchaseUnit).toPrecision(12)) : null;
    row.querySelector('.purchase-order-consumption-quantity').textContent = consumptionQuantity === null
      ? 'Sin conversión' : `${formatProjectionQuantity(consumptionQuantity)} ${item.internalUnit || ''}`.trim();
    const coverage = purchaseOrderCoverageMetrics(item);
    const coverageCell = row.querySelector('.purchase-order-coverage-after');
    coverageCell.textContent = coverage.afterDays === null ? coverage.unavailable
      : `${formatProjectionOneDecimal(coverage.afterDays)} días`;
    const belowMinimum = coverage.afterDays !== null && Number.isFinite(item.minDays) && coverage.afterDays < item.minDays;
    const aboveMaximum = coverage.afterDays !== null && Number.isFinite(item.maxDays) && coverage.afterDays > item.maxDays;
    coverageCell.classList.toggle('purchase-order-coverage-low', belowMinimum);
    coverageCell.classList.toggle('purchase-order-coverage-high', aboveMaximum);
    const inventoryName = item.totalInventory === undefined ? 'Inventario actual' : 'Inventario Total';
    coverageCell.title = coverage.afterDays === null ? coverage.unavailable
      : `${item.selected ? `(${inventoryName} + cantidad de esta orden en unidades de consumo)` : `${inventoryName} (ítem excluido)`} ÷ promedio diario.`
        + (belowMinimum ? ' Bajo el mínimo.' : aboveMaximum ? ' Sobre el máximo.' : ' Dentro del rango mínimo y máximo.');
    row.querySelector('.purchase-order-row-warning').textContent = [
      changed ? 'Costo modificado' : '', packageWarning,
      item.transferConfigured === false ? 'Configura Unidad de Transferencia a Cafeterías en el maestro' : '',
      item.transferUnitChanged ? 'Convertido a unidad de transferencia; revisa cantidad y costo' : '',
      !item.editorDefaultVisible && item.selected ? 'Ítem adicional' : ''
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
  const showsLocals = state.location.type === 'warehouse' || state.items.some(item => item.localsDailyConsumption !== undefined);
  document.getElementById('purchase-order-locals-inventory-header').hidden = !showsLocals;
  document.getElementById('purchase-order-total-inventory-header').hidden = !showsLocals;
  document.querySelector('.purchase-order-editor-table tfoot td').colSpan = showsLocals ? 18 : 16;
  document.getElementById('purchase-order-coverage-description').textContent =
    `Días con esta orden = (${showsLocals ? 'inventario total' : 'inventario actual'} + compra incluida en unidades de consumo) ÷ promedio diario. Se actualiza al cambiar cantidades o incluir productos. Rojo: bajo el mínimo; naranja: sobre el máximo.`;
  document.getElementById('purchase-order-editor-title').textContent = state.id
    ? `Orden de compra ${state.orderNumber}` : 'Nueva orden de compra';
  document.getElementById('purchase-order-editor-subtitle').textContent =
    `${state.supplier.name}${state.supplier.taxId ? ` · RUT ${state.supplier.taxId}` : ''} · ${state.location.name}`
      + (state.location.type === 'store' ? ' · Unidades de transferencia a cafeterías' : ' · Unidades de abastecimiento');
  document.getElementById('purchase-order-unit-header').textContent = state.location.type === 'store' ? 'Un. de Transferencia' : 'Un. de Abast.';
  document.getElementById('purchase-order-editor-status').textContent = state.id
    ? `Orden guardada. Última actualización: ${new Date(state.updatedAt).toLocaleString('es-CL')}.` :
      'Selecciona los ítems y confirma sus cantidades y costos antes de guardar.';
  const showAll = document.getElementById('purchase-order-show-all-supplier-items');
  const defaultItems = state.items.filter(item => item.editorDefaultVisible || item.selected);
  const visibleItems = state.showAllSupplierItems ? state.items : defaultItems;
  showAll.checked = state.showAllSupplierItems === true;
  showAll.disabled = state.supplierItemsLoading === true
    || (state.supplierItemsLoaded === true && state.items.length <= defaultItems.length);
  document.getElementById('purchase-order-show-all-supplier-items-label').textContent =
    `Mostrar todos los ítems de ${state.supplier.name}`;
  document.getElementById('purchase-order-editor-item-count').textContent =
    `${visibleItems.length} visibles · ${state.items.length} del proveedor`;
  const body = document.getElementById('purchase-order-editor-body');
  body.replaceChildren(...visibleItems.map(item => {
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
    [item.code || '—', item.name]
      .forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
    const coverage = purchaseOrderCoverageMetrics(item);
    const consolidated = item.localsDailyConsumption !== undefined;
    [
      { className: 'purchase-order-daily-consumption', value: Number.isFinite(coverage.daily)
        ? `${formatProjectionQuantity(coverage.daily)} ${item.internalUnit || ''}/día` : 'Sin datos',
        title: consolidated ? 'Consumo diario consolidado de las cafeterías.' : 'Promedio diario utilizado para reposición, incluida la referencia cuando corresponde.' },
      { className: 'purchase-order-inventory', value: Number.isFinite(item.currentInventory)
        ? `${formatProjectionMetric(item.currentInventory)} ${item.internalUnit || ''}`.trim() : 'Sin datos',
        title: 'Inventario actual de esta ubicación en unidades de consumo.' },
      ...(showsLocals ? [
        { className: 'purchase-order-inventory-locals', value: Number.isFinite(item.localsInventory ?? item.localsInventorySubtotal)
          ? formatProjectionMetric(item.localsInventory ?? item.localsInventorySubtotal) : 'Sin datos',
          title: 'Inventario de las cafeterías, convertido a la unidad de consumo del ingrediente.', localDetail: true },
        { className: 'purchase-order-inventory-total', value: Number.isFinite(item.totalInventory)
          ? formatProjectionMetric(item.totalInventory) : 'Sin datos',
          title: 'Inventario actual + inventario de las cafeterías. Base de los días de cobertura.' }
      ] : []),
      { className: 'purchase-order-coverage-current', value: coverage.currentDays === null
        ? (Number.isFinite(coverage.inventory) && Number.isFinite(coverage.daily) && coverage.daily <= 0 ? 'Sin consumo' : 'Sin datos') : `${formatProjectionOneDecimal(coverage.currentDays)} días`,
        title: `${showsLocals ? 'Inventario Total' : 'Inventario actual'} ÷ promedio diario.` },
      { className: 'purchase-order-min-days', value: Number.isFinite(item.minDays) ? `${formatProjectionQuantity(item.minDays)} días` : 'Sin datos' },
      { className: 'purchase-order-max-days', value: Number.isFinite(item.maxDays) ? `${formatProjectionQuantity(item.maxDays)} días` : 'Sin datos' }
    ].forEach(entry => {
      const cell = document.createElement('td');
      cell.className = entry.className;
      if (entry.localDetail && item.locals?.length) {
        const detail = document.createElement('button');
        detail.type = 'button';
        detail.className = 'projection-value-detail';
        detail.textContent = entry.value;
        detail.setAttribute('aria-label', `Ver detalle de Inventario Locales de ${item.name}`);
        detail.addEventListener('click', () => openProjectionLocalDetail(item.key, 'inventory', item, state.location.name));
        cell.appendChild(detail);
      } else cell.textContent = entry.value;
      if (entry.title) cell.title = entry.title;
      row.appendChild(cell);
    });
    const quantityCell = document.createElement('td');
    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = String(item.unitsPerPackage || 0);
    quantity.step = String(item.unitsPerPackage || 'any');
    quantity.value = String(item.quantity ?? 0);
    quantity.className = 'purchase-order-quantity';
    quantity.setAttribute('aria-label', `Cantidad UDA de ${item.name}`);
    const quantityUnit = document.createElement('span');
    quantityUnit.className = 'purchase-order-quantity-unit';
    quantityUnit.textContent = item.transferConfigured === false ? 'Sin configurar' : item.purchaseUnit || '—';
    const quantityControl = document.createElement('div');
    quantityControl.className = 'purchase-order-quantity-control';
    quantityControl.append(quantity, quantityUnit);
    quantityCell.appendChild(quantityControl);
    row.appendChild(quantityCell);
    const coverageCell = document.createElement('td');
    coverageCell.className = 'purchase-order-coverage-after';
    row.appendChild(coverageCell);
    [item.transferConfigured === false ? 'Sin configurar' : item.purchaseUnit || '—',
      item.unitsPerPurchaseUnit == null ? 'Sin conversión'
        : `${formatProjectionQuantity(item.unitsPerPurchaseUnit)} ${item.internalUnit || ''} por ${item.purchaseUnit || 'Un. de Abast.'}`.trim(),
      formatProjectionQuantity(item.unitsPerPackage || 1),
      item.suggestedPurchaseUnits == null ? '—' : formatProjectionQuantity(item.suggestedPurchaseUnits)]
      .forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
    const consumptionCell = document.createElement('td');
    consumptionCell.className = 'purchase-order-consumption-quantity';
    row.appendChild(consumptionCell);
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
  const visibleKeys = new Set(visibleItems.map(item => item.key));
  const supplierItems = data.items.filter(item => item.supplierKey === supplierKey);
  purchaseOrderEditorState = {
    id: null,
    orderNumber: null,
    location: data.location,
    supplier,
    projectionPeriod: data.period,
    projectionId: data.projectionId,
    filters: {
      onlyRequired: document.getElementById('projection-only-required').checked,
      onlyManaged: document.getElementById('projection-only-managed').checked,
      selectedPurchaseOrderIds: data.purchaseOrders?.selectedOrderIds || []
    },
    showAllSupplierItems: false,
    items: supplierItems.map(item => editablePurchaseOrderSupplierItem(item, {
      selected: visibleKeys.has(item.key) && Number(item.suggestedPurchaseUnits || 0) > 0,
      editorDefaultVisible: visibleKeys.has(item.key)
    }))
  };
  renderPurchaseOrderEditor();
  document.getElementById('purchase-order-editor-dialog').showModal();
}

async function confirmPurchaseOrder() {
  if (!purchaseOrderEditorState) return;
  const button = document.getElementById('confirm-purchase-order');
  if (button.disabled) return;
  updatePurchaseOrderEditorTotals();
  const status = document.getElementById('purchase-order-editor-status');
  const selected = purchaseOrderEditorState.items.filter(item => item.selected);
  if (!selected.length) return setStatus(status, 'Selecciona al menos un ítem para guardar la orden.', 'error');
  const missingTransfer = selected.find(item => item.transferConfigured === false);
  if (missingTransfer) return setStatus(status, `${missingTransfer.name}: configura la Unidad de Transferencia a Cafeterías y su equivalencia en el Maestro de ingredientes.`, 'error');
  if (selected.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitCost) || item.unitCost < 0)) {
    return setStatus(status, 'Todos los ítems incluidos deben tener cantidad mayor que cero y un costo válido.', 'error');
  }
  const invalidMultiple = selected.find(item => !isSupplyMultiple(item.quantity, item.unitsPerPackage));
  if (invalidMultiple) return setStatus(status, `${invalidMultiple.name}: ${purchaseQuantityPackageWarning(invalidMultiple, invalidMultiple.quantity)}`, 'error');
  if (purchaseOrderHasChangedCosts() && !window.confirm('Modificaste uno o más costos respecto de la estimación. ¿Confirmas que deseas guardar la orden con estos nuevos costos?')) return;
  button.disabled = true;
  button.textContent = 'Guardando orden…';
  setStatus(status, 'Guardando orden…');
  try {
    const existing = purchaseOrderEditorState.id;
    const payload = {
      location: purchaseOrderEditorState.location.id,
      supplierKey: purchaseOrderEditorState.supplier.key,
      projectionId: purchaseOrderEditorState.projectionId,
      useTransferUnits: purchaseOrderEditorState.location.type === 'store',
      filters: purchaseOrderEditorState.filters,
      items: selected.map(item => ({ key: item.key, quantity: item.quantity, unitCost: item.unitCost,
        purchaseUnit: item.purchaseUnit, unitsPerPurchaseUnit: item.unitsPerPurchaseUnit, internalUnit: item.internalUnit }))
    };
    const saved = await apiRequest(existing ? `/api/purchase-orders/${encodeURIComponent(existing)}` : '/api/purchase-orders', {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const supplierItems = purchaseOrderEditorState.items;
    rememberSavedPurchaseOrder(saved);
    purchaseOrderEditorState = { ...editableSavedPurchaseOrder(saved, supplierItems),
      projectionId: purchaseOrderEditorState.projectionId, supplierItemsLoaded: purchaseOrderEditorState.supplierItemsLoaded };
    renderPurchaseOrderEditor();
    setStatus(status, `Orden ${saved.orderNumber} guardada correctamente. Ya puedes imprimirla o volver a modificarla.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Confirmar y guardar orden';
  }
}

function printPurchaseOrder(order = purchaseOrderEditorState) {
  if (!order?.id || !order.items?.length) return;
  const printableItems = order.items.filter(item => item.selected !== false && Number(item.quantity) > 0);
  if (!printableItems.length) return;
  const printableTotal = printableItems.reduce((total, item) =>
    total + (Number(item.quantity) * Number(item.unitCost) || 0), 0);
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
  table.innerHTML = '<thead><tr><th>Código</th><th>Producto / ingrediente</th><th>Cantidad UDA</th><th>Un. de Abast.</th><th>Cantidad Un. de Cons.</th><th>Costo UDA</th><th>Total</th></tr></thead>';
  const body = document.createElement('tbody');
  printableItems.forEach(item => {
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
  totalRow.innerHTML = `<td colspan="6">TOTAL ORDEN</td><td>${formatClp(printableTotal)}</td>`;
  footer.appendChild(totalRow);
  table.append(body, footer);
  const note = document.createElement('p');
  note.className = 'purchase-order-note';
  note.textContent = printableItems.some(item => item.costModified)
    ? 'Esta orden contiene costos modificados manualmente respecto de la estimación original. Verificar impuestos y condiciones comerciales antes de enviarla.'
    : 'Verificar disponibilidad, impuestos y condiciones comerciales antes de enviar la orden al proveedor.';
  documentSection.replaceChildren(heading, supplierBlock, table, note);
  documentSection.hidden = false;
  const previousTitle = document.title;
  document.title = `${order.orderNumber} - ${order.supplier.name} - ${order.location.name}`;
  document.body.classList.add('printing-purchase-order');
  try {
    window.print();
  } finally {
    document.body.classList.remove('printing-purchase-order');
    documentSection.hidden = true;
    document.title = previousTitle;
  }
}

function rememberSavedPurchaseOrder(order) {
  pastPurchaseOrdersRequestSequence += 1;
  const cached = pastPurchaseOrdersCache.get(order.location.id);
  if (!cached) return;
  const { items, ...metadata } = order;
  pastPurchaseOrdersCache.set(order.location.id, [
    { ...metadata, itemCount: items.length }, ...cached.filter(item => item.id !== order.id)
  ]);
}

function renderPastPurchaseOrders(orders) {
  const list = document.getElementById('past-purchase-orders-list');
  const status = document.getElementById('past-purchase-orders-status');
  list.replaceChildren();
  const hiddenCount = orders.filter(order => order.hidden).length;
  const showHidden = document.getElementById('show-hidden-purchase-orders').checked;
  const displayedOrders = orders.filter(order => showHidden || !order.hidden)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (!orders.length) {
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
}

async function openPastPurchaseOrders() {
  const dialog = document.getElementById('past-purchase-orders-dialog');
  const status = document.getElementById('past-purchase-orders-status');
  const location = document.getElementById('projection-location-filter').value;
  const sequence = ++pastPurchaseOrdersRequestSequence;
  if (!dialog.open) dialog.showModal();
  const projected = purchaseProjectionState?.location.id === location
    ? purchaseProjectionState.purchaseOrders?.savedOrders : null;
  if (!pastPurchaseOrdersCache.has(location) && Array.isArray(projected)) {
    pastPurchaseOrdersCache.set(location, projected);
  }
  const cached = pastPurchaseOrdersCache.get(location);
  if (cached) renderPastPurchaseOrders(cached);
  else {
    document.getElementById('past-purchase-orders-list').replaceChildren();
    setStatus(status, 'Cargando órdenes guardadas…');
  }
  try {
    const data = await apiRequest(`/api/purchase-orders?location=${encodeURIComponent(location)}`);
    if (sequence !== pastPurchaseOrdersRequestSequence) return;
    pastPurchaseOrdersCache.set(location, data.orders);
    if (dialog.open && document.getElementById('projection-location-filter').value === location) {
      renderPastPurchaseOrders(data.orders);
    }
  } catch (error) {
    if (sequence === pastPurchaseOrdersRequestSequence && dialog.open) {
      setStatus(status, cached ? `Mostrando la última lista disponible. No se pudo comprobar si hay cambios: ${error.message}` : error.message, 'error');
    }
  }
}

async function setPurchaseOrderVisibility(orderId, orderNumber, hidden) {
  const status = document.getElementById('past-purchase-orders-status');
  try {
    const updated = await apiRequest(`/api/purchase-orders/${encodeURIComponent(orderId)}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden })
    });
    pastPurchaseOrdersRequestSequence += 1;
    const cached = pastPurchaseOrdersCache.get(updated.location.id);
    if (cached) pastPurchaseOrdersCache.set(updated.location.id, cached.map(order => order.id === orderId ? updated : order));
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
    pastPurchaseOrdersRequestSequence += 1;
    for (const [location, orders] of pastPurchaseOrdersCache) {
      pastPurchaseOrdersCache.set(location, orders.filter(order => order.id !== orderId));
    }
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
    const projection = purchaseProjectionState?.location.id === order.location.id ? purchaseProjectionState : null;
    const supplierItems = projection?.items.filter(item => item.supplierKey === order.supplier.key) || [];
    const projectionId = projection?.projectionId;
    document.getElementById('past-purchase-orders-dialog').close();
    purchaseOrderEditorState = { ...editableSavedPurchaseOrder(order, supplierItems), projectionId };
    renderPurchaseOrderEditor();
    document.getElementById('purchase-order-editor-dialog').showModal();
  } catch (error) {
    setStatus(status, error.message, 'error');
  }
}

async function showAllPurchaseOrderSupplierItems(checked) {
  const state = purchaseOrderEditorState;
  if (!state || state.supplierItemsLoading) return;
  updatePurchaseOrderEditorTotals();
  state.showAllSupplierItems = checked;
  if (!checked || state.supplierItemsLoaded) return renderPurchaseOrderEditor();
  state.supplierItemsLoading = true;
  renderPurchaseOrderEditor();
  const confirm = document.getElementById('confirm-purchase-order');
  confirm.disabled = true;
  const status = document.getElementById('purchase-order-editor-status');
  setStatus(status, 'Cargando todos los artículos del proveedor…');
  let errorMessage = null;
  try {
    const params = new URLSearchParams({ location: state.location.id, supplier: state.supplier.key });
    if (state.projectionId) params.set('projectionId', state.projectionId);
    const data = await apiRequest(`/api/purchase-projections/supplier-items?${params}`);
    if (purchaseOrderEditorState !== state || !document.getElementById('purchase-order-editor-dialog').open) return;
    updatePurchaseOrderEditorTotals();
    const known = new Set(state.items.map(item => item.key));
    state.items.push(...data.items.filter(item => !known.has(item.key)).map(item => editablePurchaseOrderSupplierItem(item)));
    state.projectionId = data.projectionId;
    state.supplierItemsLoaded = true;
  } catch (error) {
    state.showAllSupplierItems = false;
    errorMessage = error.message;
  } finally {
    state.supplierItemsLoading = false;
    if (purchaseOrderEditorState === state && document.getElementById('purchase-order-editor-dialog').open) {
      renderPurchaseOrderEditor(); confirm.disabled = false;
      if (errorMessage) setStatus(status, errorMessage, 'error');
      else if (state.items.every(item => item.editorDefaultVisible || item.selected)) {
        setStatus(status, 'Todos los artículos disponibles del proveedor ya están en la orden.', 'muted');
      }
    }
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
      otherItems: projection.items.filter(item => item.supplierKey === supplierKey && !buying.some(buy => buy.key === item.key)).map(item => ({
        ...item,
        noPurchaseReason: item.managed ? tentativeNoPurchaseReason(item) : 'No está marcado como administrado; puedes agregarlo manualmente.'
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

function tentativeItemIssues(item) {
  const issues = [];
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) issues.push('Ingresa una cantidad mayor que 0 o desmarca Incluir.');
  else if (!isSupplyMultiple(item.quantity, item.unitsPerPackage)) issues.push(purchaseQuantityPackageWarning(item, item.quantity));
  if (!Number.isFinite(item.unitCost) || item.unitCost < 0) issues.push('Ingresa un costo válido, mayor o igual que 0.');
  if (item.transferConfigured === false) issues.push('Configura la Unidad de Transferencia a Cafeterías y su equivalencia en el Maestro de ingredientes.');
  else if (!(item.unitsPerPurchaseUnit > 0)) issues.push('Falta la equivalencia en unidades de consumo; revísala en el Maestro de ingredientes.');
  return issues;
}

function tentativeOrderIssues(group) {
  if (!group) return [];
  const issues = [];
  const selected = group.buyingItems.filter(item => item.selected);
  if (group.supplier.key === 'unassigned') issues.push('Asigna un proveedor antes de confirmar la orden.');
  if (!selected.length) issues.push('Incluye al menos un producto.');
  for (const item of selected) for (const issue of tentativeItemIssues(item)) issues.push(`${item.code || item.key} · ${item.name}: ${issue}`);
  return issues;
}

function updateTentativeOrderTotals() {
  const group = currentTentativeOrderGroup();
  if (!group) {
    document.getElementById('tentative-order-total').textContent = '$0';
    document.getElementById('confirm-tentative-purchase-order').disabled = true;
    document.getElementById('tentative-order-validation').replaceChildren();
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
    const issues = item.selected ? tentativeItemIssues(item) : [];
    warnings.push(...issues);
    const quantityInvalid = item.selected && (!(item.quantity > 0) || !isSupplyMultiple(item.quantity, item.unitsPerPackage));
    row.querySelector('.tentative-order-quantity').setAttribute('aria-invalid', String(quantityInvalid));
    row.querySelector('.tentative-order-cost').setAttribute('aria-invalid', String(item.selected && (!Number.isFinite(item.unitCost) || item.unitCost < 0)));
    row.querySelector('.tentative-order-row-warning').textContent = warnings.join(' · ');
    row.classList.toggle('purchase-order-package-warning', quantityInvalid);
    row.classList.toggle('purchase-order-row-excluded', !item.selected);
    total += item.total;
  }
  document.getElementById('tentative-order-total').textContent = formatClp(total);
  const selected = group.buyingItems.filter(item => item.selected);
  const summaryChips = document.querySelectorAll('#tentative-orders-summary .chip');
  if (summaryChips[1]) summaryChips[1].textContent = `${selected.length} incluido(s)`;
  const issues = tentativeOrderIssues(group);
  const validation = document.getElementById('tentative-order-validation');
  validation.replaceChildren();
  if (!group.confirmedOrder && issues.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Para confirmar esta orden:';
    const list = document.createElement('ul');
    for (const message of issues) { const li = document.createElement('li'); li.textContent = message; list.append(li); }
    validation.append(heading, list);
  }
  validation.hidden = Boolean(group.confirmedOrder) || !issues.length;
  document.getElementById('confirm-tentative-purchase-order').disabled = Boolean(group.confirmedOrder)
    || Boolean(group.confirming || group.supplierItemsLoading) || issues.length > 0;
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
  const loadButton = document.getElementById('load-tentative-supplier-items');
  loadButton.disabled = Boolean(group.confirmedOrder || group.confirming || group.supplierItemsLoading || group.supplierItemsLoaded)
    || group.supplier.key === 'unassigned';
  loadButton.textContent = group.supplierItemsLoading ? 'Cargando productos…'
    : group.supplierItemsLoaded ? 'Productos del proveedor cargados' : 'Cargar todos los productos del proveedor';
  setStatus(document.getElementById('tentative-supplier-items-status'), group.supplierItemsError || '', group.supplierItemsError ? 'error' : '');
  summary.replaceChildren(...[
    `${group.buyingItems.length} ítem(s) en la propuesta`,
    `${selectedCount} incluido(s)`,
    `${group.otherItems.length} otros productos`
  ].map(text => {
    const chip = document.createElement('span');
    chip.className = 'chip neutral';
    chip.textContent = text;
    return chip;
  }));
  document.getElementById('tentative-order-heading').textContent = `${location.name} · ${group.supplier.name}`;
  const disabled = Boolean(group.confirmedOrder || group.confirming);
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
      !Number.isFinite(item.currentCoverageDays) ? 'Sin datos' : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
      item.addedManually ? 'Agregado manualmente' : formatSupplySuggestion(item),
      formatProjectionQuantity(item.unitsPerPackage || 1),
      item.transferConfigured === false ? 'Sin configurar' : item.purchaseUnit || '—',
      item.conversionAvailable ? formatProjectionQuantity(item.unitsPerPurchaseUnit) : 'Sin conversión'
    ].forEach(value => {
      const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
    });
    const quantityCell = document.createElement('td');
    const quantity = document.createElement('input');
    quantity.type = 'number'; quantity.min = String(item.unitsPerPackage || 0); quantity.step = String(item.unitsPerPackage || 'any'); quantity.value = String(item.quantity);
    quantity.className = 'tentative-order-quantity'; quantity.disabled = disabled;
    quantity.setAttribute('aria-label', `Cantidad UDA de ${item.name}`);
    quantityCell.appendChild(quantity); row.appendChild(quantityCell);
    const costCell = document.createElement('td');
    const cost = document.createElement('input');
    cost.type = 'text'; cost.inputMode = 'numeric'; cost.value = formatPurchaseOrderCost(item.unitCost);
    cost.className = 'tentative-order-cost'; cost.disabled = disabled;
    cost.setAttribute('aria-label', `Costo UDA de ${item.name}`);
    costCell.appendChild(cost); row.appendChild(costCell);
    const totalCell = document.createElement('td'); totalCell.className = 'tentative-order-row-total'; row.appendChild(totalCell);
    const warningCell = document.createElement('td'); warningCell.className = 'tentative-order-row-warning'; row.appendChild(warningCell);
    return row;
  }));
  const otherBody = document.getElementById('tentative-orders-other-body');
  if (!group.otherItems.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td'); cell.colSpan = 9; cell.textContent = 'No hay otros productos en la lista. Puedes consultar todos los productos del proveedor.';
    row.appendChild(cell); otherBody.replaceChildren(row);
  } else {
    otherBody.replaceChildren(...group.otherItems.map(item => {
      const row = document.createElement('tr');
      [
        item.code || '—', item.name, item.internalUnit || '—', formatProjectionMetric(item.currentInventory),
        !Number.isFinite(item.currentCoverageDays) ? 'Sin datos' : `${formatProjectionOneDecimal(item.currentCoverageDays)} días`,
        formatProjectionOneDecimal(item.minDays), formatProjectionOneDecimal(item.maxDays), item.noPurchaseReason
      ].forEach(value => {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      });
      const action = document.createElement('td'), add = document.createElement('button');
      add.type = 'button'; add.className = 'icon-button small'; add.dataset.tentativeAdd = item.key;
      add.textContent = 'Agregar'; add.disabled = disabled || Boolean(group.supplierItemsLoading);
      add.setAttribute('aria-label', `Agregar ${item.name} a la orden`);
      action.append(add); row.append(action);
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

function addTentativeSupplierItem(key) {
  const group = currentTentativeOrderGroup();
  if (!group || group.confirmedOrder || group.confirming || group.supplierItemsLoading) return;
  updateTentativeOrderTotals();
  const index = group.otherItems.findIndex(item => item.key === key);
  if (index < 0) return;
  const item = group.otherItems.splice(index, 1)[0];
  const unitCost = roundedPurchaseOrderCost(item.estimatedPurchaseUnitCost ?? 0);
  const quantity = Number.isFinite(item.unitsPerPackage) && item.unitsPerPackage > 0 ? item.unitsPerPackage : 1;
  group.buyingItems.push({ ...item, addedManually: true, selected: true, quantity, unitCost,
    conversionAvailable: Number.isFinite(item.unitsPerPurchaseUnit) && item.unitsPerPurchaseUnit > 0,
    referenceUnitCost: unitCost, total: quantity * unitCost });
  renderTentativePurchaseOrderReview();
}

async function loadTentativeSupplierItems() {
  const state = tentativePurchaseOrdersState, group = currentTentativeOrderGroup();
  const location = state?.locations.find(item => item.id === document.getElementById('tentative-orders-location').value);
  if (!group || !location || group.confirmedOrder || group.confirming || group.supplierItemsLoading) return;
  updateTentativeOrderTotals();
  group.supplierItemsLoading = true; group.supplierItemsError = null;
  renderTentativePurchaseOrderReview();
  try {
    const params = new URLSearchParams({ location: location.id, supplier: group.supplier.key });
    const projectionId = group.projectionId || location.projectionId;
    if (projectionId) params.set('projectionId', projectionId);
    const data = await apiRequest(`/api/purchase-projections/supplier-items?${params}`);
    if (tentativePurchaseOrdersState !== state || !state.locations.includes(location) || !location.groups.includes(group)) return;
    const known = new Set([...group.buyingItems, ...group.otherItems].map(item => item.key));
    group.otherItems.push(...data.items.filter(item => !known.has(item.key)).map(item => ({ ...item,
      conversionAvailable: Number.isFinite(item.unitsPerPurchaseUnit) && item.unitsPerPurchaseUnit > 0,
      noPurchaseReason: 'Disponible para agregar manualmente; no forma parte de la sugerencia inicial.' })));
    group.otherItems.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    group.projectionId = data.projectionId; group.supplierItemsLoaded = true;
  } catch (error) { group.supplierItemsError = error.message; }
  finally {
    group.supplierItemsLoading = false;
    if (tentativePurchaseOrdersState === state && currentTentativeOrderGroup() === group) renderTentativePurchaseOrderReview();
  }
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
        projectionId: projection.projectionId,
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
  if (!group || !location || group.confirmedOrder || group.confirming || group.supplierItemsLoading) return;
  updateTentativeOrderTotals();
  const selected = group.buyingItems.filter(item => item.selected);
  const issues = tentativeOrderIssues(group);
  if (issues.length) return setStatus(status, 'Revisa los productos indicados junto al botón de confirmación.', 'error');
  if (selected.some(item => item.unitCost !== item.referenceUnitCost)
    && !window.confirm('Modificaste uno o más costos respecto de la estimación. ¿Confirmas que deseas guardar la orden?')) return;
  const button = document.getElementById('confirm-tentative-purchase-order');
  group.confirming = true;
  renderTentativePurchaseOrderReview();
  button.disabled = true;
  setStatus(status, 'Guardando orden definitiva…');
  try {
    const saved = await apiRequest('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: location.id,
        supplierKey: group.supplier.key,
        projectionId: group.projectionId || location.projectionId,
        useTransferUnits: location.type === 'store',
        filters: { onlyRequired: selected.every(item => !item.addedManually), onlyManaged: selected.every(item => item.managed) },
        items: selected.map(item => ({ key: item.key, quantity: item.quantity, unitCost: item.unitCost,
          purchaseUnit: item.purchaseUnit, unitsPerPurchaseUnit: item.unitsPerPurchaseUnit, internalUnit: item.internalUnit }))
      })
    });
    rememberSavedPurchaseOrder(saved);
    group.confirmedOrder = saved;
    setStatus(status, `Orden tentativa confirmada y guardada como ${saved.orderNumber}.`, 'success');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    group.confirming = false;
    renderTentativePurchaseOrderReview();
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
  document.getElementById('process-original-inventory-report').disabled = !location;
  const status = document.getElementById('inventory-source-status');
  const list = document.getElementById('inventory-source-list');
  const currentButton = document.getElementById('current-inventory-report');
  if (!location) {
    inventorySourceState = null;
    list.replaceChildren();
    currentButton.disabled = true;
    return setStatus(status, 'No hay ubicaciones activas disponibles.', 'muted');
  }
  setStatus(status, 'Consultando las fuentes sincronizadas…');
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
        if (['waste', 'marketing', 'employees', 'calibrations'].includes(source.field) && source.applicable) {
          const summary = document.createElement('button');
          summary.type = 'button';
          summary.className = 'primary small';
          const summaryNames = {
            waste: 'Ver resumen merma',
            marketing: 'Ver resumen marketing',
            employees: 'Ver resumen colaboradores', calibrations: 'Ver resumen calibraciones y bebidas desechadas'
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
        download.textContent = 'Exportar datos';
        actions.append(preview, download);
        if (source.applicable && ['marketing', 'employees', 'calibrations'].includes(source.field)) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'delete-button small';
          remove.textContent = 'Eliminar todos los datos';
          remove.setAttribute('aria-label', `Eliminar todos los datos de ${source.label}`);
          remove.addEventListener('click', () => openTransactionDeleteDialog(source.field, { latest: source.file, fileCount: source.file.fileCount }, {
            location, source: 'inventory', allOnly: true
          }));
          actions.appendChild(remove);
        }
      }
      card.append(name, details, actions);
      return card;
    }));
    currentButton.disabled = !data.kardexPeriod;
    document.getElementById('inventory-process-note').textContent = data.ready
      ? data.kardexPeriod
        ? 'Selecciona las fechas de inventario inicial y final; los movimientos se calculan automáticamente hasta el día anterior al cierre.'
        : `No fue posible interpretar las fechas del Kardex: ${data.kardexError || 'estructura no reconocida'}.`
      : 'Faltan fuentes sincronizadas. Actualízalas en Datos y sincronización antes de procesar el informe.';
    setStatus(status, data.ready
      ? 'La ubicación tiene todas las fuentes requeridas disponibles.'
      : 'La ubicación todavía no tiene todas las fuentes requeridas.', data.ready ? 'success' : 'muted');
  } catch (error) {
    inventorySourceState = null;
    list.replaceChildren();
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
  return browserIsoToday(date);
}

function inventoryDefaultPeriod() {
  const today = browserIsoToday();
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const currentMonday = offsetIsoDate(today, -((weekday + 6) % 7));
  return {
    previousMonday: offsetIsoDate(currentMonday, -7),
    previousSunday: offsetIsoDate(currentMonday, -1),
    currentMonday
  };
}

const inventoryProcessingMode = 'originals';
let inventoryProcessedProvenance = null;
let originalInventoryDates = [];
function processingInventoryDates() { return originalInventoryDates; }
function constrainInventoryDateInput(input) {
  const dates = processingInventoryDates();
  input.min = dates[0] || '';
  input.max = dates.at(-1) || '';
}

let inventoryCalendarData = null;
const inventoryCalendarMonths = {};
function syncInventoryBoundaries() {
  const initial=document.getElementById('inventory-initial-date').value;
  const final=document.getElementById('inventory-final-date').value;
  document.getElementById('inventory-movement-from').value=initial;
  document.getElementById('inventory-movement-to').value=final?offsetIsoDate(final,-1):'';
  for(const kind of ['initial','final'])renderInventoryCalendar(kind);
}
function renderInventoryCalendar(kind) {
  const input=document.getElementById(`inventory-${kind}-date`),container=document.getElementById(`inventory-${kind}-calendar`);
  if(!inventoryCalendarData)return;
  const month=inventoryCalendarMonths[kind] || (input.value || inventoryCalendarData.from).slice(0,7);
  inventoryCalendarMonths[kind]=month;
  const header=document.createElement('div');header.className='inventory-calendar-head';
  const title=document.createElement('strong');title.textContent=new Intl.DateTimeFormat('es-CL',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T12:00:00Z'));
  for(const direction of [-1,1]) {
    const button=document.createElement('button');button.type='button';button.textContent=direction<0?'‹':'›';button.setAttribute('aria-label',`${direction<0?'Mes anterior':'Mes siguiente'} del inventario ${kind==='initial'?'inicial':'final'}`);
    button.addEventListener('click',()=>{const date=new Date(month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+direction);inventoryCalendarMonths[kind]=date.toISOString().slice(0,7);renderInventoryCalendar(kind);});
    if(direction<0)header.append(button,title);else header.append(button);
  }
  const grid=document.createElement('div');grid.className='inventory-calendar-grid';
  for(const weekday of ['Lu','Ma','Mi','Ju','Vi','Sá','Do']){const label=document.createElement('span');label.textContent=weekday;grid.append(label);}
  const first=new Date(month+'-01T12:00:00Z'),offset=(first.getUTCDay()+6)%7;
  const countDates=new Set(inventoryCalendarData.countDates);
  for(let i=0;i<42;i++) {
    const date=offsetIsoDate(month+'-01',i-offset),button=document.createElement('button');button.type='button';button.textContent=String(Number(date.slice(-2)));button.dataset.date=date;
    const physical=countDates.has(date);button.className=physical?'has-physical-count':'';
    if(date===input.value)button.classList.add('selected');
    button.disabled=date<inventoryCalendarData.from||date>inventoryCalendarData.to||date.slice(0,7)!==month;
    button.setAttribute('aria-label',`${date}${physical?' · toma física registrada':' · sin toma física'}`);button.setAttribute('aria-pressed',String(date===input.value));
    button.title=physical?'Toma física registrada (puede incluir solo parte de los productos)':'Saldo teórico si no hay toma física';
    button.addEventListener('click',()=>{input.value=date;syncInventoryBoundaries();});grid.append(button);
  }
  container.replaceChildren(header,grid);
}
async function openInventoryProcessDialog() {
  const location=document.getElementById('inventory-location-select').value;
  try {
    const calendar=await apiRequest(`/api/inventory/calendar?location=${encodeURIComponent(location)}&source=${inventoryProcessingMode}`);
    if(location!==document.getElementById('inventory-location-select').value)return;
    inventoryCalendarData=calendar;
    originalInventoryDates=[];for(let date=calendar.from;date<=calendar.to;date=offsetIsoDate(date,1))originalInventoryDates.push(date);
    const defaults=inventoryDefaultPeriod();
    const initial=document.getElementById('inventory-initial-date'),final=document.getElementById('inventory-final-date');
    for(const input of [initial,final]){input.min=calendar.from;input.max=calendar.to;}
    initial.value=defaults.previousMonday>=calendar.from&&defaults.previousMonday<calendar.to?defaults.previousMonday:calendar.from;
    final.value=defaults.currentMonday>initial.value&&defaults.currentMonday<=calendar.to?defaults.currentMonday:calendar.to;
    for(const kind of ['initial','final']) {
      inventoryCalendarMonths[kind]=document.getElementById(`inventory-${kind}-date`).value.slice(0,7);
      document.getElementById(`inventory-${kind}-basis`).value='initial';
      document.getElementById(`inventory-${kind}-basis`).closest('label').hidden=true;
    }
    syncInventoryBoundaries();
    document.getElementById('inventory-process-source').textContent=`Inventario API Toteat. Recuadro: fecha con toma física. Sin toma al inicio, se reconstruye desde una toma anterior; sin toma al final, solo se informa saldo teórico.`;
    document.getElementById('confirm-inventory-process').textContent = calendar.requiresRebuild ? 'Recalcular y procesar' : 'Confirmar y procesar';
    setStatus(document.getElementById('inventory-process-dialog-status'), calendar.requiresRebuild
      ? 'El inventario calculado corresponde a una versión anterior de los datos o de las reglas de cálculo. Pulsa «Recalcular y procesar» para generar el informe con los datos ya guardados.' : '', 'muted');
    document.getElementById('inventory-process-dialog').showModal();
  }catch(error){setStatus(document.getElementById('inventory-source-status'),error.message,'error');}
}

function openSourceSummaryDialog(field) {
  pendingInventorySummaryField = field;
  const defaults = inventoryDefaultPeriod();
  document.getElementById('source-summary-date-from').value = defaults.previousMonday;
  document.getElementById('source-summary-date-to').value = defaults.previousSunday;
  const titles = {
    waste: 'Resumen de Merma',
    marketing: 'Resumen de Consumo de Marketing',
    employees: 'Resumen de Consumo de Colaboradores', calibrations: 'Resumen de Calibraciones y bebidas desechadas'
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
        calibrations: 'Calibraciones y bebidas desechadas', employees: 'Consumo de colaboradores'
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
  const stockedCost = (data.ingredients.stockedProducts || []).reduce((sum, item) => sum + (item.totalCost || 0), 0);
  const stockConsumptionCost = ingredientCost + stockedCost;
  const difference = productCost - stockConsumptionCost;
  const unexplainedDifference = difference;
  const percentage = productCost ? Math.abs(difference) / productCost * 100 : 0;
  const box = document.createElement('aside');
  box.className = `cost-reconciliation ${Math.abs(unexplainedDifference) < 1 ? 'is-balanced' : 'has-difference'}`;

  const title = document.createElement('strong');
  title.textContent = Math.abs(unexplainedDifference) < 1
    ? (data.products.productsWithoutMasterCost?.length || data.ingredients.ingredientsWithoutCost?.length ? 'Subtotales conciliados · costos pendientes' : 'Costos conciliados')
    : 'Explicación de la diferencia de costos';
  const comparison = document.createElement('p');
  comparison.textContent = `Productos: ${formatClp(productCost)} · Insumos consumidos (ingredientes y productos terminados): ${formatClp(stockConsumptionCost)} · Diferencia: ${formatClp(difference)} (${percentage.toLocaleString('es-CL', { maximumFractionDigits: 1 })}%).`;
  const method = document.createElement('p');
  method.textContent = 'El costo de cada producto preparado se calcula desde su receta con las cantidades, rendimientos y conversiones de unidad. Cada ingrediente usa su última compra compatible disponible al corte. Los productos preparados suman esos mismos costos mediante su receta. Se buscan compras de todo el historial hasta el corte, incluso anteriores al período. Solo sin compra compatible se usa el maestro de ingredientes como respaldo; nunca el costo fijo del producto preparado. Si faltan ambas referencias, el costo queda pendiente.';
  box.append(title, comparison, method);

  const reasons = [];
  if (data.ingredients.stockedProducts?.length) reasons.push(`Productos terminados con stock: ${data.ingredients.stockedProducts.map(p => p.code).join(', ')}; costo ${formatClp(stockedCost)}. Se consumen como producto y no se vuelven a descontar sus ingredientes. Conciliación: ingredientes ${formatClp(ingredientCost)} + productos terminados ${formatClp(stockedCost)} = ${formatClp(ingredientCost + stockedCost)}. No es una diferencia de base de costo.`);
  const withoutRecipe = data.ingredients.productsWithoutRecipe || [];
  const withoutCost = data.ingredients.ingredientsWithoutCost || [];
  const withoutConversion = data.ingredients.ingredientsWithoutConversion || [];
  if (withoutRecipe.length) reasons.push(`Productos sin receta: ${withoutRecipe.join(', ')}. Su costo aparece en productos, pero no puede descomponerse en ingredientes.`);
  if (withoutCost.length) reasons.push(`Ingredientes sin costo completo de compra ni respaldo compatible del maestro: ${withoutCost.join(', ')}.`);
  if (withoutConversion.length) reasons.push(`Ingredientes con unidades incompatibles: ${withoutConversion.join(', ')}.`);
  if (Math.abs(unexplainedDifference) >= 1 && !withoutRecipe.length && !withoutCost.length && !withoutConversion.length) reasons.push('Hay una diferencia no conciliada que debe revisarse; los productos con receta completa deberían coincidir con sus ingredientes valorizados.');
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
  fields = ['marketing', 'employees', 'calibrations'],
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
      `Costo productos${data.products.productsWithoutMasterCost?.length ? ' (parcial)' : ''}: ${formatClp(data.products.totalCost)}`,
      `Costo insumos${data.ingredients.ingredientsWithoutCost?.length || data.ingredients.stockedProducts?.some(p => p.costIncomplete) ? ' (parcial)' : ''}: ${formatClp((data.ingredients.totalCost || 0) + sumConsumptionRows(data.ingredients.stockedProducts || [], 'totalCost'))}`
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
      { key: 'quantity', label: 'Cantidad', value: item => `${formatInventoryQuantity(item.quantity)} ${item.unitNeedsConfirmation ? '(unidad por confirmar)' : item.unit || ''}` },
      { key: 'unitCost', label: 'Costo unit.', value: item => item.costSource === 'missing' ? 'Pendiente' : formatClp(item.unitCost) },
      { key: 'costSource', label: 'Origen costo', value: item => costSourceShort(item) },
      { key: 'totalCost', label: 'Costo total', value: item => item.costSource === 'missing' ? 'Pendiente' : formatClp(item.totalCost) }
    ], productRows, {
      code: 'TOTAL',
      quantity: quantitiesByUnit(productRows),
      totalCost: formatClp(sumConsumptionRows(productRows, 'totalCost'))
    }));
    if (data.products.productsWithoutMasterCost?.length) {
      const warning = document.createElement('p');
      warning.className = 'form-status muted';
      warning.textContent = `${data.products.productsWithoutMasterCost.length} producto(s) sin costo completo de compra ni respaldo compatible; total parcial.`;
      productPart.appendChild(warning);
    }
    card.appendChild(productPart);

    const ingredientPart = document.createElement('section');
    ingredientPart.className = 'consumption-report-part';
    const ingredientTitle = document.createElement('h5');
    ingredientTitle.textContent = '2. Insumos consumidos: ingredientes y productos terminados';
    ingredientPart.appendChild(ingredientTitle);
    if (data.ingredients.error) {
      const error = document.createElement('p');
      error.className = 'form-status error';
      error.textContent = data.ingredients.error;
      ingredientPart.appendChild(error);
    } else {
      const ingredientRows = [...data.ingredients.items.map(item => ({...item, consumptionType: item.includesDirectConsumption
        ? item.includesRecipeConsumption ? 'Ingrediente directo y de receta' : 'Ingrediente directo'
        : 'Ingrediente de receta'})), ...(data.ingredients.stockedProducts || []).map(item => ({...item, consumptionType: 'Producto terminado'}))];
      ingredientPart.appendChild(buildConsumptionTable([
        { key: 'code', label: 'Código', value: item => item.code, maxChars: 18 },
        { key: 'name', label: 'Ingrediente', value: item => item.name, maxChars: 50 },
        { key: 'quantity', label: 'Cantidad', value: item => formatInventoryQuantity(item.quantity) },
        { key: 'unit', label: 'Unidad', value: item => item.unit },
        { key: 'consumptionType', label: 'Tipo de insumo', value: item => item.consumptionType },
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

function matchesInventoryQuantityFilter(value, criterion) {
  if (criterion === 'all') return true;
  if (value == null || !Number.isFinite(Number(value))) return false;
  const isZero = Math.abs(Number(value)) <= 0.000001;
  return criterion === 'zero' ? isZero : !isZero;
}

// Keep source quantities unchanged; show each movement's effect on inventory.
function signedKardexMovement(item, definition) {
  const direction = /^(uso-|trl-out-|mov-out-|trn-out-)/.test(definition.key) ? -1 : 1;
  return direction * (Number(item.movements[definition.key]) || 0);
}

function renderKardexTotalsNote(element, items, report) {
  const missingCost = items.filter(item => !item.costAvailable).length;
  const nonComparable = items.filter(item => item.difference == null).length;
  const missingPhysical = items.filter(item => (report.selection ? item.finalInventory : item.physicalFinal) == null).length;
  const observations = [];
  if (missingCost) observations.push(`${missingCost} registro(s) sin costo`);
  if (nonComparable) observations.push(`${nonComparable} registro(s) no comparables`);
  if (missingPhysical) observations.push(`${missingPhysical} registro(s) sin toma física`);
  element.hidden = !observations.length;
  element.textContent = observations.length
    ? `Observación: los totales suman los valores disponibles de las filas mostradas. ${observations.join('; ')}. Los valores faltantes no se incluyen en la suma.`
    : '';
}

function makeInventoryItemRowInteractive(row, item) {
  row.classList.add('inventory-item-row');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'inventory-item-trigger';
  button.textContent = item.code;
  button.setAttribute('aria-label', `Ver movimientos de ${item.code}: ${item.name}`);
  row.cells[1].replaceChildren(button);
  row.addEventListener('click', () => openInventoryItemDetail(item, button));
}

async function openInventoryItemDetail(item, trigger) {
  const state = inventoryKardexTableState;
  const dialog = document.createElement('dialog');
  dialog.className = 'inventory-report-dialog inventory-item-dialog';
  dialog.setAttribute('aria-label', `Detalle de ${item.code}: ${item.name}`);
  const head = document.createElement('div'); head.className = 'preview-dialog-head';
  const title = document.createElement('h2'); title.textContent = `${item.code} · ${item.name}`;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = 'Cerrar';
  close.addEventListener('click', () => dialog.close()); head.append(title, close); dialog.append(head);
  const period = document.createElement('p');
  period.textContent = `${state.location?.name || ''} · Movimientos: ${formatReportDate(state.report.dateFrom)} – ${formatReportDate(state.report.dateTo)} · Unidad: ${item.unit}`;
  dialog.append(period);
  const summary = document.createElement('dl'); summary.className = 'inventory-item-summary';
  for (const column of state.columns.filter(column => !['Código', 'Producto'].includes(column.label))) {
    const label = document.createElement('dt'), value = document.createElement('dd');
    label.textContent = column.label; value.textContent = column.value(item); summary.append(label,value);
  }
  dialog.append(summary);
  const content = document.createElement('div'); content.textContent = 'Cargando documentos y movimientos…'; dialog.append(content);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus({preventScroll:true}); });
  document.body.append(dialog); dialog.showModal(); close.focus();
  const quantity = value => value == null ? 'No disponible' : formatKardexQuantity(value, 4);
  const exactQuantity = value => value == null ? 'No disponible' : Number(value).toLocaleString('es-CL', { maximumFractionDigits: 12 });
  const timestamp = value => !value ? 'No informado' : /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatReportDate(value) : new Date(value).toLocaleString('es-CL', { timeZone: 'America/Santiago' });
  const addTable = (title, rows, columns, empty) => {
    const section = document.createElement('section'), heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
    if (!rows.length) {const p=document.createElement('p');p.textContent=empty;section.append(p);content.append(section);return;}
    const wrap=document.createElement('div');wrap.className='inventory-item-table-wrap';
    const table=document.createElement('table');table.className='inventory-results-table';
    const head=document.createElement('thead'),header=document.createElement('tr'),body=document.createElement('tbody');
    for(const [label] of columns){const th=document.createElement('th');th.textContent=label;header.append(th);}head.append(header);
    for(const row of rows){const tr=document.createElement('tr');for(const [,value] of columns){const td=document.createElement('td');td.textContent=value(row)??'No informado';tr.append(td);}body.append(tr);}
    table.append(head,body);wrap.append(table);section.append(wrap);content.append(section);
  };
  try {
    if (!state.detailReportId) throw Error('Vuelve a procesar el informe para cargar el detalle de sus movimientos.');
    const detail = await apiRequest(`/api/inventory/item-detail?${new URLSearchParams({report:state.detailReportId,code:item.code,unit:item.unit})}`);
    if (!dialog.isConnected) return;
    content.replaceChildren();
    const note=document.createElement('p');note.className='inventory-item-note';
    note.textContent=`${detail.warehouse ? 'Bodega considerada: '+detail.warehouse+'. ' : ''}${detail.capturedAt ? 'Captura: '+timestamp(detail.capturedAt)+'. ' : ''}Las cantidades corresponden a la unidad del ítem; se conserva también la cantidad original. Las tomas fijan un saldo, no se suman como entradas. Los documentos pendientes o anulados no afectan el inventario. El consumo de ventas es estimado según recetas. Fechas de registro y aprobación en horario de Chile.`;
    content.append(note);
    if(!detail.documentsAvailable){const p=document.createElement('p');p.className='inventory-totals-note';p.textContent='Esta fuente contiene saldos agregados; no dispone de documentos individuales para desglosar los movimientos.';content.append(p);}
    const movementColumns=[
      ['Fecha',m=>formatReportDate(m.date)],['Movimiento',m=>m.type],['Documento',m=>m.document],
      ['Cantidad',m=>`${quantity(m.quantity)} ${m.unit}`],['Efecto en saldo',m=>!m.active?'No contabilizado':m.count?'Fija saldo':`${quantity(m.effect)} ${m.unit}`],
      ['Estado',m=>m.status],['Origen',m=>m.origin],['Destino',m=>m.destination],
      ['Cantidad original',m=>`${exactQuantity(m.originalQuantity)} ${m.originalUnit}`],['Cantidad exacta convertida',m=>`${exactQuantity(m.exactQuantity)} ${m.unit}`],
      ['Registrado',m=>timestamp(m.createdAt)],['Aprobado',m=>timestamp(m.approvedAt)],['Observación',m=>m.observation|| (m.estimated?'Consumo estimado según receta':'—')]
    ];
    addTable('Transferencias entre bodegas y locales',detail.movements.filter(m=>m.transfer),movementColumns,'No hay transferencias registradas para este ítem en la bodega y período considerados.');
    addTable('Compras, ventas y transformaciones',detail.movements.filter(m=>!m.transfer&&!m.count),movementColumns,'No hay documentos de estos movimientos disponibles para el período.');
    addTable('Tomas físicas y apertura',detail.movements.filter(m=>m.count),movementColumns,'No hay documentos de tomas físicas disponibles para las fechas consideradas.');
    addTable('Marketing, colaboradores y calibraciones',detail.consumptionMovements || [],[
      ['Fecha',r=>formatReportDate(r.date)],['Consumo',r=>r.type],['Cantidad',r=>`${quantity(r.quantity)} ${r.unit}`],['Efecto en saldo',r=>`${quantity(r.effect)} ${r.unit}`],['Producto consumido',r=>r.product],['Archivo',r=>r.source],['Cantidad en unidad original',r=>`${quantity(r.originalQuantity)} ${r.originalUnit}`]
    ],'No hay consumos diarios disponibles para este ítem.');
    addTable('Saldos diarios de las fuentes originales',detail.daily,[
      ['Fecha',r=>formatReportDate(r.date)],['Saldo inicial',r=>quantity(r.opening)],['Saldo final',r=>quantity(r.closing)],['Toma física',r=>r.physicalCount?'Sí':'No'],['Ajuste por toma',r=>quantity(r.adjustment)]
    ],'No hay saldos diarios disponibles.');
    const explanation=document.createElement('p');explanation.className='inventory-item-note';
    explanation.textContent='Los saldos diarios muestran el cálculo de las fuentes originales. Marketing, colaboradores, calibraciones y compensaciones se aplican en el consolidado. Los consumos de ingredientes se estiman con las recetas; las compensaciones por sustituciones y envases no utilizados figuran como cantidad total del período en el resumen del ítem.';content.append(explanation);
    for(const issue of detail.issues){const p=document.createElement('p');p.className='inventory-totals-note';p.textContent=issue;content.append(p);}
  } catch(error){if(dialog.isConnected){content.textContent=error.message;content.className='form-status error';}}
}

function inventoryItemHasActivity(item) {
  const nonzero = value => value != null && Number.isFinite(Number(value)) && Number(value) !== 0;
  return item.hasPeriodMovements === true
    || ['initialInventory', 'finalInventory', 'physicalFinal', 'theoreticalFinal', 'adjustedTheoreticalFinal',
      'calibrationConsumption', 'employeeConsumption', 'marketingConsumption', 'compensationQuantity'].some(key => nonzero(item[key]))
    || Object.values(item.movements || {}).some(nonzero);
}

function sortInventoryItems(items, column, sortDirection) {
  const direction = sortDirection === 'desc' ? -1 : 1;
  const value = column.sortValue || column.value;
  return items.sort((left, right) => {
    const leftValue = value(left), rightValue = value(right);
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return String(left.code).localeCompare(String(right.code), 'es', { numeric: true });
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), 'es', { numeric: true, sensitivity: 'base' });
    return (comparison || String(left.code).localeCompare(String(right.code), 'es', { numeric: true })) * direction;
  });
}

function renderInventoryKardexTable() {
  if (!inventoryKardexTableState) return;
  const { report, columns } = inventoryKardexTableState;
  const table = document.getElementById('inventory-results-table');
  const previousScrollLeft = table.parentElement.scrollLeft;
  const search = normalizedInventorySearch(document.getElementById('inventory-kardex-search').value);
  const costCriterion = document.getElementById('inventory-kardex-cost-filter').value;
  const physicalCriterion = document.getElementById('inventory-kardex-physical-filter').value;
  const theoreticalCriterion = document.getElementById('inventory-kardex-theoretical-filter').value;
  const epsilon = 0.000001;
  const activeItems = report.items.filter(inventoryItemHasActivity);
  const items = activeItems.filter(item => {
    const matchesSearch = !search || normalizedInventorySearch(`${item.code} ${item.name}`).includes(search);
    if (!matchesSearch) return false;
    const cost = Number(item.totalCost) || 0;
    if (costCriterion === 'positive' && cost <= epsilon) return false;
    if (costCriterion === 'negative' && cost >= -epsilon) return false;
    if (costCriterion === 'zero' && Math.abs(cost) > epsilon) return false;
    if (costCriterion === 'nonzero' && Math.abs(cost) <= epsilon) return false;
    const physical = report.selection ? item.finalInventory : item.physicalFinal;
    const theoretical = report.boundaryMode ? item.adjustedTheoreticalFinal : item.theoreticalFinal;
    return matchesInventoryQuantityFilter(physical, physicalCriterion)
      && matchesInventoryQuantityFilter(theoretical, theoreticalCriterion);
  });
  const sortColumn = columns[inventoryKardexTableState.sortIndex];
  sortInventoryItems(items, sortColumn, inventoryKardexTableState.direction);

  inventoryKardexTableState.visibleItems = items;
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
    cell.textContent = activeItems.length ? 'No hay filas que coincidan con los filtros seleccionados.' : 'No hay ítems con inventario o movimientos en el período.';
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    for (const item of items) {
      const row = document.createElement('tr');
      for (const [columnIndex, column] of columns.entries()) {
        const cell = document.createElement('td');
        cell.textContent = column.value(item);
        if (columnIndex < 5) cell.title = cell.textContent;
        const numericValue = column.signValue ? column.signValue(item) : column.sortValue?.(item);
        if (typeof numericValue === 'number' && Number.isFinite(numericValue)) {
          if (numericValue < 0) cell.className = 'difference-negative';
          else if (numericValue > 0) cell.className = 'difference-positive';
        }
        row.appendChild(cell);
      }
      makeInventoryItemRowInteractive(row, item);
      body.appendChild(row);
    }
  }
  const foot = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  totalRow.className = 'consumption-total-row';
  columns.forEach((column, index) => {
    const cell = document.createElement('td');
    if (index === 0) cell.textContent = 'TOTAL';
    else if (column.totalValue) {
      cell.textContent = column.totalValue(items);
      const values = items.map(item => column.sortValue?.(item));
      if (!/Sin |No comparable/.test(cell.textContent)) {
        const total = values.reduce((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
        if (total) cell.className = total > 0 ? 'difference-positive' : 'difference-negative';
      }
    }
    totalRow.appendChild(cell);
  });
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);
  table.parentElement.scrollLeft = previousScrollLeft;
  renderKardexTotalsNote(document.getElementById('inventory-kardex-totals-note'), items, report);
  const inactiveCount = report.items.length - activeItems.length;
  document.getElementById('inventory-kardex-visible-count').textContent = `${items.length} de ${activeItems.length} filas${inactiveCount ? ` · ${inactiveCount} sin inventario ni movimientos ocultas` : ''}`;
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

function formatInventoryExecutivePercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function inventoryExecutiveResultTone(metric) {
  const amount = Number(metric?.amount) || 0;
  if (amount > 0) return 'executive-positive-result';
  if (amount < 0) return 'executive-negative-result';
  return '';
}

function renderInventoryExecutiveSummary(summary) {
  const section = document.getElementById('inventory-executive-summary');
  if (!summary?.metrics) {
    section.hidden = true;
    return;
  }
  const locations = (summary.period?.locations || []).map(location => location.name).filter(Boolean);
  const locationLabel = locations.length === 1 ? 'Ubicación considerada' : 'Ubicaciones consideradas';
  document.getElementById('inventory-executive-net-sales').textContent =
    `Venta neta: ${formatKardexCost(summary.netSales)}`;
  document.getElementById('inventory-executive-period').textContent =
    `${formatReportDate(summary.period.dateFrom)} – ${formatReportDate(summary.period.dateTo)} · ${locationLabel}: ${locations.join(', ') || 'Sin ubicación'}.${summary.salesFilesRead ? '' : ' No se encontró un archivo de ventas legible para el período.'}`;

  const metrics = summary.metrics;
  const adjustedKardex = metrics.adjustedKardexTotalCost;
  const inventoryContext = (label, metric) => metric?.available
    ? `${label}${metric.partial ? ' (subtotal parcial)' : ''}: ${formatKardexCost(metric.amount)} (${formatInventoryExecutivePercent(metric.percentOfNetSales)} de la venta neta del período).`
    : `${label}: no disponible para esta fuente o período.`;
  const balances = summary.inventoryBalances;
  const physicalReconciliation = () => {
    if (!balances?.physicalTotal?.available) return '';
    const components = [];
    if (balances.kardex.physical.available) components.push(`consolidado ${formatKardexCost(balances.kardex.physical.amount)}`);
    if (balances.consumables?.physical.available) components.push(`consumibles ${formatKardexCost(balances.consumables.physical.amount)}`);
    if (balances.physicalOutsideKardex?.available && balances.physicalOutsideKardex.amount !== 0) {
      components.push(`artículos con toma fuera del consolidado ${formatKardexCost(balances.physicalOutsideKardex.amount)}`);
    }
    return `Inventario físico total del ${formatReportDate(balances.date)}${balances.physicalTotal.partial ? ' (subtotal parcial)' : ''}: ${components.join(' + ')} = ${formatKardexCost(balances.physicalTotal.amount)}. Incluye consumibles; es la base de Inventario Final en Resultados Semanales para esa toma.`;
  };

  const rows = [
    {
      label: 'Costo consumo marketing', metric: metrics.marketingConsumption, tone: 'executive-negative-concept',
      context: `${formatInventoryQuantity(metrics.marketingConsumption.quantity)} unidad(es) de producto consumida(s). Se presenta en rojo porque corresponde a consumo interno.`
    },
    {
      label: 'Costo consumo colaboradores', metric: metrics.employeeConsumption, tone: 'executive-negative-concept',
      context: `${formatInventoryQuantity(metrics.employeeConsumption.quantity)} unidad(es) de producto consumida(s). Se presenta en rojo porque corresponde a consumo interno.`
    },
    {
      label: 'Calibraciones y bebidas desechadas', metric: metrics.calibrationConsumption, tone: 'executive-negative-concept',
      context: `${formatInventoryQuantity(metrics.calibrationConsumption.quantity)} unidad(es) de producto consumida(s).`
    },
    {
      label: 'Costo de merma', metric: metrics.waste, tone: 'executive-negative-concept',
      context: `${metrics.waste.itemCount} ítem(s) con adiciones. Se presenta en rojo porque representa pérdida o merma.`
    },
    ...(metrics.otherConsumables ? [{label:'Otros Consumibles',metric:metrics.otherConsumables,tone:'executive-negative-concept',context:`${metrics.otherConsumables.coveredItemCount} de ${metrics.otherConsumables.itemCount} ítems con diferencia valorizada. Separados del costo Kardex ajustado.${metrics.otherConsumables.partial ? ' Subtotal parcial: faltan costos o tomas físicas.' : ''}`}]:[]),
    {
      label: 'Costo Total Kardex ajustado por sustit. y vasos no ut.', metric: adjustedKardex,
      preserveSign: true,
      tone: inventoryExecutiveResultTone(adjustedKardex),
      alwaysShowContext: true,
      context: [
        adjustedKardex.coveredItemCount !== undefined ? `${adjustedKardex.partial ? 'Subtotal verificable' : 'Cobertura completa'}: ${adjustedKardex.coveredItemCount} de ${adjustedKardex.totalItemCount} productos. Sin toma final: ${adjustedKardex.missingPhysicalCodes?.length || 0}; sin costo verificable: ${adjustedKardex.missingCostCodes?.length || 0}. Además, ${adjustedKardex.excludedOpeningCodes?.length || 0} excluidos por apertura o identidad. Ver detalle del inventario.` : '',
        adjustedKardex.available && adjustedKardex.coveredItemCount !== undefined
          ? `Costo Kardex de los productos cubiertos ${formatKardexCost(adjustedKardex.kardexTotalCost)} − sustituciones y envases no utilizados de esos productos ${formatKardexCost(adjustedKardex.totalAdjustmentCost)} = ${formatKardexCost(adjustedKardex.amount)}.`
          : adjustedKardex.available
          ? `Costo Total del Kardex ${formatKardexCost(adjustedKardex.kardexTotalCost)} − sustituciones de syrup y salsas ${formatKardexCost(adjustedKardex.syrupSauceSubstitutionCost)} − costo de LAC001 no utilizado por sustituciones ${formatKardexCost(adjustedKardex.lac001SubstitutionCost)} − vasos y tapas no utilizados ${formatKardexCost(adjustedKardex.avoidedPackagingCost)} = ${formatKardexCost(adjustedKardex.amount)}.`
          : 'Costo ajustado no disponible para esta fuente o período.',
        balances ? 'Saldos del consolidado completo, sin los consumibles separados; coinciden con la grilla sin filtros.' : '',
        inventoryContext('Valor Inventario Final Teórico', metrics.theoreticalFinalInventoryValue),
        inventoryContext('Valor Inventario Físico', metrics.physicalInventoryValue),
        adjustedKardex.available && adjustedKardex.physicalInventoryValue != null && adjustedKardex.adjustedTheoreticalFinalInventoryValue != null
          ? `Productos comparables: físico ${formatKardexCost(adjustedKardex.physicalInventoryValue)} − teórico ajustado ${formatKardexCost(adjustedKardex.adjustedTheoreticalFinalInventoryValue)} = costo ajustado ${formatKardexCost(adjustedKardex.amount)}.` : '',
        physicalReconciliation()
      ].join(' ')
    }
  ];
  const table = document.getElementById('inventory-executive-summary-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Indicador', 'Total', '% de venta neta', 'Contexto'].forEach(label => {
    const cell = document.createElement('th');
    cell.textContent = label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  const netSales = Number(summary.netSales) || 0;
  const displayedAmount = (metric, preserveSign = false) => preserveSign
    ? Math.round(Number(metric.amount) || 0)
    : -Math.round(Math.abs(Number(metric.amount) || 0));
  const percent = amount => netSales !== 0 ? amount / netSales * 100 : null;
  const availableRows = rows.filter(({ metric }) => metric.available);
  rows.forEach(({ label, metric, context, tone = '', alwaysShowContext = false, preserveSign = false }) => {
    const row = document.createElement('tr');
    row.className = tone;
    const amount = metric.available ? displayedAmount(metric, preserveSign) : null;
    [
      label + (metric.partial ? ' (parcial)' : ''),
      metric.available ? formatKardexCost(amount) : 'No disponible',
      metric.available ? formatInventoryExecutivePercent(percent(amount)) : '—',
      metric.available || alwaysShowContext ? context : 'No disponible para esta fuente o período.'
    ].forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if ((index === 1 || index === 2) && metric.available) cell.className = 'executive-total-cost';
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  const foot = document.createElement('tfoot');
  const totalRow = document.createElement('tr');
  const total = availableRows.reduce((sum, { metric, preserveSign }) => sum + displayedAmount(metric, preserveSign), 0);
  totalRow.className = inventoryExecutiveResultTone({amount: total});
  const complete = availableRows.length === rows.length && !availableRows.some(({metric}) => metric.partial);
  [
    complete ? 'TOTAL' : 'TOTAL DISPONIBLE',
    availableRows.length ? formatKardexCost(total) : 'No disponible',
    availableRows.length ? formatInventoryExecutivePercent(percent(total)) : '—',
    complete ? '' : 'Suma de los indicadores disponibles; faltan datos para completar el total.'
  ].forEach((value, index) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    if ((index === 1 || index === 2) && availableRows.length) cell.className = 'executive-total-cost';
    totalRow.appendChild(cell);
  });
  foot.appendChild(totalRow);
  table.replaceChildren(head, body, foot);

  section.hidden = false;
}

function renderInventoryResults(data) {
  inventoryProcessedProvenance = data.provenance || null;
  setStatus(document.getElementById('inventory-kardex-export-status'), '');
  const report = data.report;
  const physicalInventoryQuantity = item => report.selection ? item.finalInventory : item.physicalFinal;
  const inventoryValue = (item, quantity) => (Number(quantity) || 0) * (Number(item.unitCost) || 0);
  const totalInventoryValue = (items, quantity) => formatKardexCost(items.reduce(
    (sum, item) => item.costAvailable && quantity(item) != null ? sum + inventoryValue(item, quantity(item)) : sum,
    0
  ));
  renderInventoryExecutiveSummary(data.executiveSummary);
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
  const reportPeriod = report.selection
    ? `Saldo inicial: ${basisLabel(report.selection.initialBasis)} del ${formatReportDate(report.selection.initialDate)} · movimientos: ${formatReportDate(report.dateFrom)} a ${formatReportDate(report.dateTo)}, ambas fechas incluidas · saldo final: ${basisLabel(report.selection.finalBasis)} del ${formatReportDate(report.selection.finalDate)}.`
    : `${formatReportDate(report.dateFrom)} a ${formatReportDate(report.dateTo)} · inventario físico tomado del inicio del ${formatReportDate(report.physicalInventoryDate)}.`;
  const executiveLocations = (data.executiveSummary?.period?.locations || []).map(location => location.name).filter(Boolean);
  const executiveLocationLabel = executiveLocations.length === 1 ? 'Ubicación considerada' : 'Ubicaciones consideradas';
  const netSalesHeader = data.executiveSummary
    ? ` ${executiveLocationLabel}: ${executiveLocations.join(', ') || 'Sin ubicación'} · Venta neta del período: ${formatKardexCost(data.executiveSummary.netSales)}.`
    : '';
  document.getElementById('inventory-report-period').textContent = `${data.provenance?.label || 'Archivos Kardex de Toteat'} · ${reportPeriod}${netSalesHeader}`;
  const provenance = document.getElementById('inventory-report-provenance');
  provenance.hidden = data.provenance?.mode !== 'originals';
  provenance.textContent = provenance.hidden ? '' : `${data.provenance.note} Lectura: ${new Date(data.provenance.capturedAt).toLocaleString('es-CL')}. ${data.provenance.excluded.length} productos excluidos (motivos en Excel); ${data.provenance.issues.length} incidencias en la captura. ${data.provenance.physicalFinalItems} productos incluidos con toma física en el saldo final seleccionado.`;
  document.getElementById('inventory-report-item-count').textContent = `${report.itemCount} productos`;
  const columns = [
    { label: 'Jerarquía', value: item => item.hierarchyPath?.join(' › ') || 'Sin jerarquía', sortValue: item => item.hierarchyPath?.join(' › ') || 'Sin jerarquía' },
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
    ...(report.boundaryMode ? [{label:'Origen apertura',value:item=>`${item.initialSource==='physical'?'Toma física':'Teórico desde toma/registro'} ${item.anchorDate}`}]:[]),
    ...report.movementDefinitions.map(definition => ({
      label: definition.label,
      value: item => formatKardexTableQuantity(signedKardexMovement(item, definition)),
      sortValue: item => signedKardexMovement(item, definition)
    })),
    { label: 'Calibraciones y bebidas desechadas', value: item => formatKardexTableQuantity(-(Number(item.calibrationConsumption) || 0)), sortValue: item => -(Number(item.calibrationConsumption) || 0) },
    { label: 'Consumo Colaboradores', value: item => formatKardexTableQuantity(-(Number(item.employeeConsumption) || 0)), sortValue: item => -(Number(item.employeeConsumption) || 0) },
    { label: 'Consumo Marketing', value: item => formatKardexTableQuantity(-(Number(item.marketingConsumption) || 0)), sortValue: item => -(Number(item.marketingConsumption) || 0) },
    ...(report.boundaryMode ? [{
      label: 'Compensaciones',
      value: item => formatKardexTableQuantity(item.compensationQuantity),
      sortValue: item => Number(item.compensationQuantity) || 0
    }] : []),
    ...(report.selection ? [
      {
        label: 'Inventario Final Teórico',
        value: item => formatKardexTableQuantity(report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal),
        sortValue: item => Number(report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal) || 0
      },
      {
        label: `${report.boundaryMode?'Inventario físico':basisLabel(report.selection.finalBasis)} ${formatReportDate(report.selection.finalDate)}`,
        value: item => item.finalInventory==null?'Sin toma física':formatKardexTableQuantity(item.finalInventory),
        sortValue: item => Number(item.finalInventory) || 0
      }
    ] : [
      { label: 'Inventario final teórico', value: item => formatKardexTableQuantity(report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal), sortValue: item => Number(report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal) || 0 },
      { label: `Inventario físico ${formatReportDate(report.physicalInventoryDate)}`, value: item => formatKardexTableQuantity(item.physicalFinal), sortValue: item => Number(item.physicalFinal) || 0 }
    ]),
    {
      label: 'Diff de Inventario',
      value: item => item.difference==null?'No comparable':formatKardexTableQuantity(item.difference),
      sortValue: item => item.difference == null ? null : Number(item.difference),
      signValue: item => item.difference,
      finalDifference: true
    },
    {
      label: 'Costo Total',
      value: item => item.totalCost==null?'No comparable':item.costAvailable ? formatKardexCost(item.totalCost) : 'Sin costo',
      sortValue: item => item.costAvailable && Number.isFinite(item.totalCost) ? item.totalCost : null,
      totalValue: items => formatKardexCost(items.reduce((sum, item) => sum + (item.costAvailable && Number.isFinite(item.totalCost) ? item.totalCost : 0), 0))
    },
    {
      label: 'Valor Inventario Final Teórico',
      value: item => item.costAvailable ? formatKardexCost(inventoryValue(item, report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal)) : 'Sin costo',
      sortValue: item => item.costAvailable ? inventoryValue(item, report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal) : null,
      totalValue: items => totalInventoryValue(items, item => report.boundaryMode?item.adjustedTheoreticalFinal:item.theoreticalFinal)
    },
    {
      label: 'Valor Inventario Físico',
      value: item => physicalInventoryQuantity(item)==null?'Sin toma física':item.costAvailable ? formatKardexCost(inventoryValue(item, physicalInventoryQuantity(item))) : 'Sin costo',
      sortValue: item => item.costAvailable && physicalInventoryQuantity(item) != null ? inventoryValue(item, physicalInventoryQuantity(item)) : null,
      totalValue: items => totalInventoryValue(items, physicalInventoryQuantity)
    }
  ];
  document.getElementById('inventory-kardex-search').value = '';
  document.getElementById('inventory-kardex-cost-filter').value = 'all';
  document.getElementById('inventory-kardex-physical-filter').value = 'all';
  document.getElementById('inventory-kardex-theoretical-filter').value = 'all';
  inventoryKardexTableState = { report, columns, detailReportId: data.itemDetailReportId, location: data.location, sortIndex: 1, direction: 'asc' };
  renderInventoryKardexTable();
  renderOtherConsumables(data.otherConsumables, columns, data.executiveSummary?.metrics.otherConsumables);
  renderLac001SubstitutionReport(data.lac001Substitutions);
  renderSyrupSauceSubstitutionReport(data.syrupSauceSubstitutions);
  renderInventoryAvoidedPackagingReport(data.avoidedPackaging);
  document.getElementById('inventory-report-results').showModal();
}

function renderOtherConsumables(report, columns, metric) {
  const section = document.getElementById('inventory-other-consumables');
  inventoryOtherConsumablesTableState = report?.items?.length
    ? { report, columns, sortIndex: 1, direction: 'asc' } : null;
  section.hidden = !report?.items?.length;
  if (section.hidden) return;
  const activeCount = report.items.filter(inventoryItemHasActivity).length;
  const inactiveCount = report.items.length - activeCount;
  document.getElementById('inventory-other-consumables-summary').textContent = `${activeCount} ítems con inventario o movimientos, separados del Consolidado del Kardex.${inactiveCount ? ` ${inactiveCount} ítems sin inventario ni movimientos ocultos.` : ''} ${metric?.partial ? 'Subtotal parcial; los registros sin costo o toma física permanecen pendientes.' : 'Importe incluido por separado en el resumen ejecutivo.'}`;
  renderOtherConsumablesTable();
}

function renderOtherConsumablesTable() {
  if (!inventoryOtherConsumablesTableState) return;
  const state = inventoryOtherConsumablesTableState;
  const { report, columns } = state;
  const table = document.getElementById('inventory-other-consumables-table');
  const { scrollLeft, scrollTop } = table.parentElement;
  const items = sortInventoryItems(report.items.filter(inventoryItemHasActivity), columns[state.sortIndex], state.direction);
  const head = document.createElement('thead'), header = document.createElement('tr');
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    const active = index === state.sortIndex;
    th.setAttribute('aria-sort', active ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inventory-sort-button${active ? ' active' : ''}`;
    button.textContent = `${column.label}${active ? state.direction === 'asc' ? ' ▲' : ' ▼' : ''}`;
    button.title = column.label;
    button.addEventListener('click', () => {
      state.direction = state.sortIndex === index && state.direction === 'asc' ? 'desc' : 'asc';
      state.sortIndex = index;
      renderOtherConsumablesTable();
      table.querySelectorAll('thead button')[index].focus({ preventScroll: true });
    });
    th.appendChild(button);
    header.appendChild(th);
  });
  head.appendChild(header);
  const body=document.createElement('tbody');
  if (!items.length) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = columns.length;
    cell.className = 'inventory-empty-result';
    cell.textContent = 'No hay consumibles con inventario o movimientos en el período.';
    row.appendChild(cell); body.appendChild(row);
  }
  for (const item of items) {
    const row=document.createElement('tr');
    for (const column of columns) {const td=document.createElement('td');td.textContent=column.value(item);row.appendChild(td);}
    makeInventoryItemRowInteractive(row, item);
    body.appendChild(row);
  }
  const foot=document.createElement('tfoot'), total=document.createElement('tr');
  for (const [index,column] of columns.entries()) {
    const td=document.createElement('td');
    td.textContent=index===0?'TOTAL':column.totalValue?column.totalValue(items):'';
    total.appendChild(td);
  }
  foot.appendChild(total);table.replaceChildren(head,body,foot);
  inventoryOtherConsumablesStickyObserver?.disconnect();
  const stickyHeaders = [...header.cells].slice(0, 4);
  const updateStickyOffsets = () => {
    const widths = stickyHeaders.map(cell => cell.getBoundingClientRect().width);
    if (widths.some(width => width === 0)) return;
    let left = 0;
    widths.forEach((width, index) => {
      table.style.setProperty(`--consumables-sticky-left-${index + 1}`, `${left}px`);
      left += width;
    });
  };
  inventoryOtherConsumablesStickyObserver = new ResizeObserver(updateStickyOffsets);
  stickyHeaders.forEach(cell => inventoryOtherConsumablesStickyObserver.observe(cell, { box: 'border-box' }));
  updateStickyOffsets();
  table.parentElement.scrollLeft = scrollLeft;
  table.parentElement.scrollTop = scrollTop;
  renderKardexTotalsNote(document.getElementById('inventory-other-consumables-totals-note'), items, inventoryKardexTableState.report);
}

function currentInventoryColumns() {
  return [
    { label: 'Jerarquía', value: item => item.hierarchyPath.join(' › '), sortValue: item => item.hierarchyPath.join(' › ') },
    { label: 'Código', value: item => item.code, sortValue: item => item.code },
    { label: 'Producto', value: item => item.name, sortValue: item => item.name },
    { label: 'Unidad', value: item => item.unit, sortValue: item => item.unit },
    { label: 'Inventario teórico', value: item => formatCurrentInventoryQuantity(item.quantity), sortValue: item => Number(item.quantity) || 0 },
    { label: 'Inventario físico', value: item => item.physicalInventory == null ? 'Sin toma física' : formatCurrentInventoryQuantity(item.physicalInventory), sortValue: item => item.physicalInventory ?? null },
    { label: 'Costo unitario', value: item => item.costAvailable ? formatKardexCost(item.unitCost) : 'Sin costo', sortValue: item => item.costAvailable ? Number(item.unitCost) || 0 : null },
    { label: 'Origen costo', value: item => costSourceShort(item), sortValue: item => `${item.costSource || ''}:${item.costSourceDate || ''}` },
    { label: 'Valorización', value: item => item.costAvailable ? formatKardexCost(item.valuation) : 'Sin costo', sortValue: item => item.costAvailable ? Number(item.valuation) || 0 : null }
  ];
}

function formatCurrentInventoryQuantity(value) {
  const selected = Number(document.getElementById('current-inventory-decimals').value);
  return formatKardexQuantity(value, Number.isInteger(selected) && selected >= 1 && selected <= 4 ? selected : 2);
}

function clearCurrentInventoryFilters() {
  document.getElementById('current-inventory-search').value = '';
  document.getElementById('current-inventory-value-filter').value = 'all';
  document.getElementById('current-inventory-physical-filter').value = 'all';
  document.getElementById('current-inventory-theoretical-filter').value = 'all';
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
    cell.textContent = 'No hay productos que coincidan con los filtros seleccionados.';
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
  const criterion = document.getElementById('current-inventory-value-filter').value;
  const physicalCriterion = document.getElementById('current-inventory-physical-filter').value;
  const theoreticalCriterion = document.getElementById('current-inventory-theoretical-filter').value;
  const epsilon = 0.000001;
  const matches = item => {
    if (query && !normalizedInventorySearch(`${item.code} ${item.name}`).includes(query)) return false;
    if (!matchesInventoryQuantityFilter(item.physicalInventory, physicalCriterion)
      || !matchesInventoryQuantityFilter(item.quantity, theoreticalCriterion)) return false;
    if (criterion === 'all') return true;
    if (!item.costAvailable || !Number.isFinite(item.valuation)) return false;
    const value = item.valuation;
    if (criterion === 'positive' && value <= epsilon) return false;
    if (criterion === 'negative' && value >= -epsilon) return false;
    if (criterion === 'zero' && Math.abs(value) > epsilon) return false;
    if (criterion === 'nonzero' && Math.abs(value) <= epsilon) return false;
    return true;
  };
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
  currentInventoryTableState.visibleItems = visibleItems;
  const valuedItems = visibleItems.filter(item => item.costAvailable);
  const missingItems = visibleItems.filter(item => !item.costAvailable);
  renderCurrentInventoryTable(document.getElementById('current-inventory-table'), valuedItems);
  renderCurrentInventoryTable(document.getElementById('current-inventory-missing-cost-table'), missingItems, true);
  document.getElementById('current-inventory-missing-cost').hidden = missingItems.length === 0;
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
  clearCurrentInventoryFilters();
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
  const movementDateFrom = initialInventoryDate;
  const movementDateTo = finalInventoryDate ? offsetIsoDate(finalInventoryDate,-1) : '';
  const availableDates = originalInventoryDates;
  if (!initialInventoryDate || !finalInventoryDate || !movementDateFrom || !movementDateTo || movementDateFrom > movementDateTo) {
    return setStatus(dialogStatus, 'Selecciona una fecha final posterior a la inicial.', 'error');
  }
  if (!availableDates.includes(initialInventoryDate) || !availableDates.includes(finalInventoryDate)) {
    return setStatus(dialogStatus, 'Las fechas deben estar dentro de la cobertura disponible. Actualiza las fuentes para ampliar el período.', 'error');
  }
  button.disabled = true;
  setStatus(status, 'Consolidando el Kardex para el período seleccionado…');
  setStatus(dialogStatus, inventoryCalendarData?.requiresRebuild ? 'Recalculando el inventario con los datos guardados y procesando el informe…' : 'Procesando informe…');
  try {
    const data = await apiRequest('/api/inventory/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: document.getElementById('inventory-location-select').value,
        source: inventoryProcessingMode,
        criteriaMode: 'count-boundaries',
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
    if (!window.brewitSettings?.dirty('company-profile-form')) {
      document.getElementById('company-name').value = company.name || 'CODE SPA';
      document.getElementById('company-tax-id').value = company.taxId || '';
      exportDecimalSystem = company.exportDecimalSystem === 'dot' ? 'dot' : 'comma';
      document.getElementById('company-export-decimal-system').value = exportDecimalSystem;
      window.brewitSettings?.clean('company-profile-form');
    }
    locationRegistry = Object.fromEntries(data.active.map(location => [location.id, location]));
    refreshReportLocationFilter();
    refreshSalesDashboardLocationFilter();
    refreshTransactionAuditLocationFilter();
    refreshFindingsLocationFilter();
    refreshFinancialResultsLocationFilter();
    refreshFinancialGeneralExpensesLocationFilter();
    refreshSalesIngredientsLocationFilter();
    refreshProductsLocationFilter();
    refreshIngredientsLocationFilter();
    refreshCostReviewLocationFilter();
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
    window.brewitSettings?.setLocations(data);
    if (document.getElementById('weekly-upload-form')) updateLocationFields();
    return data;
  } catch (error) {
    setStatus(status, error.message, 'error');
    throw error;
  }
}

function renderLocationManagement(data) {
  const activeList = document.getElementById('active-locations-list');
  const trashList = document.getElementById('trashed-locations-list');
  const editorList = document.getElementById('location-editor-list');
  if ([...editorList.children].some(row => window.brewitSettings?.dirty(row))) return;
  activeList.replaceChildren();
  editorList.replaceChildren();
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
    const toteatFields = document.createElement('div');
    toteatFields.className = 'location-toteat-fields';
    const toteatInputs = [
      ['Restaurant ID', 'toteatRestaurantId'], ['ID Local', 'toteatLocalId'],
      ['Nombre', 'toteatName'], ['Simple ID', 'toteatSimpleId']
    ].map(([label, field]) => {
      const wrapper = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = `TotEat · ${label}`;
      const input = document.createElement('input');
      input.value = location[field] || '';
      input.maxLength = field === 'toteatName' ? 100 : 40;
      input.setAttribute('aria-label', `${label} TotEat para ${location.name}`);
      wrapper.append(caption, input);
      toteatFields.appendChild(wrapper);
      return [field, input];
    });
    if (location.type === 'store') {
      const wrapper = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = 'MercadoPago · STORE_ID';
      const input = document.createElement('input');
      input.value = location.mercadoPagoStoreId || '';
      input.inputMode = 'numeric';
      input.maxLength = 40;
      input.setAttribute('aria-label', `STORE_ID MercadoPago para ${location.name}`);
      wrapper.append(caption, input);
      toteatFields.appendChild(wrapper);
      toteatInputs.push(['mercadoPagoStoreId', input]);
    }
    let openingInput = null;
    let weekdayInputs = [];
    let weekdayHoursInputs = [];
    let closedDatesInput = null;
    const operationFields = document.createElement('div');
    operationFields.className = 'location-operation-fields';
    if (location.type === 'store') {
      const openingLabel = document.createElement('label');
      openingLabel.textContent = 'Fecha de apertura';
      openingInput = document.createElement('input');
      openingInput.type = 'date';
      openingInput.value = location.openingDate || '';
      openingInput.setAttribute('aria-label', `Fecha de apertura de ${location.name}`);
      openingLabel.append(openingInput);
      operationFields.append(openingLabel);
      const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
      const days = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = 'Días programados de operación';
      days.append(legend);
      weekdayInputs = dayNames.map((day, index) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = location.operatingWeekdays?.includes(index) || false;
        label.append(input, document.createTextNode(day));
        days.append(label);
        return input;
      });
      operationFields.append(days);
      const schedule = document.createElement('fieldset');
      schedule.className = 'location-weekly-hours';
      const scheduleLegend = document.createElement('legend');
      scheduleLegend.textContent = 'Horario habitual por día · para comparaciones equivalentes';
      schedule.append(scheduleLegend);
      const scheduleGroups = [
        { label: 'Lunes a viernes', shortLabel: 'Lun–Vie', days: [1, 2, 3, 4, 5], className: 'weekday-hours' },
        { label: 'Sábado', shortLabel: 'Sáb', days: [6] },
        { label: 'Domingo', shortLabel: 'Dom', days: [0] }
      ];
      weekdayHoursInputs = scheduleGroups.map(group => {
        const row = document.createElement('label');
        row.className = `location-hours-row ${group.className || ''}`.trim();
        const caption = document.createElement('span');
        caption.textContent = `${group.label} · abre / cierra`;
        const controls = document.createElement('span');
        controls.className = 'location-hours-inputs';
        const open = document.createElement('input');
        const close = document.createElement('input');
        open.type = close.type = 'time';
        const originalHours = Object.fromEntries(group.days.flatMap(day => location.operatingHours?.[day]
          ? [[day, { ...location.operatingHours[day] }]] : []));
        const values = group.days.map(day => location.operatingHours?.[day] || null);
        const signatures = new Set(values.map(value => value ? `${value.open}|${value.close}` : ''));
        const mixed = signatures.size > 1;
        if (!mixed) {
          open.value = values[0]?.open || '';
          close.value = values[0]?.close || '';
        } else {
          open.title = close.title = 'Actualmente existen horarios distintos. Ingresa un horario para unificarlos.';
          open.setAttribute('aria-description', open.title);
          close.setAttribute('aria-description', close.title);
        }
        open.setAttribute('aria-label', `Apertura ${group.shortLabel} de ${location.name}`);
        close.setAttribute('aria-label', `Cierre ${group.shortLabel} de ${location.name}`);
        let changed = false;
        open.addEventListener('brewit-settings-discarded', () => { changed = false; });
        open.addEventListener('input', () => { changed = true; });
        close.addEventListener('input', () => { changed = true; });
        controls.append(open, close);
        row.append(caption, controls);
        if (mixed) {
          const note = document.createElement('small');
          note.textContent = 'Hay horarios distintos guardados. Al ingresar uno nuevo se unificarán.';
          row.append(note);
        }
        schedule.append(row);
        return { ...group, open, close, originalHours, mixed, wasChanged: () => changed };
      });
      operationFields.append(schedule);
      const closuresLabel = document.createElement('label');
      closuresLabel.textContent = 'Cierres excepcionales (fechas AAAA-MM-DD separadas por coma)';
      closedDatesInput = document.createElement('input');
      closedDatesInput.type = 'text';
      closedDatesInput.value = (location.closedDates || []).join(', ');
      closedDatesInput.placeholder = '2026-09-18, 2026-12-25';
      closuresLabel.append(closedDatesInput);
      operationFields.append(closuresLabel);
    }
    const type = document.createElement('span');
    type.className = 'location-type-badge';
    type.textContent = location.type === 'warehouse' ? 'Bodega' : 'Cafetería';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'primary';
    saveButton.textContent = 'Guardar cambios';
    saveButton.setAttribute('aria-label', `Guardar cambios de ${location.name}`);
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      window.brewitSettings?.setBusy(row, true);
      setStatus(document.getElementById('location-status'), 'Guardando ubicación…');
      try {
        if (weekdayHoursInputs.some(({ open, close }) => Boolean(open.value) !== Boolean(close.value))) {
          throw new Error('Completa apertura y cierre del mismo bloque, o deja ambos horarios vacíos.');
        }
        const operatingHours = Object.fromEntries(weekdayHoursInputs.flatMap(group => {
          if (group.open.value && group.close.value) {
            return group.days.map(day => [day, { open: group.open.value, close: group.close.value }]);
          }
          if (group.mixed && !group.wasChanged()) return Object.entries(group.originalHours);
          return [];
        }));
        await apiRequest(`/api/config/locations/${encodeURIComponent(location.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: nameInput.value,
            address: addressInput.value,
            ...(openingInput ? { openingDate: openingInput.value,
              operatingWeekdays: weekdayInputs.flatMap((input, index) => input.checked ? [index] : []),
              operatingHours,
              closedDates: closedDatesInput.value.split(',').map(value => value.trim()).filter(Boolean) } : {}),
            ...Object.fromEntries(toteatInputs.map(([field, input]) => [field, input.value]))
          })
        });
        window.brewitSettings?.clean(row);
        setStatus(document.getElementById('location-status'), 'Ubicación guardada.', 'success');
        await refreshLocationConfiguration();
        document.getElementById('location-editor-title').focus();
        window.dispatchEvent(new Event('brewit-location-settings-updated'));
      } catch (error) {
        setStatus(document.getElementById('location-status'), error.message, 'error');
      } finally { saveButton.disabled = false; window.brewitSettings?.setBusy(row, false); }
    });
    const trashButton = document.createElement('button');
    trashButton.type = 'button';
    trashButton.className = 'delete-button small';
    trashButton.textContent = 'Enviar a papelera';
    trashButton.addEventListener('click', () => window.brewitSettings.guard(() => openLocationTrashDialog(location)));
    const actionStack = document.createElement('div');
    actionStack.className = 'location-row-actions';
    actionStack.append(saveButton, trashButton);
    const general = document.createElement('div'); general.className = 'settings-field-grid';
    for (const [caption, input] of [['Nombre de la ubicación', nameInput], ['Dirección', addressInput]]) {
      const label = document.createElement('label'); const span = document.createElement('span'); span.textContent = caption; label.append(span, input); general.append(label);
    }
    const advanced = document.createElement('details'); const advancedTitle = document.createElement('summary'); advancedTitle.textContent = 'Identificadores avanzados'; advanced.append(advancedTitle, toteatFields);
    const heading = document.createElement('h4'); heading.textContent = 'Datos generales';
    row.append(heading, general, type);
    if (location.type === 'store') { const title = document.createElement('h4'); title.textContent = 'Calendario de operación'; row.append(title, operationFields); }
    row.append(advanced, actionStack); editorList.appendChild(row);
    window.brewitSettings?.registerEditor(row, location);
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

function renderMercadoPagoUploadSummary(summary) {
  const container = document.getElementById('mercadopago-upload-summary');
  container.replaceChildren();
  container.hidden = !summary;
  if (!summary) return;
  const title = document.createElement('h4');
  title.textContent = `Resumen del archivo: ${summary.originalName}`;
  const wrap = document.createElement('div');
  wrap.className = 'inventory-results-table-wrap';
  const table = document.createElement('table');
  table.className = 'inventory-results-table';
  const header = table.createTHead().insertRow();
  for (const label of ['Sucursal', 'STORE_ID', 'Registros']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; header.append(cell);
  }
  const body = table.createTBody();
  for (const item of [...summary.stores, ...summary.unassociated.map(item => ({ ...item, name: 'Sin asociación' }))]) {
    const row = body.insertRow();
    for (const value of [item.name, item.storeId || 'Sin STORE_ID', item.rowCount.toLocaleString('es-CL')]) row.insertCell().textContent = value;
  }
  const total = table.createTFoot().insertRow();
  total.insertCell().textContent = 'Total del archivo'; total.insertCell().textContent = ''; total.insertCell().textContent = summary.totalRows.toLocaleString('es-CL');
  wrap.append(table);
  const note = document.createElement('p');
  note.className = 'panel-description';
  note.textContent = `${summary.associatedCount.toLocaleString('es-CL')} registro(s) asociados a nuestras cafeterías. Los registros repetidos se revisarán al confirmar la carga.`;
  container.append(title, wrap, note);
  const warning = document.createElement('p');
  setStatus(warning, summary.unassociatedCount
    ? `Advertencia: ${summary.unassociatedCount.toLocaleString('es-CL')} registro(s) sin cafetería asociada no serán procesados. Al confirmar la carga, se guardarán únicamente los registros asociados según la opción elegida.`
    : 'Todos los registros tienen una cafetería asociada.', summary.unassociatedCount ? 'warning' : 'success');
  container.append(warning);
}

function showInspection(manifest, { openDialog = true } = {}) {
  inspectionState = manifest;
  const confirmation = document.getElementById('date-confirmation');
  const list = document.getElementById('detected-files-list');
  renderMercadoPagoUploadSummary(manifest.mercadoPagoSummary);
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
    if (file.storeId) {
      const assignment = document.createElement('span');
      assignment.textContent = `${file.locationLabel} · STORE_ID ${file.storeId} · ${file.rowCount} registro(s)`;
      row.appendChild(assignment);
    }
    if (file.structure?.ok && !manifest.mercadoPagoSummary) {
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
  if(document.getElementById('historical-complete'))document.getElementById('historical-complete').checked=false;
  if(document.getElementById('historical-warehouse'))document.getElementById('historical-warehouse').value='';
  const salesOnlyUpload = manifest.files.length > 0 && manifest.files.every(file => file.field === 'sales');
  const sharedMercadoPago = hasSharedMercadoPagoDates(manifest);
  const noAssociatedRows = manifest.mercadoPagoSummary?.associatedCount === 0;
  confirmation.querySelector('.confirmation-dates').hidden = sharedMercadoPago || noAssociatedRows;
  document.getElementById('date-confirmation-row').hidden = salesOnlyUpload || sharedMercadoPago || noAssociatedRows;
  document.getElementById('transaction-confirmation-title').textContent = manifest.mercadoPagoSummary
    ? 'Carga de MercadoPago por STORE_ID' : 'Revisa las fechas detectadas';
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
  keepButton.disabled = replaceButton.disabled = noAssociatedRows;
  overlapNotice.hidden = !manifest.hasOverlap;
  replaceButton.hidden = !manifest.hasOverlap;
  if (manifest.hasOverlap) {
    keepButton.textContent = 'Mantener existentes y agregar nuevos';
    const descriptions = manifest.files.filter(file => file.overlapRange).map(file =>
      `${file.locationLabel ? file.locationLabel + ' · ' : ''}${FIELD_LABELS[file.field] || file.field}: ${formatDetectedRange(file.overlapRange)}`);
    overlapNotice.textContent = `Ya existen datos para ${descriptions.join(' · ')}. Puedes mantenerlos y agregar únicamente registros no repetidos, o reemplazar completamente la información de esos días con la nueva carga.`;
    document.getElementById('transaction-confirmation-copy').textContent =
      sharedMercadoPago
        ? 'Los registros se asignarán automáticamente a cada cafetería por STORE_ID. Elige si reemplazar los días coincidentes o mantener los existentes y agregar solo los nuevos.'
        : 'Revisa el rango y elige qué hacer con los días que coinciden con datos ya guardados.';
  } else {
    keepButton.textContent = sharedMercadoPago ? 'Agregar registros nuevos' : 'Confirmar y guardar registros';
    overlapNotice.textContent = '';
    document.getElementById('transaction-confirmation-copy').textContent =
      sharedMercadoPago
        ? 'Los registros se asignarán automáticamente a cada cafetería por STORE_ID. No hay días coincidentes; guarda para agregar los registros nuevos.'
        : 'No se encontraron fechas coincidentes. Confirma el rango para agregar estos registros al sistema.';
  }
  if (noAssociatedRows) document.getElementById('transaction-confirmation-copy').textContent = 'No hay registros asociados a nuestras cafeterías para cargar. Revisa el resumen y cierra esta ventana.';
  setStatus(document.getElementById('transaction-confirmation-status'), '');
  if (openDialog) confirmation.showModal();
}

async function renderMasterList() {
  const container = document.getElementById('master-list');
  if (!container) return;
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

window.addEventListener('brewit-masters-updated', () => renderMasterList());

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

function openLatestMasterPreview(field, label) {
  openSpreadsheetPreview(async () => {
    const index = await apiRequest('/api/masters');
    const records = Object.entries(index).flatMap(([version, group]) =>
      Object.entries(group).filter(([key]) => (LEGACY_MASTER_FIELDS[key] || key) === field)
        .map(([key, record]) => ({ version, key, record })));
    records.sort((a, b) => String(b.record.savedAt || b.version).localeCompare(String(a.record.savedAt || a.version)));
    const latest = records[0];
    if (!latest) throw new Error('Aún no hay un archivo disponible para este maestro.');
    return `/api/masters/${encodeURIComponent(latest.version)}/${encodeURIComponent(latest.key)}/preview`;
  }, label);
}

async function openSpreadsheetPreview(endpoint, fallbackTitle, ids = {}) {
  const dialog = document.getElementById(ids.dialog || 'master-preview-dialog');
  const title = document.getElementById(ids.title || 'master-preview-title');
  const content = document.getElementById(ids.content || 'master-preview-content');
  title.textContent = fallbackTitle;
  content.textContent = 'Cargando vista previa…';
  dialog.showModal();
  try {
    const preview = await apiRequest(typeof endpoint === 'function' ? await endpoint() : endpoint);
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

function reducedKardexReport() {
  const state = inventoryKardexTableState;
  if (!state?.report) return null;
  const labels = ['Jerarquía', 'Código', 'Producto', 'Unidad', 'Costo Unitario',
    'Inventario Final Teórico', 'Inventario Físico', 'Diff de inventario', 'Costo Total',
    'Valor Inventario Final Teórico', 'Valor Inventario Final Físico'];
  const columns = [...state.columns.slice(0, 5), ...state.columns.slice(-6)]
    .map((column, index) => ({ ...column, label: labels[index] }));
  return { columns, items: state.visibleItems || [], state };
}

async function exportKardexMovements(format) {
  const state = inventoryKardexTableState;
  if (!state?.report) return;
  const status = document.getElementById('inventory-kardex-export-status');
  const buttons = ['inventory-kardex-movements-pdf', 'inventory-kardex-daily-xlsx'].map(id => document.getElementById(id));
  buttons.forEach(button => { button.disabled = true; });
  setStatus(status, 'Preparando movimientos del período…');
  try {
    if (!state.detailReportId) throw new Error('Vuelve a procesar el informe para exportar sus movimientos.');
    if (format === 'pdf' && !window.jspdf?.jsPDF) throw new Error('No fue posible cargar el generador de archivos PDF.');
    if (format === 'xlsx' && !window.XLSX) throw new Error('No fue posible cargar el generador de archivos Excel.');
    const report = await apiRequest(`/api/inventory/movement-report?${new URLSearchParams({ report: state.detailReportId })}`);
    const period = `${report.dateFrom}-${report.dateTo}`;
    if (format === 'xlsx') {
      writeConfiguredExcelWorkbook(KardexMovementExport.workbook(report, XLSX), inventoryReportFilename(`Kardex diario ${report.location} ${period}`, 'xlsx'));
    } else {
      KardexMovementExport.pdf(report, window.jspdf.jsPDF, exportDecimalSystem).save(inventoryReportFilename(`Kardex movimientos por producto ${report.location} ${period}`, 'pdf'));
    }
    setStatus(status, format === 'xlsx' ? 'Excel generado con los productos con inventario inicial o final mayor que cero, o con entradas o salidas. Cantidades con 2 decimales.' : 'PDF generado con los productos que tuvieron al menos una entrada y una salida.', 'success');
  } catch (error) { setStatus(status, error.message, 'error'); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

function exportReducedKardexReport() {
  const reduced = reducedKardexReport();
  if (!reduced) return;
  const status = document.getElementById('inventory-source-status');
  if (!window.XLSX) return setStatus(status, 'No fue posible cargar el generador de archivos Excel.', 'error');
  try {
    const { columns, items } = reduced;
    const rows = [columns.map(column => column.label), ...items.map(item => columns.map((column, index) => {
      if (index < 4) return column.value(item);
      // Keep unavailable values explicit and available quantities numeric in Excel.
      const displayed = column.value(item);
      const value = column.sortValue(item);
      return typeof value === 'number' && Number.isFinite(value) && !/Sin |No comparable/.test(displayed) ? value : displayed;
    }))];
    rows.push(columns.map((column, index) => index === 0 ? 'TOTAL' : column.totalValue
      ? items.reduce((sum, item) => sum + (Number.isFinite(column.sortValue(item)) ? column.sortValue(item) : 0), 0) : ''));
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!brewitColumnNumberFormats'] = Object.fromEntries(columns.slice(4).map((_, index) =>
      [index + 4, { decimalPlaces: 2 }]));
    sheet['!brewitNumberFormat'] = '#,##0.00';
    sheet['!brewitTextColumns'] = [0, 1, 2, 3];
    sheet['!brewitInventoryStyle'] = { boldColumns: [0, 1, 2], hasTotalRow: true, freezeColumns: 4 };
    sheet['!cols'] = [52, 14, 45, 10, 18, 26, 22, 24, 20, 34, 34].map(wch => ({wch}));
    sheet['!autofilter'] = {ref: XLSX.utils.encode_range({r:0,c:0}, {r:items.length,c:10})};
    const workbook = XLSX.utils.book_new();
    workbook.Props = {Title: 'Consolidado del Kardex resumido', Subject: `${reduced.state.location?.name || ''} · ${document.getElementById('inventory-report-period').textContent}`};
    XLSX.utils.book_append_sheet(workbook, sheet, 'Kardex resumido');
    writeConfiguredExcelWorkbook(workbook, inventoryReportFilename('Consolidado del Kardex resumido', 'xlsx'));
  } catch (error) { setStatus(status, error.message, 'error'); }
}

function printReducedKardexReport() {
  const reduced = reducedKardexReport();
  if (!reduced) return;
  const section = document.createElement('section');
  section.id = 'inventory-kardex-reduced-report';
  const head = document.createElement('div'); head.className = 'inventory-results-head';
  const title = document.createElement('h3'); title.textContent = 'Consolidado del Kardex resumido'; head.append(title);
  const context = document.createElement('p');
  context.textContent = `${reduced.state.location?.name || ''} · ${document.getElementById('inventory-report-period').textContent} · ${reduced.items.length} de ${reduced.state.report.items.length} filas, según los filtros y el orden del consolidado.`;
  const table = document.createElement('table'); table.className = 'inventory-results-table';
  const thead = table.createTHead(), tbody = table.createTBody(), tfoot = table.createTFoot();
  const header = thead.insertRow();
  reduced.columns.forEach(column => { const cell = document.createElement('th'); cell.textContent = column.label; header.append(cell); });
  reduced.items.forEach(item => {
    const row = tbody.insertRow();
    reduced.columns.forEach(column => { row.insertCell().textContent = column.value(item); });
  });
  const total = tfoot.insertRow();
  reduced.columns.forEach((column, index) => { total.insertCell().textContent = index === 0 ? 'TOTAL' : column.totalValue?.(reduced.items) || ''; });
  const note = document.createElement('p');
  renderKardexTotalsNote(note, reduced.items, reduced.state.report);
  section.append(head, context, table, note);
  document.getElementById('inventory-workspace').append(section);
  const dialog = document.getElementById('inventory-report-results');
  const reopen = dialog.open;
  if (reopen) dialog.close();
  try { printInventoryReport(section.id); }
  finally { section.remove(); if (reopen) dialog.showModal(); }
}

function excelSheetLabel(table, index) {
  if (table.id === 'inventory-other-consumables-table') return 'Otros Consumibles';
  if (table.id === 'inventory-executive-summary-table') return 'Resumen ejecutivo';
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
      ['Alcance de las fuentes', section.querySelector('#inventory-report-provenance:not([hidden])')?.textContent || 'Archivos cargados'],
      ['Exportado', new Date().toLocaleString('es-CL')]
    ]);
    const currentInventory = sectionId === 'current-inventory-results';
    if (!currentInventory) XLSX.utils.book_append_sheet(workbook, information, 'Información');
    const usedNames = new Set(['Información']);
    if (sectionId === 'inventory-report-results' && inventoryProcessedProvenance?.mode === 'originals') {
      for (const [name, rows] of [['Productos excluidos', inventoryProcessedProvenance.excluded], ['Incidencias de captura', inventoryProcessedProvenance.issues]]) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
        usedNames.add(name);
      }
    }
    const tables = [...section.querySelectorAll('table')].filter(table => !table.closest('[hidden]'));
    tables.forEach((table, index) => {
      const sheet = currentInventory
        ? currentInventoryExcelSheet(table.id === 'current-inventory-missing-cost-table')
        : XLSX.utils.table_to_sheet(table, { raw: true });
      if (['inventory-results-table', 'inventory-other-consumables-table'].includes(table.id)) {
        sheet['!brewitNumberFormat'] = '#,##0.00';
        sheet['!brewitInventoryStyle'] = { boldColumns: [0, 1, 2], hasTotalRow: true, freezeColumns: 4 };
        sheet['!brewitTextColumns'] = [0, 1, 2, 3];
        const range = XLSX.utils.decode_range(sheet['!ref']);
        sheet['!cols'] = Array.from({ length: range.e.c + 1 }, (_, column) => ({ wch: [52, 14, 45, 10][column] || 26 }));
        sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: Math.max(0, range.e.r - 1), c: range.e.c }) };
      }
      XLSX.utils.book_append_sheet(workbook, sheet, uniqueExcelSheetName(excelSheetLabel(table, index), usedNames));
    });
    if (currentInventory) XLSX.utils.book_append_sheet(workbook, information, 'Información');
    writeConfiguredExcelWorkbook(workbook, inventoryReportFilename(title, 'xlsx'));
    setStatus(status, 'Reporte exportado a Excel correctamente.', 'success');
  } catch (error) {
    setStatus(status, `No fue posible exportar el reporte: ${error.message}`, 'error');
  }
}

function currentInventoryExcelSheet(missingCost = false) {
  const items = (currentInventoryTableState?.visibleItems || [])
    .filter(item => !item.costAvailable === missingCost)
    .slice().sort((a, b) => (a.hierarchyPath || []).join(' › ').localeCompare((b.hierarchyPath || []).join(' › '), 'es')
      || a.code.localeCompare(b.code, 'es', { numeric: true }));
  const headers = ['Jerarquía', 'Código', 'Producto', 'Unidad', 'Inventario teórico',
    'Inventario físico', 'Costo unitario', 'Origen costo', 'Valorización'];
  const rows = items.map(item => [
    (item.hierarchyPath || []).join(' › ') || 'Sin jerarquía', String(item.code), item.name, item.unit,
    item.quantity, item.physicalInventory ?? 'Sin toma física',
    item.costAvailable ? item.unitCost : 'Sin costo', costSourceShort(item),
    item.costAvailable ? item.valuation : 'Sin costo'
  ]);
  const total = missingCost ? 'Sin valorizar' : items.reduce((sum, item) => sum + (Number(item.valuation) || 0), 0);
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows,
    [missingCost ? 'TOTAL SIN COSTO' : 'TOTAL VALORIZADO', '', '', '', '', '', '', '', total]]);
  sheet['!cols'] = [565, 101, 300, 54, 118, 103, 100, 138, 90].map(wpx => ({ wpx }));
  sheet['!autofilter'] = { ref: `A1:I${rows.length + 1}` };
  const decimalPlaces = 2;
  sheet['!brewitColumnNumberFormats'] = {
    4: { decimalPlaces }, 5: { decimalPlaces }, 6: { integer: true }, 8: { integer: true }
  };
  sheet['!brewitTextColumns'] = [0, 1, 2, 3, 7];
  sheet['!brewitInventoryStyle'] = true;
  // Excel number formats use canonical separators; Excel displays them using
  // the spreadsheet application's locale (35,00 / 25.517 in Spanish).
  for (let row = 1; row <= rows.length + 1; row++) {
    for (const column of [4, 5, 6, 8]) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell?.t === 'n') cell.z = column === 4 || column === 5 ? '#,##0.00' : '#,##0';
    }
  }
  return sheet;
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
  organizeWorkspaceNavigation();
  initializeFontScale();
  initializeSidebarToggle();
  initializeFinancialGeneralExpensesPanel();
  initializeIntradayBlockOptions();
  document.body.appendChild(document.getElementById('report-chart-dialog'));
  installReportChartButtons();
  initializeAnalyticalTableCharts();
  initializePurchaseProjectionStickyColumns();
  document.getElementById('weekly-report').addEventListener('click', event => {
    const button = event.target.closest('[data-report-chart]');
    if (button && !button.disabled) openReportChart(button.dataset.reportChart);
  });
  document.getElementById('report-chart-close').addEventListener('click', () => {
    document.getElementById('report-chart-dialog').close();
  });
  document.getElementById('report-chart-dialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.getElementById('report-chart-metric').addEventListener('change', updateReportChartDialog);
  document.getElementById('report-chart-type-options').addEventListener('click', event => {
    const button = event.target.closest('[data-chart-type]');
    if (!button || button.hidden) return;
    activeReportChartType = button.dataset.chartType;
    updateReportChartDialog();
  });
  syncHourlyDemandControls();
  const financialToday = browserIsoToday();
  document.getElementById('financial-results-to').value = financialToday;
  document.getElementById('financial-results-from').value = offsetIsoDate(financialToday, -29);
  syncFinancialResultsPeriod();
  syncFinancialResultsPeriod('financial-costs');
  Object.keys(salesReportDefinitions).forEach(prefix => syncFinancialResultsPeriod(prefix));
  document.getElementById('financial-general-expenses-year').value = financialToday.slice(0, 4);
  document.body.appendChild(document.getElementById('date-confirmation'));
  document.querySelectorAll('.nav-link').forEach(link => {
    const linkLabel = link.querySelector('.nav-text')?.textContent.trim() || '';
    link.title = linkLabel;
    link.setAttribute('aria-label', linkLabel);
    link.addEventListener('click', event => {
      event.preventDefault();
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
  await loadFinancialGeneralExpenses().catch(() => {});
  if (typeof initializeDemandView === 'function') {
    await initializeDemandView(Object.values(locationRegistry).filter(location => location.type === 'store'));
  }
  syncTransactionAuditPeriod();
  setView(document.querySelector('.nav-link.active')?.dataset.view || 'report');

  document.getElementById('transaction-audit-period').addEventListener('change', syncTransactionAuditPeriod);
  document.getElementById('transaction-audit-filters').addEventListener('submit', event => {
    event.preventDefault();
    loadTransactionAudit();
  });
  document.getElementById('transaction-audit-clear').addEventListener('click', () => {
    document.getElementById('transaction-audit-location').value = 'all';
    document.getElementById('transaction-audit-period').value = 'last-30';
    ['transaction-audit-min-amount', 'transaction-audit-max-amount', 'transaction-audit-min-discount', 'transaction-audit-max-discount']
      .forEach(id => { document.getElementById(id).value = ''; });
    syncTransactionAuditPeriod();
    loadTransactionAudit();
  });
  document.querySelectorAll('[data-audit-sort]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.auditSort;
      transactionAuditSort = transactionAuditSort.key === key
        ? { key, direction: transactionAuditSort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: ['locationName', 'orderReference'].includes(key) ? 'asc' : 'desc' };
      renderTransactionAuditTable();
    });
  });


  document.querySelectorAll('#weekly-upload-form input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      transactionUploadContext = { source: 'uploads', statusId: 'week-status', location: document.getElementById('location-select').value };
      inspectSelectedTransactionFile(input);
    });
  });
  document.getElementById('weekly-upload-form')?.addEventListener('submit', event => event.preventDefault());

  document.getElementById('transaction-delete-confirmation').addEventListener('input', event => {
    document.getElementById('confirm-transaction-delete').disabled = !!pendingTransactionDelete?.deleting || event.target.value.trim() !== 'ELIMINAR';
  });
  document.getElementById('confirm-transaction-delete').addEventListener('click', confirmTransactionDeletion);
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

  document.getElementById('master-upload-form')?.addEventListener('submit', event => {
    event.preventDefault();
    uploadMasterFiles(false);
  });
  document.getElementById('replace-master-btn')?.addEventListener('click', () => uploadMasterFiles(true));
  document.getElementById('cancel-master-btn')?.addEventListener('click', () => {
    document.getElementById('master-upload-form').reset();
    hideMasterConflict();
    setStatus(document.getElementById('master-status'), 'Carga cancelada.', 'muted');
  });
  document.getElementById('master-upload-form')?.addEventListener('change', () => {
    hideMasterConflict();
  });
  document.getElementById('close-master-preview').addEventListener('click', () => {
    document.getElementById('master-preview-dialog').close();
  });
  document.getElementById('report-location-filter').addEventListener('change', loadWeeklySalesReport);
  document.getElementById('report-view-filter').addEventListener('change', changeReportView);
  document.getElementById('report-include-today').addEventListener('change', loadWeeklySalesReport);
  for (const prefix of Object.keys(salesReportDefinitions)) {
    document.getElementById(`${prefix}-filters`).addEventListener('submit', event => {
      event.preventDefault();
      loadSalesReport(prefix);
    });
    document.getElementById(`${prefix}-period`).addEventListener('change', () => syncFinancialResultsPeriod(prefix));
    for (const id of salesReportFilterIds(prefix)) {
      document.getElementById(id).addEventListener('change', () => markSalesReportDirty(prefix));
    }
  }
  for (const [prefix, calculation, kind] of [['financial-results', 'financial', 'statement'], ['financial-costs', 'financialCosts', 'costs']]) {
    document.getElementById(`${prefix}-filters`).addEventListener('submit', event => {
      event.preventDefault(); loadFinancialResults(kind);
    });
    document.getElementById(`${prefix}-period`).addEventListener('change', () => syncFinancialResultsPeriod(prefix));
    for (const field of ['location', 'period', 'from', 'to']) {
      document.getElementById(`${prefix}-${field}`).addEventListener('change', () => invalidateCalculation(calculation, `${prefix}-status`));
    }
  }
  document.getElementById('financial-general-expenses-location').addEventListener('change', loadFinancialGeneralExpenses);
  document.getElementById('financial-general-expenses-year').addEventListener('change', loadFinancialGeneralExpenses);
  document.getElementById('financial-general-expenses-form').addEventListener('submit', event => {
    event.preventDefault();
    saveFinancialGeneralExpenses();
  });
  document.getElementById('run-findings').addEventListener('click', loadFindingsView);
  document.getElementById('findings-status-filter').addEventListener('change', renderFindingsView);
  document.getElementById('print-findings').addEventListener('click', printFindingsReport);
  document.getElementById('run-sales-ingredients').addEventListener('click', loadSalesIngredientsView);
  document.getElementById('clear-sales-ingredients').addEventListener('click', () => {
    selectedSalesAnalysis.clear();
    collapsedSalesAnalysisGroups.clear();
    renderSalesAnalysisPickers();
    updateSalesAnalysisSelectionCount();
    markSalesReportDirty('sales-ingredients');
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
      markSalesReportDirty('sales-ingredients');
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
  document.getElementById('sales-hierarchy-back').addEventListener('click', () => {
    salesHierarchyPath = salesHierarchyPath.slice(0, -1);
    renderSalesInsights();
  });
  document.getElementById('refresh-hourly-demand').addEventListener('click', loadHourlySalesDemand);
  document.getElementById('generate-hourly-analysis').addEventListener('click', openHourlyAnalysisOptions);
  document.getElementById('hourly-analysis-dialog').addEventListener('click', event => {
    if (event.target.closest('.cv-help-trigger')) document.getElementById('hourly-cv-help').showModal();
  });
  document.getElementById('hourly-analysis-options-dialog').addEventListener('click', event => {
    const option = event.target.closest('[data-hourly-analysis-level]');
    if (option) loadHourlyAnalysis(option.dataset.hourlyAnalysisLevel);
  });
  document.getElementById('close-hourly-analysis-options').addEventListener('click', () => {
    document.getElementById('hourly-analysis-options-dialog').close();
  });
  document.getElementById('hourly-demand-mode').addEventListener('change', syncHourlyDemandControls);
  for (const id of hourlyReportFilterIds) {
    document.getElementById(id).addEventListener('change', () => {
      if (['hourly-demand-from', 'hourly-demand-to'].includes(id)) {
        const mode = document.getElementById('hourly-demand-mode');
        if (mode.value === 'date') syncHourlyDemandControls();
        else if (!['same-weekday', 'weekdays'].includes(mode.value)) mode.value = 'custom';
      }
      if (id === 'hourly-demand-occurrences') syncHourlyDemandControls();
      markHourlyReportDirty();
    });
  }

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
  document.getElementById('cost-review-location').addEventListener('change', () => invalidateCalculation('costs', 'cost-review-status'));
  document.getElementById('cost-review-date').addEventListener('change', () => invalidateCalculation('costs', 'cost-review-status'));
  document.getElementById('refresh-cost-review').addEventListener('click', loadCostReview);
  document.getElementById('cost-review-type').addEventListener('change', renderCostReview);
  document.getElementById('cost-review-state').addEventListener('change', renderCostReview);
  document.getElementById('cost-review-search').addEventListener('input', renderCostReview);
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
    invalidateCalculation('ingredients', 'ingredients-status');
  });
  document.getElementById('ingredients-date-from').addEventListener('change', () => invalidateCalculation('ingredients', 'ingredients-status'));
  document.getElementById('ingredients-date-to').addEventListener('change', () => invalidateCalculation('ingredients', 'ingredients-status'));
  document.getElementById('ingredients-supplier-filter').addEventListener('change', renderIngredientsView);
  document.getElementById('ingredients-search').addEventListener('input', renderIngredientsView);
  document.getElementById('ingredients-only-changed').addEventListener('change', renderIngredientsView);
  document.getElementById('ingredients-ranking-limit').addEventListener('change', renderIngredientsView);
  document.getElementById('refresh-ingredients').addEventListener('click', loadIngredientsView);
  document.getElementById('print-ingredients-report').addEventListener('click', printIngredientsReport);
  document.getElementById('export-ingredients-report').addEventListener('click', exportIngredientsReport);
  document.getElementById('export-ingredient-yields-report').addEventListener('click', exportIngredientYieldsReport);
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
    invalidateCalculation('purchases', 'purchases-status');
  });
  for (const id of ['purchases-supplier-filter', 'purchases-product-filter', 'purchases-date-from', 'purchases-date-to']) {
    document.getElementById(id).addEventListener('change', () => invalidateCalculation('purchases', 'purchases-status'));
  }
  document.getElementById('refresh-purchases').addEventListener('click', loadPurchasesView);
  document.getElementById('purchases-groups').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchasesSort, header.dataset.sortKey,
      ['quantity', 'unitsPerPurchaseUnit', 'listedUnitPrice', 'baseUnitCost', 'discount', 'effectiveUnitPrice', 'comparisonUnitCost', 'previousEffectiveUnitPrice', 'priceChangePercent', 'totalAmount'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
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
  document.getElementById('projection-location-filter').addEventListener('change', resetPurchaseProjection);
  document.getElementById('projection-supplier-filter').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-required').addEventListener('change', renderPurchaseProjection);
  document.getElementById('projection-only-managed').addEventListener('change', renderPurchaseProjection);
  document.getElementById('refresh-purchase-projection').addEventListener('click', loadPurchaseProjection);
  document.getElementById('open-ingredient-purchase-master').addEventListener('click', openIngredientPurchaseMaster);
  document.getElementById('show-all-projection-ingredients').addEventListener('click', () => {
    document.getElementById('projection-only-required').checked = false;
    document.getElementById('projection-only-managed').checked = false;
    document.getElementById('projection-supplier-filter').value = 'all';
    renderPurchaseProjection();
  });
  document.getElementById('close-ingredient-purchase-master').addEventListener('click', () => {
    document.getElementById('ingredient-purchase-master-dialog').close();
  });
  document.getElementById('ingredient-purchase-master-dialog').addEventListener('cancel', event => {
    if (event.currentTarget.dataset.saving === 'true') event.preventDefault();
  });
  document.getElementById('ingredient-purchase-master-dialog').addEventListener('close', () => {
    ingredientPurchaseMasterRequest += 1;
  });
  document.getElementById('ingredient-purchase-master-search').addEventListener('input', renderIngredientPurchaseMaster);
  document.getElementById('ingredient-purchase-master-body').addEventListener('input', editIngredientPurchaseMaster);
  document.getElementById('ingredient-purchase-master-body').addEventListener('change', editIngredientPurchaseMaster);
  document.getElementById('save-ingredient-purchase-master').addEventListener('click', saveIngredientPurchaseMaster);
  ['pdf', 'csv', 'xlsx'].forEach(format => {
    document.getElementById(`ingredient-purchase-master-${format}`).addEventListener('click', () => exportIngredientPurchaseMaster(format));
  });
  document.getElementById('purchase-projection-body').addEventListener('click', event => {
    const button = event.target.closest('button[data-local-detail]');
    if (button) openProjectionLocalDetail(button.closest('tr[data-key]').dataset.key, button.dataset.localDetail);
  });
  document.getElementById('close-projection-local-detail').addEventListener('click', () => {
    document.getElementById('projection-local-detail-dialog').close();
  });
  document.getElementById('configure-consumption-reference').addEventListener('click', openConsumptionReferenceConfiguration);
  document.getElementById('cancel-consumption-reference').addEventListener('click', () => {
    document.getElementById('consumption-reference-dialog').close();
  });
  document.getElementById('consumption-reference-dialog').addEventListener('cancel', event => {
    if (event.currentTarget.dataset.saving === 'true') event.preventDefault();
  });
  ['consumption-reference-enabled', 'consumption-reference-source', 'consumption-reference-curve'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderConsumptionReferenceConfiguration);
  });
  document.getElementById('save-consumption-reference').addEventListener('click', saveConsumptionReferenceConfiguration);
  document.getElementById('open-projection-purchase-orders').addEventListener('click', openProjectionPurchaseOrders);
  document.getElementById('cancel-projection-purchase-orders').addEventListener('click', () => {
    document.getElementById('projection-purchase-orders-dialog').close();
  });
  document.getElementById('apply-projection-purchase-orders').addEventListener('click', applyProjectionPurchaseOrders);
  document.querySelector('.purchase-projection-table thead').addEventListener('click', event => {
    const header = event.target.closest('th[data-sort-key]');
    if (!header) return;
    applySort(purchaseProjectionSort, header.dataset.sortKey,
      ['managed', 'unitsPerPackage', 'currentInventory', 'localsInventory', 'totalInventory', 'localsDailyConsumption', 'consumption30', 'ownAverageDailyConsumption', 'projectedAverageDailyConsumption', 'averageDailyConsumption', 'currentCoverageDays', 'minDays', 'maxDays', 'suggestedInternalQuantity', 'suggestedConsumptionQuantity', 'coverageAfterSuggestionDays', 'unitsPerPurchaseUnit', 'suggestedPurchaseUnits', 'estimatedPurchaseUnitCost', 'estimatedTotal'].includes(header.dataset.sortKey) ? 'desc' : 'asc');
    renderPurchaseProjection();
  });
  document.getElementById('save-projection-policies').addEventListener('click', savePurchaseProjectionPolicies);
  document.getElementById('open-copy-projection-policies').addEventListener('click', openCopyProjectionPolicies);
  document.getElementById('cancel-copy-projection-policies').addEventListener('click', () => {
    document.getElementById('copy-projection-policies-dialog').close();
  });
  document.getElementById('copy-projection-policies-source').addEventListener('change', event => {
    document.getElementById('confirm-copy-projection-policies').disabled = !event.target.value;
  });
  document.getElementById('confirm-copy-projection-policies').addEventListener('click', copyProjectionPolicies);
  document.getElementById('copy-projection-policies-dialog').addEventListener('cancel', event => {
    if (event.currentTarget.dataset.copying === 'true') event.preventDefault();
  });
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
  document.getElementById('load-tentative-supplier-items').addEventListener('click', () => { void loadTentativeSupplierItems(); });
  document.getElementById('tentative-orders-other-body').addEventListener('click', event => {
    const button = event.target.closest('button[data-tentative-add]');
    if (button) addTentativeSupplierItem(button.dataset.tentativeAdd);
  });
  document.getElementById('tentative-orders-buying-body').addEventListener('input', updateTentativeOrderTotals);
  document.getElementById('tentative-orders-buying-body').addEventListener('change', event => {
    if (event.target.matches('.tentative-order-cost')) {
      const value = roundedPurchaseOrderCost(parseLocalizedNumber(event.target.value));
      if (Number.isFinite(value)) event.target.value = formatPurchaseOrderCost(value);
    }
    updateTentativeOrderTotals();
  });
  document.getElementById('confirm-tentative-purchase-order').addEventListener('click', confirmTentativePurchaseOrder);
  document.getElementById('print-confirmed-tentative-order').addEventListener('click', () => {
    const group = currentTentativeOrderGroup();
    if (group?.confirmedOrder) printPurchaseOrder(group.confirmedOrder);
  });
  document.getElementById('show-hidden-purchase-orders').addEventListener('change', () => {
    const cached = pastPurchaseOrdersCache.get(document.getElementById('projection-location-filter').value);
    if (cached) renderPastPurchaseOrders(cached);
    else openPastPurchaseOrders();
  });
  document.getElementById('close-purchase-order-editor').addEventListener('click', () => {
    document.getElementById('purchase-order-editor-dialog').close();
  });
  document.getElementById('close-past-purchase-orders').addEventListener('click', () => {
    document.getElementById('past-purchase-orders-dialog').close();
  });
  document.getElementById('purchase-order-editor-body').addEventListener('input', updatePurchaseOrderEditorTotals);
  document.getElementById('purchase-order-editor-body').addEventListener('change', event => {
    if (event.target.matches('.purchase-order-select') && event.target.checked) {
      const row = event.target.closest('tr[data-key]');
      const quantity = row?.querySelector('.purchase-order-quantity');
      const item = purchaseOrderEditorState?.items.find(candidate => candidate.key === row?.dataset.key);
      if (quantity && !(Number(quantity.value) > 0)) {
        quantity.value = String(Number(item?.suggestedPurchaseUnits) > 0 ? item.suggestedPurchaseUnits : item?.unitsPerPackage || 1);
      }
    }
    if (event.target.matches('.purchase-order-cost')) {
      event.target.value = formatPurchaseOrderCost(roundedPurchaseOrderCost(parseLocalizedNumber(event.target.value)));
    }
    updatePurchaseOrderEditorTotals();
  });
  document.getElementById('purchase-order-show-all-supplier-items').addEventListener('change', event => {
    void showAllPurchaseOrderSupplierItems(event.target.checked);
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
  document.getElementById('current-inventory-report').addEventListener('click', openCurrentInventoryDateDialog);
  document.getElementById('confirm-current-inventory-report').addEventListener('click', generateCurrentInventoryReport);
  for (const id of ['close-current-inventory-date-dialog', 'cancel-current-inventory-date-dialog']) {
    document.getElementById(id).addEventListener('click', () => {
      document.getElementById('current-inventory-date-dialog').close();
    });
  }
  document.getElementById('process-original-inventory-report').addEventListener('click', async () => {
    const button = document.getElementById('process-original-inventory-report');
    const location = document.getElementById('inventory-location-select').value;
    button.disabled = true;
    try {
      await openInventoryProcessDialog();
    } catch (error) { setStatus(document.getElementById('inventory-source-status'), error.message, 'error'); }
    finally { button.disabled = false; }
  });
  for (const kind of ['initial','final']) document.getElementById(`inventory-${kind}-date`).addEventListener('input',()=>{inventoryCalendarMonths[kind]=document.getElementById(`inventory-${kind}-date`).value.slice(0,7);syncInventoryBoundaries();});
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
  for (const id of ['current-inventory-physical-filter', 'current-inventory-theoretical-filter']) {
    document.getElementById(id).addEventListener('change', renderCurrentInventoryTables);
  }
  document.getElementById('current-inventory-value-filter').addEventListener('change', renderCurrentInventoryTables);
  document.getElementById('current-inventory-decimals').addEventListener('change', renderCurrentInventoryTables);
  document.getElementById('clear-current-inventory-search').addEventListener('click', () => {
    clearCurrentInventoryFilters();
    renderCurrentInventoryTables();
  });
  document.getElementById('inventory-kardex-search').addEventListener('input', renderInventoryKardexTable);
  for (const id of ['inventory-kardex-physical-filter', 'inventory-kardex-theoretical-filter']) {
    document.getElementById(id).addEventListener('change', renderInventoryKardexTable);
  }
  document.getElementById('inventory-kardex-cost-filter').addEventListener('change', renderInventoryKardexTable);
  document.getElementById('inventory-kardex-decimals').addEventListener('change', renderInventoryKardexTable);
  document.getElementById('inventory-kardex-reduced-pdf').addEventListener('click', printReducedKardexReport);
  document.getElementById('inventory-kardex-reduced-xlsx').addEventListener('click', exportReducedKardexReport);
  document.getElementById('inventory-kardex-movements-pdf').addEventListener('click', () => exportKardexMovements('pdf'));
  document.getElementById('inventory-kardex-daily-xlsx').addEventListener('click', () => exportKardexMovements('xlsx'));
  document.getElementById('clear-inventory-kardex-filters').addEventListener('click', () => {
    document.getElementById('inventory-kardex-search').value = '';
    document.getElementById('inventory-kardex-cost-filter').value = 'all';
    document.getElementById('inventory-kardex-physical-filter').value = 'all';
    document.getElementById('inventory-kardex-theoretical-filter').value = 'all';
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
    uploadWorkspace.open(location, 'inventory');
    if (locationRegistry[location]) {
      document.getElementById('location-select').value = location;
      if (document.getElementById('weekly-upload-form')) updateLocationFields();
    }
  });

  document.getElementById('create-location-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    window.brewitSettings?.setBusy(form, true);
    try {
      const created = await apiRequest('/api/config/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('new-location-name').value,
          address: document.getElementById('new-location-address').value,
          type: document.getElementById('new-location-type').value,
          toteatRestaurantId: document.getElementById('new-location-toteat-restaurant-id').value,
          toteatLocalId: document.getElementById('new-location-toteat-local-id').value,
          toteatName: document.getElementById('new-location-toteat-name').value,
          toteatSimpleId: document.getElementById('new-location-toteat-simple-id').value
        })
      });
      form.reset();
      window.brewitSettings?.clean(form);
      setStatus(document.getElementById('location-status'), 'Ubicación creada.', 'success');
      await refreshLocationConfiguration();
      window.brewitSettings?.setBusy(form, false);
      window.brewitSettings?.created(created.id);
    } catch (error) {
      setStatus(document.getElementById('location-status'), error.message, 'error');
    } finally {
      button.disabled = false;
      window.brewitSettings?.setBusy(form, false);
    }
  });

  document.getElementById('company-profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    window.brewitSettings?.setBusy(form, true);
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
      window.brewitSettings?.clean('company-profile-form');
      exportDecimalSystem = company.exportDecimalSystem === 'dot' ? 'dot' : 'comma';
      setStatus(document.getElementById('company-profile-status'), 'Datos de Brewit y formato de exportación actualizados.', 'success');
    } catch (error) {
      setStatus(document.getElementById('company-profile-status'), error.message, 'error');
    } finally {
      button.disabled = false;
      window.brewitSettings?.setBusy(form, false);
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


let uploadOverviewBusy = false;
let uploadScheduleDirty = false;
let uploadManualTarget = null;
// Source selection and presentation use the existing overview and persisted job.
const uploadWorkspace = (() => {
  const el = id => document.getElementById(id), selected = new Map();
  let data = null, location = 'all', activeTab = 'status', submitting = false, signature = '', jobId = null;
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  const date = value => value ? new Date(value).toLocaleString('es-CL') : 'Sin actualización guardada';
  const groups = [
    ['sales', 'Ventas y pagos', ['sales', 'payment-details']], ['purchases', 'Compras', ['purchases']],
    ['counts', 'Tomas físicas', ['counts']], ['inventory', 'Movimientos de inventario', ['transformations', 'transfers']],
    ['mercadopago', 'Liquidaciones de MercadoPago', ['mercadopago']], ['marketing', 'Consumo de marketing', ['marketing']],
    ['employees', 'Consumo de colaboradores', ['employees']], ['calibrations', 'Calibraciones y bebidas desechadas', ['calibrations']]
  ];
  const busy = () => submitting || data?.job.running || data?.masterStatus.running || data?.rows.some(row => row.cells.some(cell => cell.running));
  function tab(key, focus = false) {
    activeTab = key;
    document.querySelectorAll('[data-upload-tab]').forEach(button => {
      const active = button.dataset.uploadTab === key;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      el(button.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) button.focus();
    });
    el('upload-filter-bar').hidden = key === 'history';
    if (key === 'history' && [...el('source-history-location').options].some(option => option.value === location)) el('source-history-location').value = location;
  }
  const tabs = [...document.querySelectorAll('[data-upload-tab]')];
  tabs.forEach((button, index) => {
    button.onclick = () => tab(button.dataset.uploadTab);
    button.onkeydown = event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return; event.preventDefault(); tab(tabs[next].dataset.uploadTab, true);
    };
  });
  function summary() {
    el('upload-selection-summary').textContent = selected.size ? `${selected.size} grupo(s): ${[...selected.values()].map(item => item.label).join(' · ')}` : 'Selecciona las fuentes que quieres actualizar.';
    el('upload-refresh-selection').disabled = !selected.size || busy() || !data?.capabilities?.selectedRefresh;
    el('upload-refresh-masters').disabled = !!busy();
    el('upload-select-masters').checked = selected.has('shared:masters');
    el('upload-select-masters').disabled = !!busy() || !data?.capabilities?.selectedRefresh;
  }
  function choose(key, value, checked) { if (checked) selected.set(key, value); else selected.delete(key); summary(); }
  function configure(id) {
    const source = id === 'main-warehouse' ? 'store-1' : id;
    window.brewitSettings?.openIntegration(source);
  }
  function inspect(id, key) {
    const context = window.brewitSettings?.context;
    if (!context) return;
    context.syncLocation = id === 'main-warehouse' ? 'store-1' : id;
    context.syncSource = key === 'purchases' ? 'purchases' : 'sales';
    el('source-sync-location').value = context.syncLocation;
    el('source-sync-location').dispatchEvent(new Event('change'));
    el('source-sync-kind').value = context.syncSource;
    el('source-sync-kind').dispatchEvent(new Event('change'));
    el('source-sync-dialog').showModal();
  }
  function openInventory(id) {
    const source = id === 'main-warehouse' ? 'store-1' : id;
    setView('inventory');
    el('inventory-location-select').value = id;
    el('inventory-location-select').dispatchEvent(new Event('change'));
    el('location-select').value = source;
    el('location-select').dispatchEvent(new Event('change'));
    el('inventory-native-detail').open = true;
    el('inventory-native-detail').scrollIntoView({ block: 'start' });
  }
  function button(label, action) { const b = node('button', label, 'icon-button'); b.type = 'button'; b.onclick = action; return b; }
  async function refresh(targets) {
    if (busy()) return;
    submitting = true; summary();
    setStatus(el('upload-overview-status'), 'Iniciando la actualización de las fuentes seleccionadas…');
    try {
      if (data?.capabilities?.selectedRefresh) {
        await apiRequest('/api/uploads/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }) });
      } else if (targets.length === 1) {
        const target = targets[0];
        if (target.key === 'masters') await apiRequest('/api/integrations/toteat/masters/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'store-1' }) });
        else await apiRequest('/api/uploads/refresh-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: target.location, key: target.key === 'inventory' ? 'transfers' : target.key }) });
      } else throw Error('Reinicia Brewit para activar la actualización de varias fuentes. Las actualizaciones individuales siguen disponibles.');
      targets.forEach(target => selected.delete(`${target.location}:${target.key}`));
      await loadUploadOverview();
      if (!el('upload-refresh-report').hidden) el('upload-refresh-report').scrollIntoView({ block: 'nearest' });
    } catch (error) { setStatus(el('upload-overview-status'), error.message, 'error'); }
    finally { submitting = false; render(); }
  }
  function render() {
    if (!data) return;
    const rows = data.rows.filter(row => location === 'all' ? row.id !== 'main-warehouse' : row.id === location);
    const fingerprint = JSON.stringify([rows, !!busy(), !!data.capabilities?.selectedRefresh, location]);
    if (fingerprint !== signature) {
      signature = fingerprint;
      const focus = document.activeElement?.dataset.uploadFocus;
      const opened = new Set([...el('upload-source-list').querySelectorAll('details[open]')].map(item => item.dataset.detail));
      const cards = [];
      for (const row of rows) {
        const group = node('section', null, 'upload-location-group'); group.append(node('h4', row.name));
        for (const [key, label, keys] of groups) {
          const cells = row.cells.filter(cell => keys.includes(cell.key) && cell.applicable);
          if (!cells.length) continue;
          const source = row.id === 'main-warehouse' ? 'store-1' : row.id;
          const selectable = cells.some(cell => cell.refreshable);
          const target = { location: source, key }, identity = `${source}:${key}`;
          const card = node('article', null, 'upload-source-row'); card.dataset.source = key; card.dataset.location = row.id;
          const heading = node('div', null, 'upload-source-heading');
          if (selectable) {
            const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(identity);
            check.disabled = !!busy() || !data.capabilities?.selectedRefresh; check.setAttribute('aria-label', `Seleccionar ${label} · ${row.name}`); check.dataset.uploadFocus = `select:${row.id}:${key}`;
            check.onchange = () => choose(identity, { ...target, label: `${row.name}: ${label}` }, check.checked);
            heading.append(check);
          }
          heading.append(node('h5', label));
          const errors = [...new Set(cells.map(cell => cell.error).filter(Boolean))];
          const state = cells.some(cell => cell.running) ? 'Actualizando' : errors.length || cells.some(cell => cell.stale) ? 'Requiere revisión' : cells.some(cell => cell.updatedAt) ? 'Datos guardados' : 'Sin datos guardados';
          heading.append(node('span', state, `upload-state${state === 'Requiere revisión' ? ' warning' : ''}`)); card.append(heading);
          const info = node('div', null, 'upload-source-info');
          info.append(node('p', `Última actualización guardada: ${date(cells[0].updatedAt)}`));
          if (key === 'sales') info.append(node('p', 'Incluye dos conjuntos: ventas con detalle por producto y detalle de pagos. Se actualizan juntos.'));
          if (cells[0].coverage) info.append(node('p', `Período informado: ${cells[0].coverage.from} → ${cells[0].coverage.to}`));
          if (cells[0].lastCheck) info.append(node('p', `Última comprobación: ${date(cells[0].lastCheck.finishedAt)}`));
          if (cells.some(cell => cell.sharedFrom)) info.append(node('p', 'Fuente compartida desde La Concepción.'));
          if (key === 'inventory') info.append(node('p', 'Transformaciones y transferencias; la actualización puede incluir tomas vinculadas.'));
          if (errors.length) info.append(node('p', errors.join(' '), 'upload-source-warning'));
          card.append(info);
          const actions = node('div', null, 'settings-actions');
          if (selectable) { const update = button(`Actualizar ${label.toLowerCase()}`, () => refresh([target])); update.disabled = !!busy(); update.dataset.uploadFocus = `refresh:${row.id}:${key}`; actions.append(update); }
          for (const cell of cells) {
            const name = data.columns.find(column => column.key === cell.key)?.label || cell.key;
            const view = button(cell.key === 'sales' ? 'Ver ventas por producto' : cells.length > 1 ? `Ver ${name.toLowerCase()}` : 'Ver registros', () => window.openUploadRecords(row.id, cell.key, `${cell.key === 'sales' ? 'Ventas con detalle por producto' : name} · ${row.name}`));
            view.dataset.uploadFocus = `records:${row.id}:${cell.key}`; actions.append(view);
          }
          if (['sales','purchases'].includes(key)) {
            actions.append(button('Configurar conexión', () => configure(row.id)), button('Ver detalle de carga', () => inspect(row.id, key)));
          } else if (['inventory','counts'].includes(key)) actions.append(button('Abrir Inventario', () => openInventory(row.id)));
          else if (key === 'mercadopago') actions.append(button('Ver actualización web compartida', () => el('upload-mercadopago-web').scrollIntoView({ block: 'start' })));
          else actions.append(button('Cargar archivo', () => { tab('files'); el('upload-manual-actions').scrollIntoView({ block: 'start' }); }));
          [...actions.children].forEach((action, index) => { action.dataset.uploadFocus ||= `action:${row.id}:${key}:${index}`; });
          card.append(actions);
          const detail = node('details'); detail.dataset.detail = `${row.id}:${key}`; detail.open = opened.has(detail.dataset.detail);
          const detailSummary = node('summary', 'Detalle de la fuente'); detailSummary.dataset.uploadFocus = `detail:${row.id}:${key}`; detail.append(detailSummary);
          for (const cell of cells) {
            detail.append(node('p', cell.origin || 'Origen no informado'));
            if (cell.lastHistoricalReview) detail.append(node('p', `Revisión anterior: ${cell.lastHistoricalReview.from} → ${cell.lastHistoricalReview.to} · ${date(cell.lastHistoricalReview.completedAt)}`));
            if (cell.lastFullSuccess) detail.append(node('p', `Última revisión completa: ${date(cell.lastFullSuccess)}`));
            if (cell.lastCheck?.windows) detail.append(node('p', `Ventanas comprobadas: ${cell.lastCheck.windows.map(w => `${w.from} → ${w.to}`).join(', ')}`));
          }
          card.append(detail); group.append(card);
        }
        cards.push(group);
      }
      el('upload-source-list').replaceChildren(...(cards.length ? cards : [node('p', 'No hay fuentes disponibles para esta ubicación.')]));
      if (focus) [...el('upload-source-list').querySelectorAll('[data-upload-focus]')].find(item => item.dataset.uploadFocus === focus)?.focus({ preventScroll: true });
    }
    for (const row of el('upload-manual-actions').querySelectorAll('tbody tr')) {
      const id = row.querySelector('[data-upload-location]')?.dataset.uploadLocation;
      row.hidden = location !== 'all' && id !== location;
    }
    el('upload-manual-empty').hidden = [...el('upload-manual-actions').querySelectorAll('tbody tr')].some(row => !row.hidden);
    const notices = [];
    if (!data.capabilities?.selectedRefresh) notices.push(node('p', 'Reinicia Brewit para activar la selección de varias fuentes. Puedes seguir actualizando cada fuente individualmente.', 'upload-alert'));
    const masters = data.masterStatus;
    if (masters.lastError || /vencida|vencido/i.test(masters.connection || '') || (masters.credentialExpiresAt && Date.parse(masters.credentialExpiresAt) < Date.now())) {
      const notice = node('div', null, 'upload-alert'); notice.append(node('strong', 'Maestros compartidos: revisa la conexión'), node('p', `Última lectura exitosa: ${date(masters.observedAt)}. ${masters.lastError || masters.connection || 'La credencial está vencida.'}`));
      const retry = button('Reintentar actualización de maestros', () => refresh([{ location: 'shared', key: 'masters' }])); retry.disabled = !!busy(); notice.append(retry); notices.push(notice);
    }
    const problems = rows.flatMap(row => row.cells.filter(cell => cell.applicable && (cell.error || cell.stale)).map(cell => `${row.name}: ${data.columns.find(column => column.key === cell.key)?.label || cell.key}`));
    if (problems.length) { const notice = node('details', null, 'upload-alert'); notice.append(node('summary', `${problems.length} fuente(s) requieren revisión`), node('p', problems.join(' · '))); notices.push(notice); }
    el('upload-attention').replaceChildren(...notices);
    el('upload-mode').textContent = data.manualOnly ? 'Actualización manual' : 'Actualización manual y programación disponible';
    if (data.job.id !== jobId) { el('upload-progress-details').open = !!data.job.running; jobId = data.job.id; }
    summary();
  }
  el('upload-location-filter').onchange = event => { location = event.target.value; selected.clear(); render(); };
  el('upload-select-masters').onchange = event => choose('shared:masters', { location: 'shared', key: 'masters', label: 'Maestros compartidos: todas las ubicaciones' }, event.target.checked);
  el('upload-refresh-selection').onclick = () => refresh([...selected.values()].map(({ location, key }) => ({ location, key })));
  el('upload-refresh-masters').onclick = () => refresh([{ location: 'shared', key: 'masters' }]);
  el('source-sync-close').onclick = () => el('source-sync-dialog').close();
  el('upload-open-source-detail').onclick = () => {
    const historyLocation = el('source-history-location').value;
    inspect(historyLocation === 'all' ? window.brewitSettings?.context.syncLocation : historyLocation, 'sales');
  };
  return {
    tab, openInventory, loaded: () => !!data,
    accept(value) {
      data = value;
      const options = [['all','Todas las ubicaciones'], ...data.rows.map(row => [row.id,row.name])];
      const select = el('upload-location-filter');
      if (JSON.stringify([...select.options].map(option => [option.value,option.text])) !== JSON.stringify(options)) select.replaceChildren(...options.map(([id,name]) => new Option(name,id)));
      if (!options.some(([id]) => id === location)) { location = 'all'; selected.clear(); }
      select.value = location;
      for (const [id, target] of selected) if (target.location !== 'shared' && !data.rows.some(row => row.id === target.location)) selected.delete(id);
      render();
    },
    open(id, key) {
      location = id || 'all'; selected.clear();
      if (key === 'masters') selected.set('shared:masters', { location:'shared', key:'masters', label:'Maestros compartidos: todas las ubicaciones' });
      else if (id) selected.set(`${id}:${key}`, { location:id, key, label:`${window.brewitSettings?.getLocation(id)?.name || id}: ${groups.find(group => group[0] === key)?.[1] || key}` });
      tab('status'); if (data) { el('upload-location-filter').value = location; render(); }
    }
  };
})();

async function loadUploadOverview() {
  if (uploadOverviewBusy) return;
  uploadOverviewBusy = true;
  const el = id => document.getElementById(id);
  const date = value => value ? new Date(value).toLocaleString('es-CL') : 'Sin actualizar';
  if (!uploadWorkspace.loaded()) setStatus(el('upload-overview-status'), 'Consultando el estado de las fuentes guardadas…');
  try {
    const data = await apiRequest('/api/uploads/overview');
    el('upload-native-schedule').hidden = !!data.manualOnly;
    const historyLocation = el('source-history-location');
    const selectedHistoryLocation = historyLocation.value;
    historyLocation.replaceChildren(new Option('Todas las cafeterías', 'all'),
      ...data.rows.filter(row => row.type ? row.type === 'store' : row.id !== 'main-warehouse').map(row => new Option(row.name, row.id)));
    if ([...historyLocation.options].some(option => option.value === selectedHistoryLocation)) historyLocation.value = selectedHistoryLocation;
    const cell = (tag, text) => { const e=document.createElement(tag);e.textContent=text;return e; };
    el('upload-master-list').replaceChildren(...data.masters.map(m=>{
      const item=document.createElement('button');item.type='button';item.setAttribute('aria-label',`Ver maestro: ${m.label}`);
      item.append(cell('strong',m.label),cell('span',date(m.updatedAt)));
      item.addEventListener('click',()=>openLatestMasterPreview(m.key,m.label));return item;
    }));
    const manualColumns=data.columns.filter(c=>['marketing','employees','calibrations'].includes(c.key));
    const manualHead=document.createElement('thead'),manualHeader=document.createElement('tr');
    for(const label of ['Local',...manualColumns.map(c=>c.label)]) {
      const th=cell('th',label);th.scope='col';manualHeader.append(th);
    }
    manualHead.append(manualHeader);
    const manualBody=document.createElement('tbody');
    for(const location of data.rows.filter(r=>r.cells.some(c=>c.applicable&&manualColumns.some(m=>m.key===c.key)))) {
      const row=document.createElement('tr'),name=cell('th',location.name);name.scope='row';row.append(name);
      for(const column of manualColumns) {
        const td=document.createElement('td'); td.dataset.label=column.label;
        if(location.cells.some(c=>c.key===column.key&&c.applicable)) {
          const button=cell('button','Cargar archivo');button.type='button';button.className='icon-button';
          button.dataset.uploadLocation=location.id;button.dataset.uploadField=column.key;
          button.setAttribute('aria-label',`Cargar ${column.label} · ${location.name}`);
          button.addEventListener('click',()=>{
            if(inspectionState){document.getElementById('date-confirmation').showModal();return;}
            uploadManualTarget={location:location.id,field:column.key};
            document.getElementById('upload-overview-file').click();
          });td.append(button);
        } else td.textContent='No aplica';
        row.append(td);
      }
      manualBody.append(row);
    }
    if (el('upload-manual-actions').innerHTML !== manualHead.outerHTML + manualBody.outerHTML) el('upload-manual-actions').replaceChildren(manualHead,manualBody);
    const table=el('upload-transaction-matrix'),head=document.createElement('thead'),header=document.createElement('tr');
    header.append(cell('th','Ubicación'),...data.columns.map(c=>cell('th',c.label)));head.append(header);
    const body=document.createElement('tbody');
    for(const location of data.rows){const row=document.createElement('tr');row.append(cell('th',location.name));
      for(const item of location.cells){const td=cell('td',item.applicable?date(item.updatedAt):'No aplica');
        if(item.applicable){
          const label=`${data.columns.find(c=>c.key===item.key).label} · ${location.name}`;
          const open=()=>window.openUploadRecords(location.id,item.key,label);
          td.classList.add('upload-record-cell');td.tabIndex=0;td.setAttribute('aria-label',`Ver registros: ${label}`);
          td.addEventListener('click',event=>{if(!event.target.closest('button'))open();});
          td.addEventListener('keydown',event=>{if(event.target===td&&['Enter',' '].includes(event.key)){event.preventDefault();open();}});
          const view=cell('button','Ver registros');view.type='button';view.className='icon-button';view.setAttribute('aria-label',`Ver registros: ${label}`);view.addEventListener('click',event=>{event.stopPropagation();open();});
          const actions=document.createElement('div');actions.className='upload-record-actions';actions.append(view);
          if(item.refreshable){
            const refresh=cell('button','');refresh.type='button';refresh.className='icon-button upload-source-refresh';
            const related=['sales','payment-details'].includes(item.key)?'Incluye ventas y detalle de pagos.':['transformations','transfers'].includes(item.key)?'Incluye las operaciones de inventario vinculadas.':'';
            refresh.title=`Actualizar ${label}. ${related}${item.sharedFrom?' Fuente compartida con '+item.sharedFrom+'.':''}`;
            refresh.setAttribute('aria-label',refresh.title);
            refresh.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>';
            refresh.disabled=data.job.running || data.masterStatus.running || data.rows.some(r=>r.cells.some(c=>c.running));
            refresh.addEventListener('click',async event=>{
              event.stopPropagation();refresh.disabled=true;
              try{await apiRequest('/api/uploads/refresh-source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:location.id,key:item.key})});await loadUploadOverview();}
              catch(error){setStatus(el('upload-overview-status'),error.message,'error');refresh.disabled=false;}
            });actions.append(refresh);
          }
          td.append(actions);
          td.append(cell('small',`${item.origin}${item.sharedFrom?' · '+item.sharedFrom:''}`));
          if(item.lastCheck)td.append(cell('small',`Última comprobación: ${date(item.lastCheck.finishedAt)} · ${(item.lastCheck.durationMs/1000).toFixed(1)} s · ${item.lastCheck.windows.map(w=>`${w.from}–${w.to}`).join(', ')}`));
          if(item.lastHistoricalReview)td.append(cell('small',`Última revisión anterior: ${item.lastHistoricalReview.from}–${item.lastHistoricalReview.to} · ${date(item.lastHistoricalReview.completedAt)}`));
          if(item.lastFullSuccess)td.append(cell('small',`Última revisión completa: ${date(item.lastFullSuccess)}`));
          if(item.running)td.append(cell('small','Actualizando…'));if(item.error)td.append(cell('small',item.error));
        }row.append(td);
      }body.append(row);
    }table.replaceChildren(head,body);
    el('upload-refresh-schedule').replaceChildren(...data.rows.flatMap(r=>r.schedules.map(s=>cell('div',`${r.name} · ${s.label}: ${s.enabled?'cada '+s.minutes+' minutos':'automático desactivado'}`))),...Object.entries(data.schedule).map(([key,value])=>cell('div',`${key==='masters'?'Maestros compartidos':'Fuentes de inventario'}: ${value.minutes?'cada '+value.minutes+' minutos':'manual'}`)));
    if(!uploadScheduleDirty)for(const key of ['masters','inventory'])el(`upload-${key}-frequency`).value=data.schedule[key].minutes || '';
    el('refresh-upload-api').disabled=data.job.running || data.masterStatus.running || data.rows.some(r=>r.cells.some(c=>c.running));
    el('review-recent-sales-windows').disabled=data.job.running || data.rows.some(r=>r.cells.some(c=>['sales','payment-details'].includes(c.key)&&c.running));
    el('upload-master-connection').textContent = `${data.masterStatus.connection || 'Servicios internos · sesión web'} · Última lectura exitosa: ${date(data.masterStatus.observedAt)} · Último intento fallido: ${date(data.masterStatus.lastFailedAt)}${data.masterStatus.credentialExpiresAt ? ' · Vencimiento de credencial: '+date(data.masterStatus.credentialExpiresAt) : ''}${data.masterStatus.lastError ? ' · '+data.masterStatus.lastError : ''}`;
    el('upload-refresh-methods').textContent = `Ventas, pagos y compras: API pública con token. Tomas, transformaciones y transferencias originales: API interna con sesión autorizada. Maestros: ${data.masterStatus.connection || 'servicios internos con sesión web'}.`;
    const job=data.job,summary=job.summary || {};
    el('upload-refresh-report').hidden=!job.steps.length;
    el('resume-upload-api').hidden=!job.waitingForAuthentication;
    el('resume-upload-api').disabled=false;
    el('upload-refresh-progress').textContent=`${job.waitingForAuthentication?'En pausa · Inicia sesión en TotEat para continuar':job.running?'En curso':'Finalizado'} · ${summary.complete||0} grupos actualizados · ${summary.error||0} con problemas · ${summary.skipped||0} omitidos · ${(summary.pending||0)+(summary.running||0)+(summary['waiting-auth']||0)} pendientes. Inicio: ${date(job.startedAt)}${job.finishedAt?' · Fin: '+date(job.finishedAt):''}${job.recoveredCount ? ` · ${job.recoveredCount} problema(s) resuelto(s) después de este proceso` : ''}`;
    const progressHead=document.createElement('thead'),progressHeader=document.createElement('tr');
    progressHeader.append(...['Local / grupo','Fuentes previstas','Conexión','Estado','Resultado','Último cambio'].map(label=>cell('th',label)));progressHead.append(progressHeader);
    const progressBody=document.createElement('tbody');
    for(const step of job.steps){const row=document.createElement('tr');
      row.dataset.state=step.state;
      row.append(cell('td',step.label),cell('td',(step.sources||[]).join(' · ')),cell('td',step.method||''),cell('td',({pending:'Pendiente',running:'Actualizando…','waiting-auth':'Esperando autenticación',complete:'Actualizado',error:'Con problemas',skipped:'Omitido'})[step.state]),cell('td',step.message||(step.state==='running'?'Consultando y guardando las fuentes…':'En espera de su turno.')),cell('td',date(step.finishedAt||step.startedAt)));
      progressBody.append(row);
    }el('upload-refresh-steps').replaceChildren(progressHead,progressBody);
    const otherRunning=data.rows.filter(r=>r.cells.some(c=>c.running)).map(r=>r.name);
    setStatus(el('upload-overview-status'),data.job.running?'Actualización en curso…':otherRunning.length?'Hay actualizaciones independientes en curso: '+otherRunning.join(', '):data.masterStatus.running?'Maestros actualizándose desde otra vista…':data.job.finishedAt?'Último proceso finalizado: '+date(data.job.finishedAt):'');
    const loginRequired=job.steps.find(step=>['waiting-auth','error'].includes(step.state)&&step.code==='TOTEAT_AUTH_REQUIRED');
    if(loginRequired)setStatus(el('upload-overview-status'),loginRequired.message,'error');
    uploadWorkspace.accept(data);
  } catch(error){setStatus(el('upload-overview-status'),error.message,'error');}finally{uploadOverviewBusy=false;}
}
document.getElementById('open-previous-upload')?.addEventListener('click',()=>setView('uploads-previous'));
document.getElementById('return-upload-overview')?.addEventListener('click',()=>setView('uploads'));
document.getElementById('refresh-upload-api').addEventListener('click',async()=>{
  const button=document.getElementById('refresh-upload-api');button.disabled=true;
  try{await apiRequest('/api/uploads/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await loadUploadOverview();}
  catch(error){setStatus(document.getElementById('upload-overview-status'),error.message,'error');button.disabled=false;}
});
document.getElementById('review-recent-sales-windows').addEventListener('click',async event=>{
  const button=event.currentTarget,status=document.getElementById('source-history-status');
  button.disabled=true;
  setStatus(status,'Iniciando revisión de las dos últimas ventanas de ventas y pagos…');
  try{
    const location=document.getElementById('source-history-location').value;
    await apiRequest('/api/integrations/toteat/api/sales/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location})});
    setStatus(status,'Revisión de las dos últimas ventanas iniciada. Consulta el período comprobado en la tabla de fuentes.','success');
    await loadUploadOverview();
  }catch(error){setStatus(status,error.message,'error');}
  finally{button.disabled=false;}
});
document.getElementById('source-history-review').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('source-history-status');
  const button = form.querySelector('button[type="submit"]');
  const location = document.getElementById('source-history-location').value;
  const reviewRange = { from: document.getElementById('source-history-from').value,
    to: document.getElementById('source-history-to').value };
  const sources = [
    ['source-history-sales', '/api/integrations/toteat/api/sales/sync', 'Ventas y pagos Toteat'],
    ['source-history-purchases', '/api/integrations/toteat/api/purchases/sync', 'Compras Toteat'],
    ['source-history-mp', '/api/integrations/mercadopago/sync', 'MercadoPago']
  ].filter(([id]) => document.getElementById(id).checked);
  if (!sources.length || !reviewRange.from || !reviewRange.to || reviewRange.from > reviewRange.to) {
    setStatus(status, 'Selecciona al menos una fuente y un período válido.', 'error');
    return;
  }
  button.disabled = true;
  setStatus(status, 'Iniciando revisión histórica de las fuentes seleccionadas…');
  const outcomes = await Promise.allSettled(sources.map(async ([, route, label]) => {
    await apiRequest(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, reviewRange }) });
    return label;
  }));
  const started = outcomes.filter(item => item.status === 'fulfilled').map(item => item.value);
  const failed = outcomes.filter(item => item.status === 'rejected').map(item => item.reason.message);
  setStatus(status, `${started.length ? `Revisión iniciada: ${started.join(', ')}. Consulta su avance en esta pantalla.` : ''}${failed.length ? ` ${failed.join(' ')}` : ''}`.trim(),
    failed.length ? 'error' : 'success');
  button.disabled = false;
  await loadUploadOverview();
  await loadMercadoPagoWebStatus();
});
document.getElementById('source-history-to').value = browserIsoToday();
document.getElementById('source-history-from').value = offsetIsoDate(browserIsoToday(), -30);
document.getElementById('resume-upload-api').addEventListener('click',async event=>{
  event.currentTarget.disabled=true;
  try{await apiRequest('/api/uploads/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await loadUploadOverview();}
  catch(error){setStatus(document.getElementById('upload-overview-status'),error.message,'error');event.currentTarget.disabled=false;}
});
setInterval(()=>{const view=document.getElementById('upload-overview');if(!view.hidden&&view.style.display!=='none'){loadUploadOverview();loadMercadoPagoWebStatus();}},5000);

// The confirmation dialog is shared by both upload views.
document.body.append(document.getElementById('date-confirmation'));
let mercadoPagoWebBusy = false;
let mercadoPagoScheduleBusy = false;
function renderMercadoPagoWebStatus(data) {
  const button = document.getElementById('sync-mercadopago-web');
  button.disabled = data.running || mercadoPagoWebBusy;
  button.textContent = data.running ? 'Actualizando MercadoPago…' : 'Actualizar MercadoPago desde web';
  const daily = document.getElementById('mercadopago-daily');
  daily.closest('label').hidden = !!data.manualOnly;
  if (!mercadoPagoScheduleBusy) daily.checked = data.enabled;
  const auth = data.status === 'waiting-auth';
  document.getElementById('resume-mercadopago-web').hidden = !auth;
  document.getElementById('resume-mercadopago-web').disabled = data.running || mercadoPagoWebBusy;
  document.getElementById('mercadopago-report-link').hidden = !auth && data.status !== 'error' && !(data.result?.reports === 0);
  setStatus(document.getElementById('mercadopago-web-status'), data.message || '',
    auth || data.status === 'error' ? 'error' : data.status === 'complete' && data.result?.reports > 0 ? 'success' : '');
}
async function loadMercadoPagoWebStatus() {
  try { renderMercadoPagoWebStatus(await apiRequest('/api/integrations/mercadopago')); }
  catch (error) { setStatus(document.getElementById('mercadopago-web-status'), error.message, 'error'); }
}
async function syncMercadoPagoWeb() {
  if (mercadoPagoWebBusy) return;
  mercadoPagoWebBusy = true;
  document.getElementById('sync-mercadopago-web').disabled = true;
  document.getElementById('resume-mercadopago-web').disabled = true;
  try {
    const data = await apiRequest('/api/integrations/mercadopago/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    mercadoPagoWebBusy = false;
    renderMercadoPagoWebStatus(data);
  } catch (error) {
    setStatus(document.getElementById('mercadopago-web-status'), error.message, 'error');
    document.getElementById('sync-mercadopago-web').disabled = false;
    document.getElementById('resume-mercadopago-web').disabled = false;
  } finally { mercadoPagoWebBusy = false; }
}
document.getElementById('sync-mercadopago-web').addEventListener('click', syncMercadoPagoWeb);
document.getElementById('resume-mercadopago-web').addEventListener('click', syncMercadoPagoWeb);
document.getElementById('mercadopago-daily').addEventListener('change', async event => {
  const input = event.currentTarget;
  mercadoPagoScheduleBusy = true; input.disabled = true;
  try {
    const data = await apiRequest('/api/integrations/mercadopago/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: input.checked }) });
    mercadoPagoScheduleBusy = false; renderMercadoPagoWebStatus(data);
  } catch (error) {
    input.checked = !input.checked;
    setStatus(document.getElementById('mercadopago-web-status'), error.message, 'error');
  } finally { mercadoPagoScheduleBusy = false; input.disabled = false; }
});
loadMercadoPagoWebStatus();
document.getElementById('upload-mercadopago-shared').addEventListener('click', () => {
  if (inspectionState) { document.getElementById('date-confirmation').showModal(); return; }
  uploadManualTarget = { field: 'mercadopago' };
  document.getElementById('upload-overview-file').click();
});
document.getElementById('upload-overview-file').addEventListener('change',async event=>{
  const input=event.currentTarget,file=input.files[0],target=uploadManualTarget;
  if(!file||!target)return;
  transactionUploadContext={source:'overview',statusId:'upload-manual-status',location:target.location};
  await inspectTransactionFile(file,target.field,target.location,input);
  input.value='';
});
for(const key of ['masters','inventory'])document.getElementById(`upload-${key}-frequency`).addEventListener('change',()=>{uploadScheduleDirty=true;});
document.getElementById('upload-native-schedule').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;
  try{
    const body=Object.fromEntries(['masters','inventory'].map(key=>[key,Number(document.getElementById(`upload-${key}-frequency`).value)||null]));
    await apiRequest('/api/uploads/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    uploadScheduleDirty=false;setStatus(document.getElementById('upload-schedule-status'),'Frecuencias guardadas. Se ejecutan mientras el servidor esté encendido.','success');await loadUploadOverview();
  }catch(error){setStatus(document.getElementById('upload-schedule-status'),error.message,'error');}finally{button.disabled=false;}
});

// Make the active data policy visible in every workspace, including historical periods.
(async function showSourcePolicy(){
  try {
    const policy=await apiRequest('/api/source-policy');
    if(policy.mode!=='synchronized')return;
    window.brewitSynchronizedSources=true;
    const notice=document.createElement('details');notice.className='source-policy-notice';
    const title=document.createElement('summary');title.textContent=policy.message;notice.append(title);
    const note=document.createElement('p');note.textContent=policy.masterNote+' Carga manual: '+policy.manual.join(', ')+'.';notice.append(note);
    for(const location of policy.locations){const line=document.createElement('p');line.textContent=location.name+': ventas '+(location.sales?(location.sales.lastSuccess?'sincronizadas desde '+location.sales.from:'sin sincronizar'):'no aplica')+'; compras '+(location.purchases.lastSuccess?'sincronizadas desde '+location.purchases.from:'sin sincronizar')+'; inventario '+(location.inventory?location.inventory.range.from+' a '+location.inventory.range.to:'sin sincronizar')+'. Los días fuera de cobertura no representan actividad cero.';notice.append(line);}
    document.querySelector('.main-content').prepend(notice);
  }catch(error){console.warn('No se pudo consultar la política de fuentes.');}
})();

document.getElementById('sales-ranking-order').addEventListener('change', renderSalesInsights);

// Keep existing controls and report nodes alive while changing the visible block.
function installWorkspaceTabs(workspaceId, headingSelector, definitions, onActivate) {
  const workspace = document.getElementById(workspaceId);
  const navigation = document.createElement('div');
  navigation.className = 'workspace-tabs';
  navigation.setAttribute('role', 'tablist');
  navigation.setAttribute('aria-label', workspace.querySelector('h2').textContent);
  const entries = definitions.map(([key, label, selectors]) => {
    const nodes = selectors.flatMap(selector => [...workspace.querySelectorAll(selector)]);
    const panel = document.createElement('div');
    panel.id = `${workspaceId}-panel-${key}`;
    panel.className = 'workspace-tab-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `${workspaceId}-tab-${key}`);
    panel.tabIndex = 0;
    nodes[0].before(panel);
    panel.append(...nodes);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${workspaceId}-tab-${key}`;
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    navigation.append(button);
    return { button, panel };
  });
  function activate(index, focus = false) {
    entries.forEach(({ button, panel }, current) => {
      const selected = current === index;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    });
    if (focus) entries[index].button.focus();
    onActivate?.(definitions[index][0]);
    window.dispatchEvent(new Event('resize'));
  }
  entries.forEach(({ button }, index) => {
    button.addEventListener('click', () => activate(index));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % entries.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + entries.length) % entries.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = entries.length - 1;
      if (next !== undefined) { event.preventDefault(); activate(next, true); }
    });
  });
  workspace.querySelector(headingSelector).after(navigation);
  activate(0);
  return navigation;
}

installWorkspaceTabs('sales-workspace', '.sales-dashboard-heading', [
  ['breakdowns', 'Participación', ['#sales-margin-controls', '.financial-breakdowns-grid']],
  ['service', 'Modalidad de consumo', ['.sales-service-mode-panel']],
  ['hierarchies', 'Jerarquías y margen', ['#sales-hierarchy-margin-controls', '.financial-hierarchy-panel']],
  ['products', 'Productos y jerarquías', ['.sales-insight-heading', '#sales-insight-filters', '#sales-insight-range-status', '#sales-insight-context', '#sales-insight-filter-note', '.sales-insights-grid']],
  ['ingredients', 'Ventas por ingredientes', ['#sales-ingredients-workspace']],
  ['hourly', 'Franjas horarias', ['.hourly-demand-panel']],
  ['customers', 'Clientes recurrentes', ['.mercadopago-panel']]
]);
installWorkspaceTabs('financial-results-workspace', '.financial-results-heading', [
  ['weekly', 'Resultados Semanales / Mensuales', ['#weekly-results-workspace']],
  ['statement', 'Estado de resultados', ['#financial-results-filters', '#financial-results-status', '#financial-results-summary', '.financial-statement-panel', '#financial-warnings']],
  ['expenses', 'Gastos generales', ['.financial-general-expenses-panel']],
  ['costs', 'Revisión de costos', ['#financial-costs-filters', '#financial-costs-status', '#financial-costs-context', '#financial-costs-empty', '#financial-missing-costs', '#financial-costs-warnings']]
], key => {
  if (key === 'weekly') window.openCafeWeeklyResults?.();
  else window.cancelCafeWeeklyResults?.();
});
const demandNavigation = installWorkspaceTabs('demand-analysis-workspace', '.demand-heading', [
  ['overview', 'Resumen del período', ['#demand-report > .demand-section:nth-child(1)']],
  ['exploration', 'Composición de la venta', ['#demand-report > .demand-section:nth-child(2)']],
  ['hypotheses', 'Hipótesis', ['#demand-report > .demand-section:nth-child(3)']],
  ['actions', 'Acciones', ['#demand-report > .demand-section:nth-child(4)']],
  ['advanced', 'Análisis avanzado', ['#demand-report > .demand-section:nth-child(5)']]
]);
const demandNavigationRow = document.createElement('div');
demandNavigationRow.className = 'demand-navigation-row';
demandNavigation.before(demandNavigationRow);
demandNavigationRow.append(demandNavigation, document.getElementById('sales-clusters-open'));

// The screen, print view and workbook share the same report rows.
(() => {
  const dialog = document.getElementById('purchase-master-dialog');
  const form = document.getElementById('purchase-master-form');
  const result = document.getElementById('purchase-master-results');
  const status = document.getElementById('purchase-master-status');
  const print = document.getElementById('print-purchase-master');
  const excel = document.getElementById('export-purchase-master');
  let report = null, sections = [], generation = 0;
  const money = value => value === null ? 'N/D' : formatClp(value);
  const amounts = item => [item.recorded];
  let target = result;
  function table(headers, rows, monetaryColumns, kind = '') {
    const wrap = document.createElement('div'); wrap.className = 'purchases-table-wrap';
    const table = document.createElement('table'); table.className = `purchase-master-table ${kind}`;
    const head = table.createTHead().insertRow();
    headers.forEach((label, index) => {
      const th = document.createElement('th'); th.scope = 'col'; th.textContent = label;
      if (monetaryColumns.includes(index)) th.className = 'master-amount';
      head.append(th);
    });
    const body = table.createTBody();
    rows.forEach(values => {
      const row = body.insertRow();
      if (!values.length) {
        row.className = 'master-group-gap'; row.setAttribute('aria-hidden', 'true');
        row.insertCell().colSpan = headers.length;
        return;
      }
      if (values.includes('Total proveedor')) row.className = 'master-subtotal';
      if (values[0] === 'Total general' || kind === 'master-location-total') row.className = 'master-grand-total';
      values.forEach((value, index) => {
        const cell = row.insertCell(); cell.textContent = monetaryColumns.includes(index) ? money(value) : value ?? 'N/D';
        if (monetaryColumns.includes(index)) cell.className = 'master-amount';
      });
    });
    wrap.append(table); target.append(wrap);
    sections.push([headers, ...rows.map(row => row.map(value => value ?? 'N/D'))]);
  }
  function heading(text, tag = 'h4', className = '') {
    const element = document.createElement(tag); element.textContent = text; element.className = className;
    target.append(element); sections.push([[text]]);
  }
  function render() {
    result.replaceChildren(); sections = []; target = result;
    const header = document.createElement('header'); header.className = 'master-report-header'; result.append(header); target = header;
    heading('Reporte maestro de compras', 'h2');
    heading(`${formatReportDate(report.period.from)} – ${formatReportDate(report.period.to)}`, 'p', 'master-period');
    heading(report.note, 'p', 'master-note');
    const overview = document.createElement('div'); overview.className = 'master-overview'; header.append(overview);
    for (const [label, value] of [['Importe Neto', money(report.recorded)], ['Proveedores', report.suppliers.length], ['Facturas por local', report.invoiceCount], ['Documentos por local', report.documentCount]]) {
      const card = document.createElement('div'); const caption = document.createElement('span'); caption.textContent = label;
      const amount = document.createElement('strong'); amount.textContent = value; card.append(caption, amount); overview.append(card);
    }
    report.locations.forEach(location => {
      const section = document.createElement('section'); section.className = 'master-location'; result.append(section); target = section;
      heading(location.name, 'h3', 'master-location-heading');
      if (!location.suppliers.length) heading('Sin compras registradas en el período.', 'p');
      location.suppliers.forEach(supplier => {
        const group = document.createElement('section'); group.className = 'master-supplier'; section.append(group); target = group;
        heading(supplier.name, 'h4');
        if (supplier.taxId) heading(`RUT ${supplier.taxId}`, 'p', 'master-supplier-rut');
        const rows = supplier.documents.map(document => [formatReportDate(document.date), document.type, document.number, ...amounts(document)]);
        rows.push(['', 'Total proveedor', `${supplier.invoiceCount} factura(s) · ${supplier.documentCount} documento(s)`, ...amounts(supplier)]);
        table(['Fecha emisión', 'Tipo documento', 'Documento', 'Importe Neto'], rows, [3], 'master-documents');
        if (report.includeProducts) supplier.documents.forEach(document => {
          heading(`Productos recibidos · ${document.type} ${document.number}`, 'p', 'master-products-heading');
          table(['Código', 'Producto', 'Cantidad recibida', 'Unidad recibida', 'Importe Neto'],
            document.products.map(product => [product.code, product.product, product.quantity, product.unit, product.recorded]), [4]);
        });
      });
      target = section;
      table(['Total local', 'Facturas', 'Documentos', 'Importe Neto'],
        [[location.name, location.invoiceCount, location.documentCount, ...amounts(location)]], [3], 'master-location-total');
    });
    const summarySection = document.createElement('section'); summarySection.className = 'master-summary'; result.append(summarySection); target = summarySection;
    heading('Resumen general por proveedor y localidad', 'h3');
    const summary = [];
    report.suppliers.forEach(supplier => {
      supplier.locations.forEach((location, index) => summary.push([index === 0 ? supplier.name : '', index === 0 ? supplier.taxId : '', location.name, location.invoiceCount, location.documentCount, ...amounts(location)]));
      summary.push(['', '', 'Total proveedor', supplier.invoiceCount, supplier.documentCount, ...amounts(supplier)]);
      summary.push([]);
    });
    summary.push(['Total general', '', 'Todas las ubicaciones', report.invoiceCount, report.documentCount, ...amounts(report)]);
    table(['Proveedor', 'RUT', 'Localidad', 'Facturas por local', 'Documentos por local', 'Importe Neto'], summary, [5]);
    print.disabled = excel.disabled = false;
  }
  function invalidate() {
    generation++; report = null; result.replaceChildren(); print.disabled = excel.disabled = true;
  }
  async function generate(event) {
    event?.preventDefault();
    if (!form.reportValidity()) return;
    invalidate(); const current = generation;
    const from = form.elements.from.value, to = form.elements.to.value;
    if (from > to) return setStatus(status, 'La fecha inicial debe ser anterior o igual a la final.', 'error');
    setStatus(status, 'Generando reporte maestro…');
    try {
      const params = new URLSearchParams({ dateFrom: from, dateTo: to, includeProducts: form.elements.products.checked });
      const data = await apiRequest(`/api/purchase-master-report?${params}`);
      if (current !== generation) return;
      report = data; render(); setStatus(status, report.documentCount ? 'Reporte generado.' : 'No hay compras registradas en el período.', 'success');
    } catch (error) { if (current === generation) setStatus(status, error.message, 'error'); }
  }
  document.getElementById('open-purchase-master').addEventListener('click', () => {
    invalidate(); setStatus(status, 'Selecciona el período y genera el reporte.');
    form.elements.from.value = document.getElementById('purchases-date-from').value;
    form.elements.to.value = document.getElementById('purchases-date-to').value;
    dialog.showModal();
    if (form.elements.from.value && form.elements.to.value) generate();
  });
  document.getElementById('close-purchase-master').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', generate);
  form.addEventListener('input', () => { invalidate(); setStatus(status, 'Genera el reporte para aplicar los cambios.'); });
  excel.addEventListener('click', () => {
    if (!report) return;
    try {
      if (!window.XLSX) throw new Error('No fue posible cargar el generador Excel.');
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sections.flatMap(section => [...section, []]));
      sheet['!cols'] = [28, 32, 40, 24, 22, 24].map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(workbook, sheet, 'Reporte maestro');
      writeConfiguredExcelWorkbook(workbook, `reporte-maestro-compras-${report.period.from}-${report.period.to}.xlsx`);
      setStatus(status, 'Reporte exportado a Excel.', 'success');
    } catch (error) { setStatus(status, error.message, 'error'); }
  });
  print.addEventListener('click', () => {
    if (!report) return;
    const title = document.title;
    document.title = `Reporte maestro de compras ${report.period.from} al ${report.period.to}`;
    document.body.classList.add('printing-purchase-master');
    try { window.print(); } finally { document.body.classList.remove('printing-purchase-master'); document.title = title; }
  });
})();
