/**
 * API: /api/cortejo  (cortejo y participantes · requiere sesión admin)
 *
 * GET                       → { roles, people, summary }
 * POST ?action=create       → { name, description? } crea un papel
 * POST ?action=assign       → { role_id, guest_ids } da el papel a varias personas
 * POST ?action=unassign     → { role_id, guest_id } le quita el papel a una persona
 * POST ?action=reorder      → { role_ids } ordena los papeles
 * POST ?action=add-member   → { nombre, pertenece } agrega a una persona sin invitación (los novios…)
 * POST ?action=remove-member → { id } la quita del cortejo (id positivo de la persona)
 * PATCH                     → { id, name?, description? } edita un papel
 * DELETE                    → { id } elimina un papel (y sus asignaciones; las personas no se borran)
 *
 * Una persona puede tener varios papeles. Los papeles se pueden crear y renombrar libremente.
 * Las personas sin invitación no son invitados: en las asignaciones se identifican con un id negativo.
 */

const fs = require('fs');
const path = require('path');
const { isAdminRequest, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { DATA_DIR, ensureLocalSingletons } = require('../lib/invitations');
const T = require('../lib/tables');
const R = require('../lib/roles');
const { listInvitations } = require('./invitations');
const tablesApi = require('./tables');
const kinshipsApi = require('./kinships');

const LOCAL_FILE = path.join(DATA_DIR, 'roles_local.json');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  if (Buffer.isBuffer(body)) { try { return JSON.parse(body.toString('utf8')); } catch { return {}; } }
  return body;
}

/* ─── Almacenamiento local (desarrollo y pruebas) ─── */
function readLocalState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.roles) && Array.isArray(parsed.assignments)) return { members: [], ...parsed };
  } catch { /* primera vez: se usan los papeles iniciales */ }
  return R.defaultRoleState();
}
function writeLocalState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf8');
}

const localStore = {
  async load() { return readLocalState(); },
  async create(state, input) { writeLocalState(R.createRole(state, input)); },
  async update(state, id, input) { writeLocalState(R.updateRole(state, id, input)); },
  async remove(state, id) { writeLocalState(R.deleteRole(state, id)); },
  async assign(state, roleId, guestIds) { writeLocalState(R.assign(state, roleId, guestIds)); },
  async unassign(state, roleId, guestId) { writeLocalState(R.unassign(state, roleId, guestId)); },
  async reorder(state, ids) { writeLocalState(R.reorder(state, ids)); },
  async addMember(state, input) { writeLocalState(R.addMember(state, input)); },
  async removeMember(state, id) { writeLocalState(R.removeMember(state, id)); },
};

/* ─── Supabase ─── */
function translateDbError(error) {
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error?.code)) {
    return new R.RoleError('MIGRATION', 'Primero ejecuta la migración 014_wedding_roles.sql en Supabase para activar el cortejo.');
  }
  if (error?.code === '23505') return new R.RoleError('DUPLICATE', 'Ya existe un papel con ese nombre.');
  if (error?.code === '23503') return new R.RoleError('NOT_FOUND', 'El papel o la persona ya no existe. Recarga la página.');
  if (error?.code === '23514') return new R.RoleError('INVALID', 'Revisa el nombre (hasta 60 caracteres) y la descripción (hasta 200).');
  if (error?.code === '22023') return new R.RoleError('INVALID', 'La lista de papeles no es válida.');
  return error;
}

async function dbCall(promise) {
  const { data, error } = await promise;
  if (error) throw translateDbError(error);
  return data;
}

// Las tablas de personas sin invitación llegan con la migración 015: sin ella, no hay personas.
async function optionalRows(promise) {
  const { data, error } = await promise;
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return [];
    throw translateDbError(error);
  }
  return data || [];
}

// Agregar o quitar personas sin invitación necesita la migración 015.
async function memberCall(promise) {
  const { data, error } = await promise;
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) {
      throw new R.RoleError('MIGRATION', 'Primero ejecuta la migración 015_kinships_and_party_members.sql en Supabase para agregar personas sin invitación.');
    }
    throw translateDbError(error);
  }
  return data;
}

