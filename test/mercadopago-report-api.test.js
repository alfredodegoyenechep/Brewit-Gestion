const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportApi, compareReportBytes } = require('../mercadopago-report-api');

test('read-only report pilot lists metadata and downloads only a named existing report', async () => {
  const calls = [];
  const api = createReportApi({ token: 'private-test-token', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, authorization: options.headers.Authorization });
    return url.endsWith('/list') ? new Response(JSON.stringify([{ id: 1, account_id: 7, status: 'processed', file_name: 'report.csv' }]))
      : new Response('STORE_ID;SOURCE_ID;TRANSACTION_AMOUNT\n1;a;100');
  } });
  assert.equal((await api.list())[0].fileName, 'report.csv');
  const result = await api.download('report.csv');
  assert.ok(result.sha256);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'GET'));
  await assert.rejects(api.download('../secret.csv'), /inválido/);
});

test('report comparison ignores row and column order but detects amount changes', () => {
  const old = Buffer.from('STORE_ID;SOURCE_ID;TRANSACTION_AMOUNT\n1;a;100\n1;b;200');
  const reordered = Buffer.from('TRANSACTION_AMOUNT;SOURCE_ID;STORE_ID\n200;b;1\n100;a;1');
  assert.equal(compareReportBytes(old, reordered).equivalent, true);
  assert.equal(compareReportBytes(old, Buffer.from('STORE_ID;SOURCE_ID;TRANSACTION_AMOUNT\n1;a;90\n1;b;200')).equivalent, false);
});
test('pilot rejects an expired token without returning secret response content', async () => {
  const api = createReportApi({ token: 'private-test-token', fetchImpl: async () => new Response('sensitive vendor detail', { status: 401 }) });
  await assert.rejects(api.list(), error => error.status === 401 && !error.message.includes('sensitive'));
});
