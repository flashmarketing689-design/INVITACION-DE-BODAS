const crypto = require('crypto');
const { isAdminRequest, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const {
  DATA_DIR, readJson, writeJson, getLocalInvitations, saveLocalInvitations,
  getLocalCheckins, ensureLocalSingletons, getInvitationByToken, isMissingMigration,
} = require('../lib/invitations');

const GUESTS_FILE = require('path').join(DATA_DIR, 'guests.json');

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  if (Buffer.isBuffer(body)) { try { return JSON.parse(body.toString('utf8')); } catch { return {}; } }
  return body;
}

function errorResponse(res, error, genericMessage) {
  console.error('Invitations API error:', error?.message || error);
  if (isMissingMigration(error)) {
    const migration = /add_invitation_members/i.test(String(error?.message || ''))
      ? '007_add_invitation_members.sql para permitir agregar integrantes a una invitación.'
      : '004_group_invitations_checkin.sql de invitaciones agrupadas en Supabase.';
    res.status(503).json({ error: `Primero ejecuta la migración ${migration}` });
  } else if (error?.code === '23505' || error?.code === '22023') {
    const raw = String(error.message || '');
    let message = raw || 'La invitación cambió o incluye personas que ya están agrupadas.';
    if (/check.?in|checked in/i.test(raw)) message = 'No se puede modificar una invitación que ya tiene entradas registradas.';
    else if (/already grouped|already in this invitation|split an existing group/i.test(raw)) message = 'La persona ya pertenece a un grupo. Separa primero esa invitación antes de volver a agruparla.';
    else if (/invitation not found/i.test(raw)) message = 'No encontramos una invitación activa con esos datos. Recarga la lista.';
    else if (/invalid|between two and one hundred|individually identified/i.test(raw)) message = 'Revisa los nombres y confirma que cada integrante tenga su propio registro.';
    res.status(error.code === '22023' ? 400 : 409).json({ error: message });
  } else {
    res.status(500).json({ error: genericMessage });
  }
}

function localSnapshots() {
  const guests = readJson(GUESTS_FILE).filter((guest) => !guest.archived_at);
  const rsvps = readJson(require('path').join(DATA_DIR, 'rsvp_respuestas_local.json'));
  const checkins = getLocalCheckins();
  const invitations = ensureLocalSingletons().filter((invitation) => invitation.status === 'active');
  const assignedIds = new Set(invitations.flatMap((invitation) =>
    (invitation.members || []).filter((member) => member.active !== false).map((member) => String(member.guest_id))));

  guests.filter((guest) => !assignedIds.has(String(guest.id))).forEach((guest) => {
    invitations.push({
      id: `local-${guest.id}`,
      token: guest.token,
      group_type: 'individual',
      display_name: guest.nombre,
      status: 'active',
      needs_review: (Number(guest.cantidad_personas) || 1) > 1,
      sent_at: guest.fecha_invitacion_enviada || null,
      created_at: guest.created_at || null,
      members: [{ public_id: guest.public_id || guest.token, guest_id: guest.id, position: 0, active: true }],
    });
  });

  return invitations.map((invitation) => ({
    id: invitation.id,
    token: invitation.token,
    pass_token: invitation.pass_token,
    group_type: invitation.group_type,
    display_name: invitation.display_name,
    status: invitation.status,
    needs_review: Boolean(invitation.needs_review),
    sent_at: invitation.sent_at || null,
    members: (invitation.members || []).filter((member) => member.active !== false).map((member) => {
      const guest = guests.find((row) => String(row.id) === String(member.guest_id));
      if (!guest) return null;
      const rsvp = rsvps.find((row) => String(row.guest_id) === String(guest.id));
      const checkin = checkins.find((row) => String(row.guest_id) === String(guest.id));
      return {
        member_id: member.public_id || member.member_id,
        guest_id: guest.id,
        position: member.position || 0,
        nombre: guest.nombre,
        telefono: guest.telefono || null,
        pertenece: guest.pertenece,
        categoria: guest.categoria,
        cantidad_personas: Number(guest.cantidad_personas) || 1,
        estado_rsvp: rsvp?.estado || guest.estado_rsvp || null,
        fecha_rsvp: rsvp?.fecha_respuesta || guest.fecha_rsvp || null,
        checkin: checkin ? { checked_in_at: checkin.checked_in_at, operator_name: checkin.operator_name } : null,
      };
    }).filter(Boolean),
  }));
}

