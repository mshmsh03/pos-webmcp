'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getAllProducts, updateProduct, logToolCall } from '../../../lib/queries';
import { supabase } from '../../../lib/supabaseClient';

// Shared by the human typing in the filter box and by an agent calling the
// declarative tool below — one implementation, not two.
function applyFilter(products, { name, lowStockOnly }) {
  const q = (name || '').trim().toLowerCase();
  return products.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (lowStockOnly && p.stock > p.low_stock_threshold) return false;
    return true;
  });
}

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newProduct, setNewProduct] = useState({ name: '', price: '', stock: '' });
  const [filter, setFilter] = useState({ name: '', lowStockOnly: false });
  const [savedId, setSavedId] = useState(null);
  const [error, setError] = useState('');
  const [agentAction, setAgentAction] = useState(null);

  // The declarative tool's submit handler runs outside React's render cycle
  // when an agent fires it, so it reads products through a ref.
  const productsRef = useRef([]);
  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      setProducts(await getAllProducts());
    } finally {
      setLoading(false);
    }
  }

  async function saveField(id, field, value) {
    setError('');
    try {
      await updateProduct(id, { [field]: value });
      setSavedId(`${id}:${field}`);
      setTimeout(() => setSavedId(null), 1200);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function addProduct(e) {
    e.preventDefault();
    setError('');
    try {
      const { error: insertError } = await supabase.from('products').insert({
        name: newProduct.name.trim(),
        price: Number(newProduct.price),
        stock: Number(newProduct.stock) || 0,
      });
      if (insertError) throw insertError;
      setNewProduct({ name: '', price: '', stock: '' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  // --------------------------------------------------------------------------
  // WebMCP, declarative API.
  //
  // The form below is a WebMCP tool purely by virtue of its HTML attributes —
  // toolname / tooldescription / toolparamdescription. There is no
  // registerTool() call for it and no second implementation: the search box a
  // human types into IS the tool an agent calls, and both run the same
  // applyFilter() above.
  //
  // When an agent submits it, the browser sets SubmitEvent#agentInvoked and
  // gives us respondWith() to hand back a result without navigating. React
  // wraps the native event, so both live on e.nativeEvent.
  //
  // Note what this tool does: it changes what the shop owner is *looking at*.
  // It reads no more than find_product does, and writes nothing at all — but
  // the effect lands on their screen, which is the whole reason for putting a
  // tool in a page instead of behind an API.
  // --------------------------------------------------------------------------
  function handleFilterSubmit(e) {
    e.preventDefault();
    const native = e.nativeEvent || e;

    const data = new FormData(e.target);
    const name = String(data.get('name') || '').trim();
    const lowStockOnly = String(data.get('low_stock_only') || 'no') === 'yes';

    setFilter({ name, lowStockOnly });

    if (!native.agentInvoked) return;

    const matched = applyFilter(productsRef.current, { name, lowStockOnly });
    const result = {
      shown: matched.length,
      out_of: productsRef.current.length,
      filter: { name: name || '(any)', low_stock_only: lowStockOnly },
      products: matched.map((p) => ({
        name: p.name,
        price: p.price,
        stock: p.stock,
        low_stock_threshold: p.low_stock_threshold,
      })),
      status: "The product table on the shop owner's screen now shows exactly these rows.",
    };

    setAgentAction({ name: 'filter_product_list', at: new Date() });
    logToolCall('filter_product_list', { name, low_stock_only: lowStockOnly }, result, true);

    if (typeof native.respondWith === 'function') {
      native.respondWith(Promise.resolve(JSON.stringify(result)));
    }
  }

  const visible = useMemo(() => applyFilter(products, filter), [products, filter]);
  const filtering = filter.name || filter.lowStockOnly;

  return (
    <main className="min-h-screen bg-ground p-4 md:p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Products</h1>
        <Link href="/admin" className="text-sm text-accent underline">
          ← Dashboard
        </Link>
      </header>

      {agentAction && (
        <div className="mb-4 flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span>
            Agent called <span className="font-medium">{agentAction.name}</span> — this table is
            filtered by an agent, not by you
          </span>
          <span className="ml-auto text-emerald-600">{agentAction.at.toLocaleTimeString()}</span>
        </div>
      )}

      <form
        onSubmit={handleFilterSubmit}
        toolname="filter_product_list"
        tooldescription="Filter the product table the shop owner is currently looking at, by name and/or to just the items that need restocking. This changes what is displayed on their screen. It only reads product data — it never changes a product, a price, or a stock level."
        toolautosubmit=""
        className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <label className="text-xs text-slate-500" htmlFor="filter-name">
          Search
        </label>
        <input
          id="filter-name"
          name="name"
          defaultValue={filter.name}
          placeholder="Product name…"
          toolparamdescription="Part of a product name to match, case-insensitive. Leave empty to match every product."
          className="flex-1 rounded border border-line px-3 py-2 text-sm"
        />
        <select
          name="low_stock_only"
          defaultValue={filter.lowStockOnly ? 'yes' : 'no'}
          toolparamdescription="Use 'yes' to narrow the table to only products at or below their restock threshold."
          className="rounded border border-line px-3 py-2 text-sm"
        >
          <option value="no">All products</option>
          <option value="yes">Only low stock</option>
        </select>
        <button className="rounded border border-line px-4 py-2 text-sm text-slate-600">
          Filter
        </button>
        {filtering && (
          <button
            type="button"
            onClick={() => {
              setFilter({ name: '', lowStockOnly: false });
              setAgentAction(null);
            }}
            className="text-xs text-slate-500 underline"
          >
            Clear
          </button>
        )}
      </form>

      <form
        onSubmit={addProduct}
        className="mb-4 flex flex-wrap gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <input
          placeholder="Name"
          value={newProduct.name}
          onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
          className="flex-1 rounded border border-line px-3 py-2 text-sm"
          required
        />
        <input
          placeholder="Price"
          type="number"
          min="0"
          step="any"
          value={newProduct.price}
          onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
          className="w-28 rounded border border-line px-3 py-2 text-sm"
          required
        />
        <input
          placeholder="Stock"
          type="number"
          min="0"
          value={newProduct.stock}
          onChange={(e) => setNewProduct({ ...newProduct, stock: e.target.value })}
          className="w-28 rounded border border-line px-3 py-2 text-sm"
        />
        <button className="rounded bg-accent px-4 py-2 text-sm text-white">Add</button>
      </form>

      {error && (
        <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-ground text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Stock</th>
              <th className="px-4 py-2">Restock at</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-3 text-slate-400" colSpan={4}>
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td className="px-4 py-3 text-slate-400" colSpan={4}>
                  {products.length === 0
                    ? 'No products yet — add one above.'
                    : 'No products match this filter.'}
                </td>
              </tr>
            ) : (
              visible.map((p) => {
                const low = p.stock <= p.low_stock_threshold;
                return (
                  <tr key={p.id} className="border-t border-line">
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        {p.name}
                        {low && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                            low
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <EditableNumber
                        value={p.price}
                        saved={savedId === `${p.id}:price`}
                        onSave={(v) => saveField(p.id, 'price', v)}
                        step="any"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <EditableNumber
                        value={p.stock}
                        saved={savedId === `${p.id}:stock`}
                        onSave={(v) => saveField(p.id, 'stock', v)}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <EditableNumber
                        value={p.low_stock_threshold}
                        saved={savedId === `${p.id}:low_stock_threshold`}
                        onSave={(v) => saveField(p.id, 'low_stock_threshold', v)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        {filtering ? `Showing ${visible.length} of ${products.length} products. ` : ''}
        Edit a price, stock count or restock threshold by typing in it — it saves when you click
        away.
      </p>
    </main>
  );
}

function EditableNumber({ value, onSave, saved, step }) {
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="number"
        min="0"
        step={step || '1'}
        defaultValue={value}
        key={value}
        onBlur={(e) => {
          if (Number(e.target.value) !== Number(value)) onSave(e.target.value);
        }}
        className="w-24 rounded border border-line px-2 py-1"
      />
      {saved && <span className="text-[10px] text-emerald-600">saved</span>}
    </span>
  );
}
