const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_PASSWORD = 'test-admin-pass';

const rsvpsHandler = require('../api/rsvps');
const guestsHandler = require('../api/guests');
const guestHandler = require('../api/guest');
const invitationsHandler = require('../api/invitations');
const checkinHandler = require('../api/checkin');
const qrHandler = require('../api/qr');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
const LOCAL_RSVPS = path.join(DATA_DIR, 'rsvp_respuestas_local.json');
const LOCAL_INVITATIONS = path.join(DATA_DIR, 'invitations_local.json');
const LOCAL_CHECKINS = path.join(DATA_DIR, 'invitation_checkins_local.json');
let loginAttemptId = 0;

function createRes() {
  const res = {};
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = (payload) => { res.ended = true; res.output = payload; return res; };
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
  fs.writeFileSync(LOCAL_INVITATIONS, '[]', 'utf8');
  fs.writeFileSync(LOCAL_CHECKINS, '[]', 'utf8');
}

async function loginAdmin() {
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests?action=login',
    body: { password: 'test-admin-pass' },
    headers: { 'x-forwarded-for': `test-login-${++loginAttemptId}` },
  }), res);
  assert.equal(res.statusCode, 200);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  return cookie;
}

async function createGuest(cookie, overrides = {}) {
  const legacyQuantity = Number(overrides.cantidad_personas ?? overrides.cantidad ?? 2);
  const guestOverrides = { ...overrides };
  delete guestOverrides.cantidad_personas;
  delete guestOverrides.cantidad;
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST',
    url: '/api/guests',
    body: {
      nombre: 'Ana Pérez',
      pertenece: 'novia',
      categoria: 'familiares',
      cantidad_personas: 1,
      telefono: '+18090000000',
      ...guestOverrides,
    },
    headers: { cookie },
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  if (legacyQuantity > 1) {
    const guests = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
    const index = guests.findIndex((guest) => String(guest.id) === String(res.body.id));
    guests[index] = { ...guests[index], cantidad_personas: legacyQuantity };
    fs.writeFileSync(GUESTS_FILE, JSON.stringify(guests, null, 2), 'utf8');
  }
  return { ...res.body, cantidad_personas: legacyQuantity };
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

async function groupGuests(cookie, guestIds, groupType = 'couple', displayName) {
  const res = createRes();
  await invitationsHandler(createReq({
    method: 'POST', url: '/api/invitations',
    body: { guest_ids: guestIds, group_type: groupType, display_name: displayName },
    headers: { cookie },
  }), res);
  return res;
}

async function addInvitationMembers(cookie, invitationId, payload = {}) {
  const res = createRes();
  await invitationsHandler(createReq({
    method: 'POST', url: '/api/invitations?action=add-members',
    body: { invitation_id: invitationId, ...payload },
    headers: { cookie },
  }), res);
  return res;
}

async function confirmMembers(token, responses, mensaje = '') {
  const res = createRes();
  await rsvpsHandler(createReq({
    method: 'POST', url: '/api/rsvps',
    body: { token, responses, mensaje },
  }), res);
  return res;
}

async function loginReception(operator = 'Ana Recepción') {
  process.env.RECEPTION_PASS_KEY = 'reception-test-pass-12345';
  const res = createRes();
  await checkinHandler(createReq({
    method: 'POST', url: '/api/checkin?action=login',
    body: { operator, password: process.env.RECEPTION_PASS_KEY },
  }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.headers['Set-Cookie'].split(';')[0];
}

/* ══════════ Autenticación admin ══════════ */

test('guests API rechaza CRUD sin sesión admin', async () => {
  resetData();
  const res = createRes();
  await guestsHandler(createReq({ method: 'GET', url: '/api/guests' }), res);
  assert.equal(res.statusCode, 401);
});

test('renombrar invitado requiere sesión admin', async () => {
  resetData();
  const res = createRes();
  await guestsHandler(createReq({
    method: 'PATCH', url: '/api/guests',
    body: { action: 'renombrar', guest_id: 1001, nombre: 'Ana Pérez' },
  }), res);
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

test('importación conserva la categoría Participantes y el estado RSVP existente', async () => {
  resetData();
  const cookie = await loginAdmin();
  const batchId = '323e4567-e89b-42d3-a456-426614174000';
  const res = createRes();
  await guestsHandler(createReq({
    method: 'POST', url: '/api/guests?import=1',
    body: {
      batch_id: batchId,
      guests: [{
        nombre: 'Ana Pérez', pertenece: 'novio', categoria: 'participantes',
        cantidad_personas: 1, estado_rsvp: 'confirmado', fecha_rsvp: '2026-10-07T12:00:00.000Z',
      }],
    },
    headers: { cookie },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 1);
  assert.equal(res.body.guests[0].pertenece, 'novio');
  assert.equal(res.body.guests[0].categoria, 'participantes');
  assert.equal(res.body.guests[0].estado_rsvp, 'confirmado');
  assert.equal(res.body.guests[0].estado, 'confirmado');
  assert.equal(res.body.guests[0].fecha_rsvp, '2026-10-07T12:00:00.000Z');
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

test('pareja comparte un enlace, conserva respuestas individuales y revoca sus enlaces anteriores', async () => {
  resetData();
  const cookie = await loginAdmin();
  const ana = await createGuest(cookie, { nombre: 'Ana Pérez', cantidad_personas: 1 });
  const luis = await createGuest(cookie, { nombre: 'Luis Cruz', cantidad_personas: 1 });
  const grouped = await groupGuests(cookie, [ana.id, luis.id], 'couple');
  assert.equal(grouped.statusCode, 201, JSON.stringify(grouped.body));
  assert.equal(grouped.body.display_name, 'Ana Pérez y Luis Cruz');
  assert.equal(grouped.body.members.length, 2);
  assert.notEqual(grouped.body.token, ana.token);
  assert.notEqual(grouped.body.pass_token, grouped.body.token, 'el código del pase no es el enlace para responder');

  const oldLink = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${ana.token}` }), oldLink);
  assert.deepEqual(oldLink.body, { found: false });
  const publicInvite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${grouped.body.token}` }), publicInvite);
  assert.equal(publicInvite.body.guest.members.length, 2);
  assert.deepEqual(publicInvite.body.guest.members.map((member) => member.nombre), ['Ana Pérez', 'Luis Cruz']);
  assert.ok(!JSON.stringify(publicInvite.body).includes(String(ana.id)), 'no expone IDs internos secuenciales');

  const firstMember = publicInvite.body.guest.members[0];
  const partial = await confirmMembers(grouped.body.token, [{ member_id: firstMember.member_id, estado: 'confirmado' }]);
  assert.equal(partial.statusCode, 200, JSON.stringify(partial.body));
  assert.equal(partial.body.resumen.confirmados, 1);
  assert.equal(partial.body.resumen.pendientes, 1);
  const qr = createRes();
  await qrHandler(createReq({ method: 'GET', url: `/api/qr?token=${grouped.body.token}` }), qr);
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['Content-Type'], 'image/png');
  assert.ok(Buffer.isBuffer(qr.output) && qr.output.length > 100);

  const oldPassToken = grouped.body.pass_token;
  const declined = await confirmMembers(grouped.body.token, [{ member_id: firstMember.member_id, estado: 'no_asiste' }]);
  assert.equal(declined.statusCode, 200);
  const oldQr = createRes();
  await qrHandler(createReq({ method: 'GET', url: `/api/qr?token=${grouped.body.token}` }), oldQr);
  assert.equal(oldQr.statusCode, 404, 'sin confirmados no se emite un pase');
  const adminInvitations = createRes();
  await invitationsHandler(createReq({ method: 'GET', url: '/api/invitations', headers: { cookie } }), adminInvitations);
  const revokedGroup = adminInvitations.body.find((row) => row.id === grouped.body.id);
  assert.notEqual(revokedGroup.pass_token, oldPassToken, 'al cancelar todos, se rota la credencial del QR');

  await confirmMembers(grouped.body.token, [{ member_id: firstMember.member_id, estado: 'confirmado' }]);
  const otherMember = publicInvite.body.guest.members[1];
  const mixed = await confirmMembers(grouped.body.token, [{ member_id: otherMember.member_id, estado: 'no_asiste' }]);
  assert.equal(mixed.body.resumen.confirmados, 1);
  assert.equal(mixed.body.resumen.no_asisten, 1);
  assert.equal(mixed.body.resumen.pendientes, 0);
  const renewedQr = createRes();
  await qrHandler(createReq({ method: 'GET', url: `/api/qr?token=${grouped.body.token}` }), renewedQr);
  assert.equal(renewedQr.statusCode, 200, 'la asistencia mixta mantiene el pase de quien sí confirmó');
  const receptionCookie = await loginReception('Ana Recepción');
  const obsoleteTicket = createRes();
  await checkinHandler(createReq({
    method: 'GET', url: `/api/checkin?ticket=${oldPassToken}`, headers: { cookie: receptionCookie },
  }), obsoleteTicket);
  assert.equal(obsoleteTicket.statusCode, 404, 'el QR anterior no revive al reconfirmar');
});

test('lista de personas conserva su grupo al editar, marcar envío, ampliar y separar', async () => {
  resetData();
  const cookie = await loginAdmin();
  const first = await createGuest(cookie, { nombre: 'Persona Uno', cantidad_personas: 1, pertenece: 'novia' });
  const second = await createGuest(cookie, { nombre: 'Persona Dos', cantidad_personas: 1, pertenece: 'novio', categoria: 'amigos' });
  const third = await createGuest(cookie, { nombre: 'Persona Tres', cantidad_personas: 1 });
  const grouped = await groupGuests(cookie, [first.id, second.id], 'couple');
  assert.equal(grouped.statusCode, 201);
  const list = async () => {
    const res = createRes();
    await guestsHandler(createReq({ url: '/api/guests', headers: { cookie } }), res);
    assert.equal(res.statusCode, 200);
    return res.body;
  };
  let rows = await list();
  assert.equal(rows.filter((row) => row.invitation_type === 'individual').length, 1);
  assert.ok(rows.filter((row) => row.id !== third.id).every((row) =>
    row.invitation_people_count === 2 && row.invitation_members.length === 2
      && row.invitation_token === grouped.body.token));
  const edited = createRes();
  await guestsHandler(createReq({ method: 'PUT', url: '/api/guests', headers: { cookie },
    body: { id: first.id, nombre: 'Persona Renombrada', pertenece: 'novia', categoria: 'familiares', cantidad_personas: 1 },
  }), edited);
  assert.equal(edited.statusCode, 200);
  const sent = createRes();
  await guestsHandler(createReq({ method: 'PATCH', url: '/api/guests', headers: { cookie },
    body: { action: 'marcar_enviada', guest_id: second.id, value: true },
  }), sent);
  assert.equal(sent.statusCode, 200);
  rows = await list();
  assert.ok(rows.filter((row) => row.id !== third.id).every((row) => row.invitation_type === 'couple'
    && row.invitacion_enviada && row.invitation_members.some((member) => member.nombre === 'Persona Renombrada')));
  const expanded = await addInvitationMembers(cookie, grouped.body.id, { guest_ids: [third.id] });
  assert.equal(expanded.statusCode, 200);
  rows = await list();
  assert.ok(rows.every((row) => row.invitation_type === 'family' && row.invitation_people_count === 3));
  const split = createRes();
  await invitationsHandler(createReq({ method: 'POST', url: '/api/invitations?action=split', headers: { cookie },
    body: { invitation_id: grouped.body.id },
  }), split);
  assert.equal(split.statusCode, 200);
  rows = await list();
  assert.ok(rows.every((row) => row.invitation_type === 'individual' && row.invitation_member_count === 1));
  assert.equal(new Set(rows.map((row) => row.invitation_id)).size, 3);
});

test('dos teléfonos registran el mismo pase sin duplicar una entrada', async () => {
  resetData();
  const adminCookie = await loginAdmin();
  const one = await createGuest(adminCookie, { nombre: 'Starlin Pérez', cantidad_personas: 1 });
  const two = await createGuest(adminCookie, { nombre: 'Reneisy Charles', cantidad_personas: 1 });
  const grouped = await groupGuests(adminCookie, [one.id, two.id], 'couple');
  const invite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${grouped.body.token}` }), invite);
  const member = invite.body.guest.members[0];
  await confirmMembers(grouped.body.token, [{ member_id: member.member_id, estado: 'confirmado' }]);

  const firstPhone = await loginReception('Ana Puerta 1');
  const secondPhone = await loginReception('Luis Puerta 2');
  const invitationTokenAsPass = createRes();
  await checkinHandler(createReq({
    method: 'GET', url: `/api/checkin?ticket=${grouped.body.token}`, headers: { cookie: firstPhone },
  }), invitationTokenAsPass);
  assert.equal(invitationTokenAsPass.statusCode, 404, 'el enlace RSVP no debe funcionar como pase de recepción');

  const request = (cookie, requestId) => {
    const res = createRes();
    return checkinHandler(createReq({
      method: 'POST', url: '/api/checkin',
      body: { pass_token: grouped.body.pass_token, member_ids: [member.member_id], request_id: requestId },
      headers: { cookie },
    }), res).then(() => res);
  };
  const [a, b] = await Promise.all([
    request(firstPhone, '323e4567-e89b-42d3-a456-426614174000'),
    request(secondPhone, '423e4567-e89b-42d3-a456-426614174000'),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const outcomes = [a.body.results[0].status, b.body.results[0].status].sort();
  assert.deepEqual(outcomes, ['already', 'registered']);
  const checkins = JSON.parse(fs.readFileSync(LOCAL_CHECKINS, 'utf8'));
  assert.equal(checkins.length, 1);

  const ticket = createRes();
  await checkinHandler(createReq({
    method: 'GET', url: `/api/checkin?ticket=${grouped.body.pass_token}`, headers: { cookie: secondPhone },
  }), ticket);
  assert.equal(ticket.statusCode, 200);
  assert.equal(ticket.body.members[0].checkin.operator_name, 'Ana Puerta 1');
});

test('no se agrupan cupos antiguos sin identificar como si fueran personas', async () => {
  resetData();
  const cookie = await loginAdmin();
  const aggregate = await createGuest(cookie, { nombre: 'Familia García', cantidad_personas: 3 });
  const individual = await createGuest(cookie, { nombre: 'María García', cantidad_personas: 1 });
  const grouped = await groupGuests(cookie, [aggregate.id, individual.id], 'family', 'Familia García');
  assert.equal(grouped.statusCode, 409);
});

test('familia comparte un pase para sus integrantes y una pareja exige dos personas', async () => {
  resetData();
  const cookie = await loginAdmin();
  const people = await Promise.all([
    createGuest(cookie, { nombre: 'Ana García', cantidad_personas: 1 }),
    createGuest(cookie, { nombre: 'Luis García', cantidad_personas: 1 }),
    createGuest(cookie, { nombre: 'Eva García', cantidad_personas: 1 }),
  ]);
  const family = await groupGuests(cookie, people.map((guest) => guest.id), 'family', 'Familia García');
  assert.equal(family.statusCode, 201, JSON.stringify(family.body));
  assert.equal(family.body.group_type, 'family');
  assert.equal(family.body.members.length, 3);

  const rejectedCouple = await groupGuests(cookie, people.map((guest) => guest.id), 'couple');
  assert.equal(rejectedCouple.statusCode, 400);
});

test('agregar invitados existentes y nuevos conserva RSVP y renueva el enlace compartido', async () => {
  resetData();
  const cookie = await loginAdmin();
  const ana = await createGuest(cookie, { nombre: 'Ana Pérez', cantidad_personas: 1 });
  const luis = await createGuest(cookie, { nombre: 'Luis Pérez', cantidad_personas: 1 });
  const eva = await createGuest(cookie, { nombre: 'Eva Pérez', cantidad_personas: 1 });
  const couple = await groupGuests(cookie, [ana.id, luis.id], 'couple');
  assert.equal(couple.statusCode, 201, JSON.stringify(couple.body));
  const anaMember = couple.body.members.find((member) => String(member.guest_id) === String(ana.id));
  const confirmed = await confirmMembers(couple.body.token, [{ member_id: anaMember.member_id, estado: 'confirmado' }]);
  assert.equal(confirmed.statusCode, 200);

  const oldToken = couple.body.token;
  const oldPassToken = couple.body.pass_token;
  const added = await addInvitationMembers(cookie, couple.body.id, {
    guest_ids: [eva.id],
    new_members: [{ nombre: 'Mía Pérez', pertenece: 'novia', categoria: 'amigos' }],
  });
  assert.equal(added.statusCode, 200, JSON.stringify(added.body));
  assert.equal(added.body.group_type, 'family');
  assert.equal(added.body.members.length, 4);
  assert.equal(added.body.added_count, 2);
  assert.equal(added.body.display_name, 'Familia Pérez');
  assert.notEqual(added.body.token, oldToken);
  assert.notEqual(added.body.pass_token, oldPassToken);
  assert.equal(added.body.sent_at, null);

  const obsoleteLink = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${oldToken}` }), obsoleteLink);
  assert.deepEqual(obsoleteLink.body, { found: false });
  const publicInvite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${added.body.token}` }), publicInvite);
  assert.equal(publicInvite.statusCode, 200);
  assert.deepEqual(publicInvite.body.guest.members.map((member) => member.nombre), [
    'Ana Pérez', 'Luis Pérez', 'Eva Pérez', 'Mía Pérez',
  ]);
  assert.equal(publicInvite.body.guest.members.find((member) => member.nombre === 'Ana Pérez').estado_rsvp, 'confirmado');
  assert.equal(publicInvite.body.guest.members.find((member) => member.nombre === 'Mía Pérez').estado_rsvp, null);
  const guests = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  const mia = guests.find((guest) => guest.nombre === 'Mía Pérez');
  assert.equal(mia.pertenece, 'novia');
  assert.equal(mia.categoria, 'amigos');
  assert.equal(mia.cantidad_personas, 1);
});

test('no se puede ampliar un grupo después de registrar una entrada', async () => {
  resetData();
  const cookie = await loginAdmin();
  const ana = await createGuest(cookie, { nombre: 'Ana Pérez', cantidad_personas: 1 });
  const luis = await createGuest(cookie, { nombre: 'Luis Pérez', cantidad_personas: 1 });
  const group = await groupGuests(cookie, [ana.id, luis.id], 'couple');
  const invite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${group.body.token}` }), invite);
  const member = invite.body.guest.members[0];
  await confirmMembers(group.body.token, [{ member_id: member.member_id, estado: 'confirmado' }]);
  const receptionCookie = await loginReception();
  const checkin = createRes();
  await checkinHandler(createReq({
    method: 'POST', url: '/api/checkin',
    body: { pass_token: group.body.pass_token, member_ids: [member.member_id], request_id: '623e4567-e89b-42d3-a456-426614174000' },
    headers: { cookie: receptionCookie },
  }), checkin);
  assert.equal(checkin.statusCode, 200, JSON.stringify(checkin.body));

  const added = await addInvitationMembers(cookie, group.body.id, {
    new_members: [{ nombre: 'Mía Pérez', pertenece: 'novia', categoria: 'amigos' }],
  });
  assert.equal(added.statusCode, 409);
  assert.match(added.body.error, /entradas registradas/i);
  const guests = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  assert.equal(guests.some((guest) => guest.nombre === 'Mía Pérez'), false);
});

