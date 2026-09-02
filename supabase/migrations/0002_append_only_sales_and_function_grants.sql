-- ============================================================================
-- 0002 — make the sales ledger append-only, close two function-grant defaults,
--        and stop a null tool result from silently voiding its audit row.
--
-- Apply to an existing database (Supabase → SQL Editor → paste → Run).
-- A fresh database created from schema.sql already contains all of this;
-- everything below is idempotent, so running it twice is harmless.
-- ============================================================================

-- 1. Sales become append-only ------------------------------------------------
-- "sales_admin_update" let an admin PATCH a historical sale — total, payment
-- method, cashier, timestamp — straight through the REST API, with no audit
-- row and no trace. That turns the financial record into an editable document.
-- Nothing in the application ever updated a sale, so the policy bought nothing
-- and cost the one property that made the numbers worth trusting. Corrections
-- belong in the books as another entry, not as a rewrite of the original.
drop policy if exists "sales_admin_update" on public.sales;

-- 2. SECURITY DEFINER functions stop being callable by anon ------------------
-- Postgres grants EXECUTE on new functions to PUBLIC by default and Supabase
-- exposes them to `anon`. record_sale() was already locked down; these two were
-- left on the default because calling them achieves nothing useful today —
-- which is a statement about the current implementation, not a boundary.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.handle_new_user() from public, anon;

-- 3. A null tool result must not void its own audit row ----------------------
-- pg_column_size is STRICT: pg_column_size(NULL) is NULL, so the whole WITH
-- CHECK evaluated to NULL and RLS read that as a refusal. A tool call logged
-- with no result would have disappeared from the audit trail without an error
-- anywhere — the single failure mode an audit trail cannot have.
drop policy if exists "tool_calls_insert_own" on public.tool_calls;
create policy "tool_calls_insert_own" on public.tool_calls
  for insert with check (
    called_by = auth.uid()
    and length(tool_name) between 1 and 100
    and pg_column_size(input) < 8192
    and (result is null or pg_column_size(result) < 32768)
  );
