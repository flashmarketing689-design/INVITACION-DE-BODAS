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
const { getLocalInvitations, saveLocalInvitations, ensureLocalSingletons, isMissingMigration } = require('../lib/invitations');

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
  const categoria = ['familiares', 'amigos', 'companeros', 'iglesia', 'participantes'].includes(payload.categoria)
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

async function decorateGuests(rows) {
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.from('invitation_members')
      .select('guest_id, invitation_id, invitations!inner(token, group_type, display_name, status, needs_review)')
      .eq('active', true).eq('invitations.status', 'active');
    if (error) {
      if (isMissingMigration(error)) return rows;
      throw error;
    }
    const byGuest = new Map((data || []).map((row) => [String(row.guest_id), row]));
    return rows.map((guest) => {
      const row = byGuest.get(String(guest.id));
      if (!row) return guest;
      const invitation = row.invitations || {};
      return { ...guest, invitation_id: row.invitation_id, invitation_token: invitation.token,
        invitation_type: invitation.group_type, invitation_name: invitation.display_name,
        invitation_needs_review: Boolean(invitation.needs_review) };
    });
  }
  const byGuest = new Map();
  ensureLocalSingletons().filter((row) => row.status === 'active').forEach((invitation) => {
    (invitation.members || []).filter((member) => member.active !== false).forEach((member) => {
      byGuest.set(String(member.guest_id), invitation);
    });
  });
  return rows.map((guest) => {
    const invitation = byGuest.get(String(guest.id));
    return invitation ? { ...guest, invitation_id: invitation.id, invitation_token: invitation.token,
      invitation_type: invitation.group_type, invitation_name: invitation.display_name,
      invitation_needs_review: Boolean(invitation.needs_review) } : guest;
  });
}

async function getActiveMembership(guestId) {
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.from('invitation_members')
      .select('invitation_id, invitations!inner(group_type, status, needs_review)')
      .eq('guest_id', guestId).eq('active', true).eq('invitations.status', 'active').maybeSingle();
    if (error) {
      if (isMissingMigration(error)) return null;
      throw error;
    }
    return data || null;
  }
  const invitation = ensureLocalSingletons().find((row) => row.status === 'active'
    && (row.members || []).some((member) => String(member.guest_id) === String(guestId) && member.active !== false));
  return invitation ? { invitation_id: invitation.id, invitations: invitation } : null;
}

