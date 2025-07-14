-- This migration adds a complete and secure set of RLS policies for the lead_notes table.
-- It is idempotent, meaning it can be run safely multiple times.

-- First, drop the old policies if they exist to prevent conflicts.
DROP POLICY IF EXISTS "Allow agents and admins to view lead notes" ON public.lead_notes;
DROP POLICY IF EXISTS "Allow agents and admins to insert notes" ON public.lead_notes;
DROP POLICY IF EXISTS "Allow agents to insert their own notes" ON public.lead_notes; -- Dropping the older version too, just in case.


-- 1. SELECT Policy: Allows agents (role 3) and admins (role 1) to read all lead notes.
-- This is necessary for the modal to fetch and display existing notes.
CREATE POLICY "Allow agents and admins to view lead notes"
ON public.lead_notes
FOR SELECT
TO authenticated
USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) IN (1, 3) );

-- 2. INSERT Policy: A more robust policy that allows agents to insert their own notes,
-- and allows admins to insert notes as well.
CREATE POLICY "Allow agents and admins to insert notes"
ON public.lead_notes
FOR INSERT
TO authenticated
WITH CHECK (
    -- An admin (role 1) can insert any note.
    (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1
    OR
    -- A non-admin can only insert a note where they are the agent.
    agent_id = auth.uid()
);
