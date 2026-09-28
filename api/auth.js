/**
 * Módulo compartido de autenticación y utilidades para las API.
 *
 * - Login admin: contraseña en variable de entorno (NUNCA hardcodeada).
 * - Sesión: cookie HttpOnly firmada con HMAC (no manipulable en el cliente).
 * - Invitados: resolución por token UUID (no adivinable, 122 bits de entropía).
 */

const crypto = require('crypto');
const { supabase, supabaseConfigured } = require('./supabaseClient');

const ADMIN_COOKIE = 'boda_admin';

function getAdminPassword() {
  // Acepta ADMIN_PASSWORD y ADMIN_PASS_KEY (ambos nombres por compatibilidad)
  return (process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS_KEY || '').trim();
}

function sign(value) {
  const secret =
    process.env.ADMIN_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_KEY ||
    'dev-only-fallback-secret';
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function createSessionToken() {
  const payload = `admin.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  // Comparación en tiempo constante
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  // Sesión válida 12 horas
  const issuedAt = parseInt(parts[1], 10);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < 12 * 60 * 60 * 1000;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function isAdminRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[ADMIN_COOKIE]);
}

function setAdminCookie(res) {
  const token = createSessionToken();
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`
  );
}

function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Constant-time string comparison (para comparar contraseñas). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Hash de ambos para igualar longitudes sin filtrar largo
    const h1 = crypto.createHash('sha256').update(ab).digest();
    const h2 = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(h1, h2);
  }
  return crypto.timingSafeEqual(ab, bb);
}

function checkAdminPassword(password) {
  const expected = getAdminPassword();
  if (!expected) return false; // sin contraseña configurada => no hay acceso
  return safeEqual(password, expected);
}

/**
 * Resuelve un invitado por token. Devuelve null si no existe.
 * El token es UUID: si el parámetro no tiene formato UUID, se rechaza sin consultar.
 */
function isValidTokenFormat(token) {
  return typeof token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

async function getGuestByToken(token) {
  if (!isValidTokenFormat(token)) return null;

  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('guests')
      .select('id, nombre, telefono, cantidad_personas, estado, estado_rsvp, invitacion_enviada')
      .eq('token', token)
      .maybeSingle();
    if (error) {
      console.error('getGuestByToken error:', error.message);
      return null;
    }
    return data || null;
  }

  // Fallback local (desarrollo/test sin Supabase): data/guests.json
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', 'data', 'guests.json');
    if (!fs.existsSync(file)) return null;
    const guests = JSON.parse(fs.readFileSync(file, 'utf8'));
    return guests.find((g) => g.token && g.token.toLowerCase() === token) || null;
  } catch {
    return null;
  }
}

module.exports = {
  ADMIN_COOKIE,
  isAdminRequest,
  setAdminCookie,
  clearAdminCookie,
  checkAdminPassword,
  getGuestByToken,
  isValidTokenFormat,
};
