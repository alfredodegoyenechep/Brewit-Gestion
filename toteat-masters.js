const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

function normalizeMasters(source) {
  const products = source.products.map(p => ({
    id: p.id, code: p.custom_id, name: p.name?.translations?.default || p.custom_id,
    types: p.types, active: p.status === 'ACTIVE', stockManaged: typeof p.stock_enabled === 'boolean' ? p.stock_enabled : null,
    stockUnit: p.stock_unit, baseUnit: p.base_unit, reportUnit: p.stock_reports_unit,
    recipe: p.recipe || null, conversions: p.conversions || [], hierarchies: p.hierarchies || [],
    warehouses: (p.warehouses || []).map(w => w.id), purchaseWarehouse: p.stock_purchase_warehouse?.id,
    updatedAt: p.updated_at, sourceVersion: p.last_version_id
  }));
  const hierarchies = Object.fromEntries(Object.entries(source.hierarchies).map(([type, groups]) => [type,
    groups.flatMap(g => g.listado.map(r => ({ code: r[0], name: r[2], parent: r[3] || null, sourceRow: r })))
  ]));
  const warnings = products.flatMap(p => p.stockManaged === null ? [{ code: p.code, type: 'unknown-stock-policy' }]
    : p.stockManaged && p.recipe?.ingredients?.length && !p.recipe.manufacturing_use_only
      ? [{ code: p.code, type: 'stock-with-sale-recipe', message: 'Stock habilitado y receta no restringida a transformación: comprobar movimientos originales.' }] : []);
  return { restaurantId: source.restaurantId, localId: source.localId, localRef: source.localRef,
    observedAt: source.capturedAt, historicalValidity: 'observed-at-capture', products, hierarchies,
    warehouses: source.warehouses.map(w => ({ id: w.id, code: w.custom_id, name: w.name, status: w.status })),
    suppliers: (source.suppliers || []).map(p => ({ id: p.id, code: p.custom_id, taxId: p.vat, name: p.name, status: p.status })), warnings };
}

function writeViews(directory, source) {
  const wb = XLSX.utils.book_new();
  const headers = ['ID Producto **', 'Nombre Producto *', 'Medida Base', 'Costo', 'Activo', 'Control de Stocks Activado',
    'Precio Base', 'Jerarquías de Producto *', 'Jerarquías de Ingredientes *', 'Jerarquías de Extras *'];
  for (const [sheet, type] of [['Prod', 10], ['Ingr', 2], ['Extr', 5]]) {
    const items = source.items.filter(p => p.tp === type || (type === 2 && p.tp === 1));
    const conversions = Math.max(0, ...items.map(p => p.det.conv?.length || 0));
    const technical = ['pl', 'np', 'ub', 'ce', 'st', 'wact', 'pn', 'jp', 'jing', 'jb'];
    for (let i = 0; i < conversions; i++) for (const field of ['umed', 'umedb', 'cnum', 'cden']) technical.push(`conv.${i}.${field}`);
    const rows = items.map(p => [p.pl, p.det.np, p.det.ub, p.det.ce,
      p.st, p.det.wact == null ? null : Number(Boolean(p.det.wact)), p.det.pn,
      type === 10 ? p.det.jp?.join(',') : '', type === 2 ? p.det.jp?.join(',') : '', type === 5 ? p.det.jp?.join(',') : '',
      ...technical.slice(headers.length).map(key => { const [, i, field] = key.split('.'); return p.det.conv?.[i]?.[field] ?? null; })]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([technical, [...headers, ...technical.slice(headers.length)], ...rows]), sheet);
  }
  XLSX.writeFile(wb, path.join(directory, 'master-catalog.xlsx'));
  const recipeBook = XLSX.utils.book_new(), recipeRows = [], recipeHeaders = [];
  for (const product of source.products) {
    const recipe = product.recipe;
    if (!recipe?.ingredients?.length) continue;
    if (!(recipe.quantity > 0) || !(recipe.portions_per_unit > 0)) throw Error('Cantidad de producción o porciones inválidas.');
    recipeHeaders.push({ 'Id Producto': product.custom_id, 'Cantidad a Producir': recipe.quantity,
      'Unidad de Medida': recipe.quantity_unit, 'Porciones/UM': recipe.portions_per_unit,
      SoloTransformaciones: Number(Boolean(recipe.manufacturing_use_only)), 'Manejo de Stock': product.stock_enabled });
    for (const line of recipe.ingredients) recipeRows.push({ 'Id Producto': product.custom_id,
      'Id Ingrediente': line.custom_id, 'Nombre Ingrediente*': line.name,
      'Cantidad Ingrediente': line.quantity / recipe.quantity / recipe.portions_per_unit,
      'Unidad Medida': line.quantity_unit, 'Tasa Rendimiento': line.yield_rate });
  }
  XLSX.utils.book_append_sheet(recipeBook, XLSX.utils.json_to_sheet(recipeRows), 'Detalle por porcion');
  XLSX.utils.book_append_sheet(recipeBook, XLSX.utils.json_to_sheet(recipeHeaders), 'Cabeceras originales');
  XLSX.writeFile(recipeBook, path.join(directory, 'master-recipes.xlsx'));
  for (const [key, field] of [['products', 'product-hierarchy'], ['ingredients', 'ingredient-hierarchy'], ['extras', 'extras-hierarchy']]) {
    const book = XLSX.utils.book_new();
    const rows = source.hierarchies[key].flatMap(g => g.listado.map(r => [r[0], r[2], r[3], r[key === 'products' ? 6 : key === 'ingredients' ? 4 : 8]]));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['ID Jerarquia', 'Nombre Jerarquía Producto *', 'ID nodo padre', 'Orden'], ...rows]), 'Jerarquias');
    XLSX.writeFile(book, path.join(directory, `${field}.xlsx`));
  }
  if (Array.isArray(source.suppliers)) {
    const book = XLSX.utils.book_new();
    const rows = source.suppliers.map(p => ({ 'ID Proveedor': p.custom_id, 'RUT/Fiscal ID*': p.vat,
      'Nombre*': p.name, 'Razón social': p.invoice_name, Dirección: typeof p.address === 'string' ? p.address : JSON.stringify(p.address),
      Teléfono: p.phone, Estado: p.status }));
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Proveedores');
    XLSX.writeFile(book, path.join(directory, 'master-suppliers.xlsx'));
  }
}

