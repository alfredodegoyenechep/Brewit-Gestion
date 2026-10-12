const { feminine, masculine, ambiguous } = require('./name-dictionary');
const NAME_CLASSIFIER_VERSION = 'es-en-hybrid-v2';
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const MODE_WORDS = new Set('para por llevar servir servirse local mesa retiro retirar take away takeaway dine in aqui aca en el la nombre cliente client name pedido order sr sra mr mrs miss'.split(' '));
const GENERIC = /\b(empresa|sociedad|spa|ltda|eirl|factura|boleta|anonimo|sin nombre|sin comentario|consumidor|mostrador|delivery|rappi|uber|pedidos ya)\b/;
const INSTRUCTIONS = /\b(sin|con|extra|leche|azucar|cafe|coffee|latte|te|tea|matcha|chai|avena|vainilla|avellana|canela|cocina|barra|caliente|frio|hielo|vaso|taza|grande|chico|doble|descafeinado|endulzante|sacarina|propina|oficina|esquina|mandarina|proteina|harina|maquina)\b/;
const COMPOUND = new Map([
  ['maria jose', 'feminine-associated'], ['maria jesus', 'feminine-associated'],
  ['maria angel', 'feminine-associated'], ['jose maria', 'masculine-associated'],
  ['juan maria', 'masculine-associated']
]);
const result = (segment, basis, method = 'none') => ({ segment, basis, method });

function classifyRecordedName(comment) {
  if (!String(comment ?? '').trim()) return result('unavailable', 'no-recorded-name');
  const text = normalize(comment);
  if (!text) return result('indeterminate', 'initial-or-empty');
  if (GENERIC.test(text)) return result('indeterminate', 'generic-or-business-entry');
  if (INSTRUCTIONS.test(text)) return result('indeterminate', 'instruction-or-product');
  // Separadores explícitos no permiten atribuir el pedido a un único nombre.
  if (/\b(?:y|and)\b/.test(text) || /[&+\/]/.test(String(comment))) {
    return result('indeterminate', 'multiple-name-entry');
  }
  const tokens = text.split(' ').filter(token => !MODE_WORDS.has(token));
  if (!tokens.length || tokens[0].length < 2) return result('indeterminate', 'initial-or-empty');
  const compound = COMPOUND.get(tokens.slice(0, 2).join(' '));
  if (tokens.some(token => ambiguous.has(token))) return result('indeterminate', 'ambiguous-name');
  if (compound && tokens.length === 2) return result(compound, 'compound-name-v2', 'dictionary');
  const known = tokens.filter(token => feminine.has(token) || masculine.has(token));
  if (known.some(token => feminine.has(token)) && known.some(token => masculine.has(token))) {
    return result('indeterminate', 'conflicting-or-ambiguous');
  }
  // El primer candidato debe ser un nombre; no buscar nombres dentro de texto libre.
  if (feminine.has(tokens[0])) return result('feminine-associated', 'dictionary-es-en-v2', 'dictionary');
  if (masculine.has(tokens[0])) return result('masculine-associated', 'dictionary-es-en-v2', 'dictionary');
  // Respaldo de menor certeza, solo para un candidato aislado de 5–24 letras.
  // Patrones lingüísticos explícitos: no son probabilidades calibradas y nunca
  // se consideran información validada. No basta con terminar en «a» u «o».
  if (tokens.length === 1 && /^[a-z]{5,24}$/.test(tokens[0])) {
    if (/(?:iana|ina|ella|ette)$/.test(tokens[0])) {
      return result('feminine-associated', 'suffix-feminine-v2', 'inference');
    }
    if (/(?:ardo|andro|aldo|bert|fred)$/.test(tokens[0])) {
      return result('masculine-associated', 'suffix-masculine-v2', 'inference');
    }
  }
  return result('indeterminate', 'outside-dictionary-no-pattern');
}
module.exports = { classifyRecordedName, NAME_CLASSIFIER_VERSION };
