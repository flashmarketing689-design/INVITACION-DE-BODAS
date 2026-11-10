/**
 * Lógica del módulo de mesas (sin acceso a red ni a disco, para poder probarla).
 *
 * Cada mesa tiene una sección (categoría + lado), por ejemplo "Familia cercana
 * de la novia" o "Iglesia". La organización automática lleva a cada invitación
 * (pareja/familia) completa a la mesa de su sección y, si esa mesa se llena,
 * al lugar más parecido, avisando cuando queda fuera de su sección.
 *
 * - buildPeople: convierte las invitaciones en la lista de personas a sentar.
 * - planAutoAssignment: reparte a quienes no tienen mesa.
 * - applyMove / applyPlan / releaseTable / applyTablePatch: operaciones puras
 *   sobre el estado local { tables, assignments } (modo sin Supabase).
 */

const DEFAULT_TABLE_COUNT = 12;
const DEFAULT_CAPACITY = 10;

const SECTION_CATEGORIES = ['familia_cercana', 'familiares', 'participantes', 'iglesia', 'amigos'];
const SIDES = ['novia', 'novio'];
const FAMILY_CATEGORIES = new Set(['familia_cercana', 'familiares']);
// Orden en que se acomodan los grupos: primero los más específicos.
const CATEGORY_PRIORITY = SECTION_CATEGORIES;

const CATEGORY_LABELS = {
  familia_cercana: 'Familia cercana',
  familiares: 'Familiares',
  participantes: 'Participantes de la boda',
  iglesia: 'Iglesia',
  amigos: 'Amigos',
};
const SIDE_LABELS = { novia: 'de la novia', novio: 'del novio' };

/** Orden de las 12 mesas de la boda (el mismo que aplica la migración 012). */
const DEFAULT_SECTIONS = [
  ['familia_cercana', 'novia'], ['familia_cercana', 'novio'],
  ['familiares', 'novia'], ['familiares', 'novia'],
  ['familiares', 'novio'], ['familiares', 'novio'],
  ['participantes', null],
  ['iglesia', null], ['iglesia', null],
  ['amigos', 'novia'],
  ['amigos', null], ['amigos', null],
];

class TableError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TableError';
    this.code = code;
    this.details = details || null;
  }
}

function sectionLabel(category, side) {
  if (!category) return 'Cualquier invitado';
  const base = CATEGORY_LABELS[category] || category;
  return side ? `${base} ${SIDE_LABELS[side]}` : base;
}

function defaultTables() {
  return Array.from({ length: DEFAULT_TABLE_COUNT }, (_, index) => {
    const [category, side] = DEFAULT_SECTIONS[index];
    return { id: index + 1, name: `Mesa ${index + 1}`, capacity: DEFAULT_CAPACITY,
      is_main: FAMILY_CATEGORIES.has(category), category, side };
  });
}

/** Completa las secciones de un estado local guardado antes de que existieran. */
function ensureSections(state) {
  const defaults = defaultTables();
  return {
    ...state,
    tables: state.tables.map((table) => {
      if (table.category !== undefined) return table;
      const base = defaults.find((row) => row.id === table.id);
      return { ...table, category: base?.category ?? null, side: base?.side ?? null,
        is_main: base ? base.is_main : Boolean(table.is_main) };
    }),
  };
}

/** Una persona se puede sentar si está identificada individualmente. */
function buildPeople(invitations, assignments, cercanaIds = new Set()) {
  const tableByGuest = assignments instanceof Map
    ? assignments
    : new Map((assignments || []).map((row) => [String(row.guest_id), row.table_id]));
  const close = cercanaIds instanceof Set ? cercanaIds : new Set(cercanaIds);
  const people = [];
  for (const invitation of invitations || []) {
    const startAt = people.length;
    for (const member of invitation.members || []) {
      const legacy = Boolean(invitation.needs_review) || (Number(member.cantidad_personas) || 1) > 1;
      people.push({
        id: Number(member.guest_id),
        nombre: member.nombre,
        pertenece: member.pertenece || null,
        categoria: member.categoria || null,
        cercana: member.categoria === 'familiares' && close.has(Number(member.guest_id)),
        estado_rsvp: member.estado_rsvp || null,
        invitation_id: invitation.id,
        invitation_name: invitation.display_name,
        group_type: invitation.group_type,
        table_id: tableByGuest.get(String(member.guest_id)) ?? null,
        seatable: !legacy,
        reason: legacy ? 'Registro antiguo con varios cupos: identifica a cada persona primero.' : null,
      });
    }
    const members = people.slice(startAt);
    if (members.length) {
      const section = groupSection(classifyGroup(members));
      for (const person of members) {
        person.section_key = section.key;
        person.section_label = section.label;
        person.section_order = section.order;
        person.section_category = section.category;
      }
    }
  }
  return people;
}

