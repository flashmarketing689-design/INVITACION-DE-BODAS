const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pages = ['admin.html', 'invitados.html', 'invitaciones.html', 'cortejo.html', 'mesas.html', 'recepcion.html'];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('ninguna pantalla del panel usa letra por debajo del mínimo (.75rem)', () => {
  for (const file of [...pages, 'admin-shell.css']) {
    const sizes = [...read(file).matchAll(/font-size:\s*(0?\.\d+)rem/g), ...read(file).matchAll(/font:[^;}{]*?\s(0?\.\d+)rem/g)].map((m) => Number(m[1]));
    const small = sizes.filter((size) => size < 0.75);
    assert.deepEqual(small, [], `${file} tiene tamaños menores a .75rem: ${small.join(', ')}`);
  }
});

test('el sistema visual compartido define la escala, los controles altos y una sola paleta', () => {
  const css = read('admin-shell.css');
  assert.match(css, /html \{ font-size: 125%; \}/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /--green: #4f7352/);
  for (const file of pages) {
    assert.match(read(file), /<link rel="stylesheet" href="\/admin-shell\.css/, `${file} carga el sistema visual`);
    assert.doesNotMatch(read(file), /Cormorant/, `${file} usa una sola tipografía`);
  }
});
