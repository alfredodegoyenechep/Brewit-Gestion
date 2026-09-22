(() => {
  const form = document.getElementById('toteat-api-form');
  const select = document.getElementById('toteat-api-location');
  const status = document.getElementById('toteat-api-status');
  const refresh = document.getElementById('toteat-api-refresh');
  let locations = [];
  let revision = 0;
  const salesForm = document.getElementById('toteat-sales-settings');
  let salesStates = [], previousVersions = new Map(), polling = false;
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
    if (polling) return;
    polling = true;
    try {
      const data = await request('/api/integrations/toteat/api/sales/status');
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
      document.querySelectorAll('[data-toteat-sales-status]').forEach(e => { e.replaceChildren(...lines.map(line => { const p = document.createElement('p'); p.textContent = line; return p; })); });
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
