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
  } else if (period === '7d' || period === '30d') {
    start.setDate(start.getDate() - (period === '7d' ? 7 : 30));
    // Snap to midnight too. Without this, "7 days" was a rolling 168-hour
    // window anchored on the current clock time: it clipped part of the
    // earliest day, and the number on screen drifted downward as the
    // afternoon wore on. A shop owner asking for "the last 7 days" means
    // seven whole days, and expects the same answer at 9am and at 5pm.
    start.setHours(0, 0, 0, 0);
  } else {
    throw new Error(`unknown period: ${period}`);
  }
  return start.toISOString();
}

// ----------------------------------------------------------------------------
// PostgREST caps a single response at a fixed number of rows (1000 by default)
// and TRUNCATES rather than erroring. Every revenue figure in this app is a
// sum over a date window, so a shop busy enough to cross that cap would have
// quietly seen understated revenue on the dashboard, in the reports page, and
// through get_sales_summary / get_financial_summary — with nothing on screen
// saying so. Wrong money, silently, is the worst failure a POS can have.
//
// So rows are read in pages until a short page comes back. The demo never gets
// past the first request; a real shop stays correct.
// ----------------------------------------------------------------------------
const PAGE_SIZE = 1000;

async function selectAllRows(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

export async function getSalesSummary(period = 'today') {
  const since = periodStart(period);
  const data = await selectAllRows(() =>
    supabase.from('sales').select('total, payment_method, created_at').gte('created_at', since)
  );

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

  const [sales, expenses] = await Promise.all([
    selectAllRows(() => supabase.from('sales').select('total').gte('created_at', since)),
    selectAllRows(() => supabase.from('expenses').select('amount').gte('created_at', since)),
  ]);

  const revenue = sales.reduce((sum, s) => sum + Number(s.total), 0);
  const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

  return { period, revenue, expenses: expenseTotal, net: revenue - expenseTotal };
}

export async function getAllProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, price, stock, low_stock_threshold')
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

// Shared by updateProduct and createProduct so the two paths cannot disagree
// about what a valid price is. They used to: creation took Number(input) raw,
// and Number('') is 0 — so the one path that can bring a product into
// existence was the one that could create it priced at zero.
function validateNumericFields(fields, { requireAll = false } = {}) {
  const patch = {};
  for (const key of ['price', 'stock', 'low_stock_threshold']) {
    if (fields[key] === undefined) {
      if (requireAll && key !== 'low_stock_threshold') {
        throw new Error(`${key.replace(/_/g, ' ')} is required.`);
      }
      continue;
    }

    // Reject blanks explicitly. Number('') is 0, not NaN, so an empty field
    // sailed through the checks below and silently wrote a price of zero —
    // which record_sale() would then happily sell at.
    const raw = typeof fields[key] === 'string' ? fields[key].trim() : fields[key];
    if (raw === '' || raw === null) {
      throw new Error(`${key.replace(/_/g, ' ')} cannot be blank.`);
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key.replace(/_/g, ' ')} must be a number of 0 or more.`);
    }
    patch[key] = key === 'price' ? value : Math.floor(value);
  }
  return patch;
}

export async function createProduct(fields) {
  const name = String(fields.name ?? '').trim();
  if (!name) throw new Error('Product name cannot be empty.');

  const patch = validateNumericFields(fields, { requireAll: true });

  const { data, error } = await supabase
    .from('products')
    .insert({ name, low_stock_threshold: 5, ...patch })
    .select('id, name, price, stock, low_stock_threshold')
    .single();

  if (error) throw error;
  return data;
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

  Object.assign(patch, validateNumericFields(fields));

  if (Object.keys(patch).length === 0) return;

  // products.updated_at was only ever touched by record_sale(), so a product
  // whose price an admin had just changed still showed the timestamp of its
  // last sale. The column is meant to say when the row last changed.
  patch.updated_at = new Date().toISOString();

  const { error } = await supabase.from('products').update(patch).eq('id', productId);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// tool_calls audit log — every WebMCP tool invocation is written here (see
// lib/webmcpTools.js), success or failure, read-only or write. Only admins
// can read it back (RLS), which is what backs the "recent agent activity"
// panel on the dashboard.
// ----------------------------------------------------------------------------

// Never throws: a logging failure must not take down the tool call it is
// logging, and callers await this on the hot path.
export async function logToolCall(toolName, input, result, success = true) {
  try {
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
    if (error) console.error('failed to log tool call:', error.message);
  } catch (err) {
    console.error('failed to log tool call:', err?.message || err);
  }
}

export async function getRecentToolCalls(limit = 8) {
  // called_by / profiles(full_name) matters more than it looks. This is a
  // public demo URL, so the rows in this table were not necessarily written by
  // the person reading the panel. An audit trail that shows WHAT was called
  // but not WHO called it can't distinguish the owner's own agent from a
  // stranger's — which is most of what an audit trail is for.
  const { data, error } = await supabase
    .from('tool_calls')
    .select('id, tool_name, input, result, success, created_at, called_by, profiles(full_name)')
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
