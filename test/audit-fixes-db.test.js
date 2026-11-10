const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

// Ejecuta las migraciones reales en PostgreSQL aislado (ver auditoría administrativa).
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
    truncate public.table_assignments, public.guests, public.invitations, public.invitation_members,
      public.rsvp_respuestas, public.rsvp_historial, public.invitation_checkins restart identity;
    set role service_role;`);
});
after(async () => { if (db) await db.close(); });

async function guest(nombre) {
  const { rows: [row] } = await db.query(
    "insert into public.guests (nombre, pertenece, categoria) values ($1, 'novia', 'familiares') returning *", [nombre]);
  const { rows: [invitation] } = await db.query(`select i.* from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id
    where im.guest_id = $1 and im.active`, [row.id]);
  return { ...row, invitation };
}

test('SQL: separar un grupo ignora a las personas archivadas', async () => {
  const a = await guest('Uno Test');
  const b = await guest('Dos Test');
  const c = await guest('Tres Test');
  const { rows: [group] } = await db.query(
    'select * from public.add_invitation_members($1::uuid, $2::bigint[], $3::jsonb, $4)',
    [a.invitation.id, [b.id, c.id], '[]', 'Familia Test']);
  await db.query('select public.archive_invitation_guest($1)', [b.id]);

  const { rows: [{ n }] } = await db.query('select public.split_invitation($1) as n', [group.invitation_id]);
  assert.equal(n, 2);
  const ghosts = await db.query(`select 1 from public.invitations i
    join public.invitation_members im on im.invitation_id = i.id and im.active
    join public.guests g on g.id = im.guest_id
    where i.status = 'active' and g.archived_at is not null`);
  assert.equal(ghosts.rows.length, 0);
});

test('SQL: no se puede borrar ni rechazar la confirmación de quien ya entró', async () => {
  const a = await guest('Uno Test');
  await db.query("insert into public.rsvp_respuestas(guest_id, estado) values ($1, 'confirmado')", [a.id]);
  const { rows: [member] } = await db.query(
    'select public_id from public.invitation_members where guest_id = $1 and active', [a.id]);
  await db.query('select public.register_invitation_checkins($1::uuid, $2::uuid[], $3, gen_random_uuid())',
    [a.invitation.pass_token, [member.public_id], 'Recepcion']);

  await assert.rejects(db.query('delete from public.rsvp_respuestas where guest_id = $1', [a.id]), { code: '23505' });
  await assert.rejects(
    db.query("update public.rsvp_respuestas set estado = 'no_asiste' where guest_id = $1", [a.id]), { code: '23505' });
  // Reconfirmar (sin cambiar el estado) sigue permitido.
  await db.query("update public.rsvp_respuestas set estado = 'confirmado', mensaje = 'ok' where guest_id = $1", [a.id]);
  const { rows } = await db.query('select count(*)::int as n from public.invitation_checkins where guest_id = $1', [a.id]);
  assert.equal(rows[0].n, 1);
});

test('SQL: quien no ha entrado sí puede cambiar o borrar su respuesta', async () => {
  const a = await guest('Uno Test');
  await db.query("insert into public.rsvp_respuestas(guest_id, estado) values ($1, 'confirmado')", [a.id]);
  await db.query("update public.rsvp_respuestas set estado = 'no_asiste' where guest_id = $1", [a.id]);
  await db.query('delete from public.rsvp_respuestas where guest_id = $1', [a.id]);
});

test('SQL: el teléfono de la respuesta sigue al del invitado', async () => {
  const a = await guest('Uno Test');
  await db.query("update public.guests set telefono = '809-000-0000' where id = $1", [a.id]);
  await db.query("insert into public.rsvp_respuestas(guest_id, estado, telefono) values ($1, 'confirmado', '809-000-0000')", [a.id]);
  await db.query("update public.guests set telefono = '829-999-9999' where id = $1", [a.id]);
  const { rows: [r] } = await db.query('select telefono from public.rsvp_respuestas where guest_id = $1', [a.id]);
  assert.equal(r.telefono, '829-999-9999');
});