function normalizeLegacyGuest(g) {
  const base = normalizeGuestInput(g || {});
  const date = g?.enviada && g?.fecha_enviada ? new Date(g.fecha_enviada) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  const rsvpDate = g?.fecha_rsvp ? new Date(g.fecha_rsvp) : null;
  const validRsvpDate = rsvpDate && Number.isFinite(rsvpDate.getTime()) ? rsvpDate.toISOString() : null;
  const rsvpState = ['confirmado', 'no_asiste'].includes(g?.estado_rsvp) ? g.estado_rsvp : null;
  return {
    ...base,
    invitacion_enviada: Boolean(g?.enviada),
    fecha_invitacion_enviada: validDate,
    estado_rsvp: rsvpState,
    fecha_rsvp: rsvpState ? validRsvpDate : null,
    estado: rsvpState || (g?.enviada ? 'enviada' : 'pendiente'),
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
      try {
        res.status(200).json(await decorateGuests(data || []));
      } catch (decorateError) {
        console.error('Guest invitation lookup error:', decorateError.message);
        res.status(500).json({ error: 'Error leyendo invitaciones asociadas' });
      }
      return;
    }
    res.status(200).json(await decorateGuests(readLocalGuests().filter((g) => !g.archived_at)));
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
    if (clean.cantidad_personas !== 1) {
      res.status(400).json({ error: 'Registra a cada persona por separado; luego puedes reunirlas en una invitación compartida.' });
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
      if (clean.cantidad_personas > 1) {
        const { data: current, error: currentError } = await supabase.from('guests')
          .select('cantidad_personas').eq('id', id).is('archived_at', null).maybeSingle();
        if (currentError || !current || current.cantidad_personas !== clean.cantidad_personas) {
          res.status(400).json({ error: 'Cada persona debe tener su propio registro. Para resolver un cupo antiguo, revisa primero a quién incluye.' });
          return;
        }
      }
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
    if (clean.cantidad_personas > 1 && local[idx].cantidad_personas !== clean.cantidad_personas) {
      res.status(400).json({ error: 'Cada persona debe tener su propio registro. Para resolver un cupo antiguo, revisa primero a quién incluye.' });
      return;
    }
    local[idx] = { ...local[idx], ...clean, updated_at: new Date().toISOString() };
    const invitationRows = getLocalInvitations();
    const invitation = invitationRows.find((row) => row.status === 'active'
      && (row.members || []).some((member) => String(member.guest_id) === String(id) && member.active !== false));
    if (invitation) {
      invitation.needs_review = clean.cantidad_personas > 1;
      if (invitation.group_type === 'individual') invitation.display_name = clean.nombre;
      else if (invitation.group_type === 'couple') {
        invitation.display_name = invitation.members
          .filter((member) => member.active !== false)
          .sort((a, b) => a.position - b.position)
          .map((member) => local.find((guest) => String(guest.id) === String(member.guest_id))?.nombre)
          .filter(Boolean).join(' y ');
      }
      saveLocalInvitations(invitationRows);
    }
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

    if (action === 'renombrar') {
      const nombre = String(payload.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!nombre || nombre.split(' ').filter(Boolean).length < 2) {
        res.status(400).json({ error: 'El nombre completo debe incluir nombre y apellido.' });
        return;
      }

      if (supabaseConfigured && supabase) {
        const { data, error } = await supabase.from('guests')
          .update({ nombre })
          .eq('id', id)
          .is('archived_at', null)
          .select(PUBLIC_COLUMNS)
          .maybeSingle();
        if (error) {
          console.error('Guest rename error:', error.message);
          res.status(500).json({ error: 'No se pudo actualizar el nombre.' });
          return;
        }
        if (!data) { res.status(404).json({ error: 'Invitado no encontrado.' }); return; }
        res.status(200).json(data);
        return;
      }

      const local = readLocalGuests();
      const idx = local.findIndex((guest) => String(guest.id) === String(id) && !guest.archived_at);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado.' }); return; }
      local[idx] = { ...local[idx], nombre, updated_at: new Date().toISOString() };

      const invitationRows = getLocalInvitations();
      const invitation = invitationRows.find((row) => row.status === 'active'
        && (row.members || []).some((member) => String(member.guest_id) === String(id) && member.active !== false));
      if (invitation?.group_type === 'individual') {
        invitation.display_name = nombre;
        saveLocalInvitations(invitationRows);
      } else if (invitation?.group_type === 'couple') {
        invitation.display_name = invitation.members
          .filter((member) => member.active !== false)
          .sort((a, b) => a.position - b.position)
          .map((member) => local.find((guest) => String(guest.id) === String(member.guest_id))?.nombre)
          .filter(Boolean).join(' y ');
        saveLocalInvitations(invitationRows);
      }

      writeLocalGuests(local);
      res.status(200).json(local[idx]);
      return;
    }

    if (action === 'regenerar_token') {
      if (supabaseConfigured && supabase) {
        const membership = await getActiveMembership(id);
        let token;
        if (membership?.invitation_id) {
          const { data, error } = await supabase.rpc('rotate_invitation_token', { p_invitation_id: membership.invitation_id });
          if (error) {
            console.error('Invitation token rotation error:', error.message);
            res.status(error.code === '23505' ? 409 : 500).json({ error: 'No se pudo regenerar el enlace compartido' });
            return;
          }
          token = data;
        } else {
          token = newToken();
          const { error } = await supabase.from('guests').update({ token }).eq('id', id).is('archived_at', null);
          if (error) { res.status(500).json({ error: 'Error regenerando token' }); return; }
        }
        const { data, error } = await supabase.from('guests').select(PUBLIC_COLUMNS).eq('id', id).single();
        if (error) {
          res.status(500).json({ error: 'Error regenerando token' });
          return;
        }
        res.status(200).json({ ...data, token, invitation_token: token, invitation_id: membership?.invitation_id || null });
        return;
      }
      const local = readLocalGuests();
      const idx = local.findIndex((g) => g.id === id && !g.archived_at);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      const records = getLocalInvitations();
      const invitation = records.find((row) => row.status === 'active'
        && (row.members || []).some((member) => String(member.guest_id) === String(id) && member.active !== false));
      const newTok = newToken();
      let memberToken = newTok;
      if (invitation) {
        invitation.token = newTok;
        invitation.pass_token = newToken();
        invitation.sent_at = null;
        (invitation.members || []).filter((member) => member.active !== false).forEach((member) => {
          const memberGuest = local.find((row) => String(row.id) === String(member.guest_id));
          if (memberGuest) {
            memberGuest.token = newToken();
            memberGuest.invitacion_enviada = false;
            memberGuest.fecha_invitacion_enviada = null;
          }
        });
        memberToken = local[idx].token;
        saveLocalInvitations(records);
      }
      local[idx] = { ...local[idx], token: memberToken, updated_at: new Date().toISOString() };
      writeLocalGuests(local);
      res.status(200).json({ ...local[idx], invitation_token: invitation?.token || newTok, invitation_id: invitation?.id || null });
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
        const membership = await getActiveMembership(id);
        if (membership?.invitation_id) {
          const { error } = await supabase.rpc('mark_invitation_sent', {
            p_invitation_id: membership.invitation_id,
            p_value: value,
          });
          if (error) { res.status(500).json({ error: 'Error actualizando envío' }); return; }
        } else {
          const { error } = await supabase.from('guests').update(patch).eq('id', id).is('archived_at', null);
          if (error) { res.status(500).json({ error: 'Error actualizando envío' }); return; }
        }
        const { data, error } = await supabase.from('guests').select(PUBLIC_COLUMNS).eq('id', id).single();
        if (error) { res.status(500).json({ error: 'Error actualizando envío' }); return; }
        res.status(200).json(data);
        return;
      }
      const local = readLocalGuests();
      const idx = local.findIndex((g) => g.id === id && !g.archived_at);
      if (idx === -1) { res.status(404).json({ error: 'Invitado no encontrado' }); return; }
      const records = getLocalInvitations();
      const invitation = records.find((row) => row.status === 'active'
        && (row.members || []).some((member) => String(member.guest_id) === String(id) && member.active !== false));
      const members = invitation ? (invitation.members || []).filter((member) => member.active !== false) : [{ guest_id: id }];
      members.forEach((member) => {
        const guest = local.find((row) => String(row.id) === String(member.guest_id));
        if (guest && !guest.archived_at) Object.assign(guest, patch, { updated_at: new Date().toISOString() });
      });
      if (invitation) {
        invitation.sent_at = patch.fecha_invitacion_enviada;
        saveLocalInvitations(records);
      }
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
    const membership = await getActiveMembership(id);
    if (membership?.invitation_id && membership.invitations?.group_type !== 'individual') {
      res.status(409).json({ error: 'Primero separa la invitación compartida para conservar las respuestas y los enlaces del resto del grupo.' });
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
    const records = getLocalInvitations();
    const invitation = records.find((row) => row.status === 'active'
      && (row.members || []).some((member) => String(member.guest_id) === String(id) && member.active !== false));
    local[idx] = { ...local[idx], archived_at: new Date().toISOString(), token: newToken(), updated_at: new Date().toISOString() };
    if (invitation) {
      invitation.status = 'revoked';
      invitation.replaced_at = new Date().toISOString();
      invitation.members.filter((member) => member.active !== false).forEach((member) => {
        member.active = false;
        member.removed_at = invitation.replaced_at;
      });
      saveLocalInvitations(records);
    }
    writeLocalGuests(local);
    res.status(200).json({ ok: true, archived: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
