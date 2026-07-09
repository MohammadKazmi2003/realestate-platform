-- Allow users to insert their own profile row.
-- The existing UPDATE policy covers existing rows, but upsert operations
-- (used by the onboarding page) first attempt INSERT.
-- Without this policy, any upsert on profiles returns a 403 Forbidden.

create policy "Allow users to insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);
