'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import LineCoachDisplay from '@/src/LineCoachDisplay';
import LineCoachAdmin from '@/src/LineCoachAdmin';
import LineCoachSimulator from '@/src/LineCoachSimulator';
import LineCoachHub from '@/src/LineCoachHub';

function LineCoachRouter() {
  const searchParams = useSearchParams();
  const isAdmin = searchParams.has('admin');
  const isSimulator = searchParams.has('simulator');
  const isHub = searchParams.has('hub');
  // For Display + Simulator the kitchen monitor is always pinned to a
  // specific store, so the legacy 'hollywood' default is fine. For
  // Admin the tool is brand-wide — pass the URL value if provided
  // (lets a deep link still open a specific store) but accept null so
  // the admin can show its store-picker for per-store data instead.
  const storeParam = searchParams.get('store');
  const storeOrDefault = storeParam || 'hollywood';

  if (isHub) {
    return <LineCoachHub />;
  }

  if (isSimulator) {
    return <LineCoachSimulator storeId={storeOrDefault} />;
  }

  if (isAdmin) {
    return <LineCoachAdmin storeId={storeParam || null} />;
  }

  return <LineCoachDisplay storeId={storeOrDefault} />;
}

export default function Page() {
  return (
    <Suspense fallback={
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: '#fff', fontSize: '1.5rem',
        background: '#1a1a2e',
      }}>
        Loading Line Coach...
      </div>
    }>
      <LineCoachRouter />
    </Suspense>
  );
}