const supabaseStore = {
  async load() {
    const roles = await dbCall(supabase.from('wedding_roles').select('id, name, description, sort_order').order('sort_order').order('id'));
    const assignments = await dbCall(supabase.from('guest_roles').select('guest_id, role_id').limit(5000));
    const members = await optionalRows(supabase.from('party_members').select('id, nombre, pertenece').order('id').limit(200));
    const memberRoles = await optionalRows(supabase.from('party_member_roles').select('member_id, role_id').limit(5000));
    return {
      roles: roles || [],
      assignments: [...(assignments || []), ...memberRoles.map((row) => ({ guest_id: -row.member_id, role_id: row.role_id }))],
      members, next_id: 0,
    };
  },
  async create(state, input) {
    const clean = R.validateRoleInput(input);
    if (state.roles.length >= R.MAX_ROLES) throw new R.RoleError('INVALID', `Se pueden tener hasta ${R.MAX_ROLES} papeles.`);
    const order = state.roles.reduce((max, role) => Math.max(max, role.sort_order), 0) + 1;
    await dbCall(supabase.from('wedding_roles').insert({ ...clean, sort_order: order }));
  },
  async update(_state, id, input) {
    const clean = R.validateRoleInput(input, { partial: true });
    const rows = await dbCall(supabase.from('wedding_roles').update(clean).eq('id', id).select('id'));
    if (!rows?.length) throw new R.RoleError('NOT_FOUND', 'El papel no existe.');
  },
  async remove(_state, id) {
    const rows = await dbCall(supabase.from('wedding_roles').delete().eq('id', id).select('id'));
    if (!rows?.length) throw new R.RoleError('NOT_FOUND', 'El papel no existe.');
  },
  async assign(_state, roleId, guestIds) {
    const guests = guestIds.filter((id) => id > 0), members = guestIds.filter((id) => id < 0).map((id) => -id);
    if (guests.length) {
      await dbCall(supabase.from('guest_roles')
        .upsert(guests.map((guest_id) => ({ guest_id, role_id: roleId })), { onConflict: 'guest_id,role_id', ignoreDuplicates: true }));
    }
    if (members.length) {
      await dbCall(supabase.from('party_member_roles')
        .upsert(members.map((member_id) => ({ member_id, role_id: roleId })), { onConflict: 'member_id,role_id', ignoreDuplicates: true }));
    }
  },
  async unassign(_state, roleId, guestId) {
    if (guestId < 0) await dbCall(supabase.from('party_member_roles').delete().eq('role_id', roleId).eq('member_id', -guestId));
    else await dbCall(supabase.from('guest_roles').delete().eq('role_id', roleId).eq('guest_id', guestId));
  },
  async addMember(state, input) {
    const clean = R.validateMemberInput(input);
    if (state.members.length >= R.MAX_MEMBERS) throw new R.RoleError('INVALID', `Se pueden agregar hasta ${R.MAX_MEMBERS} personas sin invitación.`);
    await memberCall(supabase.from('party_members').insert(clean));
  },
  async removeMember(_state, id) {
    const rows = await memberCall(supabase.from('party_members').delete().eq('id', id).select('id'));
    if (!rows?.length) throw new R.RoleError('NOT_FOUND', 'La persona no está en el cortejo.');
  },
  async reorder(state, ids) {
    // Los papeles que no se mencionan conservan su lugar, al final.
    const rest = state.roles.filter((role) => !ids.includes(role.id)).map((role) => role.id);
    await dbCall(supabase.rpc('reorder_wedding_roles', { p_ids: [...ids, ...rest] }));
  },
};

const store = () => (supabaseConfigured && supabase ? supabaseStore : localStore);

