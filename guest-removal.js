(function (root) {
  'use strict';
  const eventKey = 'wedding-guests-changed';
  function confirmation(guest) {
    return `¿Eliminar a "${guest.nombre}" de la lista de invitados? `
      + 'Dejará de contar en el cupo y se quitará de su grupo, aunque haya confirmado. '
      + 'Su respuesta y cualquier entrada registrada se conservarán en el historial. '
      + 'Si quedan integrantes, se conservarán sus respuestas y se renovarán el enlace y el QR: deberás compartir el nuevo enlace con ellos.';
  }
  function resultMessage(result) {
    if (result.already_archived) return 'Esta persona ya estaba eliminada de la lista.';
    return result.link_changed
      ? 'Persona eliminada y grupo actualizado. Comparte el nuevo enlace con los integrantes restantes.'
      : 'Persona eliminada. Su invitación quedó desactivada y el historial se conservó.';
  }
  function announce() {
    try { root.localStorage.setItem(eventKey, `${Date.now()}-${Math.random()}`); } catch (_) {}
  }
  const removal = { confirmation, resultMessage, announce, eventKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = removal;
  else root.GuestRemoval = removal;
})(typeof window !== 'undefined' ? window : globalThis);
