const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-zñ\s-]/g, ' ').replace(/\s+/g, ' ').trim();

// Diccionario conservador y versionado. Su finalidad es una asociación lingüística
// agregada, nunca confirmar identidad ni género de una persona.
const FEMININE = new Set(`adriana alejandra alicia amanda ana andrea angela antonia barbara beatriz camila carla carolina catalina cecilia claudia constanza daniela diana elena elisa emilia fernanda francisca gabriela gloria isabel javiera josefina karen karina laura lorena lucia macarena magdalena marcela maria mariana marisol martina melissa monica natalia nicole pamela paola patricia paulina pilar renata romina rosario sofia sonia susana tamara teresa valentina vanessa veronica victoria ximena`.split(' '));
const MASCULINE = new Set(`adrian alejandro alfonso alvaro andres antonio benjamin bruno carlos cristian daniel david diego eduardo esteban fabian felipe fernando francisco gabriel gonzalo guillermo gustavo hernan ignacio jaime javier joaquin jorge jose juan leonardo luis manuel marcelo marco mario martin matias mauricio maximiliano miguel nicolas oscar pablo patricio pedro rafael raul ricardo roberto rodrigo sebastian sergio tomas vicente victor`.split(' '));
const AMBIGUOUS = new Set('alex andy ariel camille chris cruz dominique fran gabriel guadalupe jean jesus mar jose maria paz sam sasha'.split(' '));
const GENERIC = /\b(cliente|consumidor|empresa|sociedad|spa|ltda|eirl|factura|boleta|anonimo|sin nombre|mostrador|delivery|rappi|uber|pedidos? ya|llevar|servir|local|mesa|retiro|take away)\b/;
const MODE_WORDS = new Set('para por llevar servir local mesa retiro take away aqui aca cliente'.split(' '));

function classifyRecordedName(comment) {
  const text = normalize(comment);
  if (!text) return { segment: 'unavailable', basis: 'no-recorded-name' };
  if (GENERIC.test(text)) {
    const tokensWithPossibleName = text.split(' ').filter(token => !MODE_WORDS.has(token));
    if (!tokensWithPossibleName.some(token => FEMININE.has(token) || MASCULINE.has(token))) {
      return { segment: 'indeterminate', basis: 'generic-or-business-entry' };
    }
  }
  const tokens = text.split(' ').filter(token => token.length > 1 && !MODE_WORDS.has(token));
  if (!tokens.length || tokens.every(token => token.length === 1)) return { segment: 'indeterminate', basis: 'initial-or-empty' };
  const known = tokens.filter(token => FEMININE.has(token) || MASCULINE.has(token) || AMBIGUOUS.has(token));
  if (!known.length) return { segment: 'indeterminate', basis: 'outside-dictionary' };
  if (known.some(token => AMBIGUOUS.has(token))) return { segment: 'indeterminate', basis: 'ambiguous-name' };
  const feminine = known.some(token => FEMININE.has(token));
  const masculine = known.some(token => MASCULINE.has(token));
  if (feminine === masculine) return { segment: 'indeterminate', basis: 'conflicting-or-ambiguous' };
  return { segment: feminine ? 'feminine-associated' : 'masculine-associated', basis: 'conservative-dictionary-v1' };
}

module.exports = { classifyRecordedName, NAME_CLASSIFIER_VERSION: 'cl-conservative-v1' };