async function listInvitations() {
  if (!supabaseConfigured || !supabase) return localSnapshots();
  const { data: invitations, error } = await supabase.from('invitations')
    .select('id, token, pass_token, group_type, display_name, status, needs_review, sent_at, created_at')
    .eq('status', 'active').order('created_at', { ascending: true });
  if (error) throw error;
  const ids = (invitations || []).map((row) => row.id);
  if (!ids.length) return [];
  const { data: memberRows, error: memberError } = await supabase.from('invitation_members')
    .select('invitation_id, public_id, guest_id, position, guests!inner(id, nombre, telefono, pertenece, categoria, cantidad_personas, estado_rsvp, fecha_rsvp, archived_at, rsvp_respuestas(estado, fecha_respuesta))')
    .in('invitation_id', ids).eq('active', true).is('guests.archived_at', null)
    .order('position', { ascending: true });
  if (memberError) throw memberError;
  const guestIds = (memberRows || []).map((row) => row.guest_id);
  let checkins = [];
  if (guestIds.length) {
    const { data, error: checkinError } = await supabase.from('invitation_checkins')
      .select('guest_id, checked_in_at, operator_name').in('guest_id', guestIds);
    if (checkinError) throw checkinError;
    checkins = data || [];
  }
  const membersByInvite = new Map();
  (memberRows || []).forEach((row) => {
    const guest = row.guests || {};
    const rsvp = (guest.rsvp_respuestas || [])[0] || {};
    const checkin = checkins.find((item) => String(item.guest_id) === String(row.guest_id));
    const values = membersByInvite.get(row.invitation_id) || [];
    values.push({
      member_id: row.public_id,
      guest_id: row.guest_id,
      position: row.position,
      nombre: guest.nombre,
      telefono: guest.telefono,
      pertenece: guest.pertenece,
      categoria: guest.categoria,
      cantidad_personas: guest.cantidad_personas,
      estado_rsvp: rsvp.estado || guest.estado_rsvp || null,
      fecha_rsvp: rsvp.fecha_respuesta || guest.fecha_rsvp || null,
      checkin: checkin ? { checked_in_at: checkin.checked_in_at, operator_name: checkin.operator_name } : null,
    });
    membersByInvite.set(row.invitation_id, values);
  });
  return (invitations || []).map((invitation) => ({
    ...invitation,
    members: membersByInvite.get(invitation.id) || [],
  }));
}

function defaultDisplayName(type, people, supplied) {
  const name = String(supplied || '').trim().slice(0, 120);
  if (name) return name;
  if (type === 'couple') return people.map((guest) => guest.nombre).join(' y ');
  const surname = String(people[0]?.nombre || '').trim().split(/\s+/).at(-1) || 'Familia';
  return `Familia ${surname}`.slice(0, 120);
}

