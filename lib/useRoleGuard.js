'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from './supabaseClient';
import { getCurrentProfile } from './queries';

// ----------------------------------------------------------------------------
// Route guard, and — the part that matters for WebMCP — a gate on tool
// registration.
//
// Row Level Security already stops a cashier reading the shop's takings: the
// queries behind /admin would come back empty for them. But "the call fails"
// is a weaker guarantee than "the tool was never offered." An agent that can
// see log_expense and get_sales_summary in its tool list will try them, and
// the failure it gets back tells it something about a page it should not have
// been on in the first place.
//
// So pages wait for this hook to confirm the role before registering anything.
// The tool surface an agent is shown is scoped to the person whose session it
// is borrowing — a cashier's agent is offered cashier tools because it is, in
// every sense, the cashier.
//
// `require` is 'admin' or 'any' (any signed-in user). Returns:
//   status: 'checking' | 'allowed'   — 'checking' while redirecting away too
//   role:   the profile's role once known
// ----------------------------------------------------------------------------
export function useRoleGuard(require = 'any') {
  const router = useRouter();
  const [status, setStatus] = useState('checking');
  const [role, setRole] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // getSession(), not getUser(). getUser() revalidates against the auth
      // server on every call, so on a cold page load it can answer "no user"
      // before the client has finished hydrating the stored session — which
      // would bounce a perfectly good admin to /login. getSession() reads the
      // stored session and waits for that hydration.
      //
      // It doesn't re-verify the JWT with the server, but it isn't being asked
      // to: this guard decides what to render and which tools to offer. The
      // actual authorization boundary is Row Level Security in Postgres, which
      // verifies every request regardless of what this hook concluded.
      let sessionData = null;
      try {
        ({ data: sessionData } = await supabase.auth.getSession());
      } catch {
        // If the auth call itself fails there's no safe way to tell an admin
        // from a stranger, so send them to sign in rather than leaving every
        // page stuck on "Loading…" with no recovery.
        if (!cancelled) router.replace('/login');
        return;
      }
      if (cancelled) return;

      if (!sessionData?.session?.user) {
        router.replace('/login');
        return;
      }

      let profile = null;
      try {
        profile = await getCurrentProfile();
      } catch {
        // Profile row not readable/created yet — treat as the lowest privilege
        // rather than assuming anything.
        profile = null;
      }
      if (cancelled) return;

      const actual = profile?.role ?? 'cashier';
      setRole(actual);

      if (require === 'admin' && actual !== 'admin') {
        router.replace('/pos');
        return;
      }

      setStatus('allowed');
    })();

    return () => {
      cancelled = true;
    };
  }, [router, require]);

  return { status, role };
}
