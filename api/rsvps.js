const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const filePath = path.join(process.cwd(), 'data', 'rsvps.json');
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    const payload = req.body || {};
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
    const data = Array.isArray(req.body) ? req.body : [];
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    res.status(200).json(data);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
