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
} = require('./auth');
const { supabase, supabaseConfigured } = require('./supabaseClient');

/* ─── Store local (fallback dev) ─── */
const DATA_DIR = path.join(__dirname, '..', 'data');
const GUESTS_FILE = path.join(DATA_DIR, 'guests.json');
const LOCAL_LEGACY_FILE = path.join(DATA_DIR, 'guests_legacy.json');

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
  const cantidad = Math.min(10, Math.max(1, parseInt(payload.cantidad_personas || payload.cantidad, 10) || 1));
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

/* ─── Handler ─── */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const url = new URL(req.url, baseUrl(req));

  /* ══ LOGIN (única ruta pública de este endpoint) ══ */
  if (req.method === 'POST' && url.searchParams.get('action') === 'login') {
    const body = parseBody(req.body);
    if (checkAdminPassword(body.password)) {
      setAdminCookie(res);
      res.status(200).json({ ok: true });
    } else {
      // Delay pequeño para frenar fuerza bruta
      await new Promise((r) => setTimeout(r, 400));
      res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
    }
    return;
  }

  if (req.method === 'POST' && url.searchParams.get('action') === 'logout') {
    clearAdminCookie(res);
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
    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.status(400).json({ error: 'Se espera un array de invitados' });
      return;
    }

    const normalized = incoming.map((g) => {
      const base = normalizeGuestInput(g);
      return {
        ...base,
        token: newToken(),
        invitacion_enviada: Boolean(g.enviada),
        fecha_invitacion_enviada: g.enviada && g.fecha_enviada ? new Date(g.fecha_enviada).toISOString() : null,
        estado: g.enviada ? 'enviada' : 'pendiente',
      };
    });

    // Marcar importados para no duplicar en reintento
    const legacyIds = incoming.map((g) => String(g.id ?? '')).filter(Boolean);
    try {
      fs.writeFileSync(LOCAL_LEGACY_FILE, JSON.stringify({ importedAt: new Date().toISOString(), legacyIds }, null, 2), 'utf8');
    } catch (e) { /* no bloquea la importación */ }

    if (supabaseConfigured && supabase) {
      const { data, error } = await supabase.from('guests').insert(normalized).select(PUBLIC_COLUMNS);
      if (error) {
        console.error('Import guests error:', error.message);
        res.status(500).json({ error: 'Error importando invitados: ' + error.message });
        return;
      }
      res.status(200).json({ imported: (data || []).length, guests: data });
      return;
    }

    const local = readLocalGuests();
    const startId = local.reduce((m, g) => Math.max(m, g.id || 0), 1000) + 1;
    const withIds = normalized.map((g, i) => ({ ...g, id: startId + i }));
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
        .order('created_at', { ascending: true });
      if (error) {
        console.error('Guests read error:', error.message);
        res.status(500).json({ error: 'Error leyendo invitados' });
        return;
      }
      res.status(200).json(data || []);
      return;
    }
    res.status(200).json(readLocalGuests());
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
    const idx = local.findIndex((g) => g.id === id);
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
      const idx = local.findIndex((g) => g.id === id);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      local[idx] = { ...local[idx], token: newTok, updated_at: new Date().toISOString() };
      writeLocalGuests(local);
      res.status(200).json(local[idx]);
      return;
    }

    if (action === 'marcar_enviada') {
      const value = Boolean(payload.value);
      const patch = {
        invitacion_enviada: value,
        fecha_invitacion_enviada: value ? new Date().toISOString() : null,
      };
      if (supabaseConfigured && supabase) {
        const { data, error } = await supabase
          .from('guests')
          .update(patch)
          .eq('id', id)
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
      const idx = local.findIndex((g) => g.id === id);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      local[idx] = { ...local[idx], ...patch, updated_at: new Date().toISOString() };
      writeLocalGuests(local);
      res.status(200).json(local[idx]);
      return;
    }

    res.status(400).json({ error: 'Acción no reconocida' });
    return;
  }

  /* ─── DELETE: eliminar invitado (cascade elimina RSVP e historial) ─── */
  if (req.method === 'DELETE') {
    const id = parseInt(parseBody(req.body).id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id inválido' });
      return;
    }
    if (supabaseConfigured && supabase) {
      const { error } = await supabase.from('guests').delete().eq('id', id);
      if (error) {
        console.error('Guests delete error:', error.message);
        res.status(500).json({ error: 'Error eliminando invitado' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }
    writeLocalGuests(readLocalGuests().filter((g) => g.id !== id));
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
