const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

// Migraciones reales sobre PostgreSQL aislado: papeles del cortejo.
let db;
const migrationsDir = path.join(__dirname, '..', 'migrations');
const migration = () => fs.readFileSync(path.join(migrationsDir, '014_wedding_roles.sql'), 'utf8');

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
    truncate public.wedding_roles restart identity cascade;`);
  await db.exec(migration()); // vuelve a sembrar los seis papeles iniciales
  await db.exec('set role service_role;');
});
after(async () => { if (db) await db.close(); });

const guest = async (nombre, categoria = 'participantes') => (await db.query(
  "insert into public.guests (nombre, pertenece, categoria) values ($1, 'novia', $2) returning id", [nombre, categoria])).rows[0].id;
const roleId = async (name) => (await db.query('select id from public.wedding_roles where name = $1', [name])).rows[0].id;

test('SQL: vienen los seis papeles iniciales, en orden', async () => {
  const { rows } = await db.query('select name, sort_order from public.wedding_roles order by sort_order');
  assert.deepEqual(rows.map((row) => row.name), ['Padres que participan', 'Padrinos', 'Chambelanes', 'Damas de honor', 'Niña del cartel', 'Portador(a) de los anillos']);
  assert.deepEqual(rows.map((row) => row.sort_order), [1, 2, 3, 4, 5, 6]);
});

test('SQL: una persona puede tener varios papeles, pero no el mismo dos veces', async () => {
  const nina = await guest('Sofia Perez');
  await db.query('insert into public.guest_roles (guest_id, role_id) values ($1, $2), ($1, $3)', [nina, await roleId('Niña del cartel'), await roleId('Portador(a) de los anillos')]);
  const { rows } = await db.query('select count(*)::int as n from public.guest_roles where guest_id = $1', [nina]);
  assert.equal(rows[0].n, 2);
  await assert.rejects(db.query('insert into public.guest_roles (guest_id, role_id) values ($1, $2)', [nina, await roleId('Niña del cartel')]), { code: '23505' });
});

test('SQL: los nombres de papel no se repiten (ni con otras mayúsculas o espacios) y se validan', async () => {
  await assert.rejects(db.query("insert into public.wedding_roles (name) values ('  DAMAS DE HONOR ')"), { code: '23505' });
  await assert.rejects(db.query("insert into public.wedding_roles (name) values ('   ')"), { code: '23514' });
  await assert.rejects(db.query('insert into public.wedding_roles (name) values ($1)', ['x'.repeat(61)]), { code: '23514' });
  await assert.rejects(db.query("insert into public.wedding_roles (name, description) values ('Nuevo', $1)", ['x'.repeat(201)]), { code: '23514' });
  await db.query("insert into public.wedding_roles (name, sort_order) values ('Pajecitos', 7)");
});

test('SQL: eliminar a un invitado libera sus papeles y eliminar un papel quita sus asignaciones', async () => {
  const [a, b] = [await guest('Ana Uno'), await guest('Beto Dos')];
  const damas = await roleId('Damas de honor');
  await db.query('insert into public.guest_roles (guest_id, role_id) values ($1, $3), ($2, $3)', [a, b, damas]);
  await db.query('select public.archive_invitation_guest($1)', [a]);
  assert.equal((await db.query('select count(*)::int as n from public.guest_roles where guest_id = $1', [a])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.guest_roles where guest_id = $1', [b])).rows[0].n, 1);
  await db.query('delete from public.wedding_roles where id = $1', [damas]);
  assert.equal((await db.query('select count(*)::int as n from public.guest_roles')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from public.guests where id = $1', [b])).rows[0].n, 1, 'el invitado no se borra');
});

test('SQL: reordenar es atómico y rechaza listas inválidas', async () => {
  const ids = (await db.query('select id from public.wedding_roles order by sort_order')).rows.map((row) => row.id);
  const reversed = [...ids].reverse();
  assert.equal((await db.query('select public.reorder_wedding_roles($1::bigint[]) as n', [reversed])).rows[0].n, 6);
  assert.deepEqual((await db.query('select id from public.wedding_roles order by sort_order')).rows.map((row) => row.id), reversed);
  await assert.rejects(db.query('select public.reorder_wedding_roles($1::bigint[])', [[ids[0], ids[0]]]), { code: '22023' });
  await assert.rejects(db.query('select public.reorder_wedding_roles($1::bigint[])', [[]]), { code: '22023' });
});

test('SQL: anon y authenticated no pueden ver ni cambiar los papeles', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(db.query('select * from public.wedding_roles'), { code: '42501' });
    await assert.rejects(db.query('select * from public.guest_roles'), { code: '42501' });
    await assert.rejects(db.query('select public.reorder_wedding_roles($1::bigint[])', [[1]]), { code: '42501' });
  }
});

test('SQL: 014 es repetible: no duplica los papeles ni pisa los cambios', async () => {
  const damas = await roleId('Damas de honor');
  await db.query("update public.wedding_roles set name = 'Damas de la novia', description = 'Cambiado' where id = $1", [damas]);
  await db.query("insert into public.wedding_roles (name, sort_order) values ('Pajecitos', 7)");
  const a = await guest('Ana Uno');
  await db.query('insert into public.guest_roles (guest_id, role_id) values ($1, $2)', [a, damas]);
  await db.exec('reset role;'); await db.exec(migration()); await db.exec('set role service_role;');
  const { rows } = await db.query('select name from public.wedding_roles order by sort_order, id');
  assert.equal(rows.length, 7);
  assert.ok(rows.some((row) => row.name === 'Damas de la novia') && rows.some((row) => row.name === 'Pajecitos'));
  assert.equal((await db.query('select count(*)::int as n from public.guest_roles')).rows[0].n, 1);
});
