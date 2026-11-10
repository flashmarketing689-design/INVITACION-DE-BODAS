const test = require('node:test');
const assert = require('node:assert/strict');
const tables = require('../lib/tables');

let nextId = 1;
function group(name, count, { categoria = 'familiares', pertenece = 'novia', cercana = false, estado = null, seatable = true } = {}) {
  const invitation_id = `inv-${name}`;
  return Array.from({ length: count }, (_, index) => ({
    id: nextId++, nombre: `${name} ${index + 1}`, pertenece, categoria, cercana, estado_rsvp: estado,
    invitation_id, invitation_name: name, group_type: count === 1 ? 'individual' : count === 2 ? 'couple' : 'family',
    table_id: null, seatable,
  }));
}
const run = (people, state = tables.defaultTables()) => tables.planAutoAssignment(people, state);
const tableOf = (plan, person) => plan.assignments.find((row) => row.guest_id === person.id)?.table_id;
const tablesOf = (plan, people) => [...new Set(people.map((person) => tableOf(plan, person)))].sort((a, b) => a - b);
const perTable = (plan) => plan.assignments.reduce((map, row) => map.set(row.table_id, (map.get(row.table_id) || 0) + 1), new Map());

test('las 12 mesas siguen el orden pedido', () => {
  const labels = tables.defaultTables().map((table) => `${table.name}: ${tables.sectionLabel(table.category, table.side)}`);
  assert.deepEqual(labels, [
    'Mesa 1: Familia cercana de la novia', 'Mesa 2: Familia cercana del novio',
    'Mesa 3: Familiares de la novia', 'Mesa 4: Familiares de la novia',
    'Mesa 5: Familiares del novio', 'Mesa 6: Familiares del novio',
    'Mesa 7: Participantes de la boda', 'Mesa 8: Iglesia', 'Mesa 9: Iglesia',
    'Mesa 10: Amigos de la novia', 'Mesa 11: Amigos', 'Mesa 12: Amigos',
  ]);
  assert.ok(tables.defaultTables().every((table) => table.capacity === 10));
  assert.deepEqual(tables.defaultTables().filter((table) => table.is_main).map((table) => table.id), [1, 2, 3, 4, 5, 6]);
});

test('cada sección va a su mesa', () => {
  const closeBride = group('Cercana Novia', 4, { cercana: true, pertenece: 'novia' });
  const closeGroom = group('Cercana Novio', 4, { cercana: true, pertenece: 'novio' });
  const famBride = group('Fam Novia', 5, { pertenece: 'novia' });
  const famGroom = group('Fam Novio', 5, { pertenece: 'novio' });
  const party = group('Participantes', 3, { categoria: 'participantes' });
  const church = group('Iglesia A', 4, { categoria: 'iglesia' });
  const friendsBride = group('Amigas Novia', 3, { categoria: 'amigos', pertenece: 'novia' });
  const friendsGroom = group('Amigos Novio', 3, { categoria: 'amigos', pertenece: 'novio' });
  const coworkers = group('Companeros', 2, { categoria: 'companeros', pertenece: 'novio' });
  const plan = run([closeBride, closeGroom, famBride, famGroom, party, church, friendsBride, friendsGroom, coworkers].flat());
  assert.deepEqual(tablesOf(plan, closeBride), [1]);
  assert.deepEqual(tablesOf(plan, closeGroom), [2]);
  assert.deepEqual(tablesOf(plan, famBride), [3]);
  assert.deepEqual(tablesOf(plan, famGroom), [5]);
  assert.deepEqual(tablesOf(plan, party), [7]);
  assert.deepEqual(tablesOf(plan, church), [8]);
  assert.deepEqual(tablesOf(plan, friendsBride), [10]);
  assert.deepEqual(tablesOf(plan, friendsGroom), [11], 'amigos del novio van a las mesas de "Amigos"');
  assert.deepEqual(tablesOf(plan, coworkers), [11], 'los compañeros se sientan con los amigos');
  assert.deepEqual(plan.warnings, []);
});

