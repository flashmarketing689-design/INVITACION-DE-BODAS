/**
 * Parentescos editables de los familiares (madre, padre, hermano(a)… y los que se añadan).
 * Lógica pura, sin red ni disco, para poder probarla. El lado (novia / novio) no se guarda
 * aquí: sale de la lista a la que pertenece el invitado ("Madre de la novia").
 */

const MAX_KINSHIPS = 30;

const DEFAULT_KINSHIPS = [
  { key: 'madre', name: 'Madre', sort_order: 1 },
  { key: 'padre', name: 'Padre', sort_order: 2 },
  { key: 'hermano', name: 'Hermano(a)', sort_order: 3 },
];

class KinshipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KinshipError';
    this.code = code;
  }
}

const KEY_PATTERN = /^[a-z0-9_]{1,30}$/;
const isValidKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) throw new KinshipError('INVALID', 'El nombre del parentesco debe tener entre 1 y 40 caracteres.');
  return name;
}

/** Clave estable a partir del nombre: "Abuelo(a)" → "abuelo_a". */
function slugify(name) {
  const slug = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 26);
  return slug || 'parentesco';
}

function uniqueKey(name, taken) {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  throw new KinshipError('INVALID', 'No se pudo crear el parentesco.');
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function createKinship(list, name) {
  const clean = cleanName(name);
  if (list.length >= MAX_KINSHIPS) throw new KinshipError('INVALID', `Se pueden tener hasta ${MAX_KINSHIPS} parentescos.`);
  if (list.some((item) => sameName(item.name, clean))) throw new KinshipError('DUPLICATE', 'Ya existe un parentesco con ese nombre.');
  const key = uniqueKey(clean, new Set(list.map((item) => item.key)));
  return { next: [...list, { key, name: clean, sort_order: list.reduce((max, item) => Math.max(max, item.sort_order), 0) + 1 }], key };
}

function renameKinship(list, key, name) {
  const clean = cleanName(name);
  if (!list.some((item) => item.key === key)) throw new KinshipError('NOT_FOUND', 'El parentesco no existe.');
  if (list.some((item) => item.key !== key && sameName(item.name, clean))) throw new KinshipError('DUPLICATE', 'Ya existe un parentesco con ese nombre.');
  return list.map((item) => (item.key === key ? { ...item, name: clean } : item));
}

function deleteKinship(list, key) {
  if (!list.some((item) => item.key === key)) throw new KinshipError('NOT_FOUND', 'El parentesco no existe.');
  return list.filter((item) => item.key !== key);
}

const sorted = (list) => [...list].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));

module.exports = { MAX_KINSHIPS, DEFAULT_KINSHIPS, KinshipError, isValidKey, slugify, createKinship, renameKinship, deleteKinship, sorted };
