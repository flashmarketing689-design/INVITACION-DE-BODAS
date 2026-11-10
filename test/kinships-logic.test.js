const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kinships');

test('vienen madre, padre y hermano(a)', () => {
  assert.deepEqual(K.DEFAULT_KINSHIPS.map((item) => item.name), ['Madre', 'Padre', 'Hermano(a)']);
});

test('crear: clave estable sin acentos ni símbolos, sin repetir nombres ni claves', () => {
  let list = K.DEFAULT_KINSHIPS;
  let result = K.createKinship(list, '  Abuelo(a) ');
  assert.equal(result.key, 'abuelo_a');
  list = result.next;
  assert.equal(list.at(-1).sort_order, 4);
  assert.equal(K.slugify('Tío político'), 'tio_politico');
  assert.equal(K.slugify('¡¡¡'), 'parentesco');
  assert.throws(() => K.createKinship(list, 'ABUELO(A)'), { code: 'DUPLICATE' });
  assert.throws(() => K.createKinship(list, '   '), { code: 'INVALID' });
  assert.throws(() => K.createKinship(list, 'x'.repeat(41)), { code: 'INVALID' });
  // Dos nombres distintos que dan la misma clave no chocan.
  const first = K.createKinship(list, 'Primo/a').next;
  const second = K.createKinship(first, 'Primo-a');
  assert.equal(first.at(-1).key, 'primo_a');
  assert.equal(second.key, 'primo_a_2');
});

test('renombrar y eliminar', () => {
  const list = K.DEFAULT_KINSHIPS;
  assert.equal(K.renameKinship(list, 'hermano', 'Hermano o hermana').find((item) => item.key === 'hermano').name, 'Hermano o hermana');
  assert.equal(K.renameKinship(list, 'madre', 'Madre').length, 3, 'puede conservar su nombre');
  assert.throws(() => K.renameKinship(list, 'madre', 'padre'), { code: 'DUPLICATE' });
  assert.throws(() => K.renameKinship(list, 'nada', 'X'), { code: 'NOT_FOUND' });
  assert.deepEqual(K.deleteKinship(list, 'padre').map((item) => item.key), ['madre', 'hermano']);
  assert.throws(() => K.deleteKinship(list, 'nada'), { code: 'NOT_FOUND' });
});

test('hay un máximo de parentescos y las claves se validan', () => {
  let list = K.DEFAULT_KINSHIPS;
  for (let i = list.length; i < K.MAX_KINSHIPS; i += 1) list = K.createKinship(list, `Pariente ${i}`).next;
  assert.equal(list.length, 30);
  assert.throws(() => K.createKinship(list, 'Uno más'), { code: 'INVALID' });
  assert.ok(K.isValidKey('abuelo_2') && !K.isValidKey('Abuelo') && !K.isValidKey('') && !K.isValidKey(null) && !K.isValidKey('a'.repeat(31)));
});
