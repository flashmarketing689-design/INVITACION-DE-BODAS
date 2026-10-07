const {
  isAdminRequest, getReceptionPassword, getReceptionOperator,
  setReceptionCookie, clearReceptionCookie, safeEqual, isSameOriginRequest,
} = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');
const {
  getInvitationByPassToken, isMissingMigration, getLocalCheckins, saveLocalCheckins,
} = require('../lib/invitations');
const { listInvitations } = require('./invitations');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  if (Buffer.isBuffer(body)) { try { return JSON.parse(body.toString('utf8')); } catch { return {}; } }
  return body;
}

function authorizedOperator(req) {
  return getReceptionOperator(req) || (isAdminRequest(req) ? 'Administración' : null);
}

function publicTicket(invitation) {
  return {
    invitation: {
      display_name: invitation.display_name,
      group_type: invitation.group_type,
      legacy_review_required: Boolean(invitation.legacy_review_required),
    },
    members: (invitation.members || []).map((member) => ({
      member_id: member.member_id,
      nombre: member.nombre,
      asistencia: member.estado_rsvp || null,
      checkin: member.checkin ? {
        checked_in_at: member.checkin.checked_in_at,
        operator_name: member.checkin.operator_name,
      } : null,
    })),
  };
}

async function getRoster() {
  if (!supabaseConfigured || !supabase) {
    return listInvitations().then((rows) => rows.filter((row) => !row.needs_review && row.members.some((member) => member.estado_rsvp === 'confirmado'))
      .map((row) => ({
        token: row.pass_token,
        display_name: row.display_name,
        group_type: row.group_type,
        legacy_review_required: row.needs_review,
        members: row.members.filter((member) => member.estado_rsvp === 'confirmado').map((member) => ({
          member_id: member.member_id, nombre: member.nombre, checkin: member.checkin,
        })),
      })));
  }
  const { data: rows, error } = await supabase.from('invitation_members')
    .select('invitation_id, public_id, guest_id, position, invitations!inner(id, token, pass_token, group_type, display_name, status, needs_review), guests!inner(id, nombre, archived_at, rsvp_respuestas!inner(estado, fecha_respuesta))')
    .eq('active', true).eq('invitations.status', 'active').eq('guests.rsvp_respuestas.estado', 'confirmado')
    .is('guests.archived_at', null).order('position', { ascending: true });
  if (error) throw error;
  const guestIds = (rows || []).map((row) => row.guest_id);
  let checkins = [];
  if (guestIds.length) {
    const { data, error: checkinError } = await supabase.from('invitation_checkins')
      .select('guest_id, checked_in_at, operator_name').in('guest_id', guestIds);
    if (checkinError) throw checkinError;
    checkins = data || [];
  }
  const grouped = new Map();
  (rows || []).forEach((row) => {
    const invitation = row.invitations || {};
    if (invitation.needs_review) return;
    const guest = row.guests || {};
    const values = grouped.get(row.invitation_id) || {
      token: invitation.pass_token, display_name: invitation.display_name,
      group_type: invitation.group_type, legacy_review_required: false, members: [],
    };
    const checkin = checkins.find((item) => String(item.guest_id) === String(row.guest_id));
    values.members.push({ member_id: row.public_id, nombre: guest.nombre,
      checkin: checkin ? { checked_in_at: checkin.checked_in_at, operator_name: checkin.operator_name } : null });
    grouped.set(row.invitation_id, values);
  });
  return [...grouped.values()];
}

async function loadTicket(token) {
  const invitation = await getInvitationByPassToken(token);
  if (!invitation) return null;
  return invitation;
}

