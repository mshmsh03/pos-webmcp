// Rules for the cashier cart an agent can drive on /pos. Run with `npm test`.
// Zero dependencies on purpose — plain node, no test framework to install.
import { createCartApi } from '../lib/cart.js';

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
