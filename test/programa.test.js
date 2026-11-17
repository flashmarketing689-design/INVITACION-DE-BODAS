const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('la invitación incluye el programa del día en orden', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const section = html.match(/<section id="programa"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, 'falta la sección del programa');
  const names = [...section.matchAll(/class="tl-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(names, ['Bienvenida', 'Ceremonia', 'Recepción', 'Primer baile', 'Entrada de las damas', 'Brindis',
    'Fotos', 'Juegos', 'Buffet', 'Palabras de los esposos', 'Tiro de ramo', 'Hora loca']);
  const starts = [...section.matchAll(/class="tl-time">(\d+:\d+)</g)].map((m) => m[1]);
  assert.deepEqual(starts, ['3:00', '4:00', '4:15', '4:35', '4:45', '4:50', '5:50', '6:30', '7:30', '7:35', '7:40']);
  assert.ok(html.indexOf('id="evento"') < html.indexOf('id="programa"') && html.indexOf('id="programa"') < html.indexOf('id="ubicacion"'));
});