test('los familiares que no son cercanos van a las mesas de familiares, no a las de familia cercana', () => {
  const people = [...group('Tios Novia', 6, { pertenece: 'novia' }), ...group('Tios Novio', 6, { pertenece: 'novio' })];
  const plan = run(people);
  assert.deepEqual(tablesOf(plan, people.slice(0, 6)), [3]);
  assert.deepEqual(tablesOf(plan, people.slice(6)), [5]);
});

test('las parejas y familias siempre quedan completas en la misma mesa', () => {
  const people = [...group('Perez', 4, { cercana: true }), ...group('Gomez', 2, { pertenece: 'novio' }),
    ...group('Amigos A', 3, { categoria: 'amigos' }), ...group('Solo', 1, { categoria: 'iglesia' }), ...group('Ruiz', 6)];
  const plan = run(people);
  assert.equal(plan.assignments.length, people.length);
  for (const name of ['Perez', 'Gomez', 'Amigos A', 'Ruiz']) {
    const members = people.filter((person) => person.invitation_name === name);
    assert.equal(tablesOf(plan, members).length, 1, `${name} separado`);
  }
});

test('cuando una sección se llena, los familiares siguen en la familia más parecida sin separar grupos', () => {
  // 3 familias de 9 de la novia: mesa 3, mesa 4 y la tercera junto a "familia cercana de la novia" (mesa 1).
  const a = group('Fam A', 9), b = group('Fam B', 9), c = group('Fam C', 9);
  const plan = run([a, b, c].flat());
  assert.deepEqual([tablesOf(plan, a), tablesOf(plan, b), tablesOf(plan, c)], [[3], [4], [1]]);
  assert.deepEqual(plan.warnings, [], 'quedar en una sección parecida no genera aviso');
});

test('si no hay una sección parecida con lugar, se avisa dónde se sentó', () => {
  const groups = ['A', 'B', 'C', 'D'].map((letter) => group(`Novio ${letter}`, 9, { pertenece: 'novio' }));
  const plan = run(groups.flat());
  assert.deepEqual(groups.map((people) => tablesOf(plan, people)[0]), [5, 6, 2, 3]);
  const warning = plan.warnings.find((item) => item.type === 'off_section');
  assert.equal(warning.name, 'Novio D');
  assert.match(warning.message, /Mesa 3/);
});

test('iglesia, participantes y amigos nunca ocupan las mesas de familia mientras haya otro lugar', () => {
  const people = [...group('Iglesia A', 8, { categoria: 'iglesia' }), ...group('Iglesia B', 8, { categoria: 'iglesia' }),
    ...group('Iglesia C', 8, { categoria: 'iglesia' }), ...group('Particip', 9, { categoria: 'participantes' }),
    ...group('Particip 2', 9, { categoria: 'participantes' })];
  const plan = run(people);
  assert.equal(plan.assignments.length, people.length);
  assert.ok(plan.assignments.every((row) => row.table_id >= 7), 'ninguno en las mesas 1 a 6');
});

test('un grupo de más de 10 se reparte en mesas cercanas y avisa', () => {
  const people = group('Gran Familia', 13, { pertenece: 'novio' });
  const plan = run(people);
  assert.equal(plan.assignments.length, 13);
  assert.ok(plan.warnings.some((warning) => warning.type === 'split' && warning.name === 'Gran Familia'));
  assert.ok([...perTable(plan).values()].every((count) => count <= 10));
  assert.ok(tablesOf(plan, people).every((id) => [2, 5, 6].includes(id)), `mesas: ${tablesOf(plan, people)}`);
});

test('nunca se pasa de 10 por mesa', () => {
  const people = [];
  const kinds = [{ categoria: 'familiares' }, { categoria: 'amigos' }, { categoria: 'iglesia' }, { categoria: 'participantes' }];
  for (let i = 0; i < 30; i += 1) people.push(...group(`G${i}`, 1 + (i % 4), { ...kinds[i % 4], pertenece: i % 2 ? 'novia' : 'novio', cercana: i % 8 === 0 }));
  const plan = run(people);
  assert.equal(plan.assignments.length, people.length);
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
  const plan = run(family);
  assert.ok(!plan.assignments.some((row) => row.guest_id === family[0].id));
  for (const person of family.slice(1)) assert.equal(tableOf(plan, person), 6);
});

