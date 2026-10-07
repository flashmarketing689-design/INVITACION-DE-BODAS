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
const crypto = require('crypto');
const { isAdminRequest, getGuestByToken, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');
const {
  getInvitationByToken, getGuestForLegacyToken, isMissingMigration,
  getLocalInvitations, saveLocalInvitations,
} = require('../lib/invitations');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'rsvp_respuestas_local.json');
const RSVP_CAPACITY = 150;

function isCapacityReached(error) {
  return error?.code === '23514' && String(error.message || '').includes('wedding_capacity_reached');
}

function projectConfirmedPeople(guests, rsvps, changes) {
  const activeGuests = new Map(guests.filter((guest) => !guest.archived_at)
    .map((guest) => [String(guest.id), guest]));
  const stateByGuest = new Map();
  let total = 0;

  for (const response of rsvps) {
    const guestId = String(response.guest_id);
    stateByGuest.set(guestId, response.estado);
    const guest = activeGuests.get(guestId);
    if (guest && response.estado === 'confirmado') total += Math.max(1, Number(guest.cantidad_personas) || 1);
  }

  for (const change of changes) {
    const guestId = String(change.guest_id);
    const guest = activeGuests.get(guestId);
    if (!guest) continue;
    const quantity = Math.max(1, Number(guest.cantidad_personas) || 1);
    if (stateByGuest.get(guestId) === 'confirmado') total -= quantity;
    if (change.estado === 'confirmado') total += quantity;
    stateByGuest.set(guestId, change.estado);
  }

  return total;
}

function capacityErrorResponse(res) {
  res.status(409).json({ error: 'El cupo máximo de 150 personas ya se alcanzó. Contacta a los anfitriones.' });
}

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

function revokeLocalPassIfUnused(token, rsvps) {
  const invitations = getLocalInvitations();
  const invitation = invitations.find((row) => row.token === token && row.status === 'active');
  if (!invitation) return;
  const hasConfirmed = (invitation.members || []).some((member) => member.active !== false
    && rsvps.some((row) => String(row.guest_id) === String(member.guest_id) && row.estado === 'confirmado'));
  if (!hasConfirmed) {
    invitation.pass_token = crypto.randomUUID();
    saveLocalInvitations(invitations);
  }
}

function revokeLocalPassForGuestIfUnused(guestId, rsvps) {
  const invitations = getLocalInvitations();
  const invitation = invitations.find((row) => row.status === 'active'
    && (row.members || []).some((member) => String(member.guest_id) === String(guestId) && member.active !== false));
  if (!invitation) return;
  const hasConfirmed = (invitation.members || []).some((member) => member.active !== false
    && rsvps.some((row) => String(row.guest_id) === String(member.guest_id) && row.estado === 'confirmado'));
  if (!hasConfirmed) {
    invitation.pass_token = crypto.randomUUID();
    saveLocalInvitations(invitations);
  }
}

