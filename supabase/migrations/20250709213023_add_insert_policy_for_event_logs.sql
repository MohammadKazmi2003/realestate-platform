-- This policy allows any authenticated user to insert a log entry.
-- It is the only change needed to fix the logging issue.
CREATE POLICY "Allow authenticated users to insert event logs"
ON public.event_logs
FOR INSERT TO authenticated
WITH CHECK (true);
