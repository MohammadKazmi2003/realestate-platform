    CREATE OR REPLACE FUNCTION get_agent_leads()
    RETURNS TABLE (
        id uuid,
        name text,
        email text,
        phone text,
        message text,
        status text,
        created_at timestamptz,
        property_id uuid,
        property_title text
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            l.id,
            l.name,
            l.email,
            l.phone,
            l.message,
            l.status,
            l.created_at,
            l.property_id,
            p.title as property_title
        FROM
            public.leads l
        JOIN
            public.properties p ON l.property_id = p.id
        -- In a real scenario, you would filter by agent_id
        -- For now, we return all leads for demonstration
        ORDER BY
            l.created_at DESC;
    END;
    $$;
    