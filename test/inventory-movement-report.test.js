const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');
const { buildMovementReport } = require('../inventory-movement-report');
const exportApi = require('../kardex-movement-export');

function fixture() {
  const item = { code: 'A', name: 'Café', unit: 'KG', hierarchyPath: ['Ingredientes', 'Café'], initialInventory: 1000, theoreticalFinal: 1007.5, adjustedTheoreticalFinal: 1008, compensationQuantity: .5, movements: { 'aju-tomas-intermedias': 1 }, finalInventory: null };
  const line = { id: 'buy1', document: 'buy', code: 'A', unit: 'KG', date: '2026-09-01', warehouse: 'local', column: 'purchase', quantity: 10, active: true };
  return {
    location: { type: 'store', name: 'Cafetería' },
    report: { dateFrom: '2026-09-01', dateTo: '2026-09-03', boundaryMode: true, selection: { initialDate: '2026-09-01', finalDate: '2026-09-04' } },
    items: [item, { ...item, code: 'B', name: 'Bolsa', hierarchyPath: ['Ingredientes', 'Packaging'], compensationQuantity: 0 },
      { ...item, code: 'C', name: 'Sin movimientos', hierarchyPath: ['Productos'], compensationQuantity: 0 }],
    stock: {
      sourceKind: 'native-documents', warehouses: [{ id: 'local', custom_id: 2 }, { id: 'other', custom_id: 1 }],
      documents: [{ key: 'buy', id: 'Factura 10' }],
      operationLines: [line, { ...line, id: 'buy2' }, { ...line, id: 'pending', active: false }, { ...line, id: 'other-warehouse', warehouse: 'other' },
        { ...line, id: 'other-unit', unit: 'UN' }, { ...line, id: 'outside', date: '2026-09-04' }, { ...line, id: 'count', column: 'count', quantity: 1000 }],
      movements: [line, { ...line, id: 'sale', column: 'use', quantity: 3, date: '2026-09-02' }, { ...line, id: 'B', code: 'B', quantity: 2 }],
      daily: [{ ...line, purchase: 20 }, { ...line, date: '2026-09-02', purchase: 0, use: 3 }, { ...line, date: '2026-09-03', purchase: -1 }, { ...line, code: 'B', purchase: 2 }]
    },
    consumption: { marketing: { available: true, label: 'Marketing', ingredients: { items: [{ code: 'A', unit: 'G', dailyQuantities: [{ date: '2026-09-02', quantity: 500 }] }] } } }
  };
}
const options = { convertQuantity: (quantity, from, to) => from === to ? quantity : from === 'G' && to === 'KG' ? quantity / 1000 : null };

test('movement report preserves distinct lines, removes duplicates, scopes dates/units and separates counts', () => {
  const snapshot = fixture(), before = JSON.stringify(snapshot);
  const report = buildMovementReport(snapshot, options);
  assert.equal(JSON.stringify(snapshot), before);
  const item = report.items[0];
  assert.deepEqual(report.dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(item.incoming, 20);
  assert.equal(item.outgoing, 4.5);
  assert.equal(item.finalInventory, 1008);
  assert.equal(item.physicalInventory, null);
  assert.equal(item.entries.filter(row => row.document === 'Factura 10' && row.effect === 10).length, 2);
  assert.equal(item.entries.length, 5);
  assert.deepEqual(item.days['2026-09-02'], { incoming: 0, outgoing: 3.5 });
  assert.deepEqual(item.days['2026-09-03'], { incoming: 0, outgoing: 1 });
  assert.equal(item.hasIncoming && item.hasOutgoing, true);
  assert.equal(report.items[1].hasIncoming, true);
  assert.equal(report.items[1].hasOutgoing, false);
  assert.equal(report.items[2].entries.length, 0);
});

test('daily sources preserve quantities and conflicting document totals cannot invent movements', () => {
  const snapshot = fixture();
  snapshot.stock.daily[0].purchase = 25;
  assert.throws(() => buildMovementReport(snapshot, options), /documentos y el total diario.*no coinciden/);
  snapshot.stock.operationLines = [];
  snapshot.stock.movements = [];
  assert.equal(buildMovementReport(snapshot, options).items[0].incoming, 25);
  snapshot.stock.sourceKind = 'public-inventory';
  snapshot.stock.movements = snapshot.stock.daily.map(row => ({ ...row, id: undefined, column: 'purchase', quantity: row.purchase }));
  const aggregated = buildMovementReport(snapshot, options).items[0];
  assert.equal(aggregated.incoming, 25);
  assert.equal(aggregated.outgoing, 4.5);
  assert.ok(aggregated.entries.filter(row => row.type !== 'Marketing').every(row => row.document === 'Total diario sin documento individual'));
});

test('legacy Kardex extracts daily signs and leaves adjustments outside physical flows', () => {
  const snapshot = fixture();
  snapshot.stock = null; snapshot.consumption = {};
  snapshot.parsed = {
    products: [{ code: 'A', unit: 'KG', row: [100, 10, 3, 2, 5, 110] }],
    groups: [{ date: '2026-09-01', metrics: ['II - Inicial', 'BUY - Compras', 'USO - Ventas', 'TRL-OUT - Transferencia', 'AJU - Tomas', 'IF - Final'].map((label, column) => ({ label, normalized: label.toLowerCase(), column })) }]
  };
  const item = buildMovementReport(snapshot).items[0];
  assert.equal(item.incoming, 10); assert.equal(item.outgoing, 5);
  assert.equal(item.entries.length, 3);
});

test('hierarchy segments and product names sort independently of input and codes', () => {
  const snapshot = fixture();
  snapshot.items.push({ ...snapshot.items[0], code: 'Z', name: 'Azúcar' }, { ...snapshot.items[0], code: 'D', name: 'Aceite', hierarchyPath: ['Ingredientes', 'Café 2'] });
  assert.deepEqual(buildMovementReport(snapshot, options).items.map(item => item.code), ['Z', 'A', 'D', 'B', 'C']);
});

test('workbook has both final balances, missing physical stock stays blank and counted zero stays numeric', () => {
  const snapshot = fixture();
  snapshot.items[1].finalInventory = 0;
  const report = buildMovementReport(snapshot, options);
  const book = exportApi.workbook(report, XLSX), sheet = book.Sheets['Kardex diario'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  assert.deepEqual(rows[0], ['Jerarquía', 'Producto', 'Inventario inicial', 'Inventario final teórico', 'Inventario final físico', 'Total entradas', 'Total salidas',
    'Entradas 01/09/2026', 'Entradas 02/09/2026', 'Entradas 03/09/2026', 'Salidas 01/09/2026', 'Salidas 02/09/2026', 'Salidas 03/09/2026']);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], ['Ingredientes › Café', 'Café', 1000, 1008, '', 20, 4.5, 20, 0, 0, 0, 3.5, 1]);
  assert.equal(sheet.E2, undefined);
  assert.equal(sheet.E3.t, 'n');
  assert.equal(sheet.E3.v, 0);
  assert.equal(sheet.C2.t, 'n');
  assert.deepEqual(sheet['!brewitColumnNumberFormats'][12], { decimalPlaces: 2 });
  assert.deepEqual(sheet['!brewitTextColumns'], [0, 1]);
});

