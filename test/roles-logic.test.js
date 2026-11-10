const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/roles');

const names = (state) => [...state.roles].sort((a, b) => a.sort_order - b.sort_order).map((role) => role.name);

test('los papeles iniciales: Novios y los seis del cortejo, con descripción', () => {
  const state = R.defaultRoleState();
  assert.deepEqual(names(state), ['Novios', 'Padres que participan', 'Padrinos', 'Chambelanes', 'Damas de honor', 'Niña del cartel', 'Portador(a) de los anillos']);
  assert.ok(state.roles.every((role) => role.description && role.description.length > 10));
  assert.match(state.roles.find((role) => role.name === 'Niña del cartel').description, /Ya viene la novia/);
  assert.deepEqual(state.members.map((m) => [m.nombre, m.pertenece]), [['Starlin Paulino Pérez', 'novio'], ['Reneisy', 'novia']]);
  assert.deepEqual(state.assignments.map((row) => `${row.guest_id}:${row.role_id}`), ['-1:1', '-2:1'], 'los novios tienen el papel Novios');
});

test('crear, renombrar y eliminar papeles con validación', () => {
  let state = R.defaultRoleState();
  state = R.createRole(state, { name: '  Pajecitos   y  flores ', description: 'Reparten pétalos.' });
  assert.equal(names(state).at(-1), 'Pajecitos y flores', 'normaliza los espacios y va al final');
  assert.throws(() => R.createRole(state, { name: 'DAMAS DE HONOR' }), { code: 'DUPLICATE' });
  assert.throws(() => R.createRole(state, { name: '   ' }), { code: 'INVALID' });
  assert.throws(() => R.createRole(state, { name: 'x'.repeat(61) }), { code: 'INVALID' });
  assert.throws(() => R.createRole(state, { name: 'Nuevo', description: 'x'.repeat(201) }), { code: 'INVALID' });
  const id = state.roles.at(-1).id;
  state = R.updateRole(state, id, { description: '' });
  assert.equal(state.roles.at(-1).description, null);
  assert.throws(() => R.updateRole(state, id, { name: 'padrinos' }), { code: 'DUPLICATE' });
  assert.throws(() => R.updateRole(state, id, {}), { code: 'INVALID' });
  assert.throws(() => R.updateRole(state, 999, { name: 'X' }), { code: 'NOT_FOUND' });
  assert.equal(R.updateRole(state, id, { name: 'Pajecitos y flores' }).roles.at(-1).name, 'Pajecitos y flores', 'puede conservar su propio nombre');
  state = R.assign(state, id, [1, 2]);
  const removed = R.deleteRole(state, id);
  assert.equal(removed.roles.length, 7);
  assert.equal(removed.assignments.some((row) => row.role_id === id), false, 'las asignaciones se van con el papel');
  assert.equal(removed.assignments.length, 2, 'las de los novios no se tocan');
  assert.throws(() => R.deleteRole(state, 999), { code: 'NOT_FOUND' });
});

test('hay un máximo de 40 papeles', () => {
  let state = R.defaultRoleState();
  for (let i = state.roles.length; i < R.MAX_ROLES; i += 1) state = R.createRole(state, { name: `Papel ${i}` });
  assert.equal(state.roles.length, 40);
  assert.throws(() => R.createRole(state, { name: 'Uno más' }), { code: 'INVALID' });
});

test('una persona puede tener varios papeles y repetir no duplica', () => {
  let state = R.defaultRoleState();
  state = R.assign(state, 5, [10]);
  state = R.assign(state, 6, [10]);
  state = R.assign(state, 5, [10, 11]);
  const mine = (st) => st.assignments.filter((row) => row.guest_id > 0).map((row) => `${row.guest_id}:${row.role_id}`).sort();
  assert.deepEqual(mine(state), ['10:5', '10:6', '11:5']);
  assert.throws(() => R.assign(state, 99, [1]), { code: 'NOT_FOUND' });
  state = R.unassign(state, 5, 10);
  assert.deepEqual(mine(state), ['10:6', '11:5']);
  assert.equal(mine(R.unassign(state, 5, 999)).length, 2, 'quitar un papel que no tiene no falla');
});

