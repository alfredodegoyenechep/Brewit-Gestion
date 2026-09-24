(() => {
  const form = document.getElementById('toteat-api-form');
  const select = document.getElementById('toteat-api-location');
  const status = document.getElementById('toteat-api-status');
  const refresh = document.getElementById('toteat-api-refresh');
  let locations = [];
  let revision = 0;
  const salesForm = document.getElementById('toteat-sales-settings');
  let salesStates = [], previousVersions = new Map(), polling = false;
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
    if (s.running) content.append(node('p', s.progress || 'Consultando ventas en Toteat…'));
    if (s.lastError) content.append(node('p', `No se pudo actualizar: ${s.lastError}`));
    content.append(node('p', 'Los conteos y el detalle corresponden a la última carga exitosa de esta cafetería, independientemente del período seleccionado en el reporte.'));
    const warnings = s.detailWarnings || [];
    content.append(node('h3', `Pagos con importe sin productos (${warnings.length})`));
    if (!warnings.length) {
      content.append(node('p', s.lastSuccess ? 'No se detectaron pagos con importe sin productos en la carga.' : 'Este detalle estará disponible después de la primera carga exitosa.'));
      return;
    }
    const money = value => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(value);
    content.append(node('p', `Importe total informado: ${money(warnings.reduce((sum, item) => sum + item.total, 0))}. Estos pagos están incluidos en los totales de ventas. Toteat no entregó sus productos asociados; el desglose por producto queda incompleto.`));
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
    for (const label of ['Orden', 'ID del pago', 'Fecha de cierre', 'Hora (Chile)', 'Importe informado (CLP)', 'Motivo', 'Resuelto']) { const th = node('th', label); th.scope = 'col'; row.append(th); }
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
      ? `Acceso al menú verificado el ${new Date(config.verifiedAt).toLocaleString('es-CL')}: ${config.productCount} productos y extras. Las credenciales están guardadas. Configura abajo la actualización de ventas de esta cafetería.`
      : 'Ingresa las credenciales de este local para probar el acceso.';
  }
  async function loadConfig() {
    const current = ++revision;
    form.elements.token.value = '';
    for (const key of ['restaurantId', 'localId', 'userId']) form.elements[key].value = '';
    if (!select.value) { status.textContent = 'Primero crea una ubicación en Brewit.'; return; }
    busy(true);
    status.textContent = 'Consultando la configuración guardada…';
    try {
      const config = await request(`/api/integrations/toteat/api/config?location=${encodeURIComponent(select.value)}`);
      if (current !== revision) return;
      const location = locations.find(item => item.id === select.value);
      form.elements.restaurantId.value = config.restaurantId || location?.toteatRestaurantId || '';
      form.elements.localId.value = config.localId || location?.toteatLocalId || '';
      form.elements.userId.value = config.userId || '';
      form.elements.token.required = !config.configured;
      status.textContent = describe(config);
      await pollSales();
      populateSalesSettings();
    } catch (error) { status.textContent = error.message; }
    finally { if (current === revision) busy(false); }
  }
  async function loadLocations() {
    busy(true);
    try {
      const data = await request('/api/config/locations');
      locations = data.active.filter(location => location.type === 'store');
      const previous = select.value;
      select.replaceChildren(...locations.map(location => new Option(location.name, location.id)));
      if (locations.some(location => location.id === previous)) select.value = previous;
      await loadConfig();
    } catch { status.textContent = 'No se pudieron cargar las ubicaciones. Usa Actualizar ubicaciones para reintentar.'; }
    finally { busy(false); }
  }
  select.addEventListener('change', loadConfig);
  refresh.addEventListener('click', loadLocations);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    busy(true);
    status.textContent = 'Probando el acceso al menú de Toteat…';
    try {
      const config = await request('/api/integrations/toteat/api/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      form.elements.token.required = false;
      status.textContent = describe(config);
    } catch (error) { status.textContent = error.message; }
    finally { form.elements.token.value = ''; busy(false); }
  });
  function populateSalesSettings() {
    const state = salesStates.find(s => s.location === select.value);
    salesForm.elements.from.value = state?.from || new Intl.DateTimeFormat('sv-SE').format(new Date());
    salesForm.elements.from.readOnly = !!state?.lastSuccess;
    salesForm.elements.frequency.value = state?.enabled ? String(state.intervalMinutes) : 'manual';
  }
  async function pollSales() {
    if (polling || savingResolution) return;
    polling = true;
    const currentResolutionRevision = resolutionRevision;
    try {
      const data = await request('/api/integrations/toteat/api/sales/status');
      if (savingResolution || currentResolutionRevision !== resolutionRevision) return;
      salesStates = data.locations;
      let changed = false;
      const lines = salesStates.map(s => {
        if (previousVersions.has(s.location) && previousVersions.get(s.location) !== s.lastSuccess && s.lastSuccess) changed = true;
        previousVersions.set(s.location, s.lastSuccess);
        const updated = s.lastSuccess ? ` · última actualización ${new Date(s.lastSuccess).toLocaleString('es-CL')}` : '';
        const message = s.running ? `Actualizando… ${s.progress || ''}` : s.lastError ? `No se pudo actualizar: ${s.lastError}` : !s.configured ? 'Falta conectar la API' : !s.lastSuccess ? 'Pendiente de sincronizar' : s.state === 'connected-empty' ? 'Conectado · sin ventas todavía' : `${s.orderCount} órdenes · ${s.paymentCount} pagos`;
        const warning = s.detailWarnings?.length ? ` · Atención: ${s.detailWarnings.length} pagos con importe pero sin productos en Toteat; incluidos en totales, detalle pendiente.` : '';
        return `${s.name}: ${message}${updated}${warning}`;
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
    await request('/api/integrations/toteat/api/sales/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, full }) });
    await pollSales();
  }
  salesForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = salesForm.querySelector('[type=submit]'); button.disabled = true;
    try {
      const frequency = salesForm.elements.frequency.value;
      await request('/api/integrations/toteat/api/sales/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: select.value, from: salesForm.elements.from.value, enabled: frequency !== 'manual', intervalMinutes: frequency === 'manual' ? 5 : Number(frequency) }) });
      await synchronize(select.value);
      status.textContent = 'Configuración guardada. La primera carga histórica puede tardar unos minutos.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-toteat-sales-sync]').forEach(button => button.addEventListener('click', async () => {
    const scope = button.dataset.toteatSalesSync;
    const location = ['selected', 'history'].includes(scope) ? select.value : scope === 'report' ? document.getElementById('report-location-filter').value : document.getElementById('sales-dashboard-location').value;
    button.disabled = true;
    try { await synchronize(location || 'all', scope === 'history'); }
    catch (error) { status.textContent = error.message; document.querySelectorAll('[data-toteat-sales-status]').forEach(e => { e.textContent = error.message; }); }
    finally { button.disabled = false; }
  }));
  setInterval(pollSales, 10000);
  loadLocations();
})();
