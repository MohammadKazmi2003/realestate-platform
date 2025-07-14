    -- This migration adds functions to fetch the necessary details (notes and history)
    -- for the lead detail modal in the CRM.

    -- 1. Function to get all notes for a specific lead.
    CREATE OR REPLACE FUNCTION public.get_lead_notes(p_lead_id uuid)
    RETURNS TABLE (
        id bigint,
        note text,
        created_at timestamptz,
        agent_name text
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            ln.id,
            ln.note,
            ln.created_at,
            p.name as agent_name
        FROM
            public.lead_notes ln
        JOIN
            public.profiles p ON ln.agent_id = p.id
        WHERE
            ln.lead_id = p_lead_id
        ORDER BY
            ln.created_at DESC;
    END;
    $$;

    -- 2. Function to get the status change history for a specific lead.
    CREATE OR REPLACE FUNCTION public.get_lead_status_history(p_lead_id uuid)
    RETURNS TABLE (
        id bigint,
        from_status text,
        to_status text,
        changed_at timestamptz,
        agent_name text
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            lsl.id,
            lsl.from_status,
            lsl.to_status,
            lsl.created_at as changed_at,
            p.name as agent_name
        FROM
            public.lead_status_logs lsl
        JOIN
            public.profiles p ON lsl.changed_by_user_id = p.id
        WHERE
            lsl.lead_id = p_lead_id
        ORDER BY
            lsl.created_at DESC;
    END;
    $$;
    