const SHARED_FIELDS = ['master-catalog', 'product-hierarchy', 'ingredient-hierarchy', 'extras-hierarchy', 'master-recipes', 'master-suppliers'];
function publishSharedMasters(uploadsRoot, source, counts, clock = () => new Date(), sourceVersion = null) {
  if (!Array.isArray(source.suppliers)) throw Error('Falta el maestro de proveedores; no se actualizó ningún maestro compartido.');
  const root = path.join(uploadsRoot, 'masters'), staging = path.join(uploadsRoot, '.integrations', 'toteat-api', `shared-${crypto.randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { recursive: true });
  const files = [], indexPath = path.join(root, 'masters.json'), temporary = path.join(root, `.masters-${crypto.randomUUID()}.tmp`);
  try {
    writeViews(staging, source);
    const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {};
    let time = clock().getTime(); while (index[new Date(time).toISOString()]) time++;
    const version = new Date(time).toISOString(), group = {};
    const validFrom = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date(source.capturedAt));
    for (const field of SHARED_FIELDS) {
      const name = `${crypto.randomUUID()}_${field}.xlsx`, destination = path.join(root, name);
      fs.copyFileSync(path.join(staging, `${field}.xlsx`), destination); files.push(destination);
      group[field] = { name, originalName: `${field}-La-Concepcion.xlsx`, url: `/uploads/masters/${name}`,
        size: fs.statSync(destination).size, savedAt: version, validFrom, observedAt: source.capturedAt,
        source: 'toteat-shared-api', sourceLocation: 'store-1', sourceVersion, restaurantId: source.restaurantId, localId: source.localId,
        ...(field === 'master-catalog' ? { counts: { ...counts, suppliers: source.suppliers.length } } : {}) };
    }
    index[version] = group;
    fs.writeFileSync(temporary, JSON.stringify(index, null, 2));
    fs.renameSync(temporary, indexPath);
    return group;
  } catch (error) { files.forEach(file => fs.rmSync(file, { force: true })); throw error; }
  finally { fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(temporary, { force: true }); }
}

function createMasterSync({ uploadsRoot, credentials, activeLocation, reader, clock = () => new Date() }) {
  const root = path.join(uploadsRoot, '.integrations', 'toteat-api', 'masters');
  const running = new Map(), errors = new Map();
  let sharedTask = null, sharedError = null;
  const valid = location => typeof location === 'string' && /^[a-zA-Z0-9_-]+$/.test(location) && activeLocation(location)?.type === 'store';
  const dir = location => { if (!valid(location)) throw Error('Selecciona una cafetería válida.'); return path.join(root, location); };
  const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  function current(location) {
    const base = dir(location), pointer = read(path.join(base, 'current.json'));
    return pointer ? read(path.join(base, pointer.version, 'normalized.json')) : null;
  }
  function status(location) {
    const s = current(location);
    return { location, running: running.has(location), lastError: errors.get(location) || null, observedAt: s?.observedAt || null,
      source: 'Sesión web de Toteat', counts: s ? {
        products: s.products.filter(p => p.types.includes('PRODUCT')).length,
        ingredients: s.products.filter(p => p.types.includes('INGREDIENT')).length,
        extras: s.products.filter(p => p.types.includes('EXTRA')).length,
        recipes: s.products.filter(p => p.recipe?.ingredients?.length).length,
        recipeLines: s.products.reduce((n, p) => n + (p.recipe?.ingredients?.length || 0), 0),
        hierarchies: Object.fromEntries(Object.entries(s.hierarchies).map(([k, v]) => [k, v.length])), warehouses: s.warehouses.length
      } : null, warnings: s?.warnings || [] };
  }
  function publish(location, source) {
    const config = credentials()[location];
    if (!config || source.restaurantId !== config.restaurantId || source.localId !== config.localId) throw Error('El maestro recibido no corresponde a esta cafetería.');
    if (!source.products?.length || !source.items?.length || ['products', 'ingredients', 'extras'].some(k => !Array.isArray(source.hierarchies?.[k]))) throw Error('Maestros incompletos; se conserva la versión anterior.');
    if (!Number.isFinite(Date.parse(source.capturedAt)) || source.products.some(p => !p.id || !p.custom_id || !Array.isArray(p.types))) throw Error('Formato de maestros inválido; se conserva la versión anterior.');
    const ids = new Set(source.products.map(p => p.id));
    if (ids.size !== source.products.length || source.items.some(p => !ids.has(p.m_id))) throw Error('Identidad o cobertura de maestros inconsistente.');
    const base = dir(location), version = `${clock().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    const directory = path.join(base, version);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const normalized = normalizeMasters(source);
    for (const [name, data] of [['original', source], ['normalized', normalized]]) fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(data), { mode: 0o600 });
    writeViews(directory, source);
    const pointer = path.join(base, `current-${crypto.randomBytes(4).toString('hex')}.tmp`);
    const previous = read(path.join(base, 'current.json'));
    fs.writeFileSync(pointer, JSON.stringify({ version, versions: [...(previous?.versions || []), version] }), { mode: 0o600 });
    fs.renameSync(pointer, path.join(base, 'current.json'));
    return status(location);
  }
  function synchronize(location) {
    dir(location);
    if (running.has(location)) return running.get(location);
    const config = credentials()[location];
    if (!config) return Promise.reject(Error('Configura primero el restaurante y local en la conexión de Toteat.'));
    const task = Promise.resolve().then(async () => {
      errors.delete(location);
      try { const source = await reader({ restaurantId: config.restaurantId, localId: config.localId }); return publish(location, source); }
      catch { const message = 'No se pudo actualizar. Revisa la sesión web de Toteat y vuelve a intentar; se conserva el último maestro completo.'; errors.set(location, message); throw Error(message); }
      finally { running.delete(location); }
    });
    running.set(location, task); return task;
  }
  function files(location, field) {
    if (!valid(location) || !['master-catalog', 'master-recipes', 'product-hierarchy', 'ingredient-hierarchy', 'extras-hierarchy'].includes(field)) return [];
    const base = dir(location);
    if (!fs.existsSync(base)) return [];
    const published = new Set(read(path.join(base, 'current.json'))?.versions || []);
    return fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && published.has(d.name)).flatMap(d => {
      const normalized = read(path.join(base, d.name, 'normalized.json')), filePath = path.join(base, d.name, `${field}.xlsx`);
      if (!normalized || !fs.existsSync(filePath)) return [];
      const validFrom = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date(normalized.observedAt));
      return [{ name: `${field}.xlsx`, originalName: `Toteat ${location} ${field}`, filePath, version: d.name, validFrom,
        savedAt: normalized.observedAt, source: 'toteat-authenticated-web', location }];
    });
  }
  function sharedRecord() {
    const index = read(path.join(uploadsRoot, 'masters', 'masters.json')) || {};
    return Object.values(index).map(g => g['master-catalog']).filter(r => r?.source === 'toteat-shared-api').sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
  }
  function sharedCurrent() {
    const record = sharedRecord();
    return record?.sourceVersion ? read(path.join(dir('store-1'), record.sourceVersion, 'normalized.json')) : null;
  }
  function sharedStatus() {
    const record = sharedRecord();
    return { location: 'store-1', name: 'Maestros compartidos · La Concepción', running: !!sharedTask, lastError: sharedError,
      observedAt: record?.observedAt || null, publishedAt: record?.savedAt || null, counts: record?.counts || null, warnings: [], shared: true };
  }
  function synchronizeShared() {
    if (sharedTask) return sharedTask;
    sharedTask = Promise.resolve().then(async () => {
      sharedError = null;
      try {
        const config = credentials()['store-1'];
        if (!config) throw Error('Falta conexión de La Concepción.');
        const source = await reader({ restaurantId: config.restaurantId, localId: config.localId }, { includeSuppliers: true });
        const result = publish('store-1', source);
        publishSharedMasters(uploadsRoot, source, result.counts, clock, read(path.join(dir('store-1'), 'current.json')).version);
      } catch {
        sharedError = 'No se pudieron actualizar todos los maestros desde La Concepción. Se conserva la versión compartida anterior; revisa la sesión web de Toteat.';
        throw Error(sharedError);
      } finally { sharedTask = null; }
      return sharedStatus();
    });
    return sharedTask;
  }
  return { current, status, publish, synchronize, files, synchronizeShared, sharedStatus, sharedCurrent };
}

module.exports = { createMasterSync, normalizeMasters, publishSharedMasters };
