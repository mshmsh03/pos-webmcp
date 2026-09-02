'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { getCurrentProfile } from '../lib/queries';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let cancelled = false;

    async function go() {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!data?.session?.user) {
        router.replace('/login');
        return;
      }

      const profile = await getCurrentProfile();
      if (cancelled) return;

      router.replace(profile?.role === 'admin' ? '/admin' : '/pos');
    }

    // This is the entry point of the whole app. An unhandled rejection here
    // left the visitor staring at "Loading…" forever with the error only in
    // the console; /login is the one page that works without a session, so it
    // is the right place to land when we cannot tell whether there is one.
    go().catch(() => {
      if (!cancelled) router.replace('/login');
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  // supabaseClient falls back to a placeholder URL so `next build` can run
  // before the environment is configured. Without this branch that fallback
  // showed up at runtime as a stream of DNS failures behind generic error
  // strings on every page — technically accurate, useless to whoever just
  // deployed it. Say the actual thing that is wrong.
  if (!isSupabaseConfigured) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ground p-6 text-center">
        <h1 className="text-base font-semibold text-ink">This deployment isn&apos;t configured yet.</h1>
        <p className="max-w-md text-sm text-slate-500">
          Set <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your hosting
          environment, then redeploy. See the README for the full setup.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-slate-500">Loading…</p>
    </main>
  );
}
