const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

// Migraciones reales sobre PostgreSQL aislado: parentescos editables y novios sin invitación.
let db;
const migrationsDir = path.join(__dirname, '..', 'migrations');
const migration = () => fs.readFileSync(path.join(migrationsDir, '015_kinships_and_party_members.sql'), 'utf8');

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
    truncate public.wedding_kinships, public.party_members, public.wedding_roles restart identity cascade;
    insert into public.wedding_roles (name, description, sort_order) values ('Damas de honor', 'Acompañan a la novia.', 4);`);
  await db.exec(migration());
  await db.exec('set role service_role;');
});
after(async () => { if (db) await db.close(); });

const guest = async (nombre, extra = '') => (await db.query(
  `insert into public.guests (nombre, pertenece, categoria, cercana ${extra ? ', parentesco' : ''}) values ($1, 'novia', 'familiares', ${extra ? 'true, $2' : 'false'}) returning id`,
  extra ? [nombre, extra] : [nombre])).rows[0].id;

test('SQL: vienen madre, padre y hermano(a), en ese orden', async () => {
  const { rows } = await db.query('select key, name from public.wedding_kinships order by sort_order');
  assert.deepEqual(rows, [{ key: 'madre', name: 'Madre' }, { key: 'padre', name: 'Padre' }, { key: 'hermano', name: 'Hermano(a)' }]);
});

test('SQL: se pueden añadir parentescos propios y usarlos; los que no existen se rechazan', async () => {
  await db.query("insert into public.wedding_kinships (key, name, sort_order) values ('abuelo', 'Abuelo(a)', 4)");
  const id = await guest('Abuela Delgado', 'abuelo');
  assert.equal((await db.query('select parentesco from public.guests where id = $1', [id])).rows[0].parentesco, 'abuelo');
  await assert.rejects(guest('Falso Parentesco', 'tio'), { code: '23503' });
  await assert.rejects(db.query("insert into public.wedding_kinships (key, name) values ('Mal Formato', 'X')"), { code: '23514' });
  await assert.rejects(db.query("insert into public.wedding_kinships (key, name) values ('otro', '  ABUELO(A) ')"), { code: '23505' }, 'sin nombres repetidos');
  await assert.rejects(db.query("insert into public.wedding_kinships (key, name) values ('vacio', '   ')"), { code: '23514' });
});

test('SQL: quitar un parentesco deja en nulo a quienes lo tenían y siguen siendo familia cercana', async () => {
  const madre = await guest('Marta Delgado', 'madre');
  await db.query("delete from public.wedding_kinships where key = 'madre'");
  const { rows: [row] } = await db.query('select parentesco, cercana from public.guests where id = $1', [madre]);
  assert.deepEqual(row, { parentesco: null, cercana: true });
});

test('SQL: el parentesco sigue exigiendo ser familia cercana', async () => {
  const id = await guest('Sin Cercana');
  await assert.rejects(db.query("update public.guests set parentesco = 'madre' where id = $1", [id]), { code: '23514' });
});

test('SQL: los novios vienen en el cortejo con el papel "Novios", sin ser invitados', async () => {
  const { rows } = await db.query(`select m.nombre, m.pertenece, r.name as papel from public.party_members m
    join public.party_member_roles pr on pr.member_id = m.id join public.wedding_roles r on r.id = pr.role_id order by m.id`);
  assert.deepEqual(rows, [{ nombre: 'Starlin Paulino Pérez', pertenece: 'novio', papel: 'Novios' }, { nombre: 'Reneisy', pertenece: 'novia', papel: 'Novios' }]);
  assert.equal((await db.query("select sort_order from public.wedding_roles where name = 'Novios'")).rows[0].sort_order, 0, 'primero de la lista');
  assert.equal((await db.query('select count(*)::int as n from public.guests')).rows[0].n, 0, 'no cuentan como invitados');
});

test('SQL: repetir 015 no duplica ni pisa nada', async () => {
  await db.query("insert into public.wedding_kinships (key, name, sort_order) values ('tio', 'Tío(a)', 4)");
  await db.query("insert into public.party_members (nombre, pertenece) values ('Oficiante Perez', 'novio')");
  await db.exec('reset role;'); await db.exec(migration()); await db.exec('set role service_role;');
  assert.equal((await db.query('select count(*)::int as n from public.party_members')).rows[0].n, 3);
  assert.equal((await db.query('select count(*)::int as n from public.wedding_kinships')).rows[0].n, 4);
  assert.equal((await db.query("select count(*)::int as n from public.wedding_roles where name = 'Novios'")).rows[0].n, 1);
});

test('SQL: validaciones, cascadas y permisos de las personas del cortejo', async () => {
  await assert.rejects(db.query("insert into public.party_members (nombre, pertenece) values ('X', 'novio')"), { code: '23514' });
  await assert.rejects(db.query("insert into public.party_members (nombre, pertenece) values ('Ana Perez', 'otro')"), { code: '23514' });
  const novios = (await db.query("select id from public.wedding_roles where name = 'Novios'")).rows[0].id;
  await db.query('delete from public.wedding_roles where id = $1', [novios]);
  assert.equal((await db.query('select count(*)::int as n from public.party_member_roles')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.party_members')).rows[0].n, 2, 'las personas no se borran');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    for (const table of ['wedding_kinships', 'party_members', 'party_member_roles']) {
      await assert.rejects(db.query(`select * from public.${table}`), { code: '42501' });
    }
  }
});
