    -- This migration corrects the return type of the get_lead_notes function
    -- to match the actual schema of the lead_notes table, resolving the RPC error.

    -- First, explicitly DROP the old function to allow for recreation with a new return signature.
    DROP FUNCTION IF EXISTS public.get_lead_notes(uuid);

    -- Recreate the function with the corrected return type for the 'id' column (integer instead of bigint).
    CREATE OR REPLACE FUNCTION public.get_lead_notes(p_lead_id uuid)
    RETURNS TABLE (
        id integer, -- FIX: Changed from bigint to integer to match 'serial' type
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
    