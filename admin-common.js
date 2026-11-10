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

  const common = { csvCell, csvRow, escapeHtml, withBusy, uuid };
  if (typeof module !== 'undefined' && module.exports) module.exports = common;
  else root.AdminCommon = common;
})(typeof window !== 'undefined' ? window : globalThis);
