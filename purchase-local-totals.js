// Consolidation uses the same per-store projection as replenishment, including
// its effective daily consumption. Missing local data contributes zero.
function consolidateLocalTotals(item, sources, selectedLocationId, convertQuantity) {
  const convert = (value, unit) => {
    const converted = unit && item.internalUnit && Number.isFinite(value)
      ? convertQuantity(value, unit, item.internalUnit) : null;
    return Number.isFinite(converted) ? converted : null;
  };
  const locals = sources.map(source => {
    const own = source.itemsByKey.get(item.key);
    const reference = source.projection?.consumptionReference;
    const managed = own ? own.managed === true : source.managedKeys?.has(item.key) === true;
    const inventoryIncluded = source.location.id !== selectedLocationId;
    const inventory = own ? convert(own.currentInventory, own.internalUnit) : null;
    const ownDailyConsumption = own ? convert(own.ownAverageDailyConsumption, own.internalUnit) : null;
    const substituteDailyConsumption = own ? convert(own.projectedAverageDailyConsumption, own.internalUnit) : null;
    const dailyConsumption = own && !source.consumptionError ? convert(own.averageDailyConsumption, own.internalUnit) : null;
    const issue = source.error || (!own ? 'Ingrediente sin inventario o historial verificable en esta cafetería.'
      : inventory === null || ownDailyConsumption === null ? 'Unidad incompatible o desconocida.' : null);
    return {
      locationId: source.location.id,
      locationName: source.location.name,
      inventoryIncluded,
      sourceUnit: own?.internalUnit || item.internalUnit,
      sourceInventory: own?.currentInventory ?? 0,
      inventory: inventory ?? 0,
      inventoryAssumedZero: inventory === null,
      inventoryDate: source.projection?.period.dataThrough || null,
      ownDailyConsumption: ownDailyConsumption ?? 0,
      substituteDailyConsumption: substituteDailyConsumption ?? 0,
      managed,
      consumptionIncluded: managed,
      replenishmentDailyConsumption: dailyConsumption ?? 0,
      dailyConsumption: managed ? dailyConsumption ?? 0 : 0,
      consumptionAssumedZero: managed && dailyConsumption === null,
      consumptionFrom: own?.consumptionFrom || null,
      consumptionDays: own?.consumptionDays ?? null,
      reference: reference?.active ? { source: reference.source, percentage: reference.percentage } : null,
      inventoryIssue: inventory === null ? `${issue || 'Sin datos de inventario.'} Se considera 0.` : null,
      consumptionIssue: !managed ? 'No administrado en esta cafetería; no aporta al consumo consolidado.' : dailyConsumption === null
        ? `${source.consumptionError || issue || 'Sin datos de consumo.'} Se considera 0.` : own?.referenceIssue || null
    };
  });
  const inventoryRows = locals.filter(row => row.inventoryIncluded);
  const localsInventorySubtotal = inventoryRows.reduce((sum, row) => sum + (row.inventory ?? 0), 0);
  const localsDailyConsumptionSubtotal = locals.reduce((sum, row) => sum + (row.dailyConsumption ?? 0), 0);
  const localsInventory = localsInventorySubtotal;
  const localsDailyConsumption = localsDailyConsumptionSubtotal;
  const totalInventory = item.currentInventory + localsInventorySubtotal;
  const currentCoverageDays = localsDailyConsumption > 0
    ? totalInventory / localsDailyConsumption : null;
  return {
    locals, localsInventory, localsInventorySubtotal, totalInventory,
    localsDailyConsumption, localsDailyConsumptionSubtotal,
    localsInventoryComplete: true,
    localsConsumptionComplete: true,
    currentCoverageDays,
    coverageUnavailableReason: localsDailyConsumption === 0 ? 'Sin consumo diario en las cafeterías.' : null
  };
}

module.exports = { consolidateLocalTotals };
