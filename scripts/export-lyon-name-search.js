#!/usr/bin/env node
// Reproduce the requested, fixed roster without querying or changing sources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { VERSION, searchRecordedName, searchKey } = require('../recorded-name-search');
const directory = path.resolve(__dirname, '../docs/auditoria/2026-10-31');
const input = path.join(directory, 'PEDIDOS_PORTAL_LYON_2026-10-03_2026-10-30.xlsx');
const output = path.join(directory, 'PEDIDOS_PORTAL_LYON_BUSQUEDA_NOMBRES_2026-10-03_2026-10-30.xlsx');
const inputBytes = fs.readFileSync(input);
const original = XLSX.read(inputBytes, { type: 'buffer' });
const orders = XLSX.utils.sheet_to_json(original.Sheets['Detalle 978 pedidos'], { defval: '' });
assert.equal(orders.length, 978, 'El listado de origen debe contener los 978 pedidos solicitados.');
const labels = { recognized: 'Nombre reconocido', pending: 'Candidato pendiente de revisión', absent: 'Sin nombre identificable en el texto', ambiguous: 'Comentario ambiguo: revisar' };
const results = orders.map(order => ({ order, result: searchRecordedName(order['Comentario General original']) }));
const counts = Object.fromEntries(Object.keys(labels).map(status => [status, results.filter(item => item.result.status === status).length]));
const withComment = orders.filter(order => String(order['Comentario General original']).trim()).length;
assert.equal(withComment, 904);
assert.equal(new Set(orders.map(order => order['Pedido / Comanda'])).size, 978);
assert.equal(Object.values(counts).reduce((total, count) => total + count, 0), 978);
const book = XLSX.utils.book_new();
function append(name, rows, widths) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = widths.map(wch => ({ wch }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  XLSX.utils.book_append_sheet(book, sheet, name);
  return sheet;
}
const summaryRows = [
  ['Resultado de búsqueda de nombres — Portal Lyon', 'Pedidos', '% del total'],
  ...Object.entries(labels).map(([key, label]) => [label, counts[key], counts[key] / 978]),
  ['TOTAL PEDIDOS', 978, 1],
  [], ['Cobertura del comentario', 'Pedidos', '% del total'],
  ['Con comentario original', withComment, withComment / 978], ['Sin comentario original', 978 - withComment, (978 - withComment) / 978],
  [], ['Género indicado expresamente en el comentario', 'Pedidos', '% del total'],
  ...['Masculino indicado en texto', 'Femenino indicado en texto', 'Sin información', 'No identificable'].map(label => {
    const count = results.filter(item => item.result.genderInText === label).length;
    return [label, count, count / 978];
  })
];
const summary = append('Resumen', summaryRows, [57, 15, 18]);
for (const [address, cell] of Object.entries(summary)) if (/^C\d+$/u.test(address) && cell.t === 'n') cell.z = '0.0%';
const headers = ['N°', 'Fecha y hora de cierre', 'Pedido / Comanda', 'Comentario General original', 'Nombre normalizado / candidato',
  'Resultado de búsqueda', 'Motivo', 'Sugerencia de escritura: revisar', 'Género indicado en el texto', 'Versión del proceso'];
const detailRows = results.map(({ order, result }, index) => [index + 1, order['Fecha y hora de cierre'], String(order['Pedido / Comanda']),
  order['Comentario General original'], result.normalizedName, labels[result.status], result.reason, result.suggestion, result.genderInText, VERSION]);
const detail = append('Detalle 978 pedidos', [headers, ...detailRows], [7, 23, 24, 40, 34, 39, 80, 48, 31, 29]);
for (let row = 2; row <= 979; row++) detail[`C${row}`].z = '@';
append('Pendientes y ambiguos', [headers, ...detailRows.filter((row, i) => ['pending', 'ambiguous'].includes(results[i].result.status))], [7, 23, 24, 40, 34, 39, 80, 48, 31, 29]);
const candidates = new Map();
for (const { order, result } of results.filter(item => item.result.status === 'pending')) {
  const key = searchKey(result.normalizedName), existing = candidates.get(key) || { name: result.normalizedName, count: 0, suggestion: result.suggestion, sample: order['Comentario General original'] };
  existing.count++; candidates.set(key, existing);
}
append('Candidatos fuera de base', [['Candidato normalizado', 'Pedidos', 'Sugerencia de escritura: revisar', 'Comentario de ejemplo'],
  ...[...candidates.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es')).map(item => [item.name, item.count, item.suggestion, item.sample])], [35, 13, 60, 45]);
append('Criterios', [
  ['Criterio', 'Descripción'], ['Local y período', 'Portal Lyon · 03–30 octubre 2026 · America/Santiago'],
  ['Origen del listado', path.basename(input)], ['SHA-256 del listado de origen', crypto.createHash('sha256').update(inputBytes).digest('hex')],
  ['Unidad', '978 pedidos únicos, uno por Comanda. Se conserva exactamente el listado ya auditado; no se agregan pedidos de nuevas sincronizaciones.'],
  ['Original', 'Comentario General original del listado de origen, conservado sin cambios. Los comentarios de pagos distintos ya están reunidos por pedido.'],
  ['Búsqueda', 'Se ignoran diferencias de mayúsculas, tildes y espacios. Se separan las expresiones reconocidas de modalidad y las etiquetas de nombre o tratamiento.'],
  ['Presentación', 'Nombre en mayúscula inicial por palabra y espacios normalizados. En nombres de grafía habitual inequívoca se propone la tilde de la base de presentación; no se corrige la identidad del cliente.'],
  ['Nombre reconocido', 'Coincidencia con la unión de nombres de la biblioteca local, sin utilizar sus asociaciones de género, o compuesto reconocido. Un posible apellido se conserva; no se verifica identidad.'],
  ['Candidato pendiente', 'Texto compatible con un nombre, fuera de la base. Puede ser nombre nuevo, apodo o errata; no se lo descarta ni se lo da por confirmado.'],
  ['Sugerencias', 'Hasta cinco nombres a una edición o transposición de distancia, con similitud mínima de 85% y los mismos caracteres inicial y final. Se excluyen candidatos cortos y cambios de terminación. Solo se proponen para revisión; nunca reemplazan automáticamente al candidato.'],
  ['Ambigüedad', 'Iniciales, varios candidatos, instrucciones mezcladas o texto comercial/genérico. Requiere revisar el comentario.'],
  ['Sin nombre', 'Ausencia de comentario, o texto sin candidato a nombre; no equivale a ausencia de pedido.'],
  ['Género indicado en texto', 'Solo se reconoce una mención literal como hombre, mujer, masculino o femenino; no es una verificación del género de la persona. No se deduce género de un nombre, apodo, tilde o corrección sugerida.'],
  ['Alcance', 'Prueba reproducible de búsqueda para este listado. No modifica las fuentes ni cambia los reportes existentes.'], ['Versión', VERSION]
], [31, 145]);
XLSX.writeFile(book, output, { compression: true });
const checked = XLSX.readFile(output);
const exported = XLSX.utils.sheet_to_json(checked.Sheets['Detalle 978 pedidos'], { defval: '' });
assert.equal(exported.length, 978);
assert.equal(new Set(exported.map(row => row['Pedido / Comanda'])).size, 978);
for (let index = 0; index < orders.length; index++) {
  assert.equal(exported[index]['Comentario General original'], orders[index]['Comentario General original']);
  assert.equal(exported[index]['Pedido / Comanda'], String(orders[index]['Pedido / Comanda']));
}
for (const sheet of Object.values(checked.Sheets)) for (const [address, cell] of Object.entries(sheet)) if (!address.startsWith('!')) assert.equal(cell.f, undefined);
console.log(JSON.stringify({ output, orders: 978, withComment, counts, uniquePendingCandidates: candidates.size, explicitGender: Object.fromEntries(['Masculino indicado en texto', 'Femenino indicado en texto', 'Sin información', 'No identificable'].map(label => [label, results.filter(item => item.result.genderInText === label).length])), validatedReadback: true }));
