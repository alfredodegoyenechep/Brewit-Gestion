const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const XLSX = require('xlsx');
const { createApp } = require('../../server');
async function setup(t, { nestedCosts = false, recipeYield = 90 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-xray-'));
  function save(relative, sheets) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); const book = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), name); XLSX.writeFile(book, file); }
  const products = [['P0', 'Latte (CL)', 1190, 'AB.010020'], ['P1', 'Latte (GR)', 2380, 'AB.010020'], ['P2', 'Latte (XTR)', 3570, 'AB.010020'],
    ['I0', 'Iced Latte (CL)', 1190, 'AB.010080'], ['BAK', 'Croissant', 595, 'AB.140150'], ['SAND', 'Sandwich', 1785, 'AB.140160']];
  save('masters/catalog.xlsx', { Productos: products.map(([code, name, price, hierarchy]) => ({ 'ID Producto **': code, 'Nombre Producto *': name, 'Precio Base': price, Costo: 200, 'Medida Base': 'UN', Activo: 1, 'Jerarquías de Producto *': hierarchy })),
    Ingredientes: nestedCosts ? [
      { 'ID Producto **': 'CAF001', 'Nombre Producto *': 'Café Kombat', Costo: 10000, 'Medida Base': 'kg', Activo: 1 },
      { 'ID Producto **': 'CAF002', 'Nombre Producto *': 'Café Magno', Costo: 30000, 'Medida Base': 'kg', Activo: 1 },
      { 'ID Producto **': 'PAC001', 'Nombre Producto *': 'Vaso 12 oz', Costo: 10, 'Medida Base': 'UN', Activo: 1 }
    ] : [{ 'ID Producto **': 'CAF001', 'Nombre Producto *': 'Café Kombat', Costo: 10, 'Medida Base': 'g', Activo: 1, 'Jerarquías de Ingredientes *': 'IC.010' }],
    ...(nestedCosts ? { Extras: [{ 'ID Producto **': 'SUB005', 'Nombre Producto *': 'Blend', Costo: 99999, 'Medida Base': 'kg', Activo: 1 }] } : {}) });
  const recipeRow = (product, ingredient, quantity, unit, yieldRate = 100) => ({ 'Id Producto': product, 'Id Ingrediente': ingredient, 'Cantidad Ingrediente': quantity, 'Unidad Medida': unit, 'Tasa Rendimiento': yieldRate });
  save('masters/recipes.xlsx', { Recetas: [
    ...['P0', 'P1', 'P2', 'I0'].filter(code => !nestedCosts || code !== 'P0').map(code => recipeRow(code, 'CAF001', 20, 'g')),
    ...(nestedCosts ? [recipeRow('P0', 'PAC001', 1, 'UN'), recipeRow('P0', 'SUB005', 18, 'g', recipeYield), recipeRow('SUB005', 'CAF001', 600, 'g'), recipeRow('SUB005', 'CAF002', 400, 'g')] : [])
  ] });
  const hierarchies = [['AB.', '', 'Todos'], ['AB.010', 'AB.', 'Barra Cafe'], ['AB.010020', 'AB.010', 'Café Caliente'], ['AB.010080', 'AB.010', 'Iced Coffee'], ['AB.140', 'AB.', 'Bolleria, Sandwich, Bebidas - Retail'], ['AB.140150', 'AB.140', 'Bollería'], ['AB.140160', 'AB.140', 'Sandwich']];
  fs.writeFileSync(path.join(root, 'masters/hierarchy.txt'), ['ID Jerarquia\tNombre Jerarquía Producto *\tID nodo padre', ...hierarchies.map(([id, parent, name]) => `${id}\t${name}\t${parent}`)].join('\n'));
  fs.writeFileSync(path.join(root, 'masters/masters.json'), JSON.stringify({ fixture: Object.fromEntries([['master-catalog', 'catalog.xlsx'], ['master-recipes', 'recipes.xlsx'], ['product-hierarchy', 'hierarchy.txt']].map(([key, name]) => [key, { name, validFrom: '2026-01-01', savedAt: '2026-01-01T00:00:00Z' }])) }));
  const rows = [];
  for (const [id, date, total, gender, lines] of [['o1', '2026-10-03', 5950, 'Femenino', [['P0', 1, 1190], ['P1', 2, 2380], ['BAK', 1, 595], ['SAND', 1, 1785]]], ['o2', '2026-10-04', 2380, null, [['P0', 2, 2380]]], ['old', '2026-09-03', 1190, 'Masculino', [['P0', 1, 1190]]]]) {
    for (const [code, quantity, paid] of lines) { const p = products.find(p => p[0] === code); rows.push({ 'ID de orden': id, 'Fecha de creacion': date, 'Hora de creacion': '09:00:00', 'Pago total': total, Descuentos: 0,
      'ID Producto': code, Nombre: p[1], Cantidad: quantity, 'Precio a Pagar': paid, 'AB.': p[3], 'Categorías de Productos/Platos': hierarchies.find(h => h[0] === p[3])[2], 'Género': gender }); }
  }
  save('transactions/store-1/sales.xlsx', { Datos: rows });
  save('transactions/store-1/details.xlsx', { Datos: [{ Comanda: 'o1', FechaCierre: '2026-10-03', Total: 5950, 'Comentario General': 'para llevar' }, { Comanda: 'o2', FechaCierre: '2026-10-04', Total: 2380, 'Comentario General': 'cliente' }] });
  save('transactions/store-1/purchases.xlsx', { Datos: [
    ['CAF001', nestedCosts ? 'kg' : 'g', nestedCosts ? 10000 : 10], ...nestedCosts ? [['CAF002', 'kg', 30000], ['PAC001', 'UN', 10]] : [], ['BAK', 'UN', 200], ['SAND', 'UN', 200]
  ].map(([code, unit, cost], index) => ({ 'Fecha emisión': '2026-01-01', Documento: '1', Lin: index + 1, Cod: code, PRODUCTO: code, 'Q.Fac': 1, 'Q.Rec': 1, 'Um.Fac': unit, 'Um.Rec': unit, Costo: cost, 'Monto neto': cost, 'Monto total': cost })) });
  fs.writeFileSync(path.join(root, 'transactions/store-1/index.json'), JSON.stringify({ fields: { sales: { files: [{ id: 's', name: 'sales.xlsx' }] }, 'payment-details': { files: [{ id: 'd', name: 'details.xlsx' }] }, purchases: { files: [{ id: 'p', name: 'purchases.xlsx' }] } } }));
  const app = createApp({ uploadsRoot: root, sourceMode: 'legacy', reportToday: '2026-10-31', enableToteatSync: false, enableMercadoPagoSync: false, storageMaintenance: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { app.locals.salesClusterJobs.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app, base: `http://127.0.0.1:${server.address().port}`, query: new URLSearchParams({ location: 'store-1', period: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-30' }) };
}
module.exports = { setup };
