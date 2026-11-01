const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const XLSX = require('xlsx');
const { setup, fill, IDS } = require('./helpers/gender-review-fixture');
const { createGenderReviewStore } = require('../order-gender-review');
const { searchRecordedName, searchKey } = require('../recorded-name-search');
const prefix = '/api/sales/gender-review';
async function bookFor(base, query = 'status=all') { return XLSX.read(Buffer.from(await (await fetch(`${base}${prefix}/export?${query}`)).arrayBuffer()), { type: 'buffer' }); }
async function preview(base, buffer) { const body = new FormData(); body.append('file', new Blob([buffer]), 'revision.xlsx'); const r = await fetch(`${base}${prefix}/import/preview`, { method: 'POST', body }); return { status: r.status, data: await r.json() }; }
async function apply(base, id) { const r = await fetch(`${base}${prefix}/import/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); return { status: r.status, data: await r.json() }; }
const read = (base, query = '') => fetch(`${base}${prefix}?${query}`).then(r => r.json());

test('review export/import is scoped to orders, persistent, idempotent and used by product and characterization reports', async t => {
  const s = await setup(t), list = await read(s.base);
  assert.equal(list.summary.total, 5); assert.equal(list.total, 4); assert.equal(list.summary.assigned, 1);
  const row = list.rows.find(r => r.locationId === 'store-1' && r.orderId === IDS.name);
  assert.equal(row.name, 'Alfredo'); assert.equal(row.comment, '  alfredo  ');
  const reportUrl = `${s.base}/api/sales/product-gender?location=all&period=custom&dateFrom=2026-10-01&dateTo=2026-10-07`;
  const before = await fetch(reportUrl).then(r => r.json()); assert.equal(before.totals.genders.feminine.netSales, 0);
  const book = await bookFor(s.base); const sheet = book.Sheets.Asignaciones;
  for (const [key, cell] of Object.entries(sheet)) if (/^C[2-9]\d*$/u.test(key)) assert.equal(cell.t, 's');
  const buffer = fill(book, { [`store-1:${IDS.name}`]: 'Femenino' });
  const checked = await preview(s.base, buffer); assert.equal(checked.status, 200); assert.equal(checked.data.changes, 1);
  assert.deepEqual(checked.data.assignments, { masculine: 0, feminine: 1, unattributable: 0, missing: 0 });
  assert.equal(checked.data.skipped, 4);
  assert.equal((await read(s.base, 'status=reviewed')).total, 0, 'preview does not write assignments');
  const result = await apply(s.base, checked.data.id); assert.equal(result.status, 200); assert.equal(result.data.applied, 1);
  const all = await read(s.base, 'status=all');
  assert.equal(all.rows.find(r => r.locationId === 'store-1' && r.orderId === IDS.name).category, 'feminine');
  assert.equal(all.rows.find(r => r.locationId === 'store-2' && r.orderId === IDS.name).category, 'missing');
  const after = await fetch(reportUrl).then(r => r.json());
  assert.equal(after.totals.genders.feminine.netSales, 1000); assert.equal(after.totals.netSales, before.totals.netSales); assert.equal(after.totals.units, before.totals.units);
  assert.notDeepEqual(after.sourceVersions, before.sourceVersions);
  const demand = await fetch(`${s.base}/api/demand-analysis?locations=all&mode=custom&dateFrom=2026-10-01&dateTo=2026-10-07`).then(r => r.json());
  assert.equal(demand.nameSegments.segments.find(r => r.key === 'feminine-associated').orders, 1);
  const repeated = await preview(s.base, buffer); assert.equal(repeated.data.changes, 0); assert.equal(repeated.data.unchanged, 1);
  assert.equal(Object.values(repeated.data.assignments).reduce((sum, n) => sum + n, 0), 0);
  assert.equal((await apply(s.base, repeated.data.id)).data.applied, 0);
  const saved = createGenderReviewStore(s.root); assert.equal(saved.history(`store-1:order:${IDS.name}`).length, 1);
  assert.equal(saved.history(`store-1:order:${IDS.name}`)[0].reviewer, '');
  assert.equal(saved.history(`store-1:order:${IDS.name}`)[0].filename, 'revision.xlsx');
  assert.ok(fs.readdirSync(path.join(saved.root, 'analyses')).length > 0);
});
test('import summary includes all four categories and the batch is saved only after confirmation', async t => {
  const s = await setup(t), book = await bookFor(s.base);
  const checked = await preview(s.base, fill(book, {
    [`store-1:${IDS.name}`]: 'Femenino', [`store-1:${IDS.blank}`]: 'Sin información',
    [`store-1:${IDS.negation}`]: 'No atribuible', [`store-2:${IDS.name}`]: 'Masculino'
  }));
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.data.assignments, { masculine: 1, feminine: 1, unattributable: 1, missing: 1 });
  assert.equal(checked.data.changes, 4); assert.equal(checked.data.skipped, 1); assert.equal(checked.data.unchanged, 0);
  assert.equal((await read(s.base, 'status=reviewed')).total, 0);
  assert.equal((await apply(s.base, checked.data.id)).data.applied, 4);
  const reviewed = await read(s.base, 'status=reviewed');
  assert.equal(reviewed.total, 4);
  assert.deepEqual(reviewed.rows.map(row => row.category).sort(), ['feminine', 'masculine', 'missing', 'unattributable']);
});
test('invalid categories, numeric IDs, formulas and duplicate rows reject the entire file', async t => {
  const s = await setup(t);
  for (const kind of ['invalid', 'numeric', 'formula', 'duplicate']) {
    const book = await bookFor(s.base), sheet = book.Sheets.Asignaciones;
    sheet.K2 = { t: 's', v: 'Femenino' }; sheet.K3 = { t: 's', v: 'Masculino' };
    if (kind === 'invalid') sheet.K3.v = 'inferir';
    if (kind === 'numeric') sheet.C3 = { t: 'n', v: Number(sheet.C3.v) };
    if (kind === 'formula') sheet.K3.f = '"Masculino"';
    if (kind === 'duplicate') { sheet.A3 = { ...sheet.A2 }; sheet.C3 = { ...sheet.C2 }; }
    const result = await preview(s.base, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    assert.equal(result.status, 400, kind); assert.ok(result.data.errors.length, kind);
    assert.equal((await read(s.base, 'status=reviewed')).total, 0);
  }
});
test('source changes and newer reviews invalidate old sheets and staged imports', async t => {
  const s = await setup(t), old = await bookFor(s.base);
  const female = fill(old, { [`store-1:${IDS.name}`]: 'Femenino' });
  const first = await preview(s.base, female);
  const other = await preview(s.base, fill(await bookFor(s.base), { [`store-1:${IDS.name}`]: 'No atribuible' }));
  await apply(s.base, other.data.id);
  assert.equal((await apply(s.base, first.data.id)).status, 409);
  const closed = await read(s.base); assert.ok(!closed.rows.some(r => r.locationId === 'store-1' && r.orderId === IDS.name));
  const unassigned = await read(s.base, 'status=unassigned'); assert.ok(unassigned.rows.some(r => r.locationId === 'store-1' && r.orderId === IDS.name));
  s.saveDetails('alfredo para llevar');
  const stale = (await read(s.base)).rows.find(r => r.locationId === 'store-1' && r.orderId === IDS.name);
  assert.equal(stale.reviewState, 'stale'); assert.equal(stale.category, 'missing');
  assert.equal((await preview(s.base, female)).status, 400);
  assert.equal((await fetch(`${s.base}${prefix}/history?location=store-1&orderId=${IDS.name}`).then(r => r.json())).entries.length, 1);
});
test('extraction preserves ñ and spans; valid names precede spelling suggestions and negations block literal attribution', () => {
  assert.notEqual(searchKey('Núñez'), searchKey('Nunez'));
  for (const name of ['Marisela', 'Lucina', 'Natalina', 'Vanesa']) { assert.equal(searchRecordedName(name).status, 'recognized'); assert.equal(searchRecordedName(name).suggestion, ''); }
  assert.match(searchRecordedName('Ognacio').suggestion, /Ignacio/);
  assert.match(searchRecordedName('Grabiela').suggestion, /Gabriela/);
  const original = 'para Ana y Juan'; const result = searchRecordedName(original);
  assert.deepEqual(result.spans.map(s => original.slice(s.start, s.end)), ['Ana', 'Juan']);
  assert.equal(searchRecordedName('dom Juan Pablo').normalizedName, 'Juan Pablo');
  assert.equal(searchRecordedName('no es para el hombre, es para Ana').genderInText, 'No identificable');
});

test('production publication hooks populate history and update analyses after a new source publication', async t => {
  const s = await setup(t, { enableBackgroundCalculations: true });
  const waitFor = async check => { for (let i = 0; i < 150 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check()); };
  await waitFor(() => s.app.locals.commentProcessing.lastRun);
  assert.equal(s.app.locals.commentProcessing.lastError, null);
  const previousRun = s.app.locals.commentProcessing.lastRun;
  const file = path.join(s.root, 'transactions/store-1/details.xlsx');
  const book = XLSX.readFile(file), sheet = book.Sheets.Datos;
  sheet.D2 = { t: 's', v: 'nombre: alfredo para llevar' };
  require('../record-workbooks').writeFile(book, file);
  await waitFor(() => s.app.locals.commentProcessing.lastRun !== previousRun);
  assert.equal(s.app.locals.commentProcessing.lastError, null);
  const row = (await read(s.base)).rows.find(r => r.locationId === 'store-1' && r.orderId === IDS.name);
  assert.equal(row.comment, 'nombre: alfredo para llevar'); assert.equal(row.name, 'Alfredo'); assert.equal(row.mode, 'takeaway');
});
