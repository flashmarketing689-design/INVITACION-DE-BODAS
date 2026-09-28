/**
 * API pública: /api/guest?token=UUID
 *
 * Devuelve SOLO los datos necesarios para personalizar la invitación:
 * nombre para mostrar, cantidad autorizada y estado del RSVP.
 *
 * Seguridad:
 * - No distingue "token inválido" de "invitado inexistente" (respuesta única).
 * - Nunca expone id interno, teléfono, notas ni administrativa.
 * - Rate limit básico en memoria por IP (evita enumeración masiva).
 */

const { getGuestByToken } = require('./auth');

const WINDOW_MS = 60 * 1000;
const MAX_REQ_PER_WINDOW = 30;
const buckets = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const entry = buckets.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_REQ_PER_WINDOW;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (!rateLimit(ip)) {
    // Mismo shape que "no encontrado": no revela nada
    res.status(200).json({ found: false });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = (url.searchParams.get('token') || '').trim().toLowerCase();

  const guest = await getGuestByToken(token);

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
