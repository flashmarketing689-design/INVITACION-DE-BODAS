const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_PASSWORD = 'test-admin-pass';
const tablesHandler = require('../api/tables');
const guestsHandler = require('../api/guests');
const invitationsHandler = require('../api/invitations');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
  fs.rmSync(path.join(DATA_DIR, 'tables_local.json'), { force: true });
}

async function login() {
  const res = createRes();
  await guestsHandler(createReq({ method: 'POST', url: '/api/guests?action=login',
    body: { password: 'test-admin-pass' }, headers: { 'x-forwarded-for': `tables-${++loginAttempt}` } }), res);
  return res.headers['Set-Cookie'].split(';')[0];
}
async function call(cookie, { method = 'GET', query = '', body } = {}) {
  const res = createRes();
  await tablesHandler(createReq({ method, url: `/api/tables${query}`, body, headers: cookie ? { cookie } : {} }), res);
  return res;
}
async function addGuest(cookie, nombre, categoria = 'familiares', pertenece = 'novia', cercana = false, parentesco) {
  const res = createRes();
  await guestsHandler(createReq({ method: 'POST', url: '/api/guests', body: { nombre, categoria, pertenece, cercana, parentesco }, headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  return res.body;
}
async function group(cookie, ids, display_name) {
  const res = createRes();
  await invitationsHandler(createReq({ method: 'POST', url: '/api/invitations',
    body: { guest_ids: ids, group_type: ids.length === 2 ? 'couple' : 'family', display_name }, headers: { cookie } }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
}
const tableOf = (state, id) => state.people.find((person) => person.id === id).table_id;

test('las mesas requieren sesión de administrador', async () => {
  reset();
  assert.equal((await call(null)).statusCode, 401);
  assert.equal((await call(null, { method: 'POST', query: '?action=auto' })).statusCode, 401);
  const forged = await call('boda_admin=falso');
  assert.equal(forged.statusCode, 401);
});

test('muestra 12 mesas de 10 lugares, cada una con su sección', async () => {
  reset();
  const cookie = await login();
  const res = await call(cookie);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tables.length, 12);
  assert.ok(res.body.tables.every((table) => table.capacity === 10));
  assert.equal(res.body.summary.capacity, 120);
  assert.deepEqual(res.body.tables.map((table) => table.label), [
    'Familia cercana de la novia', 'Familia cercana del novio', 'Familiares de la novia', 'Familiares de la novia',
    'Familiares del novio', 'Familiares del novio', 'Participantes de la boda', 'Iglesia', 'Iglesia',
    'Amigos de la novia', 'Amigos', 'Amigos']);
});

test('mover un invitado a una mesa, a otra y de regreso a "sin mesa"', async () => {
  reset();
  const cookie = await login();
  const ana = await addGuest(cookie, 'Ana Perez');
  let res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [ana.id], table_id: 5 } });
  assert.equal(res.statusCode, 200);
  assert.equal(tableOf(res.body, ana.id), 5);
  assert.equal(res.body.tables[4].seated, 1);
  res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [ana.id], table_id: 7 } });
  assert.equal(tableOf(res.body, ana.id), 7);
  assert.equal(res.body.tables[4].seated, 0);
  res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [ana.id], table_id: null } });
  assert.equal(tableOf(res.body, ana.id), null);
});

test('una mesa llena rechaza más personas y no mueve a nadie a medias', async () => {
  reset();
  const cookie = await login();
  const people = [];
  for (let i = 1; i <= 11; i += 1) people.push(await addGuest(cookie, `Persona Numero${i}`));
  const ids = people.map((person) => person.id);
  assert.equal((await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: ids.slice(0, 10), table_id: 3 } })).statusCode, 200);
  const full = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [ids[10]], table_id: 3 } });
  assert.equal(full.statusCode, 409);
  assert.equal(full.body.code, 'TABLE_FULL');
  assert.match(full.body.error, /Mesa 3 solo tiene 0 lugares libres/);
  const state = await call(cookie);
  assert.equal(state.body.tables[2].seated, 10);
  assert.equal(tableOf(state.body, ids[10]), null);
});

test('mover con su grupo lleva a toda la pareja o familia y respeta la capacidad', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Luis Gomez');
  const b = await addGuest(cookie, 'Marta Gomez');
  const c = await addGuest(cookie, 'Pedro Gomez');
  await group(cookie, [a.id, b.id, c.id], 'Familia Gomez');
  let res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [b.id], table_id: 2, with_group: true } });
  assert.equal(res.statusCode, 200);
  for (const person of [a, b, c]) assert.equal(tableOf(res.body, person.id), 2);
  // Solo uno, sin el grupo.
  res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [c.id], table_id: 9 } });
  assert.equal(tableOf(res.body, c.id), 9);
  assert.equal(tableOf(res.body, a.id), 2);
  // Con el grupo y una mesa casi llena: no entra y no cambia nada.
  const fillers = [];
  for (let i = 1; i <= 9; i += 1) fillers.push((await addGuest(cookie, `Relleno Numero${i}`)).id);
  await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: fillers, table_id: 11 } });
  res = await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [a.id], table_id: 11, with_group: true } });
  assert.equal(res.statusCode, 409);
  assert.equal(tableOf((await call(cookie)).body, a.id), 2);
});

