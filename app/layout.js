export const metadata = {
  title: 'Line Coach — WILDBIRD Kitchen Display',
  description: 'Real-time kitchen display system for WILDBIRD restaurants',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#1a1a2e' }}>
        {children}
      </body>
    </html>
  );
}
