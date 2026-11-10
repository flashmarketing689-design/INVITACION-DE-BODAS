/**
 * Lógica del cortejo y los participantes de la boda (sin red ni disco, para poder probarla).
 *
 * Un "papel" es lo que hace una persona ese día (padrinos, damas de honor, niña
 * del cartel…). Una persona puede tener varios papeles. Estas funciones operan
 * sobre el estado local { roles, assignments, next_id } del modo sin Supabase.
 */

const MAX_ROLES = 40;
const MAX_GUESTS_PER_REQUEST = 100;

/** Papeles iniciales (los mismos que siembra la migración 014). */
const DEFAULT_ROLES = [
  ['Padres que participan', 'Los padres que acompañan a los novios en la ceremonia.'],
  ['Padrinos', 'Padrinos y madrinas de la boda.'],
  ['Chambelanes', 'Acompañan a las damas de honor.'],
  ['Damas de honor', 'Acompañan a la novia.'],
  ['Niña del cartel', 'Anuncia la llegada de la novia con un cartel: «Ya viene la novia».'],
  ['Portador(a) de los anillos', 'Lleva los anillos hasta el altar.'],
];

class RoleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoleError';
    this.code = code;
  }
}

function defaultRoleState() {
  return {
    roles: DEFAULT_ROLES.map(([name, description], index) => ({ id: index + 1, name, description, sort_order: index + 1 })),
    assignments: [],
    next_id: DEFAULT_ROLES.length + 1,
  };
}

const cloneState = (state) => ({
  roles: state.roles.map((role) => ({ ...role })),
  assignments: state.assignments.map((row) => ({ ...row })),
  next_id: state.next_id,
});

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Valida nombre y descripción de un papel; con `partial` solo revisa lo que se envía. */
function validateRoleInput(input, { partial = false } = {}) {
  const clean = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60) throw new RoleError('INVALID', 'El nombre del papel debe tener entre 1 y 60 caracteres.');
    clean.name = name;
  }
  if (!partial || input.description !== undefined) {
    const description = String(input.description ?? '').replace(/\s+/g, ' ').trim();
    if (description.length > 200) throw new RoleError('INVALID', 'La descripción no puede pasar de 200 caracteres.');
    clean.description = description || null;
  }
  if (partial && !Object.keys(clean).length) throw new RoleError('INVALID', 'No hay cambios que guardar.');
  return clean;
}

function createRole(state, input) {
  const clean = validateRoleInput(input);
  if (state.roles.length >= MAX_ROLES) throw new RoleError('INVALID', `Se pueden tener hasta ${MAX_ROLES} papeles.`);
  if (state.roles.some((role) => sameName(role.name, clean.name))) throw new RoleError('DUPLICATE', 'Ya existe un papel con ese nombre.');
  const next = cloneState(state);
  const order = next.roles.reduce((max, role) => Math.max(max, role.sort_order), 0) + 1;
  next.roles.push({ id: next.next_id, ...clean, sort_order: order });
  next.next_id += 1;
  return next;
}

function updateRole(state, id, input) {
  const clean = validateRoleInput(input, { partial: true });
  if (!state.roles.some((role) => role.id === id)) throw new RoleError('NOT_FOUND', 'El papel no existe.');
  if (clean.name && state.roles.some((role) => role.id !== id && sameName(role.name, clean.name))) {
    throw new RoleError('DUPLICATE', 'Ya existe un papel con ese nombre.');
  }
  const next = cloneState(state);
  Object.assign(next.roles.find((role) => role.id === id), clean);
  return next;
}

function deleteRole(state, id) {
  if (!state.roles.some((role) => role.id === id)) throw new RoleError('NOT_FOUND', 'El papel no existe.');
  const next = cloneState(state);
  next.roles = next.roles.filter((role) => role.id !== id);
  next.assignments = next.assignments.filter((row) => row.role_id !== id);
  return next;
}

function assign(state, roleId, guestIds) {
  if (!state.roles.some((role) => role.id === roleId)) throw new RoleError('NOT_FOUND', 'El papel no existe.');
  const next = cloneState(state);
  for (const guestId of guestIds) {
    if (!next.assignments.some((row) => row.role_id === roleId && row.guest_id === guestId)) {
      next.assignments.push({ guest_id: guestId, role_id: roleId });
    }
  }
  return next;
}

function unassign(state, roleId, guestId) {
  const next = cloneState(state);
  next.assignments = next.assignments.filter((row) => !(row.role_id === roleId && row.guest_id === guestId));
  return next;
}

/** Deja los papeles en el orden indicado; los que no se mencionan van al final. */
function reorder(state, ids) {
  if (new Set(ids).size !== ids.length || ids.some((id) => !state.roles.some((role) => role.id === id))) {
    throw new RoleError('INVALID', 'La lista de papeles no es válida.');
  }
  const next = cloneState(state);
  const rest = next.roles.filter((role) => !ids.includes(role.id)).sort((a, b) => a.sort_order - b.sort_order);
  [...ids.map((id) => next.roles.find((role) => role.id === id)), ...rest].forEach((role, index) => { role.sort_order = index + 1; });
  return next;
}

/** Quita asignaciones de personas que ya no existen o fueron eliminadas. */
function pruneAssignments(state, activeGuestIds) {
  const active = new Set([...activeGuestIds].map(Number));
  const next = cloneState(state);
  next.assignments = next.assignments.filter((row) => active.has(row.guest_id));
  return next;
}

/** Une personas y papeles para la pantalla. */
function buildOverview(state, people) {
  const rolesByGuest = new Map();
  for (const row of state.assignments) {
    if (!rolesByGuest.has(row.guest_id)) rolesByGuest.set(row.guest_id, []);
    rolesByGuest.get(row.guest_id).push(row.role_id);
  }
  const ordered = [...state.roles].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const known = new Set(people.map((person) => person.id));
  const roles = ordered.map((role) => ({
    id: role.id, name: role.name, description: role.description || null, sort_order: role.sort_order,
    guest_ids: state.assignments.filter((row) => row.role_id === role.id && known.has(row.guest_id)).map((row) => row.guest_id),
  }));
  const order = new Map(ordered.map((role, index) => [role.id, index]));
  const enriched = people.map((person) => ({
    ...person,
    role_ids: (rolesByGuest.get(person.id) || []).filter((id) => order.has(id)).sort((a, b) => order.get(a) - order.get(b)),
  }));
  const withRole = enriched.filter((person) => person.role_ids.length);
  return {
    roles,
    people: enriched,
    summary: {
      roles: roles.length,
      with_role: withRole.length,
      participants_without_role: enriched.filter((person) => person.categoria === 'participantes' && !person.role_ids.length).length,
      declined_with_role: withRole.filter((person) => person.estado_rsvp === 'no_asiste').length,
    },
  };
}

module.exports = {
  MAX_ROLES, MAX_GUESTS_PER_REQUEST, DEFAULT_ROLES, RoleError, defaultRoleState, validateRoleInput,
  createRole, updateRole, deleteRole, assign, unassign, reorder, pruneAssignments, buildOverview,
};