test('editar nombre conserva RSVP y pase compartido y actualiza el nombre de la pareja', async () => {
  resetData();
  const cookie = await loginAdmin();
  const first = await createGuest(cookie, { nombre: 'Starlin Pérez', cantidad_personas: 1 });
  const second = await createGuest(cookie, { nombre: 'Reneisy Charles', cantidad_personas: 1 });
  const grouped = await groupGuests(cookie, [first.id, second.id], 'couple');
  assert.equal(grouped.statusCode, 201, JSON.stringify(grouped.body));
  const member = grouped.body.members.find((row) => String(row.guest_id) === String(first.id));
  const originalPass = grouped.body.pass_token;
  const beforeRows = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
  const originalMemberToken = beforeRows.find((row) => String(row.id) === String(first.id)).token;

  const response = await confirmMembers(grouped.body.token, [
    { member_id: member.member_id, estado: 'confirmado' },
  ]);
  assert.equal(response.statusCode, 200);

  const renamed = createRes();
  await guestsHandler(createReq({
    method: 'PATCH', url: '/api/guests',
    body: { action: 'renombrar', guest_id: first.id, nombre: 'Starlin Paulino' },
    headers: { cookie },
  }), renamed);
  assert.equal(renamed.statusCode, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.nombre, 'Starlin Paulino');
  assert.equal(renamed.body.token, originalMemberToken);

  const publicInvite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${grouped.body.token}` }), publicInvite);
  assert.equal(publicInvite.statusCode, 200);
  assert.equal(publicInvite.body.guest.nombre, 'Starlin Paulino y Reneisy Charles');
  const updatedMember = publicInvite.body.guest.members.find((row) => row.member_id === member.member_id);
  assert.equal(updatedMember.nombre, 'Starlin Paulino');
  assert.equal(updatedMember.estado_rsvp, 'confirmado');

  const receptionCookie = await loginReception();
  const ticket = createRes();
  await checkinHandler(createReq({
    method: 'GET', url: `/api/checkin?ticket=${originalPass}`, headers: { cookie: receptionCookie },
  }), ticket);
  assert.equal(ticket.statusCode, 200);
  assert.equal(ticket.body.invitation.display_name, 'Starlin Paulino y Reneisy Charles');
  assert.equal(ticket.body.members.find((row) => row.member_id === member.member_id).nombre, 'Starlin Paulino');
});

test('editar nombre de un integrante conserva el nombre personalizado de la invitación familiar', async () => {
  resetData();
  const cookie = await loginAdmin();
  const first = await createGuest(cookie, { nombre: 'Ana García', cantidad_personas: 1 });
  const second = await createGuest(cookie, { nombre: 'Luis García', cantidad_personas: 1 });
  const family = await groupGuests(cookie, [first.id, second.id], 'family', 'Familia García');
  assert.equal(family.statusCode, 201, JSON.stringify(family.body));
  const firstMember = family.body.members.find((member) => String(member.guest_id) === String(first.id));

  const renamed = createRes();
  await guestsHandler(createReq({
    method: 'PATCH', url: '/api/guests',
    body: { action: 'renombrar', guest_id: first.id, nombre: 'Ana Martínez' },
    headers: { cookie },
  }), renamed);
  assert.equal(renamed.statusCode, 200, JSON.stringify(renamed.body));

  const invite = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${family.body.token}` }), invite);
  assert.equal(invite.statusCode, 200);
  assert.equal(invite.body.guest.nombre, 'Familia García');
  assert.equal(invite.body.guest.members.find((member) => member.member_id === firstMember.member_id).nombre, 'Ana Martínez');
});

