const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

// Execute the production migrations and triggers in an isolated PostgreSQL
// instance. JSON fallback tests cannot detect PL/pgSQL name-resolution errors.
let db;
const migrationsDir = path.join(__dirname, '..', 'migrations');
const migrationFiles = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
const readMigration = (file) => fs.readFileSync(path.join(migrationsDir, file), 'utf8');

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const file of migrationFiles) await db.exec(readMigration(file));
});

beforeEach(async () => {
  await db.exec(`reset role;
    truncate public.guests, public.invitations, public.invitation_members,
      public.rsvp_respuestas, public.rsvp_historial, public.invitation_checkins restart identity;
    set role service_role;`);
});

after(async () => { if (db) await db.close(); });

async function guest(nombre, overrides = {}) {
  const { rows: [row] } = await db.query(`insert into public.guests
    (nombre, pertenece, categoria, cantidad_personas, invitacion_enviada, fecha_invitacion_enviada)
    values ($1, 'novia', 'familiares', $2, true, now()) returning *`,
  [nombre, overrides.cantidad_personas || 1]);
  const { rows: [invitation] } = await db.query(`select i.* from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
    where im.guest_id = $1 and im.active`, [row.id]);
  return { ...row, invitation };
}

async function add(invitationId, ids = [], members = [], name = null) {
  const { rows: [result] } = await db.query(
    'select * from public.add_invitation_members($1::uuid, $2::bigint[], $3::jsonb, $4::text)',
    [invitationId, ids, JSON.stringify(members), name]);
  return result;
}

async function activeMembers(invitationId) {
  return (await db.query(`select g.id, g.nombre, g.estado_rsvp, g.invitacion_enviada, im.position
    from public.invitation_members im join public.guests g on g.id = im.guest_id
    where im.invitation_id = $1 and im.active order by im.position`, [invitationId])).rows;
}

async function snapshot() {
  const result = {};
  for (const table of ['guests', 'invitations', 'invitation_members', 'rsvp_respuestas', 'rsvp_historial', 'invitation_checkins']) {
    result[table] = (await db.query(`select * from public.${table} order by 1, 2`)).rows;
  }
  return result;
}

test('SQL: agregar un invitado existente conserva RSVP y reemplaza el pase anterior', async () => {
  const first = await guest('Persona Uno');
  const second = await guest('Persona Dos');
  await db.query(`insert into public.rsvp_respuestas(guest_id, estado)
    values ($1, 'confirmado'), ($2, 'no_asiste')`, [first.id, second.id]);
  const previous = await snapshot();
  const result = await add(first.invitation.id, [second.id]);
  assert.equal(result.group_type, 'couple');
  assert.equal(result.display_name, 'Persona Uno y Persona Dos');
  assert.equal(result.added_count, 1);
  assert.equal(result.invitation_id, first.invitation.id);
  assert.notEqual(result.token, first.invitation.token);
  assert.notEqual(result.pass_token, first.invitation.pass_token);
  const members = await activeMembers(result.invitation_id);
  assert.deepEqual(members.map((row) => row.id), [first.id, second.id]);
  assert.deepEqual(members.map((row) => row.estado_rsvp), ['confirmado', 'no_asiste']);
  assert.ok(members.every((row) => row.invitacion_enviada === false));
  const current = await snapshot();
  assert.deepEqual(current.rsvp_respuestas, previous.rsvp_respuestas);
  assert.deepEqual(current.rsvp_historial, previous.rsvp_historial);
  const source = current.invitations.find((row) => row.id === second.invitation.id);
  assert.equal(source.status, 'replaced');
  assert.equal(source.replaced_by, first.invitation.id);
  assert.equal(current.invitation_members.filter((row) => row.active).length, 2);
});

test('SQL: crear una persona nueva integra el registro creado por el trigger', async () => {
  const first = await guest('Persona Uno');
  const result = await add(first.invitation.id, [], [
    { nombre: ' Persona   Nueva ', pertenece: 'novio', categoria: 'participantes' },
  ]);
  assert.equal(result.group_type, 'couple');
  assert.equal(result.added_count, 1);
  assert.deepEqual((await activeMembers(first.invitation.id)).map((row) => row.nombre), ['Persona Uno', 'Persona Nueva']);
  const current = await snapshot();
  assert.equal(current.guests.length, 2);
  assert.equal(current.invitations.filter((row) => row.status === 'active').length, 1);
  assert.equal(current.invitation_members.filter((row) => row.active).length, 2);
});