const isDeclined = (person) => person.estado_rsvp === 'no_asiste';

/** Sección natural de una persona (los compañeros se sientan con los amigos). */
function sectionCategoryOf(person) {
  if (person.categoria === 'familiares') return person.cercana ? 'familia_cercana' : 'familiares';
  if (person.categoria === 'participantes' || person.categoria === 'iglesia') return person.categoria;
  return 'amigos';
}

function majority(values, tieBreak) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const top = Math.max(...counts.values());
  const winners = [...counts].filter(([, count]) => count === top).map(([value]) => value);
  return winners.length === 1 ? winners[0] : tieBreak(winners);
}

/** Sección de una invitación completa: la categoría y el lado que predominan. */
function classifyGroup(members) {
  const category = majority(members.map(sectionCategoryOf),
    (winners) => [...winners].sort((a, b) => CATEGORY_PRIORITY.indexOf(a) - CATEGORY_PRIORITY.indexOf(b))[0]);
  const sides = members.map((person) => person.pertenece).filter(Boolean);
  const side = sides.length ? majority(sides, () => 'mixed') : 'mixed';
  return { category, side };
}

/** Qué tan lejos de su sección queda un grupo en una mesa (0 = es su mesa). */
function sectionCost(group, table, occupantSide) {
  let cost;
  const sideFits = !table.side || group.side === 'mixed' || table.side === group.side;
  if (!table.category) cost = 40; // mesa sin sección: sirve, pero después de las específicas
  else if (table.category === group.category) cost = sideFits ? (table.side ? 0 : 5) : 150;
  else if (FAMILY_CATEGORIES.has(table.category) && FAMILY_CATEGORIES.has(group.category)) cost = sideFits ? 50 : 200;
  else cost = FAMILY_CATEGORIES.has(table.category) ? 800 : 500; // no ocupar mesas de familia con otros
  // En mesas de ambos lados, preferir sentar juntos a los del mismo lado.
  if (!table.side && occupantSide && occupantSide !== 'mixed' && group.side !== 'mixed' && occupantSide !== group.side) cost += 20;
  return cost;
}

// Las categorías con mesas por lado se dividen en novia / novio / ambos lados.
const SIDED_CATEGORIES = new Set(['familia_cercana', 'familiares', 'amigos']);

/**
 * Sección en la que se muestra una invitación en la lista de "Sin mesa": la misma
 * que usa la organización automática (categoría y lado predominantes del grupo).
 */
function groupSection({ category, side }) {
  const sided = SIDED_CATEGORIES.has(category);
  const lado = sided && SIDES.includes(side) ? side : null;
  const key = lado ? `${category}|${lado}` : (sided ? `${category}|mixed` : category);
  const label = lado ? sectionLabel(category, lado) : (sided ? `${CATEGORY_LABELS[category]} (ambos lados)` : CATEGORY_LABELS[category]);
  const order = CATEGORY_PRIORITY.indexOf(category) * 10 + (lado === 'novia' ? 0 : lado === 'novio' ? 1 : 2);
  return { key, label, order, category };
}

function tableCounts(tables, people) {
  const seated = new Map(tables.map((table) => [table.id, []]));
  for (const person of people) {
    if (person.table_id != null && seated.has(person.table_id)) seated.get(person.table_id).push(person);
  }
  return seated;
}

/**
 * Reparte a las personas sin mesa. Nunca mueve a quien ya está sentado.
 * Devuelve { assignments: [{guest_id, table_id}], warnings: [...] }.
 */
