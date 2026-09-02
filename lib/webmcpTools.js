'use client';

import {
  getSalesSummary,
  getLowStockAlerts,
  findProduct,
  logExpense,
  getReportsData,
  logToolCall,
} from './queries';
import { CURRENCY } from './format';

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
//  - Read-only tools carry annotations.readOnlyHint: true. Across the whole
//    app there are three tiers, not two: tools that read; tools that change
//    browser-only draft state (the cashier's cart, which no agent can turn
//    into a sale); and exactly ONE tool that writes BUSINESS data —
//    log_expense, which can only add an expense line, never touch a sale,
//    stock, or an account. Nothing an agent can call moves money.
//    (Every tool, including the read-only ones, also appends a row to the
//    tool_calls audit table. That is bookkeeping about the call rather than
//    business data the caller chose to write, but it is a database write, so
//    "log_expense is the only tool that writes anything" would be too strong.)
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
  // wrap() itself does nothing asynchronous — it just builds the execute()
  // function WebMCP will call later. Only that returned function is async.
  return function wrap(name, fn) {
    return async (input) => {
      try {
        const result = await fn(input);
        // Await the audit write BEFORE telling the UI. On /admin the callback
        // re-reads the tool_calls table, so firing it first raced the INSERT
        // and the panel reliably showed every call one behind — the banner
        // announcing a call that wasn't yet in the list under it.
        await logToolCall(name, input, result, true);
        onToolCalled(name, input, result);
        return JSON.stringify(result);
      } catch (err) {
        const message = err?.message || String(err);
        await logToolCall(name, input, { error: message }, false);
        onToolCalled(name, input, { error: message });

        // Return the failure rather than throwing it. Verified against Chrome
        // 152: a thrown error reaches the agent as the generic string "Tool was
        // executed but the invocation failed", and the actual message is lost.
        // That would quietly break the recovery these tools are written for —
        // "Coffee matches 2 products, ask which one" is only useful if the
        // agent can read it. So failures come back as a normal result carrying
        // ok:false, which the agent can act on. The audit log still records
        // them as failures either way.
        return JSON.stringify({ ok: false, error: message });
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
      execute: wrap('find_product', ({ query }) => findProduct(query)),
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

  // Registration is a sequence of awaits. If one of them rejects partway
  // through, the tools registered before it are already live on
  // document.modelContext and the caller never receives the controller — so
  // they would be unrevokable for the lifetime of the document. Abort our own
  // half-finished work before letting the error out.
  try {
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
      execute: wrap('get_sales_summary', ({ period }) => getSalesSummary(period)),
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
      execute: wrap('get_low_stock_alerts', () => getLowStockAlerts()),
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
      execute: wrap('get_financial_summary', ({ period }) => getReportsData(period)),
    },
    { signal }
  );

  await document.modelContext.registerTool(
    {
      name: 'log_expense',
      title: 'Log Expense',
      description:
        `Record a business expense (for example "20,000 ${CURRENCY} for cleaning supplies"). ` +
        'This is the only tool anywhere in this app that writes business data — it can only ' +
        'ever add an expense entry, never touch a sale, stock, or an account.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the expense was for.' },
          amount: { type: 'number', description: `Amount spent, in ${CURRENCY}.` },
          category: {
            type: 'string',
            description: 'Optional category, e.g. "supplies", "rent", "utilities".',
          },
        },
        required: ['description', 'amount'],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: wrap('log_expense', ({ description, amount, category }) =>
        logExpense(description, amount, category)
      ),
    },
    { signal }
  );
  } catch (err) {
    controller.abort();
    throw err;
  }

  return {
    supported: true,
    unregister: () => controller.abort(),
  };
}

