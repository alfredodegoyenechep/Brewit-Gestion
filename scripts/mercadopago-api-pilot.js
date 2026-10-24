const fs = require('node:fs');
const { createReportApi, compareReportBytes } = require('../mercadopago-report-api');

async function main() {
  const api = createReportApi({ token: process.env.BREWIT_MP_REPORT_TOKEN });
  const [fileName, webFile] = process.argv.slice(2);
  if (!fileName || !webFile) {
    const reports = await api.list();
    process.stdout.write(JSON.stringify({ reports }, null, 2) + '\n');
    return;
  }
  const { bytes, sha256 } = await api.download(fileName);
  const comparison = compareReportBytes(bytes, fs.readFileSync(webFile));
  process.stdout.write(JSON.stringify({ fileName, sha256, comparison }, null, 2) + '\n');
  if (!comparison.equivalent) process.exitCode = 2;
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
