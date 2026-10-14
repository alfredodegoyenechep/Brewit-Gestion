const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');
const { buildWeeklyResults, value } = require('../weekly-results');
const exporter = require('../weekly-results-export');

function fixture(count = 3, partial = false) {
  const locations = Array.from({ length: count }, (_, index) => ({ id: `store-${index}`, name: `Sucursal ${index + 1}` }));
  return buildWeeklyResults({ today: '2026-10-14', locations }, () => ({
    values: { netSales: value(1000.25, partial ? 'partial' : 'complete'),
      grossSales: value(1300.25, 'complete'), discounts: value(110.25, 'complete'),
      tips: value(100, 'complete'), mercadoPagoFee: value(35, 'complete'), cashCollection: value(200, 'complete'),
      mercadoPagoCollection: value(900, 'complete'), inventoryShortage: value(-50, 'partial'),
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
  assert.equal(report.rows.find(row => row.key === 'grossSales').compact, true);
  assert.equal(report.rows.find(row => row.key === 'grossSales').separator, false);
  assert.equal(report.rows.find(row => row.key === 'discounts').cells[0].color, report.colors.muted);
  assert.equal(report.rows.find(row => row.key === 'expenseIncome').cells[0].text, 'Pendiente');
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
  assert.ok(sheet['!merges'].some(merge => merge.s.r === 2 && merge.s.c === 1 && merge.e.c === 6));
  const compact = Object.entries(sheet).find(([, cell]) => cell?.v === 'Venta bruta')[0];
  assert.equal(sheet['!weeklyStyles'][compact].size, 9);
  assert.equal(sheet['!weeklyStyles'][compact].indent, 1);
});
