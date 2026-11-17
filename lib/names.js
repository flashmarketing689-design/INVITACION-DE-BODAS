/**
 * Nombres de personas: primera letra de cada nombre y apellido en mayúscula y el resto en
 * minúscula ("MARÍA pérez" → "María Pérez", "ana-maría" → "Ana-María", "o'neil" → "O'Neil").
 * Las partículas de apellidos compuestos van en minúscula, como en español ("María de los
 * Ángeles", "Juan Pérez del Rosario"), salvo si abren el nombre.
 *
 * La misma regla vive en la base de datos (public.title_case_name, migración 016) y en el
 * navegador (admin-common.js); hay pruebas que comprueban que las tres coinciden.
 */

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);

function titleCaseName(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.split(' ').map((word, index) => {
    const lower = word.toLocaleLowerCase('es');
    if (index > 0 && PARTICLES.has(lower)) return lower;
    return lower.replace(/(^|[-'’.])(\p{L})/gu, (_, separator, letter) => separator + letter.toLocaleUpperCase('es'));
  }).join(' ');
}

/** Un nombre por línea (por ejemplo, la lista de personas nuevas de una invitación). */
function titleCaseLines(value) {
  return String(value ?? '').split(/\r?\n/).map(titleCaseName).join('\n');
}

module.exports = { PARTICLES, titleCaseName, titleCaseLines };
