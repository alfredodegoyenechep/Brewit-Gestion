const { convert } = require('./toteat-inventory');

const day = value => {
  const result = String(value || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw Error('Fecha de recepción inválida al conciliar bodegas.');
  return result;
};
const key = (date, code) => `${date}|${code}`;
const add = (map, warehouse, quantity) => map.set(String(warehouse), (map.get(String(warehouse)) || 0) + quantity);

// Purchases already resolves the receiving warehouse. Inventory is only a
// cross-check: discrepancies must never reroute a purchase or alter its amounts.
function reconcilePurchaseWarehouses(documents, batches = [], products = []) {
  const result = structuredClone(documents), inventory = new Map(), groups = new Map(), warnings = [], corrections = [];
  const masters = new Map(products.map(product => [product.code || product.custom_id, product]));
  const codes = new Set(documents.flatMap(document => document.products.map(line => line.sku)).filter(Boolean));
  const seen = new Set();
  for (const batch of batches) {
    if (!Array.isArray(batch.data) || !batch.from || !batch.to) throw Error('Falta la evidencia de inventario para conciliar bodegas.');
    for (const product of batch.data) {
      if (!codes.has(product.sku)) continue;
      if (!product.sku || !product.unit || !Array.isArray(product.warehouses)) throw Error('Producto de inventario sin identidad, unidad o bodegas.');
      for (const warehouse of product.warehouses) {
        if (!Number.isInteger(Number(warehouse.warehouse_id)) || Number(warehouse.warehouse_id) <= 0 || !Array.isArray(warehouse.inventory)) throw Error('Bodega de inventario sin detalle.');
        for (const row of warehouse.inventory) {
          const date = day(row.date), identity = `${key(date, product.sku)}|${warehouse.warehouse_id}`;
          if (date < batch.from || date > batch.to || seen.has(identity) || !Number.isFinite(row.purchase)) throw Error('Evidencia de compras en inventario duplicada o inválida.');
          seen.add(identity);
          const group = inventory.get(key(date, product.sku)) || { unit: product.unit, warehouses: new Map(), capturedAt: batch.capturedAt || null };
          if (group.unit !== product.unit) throw Error('Inventario con unidades incompatibles para el mismo producto y día.');
          add(group.warehouses, warehouse.warehouse_id, row.purchase);
          inventory.set(key(date, product.sku), group);
        }
      }
    }
  }
  for (const document of result) {
    const received = document.received_date || document.recieived_date;
    if (!received) continue; // The ledger already excludes purchases without receipt dates.
    const date = day(received);
    if (!batches.some(batch => date >= batch.from && date <= batch.to)) continue;
    for (const [index, line] of document.products.entries()) {
      if (!line.sku || !line.received_measurement || line.received_quantity === 0) continue;
      const identity = key(date, line.sku), group = groups.get(identity) || { date, code: line.sku, lines: [] };
      group.lines.push({ document, index, line }); groups.set(identity, group);
    }
  }
  for (const [identity, group] of groups) {
    const evidence = inventory.get(identity), master = masters.get(group.code);
    if (!evidence) {
      if (master?.stockManaged === false || master?.stock_enabled === false) {
        warnings.push({type: 'warehouse-not-applicable', code: group.code, date: group.date, message: 'Producto sin manejo de stock; su bodega no se verifica contra inventario.'});
        continue;
      }
      warnings.push({type: 'warehouse-unverified', code: group.code, date: group.date,
        message: 'Falta el registro diario de inventario; se conserva la bodega de la API de Compras.'});
      continue;
    }
    const original = new Map();
    for (const entry of group.lines) {
      try { entry.quantity = convert(entry.line.received_quantity, entry.line.received_measurement, evidence.unit, {...master, custom_id: group.code}); }
      catch { entry.quantity = null; }
      if (entry.quantity === null) continue;
      if (!Number.isFinite(entry.quantity)) throw Error('Cantidad inválida para comparar con inventario.');
      add(original, entry.line.warehouse, entry.quantity);
    }
    if (group.lines.some(entry => entry.quantity === null)) {
      warnings.push({type: 'warehouse-unverified', code: group.code, date: group.date,
        message: 'Las unidades no permiten comparar con inventario; se conserva la bodega de la API de Compras.'});
      continue;
    }
    // Converted volume/mass receipts can differ at the last posted stock
    // decimal (e.g. BOT factors 1/1.33333 versus 0.75 L). Never apply that
    // allowance to purchases already expressed in the inventory unit or UN.
    const tolerance = 1e-6 + (evidence.unit.toUpperCase() === 'UN' ? 0 : group.lines.filter(entry => entry.line.received_measurement.toUpperCase() !== evidence.unit.toUpperCase()).length * 0.0005);
    const matches = (a, b) => Math.abs(a - b) <= tolerance;
    const warehouses = new Set([...original.keys(), ...evidence.warehouses.keys()]);
    const agrees = [...warehouses].every(warehouse => matches(original.get(warehouse) || 0, evidence.warehouses.get(warehouse) || 0));
    for (const {document, index, line, quantity} of group.lines) {
      line.warehouse_reconciliation = { source: line.warehouse_assignment?.source || 'accountingmovements', verificationSource: 'inventorystate', date: group.date, unit: evidence.unit, quantity,
        capturedAt: evidence.capturedAt, reportedWarehouse: line.warehouse_assignment?.reportedWarehouse ?? line.warehouse, effectiveWarehouse: line.warehouse, status: agrees ? 'verified' : 'discrepancy',
        inventoryWarehouses: Object.fromEntries(evidence.warehouses) };
      if (!agrees) {
        warnings.push({ movementId: String(document.movement_id), line: index + 1, code: group.code, date: group.date,
          warehouse: line.warehouse, type: 'warehouse-discrepancy',
          message: `La API de Inventario difiere de la API de Compras para ${group.code}; se conserva la bodega ${line.warehouse} indicada en Compras.` });
      }
    }
  }
  return {documents: result, warnings, corrections};
}

module.exports = { reconcilePurchaseWarehouses, receiptDay: day };
