'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getSalesSummary, getLowStockAlerts, getRecentSales, getRecentToolCalls } from '../../lib/queries';
import { registerAdminTools } from '../../lib/webmcpTools';
import { useRoleGuard } from '../../lib/useRoleGuard';

export default function AdminDashboard() {
  const router = useRouter();
  const { status: guard } = useRoleGuard('admin');
  const [summary, setSummary] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [recentSales, setRecentSales] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [webmcpReady, setWebmcpReady] = useState(false);
  const [lastToolCall, setLastToolCall] = useState(null);
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async () => {
    const [s, low, recent, calls] = await Promise.all([
      getSalesSummary('today'),
      getLowStockAlerts(),
      getRecentSales(8),
      getRecentToolCalls(8).catch(() => []), // admin-only table; swallow if role hasn't propagated yet
    ]);
    setSummary(s);
    setLowStock(low);
    setRecentSales(recent);
    setActivity(calls);
  }, []);

  useEffect(() => {
    if (guard !== 'allowed') return;
    (async () => {
      setLoading(true);
      try {
        await refresh();
        setLoadError('');
      } catch (err) {
        // Without this, the throw skipped setLoading(false) and the page sat on
        // "Loading…" forever — no error, no way back, on any single failed query.
        setLoadError(err?.message || 'Could not load the dashboard.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, guard]);

  // --- WebMCP: register this page's tools once, unregister on unmount. ---
  useEffect(() => {
    // Not just "don't show the data" — don't offer the tools at all until we
    // know this session belongs to an admin. See lib/useRoleGuard.js.
    if (guard !== 'allowed') return undefined;
    let unregister = () => {};

    (async () => {
      const { supported, unregister: cleanup } = await registerAdminTools((name, input, result) => {
        setLastToolCall({ name, input, result, at: new Date() });
        // Whatever the agent just looked at or changed, refresh the human's
        // view of it too — this is the "visible tool calls" principle from
        // the WebMCP spec in practice.
        refresh().catch(() => {});
      });
      setWebmcpReady(supported);
      unregister = cleanup;
    })();

    return () => unregister();
  }, [refresh, guard]);

  async function signOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  if (guard !== 'allowed' || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ground">
        <p className="text-sm text-slate-400">Loading…</p>
      </main>
    );
  }

  if (loadError || !summary) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ground p-6">
        <p className="text-sm text-slate-600">{loadError || 'Could not load the dashboard.'}</p>
        <button
          onClick={() => {
            setLoading(true);
            refresh()
              .then(() => setLoadError(''))
              .catch((err) => setLoadError(err?.message || 'Could not load the dashboard.'))
              .finally(() => setLoading(false));
          }}
          className="rounded bg-accent px-4 py-2 text-xs font-medium text-white"
        >
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ground p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Admin Dashboard</h1>
          <p className="mt-1 flex items-center gap-2 text-xs">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                webmcpReady ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
            />
            <span className="text-slate-500">
              {webmcpReady
                ? 'WebMCP tools active — an agent can read and act on this page'
                : "WebMCP not available in this browser — the dashboard still works normally"}
            </span>
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/admin/products" className="text-accent underline">
            Products
          </Link>
          <Link href="/admin/reports" className="text-accent underline">
            Reports
          </Link>
          <Link href="/pos" className="text-accent underline">
            Cashier view
          </Link>
          <button onClick={signOut} className="text-slate-500 underline">
            Sign out
          </button>
        </nav>
      </header>

      {lastToolCall && (
        <div className="mb-4 rounded-md border border-accent/30 bg-accent/5 px-4 py-2 text-xs text-accent">
          🤖 Agent called <code className="font-mono">{lastToolCall.name}</code>
          {lastToolCall.input && Object.keys(lastToolCall.input).length > 0 && (
            <> with {JSON.stringify(lastToolCall.input)}</>
          )}{' '}
          at {lastToolCall.at.toLocaleTimeString()}
        </div>
      )}

      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Revenue today" value={summary.revenue.toLocaleString()} />
        <Stat label="Cash" value={summary.cash.toLocaleString()} />
        <Stat label="Card" value={summary.card.toLocaleString()} />
        {/* Without this tile a sale taken as "other" left Cash + Card visibly
            short of Revenue, with nothing on screen explaining the gap. */}
        <Stat label="Other" value={summary.other.toLocaleString()} />
        <Stat label="Transactions" value={summary.transactionCount} />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Low stock</h2>
          {lowStock.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing is low right now.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {lowStock.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="text-amber-600">
                    {p.stock} left (threshold {p.low_stock_threshold})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Recent sales</h2>
          {recentSales.length === 0 ? (
            <p className="text-sm text-slate-400">No sales yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {recentSales.map((s) => (
                <li key={s.id} className="flex justify-between">
                  <span className="capitalize text-slate-500">{s.payment_method}</span>
                  <span>{Number(s.total).toLocaleString()}</span>
                  <span className="text-xs text-slate-400">
                    {new Date(s.created_at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-600">Recent agent activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-slate-400">
            No tool calls yet — every WebMCP call an agent makes, read or write, shows up here.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {activity.map((call) => (
              <li key={call.id} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      call.success ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
                  <code className="font-mono text-xs text-ink">{call.tool_name}</code>
                  {call.input && Object.keys(call.input).length > 0 && (
                    <span className="text-xs text-slate-400">{JSON.stringify(call.input)}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {new Date(call.created_at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
