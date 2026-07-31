export const metadata = {
  title: 'LINE COACH — WILDBIRD Kitchen Display',
  description: 'Real-time kitchen display system for WILDBIRD restaurants',
  // iOS ignores the manifest's `icons` for the home-screen icon on many
  // versions and looks for this instead.
  appleWebApp: {
    capable: true,
    title: 'Line Coach',
    // Content runs under the status bar, which is what lets the board
    // use the full height. The header pays for it with
    // env(safe-area-inset-top) padding.
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/apple-touch-icon.png',
    icon: '/icon-192.png',
  },
};

// Next injects `width=device-width, initial-scale=1` by default; this
// overrides it to add two things that matter on a mounted tablet:
//   viewportFit: 'cover'  → makes env(safe-area-inset-*) non-zero, so
//                            the header can dodge the notch/status bar
//   maximumScale + userScalable → stops a greasy two-finger drag from
//                            pinch-zooming the board mid-service. Safari
//                            ignores this in a normal tab (accessibility)
//                            but honours it in standalone, which is how
//                            the kiosks run.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#2B2B2B',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Next's metadata API emits the modern `mobile-web-app-capable`
            and the apple status-bar/title tags, but not this legacy one.
            iPadOS 15.4+ honours the manifest's `display: standalone`
            instead, so this only matters on older tablets — which is
            exactly the hardware likely to be repurposed into a kiosk. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Open+Sans:wght@400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Global touch rules for tablet kiosks.
            `-webkit-touch-callout` is Safari-only and CANNOT be set from a
            React inline style object — React assigns it to the
            CSSStyleDeclaration, and any engine that doesn't recognise the
            property silently drops it, so it never reaches the DOM. A real
            stylesheet is the only way to ship it.

            Without this, an 800ms hold-to-bump over a food photo pops iOS's
            "Save Image / Copy" sheet instead of bumping the order. */}
        {/* Responsive rules live here rather than in inline styles for
            two reasons that inline styles genuinely cannot cover:
            @media queries, and the dvh fallback PAIR below.

            The fallback pair is not cosmetic. `dvh`/`svh` need Safari
            15.4+ / Chromium 108+, and the Raspberry Pi kiosks may run
            older Chromium. A lone `height: calc(100dvh - 56px)` is an
            invalid declaration on an engine that doesn't know the unit,
            which means NO height at all — a blank board in a live
            kitchen. Two declarations let the old engine keep the vh
            value and the new one override it. React inline styles drop
            duplicate keys, so this has to be CSS. */}
        <style>{`
          .lc-no-callout { -webkit-touch-callout: none; }

          /* Main board grid: order column + sides rail.
             The rail narrows before it disappears — it is one of the
             display's differentiating features, so it is the last thing
             to go. Below 900px (portrait tablet) it drops to its own
             row instead of stealing the order column's width. */
          .lc-main {
            display: grid;
            grid-template-columns: 1fr 320px;
            gap: 8px;
            padding: 8px;
            overflow: hidden;
            height: calc(100vh - 56px);
            height: calc(100dvh - 56px);
          }
          @media (max-width: 1200px) {
            .lc-main { grid-template-columns: 1fr 260px; }
          }
          @media (max-width: 900px) {
            .lc-main { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
          }

          /* Full-bleed surfaces (page shell, Quality Coach, focus).
             The per-instance offset rides in on a custom property so a
             single rule can carry the fallback pair:
               <div className="lc-fill" style={{ '--lc-offset': '200px' }}> */
          .lc-fill {
            min-height: calc(100vh - var(--lc-offset, 0px));
            min-height: calc(100dvh - var(--lc-offset, 0px));
          }

          /* Overlay sheets — bird log, checklists, recipes, detail.
             Same trick, in whole vh units:
               <div className="lc-sheet" style={{ '--lc-vh': 90 }}> */
          .lc-sheet {
            max-height: calc(var(--lc-vh, 88) * 1vh);
            max-height: calc(var(--lc-vh, 88) * 1dvh);
          }

          /* Height-derived SIZING (photos, type scaled off viewport
             height) uses svh, not dvh. dvh changes as Safari's URL bar
             collapses, which would make text and images resize while
             you scroll. svh is the stable small-viewport value. */
          .lc-svh {
            max-height: calc(var(--lc-vh, 46) * 1vh);
            max-height: calc(var(--lc-vh, 46) * 1svh);
          }

          /* Header dodges the status bar in standalone mode, where
             black-translucent puts content underneath it. */
          .lc-header {
            padding-top: env(safe-area-inset-top, 0px);
            padding-left: env(safe-area-inset-left, 0px);
            padding-right: env(safe-area-inset-right, 0px);
          }

          /* Header chips: let them wrap rather than overflow. Five pills
             plus logo and clock is ~840px, which is tight at 1024. */
          .lc-header-actions { flex-wrap: wrap; justify-content: flex-end; }
          @media (max-width: 1100px) {
            .lc-header-actions button {
              padding-left: 10px !important;
              padding-right: 10px !important;
              letter-spacing: 1px !important;
            }
          }

          /* Portrait: the board needs the horizontal room. Rather than
             ship a cramped portrait layout, say so. iOS ignores the
             manifest's orientation lock, so this is the honest option. */
          .lc-rotate-prompt { display: none; }
          @media (orientation: portrait) and (max-width: 1024px) {
            .lc-rotate-prompt {
              display: flex;
              position: fixed;
              inset: 0;
              z-index: 9999;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              gap: 16px;
              padding: 32px;
              text-align: center;
              background: #2B2B2B;
              color: #F5F1E8;
            }
          }
        `}</style>
      </head>
      <body style={{
        margin: 0,
        fontFamily: "'Open Sans', 'Helvetica Neue', sans-serif",
        background: '#2B2B2B',
        color: '#F5F1E8',
      }}>
        {children}
      </body>
    </html>
  );
}
