// Only expose fixed messages; browser errors can contain private request details.
function sessionMessage(opened = false) {
  return 'Es necesario iniciar sesión en Toteat. ' + (opened
    ? 'Dejamos abierta la pantalla de Toteat en el navegador conectado. Inicia sesión allí y pulsa «Ya inicié sesión, continuar» en el proceso de actualización.'
    : 'Abre Toteat en el navegador conectado, inicia sesión y reintenta la actualización.') + ' Se conserva la última versión completa.';
}
module.exports = { sessionMessage };