test('la organización automática sienta a cada grupo completo en la mesa de su sección', async () => {
  reset();
  const cookie = await login();
  const close = [await addGuest(cookie, 'Rosa Diaz', 'familiares', 'novia', true), await addGuest(cookie, 'Juan Diaz', 'familiares', 'novia', true)];
  await group(cookie, close.map((p) => p.id), 'Padres de la novia');
  const tios = [await addGuest(cookie, 'Eva Mena', 'familiares', 'novio'), await addGuest(cookie, 'Leo Mena', 'familiares', 'novio'), await addGuest(cookie, 'Ivan Mena', 'familiares', 'novio')];
  await group(cookie, tios.map((p) => p.id), 'Familia Mena');
  const pareja = [await addGuest(cookie, 'Ana Lopez', 'amigos', 'novia'), await addGuest(cookie, 'Beto Lopez', 'amigos', 'novia')];
  await group(cookie, pareja.map((p) => p.id), 'Ana y Beto');
  const iglesia = await addGuest(cookie, 'Carlos Mena', 'iglesia', 'novio');
  const participante = await addGuest(cookie, 'Sofia Paz', 'participantes', 'novia');
  const res = await call(cookie, { method: 'POST', query: '?action=auto' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.placed, 9);
  assert.deepEqual(close.map((p) => tableOf(res.body, p.id)), [1, 1], 'familia cercana de la novia: mesa 1');
  assert.deepEqual(tios.map((p) => tableOf(res.body, p.id)), [5, 5, 5], 'familiares del novio: mesa 5');
  assert.deepEqual(pareja.map((p) => tableOf(res.body, p.id)), [10, 10], 'amigos de la novia: mesa 10');
  assert.equal(tableOf(res.body, iglesia.id), 8);
  assert.equal(tableOf(res.body, participante.id), 7);
  assert.equal(res.body.summary.unseated, 0);
  assert.equal(res.body.people.find((p) => p.id === close[0].id).cercana, true);
  const sectionOf = (guest) => res.body.people.find((p) => p.id === guest.id).section_label;
  assert.equal(sectionOf(close[0]), 'Familia cercana de la novia');
  assert.equal(sectionOf(tios[0]), 'Familiares del novio');
  assert.equal(sectionOf(pareja[0]), 'Amigos de la novia');
  assert.equal(sectionOf(iglesia), 'Iglesia');
  // Repetir no mueve a nadie.
  assert.equal((await call(cookie, { method: 'POST', query: '?action=auto' })).body.result.placed, 0);
});

test('la marca de familia cercana solo vale para familiares', async () => {
  reset();
  const cookie = await login();
  const amigo = await addGuest(cookie, 'Pedro Gil', 'amigos', 'novio', true);
  assert.equal(amigo.cercana, false);
  const familiar = await addGuest(cookie, 'Tio Gil', 'familiares', 'novio', true);
  assert.equal(familiar.cercana, true);
  const res = createRes();
  await guestsHandler(createReq({ method: 'PUT', url: '/api/guests', headers: { cookie },
    body: { id: familiar.id, nombre: 'Tio Gil', categoria: 'amigos', pertenece: 'novio', cercana: true, cantidad_personas: 1 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cercana, false, 'al dejar de ser familiar deja de ser cercano');
});

test('vaciar una mesa o todas, y editar nombre, tipo y capacidad', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  const b = await addGuest(cookie, 'Dos Test');
  await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [a.id], table_id: 4 } });
  await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [b.id], table_id: 5 } });
  let res = await call(cookie, { method: 'POST', query: '?action=reset', body: { table_id: 4 } });
  assert.equal(tableOf(res.body, a.id), null);
  assert.equal(tableOf(res.body, b.id), 5);
  res = await call(cookie, { method: 'PATCH', body: { id: 5, name: ' Mesa   de honor ', category: 'iglesia', side: null, capacity: 8 } });
  assert.equal(res.statusCode, 200);
  const edited = res.body.tables[4];
  assert.deepEqual([edited.name, edited.category, edited.side, edited.is_main, edited.capacity, edited.label], ['Mesa de honor', 'iglesia', null, false, 8, 'Iglesia']);
  res = await call(cookie, { method: 'PATCH', body: { id: 5, category: 'familia_cercana', side: 'novio' } });
  assert.deepEqual([res.body.tables[4].label, res.body.tables[4].is_main], ['Familia cercana del novio', true]);
  assert.equal((await call(cookie, { method: 'PATCH', body: { id: 5, category: 'vip' } })).statusCode, 400);
  res = await call(cookie, { method: 'PATCH', body: { id: 5, capacity: 0 } });
  assert.equal(res.statusCode, 400);
  await call(cookie, { method: 'PATCH', body: { id: 5, capacity: 1 } });
  assert.equal((await call(cookie, { method: 'PATCH', body: { id: 5, capacity: 1 } })).statusCode, 200);
  res = await call(cookie, { method: 'POST', query: '?action=reset', body: {} });
  assert.equal(res.body.summary.seated, 0);
});

