-- This function is for the main '/list' page, providing filtering and pagination.
CREATE OR REPLACE FUNCTION get_all_listings_paginated(
    p_location_text text,
    p_bhk_type_id int,
    p_property_type_id int,
    p_sort_by text,
    p_page_num int,
    p_items_per_page int
)
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area_sqft numeric,
    owner_phone text,
    user_id uuid,
    images jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_offset int;
BEGIN
    v_offset := (p_page_num - 1) * p_items_per_page;

    RETURN QUERY
    SELECT
        p.id,
        p.title,
        p.price,
        p.location_text,
        -- COALESCE returns the first non-null value, so we get area from wherever it exists.
        COALESCE(dr.carpet_area, dc.carpet_area) AS area_sqft,
        prof.phone_number as owner_phone,
        p.user_id,
        (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb)
            FROM property_media pm
            WHERE pm.property_id = p.id
        ) AS images
    FROM
        properties p
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    WHERE
        (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    ORDER BY
        CASE WHEN p_sort_by = 'created_at' THEN p.created_at END DESC,
        CASE WHEN p_sort_by = 'price_asc' THEN p.price END ASC,
        CASE WHEN p_sort_by = 'price_desc' THEN p.price END DESC
    LIMIT p_items_per_page
    OFFSET v_offset;
END;
$$;
