'use client';

import { getSalesSummary, getLowStockAlerts, findProduct, logExpense } from './queries';

// ----------------------------------------------------------------------------
// WebMCP tool registration for the admin dashboard.
//
// Spec: https://webmachinelearning.github.io/webmcp/
// API surface used: document.modelContext.registerTool({ name, description,
// inputSchema, execute }, { signal }) — the `signal` is how a tool gets
// UNregistered later (AbortController.abort()), which is what our cleanup
// function below does when the admin page unmounts.
//
// Design choices, on purpose:
//  - Three of the four tools are read-only (annotations.readOnlyHint: true).
//    An agent visiting this public demo can look, but the only thing it can
//    write is an expense line — never a sale, never stock, never a login.
//  - Every tool calls the exact same query functions the dashboard UI calls,
//    so a human watching the screen and an agent calling the tool are always
//    looking at the same numbers through the same code path.
//  - `onToolCalled(name, input, result)` is a hook the UI passes in purely so
//    it can flash a "the agent just did X" banner — WebMCP tool calls should
//    be visible to whoever's looking at the page, not silent background magic.
// ----------------------------------------------------------------------------

export function isWebMCPSupported() {
  return typeof document !== 'undefined' && 'modelContext' in document;
}

export async function registerPosTools(onToolCalled = () => {}) {
  if (!isWebMCPSupported()) {
    return { supported: false, unregister: () => {} };
  }

  const controller = new AbortController();
  const { signal } = controller;

  async function wrap(name, fn) {
    return async (input) => {
      try {
        const result = await fn(input);
        onToolCalled(name, input, result);
        return JSON.stringify(result);
      } catch (err) {
        const message = err?.message || String(err);
        onToolCalled(name, input, { error: message });
        // Re-throw as a plain object so the agent gets a readable failure
        // instead of a stack trace.
        throw new Error(message);
      }
    };
  }

  await document.modelContext.registerTool(
    {
      name: 'get_sales_summary',
      title: "Sales Summary",
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

  await document.modelContext.registerTool(
    {
      name: 'log_expense',
      title: 'Log Expense',
      description:
        'Record a business expense (for example "20,000 IQD for cleaning supplies"). This is ' +
        'the only tool on this page that writes anything — it can only ever add an expense ' +
        'entry, never touch sales, stock, or accounts.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the expense was for.' },
          amount: { type: 'number', description: 'Amount spent, in the shop\'s local currency.' },
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
