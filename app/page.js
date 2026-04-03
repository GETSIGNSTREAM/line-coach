'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import LineCoachDisplay from '@/src/LineCoachDisplay';
import LineCoachAdmin from '@/src/LineCoachAdmin';
import LineCoachSimulator from '@/src/LineCoachSimulator';

function LineCoachRouter() {
  const searchParams = useSearchParams();
  const isAdmin = searchParams.has('admin');
  const isSimulator = searchParams.has('simulator');
  const store = searchParams.get('store') || 'hollywood';

  if (isSimulator) {
    return <LineCoachSimulator storeId={store} />;
  }

  if (isAdmin) {
    return <LineCoachAdmin storeId={store} />;
  }

  return <LineCoachDisplay storeId={store} />;
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
