/**
 * API admin: /api/admin/rsvps
 *
 * Devuelve la vista consolidada para el panel de administración:
 * estadísticas de invitados (Supabase) + capacidad (invitados confirmados).
 *
 * La capacidad del evento ya NO se calcula con un contador global de RSVPs
 * (que cualquiera podía inflar), sino con la SUMA de cantidad_personas de los
 * invitados confirmados — datos que solo existen en la base de datos.
 */

const { isAdminRequest } = require('../auth');
const { supabase, supabaseConfigured } = require('../supabaseClient');

const MAX_GUESTS = 100;

function emptyStats() {
  return {
    confirmados: 0,
    no_asistira: 0,
    pendientes: 0,
    enviadas: 0,
    total_invitados: 0,
    personas_invitadas: 0,
    personas_confirmadas: 0,
    max_guests: MAX_GUESTS,
    registros: [],
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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

  if (!isAdminRequest(req)) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  if (!supabaseConfigured || !supabase) {
    // Fallback local: leer guests.json y rsvp_respuestas_local.json
    const fs = require('fs');
    const path = require('path');
    const read = (f, fallback = []) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', f), 'utf8')) || fallback;
      } catch { return fallback; }
    };
    const guests = read('guests.json');
    const respuestas = read('rsvp_respuestas_local.json');
    const byGuest = new Map(respuestas.map((r) => [r.guest_id, r]));

    const stats = emptyStats();
    stats.total_invitados = guests.length;
    stats.personas_invitadas = guests.reduce((s, g) => s + (g.cantidad_personas || 1), 0);
    stats.enviadas = guests.filter((g) => g.invitacion_enviada).length;

    guests.forEach((g) => {
      const r = byGuest.get(g.id);
      const estado = r?.estado || (g.invitacion_enviada ? 'pendiente_enviada' : 'pendiente');
      if (estado === 'confirmado') {
        stats.confirmados += 1;
        stats.personas_confirmadas += g.cantidad_personas || 1;
      } else if (estado === 'no_asiste') {
        stats.no_asistira += 1;
      } else {
        stats.pendientes += 1;
      }
      stats.registros.push({
        id: g.id,
        nombre: g.nombre,
        telefono: g.telefono,
        pertenece: g.pertenece,
        categoria: g.categoria,
        cantidad_personas: g.cantidad_personas,
        estado,
        mensaje: r?.mensaje || null,
        fecha: r?.fecha_respuesta || null,
      });
    });

    res.status(200).json(stats);
    return;
  }

  // Supabase: vista consolidada
  const { data: guests, error } = await supabase
    .from('guests')
    .select('id, nombre, telefono, pertenece, categoria, cantidad_personas, invitacion_enviada, estado, estado_rsvp, fecha_rsvp, mensaje_rsvp')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('admin stats error:', error.message);
    res.status(500).json({ error: 'Error calculando estadísticas' });
    return;
  }

  const stats = emptyStats();
  stats.total_invitados = guests.length;
  stats.personas_invitadas = guests.reduce((s, g) => s + (g.cantidad_personas || 1), 0);
  stats.enviadas = guests.filter((g) => g.invitacion_enviada).length;

  (guests || []).forEach((g) => {
    if (g.estado_rsvp === 'confirmado') {
      stats.confirmados += 1;
      stats.personas_confirmadas += g.cantidad_personas || 1;
    } else if (g.estado_rsvp === 'no_asiste') {
      stats.no_asistira += 1;
    } else {
      stats.pendientes += 1;
    }
    stats.registros.push({
      id: g.id,
      nombre: g.nombre,
      telefono: g.telefono,
      pertenece: g.pertenece,
      categoria: g.categoria,
      cantidad_personas: g.cantidad_personas,
      estado: g.estado_rsvp || (g.invitacion_enviada ? 'pendiente_enviada' : 'pendiente'),
      mensaje: g.mensaje_rsvp,
      fecha: g.fecha_rsvp,
    });
  });

  res.status(200).json(stats);
};
