'use client';

import { supabase } from './supabaseClient';

// Single source of truth for every number the dashboard shows AND every
// number a WebMCP tool returns to an agent — the human and the agent are
// always looking at the same data through the same code path.

function periodStart(period) {
  const now = new Date();
  const start = new Date(now);
  if (period === 'today') {
    start.setHours(0, 0, 0, 0); // the viewer's local day, not a UTC day
  } else if (period === '7d') {
    start.setDate(start.getDate() - 7);
  } else if (period === '30d') {
    start.setDate(start.getDate() - 30);
  } else {
    throw new Error(`unknown period: ${period}`);
  }
  return start.toISOString();
}

export async function getSalesSummary(period = 'today') {
  const since = periodStart(period);
  const { data, error } = await supabase
    .from('sales')
    .select('total, payment_method, created_at')
    .gte('created_at', since);

  if (error) throw error;

  const summary = {
    period,
    since,
    transactionCount: data.length,
    revenue: 0,
    cash: 0,
    card: 0,
    other: 0,
  };

  for (const sale of data) {
    summary.revenue += Number(sale.total);
    summary[sale.payment_method] += Number(sale.total);
  }

  return summary;
}

export async function getLowStockAlerts() {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, stock, low_stock_threshold')
    .order('stock', { ascending: true });

  if (error) throw error;
  return data.filter((p) => p.stock <= p.low_stock_threshold);
}

export async function findProduct(query) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, price, stock, low_stock_threshold')
    .ilike('name', `%${query}%`)
    .limit(20);

  if (error) throw error;
  return data;
}

export async function logExpense(description, amount, category = 'general') {
  const { data: sessionData } = await supabase.auth.getSession();

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      description,
      amount,
      category,
      created_by: sessionData?.session?.user?.id ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getRecentSales(limit = 10) {
  const { data, error } = await supabase
    .from('sales')
    .select('id, total, payment_method, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function getReportsData(period = 'today') {
  const since = periodStart(period);

  const [{ data: sales, error: salesErr }, { data: expenses, error: expErr }] = await Promise.all([
    supabase.from('sales').select('total').gte('created_at', since),
    supabase.from('expenses').select('amount').gte('created_at', since),
  ]);

  if (salesErr) throw salesErr;
  if (expErr) throw expErr;

  const revenue = sales.reduce((sum, s) => sum + Number(s.total), 0);
  const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

  return { period, revenue, expenses: expenseTotal, net: revenue - expenseTotal };
}

export async function getAllProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, price, stock, low_stock_threshold, category_id, categories(name)')
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

export async function updateProductStock(productId, stock) {
  return updateProduct(productId, { stock });
}

// A shop has to be able to reprice things and retune its restock thresholds,
// not just correct a stock count. Only the fields actually passed are written,
// and each is validated here rather than trusting the caller — this runs on
// the client, so the RLS policy on `products` (admins only) is the real guard;
// this is just to keep obviously-bad values out of the table.
export async function updateProduct(productId, fields) {
  const patch = {};

  if (fields.name !== undefined) {
    const name = String(fields.name).trim();
    if (!name) throw new Error('Product name cannot be empty.');
    patch.name = name;
  }

  for (const key of ['price', 'stock', 'low_stock_threshold']) {
    if (fields[key] === undefined) continue;
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key.replace(/_/g, ' ')} must be a number of 0 or more.`);
    }
    patch[key] = key === 'price' ? value : Math.floor(value);
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from('products').update(patch).eq('id', productId);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// tool_calls audit log — every WebMCP tool invocation is written here (see
// lib/webmcpTools.js), success or failure, read-only or write. Only admins
// can read it back (RLS), which is what backs the "recent agent activity"
// panel on the dashboard.
// ----------------------------------------------------------------------------

export async function logToolCall(toolName, input, result, success = true) {
  // Same getSession()-not-getUser() reasoning as getCurrentProfile, and it
  // matters more here: the tool_calls RLS policy requires called_by to equal
  // auth.uid(), so a null user id doesn't just lose the name — the insert is
  // rejected outright and the call vanishes from the audit trail.
  const { data: sessionData } = await supabase.auth.getSession();
  const { error } = await supabase.from('tool_calls').insert({
    tool_name: toolName,
    input: input ?? {},
    result: result ?? null,
    success,
    called_by: sessionData?.session?.user?.id ?? null,
  });
  // A logging failure should never take down the tool call it's logging —
  // surface it in the console and move on.
  if (error) console.error('failed to log tool call:', error.message);
}

export async function getRecentToolCalls(limit = 8) {
  const { data, error } = await supabase
    .from('tool_calls')
    .select('id, tool_name, input, result, success, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function getCurrentProfile() {
  // getSession() rather than getUser(): getUser() revalidates against the auth
  // server on every call and can answer "no user" on a cold page load, before
  // the client has hydrated the stored session. Every caller of this function
  // routes on the answer, so a false negative sends a signed-in admin to the
  // login page. Row Level Security still verifies the token on the query below,
  // so nothing is trusted that shouldn't be.
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', user.id)
    .single();

  if (error) return null;
  return data;
}
