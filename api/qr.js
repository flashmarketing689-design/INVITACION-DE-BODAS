const QRCode = require('qrcode');
const { isSameOriginRequest } = require('../lib/auth');
const { supabase, supabaseConfigured } = require('../lib/supabaseClient');
const { allowRequest, clientIp } = require('../lib/rateLimit');
const { getInvitationByToken, isMissingMigration } = require('../lib/invitations');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isSameOriginRequest(req)) { res.status(403).json({ error: 'Origen no permitido' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (process.env.NODE_ENV === 'production' && (!supabaseConfigured || !supabase)) {
    res.status(503).json({ error: 'Servicio no disponible' }); return;
  }
  if (!allowRequest(`qr:${clientIp(req)}`, 30, 60 * 1000)) {
    res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' }); return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = (url.searchParams.get('token') || '').trim().toLowerCase();
  try {
    const invitation = await getInvitationByToken(token);
    if (!invitation || invitation.legacy_review_required || !invitation.members.some((member) => member.estado_rsvp === 'confirmado')) {
      res.status(404).json({ error: 'El pase QR aún no está disponible.' });
      return;
    }
    const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) { res.status(400).json({ error: 'No se pudo generar el enlace del pase.' }); return; }
    const ticketUrl = new URL('/recepcion.html', `${protocol}://${host}`);
    ticketUrl.searchParams.set('ticket', invitation.pass_token);
    const image = await QRCode.toBuffer(ticketUrl.toString(), {
      type: 'png', width: 440, margin: 4,
      errorCorrectionLevel: 'Q',
      color: { dark: '#17351b', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', image.length);
    res.status(200).end(image);
  } catch (error) {
    console.error('QR generation failed:', error.message);
    if (isMissingMigration(error)) {
      res.status(503).json({ error: 'Falta ejecutar la migración 004 de invitaciones en Supabase.' });
      return;
    }
    res.status(500).json({ error: 'No se pudo generar el pase QR.' });
  }
};
