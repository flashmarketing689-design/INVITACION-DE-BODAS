const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
// Carpeta propia de este archivo de prueba: así no se pisa con otros que corren en paralelo.
process.env.WEDDING_DATA_DIR = require('fs').mkdtempSync(require('path').join(os.tmpdir(), 'boda-test-'));
process.on('exit', () => require('fs').rmSync(process.env.WEDDING_DATA_DIR, { recursive: true, force: true }));
process.env.ADMIN_PASSWORD = 'test-admin-pass';
const cortejoHandler = require('../api/cortejo');
const guestsHandler = require('../api/guests');
const tablesHandler = require('../api/tables');

const DATA_DIR = process.env.WEDDING_DATA_DIR;
let loginAttempt = 0;

const createRes = () => {
  const res = { headers: {} };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
};
const createReq = ({ method = 'GET', url = '/', body = null, headers = {} } = {}) =>
  ({ method, url, body, headers: { host: 'localhost:3000', ...headers } });

function reset() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ['guests.json', 'rsvp_respuestas_local.json', 'invitations_local.json', 'invitation_checkins_local.json']) {
    fs.writeFileSync(path.join(DATA_DIR, file), '[]', 'utf8');
  }
  fs.rmSync(path.join(DATA_DIR, 'roles_local.json'), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'tables_local.json'), { force: true });
}
async function login() {
  const res = createRes();
  await guestsHandler(createReq({ method: 'POST', url: '/api/guests?action=login',
    body: { password: 'test-admin-pass' }, headers: { 'x-forwarded-for': `roles-${++loginAttempt}` } }), res);
  return res.headers['Set-Cookie'].split(';')[0];
}
async function call(cookie, { method = 'GET', query = '', body } = {}) {
  const res = createRes();
  await cortejoHandler(createReq({ method, url: `/api/cortejo${query}`, body, headers: cookie ? { cookie } : {} }), res);
  return res;
}
async function addGuest(cookie, nombre, categoria = 'participantes', pertenece = 'novia', extra = {}) {
  const res = createRes();
  await guestsHandler(createReq({ method: 'POST', url: '/api/guests', body: { nombre, categoria, pertenece, ...extra }, headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  return res.body;
}
const role = (state, name) => state.roles.find((item) => item.name === name);

test('el cortejo requiere sesión de administrador', async () => {
  reset();
  assert.equal((await call(null)).statusCode, 401);
  assert.equal((await call(null, { method: 'POST', query: '?action=create', body: { name: 'X' } })).statusCode, 401);
  assert.equal((await call('boda_admin=falso')).statusCode, 401);
});

test('empieza con Novios y los seis papeles del cortejo; los novios ya tienen su papel', async () => {
  reset();
  const cookie = await login();
  const res = await call(cookie);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.roles.map((item) => item.name), ['Novios', 'Padres que participan', 'Padrinos', 'Chambelanes', 'Damas de honor', 'Niña del cartel', 'Portador(a) de los anillos']);
  assert.equal(res.body.summary.with_role, 2, 'Starlin y Reneisy');
  const novios = res.body.people.filter((p) => p.sin_invitacion);
  assert.deepEqual(novios.map((p) => [p.nombre, p.pertenece]), [['Starlin Paulino Pérez', 'novio'], ['Reneisy', 'novia']]);
  assert.deepEqual(role(res.body, 'Novios').guest_ids, novios.map((p) => p.id));
  assert.equal(res.body.summary.participants_without_role, 0, 'los novios no son participantes sin papel');
});

test('la misma niña puede llevar el cartel y los anillos', async () => {
  reset();
  const cookie = await login();
  const nina = await addGuest(cookie, 'Sofia Perez');
  const dama = await addGuest(cookie, 'Lucia Mena');
  let state = (await call(cookie)).body;
  const cartel = role(state, 'Niña del cartel').id, anillos = role(state, 'Portador(a) de los anillos').id, damas = role(state, 'Damas de honor').id;
  assert.equal((await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: cartel, guest_ids: [nina.id] } })).statusCode, 200);
  state = (await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: anillos, guest_ids: [nina.id] } })).body;
  state = (await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: damas, guest_ids: [dama.id] } })).body;
  const person = state.people.find((item) => item.id === nina.id);
  assert.deepEqual(person.role_ids, [cartel, anillos], 'en el orden de la lista de papeles');
  assert.deepEqual(role(state, 'Niña del cartel').guest_ids, [nina.id]);
  assert.deepEqual(role(state, 'Portador(a) de los anillos').guest_ids, [nina.id]);
  assert.equal(state.summary.with_role, 4, 'los dos novios más las dos personas');
  // Repetir no duplica; quitar un papel deja el otro.
  state = (await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: cartel, guest_ids: [nina.id] } })).body;
  assert.equal(role(state, 'Niña del cartel').guest_ids.length, 1);
  state = (await call(cookie, { method: 'POST', query: '?action=unassign', body: { role_id: cartel, guest_id: nina.id } })).body;
  assert.deepEqual(state.people.find((item) => item.id === nina.id).role_ids, [anillos]);
});

