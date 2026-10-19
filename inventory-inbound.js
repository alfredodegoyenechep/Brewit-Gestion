// Value actual receipts and central dispatches, independently
// of physical counts. Aggregated Kardex columns cannot establish transfer origin.
const { value } = require('./weekly-results');

function inboundResults({ state, location, centralIdentity, period, catalog, costResolver }) {
  if (state?.sourceKind !== 'native-documents' || !Array.isArray(state.movements)) {
    throw Error('Actualiza los documentos originales del Kardex para calcular las entradas.');
  }
  const centralLocation = location.type === 'warehouse';
  const warehouse = state.warehouses.find(item => Number(item.custom_id) === (centralLocation ? 1 : 2));
  if (!warehouse) throw Error('No está disponible la bodega operativa de la sucursal.');
  const warehouses = new Map(state.warehouses.map(item => [item.id, item]));
  const documents = new Map((state.documents || []).map(item => [item.key, item]));
  const products = new Map([...catalog].map(([code, item]) => [String(code).trim().toUpperCase(), item]));
  const groups = {
    centralWarehouseInbound: { lines: [], unresolvedOrigins: [], coverage: location.id === 'store-1'
      ? state.sourceCoverage?.transfers : state.sourceCoverage?.localTransfers },
    directSupplierInbound: { lines: [], unresolvedOrigins: [], coverage: state.sourceCoverage?.purchases }
  };
  if (centralLocation) {
    // Both transfer feeds must cover the interval to certify an empty flow.
    const ranges = [state.sourceCoverage?.transfers, state.sourceCoverage?.localTransfers];
    const coverage = ranges.every(Boolean) ? {
      from: ranges.map(range => range.from).sort().at(-1), to: ranges.map(range => range.to).sort()[0]
    } : null;
    groups.centralWarehouseInbound.coverage = coverage;
    groups.suppliesOutbound = { lines: [], unresolvedOrigins: [], errors: [], coverage };
  }
  groups.centralWarehouseInbound.errors = [];
  groups.directSupplierInbound.errors = (state.issues || []).filter(issue => (['purchase-line', 'purchase-date'].includes(issue.kind)
      || issue.kind === 'unit-conversion' && issue.source === 'purchases')
    && (!issue.date || issue.date >= period.from && issue.date <= period.through));
  const lines = new Map();
  for (const line of [...(state.operationLines || []), ...state.movements]) lines.set(line.id, line);
  for (const line of lines.values()) {
    if (line.warehouse !== warehouse.id || line.date < period.from || line.date > period.through
      || !(line.quantity > 0) || (line.active === false && !line.conversionPending)) continue;
    if (line.status && line.status !== 'APPROVED') continue;
    const doc = documents.get(line.document) || {};
    if (doc.status && doc.status !== 'APPROVED') continue;
    if (line.column === 'purchase') { groups.directSupplierInbound.lines.push(line); continue; }
    if (centralLocation) {
      if (line.column === 'transfer_local_in') {
        if (line.originWarehouseCode == null || !doc.originIdentity) groups.centralWarehouseInbound.unresolvedOrigins.push(line.id);
        else if ([1, 2].includes(Number(line.originWarehouseCode))) groups.centralWarehouseInbound.lines.push(line);
      } else if (line.column === 'transfer_local_out') groups.suppliesOutbound.lines.push(line);
      else if (['transfer_warehouse_in', 'transfer_warehouse_out'].includes(line.column)) {
        const incoming = line.column === 'transfer_warehouse_in', group = incoming ? groups.centralWarehouseInbound : groups.suppliesOutbound;
        let counterpart = incoming ? doc.originWarehouse : doc.destinationWarehouse;
        if (!counterpart) {
          const matches = [...lines.values()].filter(other => other.document === line.document && other.code === line.code
            && other.column === (incoming ? 'transfer_warehouse_out' : 'transfer_warehouse_in'));
          const ids = new Set(matches.map(other => other.warehouse));
          if (ids.size === 1) counterpart = [...ids][0];
        }
        if (!counterpart || !warehouses.has(counterpart)) group.unresolvedOrigins.push(line.id);
        else if (Number(warehouses.get(counterpart).custom_id) === 2) group.lines.push(line);
      }
      continue;
    }
    if (!['transfer_warehouse_in', 'transfer_local_in'].includes(line.column)) continue;
    const code = String(line.code).trim().toUpperCase(), product = products.get(code);
    if (product && product.type !== 'ingredient' && code !== 'SUB005') continue;
    let central = false, unresolved = false;
    if (line.column === 'transfer_warehouse_in') {
      // Warehouse 1 in Lyon is not Brewit's central warehouse.
      if (location.id !== 'store-1') continue;
      let origin = doc.originWarehouse;
      if (!origin) {
        const matches = [...lines.values()].filter(other => other.document === line.document
          && other.column === 'transfer_warehouse_out' && other.code === line.code);
        const origins = new Set(matches.map(other => other.warehouse));
        if (origins.size === 1) origin = [...origins][0];
      }
      central = Number(warehouses.get(origin)?.custom_id) === 1;
      unresolved = !origin || !warehouses.has(origin);
    } else {
      const origin = doc.originIdentity;
      if (!origin || !centralIdentity) unresolved = true;
      else if (String(origin.restaurantId) === String(centralIdentity.restaurantId)
        && Number(origin.localId) === Number(centralIdentity.localId)) {
        central = line.originWarehouseCode === 1;
        unresolved = line.originWarehouseCode == null;
      }
    }
    if (unresolved) groups.centralWarehouseInbound.unresolvedOrigins.push(line.id);
    else if (central) groups.centralWarehouseInbound.lines.push(line);
  }
  const values = {}, sources = {};
  for (const [key, group] of Object.entries(groups)) {
    const items = group.lines.map(line => {
      const code = String(line.code).trim().toUpperCase(), product = products.get(code);
      const cost = line.conversionPending || (!centralLocation && key === 'centralWarehouseInbound' && !product && code !== 'SUB005')
        ? null : costResolver.resolve(code, line.unit, product);
      const available = !!cost && cost.source !== 'missing' && !cost.costIncomplete
        && Number.isFinite(cost.unitCost) && cost.unitCost >= 0;
      return { id: line.id, document: String(documents.get(line.document)?.id ?? line.document), date: line.date,
        code, name: line.name || product?.name || code, quantity: line.quantity, unit: line.unit,
        unitCost: available ? cost.unitCost : null, amount: available ? line.quantity * cost.unitCost : null,
        costSource: cost?.source || 'missing', costSourceDate: cost?.sourceDate || null, available };
    });
    const known = items.filter(item => item.available), missingCostCodes = [...new Set(items.filter(item => !item.available).map(item => item.code))];
    const range = group.coverage && state.range ? {
      from: group.coverage.from > state.range.from ? group.coverage.from : state.range.from,
      to: group.coverage.to < state.range.to ? group.coverage.to : state.range.to
    } : null;
    const overlap = range?.from <= period.through && range?.to >= period.from;
    const complete = range?.from <= period.from && range?.to >= period.through
      && !missingCostCodes.length && !group.unresolvedOrigins.length && !group.errors.length;
    const available = known.length > 0 || (overlap && !items.length && !group.unresolvedOrigins.length && !group.errors.length);
    values[key] = value(available ? known.reduce((sum, item) => sum + item.amount, 0) : null,
      available ? complete ? 'complete' : 'partial' : 'no-data',
      { missingCostCodes, coveredLineCount: known.length, totalLineCount: items.length, unresolvedOriginCount: group.unresolvedOrigins.length });
    sources[key] = { name: centralLocation && key === 'centralWarehouseInbound' ? 'Reversas / devoluciones de cafeterías'
      : key === 'suppliesOutbound' ? 'Despachos desde Bodega Principal a cafeterías (excluye merma)'
      : key === 'centralWarehouseInbound' ? 'Entradas desde Bodega Central Local 001 La Concepcion'
      : centralLocation ? 'Compras recibidas directamente en Bodega Principal'
      : 'Compras recibidas directamente en la bodega operativa', range: range || null,
      costCutoff: period.valuationThrough || period.through, capturedAt: state.sourceCapturedAt,
      items, missingCostCodes, unresolvedOriginCount: group.unresolvedOrigins.length, issues: group.errors.map(issue => issue.message) };
  }
  return { values, sources };
}

module.exports = { inboundResults };
