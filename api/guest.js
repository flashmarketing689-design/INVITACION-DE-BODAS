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

const { getGuestByToken, isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');

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

  let guest;
  try {
    guest = await getGuestByToken(token);
  } catch (error) {
    console.error('Guest lookup failed:', error.message);
    res.status(500).json({ error: 'No se pudo verificar la invitación' });
    return;
  }

  if (!guest) {
    res.status(200).json({ found: false });
    return;
  }

  res.status(200).json({
    found: true,
    guest: {
      nombre: guest.nombre,
      cantidad_personas: guest.cantidad_personas,
      estado_rsvp: guest.estado_rsvp || null,
      fecha_rsvp: guest.fecha_rsvp || null,
    },
  });
};
