export const metadata = {
  title: 'LINE COACH — WILDBIRD Kitchen Display',
  description: 'Real-time kitchen display system for WILDBIRD restaurants',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
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
        <style>{`
          .lc-no-callout { -webkit-touch-callout: none; }
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
