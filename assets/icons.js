/* Small filled icons for the categories, in the spirit of the reference's legend icons,
   plus a few line icons for the UI. Plain script: defines window.ICON. */
(function () {
  'use strict';
  const C = { blue: '#3b8cf5', magenta: '#ee3c9f', green: '#3fd46a', cyan: '#34d0de', purple: '#9a5cf2', yellow: '#ffcc1a', orange: '#f5873a', red: '#f04a55', grey: '#b8bac2' };
  const col = c => C[c] || c;
  const cut = '#17181b';
  const svg = (inner, size = 20, cls = 'ic') => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${inner}</svg>`;

  const cats = {
    plug: c => svg(`<path fill="${col(c)}" d="M3.4 6.6h3.1a2.2 2.2 0 1 1 3.8 0h3.1a1 1 0 0 1 1 1v2.6a2.2 2.2 0 1 1 0 3.8v2.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V7.6a1 1 0 0 1 1-1z"/><path fill="#fff" opacity=".22" d="M3.4 6.6h3.1a2.2 2.2 0 1 1 3.8 0h3.1a1 1 0 0 1 1 1V10H2.4V7.6a1 1 0 0 1 1-1z"/>`),
    image: c => svg(`<circle cx="13.9" cy="5.6" r="1.9" fill="${col(c)}" opacity=".55"/><path fill="${col(c)}" d="M1.6 15.8 6.9 8.6a1 1 0 0 1 1.6 0l3.1 4.2 1.6-2.1a1 1 0 0 1 1.6 0l3.6 5.1a.6.6 0 0 1-.5 1H2.1a.6.6 0 0 1-.5-1z"/>`),
    wrench: c => svg(`<rect x="2" y="3.5" width="16" height="13" rx="3" fill="${col(c)}"/><path d="M5.9 8.1 8.5 10l-2.6 1.9M10.4 12.4H14" fill="none" stroke="${cut}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`),
    post: c => svg(`<path fill="${col(c)}" d="M4 3.4h12a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H9.6l-3.7 2.9a.5.5 0 0 1-.8-.4v-2.5H4a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2z"/><path d="M5.6 7.6h8.8M5.6 10.6h5.6" stroke="${cut}" stroke-width="1.5" stroke-linecap="round"/>`),
    pad: c => svg(`<path fill="${col(c)}" d="M6.1 5.6h7.8a4 4 0 0 1 3.9 3.2l.9 4.4a2.2 2.2 0 0 1-3.9 1.8l-1.2-1.6H6.4l-1.2 1.6a2.2 2.2 0 0 1-3.9-1.8l.9-4.4a4 4 0 0 1 3.9-3.2z"/><path fill="${cut}" d="M5.7 8.2h1.3v1.3h1.3v1.3H7v1.3H5.7v-1.3H4.4V9.5h1.3z"/><circle cx="13.3" cy="9.2" r=".9" fill="${cut}"/><circle cx="14.9" cy="10.9" r=".9" fill="${cut}"/>`),
    flask: c => svg(`<path fill="${col(c)}" opacity=".42" d="M7.6 2.4h4.8v1.4h-.8v4l4.4 7.1a1.7 1.7 0 0 1-1.4 2.6H5.4A1.7 1.7 0 0 1 4 14.9l4.4-7.1v-4h-.8z"/><path fill="${col(c)}" d="M6.3 12h7.4l1.6 2.6c.4.6 0 1.4-.8 1.4H5.5c-.8 0-1.2-.8-.8-1.4z"/><circle cx="9" cy="10.2" r=".75" fill="${col(c)}"/><circle cx="11" cy="8.6" r=".55" fill="${col(c)}"/>`),
  };

  const ui = {
    rescan: (s = 18) => svg(`<path d="M15.6 9.2a5.8 5.8 0 0 0-10.4-3M4.4 10.8a5.8 5.8 0 0 0 10.4 3" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/><path d="M4.7 2.9v3.6h3.6M15.3 17.1v-3.6h-3.6" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`, s, 'ic ui'),
    arrow: (s = 14) => svg(`<path d="M6 14 14 6M7.5 6H14v6.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`, s, 'ic ui'),
    star: (s = 12) => svg(`<path fill="currentColor" d="m10 2.2 2.3 4.9 5.3.6-3.9 3.7 1 5.3L10 14l-4.7 2.7 1-5.3-3.9-3.7 5.3-.6z"/>`, s, 'ic ui'),
    check: (s = 18) => svg(`<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="m6.3 10.2 2.5 2.5 5-5.2" fill="none" stroke="${cut}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`, s, 'ic ui'),
    code: (s = 14) => svg(`<path d="M7 5.5 2.8 10 7 14.5M13 5.5l4.2 4.5-4.2 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`, s, 'ic ui'),
    play: (s = 14) => svg(`<path fill="currentColor" d="M6 4.3v11.4a.8.8 0 0 0 1.2.7l9-5.7a.8.8 0 0 0 0-1.4l-9-5.7a.8.8 0 0 0-1.2.7z"/>`, s, 'ic ui'),
  };

  window.ICON = { cat: (name, color, size) => (cats[name] || cats.flask)(color).replace('width="20" height="20"', `width="${size || 20}" height="${size || 20}"`), ...ui, COLORS: C };
})();
