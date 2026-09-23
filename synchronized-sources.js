const TRANSACTION_FIELDS = new Set(['sales', 'payment-details', 'purchases']);
const INVENTORY_FIELDS = new Set(['kardex', 'waste']);
function synchronizedMaster(records, date) {
  const synced = records.filter(record => record.source === 'toteat-shared-api');
  return synced.find(record => record.validFrom <= date) || synced[0] || null;
}
function effectiveRecipeVersions(records, date, synchronizedOnly) {
  const dated = records.filter(record => record.validFrom <= date && (!synchronizedOnly || record.source === 'toteat-shared-api'));
  return synchronizedOnly ? dated.slice(0, 1) : dated;
}
module.exports = { TRANSACTION_FIELDS, INVENTORY_FIELDS, synchronizedMaster, effectiveRecipeVersions };