/* ════════════════ POST público: confirmación por token ════════════════ */
async function handleConfirm(req, res) {
  if (!allowRequest(`rsvp:${clientIp(req)}`, 30, 60 * 1000)) {
    res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en un momento.' });
    return;
  }

  const payload = parseBody(req.body);
  const token = String(payload.token || '').trim().toLowerCase();
  let invitation;
  try { invitation = await getInvitationByToken(token); }
  catch (error) {
    if (isMissingMigration(error)) {
      res.status(503).json({ error: 'Falta ejecutar la migración 004 de invitaciones en Supabase.' });
      return;
    }
    throw error;
  }
  if (!invitation) {
    res.status(404).json({ error: 'Invitación no encontrada' });
    return;
  }

  // Los registros antiguos con cupos anónimos conservan su respuesta agregada
  // hasta que el administrador identifique a cada persona.
  if (invitation.legacy_review_required) {
    await handleLegacyConfirm(token, payload, res);
    return;
  }

  const normalizeDecision = (value) => value === 'si' || value === 'confirmado' ? 'confirmado'
    : value === 'no_asiste' ? 'no_asiste' : null;
  const memberById = new Map(invitation.members.map((member) => [member.member_id, member]));
  let responses = Array.isArray(payload.responses) ? payload.responses.map((row) => ({
    member_id: String(row?.member_id || '').trim().toLowerCase(),
    estado: normalizeDecision(row?.estado || row?.asistencia),
    expected_estado: row?.expected_estado === undefined
      ? (memberById.get(String(row?.member_id || '').trim().toLowerCase())?.estado_rsvp || null)
      : row.expected_estado === null ? null : normalizeDecision(row.expected_estado),
  })) : [];

  // Keep the old single-person form contract working for individual links.
  if (!responses.length && invitation.members.length === 1) {
    const estado = normalizeDecision(payload.asistencia);
    if (estado) responses = [{ member_id: invitation.members[0].member_id, estado,
      expected_estado: invitation.members[0].estado_rsvp || null }];
  }
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!responses.length || responses.length > 100 || responses.some((row) => !idPattern.test(row.member_id) || !row.estado)
      || responses.some((row) => row.expected_estado && !['confirmado', 'no_asiste'].includes(row.expected_estado))
      || new Set(responses.map((row) => row.member_id)).size !== responses.length) {
    res.status(400).json({ error: 'Selecciona una respuesta válida para cada persona que vayas a responder.' });
    return;
  }
  const invitationMembers = new Set(invitation.members.map((member) => member.member_id));
  if (responses.some((row) => !invitationMembers.has(row.member_id))) {
    res.status(400).json({ error: 'Una respuesta no pertenece a esta invitación.' });
    return;
  }
  const message = String(payload.mensaje || '').trim().slice(0, 500) || null;

  if (supabaseConfigured && supabase) {
    const { error } = await supabase.rpc('save_invitation_responses', {
      p_token: token,
      p_responses: responses,
      p_message: message,
    });
    if (error) {
      console.error('Grouped RSVP save error:', error.message);
      if (isCapacityReached(error)) { capacityErrorResponse(res); return; }
      if (error.code === '22023' || error.code === '40001') {
        res.status(409).json({ error: 'La invitación cambió o una respuesta ya no pertenece a este grupo. Recarga la página.' });
        return;
      }
      res.status(500).json({ error: 'No se pudo guardar las respuestas' });
      return;
    }
    invitation = await getInvitationByToken(token);
  } else {
    const guestsFile = path.join(DATA_DIR, 'guests.json');
    const guests = JSON.parse(fs.readFileSync(guestsFile, 'utf8'));
    const rows = readLocal();
    const now = new Date().toISOString();
    for (const response of responses) {
      const member = invitation.members.find((row) => row.member_id === response.member_id);
      const current = rows.find((row) => String(row.guest_id) === String(member?.guest_id));
      if ((current?.estado || null) !== response.expected_estado) {
        res.status(409).json({ error: 'Otra persona actualizó esta respuesta. Recarga la invitación y revisa el estado.' });
        return;
      }
    }
    const targetRows = [];
    for (const response of responses) {
      const member = invitation.members.find((row) => row.member_id === response.member_id);
      const guestIndex = guests.findIndex((row) => String(row.id) === String(member?.guest_id));
      if (guestIndex < 0 || guests[guestIndex].archived_at) {
        res.status(409).json({ error: 'Una persona de la invitación ya no está activa. Recarga la página.' });
        return;
      }
      targetRows.push({ response, member, guest: guests[guestIndex], guestIndex });
    }
    if (projectConfirmedPeople(guests, rows, targetRows.map(({ response, member }) => ({
      guest_id: member.guest_id, estado: response.estado,
    }))) > RSVP_CAPACITY) {
      capacityErrorResponse(res);
      return;
    }
    for (const { response, guest, guestIndex } of targetRows) {
      const idx = rows.findIndex((row) => String(row.guest_id) === String(guest.id));
      const record = {
        id: idx >= 0 ? rows[idx].id : rows.reduce((m, row) => Math.max(m, row.id || 0), 0) + 1,
        guest_id: guest.id,
        estado: response.estado,
        telefono: guest.telefono || null,
        mensaje: message,
        fecha_respuesta: now,
        created_at: idx >= 0 ? rows[idx].created_at : now,
        updated_at: now,
      };
      if (idx >= 0) rows[idx] = { ...rows[idx], ...record };
      else rows.push(record);
      guests[guestIndex] = {
        ...guest,
        estado: response.estado,
        estado_rsvp: response.estado,
        fecha_rsvp: now,
        mensaje_rsvp: message,
        updated_at: now,
      };
    }
    writeLocal(rows);
    revokeLocalPassIfUnused(token, rows);
    fs.writeFileSync(guestsFile, JSON.stringify(guests, null, 2), 'utf8');
    invitation = await getInvitationByToken(token);
  }

  const answered = invitation.members.filter((member) => member.estado_rsvp).length;
  const confirmed = invitation.members.filter((member) => member.estado_rsvp === 'confirmado').length;
  const declined = invitation.members.filter((member) => member.estado_rsvp === 'no_asiste').length;
  res.status(200).json({
    ok: true,
    nombre: invitation.display_name,
    cantidad_personas: invitation.members.length,
    estado: invitation.members.length === 1 ? invitation.members[0].estado_rsvp : null,
    fecha: new Date().toISOString(),
    members: invitation.members.map((member) => ({
      member_id: member.member_id,
      nombre: member.nombre,
      estado_rsvp: member.estado_rsvp || null,
      fecha_rsvp: member.fecha_rsvp || null,
    })),
    resumen: {
      confirmados: confirmed,
      no_asisten: declined,
      pendientes: invitation.members.length - answered,
    },
    qr_disponible: confirmed > 0,
    actualizado: true,
  });
}

