'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getReportsData, logExpense } from '../../../lib/queries';
import { useRoleGuard } from '../../../lib/useRoleGuard';

export default function ReportsPage() {
  const { status: guard } = useRoleGuard('admin');
  const [period, setPeriod] = useState('today');
  const [data, setData] = useState(null);
  const [expense, setExpense] = useState({ description: '', amount: '', category: 'general' });
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (guard !== 'allowed') return;
    load(period);
  }, [period, guard]);

  async function load(p) {
    setData(await getReportsData(p));
  }

  async function addExpense(e) {
    e.preventDefault();
    try {
      await logExpense(expense.description, Number(expense.amount), expense.category);
      setExpense({ description: '', amount: '', category: 'general' });
      setMessage('Expense logged.');
      load(period);
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
  }

  if (guard !== 'allowed') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ground">
        <p className="text-sm text-slate-400">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ground p-4 md:p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Reports</h1>
        <Link href="/admin" className="text-sm text-accent underline">
          ← Dashboard
        </Link>
      </header>

      <div className="mb-4 flex gap-2">
        {['today', '7d', '30d'].map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              period === p ? 'bg-accent text-white' : 'border border-line bg-surface text-slate-600'
            }`}
          >
            {p === 'today' ? 'Today' : p === '7d' ? '7 days' : '30 days'}
          </button>
        ))}
      </div>

      {data && (
        <section className="mb-4 grid grid-cols-3 gap-3">
          <Stat label="Revenue" value={data.revenue.toLocaleString()} />
          <Stat label="Expenses" value={data.expenses.toLocaleString()} />
          <Stat label="Net" value={data.net.toLocaleString()} highlight={data.net < 0} />
        </section>
      )}

      <form onSubmit={addExpense} className="rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-600">Log an expense</h2>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="Description"
            value={expense.description}
            onChange={(e) => setExpense({ ...expense, description: e.target.value })}
            className="flex-1 rounded border border-line px-3 py-2 text-sm"
            required
          />
          <input
            placeholder="Amount"
            type="number"
            value={expense.amount}
            onChange={(e) => setExpense({ ...expense, amount: e.target.value })}
            className="w-32 rounded border border-line px-3 py-2 text-sm"
            required
          />
          <input
            placeholder="Category"
            value={expense.category}
            onChange={(e) => setExpense({ ...expense, category: e.target.value })}
            className="w-32 rounded border border-line px-3 py-2 text-sm"
          />
          <button className="rounded bg-accent px-4 py-2 text-sm text-white">Add</button>
        </div>
        {message && <p className="mt-2 text-xs text-slate-500">{message}</p>}
      </form>
    </main>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${highlight ? 'text-red-600' : 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}