async function createGroup(payload, res) {
  const type = payload.group_type;
  const ids = Array.isArray(payload.guest_ids) ? payload.guest_ids.map((value) => Number(value)) : [];
  const unique = new Set(ids);
  if (!['couple', 'family'].includes(type) || ids.length < 2 || ids.length > 100
      || unique.size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || (type === 'couple' && ids.length !== 2)) {
    res.status(400).json({ error: 'Una pareja requiere exactamente dos personas; una familia requiere entre dos y cien.' });
    return;
  }

  if (supabaseConfigured && supabase) {
    const { data: guests, error: guestError } = await supabase.from('guests')
      .select('id, nombre, cantidad_personas').in('id', ids).is('archived_at', null);
    if (guestError) throw guestError;
    if ((guests || []).length !== ids.length || guests.some((guest) => guest.cantidad_personas !== 1)) {
      res.status(409).json({ error: 'Solo puedes agrupar personas activas con un nombre y un registro individual.' });
      return;
    }
    const label = defaultDisplayName(type, ids.map((id) => guests.find((guest) => guest.id === id)), payload.display_name);
    const { data, error } = await supabase.rpc('group_guests', {
      p_guest_ids: ids,
      p_group_type: type,
      p_display_name: label,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const invitation = await getInvitationByToken(result.token);
    res.status(201).json({ ...invitation, message: 'El enlace anterior de cada integrante quedó revocado; envía el enlace compartido nuevo.' });
    return;
  }

  const guests = readJson(GUESTS_FILE);
  const selected = ids.map((id) => guests.find((guest) => Number(guest.id) === id && !guest.archived_at));
  if (selected.some((guest) => !guest || Number(guest.cantidad_personas) !== 1)) {
    res.status(409).json({ error: 'Solo puedes agrupar personas activas con un nombre y un registro individual.' });
    return;
  }
  const records = ensureLocalSingletons();
  const checkins = getLocalCheckins();
  const selectedIds = new Set(ids.map(String));
  const affected = records.filter((record) => record.status === 'active'
    && (record.members || []).some((member) => selectedIds.has(String(member.guest_id)) && member.active !== false));
  if (affected.some((record) => record.group_type !== 'individual'
      || record.needs_review
      || (record.members || []).filter((member) => member.active !== false).length !== 1)) {
    res.status(409).json({ error: 'Separa primero los grupos existentes y revisa los registros antiguos.' });
    return;
  }
  if (checkins.some((row) => selectedIds.has(String(row.guest_id)))) {
    res.status(409).json({ error: 'No se puede reagrupar a una persona que ya registró su entrada.' });
    return;
  }
  const label = defaultDisplayName(type, selected, payload.display_name);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  affected.forEach((record) => {
    record.status = 'replaced';
    record.replaced_by = id;
    record.replaced_at = now;
    (record.members || []).forEach((member) => { member.active = false; member.removed_at = now; });
  });
  selected.forEach((guest) => {
    guest.token = crypto.randomUUID();
    guest.invitacion_enviada = false;
    guest.fecha_invitacion_enviada = null;
    guest.estado = guest.estado_rsvp || 'pendiente';
  });
  const invitation = {
    id,
    token: crypto.randomUUID(),
    pass_token: crypto.randomUUID(),
    group_type: type,
    display_name: label,
    status: 'active',
    needs_review: false,
    sent_at: null,
    created_at: now,
    members: selected.map((guest, position) => ({
      public_id: crypto.randomUUID(), guest_id: guest.id, position, active: true,
    })),
  };
  records.push(invitation);
  saveLocalInvitations(records);
  writeJson(GUESTS_FILE, guests);
  const created = await getInvitationByToken(invitation.token);
  res.status(201).json({ ...created, message: 'El enlace anterior de cada integrante quedó revocado; envía el enlace compartido nuevo.' });
}

function normalizeNewMembers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 99) return null;
  const allowedCategories = ['familiares', 'amigos', 'companeros', 'iglesia', 'participantes'];
  const members = value.map((row) => ({
    nombre: String(row?.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    telefono: String(row?.telefono || '').trim().slice(0, 30) || null,
    pertenece: row?.pertenece === 'novia' ? 'novia' : row?.pertenece === 'novio' ? 'novio' : '',
    categoria: allowedCategories.includes(row?.categoria) ? row.categoria : '',
  }));
  if (members.some((member) => !member.nombre || member.nombre.split(/\s+/).length < 2
      || !member.pertenece || !member.categoria)) return null;
  return members;
}

async function addMembers(payload, res) {
  const invitationId = typeof payload.invitation_id === 'string' ? payload.invitation_id.trim() : '';
  const ids = Array.isArray(payload.guest_ids) ? payload.guest_ids.map((value) => Number(value)) : [];
  const newMembers = normalizeNewMembers(payload.new_members);
  const displayName = String(payload.display_name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!invitationId || !newMembers || (!ids.length && !newMembers.length)
      || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(ids).size !== ids.length || ids.length + newMembers.length > 99
      || (displayName && displayName.length < 2)) {
    res.status(400).json({ error: 'Revisa las personas que quieres agregar y el nombre de la invitación.' });
    return;
  }

  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('add_invitation_members', {
      p_invitation_id: invitationId,
      p_guest_ids: ids,
      p_new_members: newMembers,
      p_display_name: displayName || null,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const invitation = await getInvitationByToken(result.token);
    res.status(200).json({ ...invitation, added_count: Number(result.added_count) || 0,
      message: 'Integrantes agregados. El enlace anterior dejó de funcionar; comparte el nuevo enlace.' });
    return;
  }

  const guests = readJson(GUESTS_FILE);
  const records = ensureLocalSingletons();
  const invitation = records.find((row) => row.id === invitationId && row.status === 'active');
  if (!invitation) { res.status(404).json({ error: 'Invitación activa no encontrada.' }); return; }
  const currentMembers = (invitation.members || []).filter((member) => member.active !== false
    && guests.some((guest) => String(guest.id) === String(member.guest_id) && !guest.archived_at));
  const selected = ids.map((id) => guests.find((guest) => Number(guest.id) === id && !guest.archived_at));
  if (invitation.needs_review || currentMembers.some((member) => {
    const guest = guests.find((row) => String(row.id) === String(member.guest_id));
    return !guest || Number(guest.cantidad_personas || 1) !== 1;
  })) {
    res.status(409).json({ error: 'Primero identifica a cada persona del registro antiguo.' });
    return;
  }
  if (selected.some((guest) => !guest || Number(guest.cantidad_personas || 1) !== 1)
      || currentMembers.some((member) => ids.some((id) => String(id) === String(member.guest_id)))) {
    res.status(409).json({ error: 'Solo puedes agregar personas individuales que todavía no estén en esta invitación.' });
    return;
  }
  const addedIds = new Set(ids.map(String));
  const sourceInvitations = records.filter((row) => row.status === 'active'
    && (row.members || []).some((member) => member.active !== false && addedIds.has(String(member.guest_id))));
  if (sourceInvitations.some((row) => row.id === invitation.id || row.group_type !== 'individual'
      || row.needs_review || (row.members || []).filter((member) => member.active !== false).length !== 1)) {
    res.status(409).json({ error: 'Solo puedes agregar personas con invitación individual; separa primero los grupos existentes.' });
    return;
  }
  const checkins = getLocalCheckins();
  const allMemberIds = [...currentMembers.map((member) => String(member.guest_id)), ...ids.map(String)];
  if (allMemberIds.some((id) => checkins.some((row) => String(row.guest_id) === id))) {
    res.status(409).json({ error: 'No se puede modificar una invitación que ya tiene entradas registradas.' });
    return;
  }
  const total = currentMembers.length + ids.length + newMembers.length;
  if (total < 2 || total > 100) {
    res.status(400).json({ error: 'Una invitación compartida debe incluir entre dos y cien personas.' });
    return;
  }

  const now = new Date().toISOString();
  const nextId = guests.reduce((max, guest) => Math.max(max, Number(guest.id) || 0), 1000) + 1;
  const createdGuests = newMembers.map((member, index) => ({
    ...member,
    id: nextId + index,
    cantidad_personas: 1,
    notas: null,
    token: crypto.randomUUID(),
    invitacion_enviada: false,
    fecha_invitacion_enviada: null,
    estado: 'pendiente',
    estado_rsvp: null,
    fecha_rsvp: null,
    created_at: now,
    updated_at: now,
  }));
  const additions = [...selected, ...createdGuests];
  sourceInvitations.forEach((source) => {
    source.status = 'replaced';
    source.replaced_by = invitation.id;
    source.replaced_at = now;
    (source.members || []).forEach((member) => { member.active = false; member.removed_at = now; });
  });
  const orderedCurrent = [...currentMembers].sort((a, b) => (a.position || 0) - (b.position || 0));
  const orderedGuests = [...orderedCurrent.map((member) => guests.find((guest) => String(guest.id) === String(member.guest_id))), ...additions];
  const finalType = total === 2 ? 'couple' : 'family';
  const fallbackName = finalType === 'couple'
    ? orderedGuests.map((guest) => guest.nombre).join(' y ')
    : invitation.group_type === 'family' ? invitation.display_name : defaultDisplayName('family', orderedGuests);
  invitation.display_name = displayName || fallbackName;
  invitation.group_type = finalType;
  invitation.token = crypto.randomUUID();
  invitation.pass_token = crypto.randomUUID();
  invitation.sent_at = null;
  invitation.updated_at = now;
  [...currentMembers.map((member) => guests.find((guest) => String(guest.id) === String(member.guest_id))), ...additions]
    .filter(Boolean)
    .forEach((guest) => {
      guest.invitacion_enviada = false;
      guest.fecha_invitacion_enviada = null;
      guest.updated_at = now;
    });
  const currentPosition = currentMembers.length;
  additions.forEach((guest, index) => {
    guest.token = crypto.randomUUID();
    invitation.members.push({
      public_id: crypto.randomUUID(), guest_id: guest.id, position: currentPosition + index, active: true,
    });
  });
  writeJson(GUESTS_FILE, [...guests, ...createdGuests]);
  saveLocalInvitations(records);
  const created = await getInvitationByToken(invitation.token);
  res.status(200).json({ ...created, added_count: additions.length,
    message: 'Integrantes agregados. El enlace anterior dejó de funcionar; comparte el nuevo enlace.' });
}

async function splitGroup(invitationId, res) {
  if (typeof invitationId !== 'string' || !invitationId) {
    res.status(400).json({ error: 'invitation_id inválido' });
    return;
  }
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('split_invitation', { p_invitation_id: invitationId });
    if (error) throw error;
    res.status(200).json({ ok: true, separated: Number(data) || 0,
      message: 'Se crearon nuevos enlaces individuales. Las respuestas existentes se conservaron.' });
    return;
  }
  const records = ensureLocalSingletons();
  const invitation = records.find((row) => row.id === invitationId && row.status === 'active');
  if (!invitation || invitation.group_type === 'individual' || invitation.needs_review) {
    res.status(404).json({ error: 'Invitación compartida no encontrada.' });
    return;
  }
  const checkins = getLocalCheckins();
  if ((invitation.members || []).some((member) => checkins.some((row) => String(row.guest_id) === String(member.guest_id)))) {
    res.status(409).json({ error: 'No se puede separar un grupo que ya registró entradas.' });
    return;
  }
  const now = new Date().toISOString();
  invitation.status = 'replaced';
  invitation.replaced_at = now;
  invitation.members.forEach((member) => { member.active = false; member.removed_at = now; });
  const guests = readJson(GUESTS_FILE);
  const created = [];
  invitation.members.forEach((member) => {
    const guest = guests.find((row) => String(row.id) === String(member.guest_id));
    if (!guest || guest.archived_at) return;
    guest.token = crypto.randomUUID();
    guest.invitacion_enviada = false;
    guest.fecha_invitacion_enviada = null;
    const record = {
      id: crypto.randomUUID(), token: guest.token, pass_token: crypto.randomUUID(), group_type: 'individual',
      display_name: guest.nombre, status: 'active', needs_review: Number(guest.cantidad_personas) !== 1,
      sent_at: null, created_at: now,
      members: [{ public_id: crypto.randomUUID(), guest_id: guest.id, position: 0, active: true }],
    };
    records.push(record);
    created.push(record);
  });
  saveLocalInvitations(records);
  writeJson(GUESTS_FILE, guests);
  res.status(200).json({ ok: true, separated: created.length,
    message: 'Se crearon nuevos enlaces individuales. Las respuestas existentes se conservaron.' });
}

async function rotateLink(invitationId, res) {
  if (typeof invitationId !== 'string' || !invitationId) {
    res.status(400).json({ error: 'invitation_id inválido' });
    return;
  }
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('rotate_invitation_token', { p_invitation_id: invitationId });
    if (error) throw error;
    res.status(200).json({ ok: true, token: data, invitation_id: invitationId });
    return;
  }
  const records = ensureLocalSingletons();
  const invitation = records.find((row) => row.id === invitationId && row.status === 'active');
  if (!invitation) { res.status(404).json({ error: 'Invitación no encontrada.' }); return; }
  if (invitation.members.some((member) => getLocalCheckins().some((row) => String(row.guest_id) === String(member.guest_id)))) {
    res.status(409).json({ error: 'No se puede regenerar un pase que ya registró entradas.' });
    return;
  }
  invitation.token = crypto.randomUUID();
  invitation.pass_token = crypto.randomUUID();
  invitation.sent_at = null;
  const guests = readJson(GUESTS_FILE);
  invitation.members.filter((member) => member.active !== false).forEach((member) => {
    const guest = guests.find((row) => String(row.id) === String(member.guest_id));
    if (guest) {
      guest.token = crypto.randomUUID();
      guest.invitacion_enviada = false;
      guest.fecha_invitacion_enviada = null;
    }
  });
  saveLocalInvitations(records);
  writeJson(GUESTS_FILE, guests);
  res.status(200).json({ ok: true, token: invitation.token, invitation_id: invitationId });
}

