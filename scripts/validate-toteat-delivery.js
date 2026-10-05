// Independent, read-only pilot. Does not publish sources or change Toteat configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function modeFor(comment) {
  const text = normalize(comment);
  const takeaway = /\bllevar\b|\btake\s*away\b/.test(text);
  const local = /\bservir\b|\bconsumir en el local\b|\bdine.?in\b/.test(text);
  if (takeaway && !local) return 'takeaway';
  if (local && !takeaway) return 'local';
  return 'unknown';
}

function selectSamples(payments) {
  const grouped = new Map();
  for (const payment of payments) {
    const id = String(payment.orderId || '');
    if (!/^\d+$/.test(id)) continue;
    const order = grouped.get(id) || { orderId: id, payments: [] };
    order.payments.push(payment);
    grouped.set(id, order);
  }
  const orders = [...grouped.values()].filter(order => order.payments.every(p =>
    p.fiscalType !== 'NC' && p.total > 0 && Array.isArray(p.products) && p.products.length
    && p.products.every(line => line.quantity > 0 && line.payed >= 0)));
  const candidates = orders.map(order => {
    const modes = [...new Set(order.payments.map(p => modeFor(p.comment)))];
    const lines = new Map();
    for (const p of order.payments) for (const line of p.products) {
      if (line.lineId != null) lines.set(String(line.lineId), {
        lineId: String(line.lineId), productId: String(line.id),
        parentLineId: line.lineReference ? String(line.lineReference) : null,
        quantity: line.quantity
      });
    }
    return {
      orderId: order.orderId, mode: modes.length === 1 ? modes[0] : 'unknown',
      openedAt: order.payments.map(p => p.dateOpen).sort()[0],
      closedAt: order.payments.map(p => p.dateClosed).sort().at(-1),
      lines: [...lines.values()],
      deliveryEvents: null, observedDeliveryAt: null, comparison: 'pending'
    };
  }).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)) || a.orderId.localeCompare(b.orderId));
  const selected = [];
  function take(predicate, count, scenario) {
    for (const candidate of candidates) {
      if (!count) break;
      if (!selected.some(s => s.orderId === candidate.orderId) && predicate(candidate)) {
        selected.push({ ...candidate, scenario });
        count--;
      }
    }
    if (count) throw new Error('No hay cinco pedidos elegibles con ambos modos y múltiples productos.');
  }
  take(order => order.mode !== 'unknown' && order.lines.filter(l => !l.parentLineId).length >= 2,
    1, 'multiple-products; staggered-delivery-unconfirmed');
  take(order => order.mode === 'local', 2, 'local');
  take(order => order.mode === 'takeaway', 2, 'takeaway');
  return selected;
}

// Retain only timing/state evidence. Never save upstream errors, tokens, customer data or URLs.
function timingEvidence(value, prefix = '', output = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return output;
  for (const [key, field] of Object.entries(value)) {
    if (/client|customer|comment|address|phone|email|token|authorization|url/i.test(key)) continue;
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (/^(dateOpen|dateClosed|creationDate|creation_date|created_at|operationDate|modificationDate|time|deliveredAt|delivered_at)$/.test(key)
      && typeof field === 'string' && /^\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]+$/.test(field)) {
      const role = key === 'dateClosed' ? 'account-close'
        : key === 'modificationDate' ? 'last-modification'
          : key === 'time' ? 'notification-generated'
            : /^delivered/.test(key) ? 'delivery-candidate-unverified' : 'creation-or-operation';
      output.push({ field: fieldPath, value: field, role });
    } else if (/^(status|statusKDS|status_kds|kds_status|orderStatus|deliveryStatus|deliveryStatusId|detailedOrderStatus)$/.test(key)
      && (typeof field === 'number' || (typeof field === 'string' && /^[A-Za-z_ -]{1,60}$/.test(field)))) {
      output.push({ field: fieldPath, value: field, role: 'current-status' });
    } else if (field && typeof field === 'object') {
      timingEvidence(field, fieldPath, output, depth + 1);
    }
  }
  return output;
}

async function probeOrder(credential, order, fetchImpl = fetch) {
  const url = new URL('https://api.toteat.com/mw/or/1.0/orderstatus');
  url.search = new URLSearchParams({ xir: credential.restaurantId, xil: credential.localId,
    xiu: credential.userId, xapitoken: credential.token, ic: order.orderId, det: 'true' });
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok || body.ok !== true) {
      const denied = [401, 403].includes(response.status) || /not authorized/i.test(JSON.stringify(body.msg || ''));
      return { orderId: order.orderId, http: response.status,
        status: denied ? 'access-denied' : 'upstream-failure', evidence: [] };
    }
    const data = Array.isArray(body.data) ? body.data : [body.data];
    if (data.length !== 1 || String(data[0]?.orderId ?? data[0]?.order_id) !== order.orderId) {
      return { orderId: order.orderId, http: response.status, status: 'identity-unconfirmed', evidence: [] };
    }
    return { orderId: order.orderId, http: response.status,
      status: 'readable; delivery-unverified', evidence: timingEvidence(data[0]) };
  } catch {
    return { orderId: order.orderId, status: 'request-failed', evidence: [] };
  }
}

