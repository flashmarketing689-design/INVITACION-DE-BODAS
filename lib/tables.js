/**
 * Lógica del módulo de mesas (sin acceso a red ni a disco, para poder probarla).
 *
 * - buildPeople: convierte las invitaciones en la lista de personas a sentar.
 * - planAutoAssignment: reparte a quienes no tienen mesa manteniendo juntos a
 *   cada grupo (pareja/familia) y llevando a los familiares a las mesas principales.
 * - applyMove / releaseGuests / updateTable: operaciones puras sobre el estado
 *   local { tables, assignments } que usa el modo sin Supabase.
 */

const DEFAULT_TABLE_COUNT = 12;
const DEFAULT_CAPACITY = 10;
const DEFAULT_MAIN_TABLES = 2;

class TableError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TableError';
    this.code = code;
    this.details = details || null;
  }
}

function defaultTables() {
  return Array.from({ length: DEFAULT_TABLE_COUNT }, (_, index) => ({
    id: index + 1,
    name: `Mesa ${index + 1}`,
    capacity: DEFAULT_CAPACITY,
    is_main: index < DEFAULT_MAIN_TABLES,
  }));
}

/** Una persona se puede sentar si está identificada individualmente. */
function buildPeople(invitations, assignments) {
  const tableByGuest = assignments instanceof Map
    ? assignments
    : new Map((assignments || []).map((row) => [String(row.guest_id), row.table_id]));
  const people = [];
  for (const invitation of invitations || []) {
    for (const member of invitation.members || []) {
      const legacy = Boolean(invitation.needs_review) || (Number(member.cantidad_personas) || 1) > 1;
      people.push({
        id: Number(member.guest_id),
        nombre: member.nombre,
        pertenece: member.pertenece || null,
        categoria: member.categoria || null,
        estado_rsvp: member.estado_rsvp || null,
        invitation_id: invitation.id,
        invitation_name: invitation.display_name,
        group_type: invitation.group_type,
        table_id: tableByGuest.get(String(member.guest_id)) ?? null,
        seatable: !legacy,
        reason: legacy ? 'Registro antiguo con varios cupos: identifica a cada persona primero.' : null,
      });
    }
  }
  return people;
}

const isDeclined = (person) => person.estado_rsvp === 'no_asiste';
const isFamily = (people) => people.some((person) => person.categoria === 'familiares');

