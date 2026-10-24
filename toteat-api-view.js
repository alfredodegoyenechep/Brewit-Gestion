(() => {
  const form = document.getElementById('toteat-api-form');
  const select = document.getElementById('toteat-api-location');
  const settings = window.brewitSettings;
  const settingsStatus = document.getElementById('settings-sales-status');
  const status = document.getElementById('toteat-api-status');
  const refresh = document.getElementById('toteat-api-refresh');
  let revision = 0;
  const salesForm = document.getElementById('toteat-sales-settings');
  let salesStates = [], salesSchedule = null, previousVersions = new Map(), polling = false;
  let detailLocation = null;
  let warningFilter = 'unresolved', savingResolution = false, resolutionRevision = 0;
  const detailDialog = document.createElement('dialog');
  detailDialog.className = 'inventory-report-dialog sales-load-dialog';
  detailDialog.setAttribute('aria-labelledby', 'sales-load-title');
  detailDialog.innerHTML = `<div class="preview-dialog-head"><div><div class="panel-eyebrow">Carga de datos · Toteat API</div><h2 id="sales-load-title"></h2></div><button type="button" class="icon-button" autofocus>Cerrar</button></div><div class="sales-load-content"></div>`;
  document.body.append(detailDialog);
  detailDialog.querySelector('button').addEventListener('click', () => detailDialog.close());
  detailDialog.addEventListener('click', event => {
    if (event.target !== detailDialog) return;
    const box = detailDialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) detailDialog.close();
  });
  const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
  const timestamp = value => value ? new Date(value).toLocaleString('es-CL') : 'Sin actualización exitosa';
  function renderLoadDetails() {
    const s = salesStates.find(item => item.location === detailLocation);
    if (!s) return;
    detailDialog.querySelector('h2').textContent = `Detalle de la carga · ${s.name}`;
    const content = detailDialog.querySelector('.sales-load-content');
    const summary = document.createElement('dl');
    summary.className = 'sales-load-summary';
    const state = s.running ? 'Actualizando' : s.lastError ? 'Error de actualización' : !s.configured ? 'Falta conectar la API' : !s.lastSuccess ? 'Pendiente de sincronizar' : s.state === 'connected-empty' ? 'Conectado, sin ventas' : 'Actualizado';
    for (const [label, value] of [
      ['Estado', state], ['Última carga exitosa', timestamp(s.lastSuccess)],
      ['Período cargado', s.lastSuccess ? `${s.from || 'Sin fecha inicial'} → ${s.through || 'Sin fecha final disponible'}` : 'Aún no hay datos cargados'],
      ['Órdenes', s.orderCount ?? 0], ['Pagos', s.paymentCount ?? 0],
      ['Bloques de consulta cargados', s.completedWindows ?? 0],
      ['Actualización programada', s.enabled ? `Cada ${s.intervalMinutes} minutos` : 'Manual'],
      ['Turno abierto desde', s.openShift || 'Sin turno abierto informado']
    ]) summary.append(node('dt', label), node('dd', value));
    content.replaceChildren(summary);
    if (s.lastSuccess) {
      content.append(node('h3', 'Archivos de la última carga'));
      content.append(node('p', 'Cada actualización guarda juntos las ventas con detalle por producto y el detalle de pagos. Ambos corresponden a la fecha de carga indicada arriba.'));
      const sources = node('div', ''); sources.className = 'settings-actions';
      for (const [field, label] of [['sales', 'Descargar ventas por producto'], ['payment-details', 'Descargar detalle de pagos']]) {
        const link = node('a', label); link.className = 'icon-button';
        link.href = `/api/integrations/toteat/api/sales/export?location=${encodeURIComponent(s.location)}&field=${field}`;
        sources.append(link);
      }
      content.append(sources);
    }
    if (s.running) content.append(node('p', s.progress || 'Consultando ventas en Toteat…'));
    if (s.lastError) content.append(node('p', `No se pudo actualizar: ${s.lastError}`));
    if (s.cancellationCheckError) content.append(node('p', s.cancellationCheckError));
    content.append(node('p', 'Los conteos y el detalle corresponden a la última carga exitosa de esta cafetería, independientemente del período seleccionado en el reporte.'));
    const warnings = s.detailWarnings || [];
    content.append(node('h3', `Pagos con importe sin productos (${warnings.length})`));
    if (!warnings.length) {
      content.append(node('p', s.lastSuccess ? 'No se detectaron pagos con importe sin productos en la carga.' : 'Este detalle estará disponible después de la primera carga exitosa.'));
      return;
    }
    const money = value => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(value);
    content.append(node('p', `Importe total informado: ${money(warnings.reduce((sum, item) => sum + item.total, 0))}. Los pagos pendientes de verificar están incluidos en los totales; los anulados están excluidos. Toteat no entregó sus productos asociados.`));
    const filterLabel = node('label', 'Mostrar ');
    const filter = document.createElement('select'); filter.setAttribute('aria-label', 'Filtrar pagos por resolución');
    filter.append(new Option('Solo no resueltos', 'unresolved'), new Option('Todos los registros', 'all'));
    filter.value = warningFilter;
    filter.addEventListener('change', () => { warningFilter = filter.value; renderLoadDetails(); });
    filterLabel.append(filter); content.append(filterLabel);
    const visible = warnings.filter(item => warningFilter === 'all' || !item.resolved);
    content.append(node('p', `${warnings.filter(item => !item.resolved).length} no resueltos · ${warnings.filter(item => item.resolved).length} resueltos. Resolver un registro no cambia los totales de ventas.`));
    const saveStatus = node('p', ''); saveStatus.setAttribute('role', 'status'); content.append(saveStatus);
    if (!visible.length) { content.append(node('p', 'No quedan pagos sin resolver. Puedes consultarlos seleccionando Todos los registros.')); return; }
    const wrap = document.createElement('div'); wrap.className = 'sales-table-wrap';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Detalle de pagos sin productos');
    const table = document.createElement('table'); table.className = 'sales-dashboard-table';
    const head = document.createElement('thead'), row = document.createElement('tr');
    for (const label of ['Orden', 'ID del pago', 'Fecha de cierre', 'Hora (Chile)', 'Importe informado (CLP)', 'Motivo', 'Resuelto', 'Anulación']) { const th = node('th', label); th.scope = 'col'; row.append(th); }
    head.append(row);
    const body = document.createElement('tbody');
    visible.forEach(item => {
      const tr = document.createElement('tr');
      const date = item.closedAt?.date ? item.closedAt.date.split('-').reverse().join('-') : 'No disponible';
      for (const value of [item.orderId, item.paymentId, date, item.closedAt?.time || 'No disponible', money(item.total), item.reason]) tr.append(node('td', value));
      const cell = document.createElement('td'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = !!item.resolved;
      checkbox.setAttribute('aria-label', `Resuelto: pago ${item.paymentId}`);
      checkbox.addEventListener('change', async () => {
        savingResolution = true;
        content.querySelectorAll('input, select').forEach(control => { control.disabled = true; });
        saveStatus.textContent = 'Guardando…';
        try {
          const result = await request('/api/integrations/toteat/api/sales/warning-resolution', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: s.location, paymentId: item.paymentId, resolved: checkbox.checked })
          });
          resolutionRevision += 1;
          const current = salesStates.find(state => state.location === s.location)?.detailWarnings?.find(w => w.paymentId === item.paymentId);
          if (current) current.resolved = result.resolved;
          renderLoadDetails();
        } catch (error) {
          checkbox.checked = !!item.resolved;
          saveStatus.textContent = `No se pudo guardar: ${error.message}`;
          content.querySelectorAll('input, select').forEach(control => { control.disabled = false; });
        } finally { savingResolution = false; }
      });
      cell.append(checkbox); tr.append(cell);
      const cancellationCell = document.createElement('td');
      cancellationCell.append(node('span', item.cancelled ? 'Anulado · excluido de ventas. ' : 'Pendiente de verificar. '));
      const classificationButton = node('button', item.cancelled ? 'Restituir como venta' : 'Confirmar anulación');
      classificationButton.type = 'button';
      classificationButton.addEventListener('click', async () => {
        savingResolution = true;
        content.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
        saveStatus.textContent = 'Guardando estado del pago…';
        try {
          await request('/api/integrations/toteat/api/sales/payment-classification', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: s.location, paymentId: item.paymentId, cancelled: !item.cancelled })
          });
          resolutionRevision += 1;
          const result = await request('/api/integrations/toteat/api/sales/status');
          salesStates = result.locations;
          renderLoadDetails();
          window.dispatchEvent(new Event('brewit-sales-updated'));
        } catch (error) {
          saveStatus.textContent = `No se pudo guardar: ${error.message}`;
          content.querySelectorAll('input, select, button').forEach(control => { control.disabled = false; });
        } finally { savingResolution = false; }
      });
      cancellationCell.append(classificationButton); tr.append(cancellationCell);
      body.append(tr);
    });
    table.append(head, body); wrap.append(table); content.append(wrap);
  }
  document.querySelectorAll('[data-toteat-sales-status]').forEach(container => {
    container.addEventListener('click', event => {
      const button = event.target.closest('[data-sales-load-location]');
      if (!button) return;
      detailLocation = button.dataset.salesLoadLocation;
      renderLoadDetails();
      detailDialog.showModal();
    });
  });
  const busy = value => Array.from(form.elements).forEach(element => { element.disabled = value; });
  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'No se pudo completar la solicitud.');
    return body;
  }
  function describe(config) {
    return config.configured
      ? `Acceso al menú verificado el ${new Date(config.verifiedAt).toLocaleString('es-CL')}: ${config.productCount} productos y extras. Las credenciales están guardadas. Conexión verificada. La carga de datos se inicia en Datos y sincronización.`
      : 'Ingresa las credenciales de este local para probar el acceso.';
  }
  async function loadConfig() {
    const current = ++revision;
    const selectedLocation = settings.context.location;
    settingsStatus.textContent = '';
    form.elements.token.value = '';
    for (const key of ['restaurantId', 'localId', 'userId']) form.elements[key].value = '';
    settings.clean(form);
    if (!selectedLocation) { busy(true); status.textContent = 'Primero crea una cafetería en Brewit.'; settings.clean(form); return; }
    busy(true);
    status.textContent = 'Consultando la configuración guardada…';
    try {
      const config = await request(`/api/integrations/toteat/api/config?location=${encodeURIComponent(selectedLocation)}`);
      if (current !== revision) return;
      const location = settings.getLocation(selectedLocation);
      form.elements.restaurantId.value = location?.toteatRestaurantId || config.restaurantId || '';
      form.elements.localId.value = location?.toteatLocalId || config.localId || '';
      form.elements.userId.value = config.userId || '';
      form.elements.token.required = !config.configured;
      status.textContent = describe(config);
      settings.clean(form);
      await pollSales();
      if (current !== revision) return;
      populateSalesSettings();
    } catch (error) { if (current === revision) status.textContent = error.message; }
    finally { if (current === revision) busy(false); }
  }
  let locationsRevision = 0;
  async function loadLocations() {
    const current = ++locationsRevision;
    try {
      const data = await request('/api/config/locations');
      if (current !== locationsRevision) return;
      settings.setLocations(data);
    } catch { status.textContent = 'No se pudieron cargar las ubicaciones. Usa Recargar conexiones para reintentar.'; }
  }
  window.addEventListener('brewit-settings-location', loadConfig);
  refresh.addEventListener('click', () => settings.guard(loadLocations));
  window.addEventListener('brewit-location-settings-updated', loadLocations);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const selectedLocation = settings.context.location;
    const current = revision;
    form.dataset.saving = 'true';
    busy(true);
    status.textContent = 'Probando el acceso al menú de Toteat…';
    try {
      const config = await request('/api/integrations/toteat/api/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (current !== revision || selectedLocation !== settings.context.location) return;
      form.elements.token.required = false;
      status.textContent = describe(config);
      form.elements.token.value = '';
      settings.clean(form);
    } catch (error) { if (current === revision) status.textContent = error.message; }
    finally { delete form.dataset.saving; if (current === revision) { form.elements.token.value = ''; busy(false); } }
  });
  function populateSalesSettings() {
    if (settings.dirty(salesForm)) return;
    const state = salesStates.find(s => s.location === select.value);
    salesForm.elements.from.value = state?.from || new Intl.DateTimeFormat('sv-SE').format(new Date());
    salesForm.elements.from.readOnly = !!state?.lastSuccess;
    const frequency = salesSchedule || state;
    salesForm.elements.frequency.value = frequency?.enabled ? String(frequency.intervalMinutes) : 'manual';
    salesForm.querySelector('[type=submit]').disabled = !settings.context.location;
    settings.clean(salesForm);
  }
  async function pollSales() {
    if (polling || savingResolution) return;
    polling = true;
    const currentResolutionRevision = resolutionRevision;
    try {
      const data = await request('/api/integrations/toteat/api/sales/status');
      if (savingResolution || currentResolutionRevision !== resolutionRevision) return;
      salesStates = data.locations;
      salesSchedule = data.schedule || null;
      const frequencyLabel = salesForm.elements.frequency.closest('label');
      if (frequencyLabel) frequencyLabel.hidden = !!salesStates[0]?.manualOnly;
      if (!settings.dirty(salesForm)) populateSalesSettings();
      const selectedState = salesStates.find(s => s.location === settings.context.location);
      document.getElementById('settings-sales-summary').textContent = !selectedState ? 'Sin cafetería seleccionada' : selectedState.running ? 'Actualizando…' : selectedState.lastError ? `Error: ${selectedState.lastError}` : !selectedState.configured ? 'Pendiente de conectar' : !selectedState.lastSuccess ? 'Pendiente de primera carga' : selectedState.state === 'connected-empty' ? 'Conectado · sin ventas todavía' : `Última carga: ${timestamp(selectedState.lastSuccess)}`;
      let changed = false;
      const lines = salesStates.map(s => {
        if (previousVersions.has(s.location) && previousVersions.get(s.location) !== s.lastSuccess && s.lastSuccess) changed = true;
        previousVersions.set(s.location, s.lastSuccess);
        const updated = s.lastSuccess ? ` · última actualización ${new Date(s.lastSuccess).toLocaleString('es-CL')}` : '';
        const checked = s.lastCheck ? ` · comprobado ${new Date(s.lastCheck.finishedAt).toLocaleString('es-CL')} (${(s.lastCheck.durationMs / 1000).toFixed(1)} s; ${s.lastCheck.windows.map(w => `${w.from}–${w.to}`).join(', ')})` : '';
        const frequency = s.enabled ? `Automática cada ${s.intervalMinutes} min` : 'Solo manual';
        const message = s.running ? `Actualizando… ${s.progress || ''}` : s.lastError ? `No se pudo actualizar: ${s.lastError}` : !s.configured ? 'Falta conectar la API' : !s.lastSuccess ? 'Pendiente de sincronizar' : s.state === 'connected-empty' ? 'Conectado · sin ventas todavía' : `${s.orderCount} órdenes · ${s.paymentCount} pagos`;
        const pending = s.detailWarnings?.filter(item => !item.cancelled).length || 0;
        const cancelled = s.detailWarnings?.filter(item => item.cancelled).length || 0;
        const warning = [pending ? `${pending} pagos sin productos asociados, incluidos en totales y pendientes de verificar.` : '', cancelled ? `${cancelled} pagos anulados excluidos.` : ''].filter(Boolean).join(' ');
        const sources = s.lastSuccess ? ' · Ventas por producto y detalle de pagos guardados' : '';
        return `${s.name}: ${message}${sources} · ${frequency}${updated}${checked}${warning ? ' · '+warning : ''}`;
      });
      document.querySelectorAll('[data-toteat-sales-status]').forEach(e => {
        lines.forEach((line, index) => {
          const s = salesStates[index];
          let button = [...e.querySelectorAll('[data-sales-load-location]')].find(item => item.dataset.salesLoadLocation === s.location);
          if (!button) {
            button = document.createElement('button'); button.type = 'button';
            button.className = 'sales-load-trigger'; button.dataset.salesLoadLocation = s.location;
            button.setAttribute('aria-haspopup', 'dialog'); e.append(button);
          }
          button.textContent = `${line} Ver detalle ›`;
        });
        [...e.childNodes].forEach(child => { if (!child.dataset || !salesStates.some(s => s.location === child.dataset.salesLoadLocation)) child.remove(); });
      });
      if (detailDialog.open && !savingResolution) renderLoadDetails();
      if (changed) window.dispatchEvent(new Event('brewit-sales-updated'));
    } catch { document.querySelectorAll('[data-toteat-sales-status]').forEach(e => { e.textContent = 'No se pudo consultar el estado de ventas por API.'; }); }
    finally { polling = false; }
  }
  async function synchronize(location, full = false) {
    await request('/api/integrations/toteat/api/sales/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, full, recentOnly: !full }) });
    await pollSales();
  }
  salesForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = salesForm.querySelector('[type=submit]'); button.disabled = true;
    const location = settings.context.location;
    settings.setBusy(salesForm, true);
    settingsStatus.textContent = 'Guardando configuración de ventas…';
    try {
      const frequency = salesForm.elements.frequency.value;
      await request('/api/integrations/toteat/api/sales/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, from: salesForm.elements.from.value, enabled: frequency !== 'manual', intervalMinutes: frequency === 'manual' ? 5 : Number(frequency) }) });
      if (location === settings.context.location) {
        settings.clean(salesForm);
        settingsStatus.textContent = 'Configuración guardada. Usa «Ir a sincronizar ventas» para iniciar la carga.';
      }
      await pollSales();
    } catch (error) { if (location === settings.context.location) settingsStatus.textContent = error.message; }
    finally { button.disabled = false; settings.setBusy(salesForm, false); }
  });
  document.querySelectorAll('[data-toteat-sales-sync]').forEach(button => button.addEventListener('click', async () => {
    const scope = button.dataset.toteatSalesSync;
    const location = ['selected', 'history'].includes(scope) ? settings.context.syncLocation : scope === 'report' ? document.getElementById('report-location-filter').value : document.getElementById('sales-dashboard-location').value;
    button.disabled = true;
    try {
      if (['selected', 'history'].includes(scope) && !location) throw Error('Selecciona una cafetería.');
      settings.syncMessage('Iniciando actualización de ventas…', location, 'sales');
      await synchronize(location || 'all', scope === 'history');
      settings.syncMessage('Solicitud de ventas enviada. Consulta el estado y detalle de ventas.', location, 'sales');
    }
    catch (error) { settings.syncMessage(error.message, location, 'sales'); document.querySelectorAll('[data-toteat-sales-status]').forEach(e => { e.textContent = error.message; }); }
    finally { button.disabled = false; }
  }));
  setInterval(pollSales, 10000);
  loadLocations();
})();
