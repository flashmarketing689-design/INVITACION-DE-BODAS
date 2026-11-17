(function (root) {
  'use strict';

  /**
   * Celda CSV segura. Un valor que empiece por = + - @ (o tab / retorno de
   * carro) lo interpretan Excel y Sheets como fórmula; los mensajes RSVP los
   * escribe cualquier invitado, así que se neutraliza con un apóstrofo.
   * Siempre se entrecomilla, así las comas y saltos de línea no desalinean columnas.
   */
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csvRow(values) {
    return values.map(csvCell).join(',');
  }

  /** Escapa también la comilla simple, para que sea segura dentro de atributos. */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Deshabilita un control mientras dura la acción, para evitar dobles clics. */
  async function withBusy(control, action) {
    if (!control) return action();
    if (control.disabled || control.dataset.busy === '1') return undefined;
    control.dataset.busy = '1';
    control.disabled = true;
    try { return await action(); }
    finally { delete control.dataset.busy; control.disabled = false; }
  }

  /** UUID v4 con alternativa para navegadores sin crypto.randomUUID (iOS < 15.4). */
  function uuid() {
    const c = root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  /**
   * Nombres de personas: primera letra de cada nombre y apellido en mayúscula ("MARÍA pérez" →
   * "María Pérez"); partículas como "de", "del", "la" o "y" en minúscula salvo al inicio.
   * La misma regla que lib/names.js y la base de datos (hay pruebas que comparan las tres).
   */
  const PARTICLES = ['de', 'del', 'la', 'las', 'los', 'y', 'e'];
  function titleCaseName(value) {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.split(' ').map((word, index) => {
      const lower = word.toLocaleLowerCase('es');
      if (index > 0 && PARTICLES.indexOf(lower) !== -1) return lower;
      return lower.replace(/(^|[-'’.])(\p{L})/gu, (_, separator, letter) => separator + letter.toLocaleUpperCase('es'));
    }).join(' ');
  }
  function titleCaseLines(value) {
    return String(value === null || value === undefined ? '' : value).split(/\r?\n/).map(titleCaseName).join('\n');
  }

  // Los campos marcados con data-name (un nombre) o data-names (uno por línea) se corrigen al
  // salir del campo y justo antes de enviar el formulario.
  function formatNameField(field) {
    if (!field || !field.matches) return;
    if (field.matches('[data-names]')) field.value = titleCaseLines(field.value);
    else if (field.matches('[data-name]')) field.value = titleCaseName(field.value);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('focusout', (event) => formatNameField(event.target), true);
    document.addEventListener('submit', (event) => {
      if (event.target && event.target.querySelectorAll) event.target.querySelectorAll('[data-name], [data-names]').forEach(formatNameField);
    }, true);
  }

  const common = { csvCell, csvRow, escapeHtml, withBusy, uuid, titleCaseName, titleCaseLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = common;
  else root.AdminCommon = common;
})(typeof window !== 'undefined' ? window : globalThis);
