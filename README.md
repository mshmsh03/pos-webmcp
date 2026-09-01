# POS System — with a WebMCP agent interface

A working point-of-sale system — cashier register, inventory, admin dashboard,
expense reports — built on Next.js and Supabase, where the pages themselves
register [WebMCP](https://webmachinelearning.github.io/webmcp/) tools. An agent
can read the shop's numbers and **operate the register the cashier is looking
at**, live, in the same tab, on the session they're already signed into.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/) (deadline
3 September 2026).

## Why this needs WebMCP and not just an API

The fair question about any WebMCP demo is: *why not build a REST endpoint and
a normal MCP server?* For the reporting tools, that critique lands. For the
register, it can't:

**The cart is browser state.** It exists in one tab, in React, in front of one
cashier. It has never been near the database and won't be until a human takes
payment. A server-side MCP server cannot reach it, because on the server there
is nothing to reach. `add_to_cart` isn't an API call wearing a costume — it
mutates the screen a person is standing in front of.

Two things follow from that, and they're the whole argument for the spec:

- **No integration to build.** The shop owner is already signed in with the
  dashboard open. The tools ride that session. No API keys to issue, no OAuth
  dance, no service to deploy and secure, no second copy of the auth rules.
  Supabase Row Level Security already decides what this user may see, and the
  tools inherit it for free — a cashier's agent gets a cashier's permissions,
  because it *is* the cashier's session.
- **The human is in the room.** Every tool call lands on a screen someone is
  watching. That's not a limitation to work around; it's the safety model.

## The tools

Nine tools across two pages. `find_product` is registered on both.

| Tool | Where | Touches | What it does |
|---|---|---|---|
| `get_sales_summary` | `/admin` | reads | Revenue, cash/card/other split, transaction count for today / 7d / 30d |
| `get_financial_summary` | `/admin` | reads | Revenue, expenses and net — "are we actually making money" |
| `get_low_stock_alerts` | `/admin` | reads | Every product at or below its restock threshold |
| `find_product` | `/admin` + `/pos` | reads | Search the catalog by name; price and stock |
| `get_cart` | `/pos` | reads | What's on the register right now, with the running total |
| `add_to_cart` | `/pos` | **browser state** | Puts a product on the register — the cashier watches it appear |
| `remove_from_cart` | `/pos` | **browser state** | Takes a line back off the draft order |
| `clear_cart` | `/pos` | **browser state** | Starts the order over |
| `log_expense` | `/admin` | **database** | Adds one expense line. The only tool in the app that writes to the database at all. |

### Three tiers, not two

Most agent-tool designs split the world into "read" and "write." That's too
blunt for anything handling money, so this one has three:

1. **Read** — the reporting tools and lookups. `readOnlyHint: true`.
2. **Change browser-only draft state** — the cart tools. Not read-only, but
   `destructiveHint: false`: reversible, local, invisible to the database, and
   undoable by the cashier with one tap. An agent can assemble an order and be
   completely *wrong* about it without costing anyone anything.
3. **Write to the database** — exactly one tool, `log_expense`, and all it can
   do is append an expense line. It cannot touch a sale, stock, or an account.

**No tool can complete a sale.** `record_sale()` is reachable only from the
Cash / Card / Other buttons a human presses. The agent gets the keyboard, never
the cash drawer — every irreversible action stays with the person.

This matters because the deployed demo is a public URL. Anyone's agent can call
these tools, so the blast radius of a bad or malicious call is capped at "an
expense row you can delete, or a cart you can clear."

### One source of truth, and a receipt for everything

Every tool calls the same query functions in `lib/queries.js` that render the
dashboard UI. A human reading the screen and an agent calling a tool are never
looking at two different code paths.

And every call — read or write, success or failure — is written to a
`tool_calls` table and shown in a **"recent agent activity"** panel on `/admin`,
visible only to admins. It's a durable audit trail of what an agent asked and
what it got back, not a banner that vanishes on the next page load. The register
also flashes each call on screen as it happens, so the cashier sees the agent
working rather than watching the cart change by itself.

## Stack

- **Next.js 14** (App Router, JavaScript, Tailwind)
- **Supabase** — Postgres, Auth, Row Level Security
- **Vercel** — hosting

The cart rules — stock limits, ambiguous product names, quantity validation —
live in `lib/cart.js`, deliberately free of React so they can be tested
directly. `npm test` runs 18 assertions against them, no test framework
required.

## Setup — from zero to a working deploy

### 1. Create a free Supabase project
Go to [supabase.com](https://supabase.com), sign up, **New project**. Pick any
name and a database password (save it somewhere). Wait ~2 minutes for it to
provision.

### 2. Run the schema
In your new project: **SQL Editor → New query**, paste the entire contents of
[`supabase/schema.sql`](./supabase/schema.sql), and click **Run**. This creates
every table, the `record_sale()` function, the `tool_calls` audit table, all the
Row Level Security policies, and four sample products so the app isn't empty on
first load.

### 3. Get your API keys
**Project Settings → API**. You need two values:
- **Project URL**
- **anon public** key

### 4. Run it locally
```bash
npm install
cp .env.local.example .env.local
# paste your Project URL and anon key into .env.local
npm run dev
```
Open `http://localhost:3000` — it redirects to `/login`.

### 5. Create your admin account
Sign up once through the app's login page (any email/password — Supabase's
default settings don't require email confirmation for a new project). Every
new sign-up defaults to the `cashier` role. To make yourself an admin:
**Table Editor → profiles** in Supabase, find your row, change `role` from
`cashier` to `admin`, save. Sign out and back in — you'll land on `/admin`.

### 6. Deploy to Vercel
```bash
npm install -g vercel
vercel
```
Follow the prompts. Then in the Vercel project dashboard: **Settings →
Environment Variables**, add `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` with the same values from step 3, then
redeploy. WebMCP requires HTTPS — a Vercel deployment gives you that
automatically.

## Testing the WebMCP tools

WebMCP is brand new (the spec was published 26 August 2026), so support is
limited to specific surfaces right now:

- **Chrome 149+ with the flag on** — `chrome://flags/#enable-webmcp-testing`,
  set to Enabled, relaunch. Verified working on Chrome 152. Note the flag
  **does not exist in Brave or in older Chrome builds** — use current Chrome.
- **ChatGPT's browser** — the WebMCP Challenge's own rules point to this as a
  supported test surface. Open the deployed `/admin` or `/pos` URL and ask it
  things like "how did we do today" or "ring up two coffees."
- **[Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)**
  — a Chrome extension that lists and calls the tools a page has registered,
  handy for a sanity check without a full agent loop.

Things worth trying on `/pos`: *"ring up two coffees and a sandwich"*,
*"actually drop the sandwich"*, *"what's my total?"* — then press Cash
yourself, because nothing else can.

The dot next to the status line on `/admin` and `/pos` tells you whether the
current browser supports WebMCP at all. The app works completely normally
either way — `document.modelContext` is feature-detected, never assumed.

## Known limitations

- "Today" uses the viewer's own local clock (the browser's timezone), not a
  timezone configured per-shop — correct for a single owner checking their own
  dashboard, but multi-location would need a stored shop timezone.
- No real card processing — `card` is just a logged label; you still need a
  physical card terminal alongside this.
- Staff accounts are created by signing up and then having an admin flip the
  role in Supabase's Table Editor — deliberate, no self-serve admin signup.
- Supabase's free tier pauses a project after a week with no traffic (wakes
  automatically on the next request, a few seconds' delay).

## License

MIT — see [LICENSE](./LICENSE).
