'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getSalesSummary, getLowStockAlerts, getRecentSales } from '../../lib/queries';
import { registerPosTools, isWebMCPSupported } from '../../lib/webmcpTools';

export default function AdminDashboard() {
  const router = useRouter();
  const [summary, setSummary] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [recentSales, setRecentSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [webmcpReady, setWebmcpReady] = useState(false);
  const [lastToolCall, setLastToolCall] = useState(null);

  const refresh = useCallback(async () => {
    const [s, low, recent] = await Promise.all([
      getSalesSummary('today'),
      getLowStockAlerts(),
      getRecentSales(8),
    ]);
    setSummary(s);
    setLowStock(low);
    setRecentSales(recent);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  // --- WebMCP: register this page's tools once, unregister on unmount. ---
  useEffect(() => {
    let unregister = () => {};

    (async () => {
      const { supported, unregister: cleanup } = await registerPosTools((name, input, result) => {
        setLastToolCall({ name, input, result, at: new Date() });
        // Whatever the agent just looked at or changed, refresh the human's
        // view of it too — this is the "visible tool calls" principle from
        // the WebMCP spec in practice.
        refresh();
      });
      setWebmcpReady(supported);
      unregister = cleanup;
    })();

    return () => unregister();
  }, [refresh]);

  async function signOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ground">
        <p className="text-sm text-slate-400">Loading…</p>
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

      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Revenue today" value={summary.revenue.toLocaleString()} />
        <Stat label="Cash" value={summary.cash.toLocaleString()} />
        <Stat label="Card" value={summary.card.toLocaleString()} />
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
