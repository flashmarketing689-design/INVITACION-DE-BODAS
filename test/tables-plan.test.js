const test = require('node:test');
const assert = require('node:assert/strict');
const tables = require('../lib/tables');

let nextId = 1;
function group(name, count, { categoria = 'familiares', pertenece = 'novia', estado = null, seatable = true } = {}) {
  const invitation_id = `inv-${name}`;
  return Array.from({ length: count }, (_, index) => ({
    id: nextId++, nombre: `${name} ${index + 1}`, pertenece, categoria, estado_rsvp: estado,
    invitation_id, invitation_name: name, group_type: count === 1 ? 'individual' : count === 2 ? 'couple' : 'family',
    table_id: null, seatable,
  }));
}
const run = (people, state = tables.defaultTables()) => tables.planAutoAssignment(people, state);
const tableOf = (plan, person) => plan.assignments.find((row) => row.guest_id === person.id)?.table_id;
const perTable = (plan) => plan.assignments.reduce((map, row) => map.set(row.table_id, (map.get(row.table_id) || 0) + 1), new Map());

test('hay 12 mesas de 10 y las dos primeras son principales', () => {
  const defaults = tables.defaultTables();
  assert.equal(defaults.length, 12);
  assert.ok(defaults.every((table) => table.capacity === 10));
  assert.deepEqual(defaults.filter((table) => table.is_main).map((table) => table.id), [1, 2]);
});

test('cada pareja y familia queda completa en la misma mesa', () => {
  const people = [...group('Perez', 4), ...group('Gomez', 2), ...group('Amigos A', 3, { categoria: 'amigos' }),
    ...group('Solo', 1, { categoria: 'companeros' }), ...group('Ruiz', 6)];
  const plan = run(people);
  assert.equal(plan.assignments.length, people.length);
  for (const name of ['Perez', 'Gomez', 'Amigos A', 'Ruiz']) {
    const members = people.filter((person) => person.invitation_name === name);
    assert.equal(new Set(members.map((person) => tableOf(plan, person))).size, 1, `${name} separado`);
  }
  assert.deepEqual(plan.warnings, []);
});

test('los familiares van a las mesas principales y los demás a las otras', () => {
  const people = [...group('Perez', 5), ...group('Gomez', 4), ...group('Amigos A', 4, { categoria: 'amigos' }),
    ...group('Iglesia B', 3, { categoria: 'iglesia' })];
  const plan = run(people);
  for (const person of people) {
    const main = tableOf(plan, person) <= 2;
    assert.equal(main, person.categoria === 'familiares', `${person.nombre} en mesa ${tableOf(plan, person)}`);
  }
});

test('si las mesas principales se llenan, los familiares siguen en otras mesas sin separar grupos', () => {
  const people = [...group('Fam 1', 8), ...group('Fam 2', 8), ...group('Fam 3', 8)];
  const plan = run(people);
  assert.equal(plan.assignments.length, 24);
  for (const name of ['Fam 1', 'Fam 2', 'Fam 3']) {
    const members = people.filter((person) => person.invitation_name === name);
    assert.equal(new Set(members.map((person) => tableOf(plan, person))).size, 1);
  }
  assert.ok([...perTable(plan).values()].every((count) => count <= 10));
});

test('nunca se pasa de 10 por mesa y se empaqueta con pocas mesas', () => {
  const people = [];
  for (let i = 0; i < 20; i += 1) people.push(...group(`G${i}`, 1 + (i % 4), { categoria: i % 2 ? 'amigos' : 'familiares' }));
  const plan = run(people);
  assert.equal(plan.assignments.length, people.length);
  assert.ok([...perTable(plan).values()].every((count) => count <= 10));
  assert.ok(perTable(plan).size <= Math.ceil(people.length / 10) + 2, `usa ${perTable(plan).size} mesas`);
});

test('un grupo de más de 10 se reparte y avisa', () => {
  const people = group('Gran Familia', 13);
  const plan = run(people);
  assert.equal(plan.assignments.length, 13);
  assert.ok(plan.warnings.some((warning) => warning.type === 'split' && warning.name === 'Gran Familia'));
  assert.ok([...perTable(plan).values()].every((count) => count <= 10));
});

