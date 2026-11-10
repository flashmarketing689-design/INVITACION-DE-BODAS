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
async function addGuest(cookie, nombre, categoria = 'familiares', pertenece = 'novia') {
  const res = createRes();
  await guestsHandler(createReq({ method: 'POST', url: '/api/guests', body: { nombre, categoria, pertenece }, headers: { cookie } }), res);
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

test('muestra 12 mesas de 10 lugares con las dos primeras principales', async () => {
  reset();
  const cookie = await login();
  const res = await call(cookie);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tables.length, 12);
  assert.ok(res.body.tables.every((table) => table.capacity === 10));
  assert.equal(res.body.summary.capacity, 120);
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

test('la organización automática junta grupos y lleva a los familiares a las mesas principales', async () => {
  reset();
  const cookie = await login();
  const fam = [await addGuest(cookie, 'Rosa Diaz'), await addGuest(cookie, 'Juan Diaz'), await addGuest(cookie, 'Eva Diaz')];
  await group(cookie, fam.map((p) => p.id), 'Familia Diaz');
  const pareja = [await addGuest(cookie, 'Ana Lopez', 'amigos'), await addGuest(cookie, 'Beto Lopez', 'amigos')];
  await group(cookie, pareja.map((p) => p.id), 'Ana y Beto');
  const solo = await addGuest(cookie, 'Carlos Mena', 'companeros', 'novio');
  const res = await call(cookie, { method: 'POST', query: '?action=auto' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.placed, 6);
  const famTables = new Set(fam.map((p) => tableOf(res.body, p.id)));
  assert.equal(famTables.size, 1);
  assert.ok([1, 2].includes([...famTables][0]), 'familia en mesa principal');
  assert.equal(new Set(pareja.map((p) => tableOf(res.body, p.id))).size, 1);
  assert.ok(tableOf(res.body, pareja[0].id) > 2, 'amigos fuera de las principales');
  assert.ok(tableOf(res.body, solo.id) > 2);
  assert.equal(res.body.summary.unseated, 0);
  // Repetir no mueve a nadie.
  const again = await call(cookie, { method: 'POST', query: '?action=auto' });
  assert.equal(again.body.result.placed, 0);
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
  res = await call(cookie, { method: 'PATCH', body: { id: 5, name: ' Mesa   de honor ', is_main: true, capacity: 8 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.tables[4].name, res.body.tables[4].is_main, res.body.tables[4].capacity], ['Mesa de honor', true, 8]);
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
