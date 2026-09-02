// Rules for the cashier cart an agent can drive on /pos. Run with `npm test`.
// Zero dependencies on purpose — plain node, no test framework to install.
import { createCartApi, matchProduct, summarizeCart } from '../lib/cart.js';

const PRODUCTS = [
  { id: '1', name: 'Coffee Beans 1kg', price: 15000, stock: 4 },
  { id: '2', name: 'Coffee', price: 2500, stock: 10 },
  { id: '3', name: 'Sandwich', price: 5000, stock: 2 },
  { id: '4', name: 'Sold Out Cake', price: 3000, stock: 0 },
  { id: '5', name: 'Pastry', price: 2000, stock: 6 },
];

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${label} → ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function throws(fn, substring) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err.message;
  }
  assert(threw !== null, 'expected it to throw, it did not');
  assert(
    threw.toLowerCase().includes(substring.toLowerCase()),
    `expected error containing "${substring}", got "${threw}"`
  );
}

function fresh() {
  let cart = [];
  const api = createCartApi({
    getProducts: () => PRODUCTS,
    getCart: () => cart,
    setCart: (next) => {
      cart = next;
    },
  });
  return { api, peek: () => cart };
}

console.log('\ncart rules:');

check('adds one item by exact name', () => {
  const { api } = fresh();
  const r = api.add('Sandwich');
  assert(r.item_count === 1, 'item_count');
  assert(r.total === 5000, `total was ${r.total}`);
});

check('defaults quantity to 1, respects an explicit quantity', () => {
  const { api } = fresh();
  const r = api.add('Sandwich', 2);
  assert(r.item_count === 2, 'item_count');
  assert(r.total === 10000, `total was ${r.total}`);
});

check('stacks a repeat add onto the existing line', () => {
  const { api, peek } = fresh();
  api.add('Sandwich');
  const r = api.add('Sandwich');
  assert(peek().length === 1, 'should still be one cart line');
  assert(r.item_count === 2, 'item_count');
});

check('exact name beats a substring collision ("Coffee" vs "Coffee Beans 1kg")', () => {
  const { api } = fresh();
  const r = api.add('Coffee');
  assert(r.added.startsWith('Coffee ×'), `added: ${r.added}`);
  assert(r.total === 2500, `should be the 2500 Coffee, got ${r.total}`);
});

check('accepts a plural ("two coffees") without hitting the substring collision', () => {
  const { api } = fresh();
  const r = api.add('coffees', 2);
  assert(r.added.startsWith('Coffee ×'), `added: ${r.added}`);
  assert(r.total === 5000, `should be 2 x 2500, got ${r.total}`);
});

check('handles -es and -ies plurals', () => {
  const { api } = fresh();
  assert(api.add('Sandwiches').added.startsWith('Sandwich ×'), 'sandwiches → Sandwich');
  const { api: api2 } = fresh();
  assert(api2.add('Pastries').added.startsWith('Pastry ×'), 'pastries → Pastry');
});

check('a plural still matches a multi-word name', () => {
  const { api } = fresh();
  const r = api.add('coffee beans');
  assert(r.added.startsWith('Coffee Beans 1kg ×'), `added: ${r.added}`);
});

check('refuses an ambiguous partial name instead of guessing', () => {
  const { api } = fresh();
  throws(() => api.add('coff'), 'matches 2 products');
  throws(() => api.add('coff'), 'ask_cashier'); // points the agent at the human, not at a guess
});

check('refuses a name that matches nothing', () => {
  const { api } = fresh();
  throws(() => api.add('pizza'), 'nothing in the catalog matches');
});

check('refuses to exceed stock on hand', () => {
  const { api } = fresh();
  throws(() => api.add('Sandwich', 3), 'only 2');
});

check('counts what is already in the cart against stock', () => {
  const { api } = fresh();
  api.add('Sandwich', 2);
  throws(() => api.add('Sandwich', 1), 'already in the cart');
});

check('refuses an out-of-stock product', () => {
  const { api } = fresh();
  throws(() => api.add('Sold Out Cake'), 'only 0');
});

check('rejects zero, negative and nonsense quantities', () => {
  const { api } = fresh();
  throws(() => api.add('Sandwich', 0), 'whole number');
  throws(() => api.add('Sandwich', -2), 'whole number');
  throws(() => api.add('Sandwich', 'lots'), 'whole number');
});

check('a failed add leaves the cart untouched', () => {
  const { api, peek } = fresh();
  api.add('Sandwich');
  try {
    api.add('Sandwich', 99);
  } catch {}
  assert(peek().length === 1, 'cart length');
  assert(peek()[0].quantity === 1, 'quantity should be unchanged');
});

check('removes a line by name', () => {
  const { api, peek } = fresh();
  api.add('Sandwich');
  api.add('Coffee');
  const r = api.remove('Sandwich');
  assert(peek().length === 1, 'one line left');
  assert(r.total === 2500, `total was ${r.total}`);
});

check('remove complains about an empty cart', () => {
  const { api } = fresh();
  throws(() => api.remove('Sandwich'), 'already empty');
});

check('remove complains when the item is not in the cart', () => {
  const { api } = fresh();
  api.add('Coffee');
  throws(() => api.remove('Sandwich'), 'nothing in the cart matches');
});

check('clear empties the cart and reports how many lines went', () => {
  const { api, peek } = fresh();
  api.add('Sandwich');
  api.add('Coffee');
  const r = api.clear();
  assert(r.cleared === 2, `cleared: ${r.cleared}`);
  assert(peek().length === 0, 'cart should be empty');
  assert(r.total === 0, 'total should be 0');
});