test('si la mesa del grupo está llena, el resto se sienta en su sección y avisa que quedó repartido', () => {
  const seated = group('Relleno', 8, { categoria: 'iglesia' });
  seated.forEach((person) => { person.table_id = 4; });
  const family = group('Lopez', 4);
  family[0].table_id = 4;
  const plan = run([...seated, ...family]);
  assert.equal(plan.assignments.length, 3);
  assert.ok(plan.warnings.some((warning) => warning.type === 'split'));
});

test('una invitación mixta va con el lado que predomina', () => {
  const mixed = [...group('Mixta', 3, { pertenece: 'novio' }), ...group('Mixta', 1, { pertenece: 'novia' })];
  mixed.forEach((person) => { person.invitation_id = 'inv-Mixta'; });
  assert.equal(tables.classifyGroup(mixed).side, 'novio');
  assert.deepEqual(tablesOf(run(mixed), mixed), [5]);
  const even = [...group('Par', 1, { pertenece: 'novio' }), ...group('Par', 1, { pertenece: 'novia' })];
  assert.equal(tables.classifyGroup(even).side, 'mixed');
});

test('las mesas editadas se respetan: sin sección sirven de último recurso', () => {
  const state = tables.defaultTables();
  state[11] = { ...state[11], category: null, side: null, is_main: false };
  const only = state.slice(11);
  const people = group('Cualquiera', 3, { categoria: 'iglesia' });
  assert.deepEqual(tablesOf(tables.planAutoAssignment(people, only), people), [12]);
});

test('no hay lugares: se llenan los que hay y se avisa de quién quedó fuera', () => {
  const state = tables.defaultTables().slice(0, 1);
  const result = tables.planAutoAssignment([...group('A', 6), ...group('B', 6)], state);
  assert.equal(result.assignments.length, 10);
  const noSpace = result.warnings.find((warning) => warning.type === 'no_space');
  assert.equal(noSpace.name, 'B');
  assert.equal(noSpace.count, 2);
});

test('el resultado es estable: mismos datos, mismo plan', () => {
  const people = [...group('Perez', 4), ...group('Gomez', 3, { categoria: 'amigos' }), ...group('Iglesia', 5, { categoria: 'iglesia' })];
  assert.deepEqual(run(people), run(JSON.parse(JSON.stringify(people))));
});

