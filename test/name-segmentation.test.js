const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRecordedName: classify } = require('../name-segmentation');

test('reconoce nombres observados en Lyon, tildes y modalidades', () => {
  for (const name of ['Devora', 'Rosa', 'Celia', 'Belén', 'Emily', 'Araceli', 'Ayleen', 'Anaïs', 'Ingrid']) {
    const value = classify(`  ${name.toUpperCase()}  para llevar  `);
    assert.equal(value.segment, 'feminine-associated', name);
    assert.equal(value.method, 'dictionary', name);
  }
  for (const name of ['León', 'Rubén', 'Nicolás', 'Matías', 'Borja']) {
    assert.equal(classify(`${name} servir`).segment, 'masculine-associated', name);
  }
  assert.equal(classify('Belén\tservir\n').method, 'dictionary');
  assert.equal(classify('Bele\u0301n').method, 'dictionary');
});

test('reconoce inglés y conserva excepciones a patrones', () => {
  for (const name of ['Mary', 'Sarah', 'Elizabeth', 'Rosario', 'Consuelo']) {
    assert.equal(classify(name).segment, 'feminine-associated', name);
  }
  for (const name of ['John', 'James', 'Michael', 'Noah', 'Luca']) {
    assert.equal(classify(name).segment, 'masculine-associated', name);
  }
  assert.equal(classify('William take away').method, 'dictionary');
  assert.equal(classify('Maria Jose').segment, 'feminine-associated');
  assert.equal(classify('José María').segment, 'masculine-associated');
});

test('respaldo por patrones solo en candidatos aislados y con origen explícito', () => {
  for (const name of ['Marcelina', 'Antonella', 'Claudette']) {
    assert.equal(classify(`${name} llevar`).segment, 'feminine-associated');
    assert.equal(classify(name).method, 'inference');
  }
  for (const name of ['Edgardo', 'Leandro', 'Osvaldo', 'Wilbert', 'Wilfred']) {
    assert.equal(classify(name).segment, 'masculine-associated');
    assert.equal(classify(name).method, 'inference');
  }
  for (const name of ['Yuran', 'Ximeno', 'Zulema', 'Marcelina Perez']) {
    assert.equal(classify(name).segment, 'indeterminate', name);
  }
});

test('no convierte ambigüedad, empresas, productos ni instrucciones en personas', () => {
  for (const text of ['Cris', 'Alex', 'Andrea', 'Jean', 'Taylor', 'Kelly', 'cliente empresa SPA',
    'Cafeteria Rosa Ltda', 'sin nombre', 'llevar', '123', 'A. servir', 'para llevar sin sacarina',
    'cocina', 'harina', 'proteina', 'con leche', 'Camila y Pedro', 'Camila / Daniela',
    'Maria & John', 'Juan Camila', 'cliente desconocido Celia', '???']) {
    assert.equal(classify(text).segment, 'indeterminate', text);
    assert.equal(classify(text).method, 'none', text);
  }
  for (const text of ['', '  ', null, undefined]) assert.equal(classify(text).segment, 'unavailable');
  assert.equal(classify('Rosa llevar').basis, 'dictionary-es-en-v2');
  assert.equal(classify('Yuran llevar').basis, 'outside-dictionary-no-pattern');
});
