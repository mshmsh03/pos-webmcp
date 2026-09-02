// ----------------------------------------------------------------------------
// The cashier cart, as a plain object with no React in it.
//
// This is the state a WebMCP agent can drive on /pos, and the reason this
// project needs WebMCP rather than an MCP server over an HTTP API: it lives in
// one browser tab, in front of one cashier, and never reaches the server until
// a human takes payment. There is deliberately no checkout function here — the
// page keeps that to itself.
//
// Kept free of React so the rules below (stock limits, ambiguous names, empty
// carts) can be tested directly. The page supplies the three handles it needs.
// ----------------------------------------------------------------------------

export function summarizeCart(lines) {
  return {
    lines: lines.map((line) => ({
      product: line.product.name,
      quantity: line.quantity,
      unit_price: line.product.price,
      line_total: line.product.price * line.quantity,
    })),
    item_count: lines.reduce((n, line) => n + line.quantity, 0),
    total: lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0),
    status:
      'Draft cart only — nothing has been sold. A human cashier must press Cash, Card, or ' +
      'Other on the register to actually record this sale.',
  };
}

// Crude but sufficient singulariser. The input to these tools is speech
// filtered through a model — "two coffees" is at least as likely as "coffee" —
// so refusing a plural would be refusing the normal case.
function singular(s) {
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('ches') || s.endsWith('shes')) {
    return s.slice(0, -2);
  }
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 2) return s.slice(0, -1);
  return s;
}

// Resolve a loose name ("coffees") to exactly one product, or explain why it
// couldn't. Passes run most-specific first and stop at the first that hits, so
// an exact name always beats a partial one — which is what keeps "Coffee"
// addressable even though "Coffee Beans 1kg" contains it.
export function matchProduct(pool, query, where) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('Give a product name to look for.');

  const qs = singular(q);
  const names = pool.map((p) => p.name.toLowerCase());
  const passes = [
    (n) => n === q,
    (n) => n === qs,
    (n) => n.includes(q),
    (n) => n.includes(qs),
  ];

  let candidates = [];
  for (const test of passes) {
    candidates = pool.filter((_, i) => test(names[i]));
    if (candidates.length) break;
  }

  if (candidates.length === 0) {
    throw new Error(`Nothing in the ${where} matches "${query}".`);
  }
  if (candidates.length > 1) {
    const matched = candidates.map((p) => p.name).join(', ');
    throw new Error(
      `"${query}" matches ${candidates.length} products in the ${where}: ${matched}. ` +
        'Ask which one before adding it.'
    );
  }
  return candidates[0];
}

export function createCartApi({ getProducts, getCart, setCart }) {
  return {
    read() {
      return summarizeCart(getCart());
    },

    add(name, quantity) {
      const qty = Math.floor(Number(quantity ?? 1));
      if (!Number.isFinite(qty) || qty < 1) {
        throw new Error('Quantity has to be a whole number of 1 or more.');
      }

      const product = matchProduct(getProducts(), name, 'catalog');
      const current = getCart();
      const existing = current.find((line) => line.product.id === product.id);
      const already = existing ? existing.quantity : 0;

      // Stock is only actually decremented by record_sale() at checkout, but
      // there's no point letting an agent build a cart that is guaranteed to
      // fail at the till.
      if (already + qty > product.stock) {
        const inCart = already ? ` (${already} already in the cart)` : '';
        throw new Error(
          `Only ${product.stock} × ${product.name} in stock${inCart}. Nothing was added.`
        );
      }

      const next = existing
        ? current.map((line) =>
            line.product.id === product.id ? { ...line, quantity: line.quantity + qty } : line
          )
        : [...current, { product, quantity: qty }];

      setCart(next);
      return { added: `${product.name} × ${qty}`, ...summarizeCart(next) };
    },

    remove(name) {
      const current = getCart();
      if (current.length === 0) throw new Error('The cart is already empty.');

      const product = matchProduct(
        current.map((line) => line.product),
        name,
        'cart'
      );
      const next = current.filter((line) => line.product.id !== product.id);

      setCart(next);
      return { removed: product.name, ...summarizeCart(next) };
    },

    clear() {
      const had = getCart().length;
      setCart([]);
      return { cleared: had, ...summarizeCart([]) };
    },
  };
}