test('daily workbook omits products without positive balances or movements from both sheets', () => {
  const report = buildMovementReport(fixture(), options);
  const base = { ...report.items[2], initialInventory: 0, finalInventory: 0, physicalInventory: null };
  report.items = [
    { ...base, code: 'EMPTY', name: 'Vacío' },
    { ...base, code: 'INITIAL', name: 'Solo saldo inicial', initialInventory: .001 },
    { ...base, code: 'THEORETICAL', name: 'Solo final teórico', finalInventory: 2 },
    { ...base, code: 'PHYSICAL', name: 'Solo final físico', physicalInventory: 3 },
    { ...base, code: 'IN', name: 'Solo entrada', hasIncoming: true, incoming: 1 },
    { ...base, code: 'OUT', name: 'Solo salida', hasOutgoing: true, outgoing: 1 },
    { ...base, code: 'NEGATIVE', name: 'Saldos negativos sin movimientos', initialInventory: -2, finalInventory: -1, physicalInventory: -3 },
    { ...base, code: 'ZERO', name: 'Todo cero', physicalInventory: 0 }
  ];
  const before = JSON.stringify(report);
  const book = exportApi.workbook(report, XLSX);
  const rows = XLSX.utils.sheet_to_json(book.Sheets['Kardex diario'], { header: 1 });
  assert.deepEqual(rows.slice(1).map(row => row[1]), ['Solo saldo inicial', 'Solo final teórico', 'Solo final físico', 'Solo entrada', 'Solo salida']);
  const context = XLSX.utils.sheet_to_json(book.Sheets.Contexto, { header: 1 });
  const firstProduct = context.findIndex(row => row[0] === 'Jerarquía') + 1;
  assert.deepEqual(context.slice(firstProduct).map(row => row[2]), ['INITIAL', 'THEORETICAL', 'PHYSICAL', 'IN', 'OUT']);
  assert.equal(JSON.stringify(report), before);
  report.items = [report.items[0], report.items[6], report.items[7]];
  const empty = exportApi.workbook(report, XLSX);
  assert.equal(XLSX.utils.sheet_to_json(empty.Sheets['Kardex diario'], { header: 1 }).length, 1);
});

test('PDF includes only products with both directions and paginates a long product with repeated headers', () => {
  const report = buildMovementReport(fixture(), options);
  report.items[0].entries = Array.from({ length: 140 }, (_, index) => ({ date: '2026-09-01', type: 'Compra', document: `DOC-${index}`, effect: 1 }));
  for (const locale of ['dot', 'comma']) {
    const doc = exportApi.pdf(report, jsPDF, locale);
    assert.ok(doc.getNumberOfPages() > 1);
    const output = doc.output();
    assert.ok(output.startsWith('%PDF-'));
    assert.ok(output.includes('DOC-139'));
    assert.ok(!output.includes('Bolsa'));
    assert.ok(!output.includes('Sin movimientos'));
    assert.ok(output.includes(locale === 'dot' ? '1,000.00' : '1.000,00'));
    assert.equal((output.match(/Documento \/ fuente/g) || []).length, doc.getNumberOfPages());
  }
  report.items = report.items.slice(1);
  assert.throws(() => exportApi.pdf(report, jsPDF, 'comma'), /al menos una entrada y una salida/);
});