function planAutoAssignment(people, tables) {
  const seatedByTable = tableCounts(tables, people);
  const free = new Map(tables.map((table) => [table.id, table.capacity - seatedByTable.get(table.id).length]));
  const occupant = new Map(tables.map((table) => {
    const seated = seatedByTable.get(table.id);
    const sides = seated.map((person) => person.pertenece).filter(Boolean);
    return [table.id, sides.length ? majority(sides, () => 'mixed') : null];
  }));
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const order = tables.map((table) => table.id);

  const groups = new Map();
  for (const person of people) {
    if (!person.seatable) continue;
    if (!groups.has(person.invitation_id)) groups.set(person.invitation_id, { id: person.invitation_id, name: person.invitation_name, members: [] });
    groups.get(person.invitation_id).members.push(person);
  }
  const work = [];
  for (const group of groups.values()) {
    const unseated = group.members.filter((person) => person.table_id == null && !isDeclined(person));
    if (!unseated.length) continue;
    const seated = group.members.filter((person) => person.table_id != null);
    const anchor = seated.length
      ? [...seated.reduce((map, person) => map.set(person.table_id, (map.get(person.table_id) || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
      : null;
    work.push({ id: group.id, name: group.name, members: group.members,
      unseated: unseated.sort((a, b) => a.id - b.id), anchor, ...classifyGroup(group.members) });
  }
  // Primero se completan los grupos que ya tienen a alguien sentado; luego, por
  // sección (de la más específica a la más general) y los más numerosos primero.
  work.sort((a, b) => (b.anchor != null) - (a.anchor != null)
    || CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category)
    || b.unseated.length - a.unseated.length
    || String(a.name).localeCompare(String(b.name), 'es')
    || String(a.id).localeCompare(String(b.id)));

  const assignments = [];
  const warnings = [];
  const costOf = (group, tableId) => sectionCost(group, tableById.get(tableId), occupant.get(tableId));

  for (const group of work) {
    const startAt = assignments.length;
    let worst = 0;
    let pending = group.unseated;
    const place = (members, tableId, scored = true) => {
      for (const person of members) assignments.push({ guest_id: person.id, table_id: tableId });
      free.set(tableId, free.get(tableId) - members.length);
      if (scored) worst = Math.max(worst, costOf(group, tableId));
      const side = occupant.get(tableId);
      if (side == null) occupant.set(tableId, group.side);
      else if (side !== group.side) occupant.set(tableId, 'mixed');
    };

    // Quien ya tiene a alguien sentado completa su grupo en esa mesa (decisión del usuario).
    if (group.anchor != null && free.get(group.anchor) > 0) {
      const here = pending.slice(0, free.get(group.anchor));
      place(here, group.anchor, false);
      pending = pending.slice(here.length);
    }

    if (pending.length) {
      const fits = order.filter((id) => free.get(id) >= pending.length);
      if (fits.length) {
        fits.sort((a, b) => costOf(group, a) - costOf(group, b) || (free.get(a) - pending.length) - (free.get(b) - pending.length) || a - b);
        place(pending, fits[0]);
        pending = [];
      } else {
        // Ninguna mesa tiene lugar para todos: se reparte entre las más cercanas a su sección.
        const open = order.filter((id) => free.get(id) > 0)
          .sort((a, b) => costOf(group, a) - costOf(group, b) || free.get(b) - free.get(a) || a - b);
        for (const tableId of open) {
          if (!pending.length) break;
          const chunk = pending.slice(0, free.get(tableId));
          place(chunk, tableId);
          pending = pending.slice(chunk.length);
        }
      }
    }

    if (pending.length) {
      warnings.push({ type: 'no_space', invitation_id: group.id, name: group.name, count: pending.length,
        message: `No hay lugares libres para ${pending.length} persona${pending.length === 1 ? '' : 's'} de "${group.name}".` });
    }
    const placed = assignments.slice(startAt);
    const tablesUsed = new Set([
      ...group.members.filter((person) => person.table_id != null).map((person) => person.table_id),
      ...placed.map((row) => row.table_id),
    ]);
    if (tablesUsed.size > 1) {
      warnings.push({ type: 'split', invitation_id: group.id, name: group.name, count: group.members.length,
        message: `"${group.name}" no cabe junta en una sola mesa y quedó repartida en ${tablesUsed.size}.` });
    }
    if (placed.length && worst >= 150) {
      const where = [...new Set(placed.map((row) => tableById.get(row.table_id).name))].join(', ');
      const natural = sectionLabel(group.category, group.side === 'mixed' ? null : group.side);
      warnings.push({ type: 'off_section', invitation_id: group.id, name: group.name, count: placed.length,
        message: `"${group.name}" (${natural}) no cupo en su sección y se sentó en ${where}.` });
    }
  }
  return { assignments, warnings };
}

/* ── Estado local (modo sin Supabase) ── */

function cloneState(state) {
  return { tables: state.tables.map((table) => ({ ...table })), assignments: state.assignments.map((row) => ({ ...row })) };
}

function seatedAt(state, tableId, exceptIds = new Set()) {
  return state.assignments.filter((row) => row.table_id === tableId && !exceptIds.has(row.guest_id)).length;
}

function seatsAvailable(state, tableId) {
  const table = state.tables.find((row) => row.id === tableId);
  if (!table) throw new TableError('NOT_FOUND', 'La mesa no existe.');
  return table.capacity - seatedAt(state, tableId);
}

function applyMove(state, guestIds, tableId) {
  const next = cloneState(state);
  const ids = [...new Set(guestIds.map(Number))];
  if (tableId == null) {
    next.assignments = next.assignments.filter((row) => !ids.includes(row.guest_id));
    return next;
  }
  const table = next.tables.find((row) => row.id === tableId);
  if (!table) throw new TableError('NOT_FOUND', 'La mesa no existe.');
  const incoming = ids.filter((id) => !next.assignments.some((row) => row.guest_id === id && row.table_id === tableId));
  const free = table.capacity - seatedAt(next, tableId);
  if (incoming.length > free) {
    throw new TableError('TABLE_FULL',
      `${table.name} solo tiene ${free} lugar${free === 1 ? '' : 'es'} libre${free === 1 ? '' : 's'} y se necesitan ${incoming.length}.`,
      { table_id: tableId, free, needed: incoming.length });
  }
  for (const id of incoming) {
    const existing = next.assignments.find((row) => row.guest_id === id);
    if (existing) existing.table_id = tableId;
    else next.assignments.push({ guest_id: id, table_id: tableId });
  }
  return next;
}

function applyPlan(state, plan) {
  const next = cloneState(state);
  for (const { guest_id: guestId, table_id: tableId } of plan) {
    const table = next.tables.find((row) => row.id === tableId);
    if (!table) throw new TableError('NOT_FOUND', 'La mesa no existe.');
    const existing = next.assignments.find((row) => row.guest_id === guestId);
    if (existing && existing.table_id === tableId) continue;
    if (table.capacity - seatedAt(next, tableId) < 1) {
      throw new TableError('TABLE_FULL', `${table.name} ya no tiene lugares libres.`, { table_id: tableId });
    }
    if (existing) existing.table_id = tableId;
    else next.assignments.push({ guest_id: guestId, table_id: tableId });
  }
  return next;
}

function releaseTable(state, tableId) {
  const next = cloneState(state);
  next.assignments = tableId == null ? [] : next.assignments.filter((row) => row.table_id !== tableId);
  return next;
}

/**
 * Valida un cambio de mesa. `current` es la mesa actual: permite comprobar que
 * un lado no quede sin categoría y calcular is_main (las mesas de familia).
 */
function validateTablePatch(patch, current = {}) {
  const clean = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40) throw new TableError('INVALID', 'El nombre de la mesa debe tener entre 1 y 40 caracteres.');
    clean.name = name;
  }
  if (patch.capacity !== undefined) {
    const capacity = Number(patch.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) {
      throw new TableError('INVALID', 'La capacidad debe ser un número entre 1 y 30.');
    }
    clean.capacity = capacity;
  }
  if (patch.category !== undefined || patch.side !== undefined) {
    const category = patch.category !== undefined ? patch.category : (current.category ?? null);
    let side = patch.side !== undefined ? patch.side : (current.side ?? null);
    if (category !== null && !SECTION_CATEGORIES.includes(category)) throw new TableError('INVALID', 'Sección de mesa no válida.');
    if (category === null) side = null;
    if (side !== null && !SIDES.includes(side)) throw new TableError('INVALID', 'Lado no válido: usa novia o novio.');
    clean.category = category;
    clean.side = side;
    clean.is_main = category !== null && FAMILY_CATEGORIES.has(category);
  }
  if (!Object.keys(clean).length) throw new TableError('INVALID', 'No hay cambios que guardar.');
  return clean;
}

function applyTablePatch(state, tableId, patch) {
  const next = cloneState(state);
  const table = next.tables.find((row) => row.id === tableId);
  if (!table) throw new TableError('NOT_FOUND', 'La mesa no existe.');
  if (patch.capacity !== undefined && patch.capacity < seatedAt(next, tableId)) {
    throw new TableError('TABLE_CAPACITY',
      `${table.name} ya tiene ${seatedAt(next, tableId)} personas; mueve a alguien antes de reducir su capacidad.`);
  }
  Object.assign(table, patch);
  return next;
}

/** Quita asignaciones de personas que ya no existen o fueron eliminadas. */
function pruneAssignments(state, activeGuestIds) {
  const active = new Set([...activeGuestIds].map(Number));
  const next = cloneState(state);
  next.assignments = next.assignments.filter((row) => active.has(row.guest_id));
  return next;
}

module.exports = {
  TableError, SECTION_CATEGORIES, SIDES, DEFAULT_SECTIONS, sectionLabel, defaultTables, ensureSections,
  buildPeople, classifyGroup, groupSection, sectionCost, planAutoAssignment, isDeclined,
  applyMove, applyPlan, releaseTable, validateTablePatch, applyTablePatch,
  pruneAssignments, seatsAvailable, cloneState,
};
