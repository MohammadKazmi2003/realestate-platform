-- Sync profiles.role_id into auth.users.raw_app_meta_data so that
-- the client-side user.app_metadata.user_role_id is always populated
-- without requiring extra DB queries or JWT hook workarounds.
--
-- The client reads user.app_metadata from the database-stored
-- raw_app_meta_data column (via GET /auth/v1/user), NOT from JWT claims.
-- This trigger keeps that column in sync whenever a profile role changes.

-- 1. Trigger function
create or replace function public.sync_profile_role_to_auth_meta()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update auth.users
  set raw_app_meta_data = raw_app_meta_data || jsonb_build_object(
    'user_role_id', new.role_id,
    'user_role', (select name from public.roles where id = new.role_id)
  )
  where id = new.id;
  return new;
end;
$$;

-- 2. Trigger on role_id changes (insert + update)
drop trigger if exists on_profile_role_updated on public.profiles;
create trigger on_profile_role_updated
  after insert or update of role_id on public.profiles
  for each row
  execute function public.sync_profile_role_to_auth_meta();

-- 3. Backfill all existing users who lack the metadata
update auth.users u
set raw_app_meta_data = raw_app_meta_data || jsonb_build_object(
  'user_role_id', p.role_id,
  'user_role', (select name from public.roles where id = p.role_id)
)
from public.profiles p
where u.id = p.id
  and (u.raw_app_meta_data->>'user_role_id' is null
    or u.raw_app_meta_data->>'user_role_id' != p.role_id::text);

-- Also fix users who exist in auth.users but have no profile row at all
insert into public.profiles (id, email, name, role_id)
select u.id, u.email, u.raw_user_meta_data->>'full_name', 4
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
