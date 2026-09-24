function downloadReportSalesFromToteat() {
  const location = document.getElementById('report-location-filter').value || 'all';
  if (location === 'all') return startToteatTransactionalDownloads({ mode: 'sales' });
  if (locationRegistry[location]?.type !== 'store') {
    return setStatus(document.getElementById('report-status'), 'Selecciona una cafetería válida.', 'error');
  }
  document.getElementById('report-sales-download-location-name').textContent = locationRegistry[location].name;
  document.getElementById('report-sales-download-scope-dialog').showModal();
}

function chooseReportSalesDownloadScope(allLocations) {
  const dialog = document.getElementById('report-sales-download-scope-dialog');
  if (dialog.open) dialog.close();
  const selected = document.getElementById('report-location-filter').value || 'all';
  return startToteatTransactionalDownloads({ mode: 'sales', locationId: allLocations ? 'all' : selected });
}

async function saveToteatMasterDownload(endpoint, fallbackFilename) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const batchEndpoint = toteatMasterDownloadBatchId
    ? `${endpoint}${separator}batchId=${encodeURIComponent(toteatMasterDownloadBatchId)}`
    : endpoint;
  const response = await fetch(batchEndpoint, { method: 'POST' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || 'No se pudo descargar el archivo desde Toteat.');
    error.code = payload.code;
    error.state = payload.state;
    throw error;
  }
  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if ((response.headers.get('Content-Type') || '').includes('application/json')) {
    const payload = await response.json();
    if (!Array.isArray(payload.files) || !payload.files.length) throw new Error('TotEat no entregó archivos para descargar.');
    const filenames = [];
    for (const [index, file] of payload.files.entries()) {
      const binary = window.atob(file.data || '');
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const filename = file.filename || `${index + 1}-${fallbackFilename}`;
      triggerDownload(new Blob([bytes], { type: file.contentType || 'application/octet-stream' }), filename);
      filenames.push(filename);
      if (index < payload.files.length - 1) await new Promise(resolve => window.setTimeout(resolve, 150));
    }
    return filenames;
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackFilename;
  triggerDownload(blob, filename);
  return [filename];
}

