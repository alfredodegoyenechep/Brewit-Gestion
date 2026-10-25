const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../../server');
async function setup(t, worker = false, fixtureOrders = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-recurrence-api-'));
  let revision = 1, reads = 0;
  const rows = [
    ['old', '2026-09-20', '3333', 10], ['a', '2026-10-01', '1111', 10], ['a-same', '2026-10-01', '1111', 5],
    ['b', '2026-10-02', '2222', 30], ['c', '2026-10-02', '3333', 40], ['a-return', '2026-10-03', '1111', 20], ['unknown', '2026-10-03', null, 25]
  ].map(([id, day, card, amount]) => ({ locationId: 'store-1', data: { SOURCE_ID: id, TRANSACTION_DATE: `${day}T10:00:00`, TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: amount, CARD_INITIAL_NUMBER: card ? '123456' : null, LAST_FOUR_DIGITS: card, STATUS: 'approved', REFUNDED_AMOUNT: 0 } }));
  const evidence = [{ source: 'mercadopago', locationId: 'store-1', from: '2026-01-01', to: '2026-11-10', complete: true, evidenceId: 'test' }];
  const source = { fingerprint: () => ({ mp: revision, purchases: revision }), readSource: query => {
    if (!['all', 'store-1', 'store-2'].includes(query.location || 'all')) throw Object.assign(new Error('Cafetería inválida'), { status: 400 });
    const ids = query.location === 'store-2' ? ['store-2'] : ['store-1'];
    return { records: rows, today: '2026-11-11', cutoff: '12:00:00', locationIds: ids, scope: { location: query.location || 'all', label: query.location === 'store-2' ? 'Tienda 2' : 'Tienda 1', locations: ids.map(id => ({ id, name: id === 'store-1' ? 'Tienda 1' : 'Tienda 2' })) }, coverage: evidence, secret: 'fixture' };
  }, readOrders: () => { reads++; return { orders: fixtureOrders, warnings: [] }; } };
  if (worker) {
    const directory = path.join(root, 'transactions', 'store-1'); fs.mkdirSync(directory, { recursive: true });
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map(r => r.data)), 'Pagos'); XLSX.writeFile(book, path.join(directory, 'mp.xlsx'));
    fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ fields: { mercadopago: { files: [{ id: 'mp', name: 'mp.xlsx', savedAt: '2026-11-11T10:00:00Z' }] } } }));
  }
  const app = createApp({ uploadsRoot: root, enableToteatSync: false, enableMercadoPagoSync: false, reportToday: '2026-11-11',
    ...(worker ? {} : { recurrenceWorker: false, recurrenceSource: source }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.address().port}`, bump() { revision++; }, reads: () => reads, source, app };
}
module.exports = { setup };