// ----------------------------------------------------------------------------
// Cashier register (/pos) — the read-only catalog lookup, plus the cart.
//
// The cart tools are the reason this project is built on WebMCP rather than a
// normal MCP server sitting on an API. The cart is *browser state*. It exists
// only in this tab, in React, in front of a cashier who is watching it. No
// server-side agent can reach it, because there is nothing on the server to
// reach — it isn't persisted anywhere until a human takes payment.
//
// So the permission model here has three tiers, not two:
//   1. read            — find_product, get_cart
//   2. mutate UI state — add_to_cart, remove_from_cart, clear_cart. Reversible,
//                        local, invisible to the database, and the cashier can
//                        see and undo every one of them on screen.
//   3. touch money     — not exposed. At all. record_sale() is reachable only
//                        from the Cash/Card/Other buttons a human presses.
//
// An agent can therefore assemble an entire order and be *wrong* about it
// without costing anybody anything, which is what makes it safe to let one
// drive a register in the first place.
// ----------------------------------------------------------------------------
export async function registerCashierTools(onToolCalled = () => {}, cart = null, askCashier = null) {
  if (!isWebMCPSupported()) {
    return { supported: false, unregister: () => {} };
  }

  const controller = new AbortController();
  const { signal } = controller;
  const wrap = makeWrap(onToolCalled);

  // Same reasoning as registerAdminTools: a rejection partway through would
  // otherwise strand the already-registered tools with nobody holding the
  // AbortController that can remove them.
  try {
  await registerFindProductTool(wrap, signal);

  // The page passes in its cart handles. Without them (any other caller) the
  // register still gets its read-only lookup and nothing breaks.
  if (cart) {
    await document.modelContext.registerTool(
      {
        name: 'get_cart',
        title: 'Read Cart',
        description:
          'Read what is currently on the register: every line, its quantity and price, the ' +
          'item count, and the running total. Use this to answer "what am I ringing up" or to ' +
          'check your own work after adding items.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: wrap('get_cart', () => cart.read()),
      },
      { signal }
    );

    await document.modelContext.registerTool(
      {
        name: 'add_to_cart',
        title: 'Add To Cart',
        description:
          'Add a product to the register\'s current cart by name, so the cashier sees it appear ' +
          'on screen. Use this for requests like "ring up two coffees and a sandwich". This ' +
          'builds a draft order ONLY — it does not sell anything, take payment, or change ' +
          'stock. A human cashier still has to press Cash, Card, or Other to record the sale, ' +
          'and no tool can do that for them. Refuses to add more than the stock on hand, and ' +
          'asks you to be specific if the name matches more than one product.',
        inputSchema: {
          type: 'object',
          properties: {
            product: {
              type: 'string',
              description: 'Product name, or enough of it to identify one product.',
            },
            quantity: {
              type: 'number',
              description: 'How many to add. Defaults to 1.',
            },
          },
          required: ['product'],
        },
        // Not read-only — but nothing it does is destructive or persistent.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        execute: wrap('add_to_cart', ({ product, quantity }) => cart.add(product, quantity)),
      },
      { signal }
    );

    await document.modelContext.registerTool(
      {
        name: 'remove_from_cart',
        title: 'Remove From Cart',
        description:
          'Take a product line back off the current cart by name — for "actually, drop the ' +
          'sandwich". Affects the draft order on screen only; nothing has been sold yet either ' +
          'way, so this cannot refund or reverse a real sale.',
        inputSchema: {
          type: 'object',
          properties: {
            product: {
              type: 'string',
              description: 'Name of the cart line to remove.',
            },
          },
          required: ['product'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        execute: wrap('remove_from_cart', ({ product }) => cart.remove(product)),
      },
      { signal }
    );

    await document.modelContext.registerTool(
      {
        name: 'clear_cart',
        title: 'Clear Cart',
        description:
          'Empty the current cart and start the order over. Draft order only — no sale has ' +
          'happened, so nothing is refunded or undone in the books.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        execute: wrap('clear_cart', () => cart.clear()),
      },
      { signal }
    );
  }

  // The one tool that runs agent -> human rather than agent -> screen.
  if (typeof askCashier === 'function') {
    await document.modelContext.registerTool(
      {
        name: 'ask_cashier',
        title: 'Ask The Cashier',
        description:
          'Put a question on the register screen and wait for the cashier to tap an answer. ' +
          'Use this instead of guessing whenever a decision belongs to the person: which product ' +
          'was meant when a name is ambiguous, whether to substitute something that is out of ' +
          'stock, whether an unusual total is right. Prefer asking over picking for them, and over ' +
          'giving up. The cashier is standing at this screen, so this is faster than telling them ' +
          'in chat. Returns {answered:true, answer} with the option they chose, or ' +
          '{answered:false, reason} if they dismissed it or did not reply within two minutes — ' +
          'in which case do not assume any answer.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question, phrased for someone mid-transaction. Keep it to one line.',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The answers to offer as buttons, e.g. ["Chicken Sandwich", "Chocolate Cake"]. ' +
                'Two to four short options work best. Defaults to Yes / No if omitted.',
            },
          },
          required: ['question'],
        },
        // Changes nothing at all — it only asks. But it is not readOnlyHint
        // either: it interrupts a person, which is a real side effect on them.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        execute: wrap('ask_cashier', ({ question, options }) => {
          const text = String(question || '').trim();
          if (!text) throw new Error('Ask an actual question.');
          // Deduplicated: an agent that has just been told "c matches Coffee,
          // Coffee Beans, Chocolate Cake" sometimes echoes a name twice, and
          // two identical buttons is a worse question, not a richer one.
          const buttons = Array.isArray(options)
            ? [...new Set(options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 6)
            : [];
          return askCashier(text, buttons);
        }),
      },
      { signal }
    );
  }
  } catch (err) {
    controller.abort();
    throw err;
  }

  return {
    supported: true,
    unregister: () => controller.abort(),
  };
}
