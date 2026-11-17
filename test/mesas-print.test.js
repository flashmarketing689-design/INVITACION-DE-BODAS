const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('al imprimir, las mesas van 4 por hoja (2 × 2) sin el asa de arrastre', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mesas.html'), 'utf8');
  const print = html.match(/@media print\{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(print, 'falta el estilo de impresión');
  assert.match(print, /\.tables\{grid-template-columns:repeat\(2,1fr\)/);
  assert.match(print, /\.table-card:nth-child\(4n\+1\):not\(:first-child\)\{break-before:page\}/);
  assert.match(print, /\.grip/);
  assert.match(print, /\.guest,\.guest\.compact\{min-height:0!important\}/, 'sin la altura táctil de 44 px');
});
