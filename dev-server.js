#!/usr/bin/env node
/**
 * Servidor de desarrollo local (SOLO para probar en la máquina del desarrollador).
 *
 * Imita el entorno de Vercel para las funciones serverless de /api:
 *  - req.url incluye la query (p. ej. /api/guests?action=login)
 *  - req.body llega ya parseado cuando el Content-Type es JSON
 *  - res.status(...).json(...) disponibles como en Vercel/Node
 *
 * Uso:  node dev-server.js   (carga .env.local si existe)
 * NO usar en producción: no tiene TLS, rate-limit por proceso ni caché de CDN.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Cargar .env.local (mismo archivo que usa `vercel dev`)
try {
  require('dotenv').config({ path: path.join(__dirname, '.env.local') });
} catch (_) {
  // dotenv es devDependency; si no está, seguir con las vars de entorno actuales
}

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_FILES = new Set([
  'index.html', 'invitados.html', 'admin.html', 'invitaciones.html', 'recepcion.html',
  'admin-shell.css', 'admin-shell.js', 'invitation-share.js', 'foto-pareja-social.png',
  'favicon.svg', 'foto-pareja.jpg', 'musica-boda.mp3', 'vendor/zxing-browser.min.js',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Length': isBuffer ? body.length : Buffer.byteLength(String(body)),
    ...(headers || {}),
  });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ctype = String(req.headers['content-type'] || '');
      if (!raw.length) return resolve(undefined);
      if (ctype.includes('application/json') || (!ctype && raw[0] === 0x7b /* { */)) {
        try { return resolve(JSON.parse(raw.toString('utf8'))); } catch { return resolve(raw); }
      }
      resolve(raw);
    });
    req.on('error', () => resolve(undefined));
  });
}

function handlerPath(route) {
  // /api/guest?x=1 → api/guest.js ; /api/admin/rsvps → api/admin/rsvps.js
  const clean = route.split('?')[0].replace(/\/+$/, '');
  if (!clean.startsWith('/api/')) return null;
  const rel = clean.slice('/api/'.length);
  if (!rel || rel.includes('..')) return null;
  const file = path.join(ROOT, 'api', rel + '.js');
  if (!fs.existsSync(file)) return null;
  return file;
}

async function handleApi(req, res, route) {
  const file = handlerPath(route);
  if (!file) {
    json(res, 404, { error: 'Endpoint no encontrado' });
    return;
  }
  try {
    delete require.cache[require.resolve(file)]; // recarga en caliente durante el dev
    const handler = require(file);
    // Helpers que el runtime de Vercel inyecta y un ServerResponse crudo no tiene
    if (!res.status) {
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (data) => json(res, res.statusCode || 200, data);
    }
    req.body = await readBody(req);
    await handler(req, res);
    if (!res.writableEnded) json(res, 500, { error: 'El handler no respondió' });
  } catch (err) {
    console.error('[api]', route, err);
    if (!res.writableEnded) json(res, 500, { error: 'Error interno del servidor' });
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  // cleanUrls: /index → /index.html ; "/" → index.html
  let rel;
  try { rel = decodeURIComponent(pathname); }
  catch { send(res, 400, 'Solicitud inválida', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!path.extname(rel)) rel += '.html';

  const publicName = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(publicName)) {
    send(res, 404, '404 — Página no encontrada', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  const file = path.join(ROOT, publicName);

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, '404 — Página no encontrada', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    const isAdminShellAsset = /^(admin-shell\.(css|js)|invitation-share\.js)$/i.test(publicName);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // HTML and shared admin-shell files revalidate; other static assets are immutable.
      'Cache-Control': isHtml || isAdminShellAsset
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    fs.readFile(file, (e2, data) => {
      if (e2) { json(res, 500, { error: 'Error leyendo archivo' }); return; }
      send(res, 200, data, headers);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(req, res, req.url);
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  const pass = process.env.ADMIN_PASSWORD ? 'configurada ✔' : '⚠ NO configurada (login admin deshabilitado)';
  const hasServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const sb = process.env.SUPABASE_URL && hasServiceKey ? 'configurado' : 'no configurado → fallback data/*.json';
  console.log('──────────────────────────────────────────────────');
  console.log('  Invitación de boda — servidor de desarrollo');
  console.log(`  http://localhost:${PORT}`);
  console.log('──────────────────────────────────────────────────');
  console.log(`  ADMIN_PASSWORD : ${pass}`);
  console.log(`  Supabase       : ${sb}`);
  console.log('  Ctrl+C para detener');
  console.log('──────────────────────────────────────────────────');
});
