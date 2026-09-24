const Decimal = require('decimal.js').clone({ precision: 40, rounding: 4 });
class DomainError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const check = (condition, message, status) => { if (!condition) throw new DomainError(message, status); };
function decimal(value) {
  check(typeof value === 'string' || typeof value === 'number', 'Falta un valor decimal.');
  try { const d = new Decimal(value); check(d.isFinite() && d.abs().lt('1e18'), 'Valor fuera de rango.'); return d; }
  catch (e) { if (e instanceof DomainError) throw e; throw new DomainError('Número inválido.'); }
}
const positive = value => { const d = decimal(value); check(d.gt(0), 'La cantidad o costo debe ser mayor que cero.'); return d; };
const amount = value => decimal(value).toFixed(8);
function timestamp(value) {
  check(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Indica fecha y hora con zona horaria.');
  return new Date(value).toISOString();
}
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, 'Fecha inválida.');
  return value;
}
const units = { UN: ['count','1'], KG: ['mass','1'], G: ['mass','0.001'], L: ['volume','1'], ML: ['volume','0.001'], CC: ['volume','0.001'] };
function convert(item, quantity, unit) {
  check(typeof unit === 'string', 'Falta unidad de medida.');
  const from = unit.toUpperCase(), to = item.baseUnit;
  let factor;
  if (from === to) factor = decimal(1);
  else if (units[from] && units[to] && units[from][0] === units[to][0]) factor = decimal(units[from][1]).div(units[to][1]);
  else {
    const c = item.conversions.find(c => c.unit === from);
    check(c, `Falta conversión de ${from} a ${to} para ${item.code}.`);
    factor = positive(c.numerator).div(positive(c.denominator));
  }
  return decimal(quantity).mul(factor);
}
function validateItem(body) {
  check(body && /^[\w.-]{1,64}$/.test(body.code || ''), 'Código inválido.');
  check(typeof body.name === 'string' && body.name.trim() && body.name.length <= 200, 'Nombre requerido (máximo 200 caracteres).');
  check(['stock','recipe','prepared','service'].includes(body.policy), 'Define política: stock, recipe, prepared o service.');
  check(['hot','cold','other'].includes(body.bar), 'Define barra hot, cold u other.');
  check(typeof body.baseUnit === 'string' && /^[A-Z0-9]{1,12}$/.test(body.baseUnit), 'Unidad base inválida.');
  const conversions = body.conversions || [], seen = new Set();
  check(Array.isArray(conversions), 'Conversiones inválidas.');
  for (const c of conversions) {
    check(/^[A-Z0-9]{1,12}$/.test(c.unit) && c.unit !== body.baseUnit && !seen.has(c.unit), 'Unidad de conversión duplicada o inválida.');
    positive(c.numerator); positive(c.denominator); seen.add(c.unit);
  }
  if (body.recipe) {
    positive(body.recipe.yield);
    check(Array.isArray(body.recipe.lines) && body.recipe.lines.length > 0, 'La receta debe tener ingredientes.');
    for (const l of body.recipe.lines) { check(typeof l.code === 'string' && typeof l.unit === 'string', 'Ingrediente inválido.'); positive(l.quantity); }
  }
  check(!['recipe','prepared'].includes(body.policy) || body.recipe, 'Falta receta.');
  check(!body.expiryRequired || body.lotRequired,'El vencimiento obligatorio requiere control por lote.');
  if(body.externalCodes) {
    check(typeof body.externalCodes==='object' && !Array.isArray(body.externalCodes),'Equivalencias externas inválidas.');
    for(const [location,code] of Object.entries(body.externalCodes))check(['store-1','store-2'].includes(location) && typeof code==='string' && code.length>0 && code.length<=120,'Código externo o ubicación inválidos.');
  }
  return { ...body, name: body.name.trim(), conversions, active: body.active !== false, lotRequired: body.lotRequired === true, expiryRequired: body.expiryRequired === true };
}
// The resolver selects the immutable item version effective at the sale date.
async function explode(resolve, code, quantity, unit, { production = false, substitutions = [] } = {}) {
  const result = new Map();
  async function visit(code, quantity, unit, ancestors, force) {
    check(!ancestors.includes(code), `Receta circular: ${[...ancestors,code].join(' → ')}.`);
    const item = await resolve(code);
    check(item && item.body.active, `Artículo sin versión vigente: ${code}.`);
    const b = item.body, q = convert(b, quantity, unit);
    if (b.policy === 'service' && !force) return;
    if (['stock','prepared'].includes(b.policy) && !force) {
      const old = result.get(code);
      result.set(code, { item, quantity: (old?.quantity || decimal(0)).add(q) }); return;
    }
    check(b.recipe, `Falta receta de ${code}.`);
    const factor = q.div(positive(b.recipe.yield));
    for (const line of b.recipe.lines) await visit(line.code, positive(line.quantity).mul(factor).toString(), line.unit, [...ancestors,code], false);
  }
  await visit(code, positive(quantity).toString(), unit, [], production);
  for (const s of substitutions) {
    const original = result.get(s.removeCode);
    check(original, `La sustitución no encuentra ${s.removeCode}.`);
    const removal = convert(original.item.body, positive(s.removeQuantity).toString(), s.removeUnit);
    check(original.quantity.gte(removal), 'La sustitución excede el ingrediente original.');
    original.quantity = original.quantity.sub(removal);
    await visit(s.addCode, positive(s.addQuantity).toString(), s.addUnit, [], false);
  }
  return [...result.values()].filter(r => r.quantity.gt(0));
}
module.exports = { Decimal, DomainError, check, decimal, positive, amount, timestamp, date, convert, validateItem, explode };
