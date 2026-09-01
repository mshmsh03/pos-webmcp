'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getAllProducts } from '../../lib/queries';
import { createCartApi } from '../../lib/cart';
import { registerCashierTools } from '../../lib/webmcpTools';

export default function PosPage() {
  const router = useRouter();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]); // [{ product, quantity }]
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [message, setMessage] = useState('');
  const [webmcpReady, setWebmcpReady] = useState(false);
  const [agentAction, setAgentAction] = useState(null);

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
    load();
  }, []);

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
    let unregister = () => {};

    (async () => {
      const { supported, unregister: cleanup } = await registerCashierTools(
        (name, input) => setAgentAction({ name, input, at: new Date() }),
        cartApi
      );
      setWebmcpReady(supported);
      unregister = cleanup;
    })();

    return () => unregister();
  }, [cartApi]);

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
      const next = existing
        ? prev.map((line) =>
            line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line
          )
        : [...prev, { product, quantity: 1 }];
      cartRef.current = next;
      return next;
    });
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
              {webmcpReady
                ? 'Agent tools active — an agent can build this cart, only you can take payment'
                : 'WebMCP not available in this browser'}
            </span>
          </p>
        </div>
        <button onClick={signOut} className="text-xs text-slate-500 underline">
          Sign out
        </button>
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