test('SQL: agregar varios existentes y nuevos convierte pareja a familia', async () => {
  const first = await guest('Persona Uno');
  const second = await guest('Persona Dos');
  const third = await guest('Persona Tres');
  await add(first.invitation.id, [second.id]);
  const result = await add(first.invitation.id, [third.id], [
    { nombre: 'Persona Cuatro', pertenece: 'novia', categoria: 'iglesia' },
    { nombre: 'Persona Cinco', pertenece: 'novio', categoria: 'amigos' },
  ], 'Familia de prueba');
  assert.equal(result.group_type, 'family');
  assert.equal(result.display_name, 'Familia de prueba');
  assert.equal(result.added_count, 3);
  assert.deepEqual((await activeMembers(first.invitation.id)).map((row) => row.position), [0, 1, 2, 3, 4]);
  const last = await guest('Persona Seis');
  const expanded = await add(first.invitation.id, [last.id]);
  assert.equal(expanded.display_name, 'Familia de prueba');
});

test('SQL: rechaza personas agrupadas, repetidas, archivadas y datos nuevos inválidos sin cambios parciales', async () => {
  const first = await guest('Persona Uno');
  const second = await guest('Persona Dos');
  const target = await guest('Persona Destino');
  const available = await guest('Persona Disponible');
  const archived = await guest('Persona Archivada');
  const legacy = await guest('Persona Antigua', { cantidad_personas: 2 });
  await add(first.invitation.id, [second.id]);
  await db.query('update public.guests set archived_at = now() where id = $1', [archived.id]);
  const previous = await snapshot();
  for (const [invitationId, ids, members] of [
    [target.invitation.id, [available.id, second.id], []],
    [target.invitation.id, [available.id, available.id], []],
    [target.invitation.id, [target.id], []],
    [target.invitation.id, [archived.id], []],
    [target.invitation.id, [legacy.id], []],
    [legacy.invitation.id, [available.id], []],
    [target.invitation.id, [999999], []],
    [target.invitation.id, [available.id], [{ nombre: 'Incompleto', pertenece: 'novio', categoria: 'amigos' }]],
  ]) {
    await assert.rejects(add(invitationId, ids, members), (error) => ['22023', '23505'].includes(error.code));
    assert.deepEqual(await snapshot(), previous);
  }
});

test('SQL: protege las entradas registradas tanto en origen como en destino', async () => {
  const checked = await guest('Persona Registrada');
  const available = await guest('Persona Disponible');
  await db.query(`insert into public.invitation_checkins(invitation_id, guest_id, public_id, operator_name, request_id)
    select im.invitation_id, im.guest_id, im.public_id, 'Recepcion', gen_random_uuid()
    from public.invitation_members im where im.guest_id = $1 and im.active`, [checked.id]);
  const previous = await snapshot();
  await assert.rejects(add(checked.invitation.id, [available.id]), { code: '23505' });
  await assert.rejects(add(available.invitation.id, [checked.id]), { code: '23505' });
  assert.deepEqual(await snapshot(), previous);
});

test('SQL: anon y authenticated no pueden ejecutar la operación', async () => {
  const first = await guest('Persona Uno');
  const second = await guest('Persona Dos');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(add(first.invitation.id, [second.id]), { code: '42501' });
  }
});

test('SQL: 008 repara una base con la función anterior y se puede repetir sin cambiar datos', async () => {
  const first = await guest('Persona Uno');
  const second = await guest('Persona Dos');
  const corrected = readMigration('007_add_invitation_members.sql');
  const fix = readMigration('008_fix_add_invitation_members.sql');
  const body = (sql) => sql.slice(sql.indexOf('create or replace function')).replace(/\r\n/g, '\n');
  assert.equal(body(corrected), body(fix), 'Fresh installs and upgrades must install the same function');
  const legacy = corrected.replace(
    "where i.id = v_source_invitation and i.group_type = 'individual' and i.status = 'active';",
    "where i.id = v_source_invitation and group_type = 'individual' and i.status = 'active';");
  assert.notEqual(legacy, corrected);
  await db.exec('reset role;');
  await db.exec(legacy);
  await db.exec('set role service_role;');
  const previous = await snapshot();
  await assert.rejects(add(first.invitation.id, [second.id]), {
    code: '42702', message: 'column reference "group_type" is ambiguous',
  });
  assert.deepEqual(await snapshot(), previous, 'A failed call must roll back membership changes');
  await db.exec('reset role;');
  await db.exec(fix);
  await db.exec(fix);
  await db.exec('set role service_role;');
  assert.deepEqual(await snapshot(), previous, 'Applying 008 must not alter existing data');
  assert.equal((await add(first.invitation.id, [second.id])).added_count, 1);
});
