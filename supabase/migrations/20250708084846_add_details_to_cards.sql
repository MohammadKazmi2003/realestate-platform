-- This migration updates the functions that feed the homepage and list pages
-- to include crucial details for residential and commercial properties on the cards.

-- First, DROP the existing functions to avoid conflicts.
DROP FUNCTION IF EXISTS public.get_properties_with_all_images();
DROP FUNCTION IF EXISTS public.get_all_listings_paginated(text, int, int, text, int, int);

-- CREATE the updated get_properties_with_all_images function (for homepage)
CREATE OR REPLACE FUNCTION public.get_properties_with_all_images()
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area numeric,
    area_unit text,
    bhk_type_label text, -- ADDED
    bathrooms int,      -- ADDED
    balconies int,      -- ADDED
    cabins int,         -- ADDED
    workstations int,   -- ADDED
    owner_phone text,
    user_id uuid,
    images jsonb,
    property_type_name text -- ADDED
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.title,
        p.price,
        p.location_text,
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        bt.label as bhk_type_label,
        dr.bathrooms,
        dr.balconies,
        dc.cabins,
        dc.workstations,
        prof.phone_number AS owner_phone,
        p.user_id,
        (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb)
            FROM property_media pm
            WHERE pm.property_id = p.id
        ) AS images,
        pt.name as property_type_name
    FROM
        properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    ORDER BY
        p.created_at DESC
    LIMIT 12;
END;
$$;


-- CREATE the updated get_all_listings_paginated function (for /list page)
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
    area numeric,
    area_unit text,
    bhk_type_label text, -- ADDED
    bathrooms int,      -- ADDED
    balconies int,      -- ADDED
    cabins int,         -- ADDED
    workstations int,   -- ADDED
    owner_phone text,
    user_id uuid,
    images jsonb,
    property_type_name text -- ADDED
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
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        bt.label as bhk_type_label,
        dr.bathrooms,
        dr.balconies,
        dc.cabins,
        dc.workstations,
        prof.phone_number as owner_phone,
        p.user_id,
        (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb)
            FROM property_media pm
            WHERE pm.property_id = p.id
        ) AS images,
        pt.name as property_type_name
    FROM
        properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
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