async function startToteatMasterDownloads() {
  const button = document.getElementById('download-all-toteat-files');
  const status = document.getElementById('toteat-master-download-status');
  button.disabled = true;
  setStatus(status, 'Abriendo Toteat para iniciar sesión…');
  try {
    const response = await fetch('/api/integrations/toteat/master-downloads/connect', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No se pudo abrir Toteat.');
    toteatMasterDownloadBatchId = payload.batchId || null;
    const requiresAuthentication = payload.requiresAuthentication === true;
    document.getElementById('toteat-master-download-title').textContent = requiresAuthentication
      ? 'Inicia sesión en la ventana de Toteat'
      : 'Sesión de Toteat actualizada';
    document.getElementById('toteat-master-download-copy').textContent = requiresAuthentication
      ? 'Tómate el tiempo necesario para ingresar. Cuando veas Toteat abierto y autenticado, vuelve aquí para descargar los siete archivos maestros.'
      : 'Encontramos una sesión activa y refrescamos Toteat para actualizar sus opciones de fecha. Puedes comenzar las descargas.';
    setStatus(document.getElementById('toteat-master-dialog-status'), '', 'muted');
    document.getElementById('toteat-master-download-dialog').showModal();
    setStatus(status, requiresAuthentication
      ? 'Toteat solicita login. Completa el inicio de sesión y confirma para comenzar las descargas.'
      : 'La sesión existente de Toteat fue refrescada y está lista para descargar.', 'muted');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function closeToteatMasterDownloadDialog() {
  const dialog = document.getElementById('toteat-master-download-dialog');
  if (dialog.open) dialog.close();
}

function closeToteatTransactionalDownloadDialog() {
  const dialog = document.getElementById('toteat-transactional-download-dialog');
  if (dialog.open) dialog.close();
}

const TOTEAT_TRANSACTION_REPORTS = [
  { label: 'Ventas Totales', route: 'sales', field: 'sales', emptyCode: 'TOTEAT_NO_SALES_AVAILABLE' },
  { label: 'Detalle Pagos', route: 'payment-details', field: 'payment-details', emptyCode: 'TOTEAT_NO_PAYMENT_DETAILS_AVAILABLE' },
  { label: 'Compras', route: 'purchases', field: 'purchases', emptyCode: 'TOTEAT_NO_PURCHASES_AVAILABLE' }
];
const TOTEAT_LOCAL_KARDEX_REPORTS = [
  { label: 'Kardex Bodega Local', route: 'kardex-local', field: 'kardex', emptyCode: 'TOTEAT_NO_KARDEX_AVAILABLE' },
  { label: 'Kardex Bodega Merma', route: 'kardex-waste', field: 'waste', emptyCode: 'TOTEAT_NO_KARDEX_AVAILABLE' }
];
const TOTEAT_CENTRAL_KARDEX_REPORTS = [
  { label: 'Kardex Bodega Central', route: 'kardex-central', field: 'kardex', emptyCode: 'TOTEAT_NO_KARDEX_AVAILABLE' },
  { label: 'Kardex Bodega Central Merma', route: 'kardex-central-waste', field: 'waste', emptyCode: 'TOTEAT_NO_KARDEX_AVAILABLE' }
];
const toteatReportsForLocation = location => location.central
  ? TOTEAT_CENTRAL_KARDEX_REPORTS
  : toteatTransactionalMode === 'sales'
    ? TOTEAT_TRANSACTION_REPORTS.slice(0, 2)
    : [...TOTEAT_TRANSACTION_REPORTS, ...TOTEAT_LOCAL_KARDEX_REPORTS];

function toteatSuggestedStart(location, route) {
  if (route === 'sales') return location.dateFrom;
  if (route === 'payment-details') return location.paymentDetailsDateFrom;
  if (route === 'purchases') return location.purchasesDateFrom;
  if (route === 'kardex-local' || route === 'kardex-central') return location.kardexDateFrom;
  return location.wasteDateFrom;
}

function renderToteatTransactionalRanges() {
  const list = document.getElementById('toteat-transactional-locations');
  list.replaceChildren();
  const locations = [...toteatTransactionalLocations,
    ...(toteatTransactionalCentralWarehouse ? [toteatTransactionalCentralWarehouse] : [])];
  locations.forEach((location, index) => {
    const section = document.createElement('section');
    section.className = 'toteat-range-location';
    const heading = document.createElement('h4');
    heading.textContent = `${index + 1}. ${location.name}${location.central
      ? ` · administrada por ID local ${location.toteatLocalId}`
      : ` · ${location.toteatName} · ID local ${location.toteatLocalId || location.id}`}`;
    section.append(heading);
    const grid = document.createElement('div');
    grid.className = 'toteat-range-grid';
    for (const report of toteatReportsForLocation(location)) {
      const card = document.createElement('div');
      card.className = 'toteat-range-card';
      card.dataset.location = location.id;
      card.dataset.route = report.route;
      const title = document.createElement('strong');
      title.textContent = report.label;
      card.append(title);
      for (const [field, label, value] of [
        ['dateFrom', 'Fecha inicial', toteatSuggestedStart(location, report.route)],
        ['dateTo', 'Fecha final', location.dateTo]
      ]) {
        const wrapper = document.createElement('label');
        wrapper.textContent = label;
        const input = document.createElement('input');
        input.type = 'date';
        input.name = field;
        input.value = value;
        input.dataset.suggestedValue = value;
        input.max = location.dateTo;
        input.required = true;
        input.setAttribute('aria-label', `${label} de ${report.label} para ${location.name}`);
        const markChanged = () => input.classList.toggle('changed-from-suggested',
          Boolean(input.value) && input.value !== input.dataset.suggestedValue);
        input.addEventListener('input', markChanged);
        input.addEventListener('change', markChanged);
        wrapper.append(input);
        card.append(wrapper);
      }
      grid.append(card);
    }
    section.append(grid);
    list.append(section);
  });
}

function selectedToteatTransactionalRanges() {
  const ranges = new Map();
  for (const card of document.querySelectorAll('#toteat-transactional-locations .toteat-range-card')) {
    const from = card.querySelector('[name="dateFrom"]');
    const to = card.querySelector('[name="dateTo"]');
    if (!from.checkValidity() || !to.checkValidity() || from.value > to.value) {
      (from.checkValidity() ? to : from).focus();
      throw new Error('Revisa las fechas inicial y final de cada archivo. La fecha inicial no puede ser posterior a la final ni la fecha final superar hoy.');
    }
    ranges.set(`${card.dataset.location}:${card.dataset.route}`, { dateFrom: from.value, dateTo: to.value });
  }
  return ranges;
}

const toteatTransactionalStatus = () => document.getElementById(
  toteatTransactionalMode === 'sales' ? 'report-status' : 'toteat-master-download-status'
);

function createToteatTransactionalProgress(locations) {
  const panel = document.getElementById('toteat-transactional-progress');
  const list = document.getElementById('toteat-transactional-progress-list');
  const bar = document.getElementById('toteat-transactional-progress-bar');
  const count = document.getElementById('toteat-transactional-progress-count');
  const percent = document.getElementById('toteat-transactional-progress-percent');
  const total = locations.reduce((sum, location) => sum + toteatReportsForLocation(location).length * 2, 0);
  const rows = new Map();
  const downloaded = new Set();
  const finished = new Set();
  let processed = 0;
  list.replaceChildren();
  panel.hidden = false;
  bar.max = Math.max(total, 1);
  bar.value = 0;
  count.textContent = `0 de ${total} pasos completados`;
  percent.textContent = '0%';
  for (const location of locations) {
    const group = document.createElement('div');
    group.className = 'toteat-progress-location';
    const heading = document.createElement('strong');
    heading.textContent = `${location.name} · ID local ${location.toteatLocalId || location.id}`;
    group.append(heading);
    for (const report of toteatReportsForLocation(location)) {
      const row = document.createElement('div');
      row.className = 'toteat-progress-report';
      row.dataset.state = 'waiting';
      const label = document.createElement('span');
      label.textContent = report.label;
      const state = document.createElement('span');
      state.textContent = 'En espera';
      row.append(label, state);
      group.append(row);
      rows.set(`${location.id}:${report.route}`, { row, state });
    }
    list.append(group);
  }
  return {
    update(location, report, status, message) {
      const key = `${location.id}:${report.route}`;
      const entry = rows.get(key);
      entry.row.dataset.state = status;
      entry.state.textContent = message;
      if (status === 'active') entry.row.scrollIntoView({ block: 'nearest' });
      if (['done', 'empty'].includes(status) && !downloaded.has(key)) {
        downloaded.add(key);
        processed += 1;
      }
      if (['empty', 'imported', 'import-error'].includes(status) && !finished.has(key)) {
        finished.add(key);
        processed += 1;
      }
      if (['done', 'empty', 'imported', 'import-error'].includes(status)) {
        bar.value = processed;
        count.textContent = `${processed} de ${total} pasos completados`;
        percent.textContent = `${Math.round(processed / Math.max(total, 1) * 100)}%`;
      }
    }
  };
}

async function importToteatTransactionalFile(location, report, blob, filename) {
  const form = new FormData();
  form.append(report.field, blob, filename);
  const inspection = await apiRequest(`/api/uploads/transactions/inspect?location=${encodeURIComponent(location.id)}`, {
    method: 'POST', body: form
  });
  const file = inspection.files?.[0];
  const dates = file?.recordDates || [];
  if (inspection.location !== location.id || inspection.files?.length !== 1
    || file.field !== report.field || !file.structure?.ok || !dates.length) {
    throw new Error('El archivo no pasó la validación de estructura o no contiene registros con fecha. Se conservó la información anterior.');
  }
  const result = await apiRequest('/api/uploads/transactions/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: inspection.token,
      dateFrom: dates[0],
      dateTo: dates.at(-1),
      confirmed: true,
      categoryConfirmed: ['kardex', 'waste'].includes(report.field),
      overlapAction: 'replace',
      replaceOnlyIncomingDates: true
    })
  });
  if (!result.imports?.[report.field]?.saved) {
    throw new Error('El archivo fue revisado, pero no se guardaron registros nuevos. Se conservó la información anterior.');
  }
  return result;
}