test('entradas inválidas se rechazan con mensajes claros', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  const bad = [
    { guest_ids: [], table_id: 1 }, { guest_ids: [a.id, a.id], table_id: 1 }, { guest_ids: ['x'], table_id: 1 },
    { guest_ids: [a.id], table_id: 99 }, { guest_ids: [a.id], table_id: -1 }, { guest_ids: [999999], table_id: 1 },
  ];
  for (const body of bad) {
    const res = await call(cookie, { method: 'POST', query: '?action=move', body });
    assert.ok([400, 404].includes(res.statusCode), JSON.stringify(body));
    assert.ok(res.body.error);
  }
  assert.equal((await call(cookie, { method: 'POST', query: '?action=nope', body: {} })).statusCode, 400);
  assert.equal((await call(cookie, { method: 'DELETE' })).statusCode, 405);
});

test('quien se elimina de la lista libera su lugar en la mesa', async () => {
  reset();
  const cookie = await login();
  const a = await addGuest(cookie, 'Uno Test');
  const b = await addGuest(cookie, 'Dos Test');
  await call(cookie, { method: 'POST', query: '?action=move', body: { guest_ids: [a.id, b.id], table_id: 6 } });
  const res = createRes();
  await guestsHandler(createReq({ method: 'DELETE', url: '/api/guests', body: { id: a.id }, headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
  const state = (await call(cookie)).body;
  assert.equal(state.tables[5].seated, 1);
  assert.equal(state.people.some((person) => person.id === a.id), false);
});

test('madre, padre y hermanos: se guardan, implican familia cercana y se sientan en su mesa', async () => {
  reset();
  const cookie = await login();
  const madre = await addGuest(cookie, 'Marta Novia', 'familiares', 'novia', false, 'madre');
  assert.deepEqual([madre.parentesco, madre.cercana], ['madre', true], 'el parentesco implica familia cercana');
  const padre = await addGuest(cookie, 'Pedro Novio', 'familiares', 'novio', false, 'padre');
  const hermana = await addGuest(cookie, 'Hilda Novia', 'familiares', 'novia', false, 'hermano');
  const invalido = await addGuest(cookie, 'Falso Parentesco', 'familiares', 'novia', false, 'tio');
  assert.deepEqual([invalido.parentesco, invalido.cercana], [null, false]);
  const amigo = await addGuest(cookie, 'Amigo Falso', 'amigos', 'novia', false, 'madre');
  assert.deepEqual([amigo.parentesco, amigo.cercana], [null, false], 'solo los familiares tienen parentesco');
  await group(cookie, [madre.id, hermana.id], 'Familia de la novia');
  const res = await call(cookie, { method: 'POST', query: '?action=auto' });
  assert.equal(res.statusCode, 200);
  const person = (guest) => res.body.people.find((p) => p.id === guest.id);
  assert.equal(person(madre).parentesco_label, 'Madre de la novia');
  assert.equal(person(padre).parentesco_label, 'Padre del novio');
  assert.equal(person(hermana).parentesco_label, 'Hermano(a) de la novia');
  assert.deepEqual([person(madre).table_id, person(hermana).table_id], [1, 1], 'madre y hermana de la novia: Mesa 1');
  assert.equal(person(padre).table_id, 2, 'padre del novio: Mesa 2');
  assert.equal(person(invalido).section_label, 'Familiares de la novia');

  // Cambiar el parentesco y quitarlo
  const put = (body) => { const r = createRes(); return guestsHandler(createReq({ method: 'PUT', url: '/api/guests', headers: { cookie }, body: { id: madre.id, nombre: 'Marta Novia', pertenece: 'novia', cantidad_personas: 1, ...body } }), r).then(() => r); };
  let r = await put({ categoria: 'familiares', parentesco: 'padre' });
  assert.equal(r.body.parentesco, 'padre');
  r = await put({ categoria: 'familiares', parentesco: '', cercana: true });
  assert.deepEqual([r.body.parentesco, r.body.cercana], [null, true], 'sin parentesco puede seguir siendo familia cercana');
  r = await put({ categoria: 'familiares', parentesco: 'madre' });
  r = await put({ categoria: 'amigos', parentesco: 'madre', cercana: true });
  assert.deepEqual([r.body.parentesco, r.body.cercana], [null, false], 'al dejar de ser familiar se limpia el parentesco');
});
