// Explicit inventory exclusions requested by the user. Keep the source records.
const excludedCodes = new Set([
  '6a43d03f8d79da0be6d748ee',
  '6a0622b9cb89ca1b523aca41',
  '6a0622b9cb89ca1b523aca42',
  '6a0622b9cb89ca1b523aca43'
]);
function inventoryExclusion(code) {
  return excludedCodes.has(String(code || '').trim().toLowerCase())
    ? 'Código interno excluido del inventario por indicación del usuario.' : null;
}
module.exports = { inventoryExclusion };
