/**
 * API: /api/tables  (módulo de mesas · requiere sesión admin)
 *
 * GET                    → { tables, people, summary, warnings }
 * POST ?action=move      → { guest_ids, table_id|null, with_group? } sienta o libera personas
 * POST ?action=auto      → organiza automáticamente a quienes no tienen mesa
 * POST ?action=reset     → { table_id? } vacía una mesa o todas
 * PATCH                  → { id, name?, is_main?, capacity? } edita una mesa
 *
 * La capacidad se valida aquí para dar mensajes claros y se vuelve a garantizar
 * en la base de datos (migración 011), que es la que tiene la última palabra.
 */

const fs = require('fs');
const path = require('path');
const { isAdminRequest, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { DATA_DIR, ensureLocalSingletons } = require('../lib/invitations');
const T = require('../lib/tables');
const { listInvitations } = require('./invitations');

const LOCAL_FILE = path.join(DATA_DIR, 'tables_local.json');

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
    if (parsed && Array.isArray(parsed.tables) && Array.isArray(parsed.assignments)) return parsed;
  } catch { /* primera vez: se usan las 12 mesas por defecto */ }
  return { tables: T.defaultTables(), assignments: [] };
}
function writeLocalState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf8');
}

const localStore = {
  async load() { return readLocalState(); },
  async move(state, guestIds, tableId) { writeLocalState(T.applyMove(state, guestIds, tableId)); },
  async applyPlan(state, plan) { writeLocalState(T.applyPlan(state, plan)); },
  async release(state, tableId) { writeLocalState(T.releaseTable(state, tableId)); },
  async updateTable(state, id, patch) { writeLocalState(T.applyTablePatch(state, id, patch)); },
};

/* ─── Supabase ─── */
function translateDbError(error) {
  const message = String(error?.message || '');
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error?.code)) {
    return new T.TableError('MIGRATION', 'Primero ejecuta la migración 011_wedding_tables.sql en Supabase para activar las mesas.');
  }
  if (error?.code === '23514' && message.includes('table_full')) {
    return new T.TableError('TABLE_FULL', 'La mesa se llenó mientras movías a las personas. Actualiza e inténtalo de nuevo.');
  }
  if (error?.code === '23514' && message.includes('table_capacity_below_assigned')) {
    return new T.TableError('TABLE_CAPACITY', 'Esa mesa ya tiene más personas que la capacidad indicada; mueve a alguien primero.');
  }
  if (error?.code === 'P0002') return new T.TableError('NOT_FOUND', 'La mesa no existe.');
  if (error?.code === '22023') {
    return new T.TableError('INVALID', 'Alguna persona ya no está disponible para sentarse. Recarga la lista.');
  }
  return error;
}

async function dbCall(promise) {
  const { data, error } = await promise;
  if (error) throw translateDbError(error);
  return data;
}

const supabaseStore = {
  async load() {
    const tables = await dbCall(supabase.from('wedding_tables').select('id, name, capacity, is_main').order('id'));
    const assignments = await dbCall(supabase.from('table_assignments').select('guest_id, table_id').limit(5000));
    return { tables: tables || [], assignments: assignments || [] };
  },
  async move(_state, guestIds, tableId) {
    await dbCall(supabase.rpc('move_guests_to_table', { p_guest_ids: guestIds, p_table_id: tableId }));
  },
  async applyPlan(_state, plan) {
    await dbCall(supabase.rpc('apply_table_plan', { p_plan: plan }));
  },
  async release(_state, tableId) {
    let query = supabase.from('table_assignments').delete();
    query = tableId == null ? query.gt('guest_id', 0) : query.eq('table_id', tableId);
    await dbCall(query);
  },
  async updateTable(_state, id, patch) {
    const data = await dbCall(supabase.from('wedding_tables').update(patch).eq('id', id).select('id'));
    if (!data?.length) throw new T.TableError('NOT_FOUND', 'La mesa no existe.');
  },
};

const store = () => (supabaseConfigured && supabase ? supabaseStore : localStore);

/* ─── Estado para la pantalla ─── */
async function loadAll() {
  const adapter = store();
  let state = await adapter.load();
  const invitations = await listInvitations();
  if (adapter === localStore) {
    const active = invitations.flatMap((invitation) => (invitation.members || []).map((member) => member.guest_id));
    state = T.pruneAssignments(state, active);
  }
  const people = T.buildPeople(invitations, state.assignments);
  return { state, people };
}

function publicState({ state, people }) {
  const known = new Set(people.map((person) => person.id));
  const tables = state.tables.map((table) => {
    const guests = state.assignments.filter((row) => row.table_id === table.id && known.has(row.guest_id)).map((row) => row.guest_id);
    return { ...table, seated: guests.length, guests };
  });
  const toSeat = people.filter((person) => person.seatable && (person.table_id != null || !T.isDeclined(person)));
  const seated = toSeat.filter((person) => person.table_id != null).length;
  const capacity = state.tables.reduce((sum, table) => sum + table.capacity, 0);
  const warnings = [];
  if (toSeat.length > capacity) {
    warnings.push({ type: 'capacity', message: `Hay ${toSeat.length} personas por sentar y solo ${capacity} lugares en las mesas.` });
  }
  const review = people.filter((person) => !person.seatable).length;
  if (review) warnings.push({ type: 'review', message: `${review} persona${review === 1 ? '' : 's'} de registros antiguos no se pueden sentar hasta identificarlas.` });
  return {
    tables,
    people,
    summary: { to_seat: toSeat.length, seated, unseated: toSeat.length - seated, capacity, free: capacity - tables.reduce((s, t) => s + t.seated, 0) },
    warnings,
  };
}