async function handleLegacyConfirm(token, payload, res) {
  const guest = await getGuestForLegacyToken(token);
  const decision = payload.asistencia === 'no_asiste' ? 'no_asiste'
    : payload.asistencia === 'si' || payload.asistencia === 'confirmado' ? 'confirmado' : null;
  if (!guest || !decision) {
    res.status(400).json({ error: 'Respuesta inválida' });
    return;
  }
  const respuesta = {
    guest_id: guest.id,
    estado: decision,
    telefono: guest.telefono || null,
    mensaje: String(payload.mensaje || '').trim().slice(0, 500) || null,
    fecha_respuesta: new Date().toISOString(),
  };
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.from('rsvp_respuestas')
      .upsert(respuesta, { onConflict: 'guest_id' }).select().single();
    if (error) {
      console.error('Legacy RSVP upsert error:', error.message);
      if (isCapacityReached(error)) { capacityErrorResponse(res); return; }
      res.status(500).json({ error: 'No se pudo registrar tu respuesta' });
      return;
    }
    res.status(200).json({ ok: true, estado: data.estado, nombre: guest.nombre,
      cantidad_personas: guest.cantidad_personas, fecha: data.fecha_respuesta, actualizado: true });
    return;
  }
  const rows = readLocal();
  const guestsFile = path.join(DATA_DIR, 'guests.json');
  let guests;
  try { guests = JSON.parse(fs.readFileSync(guestsFile, 'utf8')); }
  catch (error) {
    console.error('Could not read local guest records:', error.message);
    res.status(500).json({ error: 'No se pudo registrar tu respuesta' });
    return;
  }
  if (projectConfirmedPeople(guests, rows, [{ guest_id: guest.id, estado: decision }]) > RSVP_CAPACITY) {
    capacityErrorResponse(res);
    return;
  }
  const idx = rows.findIndex((row) => String(row.guest_id) === String(guest.id));
  const now = new Date().toISOString();
  const record = {
    ...respuesta,
    id: idx >= 0 ? rows[idx].id : rows.reduce((m, row) => Math.max(m, row.id || 0), 0) + 1,
    created_at: idx >= 0 ? rows[idx].created_at : now,
    updated_at: now,
  };
  if (idx >= 0) rows[idx] = { ...rows[idx], ...record };
  else rows.push(record);
  try {
    const guestIndex = guests.findIndex((row) => String(row.id) === String(guest.id));
    if (guestIndex !== -1) {
      guests[guestIndex] = { ...guests[guestIndex], estado: decision, estado_rsvp: decision,
        fecha_rsvp: record.fecha_respuesta, mensaje_rsvp: record.mensaje, updated_at: record.updated_at };
      fs.writeFileSync(guestsFile, JSON.stringify(guests, null, 2), 'utf8');
    }
    writeLocal(rows);
  } catch (error) {
    console.error('Could not sync local guest RSVP:', error.message);
    res.status(500).json({ error: 'No se pudo registrar tu respuesta' });
    return;
  }
  if (decision !== 'confirmado') revokeLocalPassIfUnused(token, rows);
  res.status(200).json({ ok: true, estado: decision, nombre: guest.nombre,
    cantidad_personas: guest.cantidad_personas, fecha: record.fecha_respuesta, actualizado: idx >= 0 });
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
  const remaining = readLocal().filter((r) => String(r.guest_id) !== String(guestId));
  writeLocal(remaining);
  revokeLocalPassForGuestIfUnused(guestId, remaining);
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
