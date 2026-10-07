const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase, supabaseConfigured } = require('./supabaseClient');
const { getGuestByToken, isValidTokenFormat } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_INVITATIONS = path.join(DATA_DIR, 'invitations_local.json');
const LOCAL_CHECKINS = path.join(DATA_DIR, 'invitation_checkins_local.json');

function readJson(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

function writeJson(file, value) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function getLocalInvitations() { return readJson(LOCAL_INVITATIONS); }
function saveLocalInvitations(value) { return writeJson(LOCAL_INVITATIONS, value); }
function getLocalCheckins() { return readJson(LOCAL_CHECKINS); }
function saveLocalCheckins(value) { return writeJson(LOCAL_CHECKINS, value); }

function ensureLocalSingletons() {
  const guests = readJson(path.join(DATA_DIR, 'guests.json'));
  const invitations = getLocalInvitations();
  const assigned = new Set(invitations.filter((row) => row.status === 'active').flatMap((row) =>
    (row.members || []).filter((member) => member.active !== false).map((member) => String(member.guest_id))));
  let changed = false;
  guests.filter((guest) => !guest.archived_at && !assigned.has(String(guest.id))).forEach((guest) => {
    invitations.push({
      id: crypto.randomUUID(), token: guest.token, pass_token: crypto.randomUUID(),
      group_type: 'individual', display_name: guest.nombre, status: 'active',
      needs_review: (Number(guest.cantidad_personas) || 1) > 1,
      sent_at: guest.fecha_invitacion_enviada || null, created_at: guest.created_at || new Date().toISOString(),
      members: [{ public_id: crypto.randomUUID(), guest_id: guest.id, position: 0, active: true }],
    });
    changed = true;
  });
  if (changed) saveLocalInvitations(invitations);
  return invitations;
}

function normalizeMember(row) {
  const guest = row.guests || row.guest || {};
  const rsvpRows = Array.isArray(guest.rsvp_respuestas) ? guest.rsvp_respuestas : [];
  const rsvp = rsvpRows[0] || {};
  return {
    member_id: row.public_id || row.member_id,
    guest_id: row.guest_id ?? guest.id,
    position: row.position || 0,
    nombre: guest.nombre || row.nombre || '',
    telefono: guest.telefono || null,
    pertenece: guest.pertenece || null,
    categoria: guest.categoria || null,
    cantidad_personas: Number(guest.cantidad_personas) || 1,
    estado_rsvp: rsvp.estado || guest.estado_rsvp || null,
    fecha_rsvp: rsvp.fecha_respuesta || guest.fecha_rsvp || null,
    archived_at: guest.archived_at || null,
    checkin: row.checkin || null,
  };
}

async function resolveInvitation(token, lookupField = 'token') {
  if (!isValidTokenFormat(token)) return null;
  if (!['token', 'pass_token'].includes(lookupField)) return null;

  if (supabaseConfigured && supabase) {
    const { data: invitation, error } = await supabase
      .from('invitations')
      .select('id, token, pass_token, group_type, display_name, status, needs_review, sent_at, created_at')
      .eq(lookupField, token)
      .eq('status', 'active')
      .maybeSingle();
    if (error) {
      const failure = new Error('Invitation lookup failed');
      failure.code = error.code;
      failure.cause = error;
      throw failure;
    }
    if (!invitation) return null;

    const { data: members, error: memberError } = await supabase
      .from('invitation_members')
      .select('public_id, guest_id, position, guests!inner(id, nombre, telefono, pertenece, categoria, cantidad_personas, estado_rsvp, fecha_rsvp, archived_at, rsvp_respuestas(estado, fecha_respuesta))')
      .eq('invitation_id', invitation.id)
      .eq('active', true)
      .is('guests.archived_at', null)
      .order('position', { ascending: true });
    if (memberError) {
      const failure = new Error('Invitation members lookup failed');
      failure.code = memberError.code;
      failure.cause = memberError;
      throw failure;
    }

    const invitationMembers = (members || []).map(normalizeMember);
    if (invitationMembers.length) {
      const { data: checkins, error: checkinError } = await supabase.from('invitation_checkins')
        .select('guest_id, checked_in_at, operator_name').in('guest_id', invitationMembers.map((member) => member.guest_id));
      if (checkinError) {
        const failure = new Error('Invitation check-ins lookup failed');
        failure.code = checkinError.code;
        failure.cause = checkinError;
        throw failure;
      }
      const checkinByGuest = new Map((checkins || []).map((row) => [String(row.guest_id), row]));
      invitationMembers.forEach((member) => {
        const row = checkinByGuest.get(String(member.guest_id));
        if (row) member.checkin = { checked_in_at: row.checked_in_at, operator_name: row.operator_name };
      });
    }

    return {
      ...invitation,
      legacy_review_required: Boolean(invitation.needs_review),
      members: invitationMembers,
    };
  }

  const guests = readJson(path.join(DATA_DIR, 'guests.json'));
  const rsvps = readJson(path.join(DATA_DIR, 'rsvp_respuestas_local.json'));
  const checkins = getLocalCheckins();
  const records = ensureLocalSingletons();
  const record = records.find((row) => row[lookupField] === token && row.status === 'active');
  if (record) {
    const members = (record.members || []).filter((row) => row.active !== false).map((row) => {
      const guest = guests.find((candidate) => String(candidate.id) === String(row.guest_id));
      if (!guest || guest.archived_at) return null;
      const response = rsvps.find((candidate) => String(candidate.guest_id) === String(guest.id));
      const checked = checkins.find((candidate) => String(candidate.guest_id) === String(guest.id));
      return normalizeMember({
        ...row,
        guests: { ...guest, estado_rsvp: response?.estado || guest.estado_rsvp, fecha_rsvp: response?.fecha_respuesta || guest.fecha_rsvp },
        checkin: checked || null,
      });
    }).filter(Boolean);
    return { ...record, legacy_review_required: Boolean(record.needs_review), members };
  }

  // Old guest tokens are invitation links, never reception passes. Do not let
  // the compatibility lookup below promote them to QR credentials.
  if (lookupField === 'pass_token') return null;

  // Development/test compatibility for guests created before this migration.
  const guest = guests.find((row) => !row.archived_at && row.token && row.token.toLowerCase() === token);
  if (!guest) return null;
  const response = rsvps.find((row) => String(row.guest_id) === String(guest.id));
  const checked = checkins.find((row) => String(row.guest_id) === String(guest.id));
  const publicId = guest.public_id || guest.token;
  return {
    id: `local-${guest.id}`,
    token: guest.token,
    pass_token: guest.pass_token || guest.token,
    group_type: 'individual',
    display_name: guest.nombre,
    status: 'active',
    needs_review: (Number(guest.cantidad_personas) || 1) > 1,
    legacy_review_required: (Number(guest.cantidad_personas) || 1) > 1,
    sent_at: guest.fecha_invitacion_enviada || null,
    members: [normalizeMember({
      public_id: publicId,
      guest_id: guest.id,
      guests: { ...guest, estado_rsvp: response?.estado || guest.estado_rsvp, fecha_rsvp: response?.fecha_respuesta || guest.fecha_rsvp },
      checkin: checked || null,
    })],
  };
}

async function getInvitationByToken(token) { return resolveInvitation(token, 'token'); }
async function getInvitationByPassToken(token) { return resolveInvitation(token, 'pass_token'); }

async function getGuestForLegacyToken(token) {
  try { return await getGuestByToken(token); }
  catch (error) { throw error; }
}

function isMissingMigration(error) {
  return ['42P01', 'PGRST200', 'PGRST204', '42883'].includes(error?.code)
    || /invitation_members|invitations|register_invitation_checkins|group_guests|save_invitation_responses/i.test(String(error?.message || error?.cause?.message || ''));
}

module.exports = {
  DATA_DIR,
  LOCAL_INVITATIONS,
  LOCAL_CHECKINS,
  readJson,
  writeJson,
  getLocalInvitations,
  saveLocalInvitations,
  getLocalCheckins,
  saveLocalCheckins,
  ensureLocalSingletons,
  normalizeMember,
  getInvitationByToken,
  getInvitationByPassToken,
  getGuestForLegacyToken,
  isMissingMigration,
};