async function captureNativeOrders(uploads, credential, samples) {
  const { chromium } = require('playwright-core');
  const { cdpEndpoint } = JSON.parse(fs.readFileSync(path.join(uploads, '.integrations', 'toteat', 'browser-connection.json')));
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(cdpEndpoint)) throw new Error('Usa el navegador local de TotEat.');
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  try {
    const page = browser.contexts().flatMap(c => c.pages()).find(p => /^https:\/\/res\d*\.toteat\.com\//.test(p.url()));
    if (!page) throw new Error('Abre La Concepción en el navegador conectado.');
    return await page.evaluate(async input => {
      const injector = angular.element(document.body).injector();
      const config = injector.get('configuracion').objeto;
      if (String(config.ir) !== input.restaurantId || String(config.il) !== input.localId) throw new Error('Local incorrecto.');
      const api = injector.get('RESTorders');
      const results = [];
      const events = values => Array.isArray(values) ? values.filter(e => Array.isArray(e)
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(e[0]) && Number.isFinite(e[2]))
        .map(e => ({ occurredAtUtc: `${e[0]}Z`, stationOrActorId: String(e[1]), state: e[2] })) : [];
      for (const id of input.ids) {
        let timer;
        try {
          const body = await Promise.race([api.get({ ic: id }).$promise,
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20000); })]);
          const order = body.data;
          if (body.ok !== true || String(order?.io) !== id) {
            results.push({ orderId: id, status: 'native-read-failed' });
            continue;
          }
          results.push({ orderId: id, status: 'native-readable',
            openedAtUtc: order.fa ? `${order.fa}Z` : null,
            lastModifiedAtUtc: order.fm ? `${order.fm}Z` : null,
            closedAtUtc: order.fc ? `${order.fc}Z` : null,
            orderKdsEvents: events(order.lstk),
            lines: (order.dl || []).map(line => ({ lineId: String(line.li), productId: String(line.ip),
              parentLineId: line.lk ? String(line.lk) : null, state: line.st, kdsState: line.stk,
              orderedAtUtc: line.fp ? `${line.fp}Z` : null, kdsEvents: events(line.lstk) })) });
        } catch { results.push({ orderId: id, status: 'native-request-failed' }); }
        finally { clearTimeout(timer); }
      }
      return { source: 'toteat-authenticated-web; GET /resto/orders/procesa',
        utcInterpretation: 'Toteat log viewer appends -0000 to these native timestamps.',
        globalWebhookEnabled: !!config.cf?.d?.[0]?.phookGlobal,
        deliverySynchronization: !!config.cf?.d?.[0]?.kds?.syncdvy, results };
    }, { restaurantId: credential.restaurantId, localId: credential.localId, ids: samples.map(s => s.orderId) });
  } finally { await browser.close(); }
}

async function main(args) {
  if (args.some(arg => !['--query', '--native'].includes(arg))) throw new Error('Uso: node scripts/validate-toteat-delivery.js [--query] [--native]');
  const uploads = path.resolve(__dirname, '..', 'uploads');
  const root = path.join(uploads, '.integrations', 'toteat-api');
  const credential = JSON.parse(fs.readFileSync(path.join(root, 'credentials.json')))['store-1'];
  const registry = JSON.parse(fs.readFileSync(path.join(uploads, 'config', 'locations.json')));
  const location = registry.locations.find(l => l.id === 'store-1');
  if (!credential || location?.type !== 'store'
    || String(location.toteatRestaurantId) !== credential.restaurantId
    || String(location.toteatLocalId) !== credential.localId) throw new Error('La conexión no corresponde a La Concepción.');
  const salesRoot = path.join(root, 'sales', 'store-1');
  const { version } = JSON.parse(fs.readFileSync(path.join(salesRoot, 'current.json')));
  if (!/^[a-f0-9-]+$/.test(version)) throw new Error('Versión de ventas inválida.');
  const state = JSON.parse(fs.readFileSync(path.join(salesRoot, version, 'state.json')));
  const samples = selectSamples(state.payments);
  const probes = [];
  if (args.includes('--query')) for (const sample of samples) {
    probes.push(await probeOrder(credential, sample));
    // The documented limit is 10 requests/second; use sequential, spaced reads.
    if (probes.length < samples.length) await new Promise(resolve => setTimeout(resolve, 250));
  }
  let native = null;
  if (args.includes('--native')) {
    try { native = await captureNativeOrders(uploads, credential, samples); }
    catch { native = { status: 'session-unavailable', results: [] }; }
  }
  const report = { capturedAt: new Date().toISOString(), location: 'store-1', timezone: 'America/Santiago',
    sourceVersion: version, sourceSyncedAt: state.syncedAt, paymentCount: state.payments.length,
    status: probes.some(p => p.status === 'access-denied') ? 'access-blocked' : 'pending-kds-comparison',
    validatedOrders: 0, historicalCoverage: 'unverified',
    completeOrderRule: 'Last delivery of every active product; exclude cancelled products.',
    timestampPolicy: 'Account close, last modification and notification time are not delivery timestamps.',
    samples, probes, native };
  const outputRoot = path.join(root, 'delivery-review');
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(outputRoot, `probe-${crypto.randomUUID()}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ evidenceFile: path.relative(path.resolve(__dirname, '..'), destination),
    status: report.status, selectedOrders: samples.length, validatedOrders: 0,
    probeStatuses: probes.map(p => p.status), nativeReadCount: native?.results.filter(r => r.status === 'native-readable').length || 0 }));
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('No se completó el piloto. Verifica la conexión y las fuentes locales; no se modificó TotEat.');
  process.exitCode = 1;
});
module.exports = { modeFor, selectSamples, timingEvidence, probeOrder, captureNativeOrders };