test('reordenar deja el orden pedido y los demás al final', () => {
  const state = R.defaultRoleState();
  assert.deepEqual(names(R.reorder(state, [7, 6])).slice(0, 3), ['Portador(a) de los anillos', 'Niña del cartel', 'Novios']);
  assert.deepEqual(R.reorder(state, [4, 3, 2, 1, 5, 6, 7]).roles.map((role) => role.sort_order).sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => R.reorder(state, [1, 1]), { code: 'INVALID' });
  assert.throws(() => R.reorder(state, [99]), { code: 'INVALID' });
});

test('el resumen cuenta personas con papel, participantes sin papel y quienes no asistirán', () => {
  const people = [
    { id: 1, nombre: 'Sofia Perez', categoria: 'participantes', estado_rsvp: 'confirmado' },
    { id: 2, nombre: 'Luis Gomez', categoria: 'participantes', estado_rsvp: 'no_asiste' },
    { id: 3, nombre: 'Ana Ruiz', categoria: 'participantes', estado_rsvp: null },
    { id: 4, nombre: 'Marta Diaz', categoria: 'familiares', estado_rsvp: null },
    { id: 5, nombre: 'Otro Amigo', categoria: 'amigos', estado_rsvp: null },
  ];
  let state = R.defaultRoleState();
  state = R.assign(state, 6, [1]);
  state = R.assign(state, 7, [1, 2]);
  state = R.assign(state, 2, [4]);
  const overview = R.buildOverview(state, people);
  assert.deepEqual(overview.summary, { roles: 7, with_role: 3, participants_without_role: 1, without_invitation: 0, declined_with_role: 1 });
  assert.deepEqual(overview.people.find((p) => p.id === 1).role_ids, [6, 7], 'ordenados como la lista de papeles');
  assert.deepEqual(overview.roles.find((r) => r.id === 7).guest_ids, [1, 2]);
  assert.deepEqual(overview.roles.find((r) => r.id === 2).guest_ids, [4], 'los padres que participan incluyen a una familiar');
  assert.deepEqual(R.buildOverview(R.pruneAssignments(state, [1]), people.slice(0, 1)).roles.find((r) => r.id === 7).guest_ids, [1], 'se ignoran personas que ya no existen');
});

test('personas sin invitación: se agregan, tienen papeles y no se pierden al limpiar invitados', () => {
  let state = R.defaultRoleState();
  state = R.addMember(state, { nombre: '  Padre   Oficiante ', pertenece: 'novio' });
  assert.deepEqual(state.members.at(-1), { id: 3, nombre: 'Padre Oficiante', pertenece: 'novio' });
  assert.throws(() => R.addMember(state, { nombre: 'X', pertenece: 'novio' }), { code: 'INVALID' });
  assert.throws(() => R.addMember(state, { nombre: 'Ana Perez', pertenece: 'otro' }), { code: 'INVALID' });
  state = R.assign(state, 3, [-3]);
  const people = [{ id: -1, nombre: 'Starlin', sin_invitacion: true }, { id: -2, nombre: 'Reneisy', sin_invitacion: true }, { id: -3, nombre: 'Padre Oficiante', sin_invitacion: true }, { id: 5, nombre: 'Ana Perez', categoria: 'amigos' }];
  const pruned = R.pruneAssignments(state, [5]);
  assert.equal(pruned.assignments.filter((row) => row.guest_id < 0).length, 3, 'limpiar invitados no toca a las personas sin invitación');
  const overview = R.buildOverview(pruned, people);
  assert.deepEqual(overview.roles.find((role) => role.name === 'Novios').guest_ids, [-1, -2]);
  assert.deepEqual(overview.summary, { roles: 7, with_role: 3, participants_without_role: 0, without_invitation: 3, declined_with_role: 0 });
  const removed = R.removeMember(pruned, 3);
  assert.equal(removed.members.length, 2);
  assert.equal(removed.assignments.some((row) => row.guest_id === -3), false, 'se quitan también sus papeles');
  assert.throws(() => R.removeMember(removed, 99), { code: 'NOT_FOUND' });
  let many = R.defaultRoleState();
  for (let i = many.members.length; i < R.MAX_MEMBERS; i += 1) many = R.addMember(many, { nombre: `Persona ${i}`, pertenece: 'novia' });
  assert.throws(() => R.addMember(many, { nombre: 'Una mas', pertenece: 'novia' }), { code: 'INVALID' });
});
