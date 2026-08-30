'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getCurrentProfile } from '../../lib/queries';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('sign-in'); // 'sign-in' | 'sign-up'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);

    try {
      if (mode === 'sign-up') {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (signUpError) throw signUpError;
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
      }

      const profile = await getCurrentProfile();
      router.replace(profile?.role === 'admin' ? '/admin' : '/pos');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-ink">POS System</h1>
        <p className="mb-6 text-sm text-slate-500">
          {mode === 'sign-in' ? 'Sign in to continue.' : 'Create the first account.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'sign-up' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Full name</label>
              <input
                className="w-full rounded border border-line px-3 py-2 text-sm outline-none focus:border-accent"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Email</label>
            <input
              type="email"
              className="w-full rounded border border-line px-3 py-2 text-sm outline-none focus:border-accent"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Password</label>
            <input
              type="password"
              className="w-full rounded border border-line px-3 py-2 text-sm outline-none focus:border-accent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-accent py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          className="mt-4 text-xs text-slate-500 underline"
          onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
        >
          {mode === 'sign-in' ? 'First time here? Create an account' : 'Already have an account? Sign in'}
        </button>

        <p className="mt-6 text-xs text-slate-400">
          New accounts default to the cashier role. To make yourself an admin, open Table Editor →
          profiles in Supabase and change your row&rsquo;s role to &ldquo;admin&rdquo;.
        </p>
      </div>
    </main>
  );
}
