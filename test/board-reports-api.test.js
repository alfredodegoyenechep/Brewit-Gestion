const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { setup } = require('./helpers/product-xray-fixture');
async function request(base, endpoint, init) { const r = await fetch(base + endpoint, init); return { status: r.status, body: await r.json() }; }
const post = month => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month }) });
test('API: generación explícita, archivo inmutable, exportación, validación y cancelación', { timeout: 180000 }, async t => {
  const { app, root, base } = await setup(t);
  const opts = await request(base, '/api/board-reports/options'); assert.equal(opts.status, 200); assert.ok(opts.body.months.includes('2026-10'));
  const before = await request(base, '/api/board-reports?month=2026-10'); assert.deepEqual(before.body.versions, []);
  assert.equal((await request(base, '/api/board-reports/jobs', post('2026-13'))).status, 400);
  assert.equal((await request(base, '/api/board-reports/jobs', post('2027-01'))).status, 400);
  const created = await request(base, '/api/board-reports/jobs', post('2026-10')); assert.equal(created.status, 202);
  let state;
  for (let i = 0; i < 240; i++) { state = (await request(base, `/api/board-reports/jobs/${created.body.id}`)).body; if (!['running', 'queued'].includes(state.status)) break; await new Promise(r => setTimeout(r, 250)); }
  assert.equal(state.status, 'complete', state.error || JSON.stringify(state));
  const r = (await request(base, `/api/board-reports/${state.reportId}`)).body;
  assert.equal(r.current.netSales, 7000); assert.equal(r.previous.netSales, 1000); assert.equal(r.deck.pages.length, 16 + 2 * r.locations.length);
  const dir = path.join(root, 'board-reports', r.id), original = fs.readFileSync(path.join(dir, 'report.json'));
  assert.ok(fs.statSync(path.join(dir, 'presentation.pptx')).size > 10000);
  const pdf = await fetch(`${base}/api/board-reports/${r.id}/export?format=pdf`); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-disposition'), /Brewit-Directorio/);
  assert.equal((await request(base, `/api/board-reports/${r.id}/export?format=zip`)).status, 400);
  const pendingGender = app.locals.genderReview.filtered({ status: 'all' }).rows.find(r => r.orderId === 'o2');
  app.locals.genderReview.store.commit([{ ...pendingGender, category: 'masculine', name: pendingGender.name, note: '' }], { filename: 'board-review.xlsx', fileHash: 'board-test' });
  const refreshed = await request(base, '/api/board-reports/jobs', post('2026-10'));
  let refreshedState;
  for (let i = 0; i < 240; i++) { refreshedState = (await request(base, `/api/board-reports/jobs/${refreshed.body.id}`)).body; if (!['running', 'queued'].includes(refreshedState.status)) break; await new Promise(r => setTimeout(r, 250)); }
  assert.equal(refreshedState.status, 'complete', refreshedState.error);
  const reviewed = (await request(base, `/api/board-reports/${refreshedState.reportId}`)).body;
  assert.notEqual(reviewed.sourceVersion, r.sourceVersion); assert.notEqual(reviewed.id, r.id);
  assert.equal(reviewed.current.gender.find(g => g.key === 'masculine').netSales, 2000);
  assert.equal(r.current.gender.find(g => g.key === 'masculine').netSales, 0);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'report.json')), original);
  const changed = JSON.parse(fs.readFileSync(path.join(root, 'config/locations.json'), 'utf8')); const list = changed.locations || changed; if (Array.isArray(list)) list.push({ id: 'new', name: 'Futura', type: 'store', status: 'active', openingDate: '2026-11-01' }); fs.writeFileSync(path.join(root, 'config/locations.json'), JSON.stringify(changed));
  const old = (await request(base, `/api/board-reports/${r.id}`)).body; assert.equal(old.locations.length, r.locations.length); assert.deepEqual(fs.readFileSync(path.join(dir, 'report.json')), original);
  const pending = await request(base, '/api/board-reports/jobs', post('2026-09'));
  const cancelled = await request(base, `/api/board-reports/jobs/${pending.body.id}`, { method: 'DELETE' }); assert.equal(cancelled.body.status, 'cancelled');
  const after = await request(base, '/api/board-reports?month=2026-10'); assert.equal(after.body.versions.length, 2);
});
