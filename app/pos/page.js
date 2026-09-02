'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getAllProducts } from '../../lib/queries';
import { createCartApi } from '../../lib/cart';
import { registerCashierTools } from '../../lib/webmcpTools';
import { useRoleGuard } from '../../lib/useRoleGuard';

export default function PosPage() {
  const router = useRouter();
  const { status: guard, role } = useRoleGuard('any');
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]); // [{ product, quantity }]
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [message, setMessage] = useState('');
  const [webmcpReady, setWebmcpReady] = useState(false);
  const [agentAction, setAgentAction] = useState(null);
  const [loadError, setLoadError] = useState('');

  // The WebMCP tools are registered once, on mount, but they need to read and
  // write cart/product state that changes constantly. Closing over `cart`
  // directly would freeze it at whatever it was on mount, so the tools go
  // through refs instead — and every mutation writes the ref *before* calling
  // setCart, so an agent firing several add_to_cart calls in a row doesn't
  // read stale state between React renders.
  const productsRef = useRef([]);
  const cartRef = useRef([]);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);

  useEffect(() => {
    if (guard !== 'allowed') return;
    load().catch(() => {});
  }, [guard]);

  // --------------------------------------------------------------------------
  // The cart API handed to the WebMCP layer.
  //
  // This is the part an ordinary MCP server physically cannot do: the cart is
  // browser state. It has never been near the database and won't be until a
  // human presses Cash/Card/Other. An agent can assemble an order the cashier
  // watches appear on screen, and can be wrong about it harmlessly, because
  // nothing it touches here is persistent.
  //
  // There is deliberately no checkout function exposed. Taking money stays a
  // human action.
  // --------------------------------------------------------------------------
  const cartApi = useMemo(
    () =>
      createCartApi({
        getProducts: () => productsRef.current,
        getCart: () => cartRef.current,
        setCart: (next) => {
          // Write the ref first: an agent firing several add_to_cart calls in a
          // row must not read stale state between React renders.
          cartRef.current = next;
          setCart(next);
        },
      }),
    []
  );

  // WebMCP: the register exposes a read-only catalog lookup plus the cart
  // tools above. Registration is feature-detected — with no WebMCP in the
  // browser this is a no-op and the register behaves exactly as it always did.
  useEffect(() => {
    if (guard !== 'allowed') return undefined;
    let cancelled = false;
    let unregister = () => {};

    (async () => {
      try {
        const { supported, unregister: cleanup } = await registerCashierTools(
          (name, input) => setAgentAction({ name, input, at: new Date() }),
          cartApi
        );
        // If the effect already tore down while we were awaiting, the returned
        // cleanup would otherwise be dropped on the floor and the tools would
        // stay registered on document.modelContext after unmount. React strict
        // mode double-mounts, so this window is hit on every dev mount.
        if (cancelled) {
          cleanup();
          return;
        }
        setWebmcpReady(supported);
        unregister = cleanup;
      } catch (err) {
        console.error('WebMCP registration failed:', err?.message || err);
      }
    })();

    return () => {
      cancelled = true;
      unregister();
    };
  }, [cartApi, guard]);

  async function load() {
    setLoading(true);
    try {
      const data = await getAllProducts();
      setProducts(data);
      setLoadError('');
    } catch (err) {
      setLoadError(err?.message || 'Could not load the product catalogue.');
      throw err;
    } finally {
      setLoading(false);
    }
  }

  // The human path deliberately goes through the same cart rules the agent
  // uses. It previously only checked stock > 0, so a cashier could stack five
  // of a stock-two item and only find out at the till — the agent was better
  // behaved than the person, and the tested rules were bypassed entirely.
  function addToCart(product) {
    try {
      cartApi.addProduct(product, 1);
      setMessage('');
    } catch (err) {
      setMessage(err.message);
    }
  }

  function removeFromCart(productId) {
    setCart((prev) => {
      const next = prev.filter((line) => line.product.id !== productId);
      cartRef.current = next;
      return next;
    });
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

      cartRef.current = [];
      setCart([]);
      setAgentAction(null);
      setMessage(`Sale recorded — paid by ${paymentMethod}.`);
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setCheckingOut(false);
    }

    // Deliberately outside the try. The sale is already committed by this
    // point, so letting a failed catalog refresh overwrite the success message
    // with "Error: …" would tell the cashier the sale failed when it didn't —
    // and the natural response to that is to ring it up a second time.
    try {
      await load();
    } catch {
      /* stock figures are stale until the next refresh; the sale still stands */
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
              {webmcpReady
                ? 'Agent tools active — an agent can build this cart, only you can take payment'
                : 'WebMCP not available in this browser'}
            </span>
          </p>
        </div>
        <nav className="flex items-center gap-4 text-xs">
          {/* Only admins get this: a cashier following it would just be
              bounced back by the route guard, so offering it would be a dead
              end rather than navigation. */}
          {role === 'admin' && (
            <Link href="/admin" className="text-accent underline">
              ← Dashboard
            </Link>
          )}
          <button onClick={signOut} className="text-slate-500 underline">
            Sign out
          </button>
        </nav>
      </header>

      {agentAction && (
        <div className="mb-4 flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>
            Agent called <span className="font-medium">{agentAction.name}</span>
            {agentAction.input && Object.keys(agentAction.input).length > 0 && (
              <span className="text-emerald-700"> {JSON.stringify(agentAction.input)}</span>
            )}
          </span>
          <span className="ml-auto text-emerald-600">
            {agentAction.at.toLocaleTimeString()}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-600">Products</h2>
          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : loadError ? (
            // An empty grid used to be shown for both "no products" and "the
            // query failed", which tells a cashier the shop has no stock when
            // in fact the request errored.
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-slate-600">{loadError}</p>
              <button
                onClick={() => load().catch(() => {})}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white"
              >
                Try again
              </button>
            </div>
          ) : products.length === 0 ? (
            <p className="text-sm text-slate-400">No products in the catalogue yet.</p>
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

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            Payment is a human action. No agent tool can record a sale.
          </p>

          {message && <p className="mt-3 text-xs text-slate-500">{message}</p>}
        </aside>
      </div>
    </main>
  );
}