test('asignar a varios a la vez y avisar de los participantes sin papel', async () => {
  reset();
  const cookie = await login();
  const damas = [await addGuest(cookie, 'Dama Uno'), await addGuest(cookie, 'Dama Dos'), await addGuest(cookie, 'Dama Tres')];
  const sinPapel = await addGuest(cookie, 'Sin Papel', 'participantes');
  await addGuest(cookie, 'Un Amigo', 'amigos');
  let state = (await call(cookie)).body;
  assert.equal(state.summary.participants_without_role, 4);
  state = (await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: role(state, 'Damas de honor').id, guest_ids: damas.map((d) => d.id) } })).body;
  assert.equal(state.summary.participants_without_role, 1);
  assert.equal(state.people.find((p) => p.id === sinPapel.id).role_ids.length, 0);
});

test('el padre o la madre que participan muestran su parentesco', async () => {
  reset();
  const cookie = await login();
  const madre = await addGuest(cookie, 'Marta Novia', 'familiares', 'novia', { parentesco: 'madre' });
  let state = (await call(cookie)).body;
  state = (await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: role(state, 'Padres que participan').id, guest_ids: [madre.id] } })).body;
  const person = state.people.find((p) => p.id === madre.id);
  assert.equal(person.parentesco_label, 'Madre de la novia');
  assert.equal(person.categoria, 'familiares', 'tener un papel no cambia su categoría');
});

test('crear, renombrar, ordenar y eliminar papeles', async () => {
  reset();
  const cookie = await login();
  const nina = await addGuest(cookie, 'Sofia Perez');
  let res = await call(cookie, { method: 'POST', query: '?action=create', body: { name: ' Pajecitos ', description: 'Reparten pétalos.' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.roles.at(-1).name, 'Pajecitos');
  assert.equal((await call(cookie, { method: 'POST', query: '?action=create', body: { name: 'pajecitos' } })).statusCode, 409);
  assert.equal((await call(cookie, { method: 'POST', query: '?action=create', body: { name: '' } })).statusCode, 400);
  const paje = res.body.roles.at(-1).id;
  res = await call(cookie, { method: 'PATCH', body: { id: paje, name: 'Pajes y floristas' } });
  assert.equal(role(res.body, 'Pajes y floristas').id, paje);
  assert.equal((await call(cookie, { method: 'PATCH', body: { id: paje, name: 'Padrinos' } })).statusCode, 409);
  assert.equal((await call(cookie, { method: 'PATCH', body: { id: 9999, name: 'X' } })).statusCode, 404);
  // Ordenar: el nuevo primero
  const ids = res.body.roles.map((item) => item.id);
  res = await call(cookie, { method: 'POST', query: '?action=reorder', body: { role_ids: [paje, ...ids.filter((id) => id !== paje)] } });
  assert.equal(res.body.roles[0].id, paje);
  assert.equal((await call(cookie, { method: 'POST', query: '?action=reorder', body: { role_ids: [paje, paje] } })).statusCode, 400);
  // Eliminar un papel con gente: la persona sigue en la lista
  await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: paje, guest_ids: [nina.id] } });
  res = await call(cookie, { method: 'DELETE', body: { id: paje } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.roles.length, 7);
  assert.equal(res.body.people.some((p) => p.id === nina.id), true);
  assert.deepEqual(res.body.people.find((p) => p.id === nina.id).role_ids, []);
  assert.equal((await call(cookie, { method: 'DELETE', body: { id: paje } })).statusCode, 404);
});

test('entradas inválidas se rechazan con mensajes claros', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  const first = (await call(cookie)).body.roles[0].id;
  const bad = [
    { role_id: first, guest_ids: [] }, { role_id: first, guest_ids: [a.id, a.id] }, { role_id: first, guest_ids: ['x'] },
    { role_id: first, guest_ids: [999999] }, { role_id: 'x', guest_ids: [a.id] }, { role_id: 9999, guest_ids: [a.id] },
  ];
  for (const body of bad) {
    const res = await call(cookie, { method: 'POST', query: '?action=assign', body });
    assert.ok([400, 404].includes(res.statusCode), JSON.stringify(body));
    assert.ok(res.body.error);
  }
  assert.equal((await call(cookie, { method: 'POST', query: '?action=nope', body: {} })).statusCode, 400);
  assert.equal((await call(cookie, { method: 'PUT' })).statusCode, 405);
});

