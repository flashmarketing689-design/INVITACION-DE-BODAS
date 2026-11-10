const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

// Ejecuta las migraciones reales en PostgreSQL aislado: la capacidad de las
// mesas debe garantizarse en la base de datos, no solo en la pantalla.
let db;
const migrationsDir = path.join(__dirname, '..', 'migrations');

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
    update public.wedding_tables set capacity = 10;
    set role service_role;`);
});
after(async () => { if (db) await db.close(); });

async function people(count, prefix = 'Persona') {
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const { rows: [row] } = await db.query(
      "insert into public.guests (nombre, pertenece, categoria) values ($1, 'novia', 'familiares') returning id",
      [`${prefix} Numero${i}`]);
    ids.push(row.id);
  }
  return ids;
}
const move = (ids, table) => db.query('select public.move_guests_to_table($1::bigint[], $2::integer) as n', [ids, table]);
const seated = async (table) => (await db.query('select count(*)::int as n from public.table_assignments where table_id = $1', [table])).rows[0].n;

test('SQL: hay 12 mesas de 10 lugares con el orden de secciones pedido', async () => {
  const { rows } = await db.query('select id, name, capacity, is_main, category, side from public.wedding_tables order by id');
  assert.equal(rows.length, 12);
  assert.ok(rows.every((row) => row.capacity === 10));
  assert.deepEqual(rows.map((row) => `${row.id}:${row.category}:${row.side}`), [
    '1:familia_cercana:novia', '2:familia_cercana:novio', '3:familiares:novia', '4:familiares:novia',
    '5:familiares:novio', '6:familiares:novio', '7:participantes:null', '8:iglesia:null', '9:iglesia:null',
    '10:amigos:novia', '11:amigos:null', '12:amigos:null']);
  assert.deepEqual(rows.filter((row) => row.is_main).map((row) => row.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(rows[0].name, 'Mesa 1');
});

test('SQL: una mesa nunca pasa de su capacidad y el movimiento es atómico', async () => {
  const ids = await people(12);
  await move(ids.slice(0, 10), 3);
  assert.equal(await seated(3), 10);
  await assert.rejects(move([ids[10]], 3), { code: '23514' });
  // Mover un grupo que no cabe no deja a nadie a medias.
  await move([ids[10]], 4);
  await assert.rejects(move([ids[10], ids[11]], 3), { code: '23514' });
  assert.equal(await seated(3), 10);
  assert.equal(await seated(4), 1);
  assert.equal((await db.query('select 1 from public.table_assignments where guest_id = $1', [ids[11]])).rows.length, 0);
});

test('SQL: mover entre mesas libera el lugar anterior y repetir no falla', async () => {
  const [a, b] = await people(2);
  await move([a, b], 1);
  await move([a], 5);
  assert.equal(await seated(1), 1);
  assert.equal(await seated(5), 1);
  const again = await move([b], 1);
  assert.equal(again.rows[0].n, 0, 'no cambia nada');
  const full = await people(9, 'Otro');
  await move(full, 1);
  assert.equal(await seated(1), 10);
  await move([b], 1); // ya está en esa mesa llena: debe seguir permitido
});

test('SQL: sin mesa libera lugares y valida personas y mesas', async () => {
  const [a, b] = await people(2);
  await move([a, b], 2);
  assert.equal((await move([a], null)).rows[0].n, 1);
  assert.equal(await seated(2), 1);
  await assert.rejects(move([a], 99), { code: 'P0002' });
  await assert.rejects(move([], 1), { code: '22023' });
  await assert.rejects(move([a, a], 1), { code: '22023' });
  await assert.rejects(move([999999], 1), { code: '22023' });
  await db.query('select public.archive_invitation_guest($1)', [b]);
  assert.equal(await seated(2), 0, 'eliminar al invitado libera su lugar');
  await assert.rejects(move([b], 1), { code: '22023' });
  const { rows: [old] } = await db.query(
    "insert into public.guests (nombre, pertenece, categoria, cantidad_personas) values ('Cupo Antiguo', 'novio', 'amigos', 3) returning id");
  await assert.rejects(move([old.id], 1), { code: '22023' }, 'un cupo sin identificar no se sienta');
});

test('SQL: el plan automático se aplica completo o no se aplica', async () => {
  const ids = await people(12);
  await move(ids.slice(0, 9), 6);
  const plan = [{ guest_id: ids[9], table_id: 6 }, { guest_id: ids[10], table_id: 6 }, { guest_id: ids[11], table_id: 7 }];
  await assert.rejects(db.query('select public.apply_table_plan($1::jsonb)', [JSON.stringify(plan)]), { code: '23514' });
  assert.equal(await seated(6), 9);
  assert.equal(await seated(7), 0, 'nada se aplicó');
  const ok = [{ guest_id: ids[9], table_id: 6 }, { guest_id: ids[10], table_id: 7 }, { guest_id: ids[11], table_id: 7 }];
  assert.equal((await db.query('select public.apply_table_plan($1::jsonb) as n', [JSON.stringify(ok)])).rows[0].n, 3);
  await assert.rejects(db.query("select public.apply_table_plan('[{\"guest_id\":1,\"table_id\":99}]'::jsonb)"), { code: '22023' });
  await assert.rejects(db.query("select public.apply_table_plan('{}'::jsonb)"), { code: '22023' });
});

test('SQL: no se reduce la capacidad por debajo de los sentados', async () => {
  const ids = await people(4);
  await move(ids, 8);
  await assert.rejects(db.query('update public.wedding_tables set capacity = 3 where id = 8'), { code: '23514' });
  await db.query('update public.wedding_tables set capacity = 4, name = $1 where id = 8', ['Mesa de honor']);
  await assert.rejects(move(await people(1, 'Extra'), 8), { code: '23514' });
});

test('SQL: anon y authenticated no pueden tocar las mesas', async () => {
  const [a] = await people(1);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(move([a], 1), { code: '42501' });
    await assert.rejects(db.query('select * from public.wedding_tables'), { code: '42501' });
    await assert.rejects(db.query('select * from public.table_assignments'), { code: '42501' });
  }
});

test('SQL: las secciones de las mesas y la marca de familia cercana se validan', async () => {
  await assert.rejects(db.query("update public.wedding_tables set category = 'vip' where id = 1"), { code: '23514' });
  await assert.rejects(db.query("update public.wedding_tables set side = 'ambos' where id = 1"), { code: '23514' });
  await assert.rejects(db.query('update public.wedding_tables set category = null where id = 1'), { code: '23514' }, 'un lado sin categoría no vale');
  await db.query("update public.wedding_tables set category = null, side = null where id = 1");
  const { rows: [family] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('Tia Cercana', 'novia', 'familiares') returning id, cercana");
  assert.equal(family.cercana, false, 'por defecto nadie es familia cercana');
  await db.query('update public.guests set cercana = true where id = $1', [family.id]);
  const { rows: [friend] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('Amigo Comun', 'novio', 'amigos') returning id");
  await assert.rejects(db.query('update public.guests set cercana = true where id = $1', [friend.id]), { code: '23514' });
  await assert.rejects(db.query("update public.guests set categoria = 'amigos' where id = $1", [family.id]), { code: '23514' },
    'quien es familia cercana debe seguir siendo familiar');
  await db.query("update public.guests set cercana = false, categoria = 'amigos' where id = $1", [family.id]);
  await db.query("update public.wedding_tables set category = 'familia_cercana', side = 'novia', is_main = true where id = 1");
});

test('SQL: el parentesco solo vale para familiares cercanos y se valida', async () => {
  const { rows: [madre] } = await db.query("insert into public.guests (nombre, pertenece, categoria) values ('Madre Novia', 'novia', 'familiares') returning id, parentesco");
  assert.equal(madre.parentesco, null, 'por defecto nadie tiene parentesco');
  await assert.rejects(db.query("update public.guests set parentesco = 'madre' where id = $1", [madre.id]), { code: '23514' }, 'el parentesco exige familia cercana');
  await db.query("update public.guests set parentesco = 'madre', cercana = true where id = $1", [madre.id]);
  for (const kin of ['padre', 'hermano']) await db.query('update public.guests set parentesco = $2 where id = $1', [madre.id, kin]);
  await assert.rejects(db.query("update public.guests set parentesco = 'tio' where id = $1", [madre.id]), { code: '23503' }, 'solo valen los parentescos que existen');
  await assert.rejects(db.query("update public.guests set cercana = false where id = $1", [madre.id]), { code: '23514' }, 'quien tiene parentesco sigue siendo cercano');
  await assert.rejects(db.query("update public.guests set categoria = 'amigos' where id = $1", [madre.id]), { code: '23514' });
  await db.query("update public.guests set parentesco = null, cercana = false, categoria = 'amigos' where id = $1", [madre.id]);
});

test('SQL: repetir 012 no pisa las secciones cambiadas desde el panel', async () => {
  await db.query("update public.wedding_tables set category = 'iglesia', side = null, is_main = false where id = 3");
  await db.exec('reset role;');
  await db.exec(fs.readFileSync(path.join(migrationsDir, '012_table_sections.sql'), 'utf8'));
  await db.exec('set role service_role;');
  const { rows: [table] } = await db.query('select category, side, is_main from public.wedding_tables where id = 3');
  assert.deepEqual(table, { category: 'iglesia', side: null, is_main: false });
  await db.query("update public.wedding_tables set category = 'familiares', side = 'novia', is_main = true where id = 3");
});

test('SQL: 011 es repetible y conserva las asignaciones', async () => {
  const ids = await people(3);
  await move(ids, 9);
  await db.exec('reset role;');
  await db.exec(fs.readFileSync(path.join(migrationsDir, '011_wedding_tables.sql'), 'utf8'));
  await db.exec('set role service_role;');
  assert.equal(await seated(9), 3);
  assert.equal((await db.query('select count(*)::int as n from public.wedding_tables')).rows[0].n, 12);
});
