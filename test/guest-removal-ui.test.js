const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const removal = require('../guest-removal');

test('eliminar informa sobre cupo, historial, grupo y reenvío del pase', () => {
  const text = removal.confirmation({nombre:'Persona Prueba'});
  assert.match(text,/Persona Prueba/);
  for (const word of ['cupo','grupo','confirmado','historial','QR','compartir']) assert.ok(text.includes(word));
  assert.match(removal.resultMessage({link_changed:true}),/Comparte el nuevo enlace/);
  assert.match(removal.resultMessage({link_changed:false}),/desactivada/);
  assert.match(removal.resultMessage({already_archived:true}),/ya estaba/);
});

test('la eliminación está disponible en las tres vistas y sus scripts son válidos', () => {
  const root=path.join(__dirname,'..');
  for(const page of ['admin.html','invitados.html','invitaciones.html']){
    const html=fs.readFileSync(path.join(root,page),'utf8');
    assert.match(html,/<script src="\/guest-removal\.js\?v=1"><\/script>/);
    assert.match(html,/GuestRemoval\.confirmation/);
    assert.match(html,/GuestRemoval\.announce/);
    assert.match(html,/GuestRemoval\.eventKey/);
    for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
  }
});