test('no sienta a quienes no asistirán ni a registros antiguos', () => {
  const declined = group('Declinan', 2, { estado: 'no_asiste' });
  const legacy = group('Antiguo', 1, { seatable: false });
  const mixed = group('Mixto', 3);
  mixed[2].estado_rsvp = 'no_asiste';
  const plan = run([...declined, ...legacy, ...mixed]);
  assert.deepEqual(plan.assignments.map((row) => row.guest_id).sort(), [mixed[0].id, mixed[1].id].sort());
});

test('no mueve a quien ya está sentado y completa su grupo en esa mesa', () => {
  const family = group('Lopez', 4);
  family[0].table_id = 6;
  const other = group('Otros', 2, { categoria: 'amigos' });
  const plan = run([...family, ...other]);
  assert.ok(!plan.assignments.some((row) => row.guest_id === family[0].id));
  for (const person of family.slice(1)) assert.equal(tableOf(plan, person), 6);
});

test('si la mesa del grupo está llena, el resto se sienta cerca y avisa', () => {
  const state = tables.defaultTables();
  const seated = group('Relleno', 8);
  seated.forEach((person) => { person.table_id = 4; });
  const family = group('Lopez', 4, { categoria: 'amigos' });
  family[0].table_id = 4;
  const plan = run([...seated, ...family], state);
  assert.equal(plan.assignments.length, 3);
  assert.ok(plan.warnings.some((warning) => warning.type === 'split'));
});

test('prefiere sentar juntos a los del mismo lado y avisa si no hay lugar', () => {
  const novio = group('Novio fam', 3, { categoria: 'amigos', pertenece: 'novio' });
  const novia = group('Novia fam', 3, { categoria: 'amigos', pertenece: 'novia' });
  const plan = run([...novio, ...novia]);
  assert.notEqual(tableOf(plan, novio[0]), tableOf(plan, novia[0]));

  const state = tables.defaultTables().slice(0, 1);
  const tooMany = [...group('A', 6), ...group('B', 6)];
  const result = tables.planAutoAssignment(tooMany, state);
  assert.equal(result.assignments.length, 10, 'se llenan los 10 lugares');
  const noSpace = result.warnings.find((warning) => warning.type === 'no_space');
  assert.equal(noSpace.name, 'B');
  assert.equal(noSpace.count, 2, 'dos personas quedan sin lugar');
});

test('el resultado es estable: mismos datos, mismo plan', () => {
  const people = [...group('Perez', 4), ...group('Gomez', 3), ...group('Amigos', 5, { categoria: 'amigos' })];
  assert.deepEqual(run(people), run(JSON.parse(JSON.stringify(people))));
});

test('operaciones del modo local respetan capacidad y atomicidad', () => {
  let state = { tables: tables.defaultTables(), assignments: [] };
  state = tables.applyMove(state, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.throws(() => tables.applyMove(state, [11], 3), { code: 'TABLE_FULL' });
  assert.throws(() => tables.applyMove(state, [11, 12], 3), /necesitan 2/);
  assert.equal(state.assignments.length, 10, 'el original no se modifica');
  const moved = tables.applyMove(state, [1], 4);
  assert.deepEqual(moved.assignments.find((row) => row.guest_id === 1), { guest_id: 1, table_id: 4 });
  assert.equal(tables.applyMove(state, [1], 3).assignments.length, 10, 'repetir no falla en mesa llena');
  assert.equal(tables.applyMove(state, [1, 2], null).assignments.length, 8);
  assert.equal(tables.releaseTable(state, 3).assignments.length, 0);
  assert.throws(() => tables.applyTablePatch(state, 3, { capacity: 5 }), { code: 'TABLE_CAPACITY' });
  assert.equal(tables.applyTablePatch(state, 3, tables.validateTablePatch({ name: '  Mesa   de honor ', is_main: true })).tables[2].name, 'Mesa de honor');
  assert.throws(() => tables.validateTablePatch({ capacity: 0 }), { code: 'INVALID' });
  assert.throws(() => tables.validateTablePatch({ name: '' }), { code: 'INVALID' });
});
