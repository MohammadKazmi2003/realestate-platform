-- The custom_access_token_hook was created as SECURITY INVOKER (default).
-- GoTrue calls this hook as the supabase_auth_admin role, which lacks
-- SELECT permission on public.profiles and public.roles.
-- Making the function SECURITY DEFINER lets it run with the owner's
-- privileges (postgres), which has full access to all tables.
--
-- This was causing 500 errors on every token issuance at
-- POST /auth/v1/token?grant_type=pkce, preventing all logins.

alter function public.custom_access_token_hook
  security definer
  set search_path = public;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
