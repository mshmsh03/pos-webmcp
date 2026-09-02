-- ============================================================================
-- POS System schema — run this once in the Supabase SQL editor
-- (Project → SQL Editor → New query → paste this whole file → Run)
-- ============================================================================

-- 1. profiles ----------------------------------------------------------------
-- One row per auth user. Created automatically by the trigger below whenever
-- someone signs up (you'll create the first admin by hand — see README).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'cashier' check (role in ('admin', 'cashier')),
  created_at timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'cashier');
  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- `set search_path` matters here: this function is called by Supabase's auth
-- service (as a trigger on auth.users), not from a session where "public" is
-- already on the search_path — without it, Postgres can't resolve the bare
-- `profiles` name and signup fails with "Database error saving new user".

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- 2. categories ----------------------------------------------------------------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- 3. products ------------------------------------------------------------------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid references categories(id) on delete set null,
  price numeric(12, 2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  low_stock_threshold integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. sales -----------------------------------------------------------------
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  cashier_id uuid references profiles(id),
  total numeric(12, 2) not null check (total >= 0),
  payment_method text not null check (payment_method in ('cash', 'card', 'other')),
  created_at timestamptz not null default now()
);

-- 5. sale_items --------------------------------------------------------------
create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null,     -- captured at sale time so history survives renames
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null
);

-- 6. expenses ------------------------------------------------------------------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  category text not null default 'general',
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- 6b. tool_calls ---------------------------------------------------------------
-- Every WebMCP tool invocation gets a row here, not just the write ones — a
-- full audit trail of what an agent asked and what it got back, visible only
-- to admins. This is what backs the "recent agent activity" panel on the
-- admin dashboard.
create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  success boolean not null default true,
  called_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- 7. record_sale() — atomic checkout ------------------------------------------
-- Takes the cart as JSON: [{ "product_id": "...", "quantity": 2 }, ...]
-- Inserts the sale + line items and decrements stock in one transaction,
-- so a sale can never be recorded without the stock actually moving.
create or replace function record_sale(
  cart jsonb,
  p_payment_method text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
  v_cart jsonb;
  v_item jsonb;
  v_qty int;
  v_product public.products%rowtype;
  v_total numeric(12, 2) := 0;
begin
  -- This function is SECURITY DEFINER, so it runs as its owner and bypasses
  -- RLS entirely — that is how it can write to sales/sale_items, which have no
  -- insert policy at all. Because RLS is switched off inside here, the function
  -- has to do its own authorization. Without this check Postgres' default
  -- EXECUTE-to-PUBLIC grant would let an unauthenticated caller holding only
  -- the (public, embedded-in-the-bundle) anon key drain every product's stock
  -- and forge sales. The REVOKE/GRANT at the end of this file is the other half
  -- of that fix.
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_payment_method not in ('cash', 'card', 'other') then
    raise exception 'invalid payment method: %', p_payment_method;
  end if;

  if cart is null or jsonb_typeof(cart) <> 'array' or jsonb_array_length(cart) = 0 then
    raise exception 'cart must be a non-empty array';
  end if;

  if jsonb_array_length(cart) > 200 then
    raise exception 'cart has too many lines';
  end if;

  -- Collapse duplicate lines and sort by product id. Both matter:
  --   * Summing duplicates closes a real oversell hole. The validation loop
  --     re-reads the same row for each line, so a cart of [X:40, X:40] against
  --     stock 40 passed twice and sold 80.
  --   * Locking in a deterministic order stops two concurrent checkouts whose
  --     carts list the same products in opposite orders from deadlocking.
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity)
                   order by product_id)
    into v_cart
  from (
    select (e->>'product_id')::uuid as product_id,
           sum((e->>'quantity')::numeric) as quantity
    from jsonb_array_elements(cart) e
    group by 1
  ) merged;

  -- Lock and validate every line before writing anything.
  for v_item in select * from jsonb_array_elements(v_cart)
  loop
    -- Quantity is validated here rather than left to the table CHECK
    -- constraints. A negative quantity passes the stock test below (stock < -5
    -- is false) and then *adds* stock on the way out, minting inventory.
    if (v_item->>'quantity')::numeric <> floor((v_item->>'quantity')::numeric)
       or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'quantity must be a positive whole number';
    end if;
    v_qty := (v_item->>'quantity')::int;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid
      for update;

    if not found then
      raise exception 'product % not found', v_item->>'product_id';
    end if;

    if v_product.stock < v_qty then
      raise exception 'not enough stock for %: have %, need %',
        v_product.name, v_product.stock, v_qty;
    end if;

    v_total := v_total + (v_product.price * v_qty);
  end loop;

  insert into public.sales (cashier_id, total, payment_method)
  values (auth.uid(), v_total, p_payment_method)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(v_cart)
  loop
    v_qty := (v_item->>'quantity')::int;
    select * into v_product from public.products where id = (v_item->>'product_id')::uuid;

    insert into public.sale_items (sale_id, product_id, product_name, quantity, unit_price)
    values (v_sale_id, v_product.id, v_product.name, v_qty, v_product.price);

    update public.products
      set stock = stock - v_qty, updated_at = now()
      where id = v_product.id;
  end loop;

  return v_sale_id;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- additionally exposes them to the `anon` role — the role used for any request
