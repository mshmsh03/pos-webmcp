'use client';

// Next.js renders this instead of a blank page when a client component throws
// during render. Without it, any uncaught error in production is a white
// screen with no way back — which, for a register someone is standing at in a
// shop, is worse than the error itself.
export default function Error({ error, reset }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ground p-6 text-center">
      <div>
        <h1 className="text-base font-semibold text-ink">Something went wrong.</h1>
        <p className="mt-2 max-w-md text-sm text-slate-500">
          {error?.message || 'An unexpected error stopped this page from loading.'}
        </p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded bg-accent px-4 py-2 text-xs font-medium text-white"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded border border-line px-4 py-2 text-xs font-medium text-slate-600"
        >
          Back to the register
        </a>
      </div>
    </main>
  );
}
