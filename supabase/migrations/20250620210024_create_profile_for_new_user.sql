-- Creates a trigger that fires every time a new user is created in the auth.users table.
-- The trigger calls the handle_new_user function, which inserts a corresponding row into the public.profiles table.

-- 1. Create the function to be called by the trigger
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

-- 2. Create the trigger that fires after a new user is created
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();