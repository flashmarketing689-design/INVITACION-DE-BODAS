const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_PASSWORD = 'test-admin-pass';

const rsvpsHandler = require('../api/rsvps');
const guestsHandler = require('../api/guests');
const guestHandler = require('../api/guest');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
const LOCAL_RSVPS = path.join(DATA_DIR, 'rsvp_respuestas_local.json');

function createRes() {
  const res = {};
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

function createReq({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
  return {
    method,
    url,
    body,
    headers: { host: 'localhost:3000', ...headers },
  };
}

function resetData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GUESTS_FILE, '[]', 'utf8');
  fs.writeFileSync(LOCAL_RSVPS, '[]', 'utf8');
}

async function loginAdmin() {
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests?action=login',
    body: { password: 'test-admin-pass' },
  }), res);
  assert.equal(res.statusCode, 200);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  return cookie;
}

async function createGuest(cookie, overrides = {}) {
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests',
    body: {
      nombre: 'Ana Pérez',
      pertenece: 'novia',
      categoria: 'familiares',
      cantidad_personas: 2,
      telefono: '+18090000000',
      ...overrides,
    },
    headers: { cookie },
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function confirm(token, asistencia, mensaje) {
  const res = createRes();
  await rsvpsHandler(createReq({
    method: 'POST',
    url: '/api/rsvps',
    body: { token, asistencia, mensaje },
  }), res);
  return res;
}

/* ══════════ Autenticación admin ══════════ */

test('guests API rechaza CRUD sin sesión admin', async () => {
  resetData();
  const res = createRes();
  await guestsHandler(createReq({ method: 'GET', url: '/api/guests' }), res);
  assert.equal(res.statusCode, 401);
});

test('login rechaza contraseña incorrecta', async () => {
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests?action=login',
    body: { password: 'wrong' },
  }), res);
  assert.equal(res.statusCode, 401);
});

test('API administrativas rechazan orígenes cross-site', async () => {
  resetData();
  const res = createRes();
  await guestsHandler(createReq({
    method: 'GET',
    url: '/api/guests',
    headers: { origin: 'https://attacker.example' },
  }), res);
  assert.equal(res.statusCode, 403);
});

test('producción falla de forma segura si Supabase no está configurado', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = createRes();
    await guestHandler(createReq({ method: 'GET', url: '/api/guest?token=not-a-token' }), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Servicio no disponible' });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('la cookie de administración es Secure detrás de HTTPS', async () => {
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests?action=login',
    body: { password: 'test-admin-pass' },
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.42' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /; Secure(?:;|$)/);
  assert.match(res.headers['Set-Cookie'], /HttpOnly/);
});

/* ══════════ Tokens ══════════ */

test('crear invitado genera token UUID único', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g1 = await createGuest(cookie, { nombre: 'Ana Pérez' });
  const g2 = await createGuest(cookie, { nombre: 'Luis Cruz' });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(g1.token, uuid);
  assert.match(g2.token, uuid);
  assert.notEqual(g1.token, g2.token);
  assert.ok(!g1.token.toLowerCase().includes('ana'), 'el token no contiene el nombre');
});

test('regenerar token invalida el anterior', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);
  const oldToken = g.token;

  const res = createRes();
  await guestsHandler(createReq({
    method: 'PATCH',
    url: '/api/guests',
    body: { action: 'regenerar_token', guest_id: g.id },
    headers: { cookie },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.token, oldToken);

  const guestRes = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${oldToken}` }), guestRes);
  assert.deepEqual(guestRes.body, { found: false }, 'el token antiguo ya no identifica al invitado');

  const guestRes2 = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${res.body.token}` }), guestRes2);
  assert.equal(guestRes2.body.found, true);
});

/* ══════════ API pública por token ══════════ */

