    -- This migration creates a dedicated table and secure function for logging
    -- lead status changes, providing a clear and scalable history for the CRM.

    -- 1. Create the dedicated lead_status_logs table.
    CREATE TABLE public.lead_status_logs (
        id bigserial PRIMARY KEY,
        lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
        from_status text,
        to_status text,
        changed_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at timestamptz DEFAULT now()
    );

    -- 2. Enable Row Level Security on the new table.
    ALTER TABLE public.lead_status_logs ENABLE ROW LEVEL SECURITY;

    -- 3. Create a secure function to handle inserting log entries.
    -- This is the ONLY way data should be written to this table.
    CREATE OR REPLACE FUNCTION public.log_lead_status_change(
        p_lead_id uuid,
        p_from_status text,
        p_to_status text
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER SET search_path = public
    AS $$
    BEGIN
        INSERT INTO public.lead_status_logs (lead_id, from_status, to_status, changed_by_user_id)
        VALUES (p_lead_id, p_from_status, p_to_status, auth.uid());
    END;
    $$;

    -- 4. Create RLS policies for the new table.
    -- This policy blocks all direct inserts, forcing use of the function above.
    CREATE POLICY "Block all direct inserts into lead_status_logs"
    ON public.lead_status_logs FOR INSERT WITH CHECK (false);

    -- This policy allows agents and admins to read the logs.
    CREATE POLICY "Allow agents and admins to view lead status logs"
    ON public.lead_status_logs FOR SELECT
    USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) IN (1, 3) );
    