check('read reflects live state without mutating it', () => {
  const { api, peek } = fresh();
  api.add('Coffee', 3);
  const r = api.read();
  assert(r.item_count === 3, 'item_count');
  assert(r.lines[0].line_total === 7500, `line_total was ${r.lines[0].line_total}`);
  assert(peek().length === 1, 'read must not change the cart');
});

check('every response tells the agent it has not sold anything', () => {
  const { api } = fresh();
  for (const r of [api.read(), api.add('Coffee'), api.remove('Coffee'), api.clear()]) {
    assert(/must press Cash/i.test(r.status), 'missing the human-commits-the-sale note');
  }
});

check('addProduct applies the same stock rule the cashier UI now goes through', () => {
  const { api } = fresh();
  const sandwich = PRODUCTS.find((p) => p.name === 'Sandwich'); // stock 2
  api.addProduct(sandwich, 2);
  // The tile-click path used to bypass this entirely and only fail at the till.
  throws(() => api.addProduct(sandwich, 1), 'already in the cart');
});

check('addProduct rejects a sold-out product', () => {
  const { api } = fresh();
  throws(() => api.addProduct(PRODUCTS.find((p) => p.name === 'Sold Out Cake'), 1), 'only 0');
});

check('addProduct and add() agree — one set of rules, two entry points', () => {
  const a = fresh();
  const b = fresh();
  const viaName = a.api.add('Coffee', 3);
  const viaObject = b.api.addProduct(PRODUCTS.find((p) => p.name === 'Coffee'), 3);
  assert(viaName.total === viaObject.total, 'totals differ');
  assert(viaName.item_count === viaObject.item_count, 'counts differ');
  assert(viaName.added === viaObject.added, `added differs: ${viaName.added} vs ${viaObject.added}`);
});

check('sequential adds do not lose earlier items', () => {
  const { api } = fresh();
  api.add('Coffee', 2);
  api.add('Sandwich');
  const r = api.add('Coffee Beans 1kg');
  assert(r.lines.length === 3, `expected 3 lines, got ${r.lines.length}`);
  assert(r.item_count === 4, `expected 4 items, got ${r.item_count}`);
  assert(r.total === 2500 * 2 + 5000 + 15000, `total was ${r.total}`);
});

// --------------------------------------------------------------------------
// matchProduct is the single most load-bearing function here: it is what turns
// a phrase a person said out loud, filtered through a language model, into one
// row of a catalogue. It was previously only exercised through add(), which
// hid which pass actually fired. These test it directly.
// --------------------------------------------------------------------------
console.log('\nname matching:');

check('resolution order: exact > exact-singular > partial > partial-singular', () => {
  assert(matchProduct(PRODUCTS, 'Coffee', 'catalog').name === 'Coffee', 'exact');
  assert(matchProduct(PRODUCTS, 'coffees', 'catalog').name === 'Coffee', 'exact singular');
  assert(matchProduct(PRODUCTS, 'beans', 'catalog').name === 'Coffee Beans 1kg', 'partial');
  assert(matchProduct(PRODUCTS, 'pastries', 'catalog').name === 'Pastry', 'partial singular');
});

check('matching ignores case and surrounding whitespace', () => {
  assert(matchProduct(PRODUCTS, '  cOfFeE  ', 'catalog').name === 'Coffee', 'normalisation');
});

check('an empty or whitespace-only name is refused, not treated as "everything"', () => {
  throws(() => matchProduct(PRODUCTS, '', 'catalog'), 'give a product name');
  throws(() => matchProduct(PRODUCTS, '   ', 'catalog'), 'give a product name');
});

check('an ambiguous query names every candidate so the agent can offer them', () => {
  let message = '';
  try {
    matchProduct(PRODUCTS, 'co', 'catalog');
  } catch (err) {
    message = err.message;
  }
  assert(message.includes('Coffee'), 'should name Coffee');
  assert(message.includes('Coffee Beans 1kg'), 'should name Coffee Beans 1kg');
  assert(message.includes('ask_cashier'), 'should point at the human, not at a guess');
});

check('a short query is fine when it is unambiguous — only ambiguity is refused', () => {
  assert(matchProduct(PRODUCTS, 'sand', 'catalog').name === 'Sandwich', 'sand → Sandwich');
  assert(matchProduct(PRODUCTS, 'cake', 'catalog').name === 'Sold Out Cake', 'cake → Sold Out Cake');
});

check('a name that matches nothing says so rather than returning undefined', () => {
  throws(() => matchProduct(PRODUCTS, 'pizza', 'catalog'), 'nothing in the catalog matches');
});

console.log('\ncart summary:');

check('summarizeCart reports lines, count and total without touching the input', () => {
  const lines = [
    { product: PRODUCTS[1], quantity: 2 },
    { product: PRODUCTS[2], quantity: 1 },
  ];
  const frozen = JSON.stringify(lines);
  const s = summarizeCart(lines);
  assert(s.lines.length === 2, 'lines');
  assert(s.item_count === 3, `item_count was ${s.item_count}`);
  assert(s.total === 2500 * 2 + 5000, `total was ${s.total}`);
  assert(s.lines[0].unit_price === 2500, 'unit_price');
  assert(JSON.stringify(lines) === frozen, 'summarize must not mutate the cart');
});

check('an empty cart summarizes to zeroes, not to an error', () => {
  const s = summarizeCart([]);
  assert(s.item_count === 0 && s.total === 0 && s.lines.length === 0, 'empty');
  assert(/must press Cash/i.test(s.status), 'status still states who can sell');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