/* ─── Estado para la pantalla ─── */
async function loadAll() {
  const adapter = store();
  let state = await adapter.load();
  const invitations = await listInvitations();
  let family = new Map();
  try { family = await tablesApi.familyInfo(); } catch { /* la etiqueta de parentesco es opcional */ }
  const all = T.buildPeople(invitations, [], family, await kinshipsApi.definitions());
  if (adapter === localStore) state = R.pruneAssignments(state, all.map((person) => person.id));
  const guests = all.map((person) => ({
    id: person.id, nombre: person.nombre, pertenece: person.pertenece, categoria: person.categoria,
    estado_rsvp: person.estado_rsvp, parentesco_label: person.parentesco_label, invitation_name: person.invitation_name,
  }));
  // Las personas sin invitación (los novios…) no son invitados: id negativo, sin respuesta ni categoría.
  const members = (state.members || []).map((member) => ({
    id: -member.id, member_id: member.id, nombre: member.nombre, pertenece: member.pertenece, categoria: null,
    estado_rsvp: null, parentesco_label: null, invitation_name: null, sin_invitacion: true,
  }));
  return { state, people: [...members, ...guests] };
}

const statusFor = (error) => ({ INVALID: 400, NOT_FOUND: 404, DUPLICATE: 409, MIGRATION: 503 })[error.code] || 500;

// Id de invitado (positivo) o de persona sin invitación (negativo).
function parsePersonId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0) throw new R.RoleError('INVALID', 'Elige una persona válida.');
  return id;
}

function parseId(value, label = 'papel') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new R.RoleError('INVALID', `Elige un ${label} válido.`);
  return id;
}

async function act(body, action) {
  const { state, people } = await loadAll();
  const adapter = store();
  const known = new Set(people.map((person) => person.id));
  switch (action) {
    case 'create': await adapter.create(state, body); return { created: true };
    case 'assign': {
      const roleId = parseId(body.role_id);
      const ids = Array.isArray(body.guest_ids) ? body.guest_ids.map(Number) : [];
      if (!ids.length || ids.length > R.MAX_GUESTS_PER_REQUEST || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id === 0)) {
        throw new R.RoleError('INVALID', 'Selecciona entre 1 y 100 personas válidas.');
      }
      if (ids.some((id) => !known.has(id))) throw new R.RoleError('INVALID', 'Alguna persona ya no está en la lista. Recarga la página.');
      if (!state.roles.some((role) => role.id === roleId)) throw new R.RoleError('NOT_FOUND', 'El papel no existe.');
      await adapter.assign(state, roleId, ids);
      return { assigned: ids.length };
    }
    case 'unassign': await adapter.unassign(state, parseId(body.role_id), parsePersonId(body.guest_id)); return { unassigned: true };
    case 'add-member': await adapter.addMember(state, body); return { added: true };
    case 'remove-member': await adapter.removeMember(state, parseId(body.id, 'persona')); return { removed: true };
    case 'reorder': {
      const ids = Array.isArray(body.role_ids) ? body.role_ids.map(Number) : [];
      if (!ids.length || ids.some((id) => !Number.isSafeInteger(id))) throw new R.RoleError('INVALID', 'La lista de papeles no es válida.');
      R.reorder(state, ids); // valida antes de tocar la base
      await adapter.reorder(state, ids);
      return { reordered: true };
    }
    default: throw new R.RoleError('INVALID', 'Acción no reconocida');
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isSameOriginRequest(req)) { res.status(403).json({ error: 'Origen no permitido' }); return; }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!isAdminRequest(req)) { res.status(401).json({ error: 'No autorizado' }); return; }
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Almacenamiento no configurado' }); return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    let result = {};
    if (req.method === 'GET') {
      if (!(supabaseConfigured && supabase)) ensureLocalSingletons();
    } else if (req.method === 'POST') {
      result = await act(parseBody(req.body), url.searchParams.get('action'));
    } else if (req.method === 'PATCH') {
      const body = parseBody(req.body);
      const { state } = await loadAll();
      await store().update(state, parseId(body.id), body);
      result = { updated: true };
    } else if (req.method === 'DELETE') {
      const { state } = await loadAll();
      await store().remove(state, parseId(parseBody(req.body).id));
      result = { deleted: true };
    } else {
      res.status(405).json({ error: 'Method not allowed' }); return;
    }
    const { state, people } = await loadAll();
    res.status(200).json({ ...R.buildOverview(state, people), result });
  } catch (error) {
    if (error instanceof R.RoleError) { res.status(statusFor(error)).json({ error: error.message, code: error.code }); return; }
    console.error('Cortejo API error:', error?.message || error);
    res.status(500).json({ error: 'No se pudo completar la operación del cortejo.' });
  }
};
