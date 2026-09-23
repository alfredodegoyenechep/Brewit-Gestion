const fs = require('node:fs');
const path = require('node:path');

const AUTH_ERROR = 'La autenticación de la API interna de maestros venció o fue rechazada. Renueva la conexión autorizada de Toteat; se conserva el último maestro completo.';
function failure(message) { const error = new Error(message); error.safeMasterMessage = message; return error; }
function connectionPath(uploadsRoot) { return path.join(uploadsRoot, '.integrations', 'toteat', 'direct-masters', 'connection.json'); }
function configured(uploadsRoot) { return Boolean(uploadsRoot) && fs.existsSync(connectionPath(uploadsRoot)); }

// Adapt the complete product API to the existing master publisher. No old data
// is merged into a new response and no prices are substituted for costs.
function legacyItems(products) {
  return products.map(p => {
    const type = p.types?.length === 1 ? { PRODUCT: 10, INGREDIENT: 2, EXTRA: 5 }[p.types[0]] : null;
    if (!type || !p.id || !p.custom_id || !p.base_unit || !Array.isArray(p.conversions) || !Array.isArray(p.hierarchies)
      || !['ACTIVE', 'INACTIVE'].includes(p.status)) throw failure('Formato de catálogo no reconocido; se conserva el maestro anterior.');
    return { m_id: p.id, pl: p.custom_id, tp: type, st: Number(p.status === 'ACTIVE'), det: {
      np: p.name?.translations?.default || p.custom_id, ub: p.base_unit, ce: p.cost,
      wact: p.stock_enabled, pn: p.price, jp: p.hierarchies.map(h => h.custom_id),
      conv: p.conversions.map(c => {
        if (!Number.isFinite(c.numerator) || !Number.isFinite(c.denominator) || c.numerator < 0 || c.denominator < 0 || !c.conversion_unit || !c.base_unit) throw failure('Conversión de unidades inválida; se conserva el maestro anterior.');
        return { umed: c.conversion_unit, umedb: c.base_unit, cnum: c.numerator, cden: c.denominator };
      })
    } };
  });
}
async function readDirectMasters(uploadsRoot, restaurant, { fetchImpl = fetch } = {}) {
  let connection;
  try { connection = JSON.parse(fs.readFileSync(connectionPath(uploadsRoot), 'utf8')); }
  catch { throw failure('No hay una conexión directa autorizada de maestros.'); }
  const { localRef, requests } = connection;
  if (connection.restaurantId !== String(restaurant.restaurantId) || connection.localId !== String(restaurant.localId)
    || !/^[a-f0-9]{24}$/.test(localRef || '')) throw failure('La conexión de maestros no corresponde al local solicitado.');
  async function get(request, expectedPath) {
    let url;
    try { url = new URL(request.url); } catch { throw failure('Conexión directa de maestros inválida.'); }
    if (url.origin !== 'https://api.toteat.com' || url.pathname !== expectedPath || url.username || url.password) throw failure('Ruta de maestros no autorizada.');
    if (expectedPath === '/resto/setupconfig' && (url.searchParams.get('xir') !== connection.restaurantId || url.searchParams.get('xil') !== connection.localId)) throw failure('Jerarquías de otro local; no se publica.');
    let response, body;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { ...request.headers, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(45000) });
      if ([401, 403].includes(response.status)) throw failure(AUTH_ERROR);
      if (!response.ok) throw failure('La API interna no completó la lectura de maestros; se conserva la versión anterior.');
      body = await response.json();
    } catch (error) { throw error.safeMasterMessage ? error : failure('No se pudo consultar la API interna de maestros; se conserva la versión anterior.'); }
    if (body.ok === false) throw failure(AUTH_ERROR);
    return body;
  }
  async function collection(name) {
    const route = `/locals/${localRef}/${name}/`;
    const body = await get({ url: `https://api.toteat.com${route}`, headers: requests.products.headers }, route);
    if (!Array.isArray(body.results) || body.next || (body.count != null && body.count !== body.results.length)) throw failure('Maestros incompletos o paginados; no se publica la actualización.');
    if (body.results.some(p => p.local != null && p.local !== localRef)) throw failure('El maestro contiene registros de otro local.');
    return body.results;
  }
  const products = await collection('products');
  if (!products.length || new Set(products.map(p => p.id)).size !== products.length || products.some(p => p.local !== localRef)) throw failure('Catálogo incompleto o con identidad inconsistente.');
  const hierarchies = {};
  for (const [kind, moduleId] of [['products', '5100'], ['ingredients', '5115'], ['extras', '5110']]) {
    const request = requests[kind + 'Hierarchy'];
    if (!request || new URL(request.url).searchParams.get('xmod') !== moduleId) throw failure('Configuración de jerarquías inválida.');
    const body = await get(request, '/resto/setupconfig');
    if (body.ok !== true || !Array.isArray(body.data) || !body.data.length || body.data.some(g => !Array.isArray(g.listado))) throw failure('Jerarquías incompletas; no se publica la actualización.');
    hierarchies[kind] = body.data;
  }
  const warehouses = await collection('warehouses');
  const suppliers = await collection('providers');
  return { restaurantId: connection.restaurantId, localId: connection.localId, localRef,
    products, items: legacyItems(products), warehouses, suppliers, hierarchies,
    capturedAt: new Date().toISOString(), source: 'toteat-internal-direct-api', historicalValidity: 'observed-at-capture' };
}
module.exports = { readDirectMasters, legacyItems, configured, connectionPath };
