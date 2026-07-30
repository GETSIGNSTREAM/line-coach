// PWA manifest. Next's App Router picks this up automatically and
// serves it at /manifest.webmanifest with the <link> injected — no
// manual tag in layout.js.
//
// ⚠️  DO NOT ADD `start_url`.
//
// iOS resolves start_url when launching from the home screen. Setting
// it to '/' would strip `?store=&dt=` from every install, silently
// turning each paired iPad into an unpaired display that defaults to
// the `hollywood` store (see app/page.js). Omitting it means the spec
// default applies — the document URL the user installed from — which
// keeps the store and the pairing token.
//
// Belt and braces: LineCoachDisplay also persists `dt` and the resolved
// store to localStorage on first load, so even if a future iOS build
// drops the query string anyway, the screen stays paired.

export default function manifest() {
  return {
    name: 'LINE COACH — WILDBIRD Kitchen Display',
    short_name: 'Line Coach',
    description: 'Real-time kitchen display system for WILDBIRD restaurants',
    display: 'standalone',
    background_color: '#2B2B2B',
    theme_color: '#2B2B2B',
    // `orientation` is deliberately omitted: iOS ignores it entirely, so
    // declaring landscape here would read as a guarantee we can't keep.
    // Portrait is handled honestly with a rotate prompt instead.
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
