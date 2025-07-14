-- This migration updates the log_action function to accept a `metadata` parameter,
-- aligning the database schema with the application code and fixing the RPC error.

-- Recreate the log_action function to accept the new, optional metadata parameter.
CREATE OR REPLACE FUNCTION public.log_action(
    p_action text,
    p_entity_type text,
    p_entity_id uuid,
    p_metadata jsonb DEFAULT NULL -- The new, optional metadata parameter
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- This function securely inserts a log entry.
    -- The user_id is taken directly from auth.uid(), preventing any spoofing from the client.
    INSERT INTO public.action_logs (user_id, action, entity_type, entity_id, metadata)
    VALUES (auth.uid(), p_action, p_entity_type, p_entity_id, p_metadata);
END;
$$;
