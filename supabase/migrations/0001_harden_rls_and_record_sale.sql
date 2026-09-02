-- ============================================================================
-- Migration 0001 — close a privilege escalation and harden record_sale()
--
-- RUN THIS ON ANY DATABASE CREATED FROM AN EARLIER COPY OF schema.sql.
-- (A database created from the current schema.sql already has all of this.)
--
-- Paste the whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is idempotent: running it twice is harmless.
--
-- Why it matters, shortest version: the previous profiles UPDATE policy had no
-- WITH CHECK clause, so any signed-up user could set their own role to 'admin'
-- with a single PATCH request. Every other access rule in the schema is
-- downstream of that column.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CRITICAL - a user could grant themselves the admin role.
-- ----------------------------------------------------------------------------
drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select p.role from public.profiles p where p.id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- 2. HIGH - record_sale() was callable without authentication, accepted
--    negative quantities, and could be oversold with duplicate cart lines.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 3. MEDIUM - the audit log accepted unbounded forged entries.
-- ----------------------------------------------------------------------------
drop policy if exists "tool_calls_insert_own" on tool_calls;
create policy "tool_calls_insert_own" on tool_calls
  for insert with check (
    called_by = auth.uid()
    and length(tool_name) between 1 and 100
    and pg_column_size(input) < 8192
    and pg_column_size(result) < 32768
  );

-- ----------------------------------------------------------------------------
-- Verify: with_check should be NOT NULL, and record_sale's ACL must not
-- mention anon.
-- ----------------------------------------------------------------------------
-- select policyname, with_check from pg_policies
--   where tablename = 'profiles' and policyname = 'profiles_update_own';
-- select proname, proacl from pg_proc where proname = 'record_sale';
