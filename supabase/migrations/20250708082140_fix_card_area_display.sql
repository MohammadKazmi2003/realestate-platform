-- This migration updates the get_all_listings_paginated function
-- to correctly return a unified area and area_unit for all property types,
-- ensuring land property areas display correctly on property cards.

-- First, DROP the old function to avoid conflicts with the changed return type.
DROP FUNCTION IF EXISTS public.get_all_listings_paginated(text, int, int, text, int, int);

-- Then, CREATE the new, corrected version of the function.
CREATE OR REPLACE FUNCTION get_all_listings_paginated(
    p_location_text text,
    p_bhk_type_id int,
    p_property_type_id int,
    p_sort_by text,
    p_page_num int,
    p_items_per_page int
)
-- The return table is simplified to 'area' and 'area_unit'
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area numeric, -- UNIFIED area column
    area_unit text, -- UNIFIED area_unit column
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
        -- FIXED: Prioritize plot_area for land, then fall back to residential/commercial carpet_area.
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        -- FIXED: Prioritize the land's area_unit, otherwise default to 'sqft'.
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
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
    LEFT JOIN details_land dl ON p.id = dl.property_id
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
