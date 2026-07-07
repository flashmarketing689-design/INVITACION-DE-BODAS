const fs = require('fs');
const path = require('path');
const { supabase, supabaseConfigured } = require('./supabaseClient');

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

function getDataFilePath() {
  return path.join(__dirname, '..', 'data', 'rsvps.json');
}

function readStore() {
  const filePath = getDataFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '[]', 'utf8');
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Error reading RSVP store:', error.message);
    return [];
  }
}

function writeStore(rows) {
  const filePath = getDataFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    if (supabaseConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('rsvps')
          .select('*')
          .order('fecha', { ascending: false });

        if (!error) {
          const rows = Array.isArray(data) ? data : [];
          writeStore(rows);
          res.status(200).json(sortRows(rows));
          return;
        }

        console.error('Supabase read error:', error.message);
      } catch (error) {
        console.error('Supabase read failed:', error.message);
      }
    }

    res.status(200).json(sortRows(readStore()));
    return;
  }

  if (req.method === 'POST') {
    const payload = parseBody(req.body);
    const entry = {
      id: payload.id || Date.now(),
      nombre: payload.nombre || '',
      telefono: payload.telefono || '',
      asistencia: payload.asistencia || 'no',
      mensaje: payload.mensaje || '',
      fecha: payload.fecha || new Date().toISOString(),
    };

    if (supabaseConfigured && supabase) {
      try {
        const { data, error } = await supabase
          .from('rsvps')
          .insert(entry)
          .select()
          .single();

        if (!error && data) {
          const rows = sortRows([...readStore(), data]);
          writeStore(rows);
          res.status(200).json(data);
          return;
        }

        console.error('Supabase insert error:', error?.message || 'unknown');
      } catch (error) {
        console.error('Supabase insert failed:', error.message);
      }
    }

    const rows = sortRows([...readStore(), entry]);
    writeStore(rows);
    res.status(200).json(entry);
    return;
  }

  if (req.method === 'PUT') {
    const incoming = Array.isArray(parseBody(req.body)) ? parseBody(req.body) : [];

    if (supabaseConfigured && supabase) {
      try {
        const deleteResult = await supabase
          .from('rsvps')
          .delete()
          .not('id', 'is', null);

        if (!deleteResult.error) {
          if (incoming.length === 0) {
            writeStore([]);
            res.status(200).json([]);
            return;
          }

          const { data: inserted, error } = await supabase
            .from('rsvps')
            .insert(incoming)
            .select();

          if (!error && inserted) {
            writeStore(inserted);
            res.status(200).json(inserted || []);
            return;
          }

          console.error('Supabase replace error:', error?.message || 'unknown');
        } else {
          console.error('Supabase delete error:', deleteResult.error.message);
        }
      } catch (error) {
        console.error('Supabase replace failed:', error.message);
      }
    }

    writeStore(incoming);
    res.status(200).json(incoming);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
