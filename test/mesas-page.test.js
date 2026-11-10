const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'mesas.html'), 'utf8');

test('la página de mesas tiene scripts válidos y usa los módulos comunes', () => {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  assert.match(html, /<script src="\/admin-common\.js\?v=1"><\/script>/);
  assert.match(html, /<script src="\/guest-removal\.js\?v=1"><\/script>/);
  assert.match(html, /<header class="top">/, 'el menú lateral necesita la cabecera .top');
});

test('el módulo aparece en el menú, en el servidor de desarrollo y en las cabeceras de caché', () => {
  assert.match(fs.readFileSync(path.join(root, 'admin-shell.js'), 'utf8'), /key: 'mesas'.*href: 'mesas\.html'/s);
  assert.match(fs.readFileSync(path.join(root, 'dev-server.js'), 'utf8'), /'mesas\.html'/);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(config.headers.some((rule) => /mesas/.test(rule.source)));
});

test('chip() nunca recibe el índice de .map() como modo compacto', () => {
  // .map(chip) pasa (elemento, índice); el índice 1, 2… activaba el modo compacto y
  // ocultaba el detalle (grupo y parentesco) de todos los invitados menos el primero.
  assert.doesNotMatch(html, /\.map\(chip\)/);
  assert.match(html, /function chip\(person, compact = false\)/);
});
