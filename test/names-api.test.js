const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Carpeta propia de este archivo de prueba: así no se pisa con otros que corren en paralelo.
process.env.WEDDING_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'boda-test-'));
process.on('exit', () => fs.rmSync(process.env.WEDDING_DATA_DIR, { recursive: true, force: true }));
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.RECEPTION_PASS_KEY = 'clave-recepcion-de-prueba-123';
const guestsHandler = require('../api/guests');
const invitationsHandler = require('../api/invitations');
const checkinHandler = require('../api/checkin');
const cortejoHandler = require('../api/cortejo');

const DATA_DIR = process.env.WEDDING_DATA_DIR;
const createRes = () => {
  const res = { headers: {} };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
};
const send = async (handler, cookie, { method = 'GET', url, body, ip } = {}) => {
  const res = createRes();
  await handler({ method, url, body, headers: { host: 'localhost:3000', ...(cookie ? { cookie } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}) } }, res);
  return res;
};
function reset() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ['guests.json', 'rsvp_respuestas_local.json', 'invitations_local.json', 'invitation_checkins_local.json']) fs.writeFileSync(path.join(DATA_DIR, file), '[]', 'utf8');
  for (const file of ['roles_local.json', 'tables_local.json', 'kinships_local.json']) fs.rmSync(path.join(DATA_DIR, file), { force: true });
}
const login = async () => (await send(guestsHandler, null, { method: 'POST', url: '/api/guests?action=login', body: { password: 'test-admin-pass' } })).headers['Set-Cookie'].split(';')[0];
const add = (cookie, nombre, extra = {}) => send(guestsHandler, cookie, { method: 'POST', url: '/api/guests', body: { nombre, categoria: 'amigos', pertenece: 'novia', ...extra } });

test('al crear y editar un invitado el nombre queda con mayúscula inicial', async () => {
  reset();
  const cookie = await login();
  const created = await add(cookie, '  maría   PÉREZ  de la cruz ');
  assert.equal(created.body.nombre, 'María Pérez de la Cruz');
  const put = await send(guestsHandler, cookie, { method: 'PUT', url: '/api/guests', body: { id: created.body.id, nombre: 'juan gómez', categoria: 'amigos', pertenece: 'novio', cantidad_personas: 1 } });
  assert.equal(put.body.nombre, 'Juan Gómez');
  const renamed = await send(guestsHandler, cookie, { method: 'PATCH', url: '/api/guests', body: { action: 'renombrar', guest_id: created.body.id, nombre: 'ROSA  de los ángeles' } });
  assert.equal(renamed.body.nombre, 'Rosa de los Ángeles');
  const list = await send(guestsHandler, cookie, { url: '/api/guests' });
  assert.equal(list.body[0].invitation_name, 'Rosa de los Ángeles', 'el nombre de su invitación individual también');
});

test('un nombre de una sola palabra se sigue rechazando y el resultado cuenta las palabras ya normalizadas', async () => {
  reset();
  const cookie = await login();
  assert.equal((await add(cookie, '   juan   ')).statusCode, 400);
  assert.equal((await add(cookie, 'juan perez')).statusCode, 200);
});

test('el nombre visible de una invitación y las personas nuevas también se corrigen', async () => {
  reset();
  const cookie = await login();
  const a = (await add(cookie, 'uno test')).body, b = (await add(cookie, 'DOS TEST')).body;
  const group = await send(invitationsHandler, cookie, { method: 'POST', url: '/api/invitations', body: { guest_ids: [a.id, b.id], group_type: 'couple', display_name: 'familia   pérez GÓMEZ' } });
  assert.equal(group.statusCode, 201);
  assert.equal(group.body.display_name, 'Familia Pérez Gómez');
  const added = await send(invitationsHandler, cookie, { method: 'POST', url: '/api/invitations?action=add-members',
    body: { invitation_id: group.body.id, new_members: [{ nombre: 'rené  ruiz', pertenece: 'novia', categoria: 'amigos' }] } });
  assert.equal(added.statusCode, 200);
  const guests = await send(guestsHandler, cookie, { url: '/api/guests' });
  assert.ok(guests.body.some((g) => g.nombre === 'René Ruiz'));
});

test('el operador de recepción y las personas del cortejo sin invitación también', async () => {
  reset();
  const login1 = await send(checkinHandler, null, { method: 'POST', url: '/api/checkin?action=login', ip: 'names-1', body: { operator: 'maría  GÓMEZ', password: process.env.RECEPTION_PASS_KEY } });
  assert.equal(login1.statusCode, 200);
  assert.equal(login1.body.operator, 'María Gómez');
  const cookie = await login();
  const res = await send(cortejoHandler, cookie, { method: 'POST', url: '/api/cortejo?action=add-member', body: { nombre: 'padre juan PÉREZ', pertenece: 'novio' } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.people.some((p) => p.nombre === 'Padre Juan Pérez'));
});
