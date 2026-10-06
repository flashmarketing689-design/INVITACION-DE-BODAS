/**
 * API: /api/guests
 *
 * GET    → lista de invitados            (requiere sesión admin)
 * POST   → crear invitado (genera token) (requiere sesión admin)
 * PUT    → actualizar invitado           (requiere sesión admin)
 * DELETE → eliminar invitado             (requiere sesión admin)
 * PATCH  → acciones: { action: 'regenerar_token' | 'marcar_enviada', guest_id, value }
 *
 * POST /api/guests?import=1 → importa un array legacy de localStorage (una vez).
 *
 * Fallback local (data/guests.json) para desarrollo sin Supabase configurado.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  isAdminRequest,
  setAdminCookie,
  clearAdminCookie,
  checkAdminPassword,
  isSameOriginRequest,
} = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');

/* ─── Store local (fallback dev) ─── */
const DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLocalGuests() {
  try {
    if (!fs.existsSync(GUESTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(GUESTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeLocalGuests(rows) {
  ensureDataDir();
  fs.writeFileSync(GUESTS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

/* ─── Utilidades ─── */
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (Buffer.isBuffer(body)) {
    try { return JSON.parse(body.toString('utf8')); } catch { return {}; }
  }
  return body;
}

function newToken() {
  // UUID v4 criptográficamente aleatorio (122 bits de entropía)
  return crypto.randomUUID();
}

function normalizeGuestInput(payload) {
  const nombre = String(payload.nombre || '').trim().slice(0, 120);
  const pertenece = payload.pertenece === 'novia' ? 'novia' : 'novio';
  const categoria = ['familiares', 'amigos', 'companeros', 'iglesia'].includes(payload.categoria)
    ? payload.categoria
    : 'familiares';
  const rawCantidad = Number(payload.cantidad_personas ?? payload.cantidad ?? 1);
  const cantidad = Number.isInteger(rawCantidad) ? Math.min(10, Math.max(1, rawCantidad)) : 1;
  return {
    nombre,
    telefono: String(payload.telefono || '').trim().slice(0, 30) || null,
    pertenece,
    categoria,
    cantidad_personas: cantidad,
    notas: String(payload.notas || '').trim().slice(0, 500) || null,
  };
}

const PUBLIC_COLUMNS = 'id, nombre, telefono, pertenece, categoria, cantidad_personas, notas, token, invitacion_enviada, fecha_invitacion_enviada, estado, estado_rsvp, fecha_rsvp, created_at, updated_at';

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function validBatchId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeLegacyGuest(g) {
  const base = normalizeGuestInput(g || {});
  const date = g?.enviada && g?.fecha_enviada ? new Date(g.fecha_enviada) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  return {
    ...base,
    invitacion_enviada: Boolean(g?.enviada),
    fecha_invitacion_enviada: validDate,
    estado: g?.enviada ? 'enviada' : 'pendiente',
  };
}

/* ─── Handler ─── */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'Origen no permitido' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Vercel's local filesystem is ephemeral: production must use Supabase.
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Almacenamiento no configurado' });
    return;
  }

  const url = new URL(req.url, baseUrl(req));

  /* ══ LOGIN (única ruta pública de este endpoint) ══ */
  if (req.method === 'POST' && url.searchParams.get('action') === 'login') {
    if (!allowRequest(`admin-login:${clientIp(req)}`, 20, 15 * 60 * 1000)) {
      res.status(429).json({ ok: false, error: 'Intenta de nuevo más tarde.' });
      return;
    }
    const body = parseBody(req.body);
    if (checkAdminPassword(body.password)) {
      if (!setAdminCookie(req, res)) {
        res.status(503).json({ ok: false, error: 'Autenticación no configurada' });
        return;
      }
      res.status(200).json({ ok: true });
    } else {
      // Delay pequeño para frenar fuerza bruta
      await new Promise((r) => setTimeout(r, 400));
      res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
    }
    return;
  }

  if (req.method === 'POST' && url.searchParams.get('action') === 'logout') {
    clearAdminCookie(req, res);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'GET' && url.searchParams.get('action') === 'session') {
    res.status(200).json({ authenticated: isAdminRequest(req) });
    return;
  }

  /* ══ A partir de aquí todo requiere sesión admin ══ */
  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  /* ─── IMPORT (migración localStorage → Supabase, idempotente) ─── */
  if (req.method === 'POST' && url.searchParams.get('import') === '1') {
    const payload = parseBody(req.body);
    const incoming = Array.isArray(payload) ? payload : payload.guests;
    const batchId = String(payload.batch_id || '').trim().toLowerCase();
    if (!validBatchId(batchId) || !Array.isArray(incoming) || incoming.length === 0 || incoming.length > 1000) {
      res.status(400).json({ error: 'La migración no tiene un identificador válido o supera el tamaño permitido.' });
      return;
    }
    const normalized = incoming.map(normalizeLegacyGuest);

    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase.rpc('import_legacy_guests', {
        p_batch_id: batchId,
        p_guests: normalized,
      });
      if (error) {
        console.error('Import guests error:', error.message);
        if (error.code === '22023') {
          res.status(409).json({ error: 'El lote de migración ya se usó con datos distintos.' });
          return;
        }
        res.status(500).json({ error: 'No se pudo completar la migración. Los datos locales siguen intactos.' });
        return;
      }
      const result = Array.isArray(data) ? data[0] : data;
      res.status(200).json({ imported: Number(result?.imported) || 0, replayed: Boolean(result?.replayed) });
      return;
    }

    const local = readLocalGuests();
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const previousBatch = local.filter((g) => g.import_batch_id === batchId);
    if (previousBatch.length) {
      if (previousBatch.some((g) => g.import_batch_hash !== payloadHash) || previousBatch.length !== incoming.length) {
        res.status(409).json({ error: 'El lote de migración ya se usó con datos distintos.' });
        return;
      }
      const imported = previousBatch.length;
      res.status(200).json({ imported, replayed: true });
      return;
    }
    const startId = local.reduce((m, g) => Math.max(m, g.id || 0), 1000) + 1;
    const withIds = normalized.map((g, i) => ({
      ...g,
      token: newToken(),
      id: startId + i,
      import_batch_id: batchId,
      import_batch_hash: payloadHash,
    }));
    writeLocalGuests([...local, ...withIds]);
    res.status(200).json({ imported: withIds.length, guests: withIds });
    return;
  }

  /* ─── GET: lista completa ─── */
  if (req.method === 'GET') {
    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('guests')
        .select(PUBLIC_COLUMNS)
        .is('archived_at', null)
        .order('created_at', { ascending: true });
      if (error) {
        console.error('Guests read error:', error.message);
        res.status(500).json({ error: 'Error leyendo invitados' });
        return;
      }
      res.status(200).json(data || []);
      return;
    }
    res.status(200).json(readLocalGuests().filter((g) => !g.archived_at));
    return;
  }

  /* ─── POST: crear invitado ─── */
  if (req.method === 'POST') {
    const payload = parseBody(req.body);
    const clean = normalizeGuestInput(payload);
    if (!clean.nombre || clean.nombre.split(/\s+/).filter(Boolean).length < 2) {
      res.status(400).json({ error: 'El nombre completo es obligatorio' });
      return;
    }

    const row = {
      ...clean,
      token: newToken(),
      invitacion_enviada: false,
      estado: 'pendiente',
    };

    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase.from('guests').insert(row).select(PUBLIC_COLUMNS).single();
      if (error) {
        console.error('Guests insert error:', error.message);
        res.status(500).json({ error: 'Error creando invitado' });
        return;
      }
      res.status(200).json(data);
      return;
    }

    const local = readLocalGuests();
    const created = { ...row, id: local.reduce((m, g) => Math.max(m, g.id || 0), 1000) + 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    writeLocalGuests([...local, created]);
    res.status(200).json(created);
    return;
  }

  /* ─── PUT: actualizar invitado (nunca toca el token) ─── */
  if (req.method === 'PUT') {
    const payload = parseBody(req.body);
    const id = parseInt(payload.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id inválido' });
      return;
    }
    const clean = normalizeGuestInput(payload);
    if (!clean.nombre || clean.nombre.split(/\s+/).filter(Boolean).length < 2) {
      res.status(400).json({ error: 'El nombre completo es obligatorio' });
      return;
    }

    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('guests')
        .update(clean)
        .eq('id', id)
        .is('archived_at', null)
        .select(PUBLIC_COLUMNS)
        .single();
      if (error) {
        console.error('Guests update error:', error.message);
        res.status(500).json({ error: 'Error actualizando invitado' });
        return;
      }
      res.status(200).json(data);
      return;
    }

    const local = readLocalGuests();
    const idx = local.findIndex((g) => g.id === id && !g.archived_at);
    if (idx === -1) {
      res.status(404).json({ error: 'Invitado no encontrado' });
      return;
    }
    local[idx] = { ...local[idx], ...clean, updated_at: new Date().toISOString() };
    writeLocalGuests(local);
    res.status(200).json(local[idx]);
    return;
  }

  /* ─── PATCH: acciones puntuales ─── */
  if (req.method === 'PATCH') {
    const payload = parseBody(req.body);
    const id = parseInt(payload.guest_id, 10);
    const action = payload.action;

    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'guest_id inválido' });
      return;
    }

    if (action === 'regenerar_token') {
      const newTok = newToken();
      if (supabaseConfigured && supabase) {
        const { data, error } = await supabase
          .from('guests')
          .update({ token: newTok })
          .eq('id', id)
          .is('archived_at', null)
          .select(PUBLIC_COLUMNS)
          .single();
        if (error) {
          res.status(500).json({ error: 'Error regenerando token' });
          return;
        }
        res.status(200).json(data);
        return;
      }
      const local = readLocalGuests();
      const idx = local.findIndex((g) => g.id === id && !g.archived_at);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      local[idx] = { ...local[idx], token: newTok, updated_at: new Date().toISOString() };
      writeLocalGuests(local);
      res.status(200).json(local[idx]);
      return;
    }

    if (action === 'marcar_enviada') {
      if (typeof payload.value !== 'boolean') {
        res.status(400).json({ error: 'value debe ser booleano' });
        return;
      }
      const value = payload.value;
      const patch = {
        invitacion_enviada: value,
        fecha_invitacion_enviada: value ? new Date().toISOString() : null,
      };
      if (supabaseConfigured && supabase) {
        const { data, error } = await supabase
          .from('guests')
          .update(patch)
          .eq('id', id)
          .is('archived_at', null)
          .select(PUBLIC_COLUMNS)
          .single();
        if (error) {
          res.status(500).json({ error: 'Error actualizando envío' });
          return;
        }
        res.status(200).json(data);
        return;
      }
      const local = readLocalGuests();
      const idx = local.findIndex((g) => g.id === id && !g.archived_at);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      local[idx] = { ...local[idx], ...patch, updated_at: new Date().toISOString() };
      writeLocalGuests(local);
      res.status(200).json(local[idx]);
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida' });
    return;
  }

  /* ─── DELETE: archivar la invitación y revocar su enlace sin borrar el historial ─── */
  if (req.method === 'DELETE') {
    const id = parseInt(parseBody(req.body).id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id inválido' });
      return;
    }
    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase
        .from('guests')
        .update({ archived_at: new Date().toISOString(), token: newToken() })
        .eq('id', id)
        .is('archived_at', null)
        .select('id')
        .maybeSingle();
      if (error) {
        console.error('Guests archive error:', error.message);
        res.status(500).json({ error: 'Error archivando invitado' });
        return;
      }
      if (!data) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      res.status(200).json({ ok: true, archived: true });
      return;
    }
    const local = readLocalGuests();
    const idx = local.findIndex((g) => g.id === id && !g.archived_at);
    if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
    local[idx] = { ...local[idx], archived_at: new Date().toISOString(), token: newToken(), updated_at: new Date().toISOString() };
    writeLocalGuests(local);
    res.status(200).json({ ok: true, archived: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
