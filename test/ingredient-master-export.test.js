const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { jsPDF } = require('jspdf');
const fs = require('node:fs');
const path = require('node:path');
// Exercise the exporter shipped inside the existing application script.
const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
const exporter = new Function(script.slice(0, script.indexOf('\nlet locationRegistry')) + '\nreturn IngredientMasterExport;')();

const item = { code: '000123', name: 'Café; "Especial"\nMolido', internalUnit: 'kg',
  purchaseUnit: 'Bolsa', unitsPerPurchaseUnit: .75, masterPurchaseUnit: 'kg', masterContent: 1 };

test('exports current values, drafts and restored master equivalences without inventing missing quantities', () => {
  assert.deepEqual(exporter.values(item), ['000123', item.name, 'kg', 'Bolsa', .75, '1 Bolsa = 0,75 kg', 'Bolsa', .75, '1 Bolsa = 0,75 kg', 'Por Consumo Receta']);
  assert.deepEqual(exporter.values(item, { purchaseUnit: 'Pack', unitsPerPurchaseUnit: '6' }).slice(3, 6), ['Pack', 6, '1 Pack = 6 kg']);
  assert.deepEqual(exporter.values(item, { purchaseUnit: '', unitsPerPurchaseUnit: null }).slice(3, 6), ['kg', 1, '1 kg = 1 kg']);
  assert.deepEqual(exporter.values(item, { ...item, transferUnit: 'Pack', unitsPerTransferUnit: '.25' }).slice(6, 9),
    ['Pack', .25, '1 Pack = 0,25 kg']);
  for (const content of [null, '', undefined, -1, 0, NaN]) {
    assert.equal(exporter.values({ ...item, unitsPerPurchaseUnit: content })[4], null);
    assert.equal(exporter.values({ ...item, unitsPerPurchaseUnit: content })[5], 'Sin equivalencia');
  }
});

test('CSV preserves accents, separators, quotes, newlines and configured decimals, and escapes formulas', () => {
  const csv = exporter.csv([exporter.values(item), ['=1+1', '@SUM(A1)', '', '', null, 'Sin equivalencia']]);
  assert.ok(csv.startsWith('\uFEFF"Código";'));
  assert.ok(csv.includes('"Café; ""Especial""\nMolido"'));
  assert.ok(csv.includes('"0,75"'));
  assert.ok(csv.includes('"\'=1+1";"\'@SUM(A1)"'));
  const book = XLSX.read(csv, { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
  assert.equal(rows[1][0], '000123');
  assert.equal(rows[1][1], item.name);
  assert.equal(rows[1][4], '0,75');
  assert.ok(exporter.csv([exporter.values(item)], 'dot').includes('"0.75"'));
});

test('XLSX round trip retains numeric content, text codes and text that resembles formulas', () => {
  const rows = [exporter.values({ ...item, transferUnit: 'Pack', unitsPerTransferUnit: .25 }),
    ['=1+1', '123.45', 'kg', 'Caja', 1000, '1 Caja = 1.000 kg', 'Bolsa', 10, '1 Bolsa = 10 kg', 'Por inventario mínimo y máximo']];
  const book = exporter.workbook(rows, XLSX);
  assert.deepEqual(book.Sheets.Ingredientes['!brewitTextColumns'], [0, 1, 2, 3, 5, 6, 8, 9]);
  const read = XLSX.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual(XLSX.utils.sheet_to_json(read.Sheets.Ingredientes, { header: 1 }), [exporter.headers, ...rows]);
  assert.equal(read.Sheets.Ingredientes.E2.t, 'n');
  assert.equal(read.Sheets.Ingredientes.H2.t, 'n');
  assert.equal(read.Sheets.Ingredientes.A3.f, undefined);
  assert.equal(read.Sheets.Ingredientes['!autofilter'].ref, 'A1:J3');
});

test('PDF downloads as a real document and repeats headers on every page, including long row continuations', () => {
  const rows = Array.from({ length: 141 }, (_, index) => exporter.values({ ...item, code: `RET${index}` }));
  rows.push(exporter.values({ ...item, name: 'Ingrediente muy largo '.repeat(500) }));
  const doc = exporter.pdf(rows, jsPDF, 'Tabla filtrada · Incluye cambios sin guardar');
  assert.ok(doc.getNumberOfPages() > 5);
  for (let index = 1; index <= doc.getNumberOfPages(); index++) {
    doc.setPage(index);
    assert.ok(doc.internal.pageSize.getWidth() > doc.internal.pageSize.getHeight());
    const commands = doc.internal.pages[index].join('\n');
    assert.match(commands, /Maestro de ingredientes/);
    assert.match(commands, /Equivalencia/);
    assert.match(commands, new RegExp(`de ${doc.getNumberOfPages()}`));
  }
  assert.equal(Buffer.from(doc.output('arraybuffer')).subarray(0, 4).toString(), '%PDF');
});
