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
const RECEPTION_COOKIE = 'boda_recepcion';

function getAdminPassword() {
  // Acepta ADMIN_PASSWORD y ADMIN_PASS_KEY (ambos nombres por compatibilidad)
  return (process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS_KEY || '').trim();
}

function getSessionSecret() {
  const configured = process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (configured && configured.length >= 32) return configured;
  // A predictable secret is acceptable only for local development and tests.
  if (process.env.NODE_ENV !== 'production') return 'dev-only-fallback-secret';
  return null;
}

function sign(value) {
  const secret = getSessionSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function createSessionToken() {
  const payload = `admin.${Date.now()}`;
  const signature = sign(payload);
  return signature ? `${payload}.${signature}` : null;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  if (!expected) return false;
  // Comparación en tiempo constante
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  // Sesión válida 12 horas
  const issuedAt = parseInt(parts[1], 10);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  return age >= 0 && age < 12 * 60 * 60 * 1000;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const name = pair.slice(0, idx).trim();
      try { out[name] = decodeURIComponent(pair.slice(idx + 1).trim()); }
      catch { out[name] = ''; }
    }
  });
  return out;
}

function isAdminRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[ADMIN_COOKIE]);
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https' || Boolean(req.socket?.encrypted);
}

function getReceptionPassword() {
  return (process.env.RECEPTION_PASS_KEY || '').trim();
}

function safeDecodeBase64Url(value) {
  try { return Buffer.from(value, 'base64url').toString('utf8'); }
  catch { return ''; }
}

function createReceptionSession(operator) {
  const issuedAt = Date.now();
  const encodedName = Buffer.from(String(operator).trim()).toString('base64url');
  const payload = `reception.${issuedAt}.${encodedName}`;
  const signature = sign(payload);
  return signature ? `${payload}.${signature}` : null;
}

function getReceptionOperator(req) {
  const token = parseCookies(req)[RECEPTION_COOKIE];
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'reception') return null;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = sign(payload);
  if (!expected) return null;
  const actualBuffer = Buffer.from(parts[3]);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const issuedAt = Number(parts[1]);
  if (!Number.isSafeInteger(issuedAt) || Date.now() - issuedAt < 0 || Date.now() - issuedAt >= 12 * 60 * 60 * 1000) return null;
  const operator = safeDecodeBase64Url(parts[2]).trim();
  return operator.length >= 2 && operator.length <= 60 ? operator : null;
}

function isReceptionRequest(req) {
  return Boolean(getReceptionOperator(req));
}

function setReceptionCookie(req, res, operator) {
  const token = createReceptionSession(operator);
  if (!token) return false;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${RECEPTION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${12 * 60 * 60}${secure}`);
  return true;
}

function clearReceptionCookie(req, res) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${RECEPTION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function setAdminCookie(req, res) {
  const token = createSessionToken();
  if (!token) return false;
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}${secure}`
  );
  return true;
}

function clearAdminCookie(req, res) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/** Browser API calls are same-origin only; admin endpoints never need CORS. */
function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
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
      .is('archived_at', null)
      .maybeSingle();
    if (error) {
      console.error('getGuestByToken error:', error.message);
      const lookupError = new Error('Guest lookup failed');
      lookupError.code = 'GUEST_LOOKUP_FAILED';
      throw lookupError;
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
    return guests.find((g) => !g.archived_at && g.token && g.token.toLowerCase() === token) || null;
  } catch {
    return null;
  }
}

module.exports = {
  ADMIN_COOKIE,
  RECEPTION_COOKIE,
  isAdminRequest,
  setAdminCookie,
  clearAdminCookie,
  checkAdminPassword,
  isSameOriginRequest,
  getGuestByToken,
  isValidTokenFormat,
  getReceptionPassword,
  getReceptionOperator,
  isReceptionRequest,
  setReceptionCookie,
  clearReceptionCookie,
  safeEqual,
};
