'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAllProducts, updateProductStock } from '../../../lib/queries';
import { supabase } from '../../../lib/supabaseClient';

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newProduct, setNewProduct] = useState({ name: '', price: '', stock: '' });

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setProducts(await getAllProducts());
    setLoading(false);
  }

  async function saveStock(id, stock) {
    await updateProductStock(id, Number(stock));
    load();
  }

  async function addProduct(e) {
    e.preventDefault();
    await supabase.from('products').insert({
      name: newProduct.name,
      price: Number(newProduct.price),
      stock: Number(newProduct.stock) || 0,
    });
    setNewProduct({ name: '', price: '', stock: '' });
    load();
  }

  return (
    <main className="min-h-screen bg-ground p-4 md:p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Products</h1>
        <Link href="/admin" className="text-sm text-accent underline">
          ← Dashboard
        </Link>
      </header>

      <form onSubmit={addProduct} className="mb-4 flex flex-wrap gap-2 rounded-lg border border-line bg-surface p-4">
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
          value={newProduct.price}
          onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })}
          className="w-28 rounded border border-line px-3 py-2 text-sm"
          required
        />
        <input
          placeholder="Stock"
          type="number"
          value={newProduct.stock}
          onChange={(e) => setNewProduct({ ...newProduct, stock: e.target.value })}
          className="w-28 rounded border border-line px-3 py-2 text-sm"
        />
        <button className="rounded bg-accent px-4 py-2 text-sm text-white">Add</button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-ground text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Stock</th>
              <th className="px-4 py-2">Threshold</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-3 text-slate-400" colSpan={4}>
                  Loading…
                </td>
              </tr>
            ) : (
              products.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2">{Number(p.price).toLocaleString()}</td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      defaultValue={p.stock}
                      onBlur={(e) => saveStock(p.id, e.target.value)}
                      className="w-20 rounded border border-line px-2 py-1"
                    />
                  </td>
                  <td className="px-4 py-2 text-slate-500">{p.low_stock_threshold}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
