'use client';

import { supabase } from './supabaseClient';

// Single source of truth for every number the dashboard shows AND every
// number a WebMCP tool returns to an agent — the human and the agent are
// always looking at the same data through the same code path.

function periodStart(period) {
  const now = new Date();
  const start = new Date(now);
  if (period === 'today') {
    start.setUTCHours(0, 0, 0, 0); // known limitation: UTC day, not local day
  } else if (period === '7d') {
    start.setUTCDate(start.getUTCDate() - 7);
  } else if (period === '30d') {
    start.setUTCDate(start.getUTCDate() - 30);
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
  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      description,
      amount,
      category,
      created_by: userData?.user?.id ?? null,
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
  const { error } = await supabase.from('products').update({ stock }).eq('id', productId);
  if (error) throw error;
}

export async function getCurrentProfile() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', userData.user.id)
    .single();

  if (error) return null;
  return data;
}
