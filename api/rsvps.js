const fs = require('fs');
const path = require('path');

function getFilePath() {
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return path.join('/tmp', 'rsvps.json');
  }
  return path.join(process.cwd(), 'data', 'rsvps.json');
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  if (Buffer.isBuffer(body)) {
    try { return JSON.parse(body.toString('utf8')); } catch { return {}; }
  }
  return body;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]');
  }

  if (req.method === 'GET') {
    const content = fs.readFileSync(filePath, 'utf8');
    res.status(200).json(JSON.parse(content));
    return;
  }

  if (req.method === 'POST') {
    const payload = parseBody(req.body);
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entry = {
      id: payload.id || Date.now(),
      nombre: payload.nombre || '',
      telefono: payload.telefono || '',
      asistencia: payload.asistencia || 'no',
      mensaje: payload.mensaje || '',
      fecha: payload.fecha || new Date().toISOString()
    };
    current.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
    res.status(200).json(entry);
    return;
  }

  if (req.method === 'PUT') {
    const data = Array.isArray(parseBody(req.body)) ? parseBody(req.body) : [];
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    res.status(200).json(data);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
