-- Ensure every auth.users row has a corresponding public.profiles row.
-- The on_auth_user_created trigger handles new sign-ups, but users who
-- existed before the trigger was added may lack profiles.
-- This also acts as a safety net if the trigger is ever missing.

insert into public.profiles (id, email, name, role_id)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
  4
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
