const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'cortejo.html'), 'utf8');

test('la página del cortejo tiene scripts válidos y usa los módulos comunes', () => {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  assert.match(html, /<script src="\/admin-common\.js\?v=1"><\/script>/);
  assert.match(html, /<script src="\/guest-removal\.js\?v=1"><\/script>/);
  assert.match(html, /<header class="top">/, 'el menú lateral necesita la cabecera .top');
});

test('el cortejo aparece en el menú, en el servidor de desarrollo y en las cabeceras de caché', () => {
  assert.match(fs.readFileSync(path.join(root, 'admin-shell.js'), 'utf8'), /key: 'cortejo'.*href: 'cortejo\.html'/s);
  assert.match(fs.readFileSync(path.join(root, 'dev-server.js'), 'utf8'), /'cortejo\.html'/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers.some((rule) => /cortejo/.test(rule.source)));
});

test('las otras pantallas leen los papeles sin depender de ellos', () => {
  const guests = fs.readFileSync(path.join(root, 'invitados.html'), 'utf8');
  assert.match(guests, /async function loadRoleNames\(\)[\s\S]*catch\(e\) \{ roleNames = new Map\(\); \}/, 'si falla, las tarjetas se ven igual');
  assert.match(fs.readFileSync(path.join(root, 'mesas.html'), 'utf8'), /person\.roles \|\| \[\]/);
});

test('se pueden crear papeles desde el selector de cada persona y desde una tarjeta al final', () => {
  assert.match(html, /<option value="__new">[^<]*Crear papel nuevo/);
  assert.match(html, /data-new-role/);
  assert.match(html, /assignAfterCreate/, 'el papel creado desde el selector se asigna a esa persona');
});
