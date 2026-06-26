-- Paginated user activity with cursor-based keyset pagination
-- Uses WHERE timestamp < p_cursor instead of OFFSET for O(log n) pagination

DROP FUNCTION IF EXISTS public.get_user_recent_activity(uuid);

CREATE OR REPLACE FUNCTION public.get_user_recent_activity(
    p_user_id uuid,
    p_limit int DEFAULT 10,
    p_cursor timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_rows jsonb;
    v_count int;
    v_has_more boolean;
BEGIN
    SELECT COALESCE(jsonb_agg(sub), '[]'::jsonb) INTO v_rows
    FROM (
        SELECT
            CASE
                WHEN al.action = 'update_property' AND p.title IS NOT NULL
                    THEN 'You updated the property: "' || p.title || '"'
                WHEN al.action = 'create_property' AND p.title IS NOT NULL
                    THEN 'You created the property: "' || p.title || '"'
                WHEN al.action = 'create_lead' AND p.title IS NOT NULL
                    THEN 'New lead on "' || p.title || '"'
                ELSE 'You performed an action: ' || al.action
            END as activity_description,
            al.timestamp::text as activity_timestamp
        FROM public.action_logs al
        LEFT JOIN public.properties p ON al.entity_id = p.id AND al.entity_type = 'property'
        WHERE al.user_id = p_user_id
          AND (p_cursor IS NULL OR al.timestamp < p_cursor)
        ORDER BY al.timestamp DESC
        LIMIT p_limit + 1
    ) sub;

    v_count := jsonb_array_length(v_rows);
    v_has_more := v_count > p_limit;

    IF v_has_more THEN
        v_rows := v_rows - p_limit;
    END IF;

    RETURN jsonb_build_object(
        'activities', v_rows,
        'has_more', v_has_more
    );
END;
$$;