test('operaciones del modo local respetan capacidad, atomicidad y secciones', () => {
  let state = { tables: tables.defaultTables(), assignments: [] };
  state = tables.applyMove(state, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.throws(() => tables.applyMove(state, [11], 3), { code: 'TABLE_FULL' });
  assert.throws(() => tables.applyMove(state, [11, 12], 3), /necesitan 2/);
  assert.equal(state.assignments.length, 10, 'el original no se modifica');
  assert.equal(tables.applyMove(state, [1], 3).assignments.length, 10, 'repetir no falla en mesa llena');
  assert.equal(tables.applyMove(state, [1, 2], null).assignments.length, 8);
  assert.equal(tables.releaseTable(state, 3).assignments.length, 0);
  assert.throws(() => tables.applyTablePatch(state, 3, { capacity: 5 }), { code: 'TABLE_CAPACITY' });

  const table = state.tables[2];
  const patch = tables.validateTablePatch({ name: '  Mesa   de honor ', category: 'iglesia', side: null }, table);
  assert.deepEqual(patch, { name: 'Mesa de honor', category: 'iglesia', side: null, is_main: false });
  assert.equal(tables.validateTablePatch({ category: 'familia_cercana', side: 'novio' }, table).is_main, true);
  assert.deepEqual(tables.validateTablePatch({ category: null, side: 'novia' }, table), { category: null, side: null, is_main: false });
  assert.deepEqual(tables.validateTablePatch({ side: 'novio' }, table).category, 'familiares', 'el lado conserva la categoría actual');
  assert.throws(() => tables.validateTablePatch({ category: 'otra' }, table), { code: 'INVALID' });
  assert.throws(() => tables.validateTablePatch({ side: 'ambos' }, table), { code: 'INVALID' });
  assert.throws(() => tables.validateTablePatch({ capacity: 0 }, table), { code: 'INVALID' });
  assert.throws(() => tables.validateTablePatch({ name: '' }, table), { code: 'INVALID' });
  assert.throws(() => tables.validateTablePatch({}, table), { code: 'INVALID' });
});

test('un estado local guardado antes de las secciones se completa con el orden pedido', () => {
  const old = { tables: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Mesa ${i + 1}`, capacity: 10, is_main: i < 2 })), assignments: [] };
  const fixed = tables.ensureSections(old);
  assert.equal(fixed.tables[0].category, 'familia_cercana');
  assert.equal(fixed.tables[9].side, 'novia');
  assert.equal(fixed.tables[2].is_main, true);
  const custom = tables.ensureSections({ tables: [{ id: 1, name: 'X', capacity: 4, category: null, side: null }], assignments: [] });
  assert.equal(custom.tables[0].category, null, 'una mesa ya editada no se pisa');
});

test('cada invitación se muestra en la sección de su grupo, en el mismo orden que las mesas', () => {
  const member = (guest_id, nombre, categoria, pertenece) => ({ guest_id, nombre, categoria, pertenece, estado_rsvp: null, cantidad_personas: 1 });
  const invitations = [
    { id: 'amigos-novio', display_name: 'Amigos', group_type: 'couple', members: [member(1, 'Amigo Uno', 'amigos', 'novio'), member(2, 'Companero Dos', 'companeros', 'novio')] },
    { id: 'iglesia', display_name: 'Coro', group_type: 'couple', members: [member(3, 'Coro Uno', 'iglesia', 'novia'), member(4, 'Coro Dos', 'iglesia', 'novio')] },
    { id: 'tios-novia', display_name: 'Tios', group_type: 'family', members: [member(5, 'Tio Uno', 'familiares', 'novia'), member(6, 'Tio Dos', 'familiares', 'novia')] },
    { id: 'padres', display_name: 'Padres', group_type: 'couple', members: [member(7, 'Padre Uno', 'familiares', 'novia'), member(8, 'Madre Uno', 'familiares', 'novia')] },
    { id: 'mixta', display_name: 'Mixta', group_type: 'couple', members: [member(9, 'Mixta Uno', 'familiares', 'novia'), member(10, 'Mixta Dos', 'familiares', 'novio')] },
    { id: 'part', display_name: 'Cortejo', group_type: 'individual', members: [member(11, 'Dama Honor', 'participantes', 'novia')] },
    { id: 'amiga-novia', display_name: 'Amiga', group_type: 'individual', members: [member(12, 'Amiga Novia', 'amigos', 'novia')] },
  ];
  const people = tables.buildPeople(invitations, [], new Set([7, 8]));
  const section = (id) => people.find((person) => person.id === id);
  assert.equal(section(7).section_key, 'familia_cercana|novia');
  assert.equal(section(5).section_key, 'familiares|novia');
  assert.equal(section(9).section_label, 'Familiares (ambos lados)');
  assert.equal(section(9).section_key, section(10).section_key, 'el grupo nunca se separa entre secciones');
  assert.equal(section(2).section_key, 'amigos|novio', 'los compañeros van con los amigos');
  assert.equal(section(3).section_key, 'iglesia', 'iglesia no se divide por lado');
  assert.equal(section(11).section_label, 'Participantes de la boda');
  const ordered = [...new Map(people.map((person) => [person.section_key, person])).values()]
    .sort((a, b) => a.section_order - b.section_order).map((person) => person.section_label);
  assert.deepEqual(ordered, ['Familia cercana de la novia', 'Familiares de la novia', 'Familiares (ambos lados)',
    'Participantes de la boda', 'Iglesia', 'Amigos de la novia', 'Amigos del novio']);
  assert.deepEqual(tables.groupSection({ category: 'familia_cercana', side: 'mixed' }).label, 'Familia cercana (ambos lados)');
});

test('el parentesco de los familiares: etiqueta por lado, implica familia cercana y se ordena', () => {
  const member = (guest_id, nombre, categoria, pertenece) => ({ guest_id, nombre, categoria, pertenece, estado_rsvp: null, cantidad_personas: 1 });
  const invitations = [
    { id: 'tios', display_name: 'Tios', group_type: 'couple', members: [member(1, 'Tio Uno', 'familiares', 'novia'), member(2, 'Tia Dos', 'familiares', 'novia')] },
    { id: 'hermanos', display_name: 'Hermanos', group_type: 'couple', members: [member(3, 'Hermano Uno', 'familiares', 'novia'), member(4, 'Hermana Dos', 'familiares', 'novia')] },
    { id: 'padres-novio', display_name: 'Padres del novio', group_type: 'couple', members: [member(5, 'Padre Novio', 'familiares', 'novio'), member(6, 'Madre Novio', 'familiares', 'novio')] },
    { id: 'amigo', display_name: 'Amigo', group_type: 'individual', members: [member(7, 'Amigo Uno', 'amigos', 'novia')] },
  ];
  const info = new Map([[3, { parentesco: 'hermano' }], [4, { parentesco: 'hermano' }], [5, { parentesco: 'padre' }], [6, { parentesco: 'madre' }], [7, { parentesco: 'madre' }]]);
  const people = tables.buildPeople(invitations, [], info);
  const byId = (id) => people.find((person) => person.id === id);
  assert.equal(byId(5).parentesco_label, 'Padre del novio');
  assert.equal(byId(6).parentesco_label, 'Madre del novio');
  assert.equal(byId(3).parentesco_label, 'Hermano(a) de la novia');
  assert.equal(byId(3).cercana, true, 'tener parentesco implica familia cercana');
  assert.equal(byId(1).cercana, false);
  assert.equal(byId(1).parentesco_label, null);
  assert.equal(byId(7).parentesco, null, 'solo los familiares tienen parentesco');
  assert.deepEqual([byId(6).parentesco_order, byId(3).parentesco_order, byId(1).parentesco_order], [0, 2, 999], 'madre, padre y hermano en el orden de la lista; sin parentesco al final');
  assert.equal(byId(3).section_key, 'familia_cercana|novia');
  assert.equal(byId(5).section_key, 'familia_cercana|novio');
  assert.equal(byId(1).section_key, 'familiares|novia');
  // Los hermanos de la novia van a la Mesa 1 y los padres del novio a la Mesa 2.
  const plan = tables.planAutoAssignment(people, tables.defaultTables());
  const tableOf = (id) => plan.assignments.find((row) => row.guest_id === id).table_id;
  assert.deepEqual([tableOf(3), tableOf(4), tableOf(5), tableOf(6), tableOf(1)], [1, 1, 2, 2, 3]);
  assert.equal(tables.kinshipLabel('tio', 'novia'), null);
  // La forma anterior (un conjunto de ids de familia cercana) sigue funcionando.
  assert.equal(tables.buildPeople(invitations, [], new Set([1]))[0].cercana, true);
});

test('los parentescos propios se etiquetan por lado y se ordenan según la lista', () => {
  const member = (guest_id, nombre, pertenece) => ({ guest_id, nombre, categoria: 'familiares', pertenece, estado_rsvp: null, cantidad_personas: 1 });
  const invitations = [{ id: 'a', display_name: 'Abuelos', group_type: 'couple', members: [member(1, 'Abuelo Uno', 'novio'), member(2, 'Hermana Dos', 'novia')] }];
  const kinships = [{ key: 'abuelo', name: 'Abuelo(a)', sort_order: 1 }, { key: 'hermano', name: 'Hermano(a)', sort_order: 2 }];
  const people = tables.buildPeople(invitations, [], new Map([[1, { parentesco: 'abuelo' }], [2, { parentesco: 'hermano' }]]), kinships);
  assert.deepEqual(people.map((p) => [p.parentesco_label, p.parentesco_order]), [['Abuelo(a) del novio', 0], ['Hermano(a) de la novia', 1]]);
  // Un parentesco que ya no existe en la lista se ignora (la persona sigue siendo familia cercana si estaba marcada).
  const quitado = tables.buildPeople(invitations, [], new Map([[1, { parentesco: 'madre', cercana: true }]]), kinships);
  assert.deepEqual([quitado[0].parentesco, quitado[0].cercana, quitado[0].parentesco_label], [null, true, null]);
});
