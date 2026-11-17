const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCaseName, titleCaseLines } = require('../lib/names');

const CASES = [
  ['juan perez', 'Juan Perez'],
  ['MARÍA PÉREZ', 'María Pérez'],
  ['  starlin   paulino  pérez ', 'Starlin Paulino Pérez'],
  ['ana-maría gómez', 'Ana-María Gómez'],
  ["o'neil", "O'Neil"],
  ['maría de los ángeles', 'María de los Ángeles'],
  ['juan pérez del rosario', 'Juan Pérez del Rosario'],
  ['rosa y beto', 'Rosa y Beto'],
  ['de la cruz', 'De la Cruz'],
  ['ÑANDÚ ÁLVAREZ', 'Ñandú Álvarez'],
  ['j.p. rojas', 'J.P. Rojas'],
  ['luis  ÁNGEL   núñez', 'Luis Ángel Núñez'],
  ['familia pérez', 'Familia Pérez'],
  ['', ''],
  ['   ', ''],
];

test('la primera letra de cada nombre y apellido queda en mayúscula', () => {
  for (const [input, expected] of CASES) assert.equal(titleCaseName(input), expected, input);
});

test('es idempotente y tolera valores vacíos', () => {
  for (const [, expected] of CASES) assert.equal(titleCaseName(expected), expected);
  assert.equal(titleCaseName(null), '');
  assert.equal(titleCaseName(undefined), '');
  assert.equal(titleCaseName(42), '42');
});

test('una lista con un nombre por línea se arregla línea por línea', () => {
  assert.equal(titleCaseLines('ana pérez\r\nLUIS gómez\n\nrené  ruiz'), 'Ana Pérez\nLuis Gómez\n\nRené Ruiz');
  assert.equal(titleCaseLines(''), '');
});

test('el navegador (admin-common.js) aplica exactamente la misma regla', () => {
  const common = require('../admin-common');
  for (const [input] of CASES) assert.equal(common.titleCaseName(input), titleCaseName(input), input);
  assert.equal(common.titleCaseLines('ana pérez\nLUIS gómez'), 'Ana Pérez\nLuis Gómez');
});

test('todos los campos de nombre de las pantallas se corrigen al escribir', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fields = { 'admin.html': ['rename-name'], 'invitados.html': ['f-nombre'], 'invitaciones.html': ['display-name', 'new-display-name', 'new-member-names'],
    'cortejo.html': ['member-name'], 'recepcion.html': ['operator'] };
  for (const [file, ids] of Object.entries(fields)) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"[^>]*data-names?[ >]`), `${file}: #${id}`);
  }
});
