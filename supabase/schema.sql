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
  insert into profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'cashier');
  return new;
end;
$$ language plpgsql security definer;

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
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product products%rowtype;
  v_total numeric(12, 2) := 0;
begin
  if p_payment_method not in ('cash', 'card', 'other') then
    raise exception 'invalid payment method: %', p_payment_method;
  end if;

  -- Lock and validate stock for every line before writing anything.
  for v_item in select * from jsonb_array_elements(cart)
  loop
    select * into v_product from products
      where id = (v_item->>'product_id')::uuid
      for update;

    if not found then
      raise exception 'product % not found', v_item->>'product_id';
    end if;

    if v_product.stock < (v_item->>'quantity')::int then
      raise exception 'not enough stock for %: have %, need %',
        v_product.name, v_product.stock, (v_item->>'quantity')::int;
    end if;

    v_total := v_total + (v_product.price * (v_item->>'quantity')::int);
  end loop;

  insert into sales (cashier_id, total, payment_method)
  values (auth.uid(), v_total, p_payment_method)
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(cart)
  loop
    select * into v_product from products where id = (v_item->>'product_id')::uuid;

    insert into sale_items (sale_id, product_id, product_name, quantity, unit_price)
    values (v_sale_id, v_product.id, v_product.name, (v_item->>'quantity')::int, v_product.price);

    update products
      set stock = stock - (v_item->>'quantity')::int, updated_at = now()
      where id = v_product.id;
  end loop;

  return v_sale_id;
end;
$$;

-- 8. Row Level Security --------------------------------------------------------
alter table profiles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table expenses enable row level security;

-- Helper: is the current user an admin?
create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- profiles: everyone can see their own row; admins see all
create policy "profiles_select_own_or_admin" on profiles
  for select using (id = auth.uid() or is_admin());
create policy "profiles_update_own" on profiles
  for update using (id = auth.uid());

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
create policy "sales_admin_update" on sales
  for update using (is_admin());

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

-- 9. Seed data (generic — swap for a real client's data later) ----------------
insert into categories (name) values ('Category A'), ('Category B'), ('Category C')
  on conflict do nothing;

insert into products (name, category_id, price, stock, low_stock_threshold)
select 'Sample Item 1', id, 2500, 40, 10 from categories where name = 'Category A'
union all
select 'Sample Item 2', id, 1500, 8, 10 from categories where name = 'Category A'
union all
select 'Sample Item 3', id, 5000, 25, 5 from categories where name = 'Category B'
union all
select 'Sample Item 4', id, 3000, 3, 5 from categories where name = 'Category C'
on conflict do nothing;

-- ============================================================================
-- After running this file:
--  1. Sign up one user through your deployed app's /login page.
--  2. In Table Editor → profiles, change that user's `role` to 'admin'.
--  3. That's your admin login. Any further sign-ups default to 'cashier'.
-- ============================================================================
