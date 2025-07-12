-- Enable Row Level Security on the action_logs table
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

-- This policy allows NO ONE to directly insert into the table.
-- It forces all inserts to go through your trusted `log_action` database function.
CREATE POLICY "Block all direct inserts into action_logs"
ON public.action_logs
FOR INSERT
WITH CHECK (false);

-- This policy allows users to view their own log entries, which can be useful for auditing.
CREATE POLICY "Users can view their own action logs"
ON public.action_logs
FOR SELECT
USING (auth.uid() = user_id);

-- This policy allows admins to view all action logs.
CREATE POLICY "Admins can view all action logs"
ON public.action_logs
FOR SELECT
USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1 );