test('quien se elimina de la lista deja de aparecer en sus papeles', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  const b = await addGuest(cookie, 'Dos Test');
  const damas = role((await call(cookie)).body, 'Damas de honor').id;
  await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: damas, guest_ids: [a.id, b.id] } });
  const res = createRes();
  await guestsHandler(createReq({ method: 'DELETE', url: '/api/guests', body: { id: a.id }, headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  const state = (await call(cookie)).body;
  assert.deepEqual(role(state, 'Damas de honor').guest_ids, [b.id]);
  assert.equal(state.people.some((p) => p.id === a.id), false);
});

test('el papel de cada persona también aparece en la pantalla de mesas', async () => {
  reset();
  const cookie = await login();
  const nina = await addGuest(cookie, 'Sofia Perez');
  const otra = await addGuest(cookie, 'Sin Papel Alguno');
  const state = (await call(cookie)).body;
  await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: role(state, 'Portador(a) de los anillos').id, guest_ids: [nina.id] } });
  await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: role(state, 'Niña del cartel').id, guest_ids: [nina.id] } });
  const res = createRes();
  await tablesHandler(createReq({ method: 'GET', url: '/api/tables', headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.find((p) => p.id === nina.id).roles, ['Niña del cartel', 'Portador(a) de los anillos'], 'en el orden de la lista de papeles');
  assert.deepEqual(res.body.people.find((p) => p.id === otra.id).roles, []);
});

test('las mesas funcionan igual si el cortejo no está disponible', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  fs.writeFileSync(path.join(DATA_DIR, 'roles_local.json'), '{ esto no es JSON', 'utf8');
  const res = createRes();
  await tablesHandler(createReq({ method: 'GET', url: '/api/tables', headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.find((p) => p.id === a.id).roles, []);
});

test('agregar y quitar personas sin invitación, con papeles, sin tocar la lista de invitados', async () => {
  reset();
  const cookie = await login();
  let res = await call(cookie, { method: 'POST', query: '?action=add-member', body: { nombre: ' Padre  Oficiante ', pertenece: 'novio' } });
  assert.equal(res.statusCode, 200);
  const persona = res.body.people.find((p) => p.nombre === 'Padre Oficiante');
  assert.ok(persona.id < 0 && persona.sin_invitacion);
  res = await call(cookie, { method: 'POST', query: '?action=assign', body: { role_id: role(res.body, 'Padrinos').id, guest_ids: [persona.id] } });
  assert.deepEqual(role(res.body, 'Padrinos').guest_ids, [persona.id]);
  assert.equal(res.body.summary.without_invitation, 3);
  // No son invitados: no aparecen en la lista de invitados ni en las mesas.
  const guestsRes = createRes();
  await guestsHandler(createReq({ method: 'GET', url: '/api/guests', headers: { cookie } }), guestsRes);
  assert.equal(guestsRes.body.length, 0);
  const tablesRes = createRes();
  await tablesHandler(createReq({ method: 'GET', url: '/api/tables', headers: { cookie } }), tablesRes);
  assert.equal(tablesRes.body.people.length, 0);
  // Quitar un papel y la persona entera
  res = await call(cookie, { method: 'POST', query: '?action=unassign', body: { role_id: role(res.body, 'Padrinos').id, guest_id: persona.id } });
  assert.deepEqual(role(res.body, 'Padrinos').guest_ids, []);
  res = await call(cookie, { method: 'POST', query: '?action=remove-member', body: { id: -persona.id } });
  assert.equal(res.body.people.some((p) => p.nombre === 'Padre Oficiante'), false);
  assert.equal((await call(cookie, { method: 'POST', query: '?action=remove-member', body: { id: 999 } })).statusCode, 404);
  for (const body of [{ nombre: 'X', pertenece: 'novio' }, { nombre: 'Ana Perez', pertenece: 'otro' }, {}]) {
    assert.equal((await call(cookie, { method: 'POST', query: '?action=add-member', body })).statusCode, 400);
  }
  // Los novios del inicio se pueden quitar
  const inicial = (await call(cookie)).body.people.find((p) => p.nombre === 'Reneisy');
  res = await call(cookie, { method: 'POST', query: '?action=remove-member', body: { id: -inicial.id } });
  assert.equal(res.body.summary.without_invitation, 1);
});
