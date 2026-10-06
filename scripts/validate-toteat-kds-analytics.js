// Read-only Analytics pilot. Uses the user's existing Chrome session; never saves tokens.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const domain = 'https://analytics.toteat.com';
const bridge = `on run argv
 tell application "Google Chrome"
  repeat with w in windows
   repeat with t in tabs of w
    set tabURL to URL of t as text
    if tabURL starts with "https://res8.toteat.com/" then
     return execute t javascript (item 1 of argv)
    end if
   end repeat
  end repeat
 end tell
end run`;
async function browserRead(js) {
  const { stdout } = await execute('osascript', ['-e', bridge, js], { timeout: 10000 });
  return stdout.trim();
}
async function session() {
  const attribute = `data-brewit-${crypto.randomUUID()}`;
  try {
    await browserRead(`(function(){var key=${JSON.stringify(attribute)};
      var user=JSON.parse(localStorage.getItem('usuarioRestoAdminLogueado'));
      document.documentElement.setAttribute(key,'pending');
      Promise.all(['dashboard_id','login'].map(function(p){return fetch('https://api.toteat.com/analytics/'+p+'/?type=operations',
        {headers:{Authorization:'Bearer '+user.tot1}}).then(function(r){if(!r.ok)throw Error();return r.json()})}))
      .then(function(r){document.documentElement.setAttribute(key,JSON.stringify({config:r[0],guestToken:r[1].results.token}))})
      .catch(function(){document.documentElement.setAttribute(key,'failed')});return 'started';})()`);
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const result = await browserRead(`document.documentElement.getAttribute(${JSON.stringify(attribute)})`);
      if (result === 'pending') continue;
      const value = JSON.parse(result);
      if (value.config.superset_uri !== domain || !/^[a-f0-9-]{36}$/.test(value.config.dashboard_id)
        || !value.guestToken) throw Error();
      return value;
    }
    throw Error();
  } finally {
    await browserRead(`document.documentElement.removeAttribute(${JSON.stringify(attribute)}); 'cleared'`).catch(() => {});
  }
}
async function main(args) {
  if (args.length !== 2 || args.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x) || !Number.isFinite(Date.parse(x)))
    || args[0] >= args[1] || Date.parse(args[1]) - Date.parse(args[0]) > 31 * 86400000) {
    throw Error('Uso: node scripts/validate-toteat-kds-analytics.js YYYY-MM-DD YYYY-MM-DD (fin exclusivo, máximo 31 días).');
  }
  const auth = await session();
  const headers = { 'X-GuestToken': auth.guestToken };
  const get = async url => {
    const response = await fetch(domain + url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('No se pudo leer la configuración Analytics.');
    return response;
  };
  const embedded = await get('/embedded/' + auth.config.dashboard_id);
  const html = await embedded.text();
  const dashboardMatch = html.match(/data-bootstrap="([^"]+)"/);
  if (!dashboardMatch) throw Error();
  const bootstrap = JSON.parse(dashboardMatch[1].replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&'));
  const dashboardId = bootstrap.embedded.dashboard_id;
  const csrf = html.match(/id="csrf_token"\s+value="([^"]+)"/)?.[1];
  if (!csrf || !Number.isInteger(dashboardId)) throw Error();
  const cookie = embedded.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
  const charts = (await (await get(`/api/v1/dashboard/${dashboardId}/charts`)).json()).result;
  const specifications = [
    { name: 'orders', metric: 'kds_p_f', columns: ['order_id', 'legacy_id', 'restaurant_name', 'order_date', 'created_at', 'status', 'kds_p_ip', 'kds_ip_f', 'kds_f_d', 'kds_p_f'] },
    { name: 'products', metric: 'kds_ip_f', columns: ['order_id', 'legacy_id', 'restaurant_name', 'order_date', 'product_id', 'product_name', 'order_type', 'canceled_line', 'is_extra', 'kds_ip_f'] }
  ];
  const sources = [];
  for (const spec of specifications) {
    const chart = charts.find(c => c.form_data?.datasource === (spec.name === 'orders' ? '128__table' : '127__table')
      && (spec.name === 'orders' ? /Duración Promedio de Ordenes/.test(c.slice_name) : /Tiempos de Preparación según KDS/.test(c.slice_name)));
    if (!chart) throw Error('La estructura del dashboard cambió; revisar antes de continuar.');
    const datasetId = Number(chart.form_data.datasource.split('__')[0]);
    const rowLimit = 10000;
    const body = { datasource: { id: datasetId, type: 'table' }, force: false,
      form_data: { dashboardId, slice_id: chart.id }, result_format: 'json', result_type: 'full',
      queries: [{ columns: spec.columns, metrics: [], filters: [], time_range: args.join(' : '),
        granularity: 'order_date', row_limit: rowLimit, order_desc: true,
        orderby: [['order_date', false]], extras: { having: '', where: '' }, applied_time_extras: {} }] };
    const response = await fetch(domain + '/api/v1/chart/data', { method: 'POST', redirect: 'error',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRFToken': csrf,
        Cookie: cookie, Referer: domain + '/embedded/' + auth.config.dashboard_id },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('Analytics no autorizó o no completó la lectura KDS.');
    const result = (await response.json()).result?.[0];
    if (result?.error || !Array.isArray(result?.data)) throw Error('Consulta KDS incompleta.');
    const rows = result.data.map(row => Object.fromEntries(spec.columns.map(key => [key, row[key] ?? null])));
    sources.push({ name: spec.name, datasetId, chartId: chart.id, truncated: rows.length >= rowLimit, rows });
  }
  const report = { capturedAt: new Date().toISOString(), from: args[0], toExclusive: args[1], dashboardId,
    source: 'TotEat Analytics / Superset', durationUnit: 'milliseconds',
    deliveryValidated: false, timestampTimezone: 'unverified; created_at differs from native UTC by three hours in checked samples', sources };
  const root = path.resolve(__dirname, '../uploads/.integrations/toteat-api/delivery-review');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `analytics-kds-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ evidenceFile: path.relative(path.resolve(__dirname, '..'), file),
    sources: sources.map(s => ({ name: s.name, rows: s.rows.length, truncated: s.truncated })) }));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message.startsWith('Uso:') ? error.message
    : 'No se completó la lectura Analytics. Verifica la sesión de TotEat y Apple Events de Chrome. No se modificó TotEat.');
  process.exitCode = 1;
});
