// A wrong URL used to land on the stock Next.js 404 — unstyled, and with no
// way back into the app. This keeps the person inside the product.
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ground p-6 text-center">
      <div>
        <h1 className="text-base font-semibold text-ink">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">There is nothing at this address.</p>
      </div>
      <a href="/" className="rounded bg-accent px-4 py-2 text-xs font-medium text-white">
        Back to the register
      </a>
    </main>
  );
}
