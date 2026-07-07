-- Create a custom access token hook that embeds role data into JWTs.
-- This eliminates the per-request profiles.role_id query in middleware.
-- https://supabase.com/docs/guides/auth/auth-hooks#hook-custom-access-token

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  user_role_id int;
  user_role text;
begin
  claims := event->'claims';

  select p.role_id, r.name into user_role_id, user_role
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where p.id = (event->>'user_id')::uuid;

  if user_role_id is not null then
    claims := jsonb_set(claims, '{user_role_id}', to_jsonb(user_role_id));
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role));
  end if;

  event := jsonb_set(event, '{claims}', claims);
  return event;
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;

-- Revoke from public (security: only supabase_auth_admin should execute)
revoke execute on function public.custom_access_token_hook from public, anon, authenticated;
