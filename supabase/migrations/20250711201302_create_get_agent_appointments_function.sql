    CREATE OR REPLACE FUNCTION get_agent_appointments()
    RETURNS TABLE (
        id int,
        title text,
        description text,
        start_time timestamptz,
        end_time timestamptz,
        lead_id uuid,
        lead_name text
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            a.id,
            a.title,
            a.description,
            a.appointment_date as start_time,
            -- Assuming a 1-hour duration for simplicity
            a.appointment_date + interval '1 hour' as end_time,
            a.lead_id,
            l.name as lead_name
        FROM
            public.appointments a
        JOIN
            public.leads l ON a.lead_id = l.id
        WHERE
            a.agent_id = auth.uid()
        ORDER BY
            a.appointment_date;
    END;
    $$;
    