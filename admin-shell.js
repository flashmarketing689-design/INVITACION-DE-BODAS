(() => {
  'use strict';

  const modules = [
    {
      key: 'admin', label: 'Resumen RSVP', href: 'admin.html', icon: 'dashboard',
      sections: [
        ['stats-grid', 'Resumen de respuestas'],
        ['capacidad-evento', 'Capacidad de la boda'],
        ['filtros-rsvp', 'Filtros y búsqueda'],
        ['respuestas', 'Lista de respuestas'],
      ],
    },
    {
      key: 'invitados', label: 'Invitados', href: 'invitados.html', icon: 'people',
      sections: [
        ['stats-row', 'Resumen de invitados'],
        ['invitados-filtros', 'Buscar y filtrar'],
        ['listas-invitados', 'Listas del novio y la novia'],
      ],
    },
    {
      key: 'invitaciones', label: 'Invitaciones', href: 'invitaciones.html', icon: 'invitation',
      sections: [
        ['summary', 'Resumen de grupos'],
        ['crear-invitacion', 'Crear una invitación'],
        ['grupos-invitacion', 'Enlaces y pases QR'],
      ],
    },
    {
      key: 'recepcion', label: 'Recepción y QR', href: 'recepcion.html', icon: 'qr',
      sections: [
        ['qr-scan', 'Escanear o consultar pase'],
        ['busqueda-nombre', 'Buscar por nombre'],
      ],
    },
  ];

  const icons = {
    dashboard: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/>',
    people: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7" r="3.5"/><path d="M17 11a3.5 3.5 0 0 0 0-7M21 20v-1.5a4 4 0 0 0-3-3.87"/>',
    invitation: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6M8 10l-4 4m12-4 4 4"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zm4 0h3m-7 4v3h3m1-3h3v3h-3"/>',
  };
  const menuIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const chevron = '<svg class="admin-nav-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  const file = (location.pathname.split('/').pop() || 'admin.html').replace(/\.html$/, '');
  const active = modules.find((item) => item.key === file) || modules[0];
  const moduleLinks = modules.map((item) => {
    const current = item.key === active.key;
    const subnav = current
      ? `<div class="admin-nav-submenu">${item.sections.map(([id, label]) => `<a href="${item.href}#${id}">${label}</a>`).join('')}</div>`
      : '';
    return `<div class="admin-nav-item"><a class="admin-nav-link" href="${item.href}"${current ? ' aria-current="page"' : ''}><svg class="admin-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[item.icon]}</svg><span>${item.label}</span>${current ? chevron : ''}</a>${subnav}</div>`;
  }).join('');

  const sidebar = document.createElement('aside');
  sidebar.className = 'admin-sidebar';
  sidebar.id = 'admin-sidebar';
  sidebar.setAttribute('aria-label', 'Navegación principal');
  sidebar.innerHTML = `
    <div class="admin-sidebar-brand-row">
      <a class="admin-sidebar-brand" href="admin.html" aria-label="Ir al resumen RSVP">
        <span class="admin-brand-mark" aria-hidden="true">S<span>&amp;</span>R</span>
        <span class="admin-brand-copy"><strong>Panel de boda</strong><small>Starlin &amp; Reneisy</small></span>
      </a>
      <button class="admin-sidebar-close" type="button" aria-label="Cerrar menú">${closeIcon}</button>
    </div>
    <div class="admin-event-card"><strong>Gestión de la boda</strong><span>21 de noviembre de 2026</span></div>
    <div class="admin-sidebar-scroll">
      <p class="admin-nav-label">Módulos</p>
      <nav aria-label="Módulos de administración">${moduleLinks}</nav>
    </div>
    <div class="admin-sidebar-footer"><span class="admin-sidebar-status" aria-hidden="true"></span><span>Acceso privado · ${active.label}</span></div>`;

  const overlay = document.createElement('div');
  overlay.className = 'admin-shell-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.add('admin-shell-enabled');
  document.body.dataset.adminPage = active.key;
  document.body.prepend(overlay, sidebar);

  const header = document.querySelector('body > header.topbar, body > header.top');
  if (header) {
    const toggle = document.createElement('button');
    toggle.className = 'admin-shell-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Abrir menú de administración');
    toggle.setAttribute('aria-controls', sidebar.id);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = menuIcon;
    header.prepend(toggle);

    const mobile = window.matchMedia('(max-width: 1119px)');
    const close = () => {
      const wasOpen = document.body.classList.contains('admin-shell-open');
      document.body.classList.remove('admin-shell-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Abrir menú de administración');
      sidebar.inert = mobile.matches;
      if (wasOpen && mobile.matches) toggle.focus();
    };
    const setOpen = (open) => {
      if (!open) return close();
      sidebar.inert = false;
      document.body.classList.toggle('admin-shell-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Cerrar menú de administración' : 'Abrir menú de administración');
      sidebar.querySelector('.admin-sidebar-close').focus();
    };

    mobile.addEventListener('change', close);
    close();

    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('admin-shell-open')));
    sidebar.querySelector('.admin-sidebar-close').addEventListener('click', close);
    overlay.addEventListener('click', close);
    sidebar.querySelectorAll('a').forEach((link) => link.addEventListener('click', close));
    document.addEventListener('keydown', (event) => {
      if (!document.body.classList.contains('admin-shell-open')) return;
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const focusable = [...sidebar.querySelectorAll('a, button')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }
})();
