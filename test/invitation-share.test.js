const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharing = require('../invitation-share');

const token = '2a40a362-bc48-4e72-aa80-94592cf51962';
const link = `https://boda.invifty.com/?guest=${token}&v=2`;
const expected = `Hola 👋

Nos gustaría confirmar tu asistencia a nuestra boda. 💍

Por favor, ingresa al siguiente enlace y completa tu confirmación.

Una vez confirmes tu asistencia, el sistema generará un código QR personal que deberás presentar como entrada el día del evento.

Haz clic aquí para confirmar 👇
${link}`;

test('compartir conserva el texto exacto, emojis, saltos de línea y token', () => {
  assert.equal(sharing.invitationUrl(token, 'https://boda.invifty.com'), link);
  assert.equal(sharing.message(link), expected);
  const url = new URL(link);
  assert.equal(url.searchParams.get('guest'), token);
  assert.equal(url.searchParams.get('v'), '2');
  assert.equal(new URL(sharing.invitationUrl('token&extra=1', 'http://localhost:3001')).searchParams.get('guest'), 'token&extra=1');
});

test('WhatsApp lleva el mensaje completo con o sin teléfono', () => {
  for (const phone of ['+1 (809) 555-1234', '', undefined]) {
    const url = new URL(sharing.whatsappUrl(link, phone));
    assert.equal(url.origin, 'https://wa.me');
    assert.equal(url.pathname, phone ? '/18095551234' : '/');
    assert.equal(url.searchParams.get('text'), expected);
  }
});

test('el mismo módulo funciona en el navegador y se carga en ambos paneles', () => {
  const root = path.join(__dirname, '..');
  const context = { window: {}, URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'invitation-share.js'), 'utf8'), context);
  assert.equal(context.window.InvitationShare.message(link), expected);
  for (const page of ['invitados.html', 'invitaciones.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /<script src="\/invitation-share\.js\?v=1"><\/script>/);
    assert.match(html, /InvitationShare\.invitationUrl/);
    assert.match(html, /InvitationShare\.whatsappUrl/);
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  }
});

test('la vista previa usa la foto original con formato, tamaño y dominio correctos', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const meta = (name) => html.match(new RegExp(`<meta (?:property|name)="${name}"\\s+content="([^"]+)"`))?.[1];
  const image = fs.readFileSync(path.join(root, 'foto-pareja-social.png'));
  assert.deepEqual(image, fs.readFileSync(path.join(root, 'foto-pareja.jpg')));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(meta('og:image'), 'https://boda.invifty.com/foto-pareja-social.png');
  assert.equal(meta('og:image:secure_url'), meta('og:image'));
  assert.equal(meta('twitter:image'), meta('og:image'));
  assert.equal(meta('og:image:type'), 'image/png');
  assert.equal(Number(meta('og:image:width')), image.readUInt32BE(16));
  assert.equal(Number(meta('og:image:height')), image.readUInt32BE(20));
  assert.equal(meta('og:url'), 'https://boda.invifty.com/');
  assert.ok(html.indexOf('property="og:image"') < html.indexOf('</head>'));
  assert.doesNotMatch(html, /invitacion-de-bodas-one\.vercel\.app/);
});
