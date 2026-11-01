const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRecordedName: search } = require('../recorded-name-search');

test('normaliza mayúsculas, espacios y tildes sin perder el texto de entrada', () => {
  for (const original of ['alfredo', ' ALFREDO ', 'AlFrEdO']) {
    assert.equal(search(original).normalizedName, 'Alfredo');
    assert.equal(search(original).status, 'recognized');
    assert.equal(search(original).genderInText, 'Sin información');
  }
  assert.equal(search('  maria   JOSE ').normalizedName, 'María José');
  assert.equal(search('nicola\u0301s').normalizedName, 'Nicolás');
  assert.equal(search('veronica torres').normalizedName, 'Verónica Torres');
});
test('extrae nombres sin exigir modalidad ni depender de su posición', () => {
  for (const text of ['llevar, tamara', 'Tamara llevar', 'NOMBRE: tamara', 'cliente: Tamara para llevar']) {
    assert.equal(search(text).normalizedName, 'Tamara', text);
    assert.equal(search(text).status, 'recognized', text);
  }
  assert.equal(search('don juan pablo').normalizedName, 'Juan Pablo');
  assert.equal(search('sin azucar camila').normalizedName, 'Camila');
  assert.equal(search('Alex').status, 'recognized');
});
test('conserva nombres nuevos y ofrece correcciones solo como sugerencias', () => {
  const newName = search('Yuran');
  assert.equal(newName.status, 'pending'); assert.equal(newName.normalizedName, 'Yuran');
  const typo = search('ridrigo');
  assert.equal(typo.status, 'pending'); assert.equal(typo.normalizedName, 'Ridrigo');
  assert.match(typo.suggestion, /Rodrigo/);
  assert.equal(typo.genderInText, 'Sin información');
  for (const text of ['cony', 'ignacia', 'dominga']) assert.equal(search(text).suggestion, '', text);
  assert.match(search('crisitna').suggestion, /Cristina/);
});
test('distingue falta de nombre de comentarios ambiguos', () => {
  for (const text of ['', '   ', null, 'servir', 'para llevar', 'hombre']) assert.equal(search(text).status, 'absent', text);
  for (const text of ['A. servir', 'Camila y Pedro', 'Camila / Daniela', 'empresa Rosa Ltda', 'mesa 4 Camila']) {
    assert.equal(search(text).status, 'ambiguous', text);
  }
});
test('reconcilia comentarios repetidos y múltiples pagos sin elegir un nombre arbitrario', () => {
  assert.equal(search('camila\nCAMILA').normalizedName, 'Camila');
  assert.equal(search('camila\nservir').status, 'recognized');
  assert.equal(search('camila\ndaniela').status, 'ambiguous');
  assert.equal(search('servir\ncamila').status, 'recognized');
});
test('solo informa género cuando hay una indicación expresa en el texto', () => {
  assert.equal(search('hombre ivan').genderInText, 'Masculino indicado en texto');
  assert.equal(search('hombre ivan').normalizedName, 'Iván');
  assert.equal(search('mujer cony').genderInText, 'Femenino indicado en texto');
  assert.equal(search('mujer hombre').genderInText, 'No identificable');
  assert.equal(search('no es hombre').genderInText, 'No identificable');
  assert.equal(search('camila').genderInText, 'Sin información');
});
