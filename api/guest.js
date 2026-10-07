/**
 * API pública: /api/guest?token=UUID
 *
 * Devuelve SOLO los datos necesarios para personalizar la invitación:
 * nombre para mostrar, cantidad autorizada y estado del RSVP.
 *
 * Seguridad:
 * - No distingue "token inválido" de "invitado inexistente" (respuesta única).
 * - Nunca expone id interno, teléfono, notas ni administrativa.
 * - Rate limit básico por IP; el token es un bearer secreto aleatorio.
 */

const { isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');
const { getInvitationByToken, isMissingMigration } = require('../lib/invitations');

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

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Servicio no disponible' });
    return;
  }

  if (!allowRequest(`guest-lookup:${clientIp(req)}`, 30, 60 * 1000)) {
    // Mismo shape que "no encontrado": no revela nada
    res.status(200).json({ found: false });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = (url.searchParams.get('token') || '').trim().toLowerCase();

  let invitation;
  try {
    invitation = await getInvitationByToken(token);
  } catch (error) {
    console.error('Guest lookup failed:', error.message);
    if (isMissingMigration(error)) {
      res.status(503).json({ error: 'El sistema de invitaciones agrupadas necesita la migración 004 en Supabase.' });
      return;
    }
    res.status(500).json({ error: 'No se pudo verificar la invitación' });
    return;
  }

  if (!invitation) {
    res.status(200).json({ found: false });
    return;
  }

  const members = invitation.members || [];
  const legacyMember = members[0] || {};
  const legacyAggregate = Boolean(invitation.legacy_review_required);
  const confirmed = members.filter((member) => member.estado_rsvp === 'confirmado').length;
  const declined = members.filter((member) => member.estado_rsvp === 'no_asiste').length;

  res.status(200).json({
    found: true,
    guest: {
      nombre: invitation.display_name,
      tipo: invitation.group_type,
      cantidad_personas: legacyAggregate ? (legacyMember.cantidad_personas || 1) : members.length,
      estado_rsvp: members.length === 1 ? legacyMember.estado_rsvp : null,
      fecha_rsvp: members.length === 1 ? legacyMember.fecha_rsvp : null,
      legacy_review_required: legacyAggregate,
      members: members.map((member) => ({
        member_id: member.member_id,
        nombre: member.nombre,
        estado_rsvp: member.estado_rsvp || null,
        fecha_rsvp: member.fecha_rsvp || null,
      })),
      resumen: {
        confirmados: confirmed,
        no_asisten: declined,
        pendientes: Math.max(0, members.length - confirmed - declined),
      },
    },
  });
};