test('token inválido responde found:false sin revelar información', async () => {
  const res = createRes();
  await guestHandler(createReq({ method: 'GET', url: '/api/guest?token=not-a-token' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { found: false });
});

test('migración legacy es idempotente si el navegador reintenta el mismo lote', async () => {
  resetData();
  const cookie = await loginAdmin();
  const batchId = '123e4567-e89b-42d3-a456-426614174000';
  const first = createRes();
  await guestsHandler(createReq({
    method: 'POST', url: '/api/guests?import=1',
    body: { batch_id: batchId, guests: [{ id: 'old-1', nombre: 'Ana Pérez', cantidad: 2, enviada: false }] },
    headers: { cookie },
  }), first);
  const retry = createRes();
  await guestsHandler(createReq({
    method: 'POST', url: '/api/guests?import=1',
    body: { batch_id: batchId, guests: [{ id: 'old-1', nombre: 'Ana Pérez', cantidad: 2, enviada: false }] },
    headers: { cookie },
  }), retry);

  assert.equal(first.statusCode, 200);
  assert.equal(first.body.imported, 1);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8')).length, 1);
});

test('un lote legacy no puede reutilizar su idempotency key con otro contenido', async () => {
  resetData();
  const cookie = await loginAdmin();
  const batchId = '223e4567-e89b-42d3-a456-426614174000';
  const send = (nombre) => {
    const res = createRes();
    return guestsHandler(createReq({
      method: 'POST', url: '/api/guests?import=1',
      body: { batch_id: batchId, guests: [{ nombre, cantidad_personas: 1 }] },
      headers: { cookie },
    }), res).then(() => res);
  };
  await send('Ana Pérez');
  const retry = await send('Luis Cruz');
  assert.equal(retry.statusCode, 409);
  assert.equal(JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8')).length, 1);
});

test('invitación por token expone solo nombre, cantidad y estado', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie, { notas: 'dato_interno', telefono: '+18095551111' });

  const res = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${g.token}` }), res);
  assert.equal(res.body.found, true);
  const exposed = JSON.stringify(res.body);
  assert.ok(!exposed.includes('dato_interno'), 'no expone notas');
  assert.ok(!exposed.includes(g.id.toString()), 'no expone id interno');
  assert.ok(!exposed.includes('+18095551111'), 'no expone teléfono');
  assert.equal(res.body.guest.cantidad_personas, 2);
});

/* ══════════ RSVP por token ══════════ */

test('confirmar asistencia registra guest_id y estado del servidor', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);

  const res = await confirm(g.token, 'confirmado', 'Nos vemos ahí');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.estado, 'confirmado');
  assert.equal(res.body.nombre, 'Ana Pérez', 'el nombre viene del servidor');
  assert.equal(res.body.cantidad_personas, 2);

  const local = JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8'));
  assert.equal(local.length, 1);
  assert.equal(local[0].guest_id, g.id);
  assert.equal(local[0].estado, 'confirmado');
  assert.equal(local[0].mensaje, 'Nos vemos ahí');
});

test('rechazar asistencia registra no_asiste', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);

  const res = await confirm(g.token, 'no_asiste', '');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.estado, 'no_asiste');

  const local = JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8'));
  assert.equal(local[0].estado, 'no_asiste');
});

test('cambiar respuesta ACTUALIZA y no duplica el RSVP', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);

  await confirm(g.token, 'confirmado', 'primer mensaje');
  const res = await confirm(g.token, 'no_asiste', 'al final no puedo');

  assert.equal(res.statusCode, 200);
  const local = JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8'));
  assert.equal(local.length, 1, 'un invitado = un registro');
  assert.equal(local[0].guest_id, g.id);
  assert.equal(local[0].estado, 'no_asiste');
  assert.equal(local[0].mensaje, 'al final no puedo');
});

test('la respuesta persiste en el invitado al volver a cargar el enlace', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);
  await confirm(g.token, 'confirmado');

  const res = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${g.token}` }), res);
  assert.equal(res.body.found, true);
  assert.equal(res.body.guest.estado_rsvp, 'confirmado');
});

test('eliminar de la lista archiva, revoca el enlace y conserva el RSVP', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);
  await confirm(g.token, 'confirmado');

  const deleted = createRes();
  await guestsHandler(createReq({
    method: 'DELETE', url: '/api/guests', body: { id: g.id }, headers: { cookie },
  }), deleted);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.archived, true);

  const guestRows = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  assert.equal(guestRows.length, 1);
  assert.ok(guestRows[0].archived_at);
  assert.notEqual(guestRows[0].token, g.token);
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8')).length, 1);

  const oldLink = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${g.token}` }), oldLink);
  assert.deepEqual(oldLink.body, { found: false });

  const list = createRes();
  await guestsHandler(createReq({ method: 'GET', url: '/api/guests', headers: { cookie } }), list);
  assert.deepEqual(list.body, []);
});

test('POST sin token o con token inválido → 404 sin pistas', async () => {
  resetData();
  const res1 = await confirm('token-falso', 'confirmado');
  assert.equal(res1.statusCode, 404);
  assert.deepEqual(res1.body, { error: 'Invitación no encontrada' });

  const res2 = await confirm('', 'confirmado');
  assert.equal(res2.statusCode, 404);
});

test('asistencia inválida → 400', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);
  const res = await confirm(g.token, 'quizas');
  assert.equal(res.statusCode, 400);
});

test('el cliente no puede suplantar identidad ni cantidad', async () => {
  resetData();
  const cookie = await loginAdmin();
  const g = await createGuest(cookie);

  const res = createRes();
  await rsvpsHandler(createReq({
    method: 'POST',
    url: '/api/rsvps',
    body: { token: g.token, asistencia: 'confirmado', nombre: 'Otro Nombre', cantidad_personas: 50 },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.nombre, 'Ana Pérez', 'nombre siempre del registro');
  assert.equal(res.body.cantidad_personas, 2, 'cantidad siempre del registro');
});

/* ══════════ Listado admin ══════════ */

test('GET /api/rsvps requiere sesión admin', async () => {
  const res = createRes();
  await rsvpsHandler(createReq({ method: 'GET', url: '/api/rsvps' }), res);
  assert.equal(res.statusCode, 401);
});

test('admin stats reflejan confirmados y capacidad por personas', async () => {
  resetData();
  const cookie = await loginAdmin();
  const adminStats = require('../api/admin/rsvps');
  const g1 = await createGuest(cookie, { nombre: 'Ana Pérez', cantidad_personas: 2 });
  const g2 = await createGuest(cookie, { nombre: 'Luis Cruz', cantidad_personas: 4 });

  await confirm(g1.token, 'confirmado');
  await confirm(g2.token, 'no_asiste');

  const res = createRes();
  await adminStats(createReq({
    method: 'GET',
    url: '/api/admin/rsvps',
    headers: { cookie },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmados, 1);
  assert.equal(res.body.personas_confirmadas, 2);
  assert.equal(res.body.no_asistira, 1);
  assert.equal(res.body.pendientes, 0);
  assert.equal(res.body.total_invitados, 2);
});
