const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../../server');
const IDS = { name: '1791204504913222', blank: '1791204504913223', literal: '1791204504913224', negation: '1791204504913225' };
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-gender-review-'));
  const write = (location, file, rows) => {
    const dir = path.join(root, 'transactions', location); fs.mkdirSync(dir, { recursive: true });
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Datos'); XLSX.writeFile(book, path.join(dir, file));
  };
  const comments = new Map([[IDS.name, '  alfredo  '], [IDS.blank, ''], [IDS.literal, 'hombre'], [IDS.negation, 'no es para el hombre, es para Ana']]);
  function saveDetails(changed) {
    write('store-1', 'details.xlsx', [...comments].map(([id, comment]) => ({ Comanda: id, FechaCierre: '2026-10-03', Total: 1190, 'Comentario General': changed && id === IDS.name ? changed : comment })));
    const file = path.join(root, 'transactions/store-1/details.xlsx'); const stamp = new Date(Date.now() + 2000); fs.utimesSync(file, stamp, stamp);
  }
  for (const location of ['store-1', 'store-2']) {
    const ids = location === 'store-1' ? [...comments.keys()] : [IDS.name];
    write(location, 'sales.xlsx', ids.map(id => ({ 'ID de orden': id, 'Fecha de creacion': '2026-10-03', 'Hora de creacion': '10:00:00', 'Pago total': 1190, Descuentos: 0,
      'ID Producto': 'C1', Nombre: 'Café', Cantidad: 1, 'Precio a Pagar': 1190, 'Categorías de Productos/Platos': 'Café' })));
    if (location === 'store-1') saveDetails();
    else write(location, 'details.xlsx', [{ Comanda: IDS.name, FechaCierre: '2026-10-03', Total: 1190, 'Comentario General': 'alfredo' }]);
    fs.writeFileSync(path.join(root, 'transactions', location, 'index.json'), JSON.stringify({ fields: { sales: { files: [{ id: 's', name: 'sales.xlsx' }] }, 'payment-details': { files: [{ id: 'p', name: 'details.xlsx' }] } } }));
  }
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', reportToday: '2026-10-31', enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false, clusterSourceWorker: false, ...options });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, base: `http://127.0.0.1:${server.address().port}`, saveDetails };
}
function fill(book, assignments) {
  const sheet = book.Sheets.Asignaciones;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  rows.slice(1).forEach((row, index) => {
    const value = assignments[`${row[0]}:${row[2]}`];
    if (value) sheet[`K${index + 2}`] = { t: 's', v: value };
  });
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
module.exports = { setup, fill, IDS };