function groupSide(people) {
  const sides = new Set(people.map((person) => person.pertenece).filter(Boolean));
  return sides.size === 1 ? [...sides][0] : 'mixed';
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
  const sideOf = new Map(tables.map((table) => {
    const seated = seatedByTable.get(table.id);
    return [table.id, seated.length ? groupSide(seated) : null];
  }));
  const main = new Set(tables.filter((table) => table.is_main).map((table) => table.id));
  const order = tables.map((table) => table.id);

  // Grupos con alguien por sentar (se ignoran no asistentes y registros antiguos).
  const groups = new Map();
  for (const person of people) {
    if (!person.seatable) continue;
    const key = person.invitation_id;
    if (!groups.has(key)) groups.set(key, { id: key, name: person.invitation_name, members: [] });
    groups.get(key).members.push(person);
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
    work.push({
      id: group.id,
      name: group.name,
      members: group.members,
      unseated: unseated.sort((a, b) => a.id - b.id),
      anchor,
      family: isFamily(group.members),
      side: groupSide(group.members),
    });
  }
  // Primero se completan los grupos que ya tienen a alguien sentado; luego las
  // familias (las más numerosas primero) y al final el resto.
  work.sort((a, b) => (b.anchor != null) - (a.anchor != null)
    || b.family - a.family
    || b.unseated.length - a.unseated.length
    || String(a.name).localeCompare(String(b.name), 'es')
    || String(a.id).localeCompare(String(b.id)));

  const assignments = [];
  const warnings = [];
  const place = (group, members, tableId) => {
    for (const person of members) assignments.push({ guest_id: person.id, table_id: tableId });
    free.set(tableId, free.get(tableId) - members.length);
    if (sideOf.get(tableId) == null) sideOf.set(tableId, group.side);
    else if (sideOf.get(tableId) !== group.side) sideOf.set(tableId, 'mixed');
  };

  // Las familias prefieren mesas principales; el resto, las demás.
  const ranking = (group, tableId) => {
    const wanted = group.family ? main.has(tableId) : !main.has(tableId);
    const side = sideOf.get(tableId);
    const mismatch = side != null && side !== 'mixed' && group.side !== 'mixed' && side !== group.side;
    return (wanted ? 0 : 1000) + (mismatch ? 100 : 0);
  };

  for (const group of work) {
    const startAt = assignments.length;
    let pending = group.unseated;

    if (group.anchor != null && free.get(group.anchor) > 0) {
      const here = pending.slice(0, free.get(group.anchor));
      place(group, here, group.anchor);
      pending = pending.slice(here.length);
    }

    if (pending.length) {
      const fits = order.filter((id) => free.get(id) >= pending.length);
      if (fits.length) {
        fits.sort((a, b) => ranking(group, a) + (free.get(a) - pending.length)
          - (ranking(group, b) + (free.get(b) - pending.length)) || a - b);
        place(group, pending, fits[0]);
        pending = [];
      } else {
        // Ninguna mesa tiene lugar para todos: se reparte entre las que más lugares libres tengan.
        const open = order.filter((id) => free.get(id) > 0)
          .sort((a, b) => ranking(group, a) - ranking(group, b) || free.get(b) - free.get(a) || a - b);
        for (const tableId of open) {
          if (!pending.length) break;
          const chunk = pending.slice(0, free.get(tableId));
          place(group, chunk, tableId);
          pending = pending.slice(chunk.length);
        }
      }
    }

    if (pending.length) {
      warnings.push({ type: 'no_space', invitation_id: group.id, name: group.name, count: pending.length,
        message: `No hay lugares libres para ${pending.length} persona${pending.length === 1 ? '' : 's'} de "${group.name}".` });
    }
    // ¿Quedó el grupo en más de una mesa (contando a quienes ya estaban sentados)?
    const tablesUsed = new Set([
      ...group.members.filter((person) => person.table_id != null).map((person) => person.table_id),
      ...assignments.slice(startAt).map((row) => row.table_id),
    ]);
    if (tablesUsed.size > 1) {
      warnings.push({ type: 'split', invitation_id: group.id, name: group.name, count: group.members.length,
        message: `"${group.name}" no cabe junta en una sola mesa y quedó repartida en ${tablesUsed.size}.` });
    }
  }
  return { assignments, warnings };
}

/* ── Estado local (modo sin Supabase) ── */

function cloneState(state) {
  return { tables: state.tables.map((table) => ({ ...table })), assignments: state.assignments.map((row) => ({ ...row })) };
}

function tableName(state, id) {
  return state.tables.find((table) => table.id === id)?.name || `Mesa ${id}`;
}

function seatedAt(state, tableId, exceptIds = new Set()) {
  return state.assignments.filter((row) => row.table_id === tableId && !exceptIds.has(row.guest_id)).length;
}

/** Calcula si `needed` personas caben en la mesa (cuenta solo a quienes aún no están allí). */
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

function validateTablePatch(patch) {
  const clean = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40) throw new TableError('INVALID', 'El nombre de la mesa debe tener entre 1 y 40 caracteres.');
    clean.name = name;
  }
  if (patch.is_main !== undefined) {
    if (typeof patch.is_main !== 'boolean') throw new TableError('INVALID', 'is_main debe ser verdadero o falso.');
    clean.is_main = patch.is_main;
  }
  if (patch.capacity !== undefined) {
    const capacity = Number(patch.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) {
      throw new TableError('INVALID', 'La capacidad debe ser un número entre 1 y 30.');
    }
    clean.capacity = capacity;
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
  TableError, defaultTables, buildPeople, planAutoAssignment, isDeclined,
  applyMove, applyPlan, releaseTable, validateTablePatch, applyTablePatch,
  pruneAssignments, seatsAvailable, tableName, cloneState,
};
