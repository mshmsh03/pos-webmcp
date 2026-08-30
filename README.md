# POS System — with a WebMCP agent interface

A small point-of-sale system (cashier register, inventory, admin dashboard,
expense reports) built on Next.js and Supabase — and the admin dashboard
exposes its own data and one safe write action as [WebMCP](https://webmachinelearning.github.io/webmcp/)
tools, so an AI agent can read it and act on it directly, in the browser,
with no separate API to build.

Built for the [WebMCP Challenge](https://webmcp.devpost.com/) (submission deadline
3 September 2026).

## The idea

A shop owner is busy at the counter and wants to know "how did we do today"
or "what needs restocking" without opening the dashboard and reading a chart.
With WebMCP, they can just ask an agent — the agent calls a tool this page
registered, gets a real answer from the live database, and the owner sees it
happen on screen at the same time.

Four tools are registered on `/admin`:

| Tool | Read/write | What it does |
|---|---|---|
| `get_sales_summary` | read-only | Revenue, cash/card/other split, transaction count for today / 7 days / 30 days |
| `get_low_stock_alerts` | read-only | Every product at or below its restock threshold |
| `find_product` | read-only | Search the catalog by name, get price and stock |
| `log_expense` | **write** | Records one expense line. The only thing an agent can ever change on this page. |

Three tools are read-only on purpose, and the one write tool can only ever
*add* an expense — never touch a sale, stock, or an account. This page is a
public demo URL; anyone's agent could call these tools, so the blast radius
of a mistake (or a malicious call) is capped at "one extra expense row,"
never a corrupted sale or a wiped product. Each tool is annotated with
`readOnlyHint` for exactly this reason — that annotation is part of the
WebMCP spec itself, not something bolted on.

Every tool calls the *same* query functions (`lib/queries.js`) that render
the dashboard UI. There's one source of truth for the numbers — a human
looking at the screen and an agent calling a tool are never looking at two
different code paths.

## Stack

- **Next.js 14** (App Router, JavaScript, Tailwind)
- **Supabase** — Postgres, Auth, Row Level Security
- **Vercel** — hosting

## Setup — from zero to a working deploy

### 1. Create a free Supabase project
Go to [supabase.com](https://supabase.com), sign up, **New project**. Pick any
name and a database password (save it somewhere). Wait ~2 minutes for it to
provision.

### 2. Run the schema
In your new project: **SQL Editor → New query**, paste the entire contents of
[`supabase/schema.sql`](./supabase/schema.sql), and click **Run**. This creates
every table, the `record_sale()` function, all the Row Level Security
policies, and four sample products so the app isn't empty on first load.

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
Follow the prompts (link or create a Vercel account, accept the defaults).
Then in the Vercel project dashboard: **Settings → Environment Variables**,
add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` with the
same values from step 3, then **redeploy**. WebMCP requires HTTPS — a Vercel
deployment gives you that automatically.

## Testing the WebMCP tools

WebMCP is brand new (the spec was published 26 August 2026), so support is
limited to specific test surfaces right now:

- **ChatGPT's browser** — the WebMCP Challenge's own rules point to this as
  a supported test surface. Open your deployed `/admin` URL there and ask
  it things like "how did we do today" or "what needs restocking."
- **Chrome, with the flag on** — `chrome://flags/#enable-webmcp-testing`,
  enable, relaunch. Note: **this flag may not exist in Brave or older Chrome
  builds** — use a current Chrome install specifically for this.
- **[Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd)**
  — a Chrome extension that lets you manually list and call the tools a page
  has registered, useful for a quick sanity check without needing a full
  agent loop.

The little dot next to "WebMCP tools active" on the `/admin` page tells you
at a glance whether the current browser supports it — the dashboard works
completely normally either way (`document.modelContext` is feature-detected,
never assumed).

## Known limitations

- "Today" is a UTC day boundary, not your local day — fine for a demo, worth
  fixing with a timezone-aware query before any real shop relies on it.
- No real card processing — `card` is just a logged label; you still need a
  physical card terminal alongside this.
- Staff accounts are created by signing up and then having an admin flip the
  role in Supabase's Table Editor — deliberate, no self-serve admin signup.
- Supabase's free tier pauses a project after a week with no traffic (wakes
  automatically on the next request, a few seconds' delay).

## License

MIT — see [LICENSE](./LICENSE).
