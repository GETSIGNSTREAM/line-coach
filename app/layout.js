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