async function markSent(invitationId, value, res) {
  if (typeof invitationId !== 'string' || !invitationId || typeof value !== 'boolean') {
    res.status(400).json({ error: 'Datos de envío inválidos.' });
    return;
  }
  const timestamp = value ? new Date().toISOString() : null;
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('mark_invitation_sent', {
      p_invitation_id: invitationId,
      p_value: value,
    });
    if (error) throw error;
    res.status(200).json({ ok: true, sent_at: data || null });
    return;
  }
  const records = ensureLocalSingletons();
  const invitation = records.find((row) => row.id === invitationId && row.status === 'active');
  if (!invitation) { res.status(404).json({ error: 'Invitación no encontrada.' }); return; }
  invitation.sent_at = timestamp;
  const guests = readJson(GUESTS_FILE);
  invitation.members.filter((member) => member.active !== false).forEach((member) => {
    const guest = guests.find((row) => String(row.id) === String(member.guest_id));
    if (guest) {
      guest.invitacion_enviada = value;
      guest.fecha_invitacion_enviada = timestamp;
    }
  });
  saveLocalInvitations(records);
  writeJson(GUESTS_FILE, guests);
  res.status(200).json({ ok: true, sent_at: timestamp });
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
    if (req.method === 'GET') {
      const result = await listInvitations();
      res.status(200).json(result);
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const body = parseBody(req.body);
    switch (url.searchParams.get('action')) {
      case 'split': await splitGroup(body.invitation_id, res); return;
      case 'add-members': await addMembers(body, res); return;
      case 'regenerate': await rotateLink(body.invitation_id, res); return;
      case 'mark-sent': await markSent(body.invitation_id, body.value, res); return;
      default: await createGroup(body, res);
    }
  } catch (error) {
    errorResponse(res, error, 'No se pudo completar la operación de invitación.');
  }
};

module.exports.listInvitations = listInvitations;
