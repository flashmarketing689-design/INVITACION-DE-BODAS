const path = require('path');

/**
 * Carpeta del almacenamiento local (modo sin Supabase: desarrollo y pruebas).
 * Por defecto es ./data; WEDDING_DATA_DIR permite apuntar a otra, y las pruebas la
 * usan para que cada archivo de prueba tenga la suya y puedan correr en paralelo.
 */
const DATA_DIR = process.env.WEDDING_DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = { DATA_DIR };
