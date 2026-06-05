-- Migration 0002: Enable Row-Level Security (default-deny) on all tables
--
-- Closes upstream issue #144 ("no RLS on any application table"). Adapted from
-- the cpatpa/PIP fork's 0011_rls.sql, retargeted to Supabase.
--
-- APPROACH (and why it's safe for Mike specifically):
--   * Mike's frontend NEVER queries Postgres tables directly — it uses Supabase
--     only for auth (supabase.auth.*) and goes through the Express backend for
--     all data. (Verified: the only `.from(` in the frontend is Array.from.)
--   * The backend connects with the Supabase SERVICE ROLE, which has BYPASSRLS.
--   * Therefore: enabling RLS + revoking table grants from anon/authenticated,
--     with NO policies, yields default-deny for the public/anon key while the
--     backend keeps working unchanged. A leaked anon key or direct PostgREST
--     call can no longer read any application data.
--
-- Mike's own schema.sql already does exactly this for user_profiles
-- (`revoke all ... from anon, authenticated`). This generalizes it to every
-- table, which is the fix for #144.
--
-- SECURITY DEFINER functions (handle_new_user, app_provision_personal_org) run
-- as their owner (a superuser) and bypass RLS, so signup + provisioning are
-- unaffected.
--
-- DEFERRED (documented, not done here): per-row policies + a service-role ->
-- user-JWT backend refactor. Those would make RLS guard the BACKEND path too
-- (defense against an app-layer bug), not just the anon key. Until then the
-- backend remains the row-level access boundary (as it is today, and as in PIP).
--
-- Idempotent: safe to re-run.

do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    begin
      execute format('revoke all on public.%I from anon, authenticated', t);
    exception
      when undefined_object then
        -- anon/authenticated only exist in a Supabase environment
        null;
    end;
  end loop;
end;
$$;