async function startToteatTransactionalDownloads({ mode = 'all', locationId = 'all' } = {}) {
  toteatTransactionalMode = mode;
  const button = document.getElementById(mode === 'sales'
    ? 'report-download-toteat-sales' : 'download-all-toteat-transactions');
  const status = toteatTransactionalStatus();
  button.disabled = true;
  setStatus(status, 'Preparando la descarga transaccional por cafetería…');
  try {
    const payload = await apiRequest('/api/integrations/toteat/transactional-downloads/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: locationId, includeCentral: mode === 'all' })
    });
    toteatTransactionalLocations = (payload.locations || []).filter(location => locationId === 'all' || location.id === locationId);
    if (!toteatTransactionalLocations.length) throw new Error('No hay cafeterías activas para descargar.');
    toteatTransactionalCentralWarehouse = mode === 'all' && payload.centralWarehouse
      ? { ...payload.centralWarehouse, central: true } : null;
    document.getElementById('toteat-transactional-progress').hidden = true;
    document.getElementById('confirm-toteat-transactional-download').textContent = 'Ya inicié sesión, descargar reportes';
    renderToteatTransactionalRanges();
    document.getElementById('toteat-transactional-download-title').textContent = payload.requiresAuthentication
      ? 'Inicia sesión en la ventana de TotEat'
      : 'Sesión de TotEat actualizada';
    document.getElementById('toteat-transactional-download-copy').textContent = mode === 'sales'
      ? 'Revisa o ajusta las fechas de Ventas Totales y Detalle Pagos de cada cafetería. Luego Brewit validará y cargará cada archivo sin duplicar fechas.'
      : payload.requiresAuthentication
        ? 'Completa el login y vuelve aquí. Puedes ajustar las fechas de cada archivo antes de iniciar las descargas y cargas.'
        : 'Revisa o ajusta las fechas de cada archivo. Brewit actualizará cada ubicación, reemplazando solo las fechas presentes en los archivos descargados.';
    setStatus(document.getElementById('toteat-transactional-dialog-status'), '', 'muted');
    document.getElementById('toteat-transactional-download-dialog').showModal();
    setStatus(status, payload.requiresAuthentication
      ? 'TotEat solicita login. Completa la sesión antes de continuar.'
      : 'La sesión de TotEat está lista para descargar los reportes por cafetería y bodega.', 'muted');
  } catch (error) {
    setStatus(status, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function confirmToteatTransactionalDownloads() {
  const button = document.getElementById('confirm-toteat-transactional-download');
  const closeButton = document.getElementById('close-toteat-transactional-download');
  const cancelButton = document.getElementById('cancel-toteat-transactional-download');
  const dialogStatus = document.getElementById('toteat-transactional-dialog-status');
  const status = toteatTransactionalStatus();
  let selectedRanges;
  try {
    selectedRanges = selectedToteatTransactionalRanges();
  } catch (error) {
    setStatus(dialogStatus, error.message, 'error');
    return;
  }
  button.disabled = true;
  closeButton.disabled = true;
  cancelButton.disabled = true;
  const completed = [];
  const withoutData = [];
  const downloaded = [];
  const imported = [];
  const importErrors = [];
  const jobs = toteatTransactionalLocations.map(location => ({ location, selectionLocationId: location.id }));
  if (toteatTransactionalCentralWarehouse) jobs.push({
    location: toteatTransactionalCentralWarehouse,
    selectionLocationId: toteatTransactionalCentralWarehouse.ownerLocationId
  });
  const progress = createToteatTransactionalProgress(jobs.map(job => job.location));
  let activeLocation = null;
  let activeReport = null;
  try {
    for (const [index, job] of jobs.entries()) {
      const { location, selectionLocationId } = job;
      activeLocation = location;
      activeReport = null;
      setStatus(dialogStatus, `Local ${location.toteatLocalId || location.id}: seleccionando ${location.name} (${index + 1} de ${jobs.length})…`);
      const selection = await fetch('/api/integrations/toteat/transactional-downloads/select-location', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: selectionLocationId })
      });
      if (!selection.ok) {
        const payload = await selection.json().catch(() => ({}));
        throw new Error(payload.error || `No se pudo seleccionar ${location.name} en TotEat.`);
      }
      for (const report of toteatReportsForLocation(location)) {
        activeReport = report;
        progress.update(location, report, 'active', 'Descargando…');
        setStatus(dialogStatus, `Local ${location.toteatLocalId || location.id} · ${location.name}: descargando ${report.label} (${index + 1} de ${jobs.length})…`);
        const response = await fetch(`/api/integrations/toteat/transactional-downloads/${report.route}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location: location.id, ...selectedRanges.get(`${location.id}:${report.route}`) })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          if (payload.code === report.emptyCode || payload.code === 'TOTEAT_NO_DATA_AVAILABLE') {
            withoutData.push(`${report.label} de ${location.name}`);
            progress.update(location, report, 'empty', 'Sin datos');
            continue;
          }
          throw new Error(payload.error || `No se pudo descargar ${report.label} de ${location.name}.`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1]
          || `${location.toteatLocalId || location.id}_${report.route}-toteat-${location.id}.csv`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        completed.push(`${report.label} de ${location.name}`);
        downloaded.push({ location, report, blob, filename });
        progress.update(location, report, 'done', 'Descargado');
      }
    }
    for (const [index, item] of downloaded.entries()) {
      const { location, report, blob, filename } = item;
      progress.update(location, report, 'active', 'Cargando…');
      setStatus(dialogStatus, `Validando y cargando ${report.label} de ${location.name} (${index + 1} de ${downloaded.length})…`);
      try {
        await importToteatTransactionalFile(location, report, blob, filename);
        imported.push(`${report.label} de ${location.name}`);
        progress.update(location, report, 'imported', 'Actualizado');
      } catch (error) {
        importErrors.push(`${report.label} de ${location.name}: ${error.message}`);
        progress.update(location, report, 'import-error', 'No cargado');
      }
    }
    await loadTransactionFiles();
    if (toteatTransactionalMode === 'sales') await loadWeeklySalesReport();
    const skipped = withoutData.length ? ` Sin registros: ${withoutData.join(', ')}.` : '';
    const failures = importErrors.length ? ` No se cargaron ${importErrors.length}: ${importErrors.join(' · ')}.` : '';
    const summary = `${completed.length} archivo(s) descargados; ${imported.length} actualizado(s).${skipped}${failures}`;
    setStatus(status, summary, importErrors.length ? 'error' : 'success');
    setStatus(dialogStatus, summary, importErrors.length ? 'error' : 'success');
    button.textContent = 'Descargar nuevamente';
  } catch (error) {
    if (activeLocation && activeReport) progress.update(activeLocation, activeReport, 'error', 'Error');
    setStatus(dialogStatus, `${completed.length} archivo(s) descargados antes del error. ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    closeButton.disabled = false;
    cancelButton.disabled = false;
  }
}

async function confirmToteatMasterDownloads() {
  const button = document.getElementById('confirm-toteat-master-download');
  const dialogStatus = document.getElementById('toteat-master-dialog-status');
  const status = document.getElementById('toteat-master-download-status');
  const downloads = [
    ['Proveedores', '/api/integrations/toteat/master-downloads/suppliers', 'proveedores-toteat.xlsx', 1],
    ['Productos / Ingredientes / Extras', '/api/integrations/toteat/master-downloads/products', 'productos-ingredientes-extras-toteat.xlsx', 1],
    ['Jerarquía de Productos', '/api/integrations/toteat/master-downloads/product-hierarchy', 'jerarquia-productos-toteat.csv', 1],
    ['Jerarquía de Ingredientes', '/api/integrations/toteat/master-downloads/ingredient-hierarchy', 'jerarquia-ingredientes-toteat.csv', 1],
    ['Jerarquía de Extras', '/api/integrations/toteat/master-downloads/extras-hierarchy', 'jerarquia-extras-toteat.csv', 1],
    ['Maestro de Recetas (Header y Detalle)', '/api/integrations/toteat/master-downloads/recipes', 'recetas-toteat.txt', 2]
  ];
  const expectedFileCount = downloads.reduce((sum, download) => sum + download[3], 0);
  const completed = [];
  button.disabled = true;
  try {
    for (const [index, [label, endpoint, fallbackFilename]] of downloads.entries()) {
      setStatus(dialogStatus, `Descargando ${index + 1} de ${downloads.length}: ${label}…`);
      completed.push(...await saveToteatMasterDownload(endpoint, fallbackFilename));
    }
    setStatus(dialogStatus, 'Los siete archivos llegaron correctamente. Validando sus estructuras contra los maestros vigentes…');
    const update = await apiRequest('/api/integrations/toteat/master-downloads/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: toteatMasterDownloadBatchId })
    });
    closeToteatMasterDownloadDialog();
    toteatMasterDownloadBatchId = null;
    setStatus(status, `Los ${expectedFileCount} archivos fueron descargados y validados. Los seis maestros se actualizaron con vigencia ${formatReportDate(update.validFrom)}.`, 'success');
    await renderMasterList();
  } catch (error) {
    const authenticationMessage = error.code === 'TOTEAT_AUTH_REQUIRED'
      ? 'Toteat todavía solicita autenticación. Completa el inicio de sesión en su ventana y vuelve a intentar.'
      : error.message;
    const progress = completed.length ? `${completed.length} de ${expectedFileCount} archivo(s) ya fueron descargados. ` : '';
    setStatus(dialogStatus, `${progress}${authenticationMessage}`, 'error');
  } finally {
    button.disabled = false;
  }
}