-- carrying just the anon key and no user JWT. For a SECURITY DEFINER function
-- that bypasses RLS and moves stock, that default is wrong.
revoke all on function public.record_sale(jsonb, text) from public;
revoke all on function public.record_sale(jsonb, text) from anon;
grant execute on function public.record_sale(jsonb, text) to authenticated;

-- 8. Row Level Security --------------------------------------------------------
alter table profiles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table expenses enable row level security;
alter table tool_calls enable row level security;

-- Helper: is the current user an admin?
create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Same reasoning as the REVOKE on record_sale() above: Postgres grants EXECUTE
-- on every new function to PUBLIC, and Supabase exposes them to `anon`. These
-- two are SECURITY DEFINER as well, so they get the same treatment rather than
-- relying on "calling it wouldn't achieve anything" — that is an argument about
-- today's implementation, not a boundary.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.handle_new_user() from public, anon;

-- profiles: everyone can see their own row; admins see all
create policy "profiles_select_own_or_admin" on profiles
  for select using (id = auth.uid() or is_admin());

-- A user may edit their own profile, but NOT their own role.
--
-- The WITH CHECK clause is the entire point of this policy. Postgres reuses the
-- USING expression as the check when WITH CHECK is omitted, so
--   for update using (id = auth.uid())
-- constrains only *which row* you may write, never *what you may write into it*.
-- Since is_admin() reads profiles.role, that left one PATCH request between any
-- self-service signup and full admin: every other boundary in this file —
-- expenses, the audit trail, product pricing, store-wide sales — is downstream
-- of this column. Role changes are deliberately not possible through the API at
-- all; an owner promotes someone from the Supabase Table Editor.
create policy "profiles_update_own" on profiles
  for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
  );

-- categories & products: anyone signed in can read; only admins write
create policy "categories_select_all" on categories
  for select using (auth.uid() is not null);
create policy "categories_admin_write" on categories
  for all using (is_admin()) with check (is_admin());

create policy "products_select_all" on products
  for select using (auth.uid() is not null);
create policy "products_admin_write" on products
  for all using (is_admin()) with check (is_admin());

-- sales: cashiers see their own sales; admins see everything.
-- Direct inserts are blocked — all sales go through record_sale() (security definer).
create policy "sales_select_own_or_admin" on sales
  for select using (cashier_id = auth.uid() or is_admin());

-- There is deliberately NO update or delete policy on sales. The sales table is
-- the financial record, and record_sale() is the only thing that may write to
-- it. An earlier "sales_admin_update" policy here let an admin PATCH a
-- historical sale's total, payment method, cashier or timestamp straight
-- through the REST API — no audit row, no trace — which quietly turned an
-- append-only ledger into an editable one. Nothing in the app ever updated a
-- sale, so it bought nothing and cost the one property that made the numbers
-- trustworthy. A correction belongs in the books as another entry, not as a
-- silent rewrite of the original.

create policy "sale_items_select_via_sale" on sale_items
  for select using (
    exists (
      select 1 from sales
      where sales.id = sale_items.sale_id
        and (sales.cashier_id = auth.uid() or is_admin())
    )
  );

-- expenses: admin only, full stop
create policy "expenses_admin_only" on expenses
  for all using (is_admin()) with check (is_admin());

-- tool_calls: any signed-in user (cashier or admin) can log a call they made
-- themselves; only admins can read the audit trail back.
-- The insert check pins called_by to the caller so a row can't be attributed to
-- someone else, and bounds the payload: the columns are otherwise entirely
-- caller-controlled, and an audit log that any signed-in user can flood with
-- arbitrarily large forged entries stops being usable as evidence.
create policy "tool_calls_insert_own" on tool_calls
  for insert with check (
    called_by = auth.uid()
    and length(tool_name) between 1 and 100
    and pg_column_size(input) < 8192
    -- pg_column_size is STRICT, so pg_column_size(NULL) is NULL, the whole
    -- WITH CHECK evaluates to NULL, and RLS treats that as a refusal. A tool
    -- call logged with no result would have vanished from the audit trail
    -- silently — the one failure mode an audit trail must not have.
    and (result is null or pg_column_size(result) < 32768)
  );
create policy "tool_calls_select_admin" on tool_calls
  for select using (is_admin());

-- 9. Seed data (generic — swap for a real client's data later) ----------------
-- Seed data. Deliberately a small café's worth of real-sounding items rather
-- than "Sample Item 1" — a POS with placeholder names is hard to evaluate and
-- impossible to demo out loud. Replace these with your own catalogue; nothing
-- in the app depends on them. Two items start below their restock threshold so
-- the low-stock alerts have something to show on first load.
insert into categories (name) values ('Drinks'), ('Food'), ('Retail')
  on conflict do nothing;

insert into products (name, category_id, price, stock, low_stock_threshold)
select 'Coffee', id, 2500, 40, 10 from categories where name = 'Drinks'
union all
select 'Tea', id, 1500, 8, 10 from categories where name = 'Drinks'
union all
select 'Chicken Sandwich', id, 5000, 25, 5 from categories where name = 'Food'
union all
select 'Chocolate Cake', id, 3000, 3, 5 from categories where name = 'Food'
union all
select 'Coffee Beans 1kg', id, 15000, 12, 4 from categories where name = 'Retail'
on conflict do nothing;

-- ============================================================================
-- After running this file:
--  1. Sign up one user through your deployed app's /login page.
--  2. In Table Editor → profiles, change that user's `role` to 'admin'.
--  3. That's your admin login. Any further sign-ups default to 'cashier'.
-- ============================================================================
