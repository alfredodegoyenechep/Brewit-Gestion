const { documentKey } = require('./toteat-purchases');
const compare = (a, b) => a.localeCompare(b, 'es', { numeric: true });
// Unknown amounts propagate to totals; a partial sum must never look complete.
function totals(items) {
  const sum = key => items.every(item => Number.isFinite(item[key]))
    ? items.reduce((total, item) => total + item[key], 0) : null;
  return { net: sum('net'), gross: sum('gross'), recorded: sum('recorded'),
    invoiceCount: items.reduce((n, item) => n + item.invoiceCount, 0),
    documentCount: items.reduce((n, item) => n + item.documentCount, 0) };
}
function buildMasterReport(payloads, period, includeProducts = false) {
  const locations = payloads.map(({ scope, rows }) => {
    const suppliers = new Map();
    rows.forEach((row, index) => {
      if (!suppliers.has(row.supplierKey)) suppliers.set(row.supplierKey, {
        key: row.supplierKey, name: row.supplier, taxId: row.supplierTaxId, documents: new Map()
      });
      const supplier = suppliers.get(row.supplierKey);
      const identity = row.document ? documentKey(row.supplierKey, row.documentType, row.document) : `unidentified-${index}`;
      if (!supplier.documents.has(identity)) supplier.documents.set(identity, {
        identity, date: row.date, number: row.document || 'Sin documento', type: row.documentType || 'Sin identificar', lines: []
      });
      supplier.documents.get(identity).lines.push(row);
    });
    const groups = [...suppliers.values()].map(supplier => {
      const documents = [...supplier.documents.values()].map(document => {
        const amounts = totals(document.lines.map(row => ({ net: row.reportNet ?? null, gross: row.reportGross ?? null,
          recorded: row.totalAmount, invoiceCount: 0, documentCount: 0 })));
        const type = documentKey('', document.type, '').split('|')[1];
        const products = includeProducts ? document.lines.map(row => ({ code: row.code, product: row.product,
          quantity: row.receivedQuantity ?? null, unit: row.receivedUnit || '', recorded: row.totalAmount })) : undefined;
        return { ...document, lines: undefined, ...amounts, products,
          invoiceCount: ['invoice', 'exemptinvoice'].includes(type) ? 1 : 0, documentCount: 1 };
      }).sort((a, b) => compare(a.date, b.date) || compare(a.number, b.number));
      return { ...supplier, documents, ...totals(documents) };
    }).sort((a, b) => compare(a.name, b.name));
    return { id: scope.location, name: scope.label, type: scope.type, suppliers: groups, ...totals(groups) };
  }).sort((a, b) => Number(a.type === 'warehouse') - Number(b.type === 'warehouse') || compare(a.name, b.name));
  const summaryMap = new Map();
  locations.forEach(location => location.suppliers.forEach(supplier => {
    if (!summaryMap.has(supplier.key)) summaryMap.set(supplier.key, { key: supplier.key, name: supplier.name, taxId: supplier.taxId, locations: [] });
    summaryMap.get(supplier.key).locations.push({ id: location.id, name: location.name, ...totals([supplier]) });
  }));
  const suppliers = [...summaryMap.values()].map(supplier => ({ ...supplier, ...totals(supplier.locations) })).sort((a, b) => compare(a.name, b.name));
  return { period, includeProducts, locations, suppliers, ...totals(locations),
    note: 'Compras por fecha de emisión. Importe Neto: suma de las líneas asignadas a cada ubicación. Las notas de crédito y otros documentos se incluyen en documentos, separados del conteo de facturas. Los documentos distribuidos entre locales se cuentan una vez en cada local.' };
}
module.exports = { buildMasterReport };
