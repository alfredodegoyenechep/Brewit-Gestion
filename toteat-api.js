const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSalesSync } = require('./toteat-sales');
const { createPurchaseSync } = require('./toteat-purchases');

function registerToteatApi(app, { uploadsRoot, activeLocation, locations, fetchImpl = fetch, enableSync = false, requestSpacing = 21000, syncClock }) {
  const root = path.join(uploadsRoot, '.integrations', 'toteat-api');
  const file = path.join(root, 'credentials.json');
  let nextRequestAt = 0;
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let queue = Promise.resolve(), nextSalesRequestAt = 0;
  const request = (config, route, params) => {
    const task = queue.then(async () => {
      const delay = Math.max(0, nextSalesRequestAt - Date.now(), nextRequestAt - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      nextSalesRequestAt = Date.now() + requestSpacing;
      const url = new URL(`https://api.toteat.com/mw/or/1.0/${route}`);
      url.search = new URLSearchParams({ xir: config.restaurantId, xil: config.localId, xiu: config.userId, xapitoken: config.token, ...params });
      let response, payload;
      try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(45000), headers: { Accept: 'application/json' } }); payload = await response.json(); }
      catch { throw new Error('No se pudo consultar Toteat. Se conserva la última actualización.'); }
      if (response.status === 429) throw new Error('Toteat limitó las consultas. Se reintentará en el próximo ciclo.');
      if (!response.ok || payload.ok !== true) throw new Error(`Toteat no autorizó o no completó la lectura de ${route}. Revisa el permiso y las credenciales del local.`);
      return payload;
    });
    queue = task.catch(() => {}); return task;
  };
  const sync = createSalesSync({ uploadsRoot, activeLocation, credentials: read, request, clock: syncClock });
  const purchases = createPurchaseSync({ uploadsRoot, activeLocation, credentials: read, request, clock: syncClock });
  sync.purchases = purchases;
  sync.requestInventory = (config, range, warehouses) => require('./toteat-public-inventory').readPublicInventory(request, config, range, warehouses);
  const publicConfig = config => config ? {
    configured: true, restaurantId: config.restaurantId, localId: config.localId,
    userId: config.userId, verifiedAt: config.verifiedAt, productCount: config.productCount
  } : { configured: false };
  const base = '/api/integrations/toteat/api';
  app.get(`${base}/purchases/status`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ locations: (locations?.() || []).filter(l => l.type === 'store' && l.status === 'active').map(l => ({ ...purchases.status(l.id), name: l.name })) });
  });
  app.put(`${base}/purchases/settings`, (req, res) => {
    try { return res.json(purchases.configure(String(req.body?.location || ''), req.body || {})); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  });
  app.post(`${base}/purchases/sync`, (req, res) => {
    const selected = String(req.body?.location || 'all');
    const stores = (locations?.() || []).filter(l => l.type === 'store' && l.status === 'active' && (selected === 'all' || l.id === selected)
      && purchases.status(l.id).from && purchases.status(l.id).configured);
    if (!stores.length) return res.status(400).json({ error: 'Configura primero la actualización de compras de esta cafetería.' });
    for (const l of stores) purchases.synchronize(l.id, { full: req.body?.full === true }).catch(() => {});
    return res.status(202).json({ locations: stores.map(l => purchases.status(l.id)) });
  });
  app.get(`${base}/purchases/export`, (req, res) => {
    const location = String(req.query.location || '');
    if (activeLocation(location)?.type !== 'store') return res.sendStatus(404);
    const source = purchases.source(location, 'purchases')[0];
    return source ? res.download(source.filePath, `${location}-purchases-api.xlsx`) : res.sendStatus(404);
  });
  app.get(`${base}/sales/status`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const selected = String(req.query.location || 'all');
    const stores = (locations?.() || []).filter(l => l.type === 'store' && l.status === 'active' && (selected === 'all' || l.id === selected));
    if (!stores.length && selected !== 'all') return res.status(400).json({ error: 'Selecciona una cafetería activa.' });
    return res.json({ locations: stores.map(l => ({ ...sync.status(l.id), name: l.name })) });
  });
  app.patch(`${base}/sales/warning-resolution`, (req, res) => {
    try { return res.json(sync.resolveWarning(String(req.body?.location || ''), req.body?.paymentId, req.body?.resolved)); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  });
  app.put(`${base}/sales/settings`, (req, res) => {
    try { return res.json(sync.configure(String(req.body?.location || ''), req.body || {})); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  });
  app.post(`${base}/sales/sync`, (req, res) => {
    const selected = String(req.body?.location || 'all');
    const stores = (locations?.() || []).filter(l => l.type === 'store' && l.status === 'active' && (selected === 'all' || l.id === selected));
    if (!stores.length || (selected !== 'all' && !sync.status(selected).from)) return res.status(400).json({ error: 'Configura primero la sincronización de esta cafetería.' });
    const started = stores.filter(l => sync.status(l.id).from && sync.status(l.id).configured);
    if (!started.length) return res.status(400).json({ error: 'No hay cafeterías con ventas por API configuradas.' });
    for (const l of started) sync.synchronize(l.id, { full: req.body?.full === true }).catch(() => {});
    return res.status(202).json({ locations: started.map(l => sync.status(l.id)) });
  });
  app.get(`${base}/sales/export`, (req, res) => {
    const location = String(req.query.location || ''), field = String(req.query.field || '');
    if (activeLocation(location)?.type !== 'store') return res.sendStatus(404);
    const source = sync.source(location, field)[0];
    return source ? res.download(source.filePath, `${location}-${field}-api.xlsx`) : res.sendStatus(404);
  });
  app.get(`${base}/config`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!activeLocation(String(req.query.location || ''))) return res.status(400).json({ error: 'Selecciona una ubicación activa.' });
    try { return res.json(publicConfig(read()[req.query.location])); }
    catch { return res.status(500).json({ error: 'No se pudo leer la configuración de la API.' }); }
  });
  app.post(`${base}/connect`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const location = String(req.body?.location || '');
    if (!activeLocation(location)) return res.status(400).json({ error: 'Selecciona una ubicación activa.' });
    if (sync.status(location).running || purchases.status(location).running) return res.status(409).json({ error: 'Espera a que termine la sincronización antes de cambiar la conexión.' });
    let config;
    try {
      const previous = read()[location];
      config = Object.fromEntries(['restaurantId', 'localId', 'userId'].map(key => [key, String(req.body?.[key] || '').trim()]));
      config.token = String(req.body?.token || '').trim() || previous?.token;
      const local = activeLocation(location);
      if (local.type !== 'store' || (local.toteatRestaurantId && String(local.toteatRestaurantId) !== config.restaurantId) || (local.toteatLocalId && String(local.toteatLocalId) !== config.localId)) return res.status(400).json({ error: 'Los identificadores no corresponden a esta cafetería en Configuración.' });
      if ((sync.get(location) || purchases.get(location)) && previous && ['restaurantId', 'localId'].some(key => previous[key] !== config[key])) return res.status(409).json({ error: 'Esta conexión ya tiene datos sincronizados; no se puede reasignar a otro local.' });
      if (Object.values(config).some(value => !value || value.length > 1024 || /[\s\x00-\x1f]/.test(value))) {
        return res.status(400).json({ error: 'Completa los tres identificadores y el token, sin espacios.' });
      }
      if (Date.now() < Math.max(nextRequestAt, nextSalesRequestAt)) {
        res.set('Retry-After', String(Math.ceil((Math.max(nextRequestAt, nextSalesRequestAt) - Date.now()) / 1000)));
        return res.status(429).json({ error: 'Espera unos segundos antes de repetir la prueba (límite de Toteat).' });
      }
      nextRequestAt = Date.now() + 21000;
      const url = new URL('https://api.toteat.com/mw/or/1.0/products');
      url.search = new URLSearchParams({ xir: config.restaurantId, xil: config.localId, xiu: config.userId, xapitoken: config.token, activeProducts: 'false' });
      // Never return upstream payloads/errors: they may contain credentials or URLs.
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
      if (!response.ok) {
        const error = response.status === 429 ? 'Toteat alcanzó su límite de consultas. Espera un minuto.'
          : [400, 401, 403].includes(response.status) ? 'Toteat rechazó el acceso. Revisa credenciales y el permiso /products.'
          : 'Toteat no pudo responder a la prueba. Intenta nuevamente.';
        return res.status(502).json({ error });
      }
      const payload = await response.json();
      if (payload.ok !== true || !Array.isArray(payload.data)) return res.status(502).json({ error: 'Toteat no confirmó un menú válido. Revisa credenciales y el permiso /products.' });
      config.verifiedAt = new Date().toISOString();
      config.productCount = payload.data.length;
      // Read again after the request to preserve connections saved for other locations.
      const configs = read();
      configs[location] = config;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = path.join(root, `${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(configs), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      return res.json(publicConfig(config));
    } catch {
      return res.status(502).json({ error: 'No se pudo completar la conexión o guardar las credenciales. Revisa la conexión del servidor; si Toteat usa una redirección legacy, solicita revisar ese ambiente.' });
    }
  });
  if (enableSync) { sync.start(); purchases.start(); }
  return sync;
}

module.exports = { registerToteatApi };
