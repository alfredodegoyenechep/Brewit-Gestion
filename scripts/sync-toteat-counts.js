// Read original count documents with the explicitly authorized local Toteat session.
const fs = require('node:fs');
const path = require('node:path');
const { createToteatAutomation } = require('../server');
const { createCountSync } = require('../toteat-counts');
async function main() {
  const [location, from, to] = process.argv.slice(2);
  const root = path.resolve(__dirname, '../uploads');
  const credentials = () => JSON.parse(fs.readFileSync(path.join(root, '.integrations/toteat-api/credentials.json'), 'utf8'));
  const reader = createToteatAutomation(path.join(root, '.integrations/toteat'));
  const sync = createCountSync({ uploadsRoot: root, credentials,
    activeLocation: id => credentials()[id] ? { type: 'store' } : null,
    reader: (restaurant, options) => reader.readNativeSources(restaurant, options) });
  const result = await sync.synchronize(location, { from, to });
  console.log(JSON.stringify(result));
}
main().catch(() => { console.error('No se pudieron actualizar las tomas originales. Revisa la sesión autorizada y el período solicitado; se conserva la última versión completa.'); process.exitCode = 1; });