function statusFor(error) {
  return ({ TABLE_FULL: 409, TABLE_CAPACITY: 409, NOT_FOUND: 404, INVALID: 400, REVIEW: 409, MIGRATION: 503 })[error.code] || 500;
}

/* ─── Acciones ─── */
function parseIds(value) {
  const ids = Array.isArray(value) ? value.map(Number) : [];
  if (!ids.length || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new T.TableError('INVALID', 'Selecciona entre 1 y 100 personas válidas.');
  }
  return ids;
}

function parseTableId(value) {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new T.TableError('INVALID', 'Mesa no válida.');
  return id;
}

async function doMove(body) {
  const ids = parseIds(body.guest_ids);
  const tableId = parseTableId(body.table_id);
  const current = await loadAll();
  const byId = new Map(current.people.map((person) => [person.id, person]));
  if (ids.some((id) => !byId.has(id))) throw new T.TableError('INVALID', 'Alguna persona ya no está en la lista. Recarga la página.');

  const selected = new Set(ids);
  if (body.with_group === true) {
    // Mover con su grupo: se suma a cada integrante que se pueda sentar y siga asistiendo.
    const invitationIds = new Set(ids.map((id) => byId.get(id).invitation_id));
    for (const person of current.people) {
      if (invitationIds.has(person.invitation_id) && person.seatable && !T.isDeclined(person)) selected.add(person.id);
    }
  }
  const moving = [...selected];
  if (moving.length > 100) throw new T.TableError('INVALID', 'El grupo es demasiado grande para moverlo de una vez.');
  if (tableId !== null && moving.some((id) => !byId.get(id).seatable)) {
    throw new T.TableError('REVIEW', 'Hay personas de un registro antiguo con varios cupos: identifica a cada una antes de sentarla.');
  }
  if (tableId !== null) {
    const table = current.state.tables.find((row) => row.id === tableId);
    if (!table) throw new T.TableError('NOT_FOUND', 'La mesa no existe.');
    const incoming = moving.filter((id) => byId.get(id).table_id !== tableId).length;
    const free = T.seatsAvailable(current.state, tableId);
    if (incoming > free) {
      throw new T.TableError('TABLE_FULL',
        `${table.name} solo tiene ${free} lugar${free === 1 ? '' : 'es'} libre${free === 1 ? '' : 's'} y se necesitan ${incoming}.`,
        { table_id: tableId, free, needed: incoming });
    }
  }
  await store().move(current.state, moving, tableId);
  return { moved: moving.length };
}

async function doAuto() {
  const current = await loadAll();
  const plan = T.planAutoAssignment(current.people, current.state.tables);
  if (plan.assignments.length) await store().applyPlan(current.state, plan.assignments);
  return { placed: plan.assignments.length, plan_warnings: plan.warnings };
}

async function doReset(body) {
  const tableId = parseTableId(body.table_id);
  const current = await loadAll();
  await store().release(current.state, tableId);
  return { reset: true };
}

async function doPatch(body) {
  const id = parseTableId(body.id);
  if (id === null) throw new T.TableError('INVALID', 'Mesa no válida.');
  const patch = T.validateTablePatch(body);
  const current = await loadAll();
  const table = current.state.tables.find((row) => row.id === id);
  if (!table) throw new T.TableError('NOT_FOUND', 'La mesa no existe.');
  if (patch.capacity !== undefined) {
    const seated = current.state.assignments.filter((row) => row.table_id === id).length;
    if (patch.capacity < seated) {
      throw new T.TableError('TABLE_CAPACITY', `${table.name} ya tiene ${seated} personas; mueve a alguien antes de reducir su capacidad.`);
    }
  }
  await store().updateTable(current.state, id, patch);
  return { updated: id };
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
      // En modo local crea las invitaciones individuales que falten antes de listar.
      if (!(supabaseConfigured && supabase)) ensureLocalSingletons();
    } else if (req.method === 'POST') {
      const body = parseBody(req.body);
      switch (url.searchParams.get('action')) {
        case 'move': result = await doMove(body); break;
        case 'auto': result = await doAuto(); break;
        case 'reset': result = await doReset(body); break;
        default: res.status(400).json({ error: 'Acción no reconocida' }); return;
      }
    } else if (req.method === 'PATCH') {
      result = await doPatch(parseBody(req.body));
    } else {
      res.status(405).json({ error: 'Method not allowed' }); return;
    }
    const state = publicState(await loadAll());
    res.status(200).json({ ...state, result });
  } catch (error) {
    if (error instanceof T.TableError) {
      res.status(statusFor(error)).json({ error: error.message, code: error.code, details: error.details });
      return;
    }
    console.error('Tables API error:', error?.message || error);
    res.status(500).json({ error: 'No se pudo completar la operación de mesas.' });
  }
};
