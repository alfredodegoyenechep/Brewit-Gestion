const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), XLSX = require('xlsx');
const { createRecurrenceSource } = require('../recurrence-source');
const { coverageFor } = require('../recurrence');
const published = (dataset, range) => ({ id: 'run', publication: 'published', reception: 'complete', artifacts: [{ id: 'file', receivedAt: '2026-10-25T15:00:00Z', datasets: [{ location: 'a', dataset, complete: true, range }] }] });
function setup(manifests, files = []) {
  return createRecurrenceSource({ uploadsRoot: '/private/tmp/recurrence-source-fixture-no-files', storesFor: () => [{ id: 'a', name: 'A' }], filesFor: (location, source) => source === 'mercadopago' ? files : [],
    manifests, today: () => '2026-10-25', cutoff: () => '15:00:00', ordersFor: () => ({ orders: [] }) });
}
test('source coverage uses published provider ranges, caps partial receipt days and never uses row endpoints', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recurrence-empty-covered-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'empty.xlsx'), book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['SOURCE_ID', 'TRANSACTION_DATE', 'TRANSACTION_AMOUNT']]), 'MP'); XLSX.writeFile(book, filePath);
  const files = [{ filePath, record: { savedAt: '2026-10-25T15:00:00Z' } }];
  const source = setup(() => [published('mercadopago', { from: '2026-10-01', to: '2026-10-25' }), { ...published('mercadopago', { from: '2026-09-01', to: '2026-09-30' }), publication: 'draft' }], files);
  const data = source.readSource({}); assert.equal(data.records.length, 0);
  const mp = data.coverage[0]; assert.equal(mp.to, '2026-10-24'); assert.equal(mp.through, '2026-10-25T12:00:00');
  assert.equal(coverageFor(data.coverage, ['a'], '2026-10-01', '2026-10-24').complete, true);
  assert.equal(coverageFor(data.coverage, ['a'], '2026-09-01', '2026-09-30').complete, false);
  const absent = setup(() => [published('mercadopago', { from: '2026-10-01', to: '2026-10-24' })]).readSource({});
  assert.equal(absent.coverage[0].complete, false); assert.ok(absent.warnings.length);
  const noEvidence = setup(() => []).readSource({}); assert.equal(noEvidence.coverage.length, 0);
});
test('mixed-source manifests invalidate only the dependent source version', () => {
  const run = published('mercadopago', { from: '2026-10-01', to: '2026-10-24' });
  run.artifacts[0].datasets.push({ location: 'a', dataset: 'sales', complete: true, range: { from: '2026-10-01', to: '2026-10-20' } });
  const source = setup(() => [run]), before = source.fingerprint({});
  run.artifacts[0].datasets[1].range.to = '2026-10-21'; const after = source.fingerprint({});
  assert.equal(before.mp, after.mp); assert.notEqual(before.purchases, after.purchases);
});