async function handleLogin(req, res) {
  if (!allowRequest(`reception-login:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Demasiados intentos. Intenta más tarde.' });
    return;
  }
  const password = getReceptionPassword();
  if (!password || password.length < 16) {
    res.status(503).json({ error: 'Configura RECEPTION_PASS_KEY con al menos 16 caracteres en Vercel.' });
    return;
  }
  const body = parseBody(req.body);
  const operator = String(body.operator || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 60);
  if (operator.length < 2 || !safeEqual(body.password || '', password)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    res.status(401).json({ error: 'Nombre o clave incorrectos.' });
    return;
  }
  if (!setReceptionCookie(req, res, operator)) {
    res.status(503).json({ error: 'No se pudo iniciar una sesión segura.' });
    return;
  }
  res.status(200).json({ ok: true, operator });
}

async function handleCheckin(req, res, operator, body) {
  const token = String(body.pass_token || '').trim().toLowerCase();
  const ids = Array.isArray(body.member_ids) ? body.member_ids.map((value) => String(value).trim().toLowerCase()) : [];
  const requestId = String(body.request_id || '').trim().toLowerCase();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(token) || !uuidPattern.test(requestId) || ids.length < 1 || ids.length > 100
      || ids.some((id) => !uuidPattern.test(id)) || new Set(ids).size !== ids.length) {
    res.status(400).json({ error: 'Pase o personas seleccionadas no válidos.' });
    return;
  }
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('register_invitation_checkins', {
      p_token: token, p_member_ids: ids, p_operator_name: operator, p_request_id: requestId,
    });
    if (error) {
      if (error.code === '22023') { res.status(409).json({ error: 'El pase ya no está vigente o alguna persona no está confirmada.' }); return; }
      if (error.code === '23505') { res.status(409).json({ error: 'No se pudo registrar la entrada por un conflicto. Actualiza el pase e intenta de nuevo.' }); return; }
      throw error;
    }
    res.status(200).json(data);
    return;
  }

  const invitation = await loadTicket(token);
  if (!invitation || invitation.legacy_review_required) {
    res.status(409).json({ error: 'El pase no está vigente o requiere revisión administrativa.' });
    return;
  }
  const membersById = new Map(invitation.members.map((member) => [member.member_id, member]));
  const selected = ids.map((id) => membersById.get(id));
  if (selected.some((member) => !member || member.estado_rsvp !== 'confirmado')) {
    res.status(409).json({ error: 'Solo se pueden registrar personas confirmadas de este pase.' });
    return;
  }
  const checkins = getLocalCheckins();
  const results = [];
  for (const member of selected) {
    const existing = checkins.find((row) => String(row.guest_id) === String(member.guest_id));
    if (existing) {
      results.push({ member_id: member.member_id, nombre: member.nombre,
        status: existing.request_id === requestId ? 'registered' : 'already',
        checked_in_at: existing.checked_in_at, operator_name: existing.operator_name });
      continue;
    }
    const row = { invitation_id: invitation.id, guest_id: member.guest_id, public_id: member.member_id,
      operator_name: operator, request_id: requestId, checked_in_at: new Date().toISOString() };
    checkins.push(row);
    results.push({ member_id: member.member_id, nombre: member.nombre, status: 'registered',
      checked_in_at: row.checked_in_at, operator_name: operator });
  }
  saveLocalCheckins(checkins);
  res.status(200).json({ results });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isSameOriginRequest(req)) { res.status(403).json({ error: 'Origen no permitido' }); return; }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const action = url.searchParams.get('action');
  if (req.method === 'POST' && action === 'login') { await handleLogin(req, res); return; }
  if (req.method === 'POST' && action === 'logout') {
    clearReceptionCookie(req, res); res.status(200).json({ ok: true }); return;
  }
  const operator = authorizedOperator(req);
  if (req.method === 'GET' && action === 'session') {
    res.status(200).json({ authenticated: Boolean(operator), operator: operator || null,
      configured: getReceptionPassword().length >= 16 });
    return;
  }
  if (!operator) { res.status(401).json({ error: 'Inicia sesión de recepción.' }); return; }
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Almacenamiento no configurado' }); return;
  }

  try {
    if (req.method === 'GET' && url.searchParams.has('ticket')) {
      const token = (url.searchParams.get('ticket') || '').trim().toLowerCase();
      const invitation = await loadTicket(token);
      if (!invitation || invitation.status !== 'active') { res.status(404).json({ error: 'Pase no encontrado o revocado.' }); return; }
      res.status(200).json(publicTicket(invitation));
      return;
    }
    if (req.method === 'GET' && url.searchParams.get('list') === '1') {
      res.status(200).json(await getRoster());
      return;
    }
    if (req.method === 'POST') {
      await handleCheckin(req, res, operator, parseBody(req.body));
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Check-in API error:', error.message);
    if (isMissingMigration(error)) {
      res.status(503).json({ error: 'Falta ejecutar la migración 004 de invitaciones en Supabase.' });
      return;
    }
    res.status(500).json({ error: 'No se pudo verificar el pase. Revisa la conexión e intenta de nuevo.' });
  }
};
