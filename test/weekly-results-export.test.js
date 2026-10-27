const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');
const { buildWeeklyResults, value } = require('../weekly-results');
const exporter = require('../weekly-results-export');

function fixture(count = 3, partial = false) {
  const locations = Array.from({ length: count }, (_, index) => ({ id: `store-${index}`, name: `Sucursal ${index + 1}` }));
  return buildWeeklyResults({ weeks: 4, includeCurrent: true, today: '2026-10-14', locations }, () => ({
    values: { netSales: value(1000.25, partial ? 'partial' : 'complete'), margin: value(700.25, 'complete'),
      grossSales: value(1300.25, 'complete'), discounts: value(110.25, 'complete'),
      tips: value(100, 'complete'), mercadoPagoFee: value(35, 'complete'), cashCollection: value(200, 'complete'),
      mercadoPagoCollection: value(900, 'complete'), inventoryShortage: value(-50, 'partial'),
      finalInventory: value(1800, 'complete', { basis: 'physical', date: '2026-10-11' }),
      otherConsumables: value(-40, 'complete'), waste: value(-10, 'complete'), marketing: value(-20, 'complete'), employees: value(-30, 'complete') },
    inventory: { initialDate: '2026-10-04', finalDate: '2026-10-11' }
  }));
}

test('export model preserves the calculated snapshot, amounts, percentages, coverage and presentation groups', () => {
  const source = fixture();
  const report = exporter.model(source);
  assert.equal(report.columns.length, 12);
  assert.equal(report.rows[0].key, 'netSales');
  assert.equal(report.rows[0].cells[0].value, 1000.25);
  assert.equal(report.rows[0].cells[1].value, 1);
  assert.equal(report.rows.find(row => row.key === 'inventoryShortage').cells[0].note, '04-10-2026 → 11-10-2026');
  assert.equal(report.rows.find(row => row.key === 'inventoryConsumptionTotal').cells[0].value, -150);
  const final = report.rows.find(row => row.key === 'finalInventory');
  assert.equal(final.cells[0].value, 1800);
  assert.equal(final.cells[0].note, 'Físico · 11-10-2026');
  assert.equal(final.cells[1].value, 1800 / 1000.25);
  source.weeks[0].locations[0].values.finalInventory = value(1700, 'partial', { basis: 'theoretical', date: '2026-10-14', showPercent: false });
  assert.equal(exporter.model(source).rows.find(row => row.key === 'finalInventory').cells[0].note, 'Inventario teórico · 14-10-2026 · Parcial');
  assert.equal(report.rows.find(row => row.key === 'grossSales').compact, true);
  const beforeFee = report.rows.findIndex(row => row.key === 'mercadoPagoTheoreticalBeforeFee');
  assert.equal(report.rows[beforeFee + 1].key, 'mercadoPagoTheoretical');
  assert.equal(report.rows[beforeFee].cells[0].value, 1090);
  assert.equal(report.rows[beforeFee].cells[1].value, '');
  assert.equal(report.rows.find(row => row.key === 'grossSales').separator, false);
  assert.equal(report.rows.find(row => row.key === 'discounts').cells[0].color, report.colors.muted);
  assert.equal(report.rows.find(row => row.key === 'centralWarehouseInbound').cells[0].text, 'Sin datos');
  for (const key of ['centralWarehouseInbound', 'directSupplierInbound']) assert.equal(report.rows.find(row => row.key === key).compact, true);
  assert.equal(report.rows.find(row => row.key === 'suppliesInbound').compact, false);
  assert.equal(report.rows.find(row => row.key === 'suppliesInbound').separator, false);
  assert.equal(report.rows.find(row => row.key === 'centralWarehouseInbound').separator, false);
  assert.equal(report.rows.find(row => row.key === 'cogs').cells[0].value, -300);
  assert.equal(report.rows.find(row => row.key === 'cogs').cells[1].value, -300 / 1000.25);
  assert.equal(report.rows.find(row => row.key === 'otherVariableCosts').cells[0].value, -150);
  assert.equal(report.rows.find(row => row.key === 'variableCosts').cells[0].value, -450);
  assert.equal(report.rows.find(row => row.key === 'variableCosts').cells[1].value, -450 / 1000.25);
  assert.equal(report.rows.find(row => row.key === 'variableCosts').separator, false);
  assert.equal(report.rows.find(row => row.key === 'cogs').compact, true);
  assert.equal(report.rows.find(row => row.key === 'otherVariableCosts').compact, true);
  const row = report.rows.find(row => row.key === 'collectionDifference');
  assert.equal(row.cells[0].color, report.colors.difference);
});

test('PDF paginates across columns and rows, repeating concepts on every landscape page', () => {
  const report = exporter.model(fixture(5, true));
  const doc = exporter.pdf(report, jsPDF);
  assert.ok(doc.getNumberOfPages() >= 5);
  for (let index = 1; index <= doc.getNumberOfPages(); index++) {
    doc.setPage(index);
    assert.ok(doc.internal.pageSize.getWidth() > doc.internal.pageSize.getHeight());
    assert.match(doc.internal.pages[index].join('\n'), /Concepto/);
    assert.match(doc.internal.pages[index].join('\n'), /Resultados Semanales/);
    assert.match(doc.internal.pages[index].join('\n'), /Importe/);
  }
  assert.equal(Buffer.from(doc.output('arraybuffer')).subarray(0, 4).toString(), '%PDF');
});

