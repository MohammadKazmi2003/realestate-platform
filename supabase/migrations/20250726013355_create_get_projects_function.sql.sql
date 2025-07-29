-- supabase/migrations/20250726000000_create_get_projects_function.sql

CREATE OR REPLACE FUNCTION get_all_projects()
RETURNS TABLE (
    id uuid,
    name text,
    slug text,
    low_price numeric,
    high_price numeric,
    construction_phase text,
    delivery_date timestamptz,
    developer_name text,
    developer_logo text,
    primary_image text,
    location_name text
)
LANGUAGE plpgsql
AS $$
BEGIN
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
        d.logo_storage_path AS developer_logo,
        -- FIX: Use a multi-level sorting logic to reliably find the hero image.
        (
            SELECT pi.storage_path_original
            FROM public.project_images pi
            WHERE pi.project_id = p.id
            ORDER BY
                pi.is_primary DESC, -- Prioritize the explicitly set primary image
                CASE -- Then, prioritize images that follow the "big.webp" hero pattern
                    WHEN pi.storage_path_original LIKE '%/big.webp' THEN 0
                    ELSE 1
                END,
                pi.id ASC -- Finally, fall back to the oldest uploaded image
            LIMIT 1
        ) AS primary_image,
        (
            SELECT l.name
            FROM public.project_locations pl
            JOIN public.locations l ON pl.location_id = l.id
            WHERE pl.project_id = p.id
            ORDER BY l.level DESC
            LIMIT 1
        ) AS location_name
    FROM
        public.projects p
    LEFT JOIN
        public.developers d ON p.developer_id = d.id
    ORDER BY
        p.created_at DESC;
END;
$$;