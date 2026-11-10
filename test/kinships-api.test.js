const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
// Carpeta propia de este archivo de prueba: así no se pisa con otros que corren en paralelo.
process.env.WEDDING_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'boda-test-'));
process.on('exit', () => fs.rmSync(process.env.WEDDING_DATA_DIR, { recursive: true, force: true }));
process.env.ADMIN_PASSWORD = 'test-admin-pass';
const kinshipsHandler = require('../api/kinships');
const guestsHandler = require('../api/guests');
const tablesHandler = require('../api/tables');
const cortejoHandler = require('../api/cortejo');

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
const send = async (handler, cookie, { method = 'GET', url, body } = {}) => {
  const res = createRes();
  await handler(createReq({ method, url, body, headers: cookie ? { cookie } : {} }), res);
  return res;
};

function reset() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ['guests.json', 'rsvp_respuestas_local.json', 'invitations_local.json', 'invitation_checkins_local.json']) fs.writeFileSync(path.join(DATA_DIR, file), '[]', 'utf8');
  for (const file of ['kinships_local.json', 'roles_local.json', 'tables_local.json']) fs.rmSync(path.join(DATA_DIR, file), { force: true });
}
async function login() {
  const res = await send(guestsHandler, null, { method: 'POST', url: '/api/guests?action=login', body: { password: 'test-admin-pass' } });
  void loginAttempt;
  return res.headers['Set-Cookie'].split(';')[0];
}
const kin = (cookie, method = 'GET', body) => send(kinshipsHandler, cookie, { method, url: '/api/kinships', body });
async function addGuest(cookie, nombre, extra = {}) {
  const res = await send(guestsHandler, cookie, { method: 'POST', url: '/api/guests', body: { nombre, categoria: 'familiares', pertenece: 'novia', ...extra } });
  return res;
}

test('los parentescos requieren sesión de administrador', async () => {
  reset();
  assert.equal((await kin(null)).statusCode, 401);
  assert.equal((await kin(null, 'POST', { name: 'X' })).statusCode, 401);
});

test('empieza con madre, padre y hermano(a), sin uso', async () => {
  reset();
  const res = await kin(await login());
  assert.deepEqual(res.body.kinships.map((k) => [k.key, k.name, k.count]), [['madre', 'Madre', 0], ['padre', 'Padre', 0], ['hermano', 'Hermano(a)', 0]]);
});

test('añadir un parentesco propio y usarlo en un invitado, en mesas y en el cortejo', async () => {
  reset();
  const cookie = await login();
  let res = await kin(cookie, 'POST', { name: ' Abuelo(a) ' });
  assert.equal(res.statusCode, 200);
  const abuelo = res.body.kinships.find((k) => k.name === 'Abuelo(a)');
  assert.equal(abuelo.key, 'abuelo_a');
  const guest = await addGuest(cookie, 'Abuela Delgado', { parentesco: 'abuelo_a' });
  assert.equal(guest.statusCode, 200);
  assert.deepEqual([guest.body.parentesco, guest.body.cercana], ['abuelo_a', true]);
  assert.equal((await kin(cookie)).body.kinships.find((k) => k.key === 'abuelo_a').count, 1);
  const tables = await send(tablesHandler, cookie, { url: '/api/tables' });
  assert.equal(tables.body.people[0].parentesco_label, 'Abuelo(a) de la novia');
  assert.equal(tables.body.people[0].section_key, 'familia_cercana|novia');
  const cortejo = await send(cortejoHandler, cookie, { url: '/api/cortejo' });
  assert.equal(cortejo.body.people.find((p) => p.nombre === 'Abuela Delgado').parentesco_label, 'Abuelo(a) de la novia');
});

test('un parentesco que no existe se rechaza al guardar un invitado', async () => {
  reset();
  const cookie = await login();
  const res = await addGuest(cookie, 'Tio Falso', { parentesco: 'tio' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /parentesco/i);
  const ok = await addGuest(cookie, 'Tio Cercano', { cercana: true });
  const put = await send(guestsHandler, cookie, { method: 'PUT', url: '/api/guests', body: { id: ok.body.id, nombre: 'Tio Cercano', categoria: 'familiares', pertenece: 'novia', cantidad_personas: 1, parentesco: 'tio' } });
  assert.equal(put.statusCode, 400);
});

test('renombrar cambia la etiqueta de quienes lo tienen; nombres repetidos se rechazan', async () => {
  reset();
  const cookie = await login();
  await addGuest(cookie, 'Marta Delgado', { parentesco: 'madre' });
  let res = await kin(cookie, 'PATCH', { key: 'madre', name: 'Mamá' });
  assert.equal(res.body.kinships[0].name, 'Mamá');
  assert.equal((await send(tablesHandler, cookie, { url: '/api/tables' })).body.people[0].parentesco_label, 'Mamá de la novia');
  assert.equal((await kin(cookie, 'PATCH', { key: 'padre', name: 'mamá' })).statusCode, 409);
  assert.equal((await kin(cookie, 'PATCH', { key: 'nada', name: 'X' })).statusCode, 404);
  assert.equal((await kin(cookie, 'PATCH', { key: 'padre', name: '' })).statusCode, 400);
  assert.equal((await kin(cookie, 'POST', { name: 'PADRE' })).statusCode, 409);
  res = await kin(cookie, 'POST', { name: 'x'.repeat(41) });
  assert.equal(res.statusCode, 400);
});

test('quitar un parentesco deja a quienes lo tenían como familia cercana sin parentesco', async () => {
  reset();
  const cookie = await login();
  const madre = await addGuest(cookie, 'Marta Delgado', { parentesco: 'madre' });
  const res = await kin(cookie, 'DELETE', { key: 'madre' });
  assert.deepEqual(res.body.kinships.map((k) => k.key), ['padre', 'hermano']);
  const guests = await send(guestsHandler, cookie, { url: '/api/guests' });
  const row = guests.body.find((g) => g.id === madre.body.id);
  assert.deepEqual([row.parentesco, row.cercana], [null, true]);
  assert.equal((await kin(cookie, 'DELETE', { key: 'madre' })).statusCode, 404);
  assert.equal((await addGuest(cookie, 'Otra Madre', { parentesco: 'madre' })).statusCode, 400, 'ya no existe');
});
