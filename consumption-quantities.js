const vegetableMilks = new Set(['LAC003', 'LAC004']);
function consumptionUnitForCode(code, unit) {
  return vegetableMilks.has(String(code || '').trim().toUpperCase()) && /^(un|und|unidad|unidades)?$/i.test(String(unit || '').trim())
    ? 'L' : unit;
}
function consumptionQuantities(values, declaredUnit = 'UN', code = null) {
  const groups = new Map();
  const units = {ml:['L',.001],cc:['L',.001],l:['L',1],lt:['L',1],lts:['L',1],litro:['L',1],litros:['L',1],kg:['kg',1],g:['kg',.001],gr:['kg',.001],un:['UN',1],unidad:['UN',1],unidades:['UN',1]};
  for (const value of values) {
    const match = String(value ?? '').trim().match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)(?:\s*\([^)]*\))?$/);
    if (!match) continue;
    const rawUnit = consumptionUnitForCode(code, (match[2] || declaredUnit || 'UN').trim());
    const [unit, factor] = units[rawUnit.toLowerCase()] || [rawUnit,1];
    const quantity = Number(match[1].replace(',','.')) * factor;
    if (Number.isFinite(quantity)) groups.set(unit,(groups.get(unit)||0)+quantity);
  }
  return [...groups].filter(([,quantity])=>quantity!==0).map(([unit,quantity])=>({unit,quantity}));
}
function withEmployeeMilkSubstitutions(report, catalog = null) {
  if (report.products.some(item => item.isMilkSubstitutionReversal)) return report;
  const substitutions = report.products.filter(item => vegetableMilks.has(item.code) && item.unit === 'L');
  if (!substitutions.length) return report;
  const quantity = -substitutions.reduce((sum, item) => sum + item.quantity, 0);
  const reversal = {
    code: 'LAC001', name: `${catalog?.get('LAC001')?.name || 'Leche LAC001'} (reversa por sustitución)`,
    unit: 'L', quantity, unitCost: 0, totalCost: 0, isMilkSubstitutionReversal: true,
    dailyQuantities: substitutions.flatMap(item => (item.dailyQuantities || []).map(day => ({
      ...day, quantity: -day.quantity, productCode: item.code, productName: item.name,
      source: `${day.source || 'Consumo colaboradores'} · Reversa LAC001 por sustitución de ${item.code}`
    })))
  };
  return { ...report, products: [...report.products, reversal], totalQuantity: report.totalQuantity + quantity };
}
function consumptionStockRows(report) {
  const ingredients = report.ingredients?.items || [];
  const directCodes = new Set(ingredients.filter(item => item.includesDirectConsumption).map(item => item.code));
  // Direct ingredients already occur in the ingredient totals, together with recipe usage.
  return [...(report.products?.products || []).filter(item => !directCodes.has(item.code)), ...ingredients];
}
module.exports = {consumptionQuantities,consumptionStockRows,consumptionUnitForCode,withEmployeeMilkSubstitutions};
