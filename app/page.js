'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../lib/supabaseClient';
import { getCurrentProfile } from '../lib/queries';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    async function go() {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;

      if (!data?.user) {
        router.replace('/login');
        return;
      }

      const profile = await getCurrentProfile();
      if (cancelled) return;

      router.replace(profile?.role === 'admin' ? '/admin' : '/pos');
    }

    go();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-slate-500">Loading…</p>
    </main>
  );
}
