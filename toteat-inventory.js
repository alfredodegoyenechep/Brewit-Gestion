const { localTimestamp } = require('./toteat-sales');
const EPSILON = 1e-6;
const COLUMNS = ['purchase', 'use', 'transfer_local_in', 'transfer_local_out', 'transfer_warehouse_in', 'transfer_warehouse_out', 'transformed_in', 'transformed_out'];
const localDate = value => localTimestamp(value.replace(' ', 'T')).date;
const finite = value => { if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Cantidad de inventario inválida.'); return value; };
function signedMovement(row) {
  if (![1, 2].includes(row.move_id)) throw Error('Sentido de movimiento no reconocido.');
  return finite(row.quantity) * (row.move_id === 1 ? 1 : -1);
}
function movementColumn(row) {
  if (row.type_move_id === 2 && row.move_id === 1) return 'purchase';
  if (row.type_move_id === 3 && row.move_id === 2) return 'use';
  if (row.type_move_id === 6) return row.move_id === 1 ? 'transformed_in' : 'transformed_out';
  if (row.type_move_id === 8) return row.move_id === 1 ? 'transfer_warehouse_in' : 'transfer_warehouse_out';
  return null; // Unknown codes must not be silently classified as sales.
}

function reconcileInventory(source) {
  const products = new Map(source.products.map(p => [p.id, p]));
  const aggregates = new Map(), transitions = [], counts = [], closures = [], unknown = [], transfers = new Map();
  let checkedTransitions = 0, movementRows = 0;
  for (const partition of source.partitions) {
    let previous = null;
    const product = products.get(partition.product);
    const identity = { product: partition.product, code: product?.custom_id || partition.product, warehouse: partition.warehouse };
    const ordered = partition.rows.map((row, ordinal) => ({ ...row, ordinal })); // Preserve equal legitimate rows and source order.
    for (const row of ordered) {
      if (row.product_ref !== partition.product || row.warehouse_ref !== partition.warehouse) throw Error('La partición contiene movimientos de otra bodega o producto.');
      const date = localDate(row.registration_date), key = `${partition.product}|${partition.warehouse}|${date}`;
      const group = aggregates.get(key) || { ...identity, date, ...Object.fromEntries(COLUMNS.map(k => [k, 0])), net: 0, count: false, firstBalance: previous };
      if (row.type_move_id === 1 && row.move_id === 3) {
        group.count = true;
        group.countQuantity = finite(row.quantity);
        counts.push({ ...identity, at: row.registration_date, date, quantity: row.quantity,
          priorBalance: previous, adjustment: previous === null ? null : row.quantity - previous });
        if (Math.abs(row.quantity - finite(row.quantity_total)) > EPSILON) unknown.push({ ...identity, reason: 'La toma y su saldo no coinciden.', ordinal: row.ordinal });
      } else {
        movementRows++;
        const column = movementColumn(row), signed = signedMovement(row);
        if (!column) unknown.push({ ...identity, type: row.type_move_id, direction: row.move_id, ordinal: row.ordinal });
        else group[column] += finite(row.quantity);
        group.net += signed;
        if (previous !== null) {
          checkedTransitions++;
          const difference = finite(row.quantity_total) - previous - signed;
          if (Math.abs(difference) > EPSILON) transitions.push({ ...identity, ordinal: row.ordinal, difference, at: row.registration_date });
        }
        if (row.type_move_id === 8) {
          const key = `${partition.product}|${row.description}|${row.measure_unit_ref}`;
          const transfer = transfers.get(key) || { code: identity.code, description: row.description, unit: row.measure_unit_ref, net: 0, rows: 0 };
          transfer.net += signed; transfer.rows++; transfers.set(key, transfer);
        }
      }
      previous = finite(row.quantity_total);
      group.lastBalance = previous;
      aggregates.set(key, group);
    }
    const opening = ordered.findIndex(r => r.type_move_id === 1 && localDate(r.registration_date) === source.range.from);
    const closing = ordered.findIndex((r, i) => i > opening && r.type_move_id === 1 && localDate(r.registration_date) === source.range.to);
    if (opening >= 0 && closing > opening) {
      const rows = ordered.slice(opening + 1, closing), interveningCounts = rows.filter(r => r.type_move_id === 1);
      const net = rows.filter(r => r.type_move_id !== 1).reduce((sum, r) => sum + signedMovement(r), 0);
      const adjustments = interveningCounts.reduce((sum, r) => sum + r.quantity - ordered[r.ordinal - 1].quantity_total, 0);
      const expected = ordered[opening].quantity + net + adjustments;
      closures.push({ ...identity, unit: ordered[opening].measure_unit_ref, opening: ordered[opening].quantity,
        openedAt: ordered[opening].registration_date, closedAt: ordered[closing].registration_date,
        net, interimAdjustments: adjustments, expected, counted: ordered[closing].quantity,
        countDifference: ordered[closing].quantity - expected, costLastInbound: ordered[closing].cost_last_inbound });
    }
  }
  const dailyDifferences = [], daily = [];
  let comparedCells = 0;
  for (const p of source.daily) for (const w of p.warehouses) for (const row of w.inventory) {
    const date = row.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const actual = aggregates.get(`${p.product_ref}|${w.warehouse_ref}|${date}`);
    const result = { code: products.get(p.product_ref)?.custom_id || p.product_ref, warehouse: w.warehouse_ref, date, unit: p.unit,
      opening: row.initial_inventory, closing: row.final_inventory, physicalCount: row.is_taken, costLastInbound: row.cost_last_inbound };
    for (const field of COLUMNS) {
      result[field] = actual?.[field] || 0;
      comparedCells++;
      const difference = result[field] - finite(row[field]);
      if (Math.abs(difference) > EPSILON) dailyDifferences.push({ code: result.code, warehouse: w.warehouse_ref, date, field, calculated: result[field], original: row[field], difference });
    }
    result.calculatedClosing = row.initial_inventory + (actual?.net || 0);
    if (Math.abs(result.calculatedClosing - row.final_inventory) > EPSILON) dailyDifferences.push({ code: result.code, warehouse: w.warehouse_ref, date, field: 'closing', calculated: result.calculatedClosing, original: row.final_inventory });
    daily.push(result);
  }
  const missingDaily = [...aggregates.values()].filter(g => !daily.some(d => d.code === g.code && d.warehouse === g.warehouse && d.date === g.date));
  const transferDifferences = [...transfers.values()].filter(t => Math.abs(t.net) > EPSILON);
  const unresolvedProducts = [...new Set(source.partitions.map(p => p.product).filter(id => !products.has(id)))];
  return { range: source.range, epsilon: EPSILON, partitionCount: source.partitions.length,
    rowCount: source.partitions.reduce((n, p) => n + p.rows.length, 0), movementRows, checkedTransitions,
    transitions, unknown, comparedCells, dailyDifferences, missingDaily, transfers: [...transfers.values()], transferDifferences,
    counts, closures, daily, unresolvedProducts, identityCoverageComplete: !unresolvedProducts.length,
    nativeReconciliationPassed: !transitions.length && !unknown.length && !dailyDifferences.length && !missingDaily.length && !transferDifferences.length };
}

const units = { G: ['mass', 0.001], KG: ['mass', 1], ML: ['volume', 0.001], CC: ['volume', 0.001], L: ['volume', 1], UN: ['count', 1] };
function convert(quantity, from, to, product) {
  from = String(from).toUpperCase(); to = String(to).toUpperCase();
  if (from === to) return quantity;
  if (units[from] && units[to] && units[from][0] === units[to][0]) return quantity * units[from][1] / units[to][1];
  const conversion = product.conversions?.find(c => String(c.conversion_unit).toUpperCase() === from && String(c.base_unit).toUpperCase() === to);
  if (conversion && conversion.denominator > 0 && conversion.numerator > 0) return quantity * conversion.numerator / conversion.denominator;
  throw Error(`Conversión no definida para ${product.custom_id}: ${from} → ${to}.`);
}

function recipeConsumption(products, code, quantity, { transformation = false, unit = 'UN' } = {}) {
  const byCode = new Map(products.map(p => [p.custom_id, p])), result = new Map();
  const visit = (code, quantity, unit, ancestors, expandStock = false) => {
    const p = byCode.get(code);
    if (!p) throw Error(`Falta el maestro de ${code}.`);
    if (ancestors.includes(code)) throw Error(`Receta circular: ${[...ancestors, code].join(' → ')}.`);
    if (typeof p.stock_enabled !== 'boolean') throw Error(`Manejo de stock desconocido para ${code}.`);
    if (p.stock_enabled && !expandStock) {
      const q = convert(quantity, unit, p.stock_unit, p);
      const item = result.get(code) || { code, unit: p.stock_unit, quantity: 0 };
      item.quantity += q; result.set(code, item); return;
    }
    const recipe = p.recipe;
    if (!recipe?.ingredients?.length) {
      if (expandStock) throw Error(`Falta la receta de producción de ${code}.`);
      return; // A known non-stock item without a recipe has no stock movement.
    }
    if (!(recipe.quantity > 0) || !(recipe.portions_per_unit > 0)) throw Error(`Rendimiento de receta inválido para ${code}.`);
    const factor = String(unit).toUpperCase() === 'UN'
      ? quantity / recipe.quantity / recipe.portions_per_unit
      : convert(quantity, unit, recipe.quantity_unit, p) / recipe.quantity;
    for (const ingredient of recipe.ingredients) {
      if (!(ingredient.yield_rate > 0)) throw Error(`Rendimiento de ingrediente inválido para ${code}.`);
      if (ingredient.variant_overrides?.length) throw Error(`La receta de ${code} requiere resolver variantes.`);
      visit(ingredient.custom_id, factor * finite(ingredient.quantity) * 100 / ingredient.yield_rate, ingredient.quantity_unit, [...ancestors, code]);
    }
  };
  visit(code, quantity, unit, [], transformation);
  return [...result.values()];
}

function compareRecipeQuantity(calculated, recorded) {
  if (Math.abs(recorded) <= EPSILON) return { percent: null, status: Math.abs(calculated) <= EPSILON ? 'equal' : 'unexplained' };
  const percent = (calculated / recorded - 1) * 100;
  return { percent, status: Math.abs(calculated - recorded) <= EPSILON ? 'equal'
    : percent >= -5.000001 && percent <= 0 ? 'within-recipe-change-range' : 'review' };
}

function recipePilot(source, payments) {
  const products = new Map(source.products.map(p => [p.custom_id, p]));
  const productIds = new Map(source.products.map(p => [p.id, p]));
  const originalByOrder = new Map(), salePayments = new Map();
  const from = `${source.range.from}T10:00:00`, to = `${source.range.to}T10:00:00`;
  // This pilot uses the actual 06:00 Chile / 10:00 UTC takes observed in the
  // source. Refuse a different boundary instead of silently reusing it.
  const localWarehouse = source.warehouses.find(w => w.custom_id === 2)?.id;
  const takeTimes = new Set(source.partitions.filter(p => p.warehouse === localWarehouse).flatMap(p => p.rows.filter(r => r.type_move_id === 1).map(r => r.registration_date.replace(' ', 'T'))));
  if (!takeTimes.has(from) || !takeTimes.has(to)) throw Error('Las horas de las tomas no coinciden con los límites del piloto.');
  for (const partition of source.partitions.filter(p => p.warehouse === localWarehouse)) for (const row of partition.rows) {
    const at = row.registration_date.replace(' ', 'T');
    if (row.type_move_id !== 3 || at < from || at >= to) continue;
    const order = /VENTA\s*#\s*(\d+)/.exec(row.description)?.[1];
    if (!order) continue;
    const rows = originalByOrder.get(order) || []; rows.push(row); originalByOrder.set(order, rows);
  }
  for (const payment of payments) {
    if (payment.dateClosed < from || payment.dateClosed >= to) continue;
    const order = String(payment.orderId), group = salePayments.get(order) || []; group.push(payment); salePayments.set(order, group);
  }
  const estimates = new Map(), recorded = new Map(), excluded = [], included = [];
  const add = (map, code, quantity, unit) => {
    const p = products.get(code); if (!p) throw Error(`Falta producto ${code}.`);
    map.set(code, (map.get(code) || 0) + convert(quantity, unit, p.stock_unit, p));
  };
  for (const [order, group] of salePayments) {
    const lines = group.flatMap(p => p.products || []);
    // Milk/syrup replacements and packaging suppression need order context.
    // Keep these out of the tolerance test until those rules are verified.
    if (group.some(p => p.fiscalType === 'NC') || lines.some(l => l.lineReference || products.get(l.id)?.types?.includes('EXTRA'))) {
      excluded.push({ order, reason: 'extras-or-reversal' }); continue;
    }
    if (!originalByOrder.has(order)) { excluded.push({ order, reason: 'no-original-consumption' }); continue; }
    const seen = new Set(), own = new Map();
    try {
      for (const line of lines) {
        if (seen.has(String(line.lineId))) throw Error('Línea repetida entre pagos.');
        seen.add(String(line.lineId));
        for (const item of recipeConsumption(source.products, line.id, line.quantity)) add(own, item.code, item.quantity, item.unit);
      }
      const observed = new Map();
      for (const row of originalByOrder.get(order)) add(observed, productIds.get(row.product_ref)?.custom_id, row.quantity, row.measure_unit_ref);
      for (const [code, quantity] of own) estimates.set(code, (estimates.get(code) || 0) + quantity);
      for (const [code, quantity] of observed) recorded.set(code, (recorded.get(code) || 0) + quantity);
      included.push(order);
    } catch (error) { excluded.push({ order, reason: error.message }); }
  }
  const comparisons = [...new Set([...estimates.keys(), ...recorded.keys()])].map(code => ({ code,
    name: products.get(code)?.name?.translations?.default, unit: products.get(code)?.stock_unit,
    types: products.get(code)?.types, calculated: estimates.get(code) || 0, recorded: recorded.get(code) || 0,
    ...compareRecipeQuantity(estimates.get(code) || 0, recorded.get(code) || 0) })).map(row => ({ ...row,
      status: products.get(row.code)?.types?.includes('PRODUCT') && products.get(row.code)?.stock_enabled && row.status !== 'equal' ? 'review-stock-product' : row.status }));
  return { method: 'current-recipes-estimate-no-modifiers', recipeObservedAt: source.capturedAt, from, to,
    includedOrders: included.length, sourceOrders: salePayments.size, excluded, comparisons,
    originalOrdersWithoutApiPayment: [...originalByOrder.keys()].filter(id => !salePayments.has(id)) };
}

function transformationPilot(source) {
  const byId = new Map(source.products.map(p => [p.id, p])), byCode = new Map(source.products.map(p => [p.custom_id, p]));
  const documents = new Map(), calculated = new Map(), recorded = new Map(), excluded = [];
  for (const partition of source.partitions) for (const row of partition.rows) if (row.type_move_id === 6) {
    const rows = documents.get(row.description) || []; rows.push(row); documents.set(row.description, rows);
  }
  let included = 0;
  for (const [document, rows] of documents) {
    try {
      const estimate = new Map(), original = new Map();
      const add = (map, code, quantity, unit) => {
        const product = byCode.get(code);
        if (!product) throw Error('Referencia de producto ausente del maestro vigente.');
        map.set(code, (map.get(code) || 0) + convert(quantity, unit, product.stock_unit, product));
      };
      const outputs = rows.filter(r => r.move_id === 1);
      if (!outputs.length) throw Error('Transformación sin producto de salida en la ventana.');
      for (const row of outputs) {
        const product = byId.get(row.product_ref);
        for (const item of recipeConsumption(source.products, product?.custom_id, row.quantity, { transformation: true, unit: row.measure_unit_ref })) add(estimate, item.code, item.quantity, item.unit);
      }
      for (const row of rows.filter(r => r.move_id === 2)) add(original, byId.get(row.product_ref)?.custom_id, row.quantity, row.measure_unit_ref);
      for (const [code, q] of estimate) calculated.set(code, (calculated.get(code) || 0) + q);
      for (const [code, q] of original) recorded.set(code, (recorded.get(code) || 0) + q);
      included++;
    } catch (error) { excluded.push({ document, reason: error.message }); }
  }
  return { documentCount: documents.size, included, excluded, comparisons: [...new Set([...calculated.keys(), ...recorded.keys()])].map(code => ({ code,
    name: byCode.get(code)?.name?.translations?.default, unit: byCode.get(code)?.stock_unit,
    calculated: calculated.get(code) || 0, recorded: recorded.get(code) || 0,
    ...compareRecipeQuantity(calculated.get(code) || 0, recorded.get(code) || 0) })) };
}

module.exports = { reconcileInventory, recipeConsumption, compareRecipeQuantity, signedMovement, convert, recipePilot, transformationPilot };