test('el cupo de 150 rechaza una confirmación que excede el límite sin guardar respuestas parciales', async () => {
  resetData();
  const existingGuests = Array.from({ length: 149 }, (_, index) => ({
    id: index + 1,
    nombre: `Invitado ${index + 1}`,
    telefono: null,
    pertenece: 'novio',
    categoria: 'familiares',
    cantidad_personas: 1,
    token: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  const confirmedRows = existingGuests.map((guest) => ({
    id: guest.id,
    guest_id: guest.id,
    estado: 'confirmado',
    fecha_respuesta: new Date().toISOString(),
  }));
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(existingGuests), 'utf8');
  fs.writeFileSync(LOCAL_RSVPS, JSON.stringify(confirmedRows), 'utf8');

  const cookie = await loginAdmin();
  const first = await createGuest(cookie, { nombre: 'María García', cantidad_personas: 1 });
  const second = await createGuest(cookie, { nombre: 'Luis García', cantidad_personas: 1 });
  const grouped = await groupGuests(cookie, [first.id, second.id], 'couple');
  assert.equal(grouped.statusCode, 201, JSON.stringify(grouped.body));

  const result = await confirmMembers(grouped.body.token, grouped.body.members.map((member) => ({
    member_id: member.member_id,
    estado: 'confirmado',
  })));
  assert.equal(result.statusCode, 409);
  assert.match(result.body.error, /150 personas/);
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8')).length, 149);
});

test('el cupo permite llegar a 150 y rechaza la siguiente persona', async () => {
  resetData();
  const existingGuests = Array.from({ length: 148 }, (_, index) => ({
    id: index + 1,
    nombre: `Invitado ${index + 1}`,
    telefono: null,
    pertenece: 'novio',
    categoria: 'familiares',
    cantidad_personas: 1,
    token: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
  const confirmedRows = existingGuests.map((guest) => ({
    id: guest.id,
    guest_id: guest.id,
    estado: 'confirmado',
    fecha_respuesta: new Date().toISOString(),
  }));
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(existingGuests), 'utf8');
  fs.writeFileSync(LOCAL_RSVPS, JSON.stringify(confirmedRows), 'utf8');

  const cookie = await loginAdmin();
  const first = await createGuest(cookie, { nombre: 'María García', cantidad_personas: 1 });
  const second = await createGuest(cookie, { nombre: 'Luis García', cantidad_personas: 1 });
  const third = await createGuest(cookie, { nombre: 'Eva García', cantidad_personas: 1 });
  const couple = await groupGuests(cookie, [first.id, second.id], 'couple');
  assert.equal(couple.statusCode, 201, JSON.stringify(couple.body));

  const coupleResponse = await confirmMembers(couple.body.token, couple.body.members.map((member) => ({
    member_id: member.member_id,
    estado: 'confirmado',
  })));
  assert.equal(coupleResponse.statusCode, 200, JSON.stringify(coupleResponse.body));
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8')).length, 150);

  const individual = createRes();
  await guestHandler(createReq({ method: 'GET', url: `/api/guest?token=${third.token}` }), individual);
  assert.equal(individual.statusCode, 200);
  const lastResponse = await confirmMembers(third.token, [{
    member_id: individual.body.guest.members[0].member_id,
    estado: 'confirmado',
  }]);
  assert.equal(lastResponse.statusCode, 409);
  assert.equal(JSON.parse(fs.readFileSync(LOCAL_RSVPS, 'utf8')).length, 150);
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
  assert.equal(res.body.max_guests, 150);
});
