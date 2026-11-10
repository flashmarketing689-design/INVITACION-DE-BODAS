/**
 * API: /api/kinships  (parentescos editables · requiere sesión admin)
 *
 * GET                  → { kinships: [{ key, name, sort_order, count }] }
 * POST   { name }      → crea un parentesco
 * PATCH  { key, name } → renombra un parentesco
 * DELETE { key }       → elimina un parentesco (quienes lo tenían quedan sin parentesco,
 *                        pero siguen siendo familia cercana)
 */

const fs = require('fs');
const path = require('path');
const { isAdminRequest, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { DATA_DIR } = require('../lib/dataDir');
const K = require('../lib/kinships');

const KINSHIPS_FILE = path.join(DATA_DIR, 'kinships_local.json');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  if (Buffer.isBuffer(body)) { try { return JSON.parse(body.toString('utf8')); } catch { return {}; } }
  return body;
}

function readLocal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KINSHIPS_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* primera vez: se usan los tres iniciales */ }
  return K.DEFAULT_KINSHIPS.map((item) => ({ ...item }));
}
function writeLocal(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KINSHIPS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function readLocalGuests() {
  try { const rows = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8')); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

function translate(error) {
  if (['42P01', '42703', 'PGRST205'].includes(error?.code)) {
    return new K.KinshipError('MIGRATION', 'Primero ejecuta la migración 015_kinships_and_party_members.sql en Supabase para editar los parentescos.');
  }
  if (error?.code === '23505') return new K.KinshipError('DUPLICATE', 'Ya existe un parentesco con ese nombre.');
  if (error?.code === '23514') return new K.KinshipError('INVALID', 'El nombre del parentesco debe tener entre 1 y 40 caracteres.');
  return error;
}
async function db(promise) {
  const { data, error } = await promise;
  if (error) throw translate(error);
  return data;
}

const localStore = {
  async load() {
    const list = readLocal();
    const counts = new Map();
    for (const guest of readLocalGuests()) if (guest.parentesco && !guest.archived_at) counts.set(guest.parentesco, (counts.get(guest.parentesco) || 0) + 1);
    return { list, counts };
  },
  async create(list, name) { const { next } = K.createKinship(list, name); writeLocal(next); },
  async rename(list, key, name) { writeLocal(K.renameKinship(list, key, name)); },
  async remove(list, key) {
    writeLocal(K.deleteKinship(list, key));
    const guests = readLocalGuests();
    if (guests.some((guest) => guest.parentesco === key)) {
      fs.writeFileSync(GUESTS_FILE, JSON.stringify(guests.map((guest) => (guest.parentesco === key ? { ...guest, parentesco: null } : guest)), null, 2), 'utf8');
    }
  },
};

const supabaseStore = {
  async load() {
    const list = await db(supabase.from('wedding_kinships').select('key, name, sort_order').order('sort_order').order('key'));
    const rows = await db(supabase.from('guests').select('parentesco').not('parentesco', 'is', null).is('archived_at', null).limit(5000));
    const counts = new Map();
    for (const row of rows || []) counts.set(row.parentesco, (counts.get(row.parentesco) || 0) + 1);
    return { list: list || [], counts };
  },
  async create(list, name) {
    const { next, key } = K.createKinship(list, name); // valida y calcula la clave
    const created = next.find((item) => item.key === key);
    await db(supabase.from('wedding_kinships').insert({ key, name: created.name, sort_order: created.sort_order }));
  },
  async rename(list, key, name) {
    K.renameKinship(list, key, name);
    const rows = await db(supabase.from('wedding_kinships').update({ name: String(name).replace(/\s+/g, ' ').trim() }).eq('key', key).select('key'));
    if (!rows?.length) throw new K.KinshipError('NOT_FOUND', 'El parentesco no existe.');
  },
  async remove(list, key) {
    K.deleteKinship(list, key);
    await db(supabase.from('wedding_kinships').delete().eq('key', key));
  },
};

const store = () => (supabaseConfigured && supabase ? supabaseStore : localStore);
const statusFor = (error) => ({ INVALID: 400, NOT_FOUND: 404, DUPLICATE: 409, MIGRATION: 503 })[error.code] || 500;

async function view() {
  const { list, counts } = await store().load();
  return { kinships: K.sorted(list).map((item) => ({ ...item, count: counts.get(item.key) || 0 })) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isSameOriginRequest(req)) { res.status(403).json({ error: 'Origen no permitido' }); return; }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!isAdminRequest(req)) { res.status(401).json({ error: 'No autorizado' }); return; }
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Almacenamiento no configurado' }); return;
  }
  try {
    if (req.method !== 'GET') {
      const body = parseBody(req.body);
      const { list } = await store().load();
      if (req.method === 'POST') await store().create(list, body.name);
      else if (req.method === 'PATCH') await store().rename(list, String(body.key || ''), body.name);
      else if (req.method === 'DELETE') await store().remove(list, String(body.key || ''));
      else { res.status(405).json({ error: 'Method not allowed' }); return; }
    }
    res.status(200).json(await view());
  } catch (error) {
    if (error instanceof K.KinshipError) { res.status(statusFor(error)).json({ error: error.message, code: error.code }); return; }
    console.error('Kinships API error:', error?.message || error);
    res.status(500).json({ error: 'No se pudo completar la operación de parentescos.' });
  }
};

// Otros módulos usan la lista para etiquetar y ordenar (si falla, los tres iniciales).
module.exports.definitions = async () => {
  try {
    const { list } = await store().load();
    return list.length ? list : K.DEFAULT_KINSHIPS;
  } catch { return K.DEFAULT_KINSHIPS; }
};
