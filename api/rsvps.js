/**
 * API: /api/rsvps  (reescrita para el sistema de invitaciones personalizadas)
 *
 * POST  { token, asistencia: 'confirmado'|'no_asiste', mensaje?, telefono? }
 *       → Registra/actualiza la respuesta del invitado identificado por token.
 *       → UPSERT por guest_id: reconfirmar NO crea duplicados.
 *       → El nombre y la cantidad vienen SIEMPRE del servidor (del registro del invitado).
 *
 * GET   → historial de respuestas (requiere sesión admin).
 * DELETE → eliminar respuesta por { guest_id } (requiere sesión admin).
 *
 * El PUT masivo (replace-all) del sistema anterior se elimina: era inseguro
 * y permitía sobrescribir toda la tabla desde el cliente.
 */

const fs = require('fs');
const path = require('path');
const { isAdminRequest, getGuestByToken, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'rsvp_respuestas_local.json');

function readLocal() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeLocal(rows) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

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

/* ════════════════ POST público: confirmación por token ════════════════ */
async function handleConfirm(req, res) {
  if (!allowRequest(`rsvp:${clientIp(req)}`, 30, 60 * 1000)) {
    res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en un momento.' });
    return;
  }

  const payload = parseBody(req.body);
  const token = String(payload.token || '').trim().toLowerCase();
  const decision = payload.asistencia === 'no_asiste' ? 'no_asiste'
    : payload.asistencia === 'si' ? 'confirmado'
    : payload.asistencia === 'confirmado' ? 'confirmado'
    : null;

  if (!decision) {
    res.status(400).json({ error: 'Respuesta inválida' });
    return;
  }

  // ── Identidad SIEMPRE del servidor ──
  const guest = await getGuestByToken(token);
  if (!guest) {
    res.status(404).json({ error: 'Invitación no encontrada' });
    return;
  }

  // El invitado nunca envía su nombre ni su cantidad: vienen del registro admin.
  const respuesta = {
    guest_id: guest.id,
    estado: decision,
    telefono: guest.telefono || null,
    mensaje: String(payload.mensaje || '').trim().slice(0, 500) || null,
    fecha_respuesta: new Date().toISOString(),
  };

  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('rsvp_respuestas')
      .upsert(respuesta, { onConflict: 'guest_id' })
      .select()
      .single();
    if (error) {
      console.error('RSVP upsert error:', error.message);
      res.status(500).json({ error: 'No se pudo registrar tu respuesta' });
      return;
    }
    res.status(200).json({
      ok: true,
      estado: data.estado,
      nombre: guest.nombre,
      cantidad_personas: guest.cantidad_personas,
      fecha: data.fecha_respuesta,
      actualizado: true,
    });
    return;
  }

  // Fallback local: mismo contrato upsert
  const rows = readLocal();
  const idx = rows.findIndex((r) => r.guest_id === guest.id);
  const record = {
    ...respuesta,
    id: idx >= 0 ? rows[idx].id : rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1,
    created_at: idx >= 0 ? rows[idx].created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (idx >= 0) rows[idx] = { ...rows[idx], ...record };
  else rows.push(record);
  writeLocal(rows);

  // Keep the development fallback equivalent to the Supabase sync trigger.
  const guestsFile = path.join(DATA_DIR, 'guests.json');
  try {
    const guests = JSON.parse(fs.readFileSync(guestsFile, 'utf8'));
    const guestIndex = guests.findIndex((g) => g.id === guest.id);
    if (guestIndex !== -1) {
      guests[guestIndex] = {
        ...guests[guestIndex],
        estado: decision,
        estado_rsvp: decision,
        fecha_rsvp: record.fecha_respuesta,
        mensaje_rsvp: record.mensaje,
        updated_at: record.updated_at,
      };
      fs.writeFileSync(guestsFile, JSON.stringify(guests, null, 2), 'utf8');
    }
  } catch (error) {
    console.error('Could not sync local guest RSVP:', error.message);
    res.status(500).json({ error: 'No se pudo registrar tu respuesta' });
    return;
  }

  res.status(200).json({
    ok: true,
    estado: decision,
    nombre: guest.nombre,
    cantidad_personas: guest.cantidad_personas,
    fecha: record.fecha_respuesta,
    actualizado: idx >= 0,
  });
}

/* ════════════════ GET admin: listado de respuestas ════════════════ */
async function handleList(req, res) {
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('rsvp_respuestas')
      .select('id, guest_id, estado, telefono, mensaje, fecha_respuesta, guests!inner(nombre, cantidad_personas, pertenece, categoria, archived_at)')
      .is('guests.archived_at', null)
      .order('fecha_respuesta', { ascending: false });
    if (error) {
      console.error('RSVP list error:', error.message);
      res.status(500).json({ error: 'Error leyendo respuestas' });
      return;
    }
    const rows = (data || []).map((r) => ({
      id: r.id,
      guest_id: r.guest_id,
      nombre: r.guests?.nombre || '',
      cantidad_personas: r.guests?.cantidad_personas || 1,
      pertenece: r.guests?.pertenece || '',
      categoria: r.guests?.categoria || '',
      estado: r.estado,
      telefono: r.telefono,
      mensaje: r.mensaje,
      fecha: r.fecha_respuesta,
    }));
    res.status(200).json(rows);
    return;
  }
  const activeGuestIds = new Set(
    (() => {
      try {
        const guests = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'guests.json'), 'utf8'));
        return guests.filter((g) => !g.archived_at).map((g) => g.id);
      } catch { return []; }
    })()
  );
  res.status(200).json(readLocal().filter((r) => activeGuestIds.has(r.guest_id)));
}

/* ════════════════ DELETE admin: borrar respuesta ════════════════ */
async function handleDelete(req, res) {
  const payload = parseBody(req.body);
  const guestId = parseInt(payload.guest_id, 10);
  if (!Number.isFinite(guestId)) {
    res.status(400).json({ error: 'guest_id inválido' });
    return;
  }
  if (supabaseConfigured && supabase) {
    const { error } = await supabase.from('rsvp_respuestas').delete().eq('guest_id', guestId);
    if (error) {
      res.status(500).json({ error: 'Error eliminando respuesta' });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }
  writeLocal(readLocal().filter((r) => r.guest_id !== guestId));
  res.status(200).json({ ok: true });
}

/* ════════════════ Router ════════════════ */
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

  // Never use Vercel's ephemeral local filesystem as a production database.
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Servicio no disponible' });
    return;
  }

  try {
    if (req.method === 'POST') {
      await handleConfirm(req, res);
      return;
    }
    if (req.method === 'GET') {
      if (!isAdminRequest(req)) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }
      await handleList(req, res);
      return;
    }
    if (req.method === 'DELETE') {
      if (!isAdminRequest(req)) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }
      await handleDelete(req, res);
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('rsvps handler error:', error);
    res.status(500).json({ error: 'Error interno' });
  }
};
