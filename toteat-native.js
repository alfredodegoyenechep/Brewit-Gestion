// Read-only adapter for Toteat's authenticated web application. This is not
// the public token API. Authorization headers live only in this function.
async function readNative(page, restaurant, { from, to, includeSuppliers = false, includeOperations = false, onProgress = () => {} } = {}) {
  const pending = [], captured = {};
  let inventoryHeaders, masterHeaders;
  const observe = response => {
    const url = new URL(response.url());
    const kind = url.origin === 'https://api.toteat.com' && /^\/locals\/[^/]+\/(products|warehouses)\/$/.exec(url.pathname)?.[1];
    if (kind) pending.push((async () => {
      if (!response.ok()) throw Error('Toteat no entregó el maestro completo.');
      const body = await response.json();
      if (!Array.isArray(body.results)) throw Error('Formato de maestro no reconocido.');
      captured[kind] = body.results;
      captured.localRef = url.pathname.split('/')[2];
      if (kind === 'warehouses') {
        const headers = await response.request().allHeaders();
        masterHeaders = { authorization: headers.authorization };
      }
    })());
    if (url.origin === 'https://inventory.toteat.com' && ['/kardex/', '/take-inventory/'].includes(url.pathname)) {
      pending.push((async () => {
        const headers = await response.request().allHeaders();
        inventoryHeaders = { authorization: headers.authorization, timezone: 'America/Santiago' };
      })());
    }
  };
  page.on('response', observe);
  try {
    await page.goto('https://res8.toteat.com/#/productos', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      try { return window.angular.element(document.body).injector().get('masterProd').maestro.local.length > 0; } catch { return false; }
    }, null, { timeout: 30000 });
    const legacy = await page.evaluate(async () => {
      const injector = window.angular.element(document.body).injector();
      const config = injector.get('configuracion').objeto, setup = injector.get('setupConfig');
      for (const mod of [5100, 5110, 5115]) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Tiempo agotado leyendo jerarquías.')), 20000);
        setup.Refresh(mod, () => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(Error('No se pudo leer la jerarquía.')); });
      });
      return { restaurantId: String(config.ir), localId: String(config.il),
        items: injector.get('masterProd').maestro.local,
        hierarchies: { products: setup.jerarquias.listado, ingredients: setup.jerarquiasIngredientes.listado, extras: setup.jerarquiasExtras.listado } };
    });
    if (legacy.restaurantId !== restaurant.restaurantId || legacy.localId !== restaurant.localId) throw Error('El local activo en Toteat no coincide con el solicitado.');
    await page.goto(`https://res8.toteat.com/#/${includeOperations ? 'autorizaciones' : 'list-kardex'}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + 45000;
    while ((!captured.warehouses || !masterHeaders || (from && !inventoryHeaders)) && Date.now() < deadline) {
      await page.waitForTimeout(250);
      await Promise.all(pending);
    }
    await Promise.all(pending);
    // Empty locations do not trigger the UI's product lookup. Read that same
    // endpoint explicitly so pre-opening locations still get complete masters.
    if (!captured.products && captured.localRef && masterHeaders?.authorization) {
      const response = await page.context().request.get(`https://api.toteat.com/locals/${encodeURIComponent(captured.localRef)}/products/`, { headers: masterHeaders, timeout: 45000, maxRedirects: 0 });
      try { if (response.ok()) captured.products = (await response.json()).results; }
      finally { await response.dispose(); }
    }
    if (!captured.products || !captured.warehouses || (from && !inventoryHeaders?.authorization)) throw Error('La sesión web no permitió leer inventario. Inicia sesión en Toteat y vuelve a actualizar.');
    const expectedIds = new Set(legacy.items.map(p => p.m_id));
    if (captured.products.length !== legacy.items.length || captured.products.some(p => p.local !== captured.localRef || !expectedIds.has(p.id))) throw Error('Los maestros recibidos están incompletos o pertenecen a otro local.');
    const result = { ...legacy, products: captured.products, warehouses: captured.warehouses, localRef: captured.localRef,
      capturedAt: new Date().toISOString(), source: 'toteat-authenticated-web', historicalValidity: 'observed-at-capture' };
    if (includeSuppliers) {
      const response = await page.context().request.get(`https://api.toteat.com/locals/${encodeURIComponent(captured.localRef)}/providers/`, { headers: masterHeaders, timeout: 45000, maxRedirects: 0 });
      try {
        if (!response.ok()) throw Error('No se pudo leer el maestro de proveedores.');
        result.suppliers = (await response.json()).results;
        if (!Array.isArray(result.suppliers) || result.suppliers.some(p => p.local !== captured.localRef)) throw Error('Proveedores incompletos o de otro local.');
      } finally { await response.dispose(); }
    }
    if (from && to && includeOperations) {
      result.range = { from, to, timezone: 'America/Santiago' };
      result.operations = {};
      for (const [kind, route] of [['counts', 'take-inventory'], ['transfers', 'transfer-warehouse'], ['transformations', 'transformations']]) {
        const documents = new Map();
        for (let start = from; start <= to;) {
        const finish = new Date(Math.min(Date.parse(to + 'T12:00:00Z'), Date.parse(start + 'T12:00:00Z') + 14 * 86400000)).toISOString().slice(0, 10);
        const url = new URL(`/${route}/`, 'https://inventory.toteat.com');
        url.search = new URLSearchParams({ local_ref: captured.localRef, init_date: start, finish_date: finish });
        const response = await page.context().request.get(url.href, { headers: inventoryHeaders, timeout: 60000, maxRedirects: 0 });
        try {
          if (!response.ok()) throw Error('No se pudo leer una fuente de inventario. Se conserva la versión anterior.');
          const body = await response.json();
          if (!Array.isArray(body.results) || body.next || (body.count != null && body.count !== body.results.length)) throw Error('La fuente de inventario está incompleta o paginada.');
          for (const document of body.results) {
            if (document.id == null || documents.has(String(document.id))) throw Error('La fuente repite documentos entre períodos; no se publicó la actualización.');
            documents.set(String(document.id), document);
          }
          onProgress(`${kind}: ${documents.size} documentos`);
        } finally { await response.dispose(); }
        start = new Date(Date.parse(finish + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
        }
        result.operations[kind] = [...documents.values()];
      }
    } else if (from && to) {
      const get = async (route, params) => {
        const url = new URL(route, 'https://inventory.toteat.com');
        url.search = new URLSearchParams({ ...params, init_date: from, finish_date: to, timezone: 'America/Santiago' });
        const response = await page.context().request.get(url.href, { headers: inventoryHeaders, timeout: 60000, maxRedirects: 0 });
        try {
          if (!response.ok()) throw Error('Toteat no completó la lectura de inventario. Se conserva la versión anterior.');
          return await response.json();
        } finally { await response.dispose(); }
      };
      result.range = { from, to, timezone: 'America/Santiago' };
      result.daily = await get('/kardex/get-kardex', { local_id: captured.localRef });
      if (!Array.isArray(result.daily)) throw Error('Formato de Kardex diario no reconocido.');
      result.partitions = [];
      const pairs = result.daily.flatMap(p => p.warehouses.map(w => ({ product: p.product_ref, warehouse: w.warehouse_ref })));
      for (const [index, pair] of pairs.entries()) {
        const data = await get(`/kardex/${encodeURIComponent(pair.product)}`, { local_ref: captured.localRef, warehouse_ref: pair.warehouse });
        if (!Array.isArray(data.results?.detail)) throw Error('Detalle de inventario incompleto. No se publicó el piloto.');
        result.partitions.push({ ...pair, rows: data.results.detail });
        onProgress(`${index + 1}/${pairs.length} combinaciones de producto y bodega`);
        await page.waitForTimeout(200);
      }
    }
    return result;
  } finally {
    page.off('response', observe);
    await Promise.allSettled(pending);
    inventoryHeaders = undefined;
    masterHeaders = undefined;
  }
}

module.exports = { readNative };
