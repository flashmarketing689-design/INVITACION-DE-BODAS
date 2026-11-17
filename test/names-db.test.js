const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { titleCaseName } = require('../lib/names');

// Migraciones reales sobre PostgreSQL aislado: nombres y apellidos con mayúscula inicial.
let db;
const migrationsDir = path.join(__dirname, '..', 'migrations');
const migration = () => fs.readFileSync(path.join(migrationsDir, '016_title_case_names.sql'), 'utf8');

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
});
beforeEach(async () => {
  await db.exec(`reset role;
    truncate public.guest_roles, public.table_assignments, public.guests, public.invitations, public.invitation_members,
      public.rsvp_respuestas, public.rsvp_historial, public.invitation_checkins restart identity;
    truncate public.party_members restart identity cascade;
    set role service_role;`);
});
after(async () => { if (db) await db.close(); });

const caseOf = async (text) => (await db.query('select public.title_case_name($1) as v', [text])).rows[0].v;

const SAMPLES = ['juan perez', 'MARÍA PÉREZ', '  starlin   paulino  pérez ', 'ana-maría gómez', "o'neil", 'maría de los ángeles',
  'juan pérez del rosario', 'rosa y beto', 'de la cruz', 'ÑANDÚ ÁLVAREZ', 'j.p. rojas', 'luis  ÁNGEL   núñez', 'familia pérez', 'JOSÉ', 'ángel', ''];

test('SQL: la función da lo mismo que la de JavaScript (incluidas tildes y ñ)', async () => {
  for (const sample of SAMPLES) assert.equal(await caseOf(sample), titleCaseName(sample), sample);
  assert.equal(await caseOf(null), null);
});

test('SQL: guests.nombre se corrige al insertar y al actualizar, venga por donde venga', async () => {
  const { rows: [row] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('maría  PÉREZ', 'novia', 'amigos') returning id, nombre");
  assert.equal(row.nombre, 'María Pérez');
  assert.equal((await db.query("update public.guests set nombre = 'juan de la cruz' where id = $1 returning nombre", [row.id])).rows[0].nombre, 'Juan de la Cruz');
  // El nombre visible de una invitación individual sigue al del invitado.
  const { rows: [inv] } = await db.query('select display_name from public.invitations i join public.invitation_members im on im.invitation_id = i.id where im.guest_id = $1', [row.id]);
  assert.equal(inv.display_name, 'Juan de la Cruz');
});

test('SQL: las invitaciones y las personas del cortejo también se corrigen', async () => {
  const { rows: [a] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('uno test', 'novia', 'amigos') returning id");
  const { rows: [b] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('dos test', 'novia', 'amigos') returning id");
  const { rows: [group] } = await db.query("select * from public.group_guests($1::bigint[], 'couple', 'familia   pérez gómez')", [[a.id, b.id]]);
  assert.equal(group.display_name, 'Familia Pérez Gómez');
  const { rows: [member] } = await db.query("insert into public.party_members (nombre, pertenece) values ('padre juan PÉREZ', 'novio') returning nombre");
  assert.equal(member.nombre, 'Padre Juan Pérez');
});

test('SQL: agregar integrantes e importar también guardan los nombres bien escritos', async () => {
  const { rows: [a] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('Uno Test', 'novia', 'amigos') returning id");
  const { rows: [b] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('Dos Test', 'novia', 'amigos') returning id");
  const { rows: [g] } = await db.query("select * from public.group_guests($1::bigint[], 'couple', 'Pareja Test')", [[a.id, b.id]]);
  await db.query("select * from public.add_invitation_members($1::uuid, '{}'::bigint[], $2::jsonb, null)",
    [g.invitation_id, JSON.stringify([{ nombre: 'rené  RUIZ de la o', pertenece: 'novia', categoria: 'amigos' }])]);
  assert.equal((await db.query("select nombre from public.guests where nombre ilike 'rené%'")).rows[0].nombre, 'René Ruiz de la O');
  await db.query("select * from public.import_legacy_guests($1::uuid, $2::jsonb)", ['11111111-1111-4111-8111-111111111111',
    JSON.stringify([{ nombre: 'carlos MENA', pertenece: 'novio', categoria: 'amigos', cantidad_personas: 1 }])]);
  assert.equal((await db.query("select nombre from public.guests where nombre ilike 'carlos%'")).rows[0].nombre, 'Carlos Mena');
});

test('SQL: repetir 016 corrige lo que ya estaba guardado y no cambia lo que está bien', async () => {
  await db.exec('reset role;');
  await db.exec('alter table public.guests disable trigger trg_guests_normalize_name; alter table public.invitations disable trigger trg_invitations_normalize_name;');
  await db.exec(`insert into public.guests (nombre, pertenece, categoria) values ('luis GÓMEZ', 'novio', 'amigos'), ('Ana Bien', 'novia', 'amigos');
    update public.invitations set display_name = 'familia GÓMEZ' where display_name ilike 'luis%';`);
  await db.exec('alter table public.guests enable trigger trg_guests_normalize_name; alter table public.invitations enable trigger trg_invitations_normalize_name;');
  assert.equal((await db.query("select count(*)::int as n from public.guests where nombre = 'luis GÓMEZ'")).rows[0].n, 1, 'precondición: dato mal escrito');
  const before = (await db.query("select updated_at from public.guests where nombre = 'Ana Bien'")).rows[0].updated_at;
  await db.exec(migration());
  await db.exec('set role service_role;');
  assert.deepEqual((await db.query('select nombre from public.guests order by id')).rows.map((r) => r.nombre), ['Luis Gómez', 'Ana Bien']);
  assert.equal((await db.query("select count(*)::int as n from public.invitations where display_name in ('familia GÓMEZ', 'luis GÓMEZ')")).rows[0].n, 0);
  assert.deepEqual((await db.query("select updated_at from public.guests where nombre = 'Ana Bien'")).rows[0].updated_at, before, 'lo que ya estaba bien no se toca');
});

test('SQL: anon y authenticated no pueden usar la función', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(db.query("select public.title_case_name('x')"), { code: '42501' });
  }
});
