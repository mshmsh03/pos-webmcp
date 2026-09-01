'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getAllProducts } from '../../lib/queries';
import { registerCashierTools } from '../../lib/webmcpTools';

export default function PosPage() {
  const router = useRouter();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]); // [{ product, quantity }]
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [message, setMessage] = useState('');
  const [webmcpReady, setWebmcpReady] = useState(false);

  useEffect(() => {
    load();
  }, []);

  // WebMCP: the register gets one read-only tool (find_product) — a cashier
  // mid-sale can have an agent check a price or stock level without leaving
  // this screen. No write tools here; record_sale() stays a human action.
  useEffect(() => {
    let unregister = () => {};

    (async () => {
      const { supported, unregister: cleanup } = await registerCashierTools();
      setWebmcpReady(supported);
      unregister = cleanup;
    })();

    return () => unregister();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await getAllProducts();
      setProducts(data);
    } finally {
      setLoading(false);
    }
  }

  function addToCart(product) {
    setCart((prev) => {
      const existing = prev.find((line) => line.product.id === product.id);
      if (existing) {
        return prev.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  }

  function removeFromCart(productId) {
    setCart((prev) => prev.filter((line) => line.product.id !== productId));
  }

  const total = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  async function checkout(paymentMethod) {
    if (cart.length === 0) return;
    setCheckingOut(true);
    setMessage('');

    try {
      const { error } = await supabase.rpc('record_sale', {
        cart: cart.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
        p_payment_method: paymentMethod,
      });
      if (error) throw error;

      setCart([]);
      setMessage(`Sale recorded — paid by ${paymentMethod}.`);
      await load();
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setCheckingOut(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  return (
    <main className="min-h-screen bg-ground p-4 md:p-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Cashier</h1>
          <p className="mt-1 flex items-center gap-2 text-xs">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                webmcpReady ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
            />
            <span className="text-slate-500">
              {webmcpReady ? 'Price/stock lookup tool active for agents' : 'WebMCP not available in this browser'}
            </span>
          </p>
        </div>
        <button onClick={signOut} className="text-xs text-slate-500 underline">
          Sign out
        </button>
      </header>

      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Products</h2>
          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {products.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  disabled={p.stock <= 0}
                  className="flex flex-col items-start rounded border border-line bg-white p-3 text-left transition hover:border-accent disabled:opacity-40"
                >
                  <span className="text-sm font-medium text-ink">{p.name}</span>
                  <span className="text-xs text-slate-500">
                    {p.price.toLocaleString()} · stock {p.stock}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Cart</h2>
          {cart.length === 0 ? (
            <p className="text-sm text-slate-400">Empty.</p>
          ) : (
            <ul className="mb-4 space-y-2">
              {cart.map((line) => (
                <li key={line.product.id} className="flex items-center justify-between text-sm">
                  <span>
                    {line.product.name} × {line.quantity}
                  </span>
                  <span className="flex items-center gap-2">
                    {(line.product.price * line.quantity).toLocaleString()}
                    <button
                      onClick={() => removeFromCart(line.product.id)}
                      className="text-xs text-red-500"
                      aria-label={`Remove ${line.product.name}`}
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mb-4 flex justify-between border-t border-line pt-3 text-sm font-semibold">
            <span>Total</span>
            <span>{total.toLocaleString()}</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {['cash', 'card', 'other'].map((method) => (
              <button
                key={method}
                onClick={() => checkout(method)}
                disabled={cart.length === 0 || checkingOut}
                className="rounded bg-accent py-2 text-xs font-medium capitalize text-white disabled:opacity-40"
              >
                {method}
              </button>
            ))}
          </div>

          {message && <p className="mt-3 text-xs text-slate-500">{message}</p>}
        </aside>
      </div>
    </main>
  );
}
