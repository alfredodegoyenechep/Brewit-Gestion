function consumptionQuantities(values, declaredUnit = 'UN') {
  const groups = new Map();
  const units = {ml:['L',.001],cc:['L',.001],l:['L',1],lt:['L',1],kg:['kg',1],g:['kg',.001],gr:['kg',.001],un:['UN',1],unidad:['UN',1],unidades:['UN',1]};
  for (const value of values) {
    const match = String(value ?? '').trim().match(/^(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)(?:\s*\([^)]*\))?$/);
    if (!match) continue;
    const rawUnit = (match[2] || declaredUnit || 'UN').trim();
    const [unit, factor] = units[rawUnit.toLowerCase()] || [rawUnit,1];
    const quantity = Number(match[1].replace(',','.')) * factor;
    if (Number.isFinite(quantity)) groups.set(unit,(groups.get(unit)||0)+quantity);
  }
  return [...groups].filter(([,quantity])=>quantity!==0).map(([unit,quantity])=>({unit,quantity}));
}
module.exports = {consumptionQuantities};