test('XLSX preserves numeric cells, merged headers, supplemental dates, print titles and dynamic branches', () => {
  const report = exporter.model(fixture());
  const book = exporter.workbook(report, XLSX), sheet = book.Sheets['Resultados Semanales'];
  assert.equal(sheet.B6.t, 'n'); assert.equal(sheet.B6.v, 1000.25);
  assert.equal(sheet.C6.t, 'n'); assert.equal(sheet.C6.v, 1); assert.equal(sheet.C6.z, '0.0%;-0.0%;0.0%');
  assert.equal(sheet['!cols'].length, 25);
  assert.match(book.Workbook.Names[0].Ref, /\$A:\$A/);
  assert.match(book.Workbook.Names[0].Ref, /\$1:\$5/);
  assert.ok(Object.values(sheet).some(cell => cell?.v === '04-10-2026 → 11-10-2026'));
  assert.ok(Object.values(sheet).some(cell => cell?.v === 'Físico · 11-10-2026'));
  const beforeFeeAddress = Object.keys(sheet).find(address => sheet[address]?.v === 'MP Teorico antes de Comision');
  const beforeFeeRow = XLSX.utils.decode_cell(beforeFeeAddress).r;
  assert.equal(sheet[XLSX.utils.encode_cell({ r: beforeFeeRow, c: 1 })].v, 1090);
  assert.equal(sheet[XLSX.utils.encode_cell({ r: beforeFeeRow, c: 2 })]?.v || '', '');
  assert.ok(sheet['!merges'].some(merge => merge.s.r === 2 && merge.s.c === 1 && merge.e.c === 6));
  const compact = Object.entries(sheet).find(([, cell]) => cell?.v === 'Venta bruta')[0];
  assert.equal(sheet['!weeklyStyles'][compact].size, 9);
  assert.equal(sheet['!weeklyStyles'][compact].indent, 1);
});

test('monthly and prior-week exports label periods, cutoffs and spreadsheet print titles correctly', () => {
  for (const period of ['week', 'month']) for (const includeCurrent of [true, false]) {
    const data = buildWeeklyResults({ weeks: 4, includeCurrent: true, today: '2026-10-14', locations: [{ id: 'store-1', name: 'Lyon' }],
      period, includeCurrent, weeks: 2 }, () => ({ values: { netSales: value(1000, 'complete') } }));
    const report = exporter.model(data), monthly = period === 'month';
    assert.equal(report.title, monthly ? 'Resultados Mensuales' : 'Resultados Semanales');
    assert.ok(report.context.includes(monthly ? '2 meses' : '2 semanas'));
    assert.ok(report.columns[0].week.startsWith(includeCurrent ? (monthly ? 'Mes actual' : 'Semana actual') : (monthly ? 'Hace 1 mes' : 'Hace 1 semana')));
    assert.ok(report.context.endsWith(`Datos hasta ${data.weeks[0].period.through.split('-').reverse().join('-')}`));
    const book = exporter.workbook(report, XLSX);
    assert.deepEqual(book.SheetNames, [report.title]);
    assert.ok(book.Workbook.Names[0].Ref.includes(`'${report.title}'!`));
    assert.equal(book.Sheets[report.title].B6.v, 1000);
    const doc = exporter.pdf(report, jsPDF);
    assert.ok(doc.internal.pages[1].join('\n').includes(report.title));
  }
});

test('warehouse uses one amount column before the cafes in PDF and Excel for every period', () => {
  for (const period of ['week', 'month']) {
    const locations = [{ id: 'main-warehouse', name: 'Bodega Principal', type: 'warehouse' },
      { id: 'store-1', name: 'La Concepción', type: 'store' }, { id: 'store-2', name: 'Portal Lyon', type: 'store' }];
    const data = buildWeeklyResults({ today: '2026-10-14', weeks: 2, period, locations }, () => ({ values: {
      netSales: value(1000, 'complete'), finalInventory: value(2500, 'complete'),
      centralWarehouseInbound: value(20, 'complete'), directSupplierInbound: value(100, 'complete'),
      suppliesOutbound: value(50, 'complete')
    } }));
    const report = exporter.model(data);
    assert.deepEqual(report.columns.map(column => column.units), [1, 2, 2, 1, 2, 2]);
    assert.deepEqual(report.columns.map(column => column.cellStart), [0, 1, 3, 5, 6, 8]);
    assert.deepEqual(report.rows[0].cells.map(cell => cell.value), ['—', 1000, 1, 1000, 1, '—', 1000, 1, 1000, 1]);
    assert.equal(report.rows.find(row => row.key === 'suppliesInbound').cells[0].value, 120);
    assert.equal(report.rows.find(row => row.key === 'suppliesOutbound').cells[0].value, 50);
    assert.match(report.context, /2 sucursales \+ Bodega Principal/);
    const sheet = exporter.workbook(report, XLSX).Sheets[report.title];
    assert.equal(sheet['!cols'].length, 11);
    assert.equal(sheet.B4.v, 'Bodega Principal'); assert.equal(sheet.C4.v, 'La Concepción');
    assert.equal(sheet.D5.v, '%'); assert.equal(sheet.B6.v, '—'); assert.equal(sheet.C6.v, 1000);
    assert.ok(sheet['!merges'].some(merge => merge.s.r === 2 && merge.s.c === 1 && merge.e.c === 5));
    assert.ok(!sheet['!merges'].some(merge => merge.s.r === 3 && merge.s.c === 1));
    const doc = exporter.pdf(report, jsPDF);
    for (let index = 1; index <= doc.getNumberOfPages(); index++) {
      const page = doc.internal.pages[index].join('\n');
      assert.match(page, /Bodega Principal/);
      assert.equal((page.match(/\(%\)/g) || []).length, 2);
    }
  }
});
