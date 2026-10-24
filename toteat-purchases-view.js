(() => {
  const form = document.getElementById('toteat-purchases-settings');
  const settings = window.brewitSettings;
  const settingsStatus = document.getElementById('settings-purchases-status');
  const base = '/api/integrations/toteat/api/purchases';
  let states = [], polling = false;
  const versions = new Map();
  async function request(route, body, method = 'POST') {
    const response = await fetch(base + route, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo consultar compras.');
    return data;
  }
  function message(text) { document.querySelectorAll('[data-toteat-purchases-status]').forEach(e => { e.textContent = text; }); }
  function populate() {
    if (settings.dirty(form)) return;
    form.querySelector('[type=submit]').disabled = !settings.context.location;
    const s = states.find(s => s.location === settings.context.location);
    form.elements.from.value = s?.from || new Intl.DateTimeFormat('sv-SE').format(new Date());
    form.elements.from.readOnly = !!s?.lastSuccess;
    form.elements.frequency.value = s?.enabled ? String(s.intervalMinutes) : 'manual';
    settings.clean(form);
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      states = (await request('/status')).locations;
      form.elements.frequency.closest('label').hidden = !!states[0]?.manualOnly;
      form.elements.from.readOnly = !!states.find(s => s.location === settings.context.location)?.lastSuccess;
      populate();
      const selectedState = states.find(s => s.location === settings.context.location);
      document.getElementById('settings-purchases-summary').textContent = !selectedState ? 'Sin cafetería seleccionada' : selectedState.running ? 'Actualizando…' : selectedState.lastError ? `Error: ${selectedState.lastError}` : !selectedState.configured ? 'Pendiente de conectar' : !selectedState.lastSuccess ? 'Pendiente de primera carga' : selectedState.state === 'connected-empty' ? 'Conectado · sin compras todavía' : `Última carga: ${new Date(selectedState.lastSuccess).toLocaleString('es-CL')}`;
      let changed = false;
      const lines = states.map(s => {
        if (versions.has(s.location) && versions.get(s.location) !== s.lastSuccess && s.lastSuccess) changed = true;
        versions.set(s.location, s.lastSuccess);
        const status = s.running ? `Actualizando: ${s.progress || ''}` : s.lastError ? `No se pudo actualizar: ${s.lastError}` : !s.lastSuccess ? 'Pendiente de conectar compras' : s.state === 'connected-empty' ? 'Conectado · sin compras registradas' : `${s.documentCount} documentos · ${s.lineCount} líneas`;
        const rounding = s.warnings.filter(w => w.type === 'rounding').length;
        const missing = s.warnings.filter(w => w.type === 'missing-product').length;
        const discrepancies = s.warnings.filter(w => w.type === 'warehouse-discrepancy').length;
        const assigned = s.warnings.filter(w => w.type === 'warehouse-receipt-assigned').length;
        const pendingReceipts = s.warnings.some(w => w.type === 'warehouse-receipts-pending');
        return `${s.name}: ${status}${s.lastSuccess ? ` · última actualización ${new Date(s.lastSuccess).toLocaleString('es-CL')}` : ''}${rounding ? ` · ${rounding} documentos con diferencia entre cabecera y líneas; se conservan ambos importes.` : ''}${missing ? ` · Atención: ${missing} líneas sin SKU o unidades; importes incluidos, identificación pendiente.` : ''}${assigned ? ` · ${assigned} líneas asignadas según la recepción original de Compras.` : ''}${pendingReceipts ? ' · Actualiza Compras para verificar las bodegas de recepción.' : ''}${discrepancies ? ` · ${discrepancies} líneas con diferencias frente a Inventario; se conservan las bodegas de Compras.` : ''}`;
      });
      document.querySelectorAll('[data-toteat-purchases-status]').forEach(e => { e.replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; })); });
      if (changed) window.dispatchEvent(new Event('brewit-purchases-updated'));
    } catch (error) { message(error.message); }
    finally { polling = false; }
  }
  window.addEventListener('brewit-settings-location', () => { settingsStatus.textContent = ''; populate(); poll(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
    const selectedLocation = settings.context.location; settings.setBusy(form, true);
    settingsStatus.textContent = 'Guardando configuración de compras…';
    try {
      const f = form.elements.frequency.value;
      await request('/settings', { location: selectedLocation, from: form.elements.from.value, intervalMinutes: f === 'manual' ? 15 : Number(f), enabled: f !== 'manual' }, 'PUT');
      if (selectedLocation === settings.context.location) { settings.clean(form); settingsStatus.textContent = 'Configuración guardada. Usa «Ir a sincronizar compras» para iniciar la carga.'; }
      await poll();
    } catch (error) { if (selectedLocation === settings.context.location) settingsStatus.textContent = error.message; }
    finally { button.disabled = false; settings.setBusy(form, false); }
  });
  document.querySelectorAll('[data-toteat-purchases-sync]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    const scope = button.dataset.toteatPurchasesSync;
    const selectedLocation = scope === 'report' ? document.getElementById('purchases-location-filter').value || 'all' : settings.context.syncLocation;
    try {
      if (!selectedLocation) throw Error('Selecciona una cafetería.');
      settings.syncMessage('Iniciando actualización de compras…', selectedLocation, 'purchases');
      await request('/sync', { location: selectedLocation, full: scope === 'history' }); await poll();
      settings.syncMessage('Solicitud de compras enviada. Consulta el estado y advertencias de compras.', selectedLocation, 'purchases');
    } catch (error) { message(error.message); settings.syncMessage(error.message, selectedLocation, 'purchases'); }
    finally { button.disabled = false; }
  }));
  setInterval(poll, 10000); poll();
})();
