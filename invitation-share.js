(function (root) {
  'use strict';

  function invitationUrl(token, origin) {
    const url = new URL('/', origin);
    url.searchParams.set('guest', token);
    // A new share URL lets previews refresh without rotating anyone's invitation.
    url.searchParams.set('v', '2');
    return url.href;
  }

  function message(link) {
    return [
      'Hola 👋',
      '',
      'Nos gustaría confirmar tu asistencia a nuestra boda. 💍',
      '',
      'Por favor, ingresa al siguiente enlace y completa tu confirmación.',
      '',
      'Una vez confirmes tu asistencia, el sistema generará un código QR personal que deberás presentar como entrada el día del evento.',
      '',
      'Haz clic aquí para confirmar 👇',
      link,
    ].join('\n');
  }

  function whatsappUrl(link, phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return `https://wa.me/${digits}?text=${encodeURIComponent(message(link))}`;
  }

  const sharing = { invitationUrl, message, whatsappUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = sharing;
  else root.InvitationShare = sharing;
})(typeof window !== 'undefined' ? window : globalThis);
