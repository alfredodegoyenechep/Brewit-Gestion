(() => {
  const form = document.getElementById('toteat-purchases-settings'), location = document.getElementById('toteat-api-location');
  const base = '/api/integrations/toteat/api/purchases';
  let states = [], populated = null, polling = false;
  const versions = new Map();
  async function request(route, body, method = 'POST') {
    const response = await fetch(base + route, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo consultar compras.');
    return data;
  }
  function message(text) { document.querySelectorAll('[data-toteat-purchases-status]').forEach(e => { e.textContent = text; }); }
  function populate() {
    if (!location.value) return;
    const s = states.find(s => s.location === location.value);
    form.elements.from.value = s?.from || new Intl.DateTimeFormat('sv-SE').format(new Date());
    form.elements.from.readOnly = !!s?.lastSuccess;
    form.elements.frequency.value = s?.enabled ? String(s.intervalMinutes) : 'manual';
    populated = location.value;
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      states = (await request('/status')).locations;
      form.elements.from.readOnly = !!states.find(s => s.location === location.value)?.lastSuccess;
      if (populated !== location.value) populate();
      let changed = false;
      const lines = states.map(s => {
        if (versions.has(s.location) && versions.get(s.location) !== s.lastSuccess && s.lastSuccess) changed = true;
        versions.set(s.location, s.lastSuccess);
        const status = s.running ? `Actualizando: ${s.progress || ''}` : s.lastError ? `No se pudo actualizar: ${s.lastError}` : !s.lastSuccess ? 'Pendiente de conectar compras' : s.state === 'connected-empty' ? 'Conectado · sin compras registradas' : `${s.documentCount} documentos · ${s.lineCount} líneas`;
        const rounding = s.warnings.filter(w => w.type === 'rounding').length;
        const missing = s.warnings.filter(w => w.type === 'missing-product').length;
        return `${s.name}: ${status}${s.lastSuccess ? ` · última actualización ${new Date(s.lastSuccess).toLocaleString('es-CL')}` : ''}${rounding ? ` · ${rounding} documentos con diferencia entre cabecera y líneas; se conservan ambos importes.` : ''}${missing ? ` · Atención: ${missing} líneas sin SKU o unidades; importes incluidos, identificación pendiente.` : ''}`;
      });
      document.querySelectorAll('[data-toteat-purchases-status]').forEach(e => { e.replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; })); });
      if (changed) window.dispatchEvent(new Event('brewit-purchases-updated'));
    } catch (error) { message(error.message); }
    finally { polling = false; }
  }
  location.addEventListener('change', populate);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      const f = form.elements.frequency.value;
      await request('/settings', { location: location.value, from: form.elements.from.value, intervalMinutes: f === 'manual' ? 15 : Number(f), enabled: f !== 'manual' }, 'PUT');
      await request('/sync', { location: location.value }); await poll();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-toteat-purchases-sync]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const scope = button.dataset.toteatPurchasesSync;
      await request('/sync', { location: scope === 'report' ? document.getElementById('purchases-location-filter').value || 'all' : location.value, full: scope === 'history' }); await poll();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  }));
  setInterval(poll, 10000); poll();
})();
