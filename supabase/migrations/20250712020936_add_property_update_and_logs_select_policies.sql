-- This migration adds the necessary RLS policies to allow property owners
-- to update their own listings and for dashboard functions to read event logs.

-- 1. Policy to allow a user to UPDATE their own properties.
-- This fixes the issue where property edits were not being saved.
CREATE POLICY "Allow property owners to update their own listings"
ON public.properties
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);


-- 2. Policy to allow authenticated users to SELECT from the event_logs table.
-- This fixes the issue where dashboard analytics could not count WhatsApp clicks.
CREATE POLICY "Allow authenticated users to read event logs"
ON public.event_logs
FOR SELECT
TO authenticated
USING (true);
