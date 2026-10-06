const { convert } = require('./toteat-inventory');
const { receiptDay } = require('./purchase-warehouses');

// The reception selector overrides product defaults. A zero/empty selector
// means "According to Purchase Warehouse of each Product" in Toteat.
function applyPurchaseReceiptWarehouses(documents, source, credential) {
  if (!source || String(source.restaurantId) !== String(credential.restaurantId)
    || String(source.localId) !== String(credential.localId)) throw Error('La fuente de recepciones de Compras no corresponde al local.');
  if (!source.range || !Array.isArray(source.operations?.purchases) || !Array.isArray(source.warehouses)
    || !Array.isArray(source.products)) throw Error('Falta la fuente completa de recepciones de Compras.');
  const warehouses = new Map(), products = new Map(source.products.map(p => [p.id, p])), receipts = new Map();
  for (const warehouse of source.warehouses) {
    if (!warehouse.id || warehouses.has(warehouse.id) || !Number.isInteger(Number(warehouse.custom_id)) || Number(warehouse.custom_id) <= 0) throw Error('Maestro de bodegas de recepción inválido.');
    warehouses.set(warehouse.id, Number(warehouse.custom_id));
  }
  for (const receipt of source.operations.purchases) {
    if (receipt.id == null || receipts.has(String(receipt.id)) || (receipt.local_ref && receipt.local_ref !== source.localRef)) throw Error('Recepción duplicada o de otro local.');
    receipts.set(String(receipt.id), receipt);
  }
  const result = structuredClone(documents), warnings = [];
  for (const document of result) {
    const id = String(document.movement_id), receipt = receipts.get(id);
    const date = receiptDay(document.received_date || document.recieived_date || document.emission_date);
    if (date < source.range.from || date > source.range.to || !receipt) throw Error(`Falta la recepción original de la compra ${id}; se conserva la última versión completa.`);
    if (String(receipt.document) !== String(document.document_id) || receiptDay(receipt.receive_date) !== date
      || (document.provider_ref && receipt.supplier_ref !== document.provider_ref)
      || !Array.isArray(receipt.purchase_detail) || receipt.purchase_detail.length !== document.products.length) throw Error(`La recepción ${id} no coincide con la compra contable; se conserva la última versión completa.`);
    const explicit = ![null, undefined, '', 0, '0'].includes(receipt.warehouse_receive_ref);
    const header = explicit ? warehouses.get(receipt.warehouse_receive_ref) : null;
    if (explicit && !header) throw Error(`Bodega de recepción desconocida en la compra ${id}.`);
    const remaining = [...receipt.purchase_detail];
    for (const [index, line] of document.products.entries()) {
      const candidates = remaining.filter(detail => {
        const product = products.get(detail.product_ref);
        if (line.sku && product?.custom_id !== line.sku) return false;
        if (!Number.isFinite(detail.quantity)) return false;
        try {
          const quantity = convert(line.received_quantity, line.received_measurement, detail.measure_unit, product);
          return Math.abs(quantity - detail.quantity) <= 1e-6;
        } catch { return false; }
      });
      if (!candidates.length || (!explicit && new Set(candidates.map(d => d.warehouse_ref)).size > 1)) throw Error(`Detalle ambiguo o incompatible en la recepción ${id}, línea ${index + 1}.`);
      const detail = candidates[0]; remaining.splice(remaining.indexOf(detail), 1);
      const destination = explicit ? header : warehouses.get(detail.warehouse_ref);
      if (!destination) throw Error(`Bodega de producto desconocida en la recepción ${id}.`);
      const reportedWarehouse = line.warehouse;
      line.warehouse = destination;
      line.warehouse_assignment = { source: 'purchases', mode: explicit ? 'receipt' : 'product',
        receiptId: id, receiptWarehouseRef: receipt.warehouse_receive_ref ?? null,
        detailWarehouseRef: detail.warehouse_ref, reportedWarehouse, effectiveWarehouse: destination, capturedAt: source.capturedAt };
      if (String(reportedWarehouse) !== String(destination)) warnings.push({type: 'warehouse-receipt-assigned', movementId: id,
        line: index + 1, code: line.sku, date, reportedWarehouse, warehouse: destination,
        message: `Compra ${id}, ${line.sku}: se aplica la bodega ${destination} de la recepción original; el detalle contable indicaba ${reportedWarehouse}.`});
    }
  }
  return { documents: result, warnings };
}

module.exports = { applyPurchaseReceiptWarehouses };
