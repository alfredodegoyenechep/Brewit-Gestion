// Explicit, local connection/renewal command. The user must authorize session
// reuse and sign in to the configured browser before running this command.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
async function connect(uploadsRoot) {
  const root = path.join(uploadsRoot, '.integrations', 'toteat');
  const endpoint = JSON.parse(fs.readFileSync(path.join(root, 'browser-connection.json'))).cdpEndpoint;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw Error('Usa el navegador local configurado de Toteat.');
  const expected = JSON.parse(fs.readFileSync(path.join(uploadsRoot, '.integrations', 'toteat-api', 'credentials.json')))['store-1'];
  const browser = await chromium.connectOverCDP(endpoint);
  let page;
  const requests = {}, pending = [];
  try {
    page = await browser.contexts()[0].newPage();
    page.on('response', response => {
      pending.push((async () => {
        try {
          const url = new URL(response.url());
          if (url.origin !== 'https://api.toteat.com' || response.request().method() !== 'GET' || !response.ok()) return;
          let key;
          if (/^\/locals\/[a-f0-9]{24}\/products\/$/.test(url.pathname)) key = 'products';
          if (url.pathname === '/resto/setupconfig') key = {5100:'productsHierarchy',5115:'ingredientsHierarchy',5110:'extrasHierarchy'}[url.searchParams.get('xmod')];
          if (!key) return;
          const body = await response.json();
          if (body.ok === false) return;
          const headers = await response.request().allHeaders();
          requests[key] = { url: response.url(), headers: headers.authorization ? { authorization: headers.authorization } : {} };
        } catch { /* Missing responses prevent publication below. */ }
      })());
    });
    await page.goto('https://res8.toteat.com/#/productos', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      try { return angular.element(document.body).injector().get('masterProd').maestro.local.length > 0; } catch { return false; }
    }, null, { timeout: 30000 });
    const identity = await page.evaluate(() => { const c = angular.element(document.body).injector().get('configuracion').objeto; return { restaurantId: String(c.ir), localId: String(c.il) }; });
    if (identity.restaurantId !== expected.restaurantId || identity.localId !== expected.localId) throw Error('Selecciona La Concepción en Toteat antes de conectar.');
    await page.evaluate(async () => {
      const setup = angular.element(document.body).injector().get('setupConfig');
      for (const id of [5100, 5115, 5110]) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Tiempo agotado')), 20000);
        setup.Refresh(id, () => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(Error('Lectura rechazada')); });
      });
    });
    await page.goto('https://res8.toteat.com/#/list-kardex', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 30000;
    while (!requests.products && Date.now() < deadline) { await page.waitForTimeout(300); await Promise.all(pending); }
    await Promise.all(pending);
    if (['products','productsHierarchy','ingredientsHierarchy','extrasHierarchy'].some(k => !requests[k])) throw Error('No se capturaron las cuatro lecturas requeridas.');
    for (const key of ['productsHierarchy','ingredientsHierarchy','extrasHierarchy']) {
      const u = new URL(requests[key].url);
      if (u.searchParams.get('xir') !== identity.restaurantId || u.searchParams.get('xil') !== identity.localId) throw Error('La sesión cambió de local.');
    }
    const directory = path.join(root, 'direct-masters');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, 'connection.json'), temporary = path.join(directory, 'connection.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ ...identity, localRef: new URL(requests.products.url).pathname.split('/')[2], authorizedAt: new Date().toISOString(), requests }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
    console.log('Conexión de maestros guardada. Las actualizaciones harán lecturas directas desde el servidor.');
  } finally { await page?.close(); await browser.close(); }
}
if (require.main === module) connect(path.resolve(__dirname, '..', 'uploads')).catch(() => { console.error('No se pudo renovar la conexión. Abre Toteat en el navegador configurado, selecciona La Concepción y vuelve a intentar.'); process.exitCode = 1; });
module.exports = { connect };
