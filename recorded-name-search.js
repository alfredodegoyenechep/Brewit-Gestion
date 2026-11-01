// Recognition of recorded names, never an inference of a person's gender.
const dictionary = require('./name-dictionary');
const VERSION = 'recorded-name-search-v3';
const primaryKey = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('es').replace(/\s+/gu, ' ').trim();
// Remove vowel accents/diaereses, while retaining ñ as a distinct letter.
const searchKey = value => primaryKey(value).normalize('NFD').replace(/[\u0301\u0308]/gu, '').normalize('NFC');
const names = new Set(Object.values(dictionary).flatMap(list => [...list]).map(searchKey));
const additional = `Marisela Lucina Natalina Vanesa Priscilla Ignacia Dominga Isidora Nelson Aldo Loreto Tatiana Ariela Alexis Angelo Bastián Aníbal Pía Danae Miriam Mariel Alondra Reinaldo Rafaela Danilo Paulo Adolfo Américo`;
for (const name of additional.split(' ')) names.add(searchKey(name));
const canonical = new Map(`Adán Adrián Agustín Aída Álvaro Ángela Ángeles Angélica Anahí Bárbara Belén Benjamín César Cristóbal Damián Darío Débora Elías Fabián Fátima Félix Germán Héctor Hernán Inés Iván Jerónimo Jesús Joaquín José Julián León Lucía María Martín Matías Mónica Moisés Nicolás Óscar Ramón Raúl René Rocío Rosalía Rubén Sebastián Simón Sofía Tomás Valentín Verónica Víctor ${additional}`.split(/\s+/u).map(name => [searchKey(name), name]));
const compounds = new Set(['maria jose', 'maria jesus', 'maria angel', 'jose maria', 'juan maria', 'juan pablo', 'juan jose', 'jose luis', 'maria ines', 'maria ester', 'maria teresa', 'maria fernanda', 'maria ignacia', 'maria noel', 'ana maria', 'ana paula', 'luis alberto', 'juan carlos']);
const operations = new Set('para por llevar servir consumir aca aqui en el local mesa retiro retirar take away takeaway dine in sin con extra leche azucar cafe coffee latte te tea matcha chai avena vainilla avellana canela cocina barra caliente frio hielo vaso taza grande chico doble descafeinado endulzante sacarina propina oficina pedido order no es'.split(' '));
const labels = new Set('nombre cliente client name don doña sr sra señor señora hombre mujer masculino femenino genero'.split(' '));
const title = word => canonical.get(searchKey(word)) || primaryKey(word).replace(/(^|[-'’])\p{L}/gu, letter => letter.toLocaleUpperCase('es'));
const tokenize = text => [...text.matchAll(/\p{L}[\p{L}\p{M}]*(?:[-'’][\p{L}\p{M}]+)*/gu)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, key: searchKey(m[0]) }));
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}
// Spelling proposals supplied in the reviewed specification; never automatic replacements.
const reviewedSpellings = new Map([['grabiela', 'Gabriela'], ['fepile', 'Felipe'], ['prsicilla', 'Priscilla']]);
function candidatesFor(token) {
  if (names.has(token) || token.length < 5) return [];
  const proposed = reviewedSpellings.get(token);
  const reviewed = proposed ? [{ name: proposed, distance: distance(token, searchKey(proposed)), similarity: 1 - distance(token, searchKey(proposed)) / Math.max(token.length, proposed.length), observed: title(token), reason: 'Propuesta de escritura de la especificación revisada; requiere confirmación' }] : [];
  return [...reviewed, ...[...names].flatMap(name => {
    const d = distance(token, name), similarity = 1 - d / Math.max(token.length, name.length);
    // Ending changes can be legitimate names; leave them for review without a replacement suggestion.
    return d <= (token.length >= 8 ? 2 : 1) && similarity >= 0.8 && token.at(-1) === name.at(-1)
      ? [{ name: title(name), distance: d, similarity, observed: title(token) }] : [];
  }).filter(c => c.name !== proposed).sort((a, b) => b.similarity - a.similarity || a.name.localeCompare(b.name, 'es'))].slice(0, 5);
}
function literalGender(text) {
  const tokens = tokenize(text), evidence = tokens.filter(t => ['hombre', 'mujer', 'masculino', 'femenino'].includes(t.key));
  if (!evidence.length) return { value: null, status: 'missing', evidence: [] };
  const keys = new Set(evidence.map(t => ['hombre', 'masculino'].includes(t.key) ? 'masculine' : 'feminine'));
  const unclear = keys.size > 1 || tokens.some(t => ['no', 'ni', 'tampoco', 'y', 'o', 'and', 'or'].includes(t.key))
    || /[&+\/]/u.test(text) || tokens.some((t, i) => t.key === 'sin' && tokens.slice(i + 1, i + 4).some(next => evidence.includes(next)));
  return { value: unclear ? null : [...keys][0], status: unclear ? 'ambiguous' : 'literal', evidence };
}
function classifyPart(original, offset) {
  const tokens = tokenize(original), key = searchKey(original);
  if (/\b(?:empresa|sociedad|spa|ltda|eirl|factura|boleta|mostrador|delivery|rappi|uber)\b/u.test(key)) return { status: 'ambiguous', reason: 'Texto comercial o genérico', normalizedName: '', spans: [], candidates: [] };
  if (/\b(?:sin nombre|sin comentario|anonimo|consumidor final)\b/u.test(key)) return { status: 'absent', reason: 'Sin nombre registrado', normalizedName: '', spans: [], candidates: [] };
  const hasConnector = tokens.some(t => ['y', 'o', 'and', 'or'].includes(t.key)) || /[&+\/]/u.test(original);
  const kept = tokens.filter((t, i) => !operations.has(t.key) && !labels.has(t.key) && !['y', 'o', 'and', 'or'].includes(t.key)
    && !(t.key === 'dom' && compounds.has(tokens.slice(i + 1, i + 3).map(x => x.key).join(' '))));
  const spans = kept.map(t => ({ text: t.text, start: t.start + offset, end: t.end + offset, role: 'name-candidate' }));
  const normalizedName = kept.map(t => title(t.text)).join(hasConnector ? ' / ' : ' ');
  if (!kept.length) return { status: 'absent', reason: 'El comentario no contiene un candidato a nombre', normalizedName: '', spans, candidates: [] };
  if (hasConnector || kept.some(t => t.key.length === 1) || kept.length > 5 || /\d/u.test(original)) return { status: 'ambiguous', reason: 'Varios candidatos, iniciales o texto insuficiente', normalizedName, spans, candidates: [] };
  const phrase = kept.map(t => t.key).join(' ');
  if (compounds.has(phrase)) return { status: 'recognized', reason: tokens[0]?.key === 'dom' ? 'Nombre compuesto; tratamiento «dom» separado para revisión' : 'Nombre compuesto reconocido', normalizedName, spans, candidates: [] };
  if (kept.filter(t => names.has(t.key)).length > 1) return { status: 'ambiguous', reason: 'Varios nombres fuera de los compuestos reconocidos', normalizedName, spans, candidates: [] };
  if (names.has(kept[0].key)) return { status: 'recognized', reason: kept.length === 1 ? 'Nombre reconocido en la base' : 'Primer nombre reconocido; posible apellido conservado', normalizedName, spans, candidates: [] };
  return { status: 'pending', reason: 'Posible nombre nuevo, apodo o errata: revisar', normalizedName, spans, candidates: kept.flatMap(t => candidatesFor(t.key)) };
}
function searchRecordedName(comment) {
  const original = String(comment ?? '');
  if (!original.trim()) return { version: VERSION, status: 'absent', reason: 'Sin comentario registrado', normalizedName: '', suggestion: '', spans: [], candidates: [], genderInText: 'Sin información' };
  const parts = [...original.matchAll(/[^\r\n]+/gu)].filter(m => m[0].trim()).map(m => classifyPart(m[0], m.index));
  const candidates = [...new Map(parts.filter(p => p.normalizedName).map(p => [searchKey(p.normalizedName), p])).values()];
  let result = candidates.length === 1 && !parts.some(p => p.status === 'ambiguous') ? { ...candidates[0] } : { ...parts[0] };
  if (candidates.length > 1 || parts.some(p => p.status === 'ambiguous')) result = { status: 'ambiguous', normalizedName: candidates.map(p => p.normalizedName).join(' / '), reason: 'Comentario ambiguo o distintos candidatos en el pedido', candidates: [] };
  result.spans = parts.flatMap(p => p.spans);
  result.suggestion = result.candidates.map(c => `${c.observed} → ${c.name}`).join('; ');
  const gender = literalGender(original);
  return { version: VERSION, ...result, genderInText: gender.status === 'ambiguous' ? 'No identificable' : gender.value === 'masculine' ? 'Masculino indicado en texto' : gender.value === 'feminine' ? 'Femenino indicado en texto' : 'Sin información' };
}
module.exports = { VERSION, primaryKey, searchKey, searchRecordedName, literalGender };
