const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/roles');

const names = (state) => [...state.roles].sort((a, b) => a.sort_order - b.sort_order).map((role) => role.name);

test('los papeles iniciales son los seis pedidos, con descripción', () => {
  const state = R.defaultRoleState();
  assert.deepEqual(names(state), ['Padres que participan', 'Padrinos', 'Chambelanes', 'Damas de honor', 'Niña del cartel', 'Portador(a) de los anillos']);
  assert.ok(state.roles.every((role) => role.description && role.description.length > 10));
  assert.match(state.roles[4].description, /Ya viene la novia/);
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
  assert.equal(removed.roles.length, 6);
  assert.equal(removed.assignments.length, 0, 'las asignaciones se van con el papel');
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
  assert.deepEqual(state.assignments.map((row) => `${row.guest_id}:${row.role_id}`).sort(), ['10:5', '10:6', '11:5']);
  assert.throws(() => R.assign(state, 99, [1]), { code: 'NOT_FOUND' });
  state = R.unassign(state, 5, 10);
  assert.deepEqual(state.assignments.map((row) => `${row.guest_id}:${row.role_id}`).sort(), ['10:6', '11:5']);
  assert.equal(R.unassign(state, 5, 999).assignments.length, 2, 'quitar un papel que no tiene no falla');
});

test('reordenar deja el orden pedido y los demás al final', () => {
  const state = R.defaultRoleState();
  assert.deepEqual(names(R.reorder(state, [6, 5])).slice(0, 3), ['Portador(a) de los anillos', 'Niña del cartel', 'Padres que participan']);
  assert.deepEqual(R.reorder(state, [4, 3, 2, 1, 5, 6]).roles.map((role) => role.sort_order).sort(), [1, 2, 3, 4, 5, 6]);
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
  state = R.assign(state, 5, [1]);
  state = R.assign(state, 6, [1, 2]);
  state = R.assign(state, 1, [4]);
  const overview = R.buildOverview(state, people);
  assert.deepEqual(overview.summary, { roles: 6, with_role: 3, participants_without_role: 1, declined_with_role: 1 });
  assert.deepEqual(overview.people.find((p) => p.id === 1).role_ids, [5, 6], 'ordenados como la lista de papeles');
  assert.deepEqual(overview.roles.find((r) => r.id === 6).guest_ids, [1, 2]);
  assert.deepEqual(overview.roles[0].guest_ids, [4], 'los padres que participan incluyen a una familiar');
  assert.deepEqual(R.buildOverview(R.pruneAssignments(state, [1]), people.slice(0, 1)).roles.find((r) => r.id === 6).guest_ids, [1], 'se ignoran personas que ya no existen');
});
