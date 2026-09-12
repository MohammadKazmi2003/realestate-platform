-- Lead archive-with-restore via status convention (no new tables/columns).
-- 'archived' is excluded from the unfiltered board path and status counts;
-- per-status fetches (including p_status='archived' for the Archived view)
-- keep working unchanged. Restore = status update back to a board status.
CREATE OR REPLACE FUNCTION public.get_agent_leads(
    p_cursor timestamptz DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_status text DEFAULT NULL
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
            l.id::text,
            l.name,
            l.email,
            l.phone,
            l.message,
            l.status,
            l.created_at::text as created_at,
            l.property_id::text as property_id,
            p.title as property_title
        FROM public.leads l
        JOIN public.properties p ON l.property_id = p.id
        WHERE (p_status IS NULL OR l.status = p_status)
          AND (p_status IS NOT NULL OR l.status != 'archived')
          AND (p_cursor IS NULL OR l.created_at < p_cursor)
        ORDER BY l.created_at DESC
        LIMIT p_limit + 1
    ) sub;

    v_count := jsonb_array_length(v_rows);
    v_has_more := v_count > p_limit;

    IF v_has_more THEN
        v_rows := v_rows - p_limit;
    END IF;

    RETURN jsonb_build_object(
        'leads', v_rows,
        'has_more', v_has_more
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_lead_status_counts()
RETURNS TABLE (status text, count bigint)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT l.status, COUNT(*)::bigint
    FROM public.leads l
    WHERE l.status != 'archived'
    GROUP BY l.status
    ORDER BY l.status;
END;
$$;
