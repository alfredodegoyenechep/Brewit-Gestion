// Local recovery server. No schedulers; never exposed beyond loopback.
const { createApp } = require('../server');
const port = Number(process.env.BREWIT_LEGACY_PORT || 3001);
createApp({ enableLegacyTools: true, enableToteatSync: false }).listen(port, '127.0.0.1', () => {
  console.log(`Herramientas legacy locales: http://127.0.0.1:${port}. Sin interfaz de carga; utilizar las rutas de recuperación documentadas.`);
});
