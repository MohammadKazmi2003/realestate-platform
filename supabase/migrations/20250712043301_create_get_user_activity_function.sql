    -- Function to fetch recent, human-readable activity for a specific user.
    -- It joins with the properties table to make the log messages more descriptive.
    CREATE OR REPLACE FUNCTION public.get_user_recent_activity(p_user_id uuid)
    RETURNS TABLE (
        activity_description text,
        activity_timestamp timestamptz
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            CASE
                WHEN al.action = 'update_property' AND p.title IS NOT NULL
                    THEN 'You updated the property: "' || p.title || '"'
                WHEN al.action = 'create_property' AND p.title IS NOT NULL
                    THEN 'You created the property: "' || p.title || '"'
                -- This is extensible for future actions like 'update_lead_status'
                ELSE 'You performed an action: ' || al.action
            END as activity_description,
            al.timestamp as activity_timestamp
        FROM
            public.action_logs al
        LEFT JOIN
            public.properties p ON al.entity_id = p.id AND al.entity_type = 'property'
        WHERE
            al.user_id = p_user_id
        ORDER BY
            al.timestamp DESC
        LIMIT 10; -- We only fetch the 10 most recent activities for the dashboard
    END;
    $$;
    