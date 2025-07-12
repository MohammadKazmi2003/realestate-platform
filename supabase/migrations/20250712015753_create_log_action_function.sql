-- This function securely inserts a log entry into the action_logs table.
-- It runs with the privileges of the user who created it (the service_role key),
-- allowing it to bypass the restrictive RLS policy that blocks direct client inserts.
-- The user_id is taken directly from the session's auth.uid(), preventing spoofing.

CREATE OR REPLACE FUNCTION public.log_action(
    p_action text,
    p_entity_type text,
    p_entity_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.action_logs (user_id, action, entity_type, entity_id)
    VALUES (auth.uid(), p_action, p_entity_type, p_entity_id);
END;
$$;
