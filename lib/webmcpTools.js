'use client';

import {
  getSalesSummary,
  getLowStockAlerts,
  findProduct,
  logExpense,
  getReportsData,
  logToolCall,
} from './queries';

// ----------------------------------------------------------------------------
// WebMCP tool registration.
//
// Spec: https://webmachinelearning.github.io/webmcp/
// API surface used: document.modelContext.registerTool({ name, description,
// inputSchema, execute }, { signal }) — the `signal` is how a tool gets
// UNregistered later (AbortController.abort()), which is what our cleanup
// function below does when the page unmounts.
//
// Design choices, on purpose:
//  - Read-only tools carry annotations.readOnlyHint: true. Of everything
//    registered across the whole app (admin dashboard + cashier register),
//    exactly one tool writes anything: log_expense — and it can only ever
//    add an expense line, never touch a sale, stock, or an account.
//  - Every tool calls the exact same query functions the page's own UI
//    calls, so a human watching the screen and an agent calling a tool are
//    always looking at the same numbers through the same code path.
//  - Every call — read or write, success or failure — is written to the
//    tool_calls table (see lib/queries.js: logToolCall / getRecentToolCalls),
//    which is what backs the "recent agent activity" panel on the admin
//    dashboard. WebMCP tool calls should be visible to whoever's looking at
//    the page, not silent background magic — this makes that durable, not
//    just a one-line banner that disappears on refresh.
//  - `onToolCalled(name, input, result)` is a second hook the UI passes in
//    purely so it can flash a "the agent just did X" banner immediately.
// ----------------------------------------------------------------------------

export function isWebMCPSupported() {
  return typeof document !== 'undefined' && 'modelContext' in document;
}

function makeWrap(onToolCalled) {
  return async function wrap(name, fn) {
    return async (input) => {
      try {
        const result = await fn(input);
        onToolCalled(name, input, result);
        logToolCall(name, input, result, true);
        return JSON.stringify(result);
      } catch (err) {
        const message = err?.message || String(err);
        onToolCalled(name, input, { error: message });
        logToolCall(name, input, { error: message }, false);
        // Re-throw as a plain object so the agent gets a readable failure
        // instead of a stack trace.
        throw new Error(message);
      }
    };
  };
}

// find_product is registered on both the admin dashboard and the cashier
// register — the same read-only lookup is useful from either page, so it's
// defined once here instead of copy-pasted.
async function registerFindProductTool(wrap, signal) {
  await document.modelContext.registerTool(
    {
      name: 'find_product',
      title: 'Find Product',
      description:
        'Search the product catalog by name and return matching products with their current ' +
        'price and stock level. Use this to answer "do we still have X" or "how much is Y".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name or partial name to search for.' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: await wrap('find_product', ({ query }) => findProduct(query)),
    },
    { signal }
  );
}

// ----------------------------------------------------------------------------
// Admin dashboard (/admin) — the full tool surface: four read-only tools plus
// the one write action.
// ----------------------------------------------------------------------------
export async function registerAdminTools(onToolCalled = () => {}) {
  if (!isWebMCPSupported()) {
    return { supported: false, unregister: () => {} };
  }

  const controller = new AbortController();
  const { signal } = controller;
  const wrap = makeWrap(onToolCalled);

  await document.modelContext.registerTool(
    {
      name: 'get_sales_summary',
      title: 'Sales Summary',
      description:
        'Get revenue, the cash/card/other payment split, and the transaction count for this ' +
        'shop over a given period. Use this to answer questions like "how did we do today" or ' +
        '"what were sales like this week".',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', '7d', '30d'],
            description: 'Which window to summarize.',
          },
        },
        required: ['period'],
      },
      annotations: { readOnlyHint: true },
      execute: await wrap('get_sales_summary', ({ period }) => getSalesSummary(period)),
    },
    { signal }
  );

  await document.modelContext.registerTool(
    {
      name: 'get_low_stock_alerts',
      title: 'Low Stock Alerts',
      description:
        'List every product whose stock has fallen to or below its low-stock threshold. Use ' +
        'this to answer "what needs restocking" or "what are we running low on".',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: await wrap('get_low_stock_alerts', () => getLowStockAlerts()),
    },
    { signal }
  );

  await registerFindProductTool(wrap, signal);

  await document.modelContext.registerTool(
    {
      name: 'get_financial_summary',
      title: 'Financial Summary',
      description:
        'Get total revenue, total expenses, and net (revenue minus expenses) for a given ' +
        'period. Use this to answer "are we actually making money" or "what did we spend this ' +
        'week", not just raw sales numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', '7d', '30d'],
            description: 'Which window to summarize.',
          },
        },
        required: ['period'],
      },
      annotations: { readOnlyHint: true },
      execute: await wrap('get_financial_summary', ({ period }) => getReportsData(period)),
    },
    { signal }
  );

  await document.modelContext.registerTool(
    {
      name: 'log_expense',
      title: 'Log Expense',
      description:
        'Record a business expense (for example "20,000 IQD for cleaning supplies"). This is ' +
        'the only tool anywhere in this app that writes anything — it can only ever add an ' +
        'expense entry, never touch sales, stock, or accounts.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the expense was for.' },
          amount: { type: 'number', description: "Amount spent, in the shop's local currency." },
          category: {
            type: 'string',
            description: 'Optional category, e.g. "supplies", "rent", "utilities".',
          },
        },
        required: ['description', 'amount'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: await wrap('log_expense', ({ description, amount, category }) =>
        logExpense(description, amount, category)
      ),
    },
    { signal }
  );

  return {
    supported: true,
    unregister: () => controller.abort(),
  };
}

// Back-compat alias — earlier builds imported this name directly.
export const registerPosTools = registerAdminTools;

// ----------------------------------------------------------------------------
// Cashier register (/pos) — deliberately narrow: one read-only lookup, so a
// cashier's own agent (or the same shop owner, mid-register) can check a
// price or stock level without leaving the register screen. No write tools
// here — record_sale() is a human-only action from this page.
// ----------------------------------------------------------------------------
export async function registerCashierTools(onToolCalled = () => {}) {
  if (!isWebMCPSupported()) {
    return { supported: false, unregister: () => {} };
  }

  const controller = new AbortController();
  const { signal } = controller;
  const wrap = makeWrap(onToolCalled);

  await registerFindProductTool(wrap, signal);

  return {
    supported: true,
    unregister: () => controller.abort(),
  };
}
