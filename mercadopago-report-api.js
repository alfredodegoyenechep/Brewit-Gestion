// Read-only pilot for existing MercadoPago settlement reports. Never creates reports.
const XLSX = require('xlsx');
const crypto = require('node:crypto');
const BASE = 'https://api.mercadopago.com/v1/account/settlement_report';

function createReportApi({ token, fetchImpl = fetch }) {
  if (!token || typeof token !== 'string') throw Error('Falta un token autorizado de MercadoPago para el piloto.');
  const get = async suffix => {
    const response = await fetchImpl(`${BASE}/${suffix}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    });
    if (!response.ok) throw Object.assign(Error(response.status === 401 ? 'El token de MercadoPago fue rechazado.'
      : response.status === 404 ? 'El reporte solicitado no está disponible.'
        : `MercadoPago respondió ${response.status}.`), { status: response.status });
    return response;
  };
  return {
    async list() {
      const data = await (await get('list')).json();
      if (!Array.isArray(data)) throw Error('MercadoPago no entregó una lista de reportes reconocible.');
      return data.map(item => ({ id: item.id, reportId: item.report_id, accountId: item.account_id,
        fileName: item.file_name || null, from: item.begin_date, to: item.end_date,
        modifiedAt: item.last_modified || item.generation_date || null,
        status: item.status, currency: item.currency_id, format: item.format }));
    },
    async download(fileName) {
      if (!/^[a-zA-Z0-9._-]+\.(csv|xlsx)$/i.test(fileName) || fileName.includes('..')) throw Error('Nombre de reporte inválido.');
      const bytes = Buffer.from(await (await get(encodeURIComponent(fileName))).arrayBuffer());
      if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw Error('El reporte está vacío o supera el límite del piloto.');
      return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  };
}

function reportRows(bytes) {
  const book = XLSX.read(bytes, { type: 'buffer', raw: true });
  const rows = book.SheetNames.flatMap(name => XLSX.utils.sheet_to_json(book.Sheets[name], { defval: null, raw: true }));
  return rows.map(row => Object.fromEntries(Object.entries(row)
    .map(([name, value]) => [name.trim().toUpperCase(), String(value ?? '').trim()])
    .sort(([left], [right]) => left.localeCompare(right))));
}
function compareReportBytes(apiBytes, webBytes) {
  const api = reportRows(apiBytes), web = reportRows(webBytes);
  const signature = row => JSON.stringify(row);
  const count = rows => rows.reduce((map, row) => map.set(signature(row), (map.get(signature(row)) || 0) + 1), new Map());
  const apiCounts = count(api), webCounts = count(web);
  const missing = [], extra = [];
  for (const [key, amount] of webCounts) if (amount > (apiCounts.get(key) || 0)) missing.push({ row: JSON.parse(key), count: amount - (apiCounts.get(key) || 0) });
  for (const [key, amount] of apiCounts) if (amount > (webCounts.get(key) || 0)) extra.push({ row: JSON.parse(key), count: amount - (webCounts.get(key) || 0) });
  return { equivalent: !missing.length && !extra.length, apiRows: api.length, webRows: web.length,
    missing, extra, apiColumns: [...new Set(api.flatMap(Object.keys))].sort(), webColumns: [...new Set(web.flatMap(Object.keys))].sort() };
}

module.exports = { createReportApi, compareReportBytes };
