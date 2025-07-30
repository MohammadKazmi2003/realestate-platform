-- This function searches, filters, sorts, and paginates projects.
-- It also returns the total count of matching projects for pagination UI.

CREATE OR REPLACE FUNCTION search_projects(
    -- Pagination
    p_page_num INT DEFAULT 1,
    p_items_per_page INT DEFAULT 12,
    -- Sorting
    p_sort_by TEXT DEFAULT 'created_at_desc', -- e.g., 'price_asc', 'delivery_date_desc'
    -- Filters
    p_search_text TEXT DEFAULT NULL,
    p_completion_status TEXT[] DEFAULT NULL,
    p_bedrooms INT[] DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_delivery_date_start DATE DEFAULT NULL,
    p_delivery_date_end DATE DEFAULT NULL,
    p_amenity_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
    -- Project Card Data
    id uuid,
    name text,
    slug text,
    low_price numeric,
    high_price numeric,
    construction_phase text,
    delivery_date timestamptz,
    developer_name text,
    primary_image text,
    location_name text,
    -- Metadata
    total_count BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_offset INT;
    v_query TEXT;
    v_total_count BIGINT;
BEGIN
    v_offset := (p_page_num - 1) * p_items_per_page;

    -- First, calculate the total count based on the filters for pagination
    SELECT COUNT(*) INTO v_total_count
    FROM public.projects p
    WHERE
        (p_search_text IS NULL OR p.name ILIKE '%' || p_search_text || '%')
    AND (p_completion_status IS NULL OR p.construction_phase = ANY(p_completion_status))
    AND (p_min_price IS NULL OR p.low_price >= p_min_price)
    AND (p_max_price IS NULL OR p.low_price <= p_max_price)
    AND (p_delivery_date_start IS NULL OR p.delivery_date >= p_delivery_date_start)
    AND (p_delivery_date_end IS NULL OR p.delivery_date <= p_delivery_date_end)
    AND (p_bedrooms IS NULL OR EXISTS (
        SELECT 1 FROM public.unit_configurations uc
        WHERE uc.project_id = p.id AND uc.bedrooms = ANY(p_bedrooms)
    ))
    AND (p_amenity_ids IS NULL OR EXISTS (
        SELECT 1 FROM public.project_amenities pa
        WHERE pa.project_id = p.id AND pa.amenity_id = ANY(p_amenity_ids)
    ));

    -- Then, build the main query to fetch the paginated data
    RETURN QUERY
    SELECT
        p.id,
        p.name,
        p.slug,
        p.low_price,
        p.high_price,
        p.construction_phase,
        p.delivery_date,
        d.name AS developer_name,
        (
            SELECT pi.storage_path_original
            FROM public.project_images pi
            WHERE pi.project_id = p.id
            ORDER BY pi.is_primary DESC, pi.id ASC
            LIMIT 1
        ) AS primary_image,
        (
            SELECT l.name
            FROM public.project_locations pl JOIN public.locations l ON pl.location_id = l.id
            WHERE pl.project_id = p.id
            ORDER BY l.level DESC
            LIMIT 1
        ) AS location_name,
        v_total_count
    FROM
        public.projects p
    LEFT JOIN
        public.developers d ON p.developer_id = d.id
    WHERE
        (p_search_text IS NULL OR p.name ILIKE '%' || p_search_text || '%')
    AND (p_completion_status IS NULL OR p.construction_phase = ANY(p_completion_status))
    AND (p_min_price IS NULL OR p.low_price >= p_min_price)
    AND (p_max_price IS NULL OR p.low_price <= p_max_price)
    AND (p_delivery_date_start IS NULL OR p.delivery_date >= p_delivery_date_start)
    AND (p_delivery_date_end IS NULL OR p.delivery_date <= p_delivery_date_end)
    AND (p_bedrooms IS NULL OR EXISTS (
        SELECT 1 FROM public.unit_configurations uc
        WHERE uc.project_id = p.id AND uc.bedrooms = ANY(p_bedrooms)
    ))
    AND (p_amenity_ids IS NULL OR EXISTS (
        SELECT 1 FROM public.project_amenities pa
        WHERE pa.project_id = p.id AND pa.amenity_id = ANY(p_amenity_ids)
    ))
    ORDER BY
        CASE WHEN p_sort_by = 'price_asc' THEN p.low_price END ASC,
        CASE WHEN p_sort_by = 'price_desc' THEN p.low_price END DESC,
        CASE WHEN p_sort_by = 'date_asc' THEN p.delivery_date END ASC,
        CASE WHEN p_sort_by = 'date_desc' THEN p.delivery_date END DESC,
        p.created_at DESC -- Default sort
    LIMIT p_items_per_page
    OFFSET v_offset;
END;
$$;
